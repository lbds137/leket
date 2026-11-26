// A streaming reader for the XML that phone backup apps write (SMS Backup & Restore's
// sms-*.xml): elements and their attributes, read a chunk at a time, so a backup larger
// than one string can hold, or holding megabytes of base64 media in one attribute, is
// read without holding the whole file. It reads what Python's expat (ElementTree) reads
// for such a file, and differs on purpose in one place:
//   - a pair of character references naming the two halves of a surrogate pair (as
//     SMS Backup & Restore writes an emoji: two decimal references, high half first) is
//     that character; a half alone, or a reference to a character XML doesn't allow, is
//     U+FFFD. Expat refuses the whole file.
// Text between elements and CDATA are passed over (these files keep everything in
// attributes); a DOCTYPE with an internal subset is refused.
//
// reader(want, onElement): feed(chunk) each chunk in order, then end(). Each element whose
// name is in `want` is handed to onElement once its end tag is read, as { name, attrs,
// children }: attrs maps each attribute to its value (entities decoded, whitespace
// normalized as XML says), children lists every element inside it, at any depth, in
// document order, as { name, attrs }. Elements outside a wanted one are checked for
// nesting but not kept. A file that isn't well-formed, or ends inside an element, throws.
// Pure: no file access.

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const REPLACEMENT = String.fromCharCode(0xfffd);
// each attribute follows whitespace, as XML requires (a="1"b="2" is malformed)
const ATTR = /[\t\n\r ]+([^\t\n\r =/>"'<&]+)[\t\n\r ]*=[\t\n\r ]*(?:"([^"]*)"|'([^']*)')/y;
// a name ends at whitespace, "/" or ">"; any other character there (<, =, a quote) is malformed
const NAME = /^<([^\t\n\r />="'<&]+)(?=[\t\n\r />])/;

const allowed = (c) => c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff)
  || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);

// An attribute value as written → its value: line ends (CRLF, CR, LF) and tabs become one
// space each, then references are decoded (so "&#10;" stays a line break)
export function attrValue(raw) {
  if (raw.includes("<")) throw new Error("a < inside an attribute value");
  const s = raw.replace(/\r\n|[\r\n\t]/g, " ");
  if (!s.includes("&")) return s;
  const out = [];
  let i = 0;
  const REF = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z][A-Za-z0-9._-]*));/y;
  let pendingHigh = -1;
  const flushHigh = () => { if (pendingHigh >= 0) out.push(REPLACEMENT); pendingHigh = -1; };
  while (i < s.length) {
    const amp = s.indexOf("&", i);
    if (amp === -1) { flushHigh(); out.push(s.slice(i)); break; }
    if (amp > i) { flushHigh(); out.push(s.slice(i, amp)); }
    REF.lastIndex = amp;
    const m = REF.exec(s);
    if (!m) throw new Error(`a & that starts no reference: ${JSON.stringify(s.slice(amp, amp + 12))}`);
    i = REF.lastIndex;
    if (m[3]) {
      if (!(m[3] in NAMED)) throw new Error(`an undefined entity &${m[3]};`);
      flushHigh();
      out.push(NAMED[m[3]]);
      continue;
    }
    const c = m[1] ? parseInt(m[1], 16) : parseInt(m[2], 10);
    if (c >= 0xd800 && c <= 0xdbff) { flushHigh(); pendingHigh = c; continue; }
    if (c >= 0xdc00 && c <= 0xdfff) {
      out.push(pendingHigh >= 0 ? String.fromCharCode(pendingHigh, c) : REPLACEMENT);
      pendingHigh = -1;
      continue;
    }
    flushHigh();
    out.push(Number.isSafeInteger(c) && allowed(c) ? String.fromCodePoint(c) : REPLACEMENT);
  }
  flushHigh();
  return out.join("");
}

// A start tag's text ("<name a="1" b='2'>" or ".../>") → { name, attrs, empty }
export function parseTag(tag) {
  const n = NAME.exec(tag);
  if (!n) throw new Error(`a malformed tag: ${JSON.stringify(tag.slice(0, 40))}`);
  const empty = tag.endsWith("/>");
  const stop = tag.length - (empty ? 2 : 1);
  const attrs = Object.create(null);
  let i = n[0].length;
  while (true) {
    ATTR.lastIndex = i;
    const m = ATTR.exec(tag);
    if (!m || ATTR.lastIndex > stop) break;
    if (m[1] in attrs) throw new Error(`attribute ${m[1]} given twice in <${n[1]}>`);
    attrs[m[1]] = attrValue(m[2] ?? m[3]);
    i = ATTR.lastIndex;
  }
  if (!/^[\t\n\r ]*$/.test(tag.slice(i, stop))) throw new Error(`a malformed attribute in <${n[1]}>: ${JSON.stringify(tag.slice(i, Math.min(stop, i + 40)))}`);
  return { name: n[1], attrs, empty };
}

