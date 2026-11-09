// The paste boxes' shared strip. Deck's generators write `window.<NAME> = <json>;` as the
// first line, then the console script after it, and Lila may paste the whole file, just
// that line, or just the JSON. This returns the JSON text in all three cases; the caller
// parses it and words its own error. The assignment is found at the start of any line,
// so a comment or "use strict"; above it still strips. A line starts only after a real
// \n or \r: JSON can't hold those raw in a string, so no line inside a bare-JSON paste
// starts with `window.`. Not the `m` flag: its ^ and $ also match at U+2028/U+2029,
// which JSON strings may hold raw.
//
// The capture stops at the first `;` that ends a line: JSON can't hold a raw newline
// inside a string, and a `;` outside one isn't JSON, so that `;` closes the assignment
// and the script after it is dropped. The cut is only at a line END: a same-line tail
// (`{...}; var q = 1;`) isn't cut and fails the caller's parse. A pasted line with no `;`
// (the semicolon is optional) takes everything after the `=` only when nothing follows
// it; with a script below, the capture runs to the script's first `;` line end and the
// caller's parse fails — the boundary is gone, so its error must say what to paste.
// `name` is regex-escaped: callers pass constants, but a variable name stays literal.
export function assignedJson(text, name) {
  let t = String(text ?? "").trim();
  const head = `(?<![^\\n\\r])[ \\t]*window\\.${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*`;
  const m = new RegExp(`${head}([\\s\\S]*?);[ \\t]*(?:\\r\\n?|\\n|$)`).exec(t)
    || new RegExp(`${head}([\\s\\S]*)$`).exec(t);
  if (m) t = m[1].trim();
  return t.replace(/;\s*$/, "");
}
