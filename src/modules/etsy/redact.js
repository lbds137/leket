// name: the full name, lowercase ASCII ("janedoe").
// short: its short form, lowercase ASCII, same first letter ("jane").
// firstSounds: letters speech recognition hears for the first letter, the real one FIRST ("jgy").
// Returns text => text. Run it on the SERIALIZED JSON string (we call it once on the whole export blob).
  const makeRedact = ({ name, short, firstSounds }) => {
    // name, short: lowercase ASCII letters ("janedoe", "jane"; short shares name's first letter);
    // firstSounds: letters heard for the first one, the real one FIRST ("jgy"). Returns text => text
    // for a serialized JSON document.
    const SHORT = String.raw`(?:(?<![A-Za-z])|(?<=\\[nrtbf])|(?<=\\u[0-9a-fA-F]{4}))[` + firstSounds + "]" + short.slice(1) + String.raw`(?![A-Za-z])`;
    // the name case-insensitively as Python's re.I has it: ı and İ count as i (ſ as s, the
    // Kelvin sign as k); JavaScript's own "i" folds ASCII only, as the letters around it are
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
    const WORD = /(?:(?<=\\)(?:([nrtbf])|u[0-9a-fA-F]{4}))?([\p{L}\p{Nl}\p{No}]+)/dgu;
    // \s as Python has it: JavaScript's leaves out U+001C-U+001F and U+0085
    const GAP = /^(?:[\s\x1c-\x1f\x85_.-]|\\(?:[nrtbf]|u[0-9a-fA-F]{4})?){1,3}$/u;
    // accents dropped, the first letter as any of firstSounds, y and the dotless ı as i;
    // arrays of code points
    const heard = (s) => {
      let c = [...s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")];
      if (c.length && firstSounds.includes(c[0])) c[0] = firstSounds[0];
      return c.map((x) => (x === "y" || x === "ı" ? "i" : x));
    };
    const N = heard(name);
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
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
    const misheard = (word) => {
      if ([...word].length < N.length - 1) return false;
      const w = heard(word);
      if (N.length >= 6 && same(w.slice(0, 6), N.slice(0, 6))) return true;
      return [N.length - 1, N.length, N.length + 1].some((k) => w.length >= k && withinOne(w.slice(0, k), N));
    };
    const split = (first, second) => {
      const a = heard(first);
      return a.length < N.length && same(N.slice(0, a.length), a) && withinOne(a.concat(heard(second)), N);
    };
    const visibleSpans = (text) => {
      const found = [...text.matchAll(EXACT), ...text.matchAll(SHORT_RE)].map((m) => [m.index, m.index + m[0].length]);
      // an escape's own letter standing alone (the r of a backslash-r backslash-n) is part of
      // the gap, not a word, so a name split across a line end still has its halves side by side
      const words = [...text.matchAll(WORD)].filter((w) => !(w[1] === undefined && "nrtbf".includes(w[2])
        && w[2].length === 1 && w.indices[2][0] > 0 && text[w.indices[2][0] - 1] === "\\"));
      words.forEach((w, i) => {
        const next = words[i + 1];
        const end = w.indices[2][1];
        const heardAs = readings(w).find(([, word]) => misheard(word));
        if (heardAs) found.push([heardAs[0], end]);
        else if (next) {
          for (const [a, first] of readings(w)) {
            if (readings(next).some(([b, second]) => GAP.test(text.slice(end, b)) && split(first, second))) {
              found.push([a, next.indices[2][1]]);
              break;
            }
          }
        }
      });
      return merge(found);
    };
    // where a word starts and its letters: after a one-letter JSON escape (backslash-n,
    // backslash-b), first as written, the escape's letter its first (plain text, where the
    // backslash is a character of its own), then as the letters after the escape; the
    // earlier reading wins, so a hit takes the most letters
    const readings = (w) => {
      const out = [[w.indices[2][0], w[2]]];
      if (w[1]) out.unshift([w.indices[1][0], w[1] + w[2]]);
      return out;
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
    // read with combining marks and invisible format characters (a zero-width space, a
    // soft hyphen) left out, so a decomposed accent or a hidden character can't break the
    // name up, and as given too, where a hidden character keeps the short form apart from
    // a neighbouring word; spans are in the text as given
    const HIDDEN = /[\p{M}\p{Cf}]/u;
    const spans = (text) => {
      if (![...text].some((c) => c.codePointAt(0) === 0xad || c.codePointAt(0) >= 0x300)) return visibleSpans(text);
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
    // a hit's start moves past a JSON escape whose letters it would otherwise take (the n of
    // a backslash-n, the hex of a backslash-u): what is redacted here is the serialized
    // document, and it must stay JSON
    const JSON_ESCAPE = /\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/y;
    const pastEscape = (text, a) => {
      for (let p = Math.max(0, a - 5); p < a; p++) {
        if (text[p] !== "\\") continue;
        let run = 0; // backslashes before this one: an odd count escapes it
        while (p - run > 0 && text[p - run - 1] === "\\") run++;
        if (run % 2 === 0) {
          JSON_ESCAPE.lastIndex = p;
          const m = JSON_ESCAPE.exec(text);
          if (m && p + m[0].length > a) return p + m[0].length;
        }
      }
      return a;
    };
    const replace = (text, found, label) => {
      let out = "", at = 0;
      for (const [start, b] of found) {
        const a = pastEscape(text, start);
        if (a < b) {
          out += text.slice(at, a) + label;
          at = b;
        }
      }
      return out + text.slice(at);
    };
    const matches = (text, re) => [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
    const once = (text) => {
      text = replace(text, matches(text, EMAIL), "[email redacted]");
      text = replace(text, spans(text), "[redacted]");
      // an address whose local part held a misheard form goes whole, as the exact name's does
      return replace(text, matches(text, REDACTED_EMAIL), "[email redacted]");
    };
    // repeated until nothing changes: taking the name out can leave the short form alone
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