export function reader(want, onElement) {
  const wanted = new Set(want);
  const stack = []; // open element names
  let kept = null; // the wanted element being read: { name, attrs, children, depth }
  let buf = "";
  let pending = null; // a start tag longer than the chunks so far: { pieces, quote }
  let started = false, rootSeen = false, rootClosed = false;

  const open = (tag) => {
    const { name, attrs, empty } = parseTag(tag);
    if (rootClosed) throw new Error(`an element <${name}> after the document's end`);
    rootSeen = true;
    if (kept) kept.children.push({ name, attrs });
    else if (wanted.has(name)) kept = { name, attrs, children: [], depth: stack.length };
    if (empty) close(name);
    else stack.push(name);
  };
  const close = (name) => {
    if (kept && kept.depth === stack.length) {
      const { depth, ...el } = kept;
      kept = null;
      onElement(el);
    }
    if (!stack.length) rootClosed = true;
  };
  const endTag = (tag) => {
    const name = tag.slice(2, -1).replace(/[\t\n\r ]+$/, "");
    const top = stack.pop();
    if (top !== name) throw new Error(top === undefined ? `an end tag </${name}> with nothing open` : `</${name}> closes <${top}>`);
    close(name);
  };

  // where a start tag that began before this text ends: the index of its ">", or -1 (and
  // the quote state to carry on with)
  const scan = (s, from, quote) => {
    let i = from;
    while (i < s.length) {
      if (quote) {
        const j = s.indexOf(quote, i);
        if (j === -1) return { end: -1, quote };
        quote = "";
        i = j + 1;
        continue;
      }
      const c = s[i];
      if (c === '"' || c === "'") quote = c;
      else if (c === ">") return { end: i, quote: "" };
      else if (c === "<") throw new Error("a < inside a tag (a tag cut off?)");
      i++;
    }
    return { end: -1, quote };
  };

  const feed = (chunk) => {
    if (!started && chunk) {
      started = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    if (pending) {
      const r = scan(chunk, 0, pending.quote);
      if (r.end === -1) { pending.pieces.push(chunk); pending.quote = r.quote; return; }
      const tag = pending.pieces.join("") + chunk.slice(0, r.end + 1);
      pending = null;
      open(tag);
      buf = chunk.slice(r.end + 1);
    } else buf += chunk;
    for (;;) {
      const lt = buf.indexOf("<");
      const text = lt === -1 ? buf : buf.slice(0, lt);
      if (/[^\t\n\r ]/.test(text) && !kept && (!rootSeen || rootClosed)) throw new Error(`text outside the document's element: ${JSON.stringify(text.trim().slice(0, 40))}`);
      if (lt === -1) { buf = ""; return; }
      buf = buf.slice(lt);
      const need = (s) => buf.length < s.length && s.startsWith(buf);
      if (need("<!--") || need("<![CDATA[") || need("<!DOCTYPE")) return;
      let end;
      if (buf.startsWith("<?")) {
        end = buf.indexOf("?>", 2);
        if (end === -1) return;
        buf = buf.slice(end + 2);
      } else if (buf.startsWith("<!--")) {
        end = buf.indexOf("-->", 4);
        if (end === -1) return;
        buf = buf.slice(end + 3);
      } else if (buf.startsWith("<![CDATA[")) {
        if (!stack.length) throw new Error("CDATA outside the document's element");
        end = buf.indexOf("]]>", 9);
        if (end === -1) return;
        buf = buf.slice(end + 3);
      } else if (buf.startsWith("<!DOCTYPE")) {
        if (rootSeen) throw new Error("a DOCTYPE after the document's element began");
        end = buf.indexOf(">");
        if (end === -1) return;
        if (buf.slice(0, end).includes("[")) throw new Error("a DOCTYPE with an internal subset (not a phone backup)");
        buf = buf.slice(end + 1);
      } else if (buf.startsWith("<!")) {
        throw new Error(`a malformed declaration: ${JSON.stringify(buf.slice(0, 20))}`);
      } else if (buf.startsWith("</")) {
        end = buf.indexOf(">");
        if (end === -1) return;
        endTag(buf.slice(0, end + 1));
        buf = buf.slice(end + 1);
      } else {
        const r = scan(buf, 1, "");
        if (r.end === -1) { pending = { pieces: [buf], quote: r.quote }; buf = ""; return; }
        open(buf.slice(0, r.end + 1));
        buf = buf.slice(r.end + 1);
      }
    }
  };

  const end = () => {
    if (pending || buf.trim()) throw new Error("the file ends inside a tag (cut off?)");
    if (!rootSeen) throw new Error("no element found (not XML, or empty)");
    if (stack.length) throw new Error(`the file ends before <${stack[stack.length - 1]}> closes (cut off?)`);
  };
  return { feed, end };
}
