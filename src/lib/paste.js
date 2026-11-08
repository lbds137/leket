// The paste boxes' shared strip. Deck's generators write `window.<NAME> = <json>;` as the
// first line, then the console script after it, and Lila may paste the whole file, just
// that line, or just the JSON. This returns the JSON text in all three cases; the caller
// parses it and words its own error.
//
// The capture stops at the first `;` that ends a line: JSON can't hold a raw newline
// inside a string, and a `;` outside one isn't JSON, so that `;` closes the assignment
// and the script after it is dropped. A line with no `;` (the semicolon is optional)
// takes everything after the `=`, as before.
export function assignedJson(text, name) {
  let t = String(text ?? "").trim();
  const head = `^window\\.${name}\\s*=\\s*`;
  const m = new RegExp(`${head}([\\s\\S]*?);[ \\t]*(?:\\r?\\n|$)`).exec(t)
    || new RegExp(`${head}([\\s\\S]*)$`).exec(t);
  if (m) t = m[1].trim();
  return t.replace(/;\s*$/, "");
}
