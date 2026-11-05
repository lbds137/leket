// name: the full name, lowercase ASCII ("janedoe").
// short: its short form, lowercase ASCII, same first letter ("jane").
// firstSounds: letters speech recognition hears for the first letter, the real one FIRST ("jgy").
// Returns text => text. Run it on the SERIALIZED JSON string (we call it once on the whole export blob).
const makeRedact = ({ name, short, firstSounds }) => {
  const SHORT = String.raw`(?:(?<![A-Za-z])|(?<=\\[nrt]))[` + firstSounds + "]" + short.slice(1) + String.raw`(?![A-Za-z])`;
  // case-insensitive as Python's re.I: dotless i (U+0131) and dotted capital I (U+0130) count as i,
  // long s (U+017F) as s, the Kelvin sign (U+212A) as k; JS "i" folds ASCII only
  const FOLD = {
    i: "iI" + String.fromCodePoint(0x131, 0x130),
    s: "sS" + String.fromCodePoint(0x17f),
    k: "kK" + String.fromCodePoint(0x212a),
  };
  const NAME_RE = [...name].map((c) => (FOLD[c] ? `[${FOLD[c]}]` : c)).join("");
  const EMAIL = new RegExp(String.raw`[A-Za-z0-9._%+-]*(?:${NAME_RE}|${SHORT})[A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+`, "gi");
  const EXACT = new RegExp(NAME_RE, "gi");
  const SHORT_RE = new RegExp(SHORT, "gi");
  const REDACTED_EMAIL = /[A-Za-z0-9._%+-]*\[redacted\][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+/g;
  // a word; a JSON escape (\n \r \t \uXXXX) directly before it is skipped, not part of the word
  const WORD = /(?:(?<=\\)(?:[nrt]|u[0-9a-fA-F]{4}))?([\p{L}\p{Nl}\p{No}]+)/dgu;
  // 1-3 separator units between the two halves of a split name; \s as Python has it
  // (JS leaves out U+001C-U+001F and U+0085), or _ . -, or a backslash optionally followed by n/r/t/uXXXX
  const GAP = /^(?:[\s\x1c-\x1f\x85_.-]|\\(?:[nrt]|u[0-9a-fA-F]{4})?){1,3}$/u;
  // "heard": lowercase, NFKD, combining marks dropped, a first letter in firstSounds becomes
  // firstSounds[0], y and dotless i become i; returns an array of code points
  const heard = (s) => {
    let c = [...s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")];
    if (c.length && firstSounds.includes(c[0])) c[0] = firstSounds[0];
    return c.map((x) => (x === "y" || x === String.fromCodePoint(0x131) ? "i" : x));
  };
  const N = heard(name);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  // one edit apart, or equal: one substitution, insertion, deletion, or swap of two neighbours
  const withinOne = (a, b) => {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    if (a.length === b.length) {
      return same(a.slice(i + 1), b.slice(i + 1))
        || (same(a.slice(i + 2), b.slice(i + 2)) && same(a.slice(i, i + 2), b.slice(i, i + 2).reverse()));
    }
    return a.length < b.length ? same(a.slice(i), b.slice(i + 1)) : same(a.slice(i + 1), b.slice(i));
  };
  // a single word that is the name misheard: at least len-1 letters, and either (name >= 6 letters)
  // its first 6 heard letters equal the name's, or a prefix of length len-1, len or len+1 is withinOne
  // of the name. The whole word is redacted (so "janedoes" goes whole).
  const misheard = (word) => {
    if ([...word].length < N.length - 1) return false;
    const w = heard(word);
    if (N.length >= 6 && same(w.slice(0, 6), N.slice(0, 6))) return true;
    return [N.length - 1, N.length, N.length + 1].some((k) => w.length >= k && withinOne(w.slice(0, k), N));
  };
  // two neighbouring words that make the name: the first is a proper prefix of it, and the two
  // joined are withinOne of it ("jane doe", "jane_doe", "jane\ndoe" in JSON)
  const split = (first, second) => {
    const a = heard(first);
    return a.length < N.length && same(N.slice(0, a.length), a) && withinOne(a.concat(heard(second)), N);
  };
  // spans to redact in text as given: exact name anywhere (even inside a word), the short form
  // where no ASCII letter touches it (an escape like \n before it counts as no letter), each
  // misheard word, each split pair (span covers both words and the gap)
  const visibleSpans = (text) => {
    const found = [...text.matchAll(EXACT), ...text.matchAll(SHORT_RE)].map((m) => [m.index, m.index + m[0].length]);
    const words = [...text.matchAll(WORD)];
    words.forEach((w, i) => {
      const next = words[i + 1];
      if (misheard(w[1])) found.push(w.indices[1]);
      else if (next && GAP.test(text.slice(w.indices[1][1], next.indices[1][0])) && split(w[1], next[1])) {
        found.push([w.indices[1][0], next.indices[1][1]]);
      }
    });
    return merge(found);
  };
  const merge = (found) => {
    const merged = [];
    for (const [a, b] of found.sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(b, last[1]);
      else merged.push([a, b]);
    }
    return merged;
  };
  // scanned twice and merged: as given (a hidden char keeps the short form apart from a neighbour)
  // and with combining marks + format chars (zero-width space, soft hyphen) removed, so a hidden
  // character or a decomposed accent can't break the name up; second-pass spans map back to
  // positions in the text as given
  const HIDDEN = /[\p{M}\p{Cf}]/u;
  // fast path: only ASCII below U+0300 and no soft hyphen (U+00AD) means nothing hidden
  const mayHide = (t) => { for (const c of t) { const p = c.codePointAt(0); if (p === 0xad || p >= 0x300) return true; } return false; };
  const spans = (text) => {
    if (!mayHide(text)) return visibleSpans(text);
    const starts = [], ends = [], shown = [];
    for (let i = 0; i < text.length;) {
      const ch = String.fromCodePoint(text.codePointAt(i));
      if (!HIDDEN.test(ch)) {
        for (let k = 0; k < ch.length; k++) { starts.push(i); ends.push(i + ch.length); }
        shown.push(ch);
      }
      i += ch.length;
    }
    return merge(visibleSpans(text).concat(
      visibleSpans(shown.join("")).map(([a, b]) => [starts[a], ends[b - 1]])));
  };
  // replacement: an email address carrying the name or short form becomes "[email redacted]"
  // (whole local part + domain); every other span becomes "[redacted]"; an address left holding
  // a "[redacted]" afterwards is collapsed to "[email redacted]" too
  const once = (text) => {
    text = text.replace(EMAIL, "[email redacted]");
    let out = "", at = 0;
    for (const [a, b] of spans(text)) {
      out += text.slice(at, a) + "[redacted]";
      at = b;
    }
    return (out + text.slice(at)).replace(REDACTED_EMAIL, "[email redacted]");
  };
  // to a fixed point, at most 8 passes: removing the name can leave the short form standing alone
  return (text) => {
    for (let i = 0; i < 8; i++) {
      const done = once(text);
      if (done === text) break;
      text = done;
    }
    return text;
  };
};

export { makeRedact };
