// Text from a file or a server, made safe to print in a message: control characters
// (line breaks and escape sequences included) become \xNN, so a crafted name can't move
// the cursor, recolour the terminal or fake a line of output; the bidi controls (which
// can show text in another order than it is) and the Unicode line and paragraph
// separators become a backslash-u escape of four hex digits.
const WIDE = [
  0x061c, 0x200e, 0x200f, // ALM, LRM, RLM
  0x2028, 0x2029, // line and paragraph separators
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // LRE, RLE, PDF, LRO, RLO
  0x2066, 0x2067, 0x2068, 0x2069, // LRI, RLI, FSI, PDI
];
const UNSAFE = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(...WIDE)}]`, "g");
const hex = (c, w) => c.charCodeAt(0).toString(16).padStart(w, "0");
export const shown = (s) => String(s).replace(UNSAFE, (c) => (c.charCodeAt(0) > 0xff ? `\\u${hex(c, 4)}` : `\\x${hex(c, 2)}`));
