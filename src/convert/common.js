// Shared by the converters in this folder: times, Python-compatible blank tests, and
// file and folder names that stay inside the output folder. Pure: no file access.
import { WIDE } from "../lib/shown.js";

// Python's str.isspace() set: the original converters' strip() and their "is this part
// blank" test use it, and it differs from JavaScript's \s (no U+FEFF; adds \x1c-\x1f, \x85)
export const PYSPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PYSTRIP = new RegExp(`^[${PYSPACE}]+|[${PYSPACE}]+$`, "g");
export const pyStrip = (s) => s.replace(PYSTRIP, "");
export const blank = (s) => !pyStrip(s);

// Seconds since 1970 → "YYYY-MM-DDTHH:MM:SSZ" in UTC (by any of its names: utc, Etc/UTC,
// GMT…), or with the zone's offset ("…-05:00") in another zone; "" for no time (missing,
// 0, or out of range). Fractions of a second are dropped, not rounded.
export function stamp(t, timeZone = "UTC") {
  if (typeof t !== "number" || !t || !Number.isFinite(t)) return "";
  const d = new Date(Math.floor(t) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset",
  });
  if (f.resolvedOptions().timeZone === "UTC") return d.toISOString().replace(/\.\d+Z$/, "Z");
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const off = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.replace(/^GMT/, "");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

// Characters a file name never keeps: path separators, a drive colon, * ? " < > | (Windows,
// and a FAT, exFAT or SMB disk on Linux, refuse them), C0 and C1 controls, and what shown()
// escapes beyond them (bidi controls, which make a printed name read differently from what
// is on disk, and the line and paragraph separators)
const UNSAFE = new RegExp(`[/\\\\:*?"<>|\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(...WIDE)}]`, "g");

// A title as a file name: unsafe characters (above) become "-", trailing dots go (Windows
// drops them), and it is cut to 200 bytes of UTF-8.
export function safeTitle(title) {
  let s = title.replace(UNSAFE, "-").replace(/\.+$/, "");
  const enc = new TextEncoder();
  if (enc.encode(s).length > 200) {
    // 200 bytes hold at most 200 code points: cut to those first, so a huge title costs
    // at most 200 short re-encodes
    const cps = [...s.slice(0, 400)].slice(0, 200);
    while (enc.encode(cps.join("")).length > 200) cps.pop();
    s = cps.join("").replace(/\.+$/, "");
  }
  return s || "untitled";
}

// A folder from --folders or --unlisted: relative, "/"-separated, no empty, . or .. part,
// and none of the characters safeTitle replaces in a name
export function badFolder(f) {
  if (typeof f !== "string" || !f || f.startsWith("/")) return true;
  if (f.replace(UNSAFE, (c) => (c === "/" ? c : "")) !== f) return true;
  return f.split("/").some((p) => !p || p === "." || p === "..");
}
