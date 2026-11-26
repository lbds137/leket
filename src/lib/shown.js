// Text from a file or a server, made safe to print in a message: control characters
// (line breaks and escape sequences included) become \xNN, so a crafted name can't move
// the cursor, recolour the terminal or fake a line of output.
export const shown = (s) => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
