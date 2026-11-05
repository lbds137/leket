// The redact guard block (src/modules/etsy/redact.js) exactly as received from
// Jackalope, genericized — these pins are written against the block as received; a pin
// that cannot pass is a STOP-report, not a fix. Nothing here fetches; the fetch red line
// stays for the per-file convention (test/etsy.test.js, claude-sessions-export.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.fetch = async () => { throw new Error("no network in tests: inject a fetch stand-in"); };

const { makeRedact } = await import("../src/modules/etsy/redact.js");

// the config every pin below uses, unless it says otherwise (Jackalope's suggested shapes)
const CFG = { name: "janedoe", short: "jane", firstSounds: "jgy" };
const f = makeRedact(CFG);

test("the name, its case forms, and name-bearing words become [redacted]", () => {
  assert.equal(f("janedoe"), "[redacted]");
  assert.equal(f("JANEDOE"), "[redacted]");
  // as the block behaves, the whole word goes: one letter wrapped around the name is
  // also a withinOne misheard word, so this pin holds whether EXACT or the word rules
  // find it
  assert.equal(f("xjanedoex"), "[redacted]", "the exact name goes even inside a word");
  // two letters per side ISOLATE the exact-name rule: too far off for the misheard word
  // rules, and the short form's boundary rejects the trailing letters — without the
  // EXACT pass this string survives untouched
  assert.equal(f("xxjanedoexx"), "xx[redacted]xx", "EXACT matches the bare name anywhere");
  assert.equal(f("jane"), "[redacted]", "the short form, bare");
  assert.equal(f("gane"), "[redacted]", "a first-sound variant of the short form");
});

test("a JSON \\n escape before the short form still counts as a boundary", () => {
  assert.equal(f('text: "line1\\njane line2"'), 'text: "line1\\n[redacted] line2"');
});

// WORD's escape-skip, isolated: without it the escape's tail letter glues onto the next
// word ("njanedo"), which is no longer a mishearing of janedoe — so this pin reddens
// only when the skip is gone. The backslash is built at runtime so the
// source file carries no escape forms to decode in transport.
test("a JSON \\n escape before a misheard word is skipped, not part of the word", () => {
  const BS = String.fromCharCode(92);
  assert.equal(f(`${BS}njanedo`), `${BS}n[redacted]`, "the word is redacted whole after the escape");
});

test("mishearings of the name go whole: one short, one long, or a neighbour swap", () => {
  assert.equal(f("janedo"), "[redacted]", "one letter short of the name");
  assert.equal(f("janedoes"), "[redacted]", "the whole word goes");
  assert.equal(f("jnaedoe"), "[redacted]", "a swap of two neighbours");
});

test("split pairs go in one span: space, underscore, or the JSON \\n escape", () => {
  assert.equal(f("jane doe"), "[redacted]");
  assert.equal(f("jane_doe"), "[redacted]");
  assert.equal(f("jane\\ndoe"), "[redacted]", "the joined form is gone as a whole, not as two hits");
});

test("a hidden character or a decomposed accent cannot split the name", () => {
  const zwsp = String.fromCodePoint(0x200b);
  assert.equal(f(`jane${zwsp}doe`), "[redacted]");
  const acute = String.fromCodePoint(0x301);
  assert.equal(f(`ja${acute}nedoe`), "[redacted]");
});

test("words that merely resemble the config stay untouched", () => {
  assert.equal(f("janet"), "janet");
  assert.equal(f("ajane"), "ajane", "a letter touches the short form");
  assert.equal(f("jan"), "jan", "too short to mishear");
  assert.equal(f("january"), "january");
});

test("an address carrying the name or the short form goes entirely", () => {
  assert.equal(f("janedoe.x@mail.com"), "[email redacted]");
  assert.equal(f("jane@x.org"), "[email redacted]");
  // isolates the EMAIL rule: the name in the DOMAIN too — the span
  // rules alone would leave "[redacted]@mail.[redacted].com", not one clean token
  assert.equal(f("janedoe@mail.janedoe.com"), "[email redacted]",
    "EMAIL takes the whole address when the name rides the domain");
});

test("a span-made [redacted] inside an address context collapses to [email redacted]", () => {
  const out = f("mail janedoe at jane@x.org");
  assert.equal(out, "mail [redacted] at [email redacted]");
  assert.ok(!out.includes("janedoe"), "no bare name survives");
  assert.ok(!/\[redacted\][A-Za-z0-9._%+-]*@/.test(out), "no address holds a bare [redacted]");
});

test("positive control: another config leaves jane alone and redacts sari", () => {
  const g = makeRedact({ name: "sarisue", short: "sari", firstSounds: "szh" });
  assert.equal(g("janedoe"), "janedoe");
  assert.equal(g("jane"), "jane");
  assert.equal(g("jane doe"), "jane doe");
  assert.equal(g("sari"), "[redacted]");
});

test("the returned function reaches a fixed point: a second pass catches what the first exposed", () => {
  const t = "janejanedoe"; // pass 1 redacts the name and leaves "jane" standing alone
  const out = f(t);
  assert.equal(out, "[redacted][redacted]", "one pass alone would have left jane[redacted]");
  assert.equal(f(out), out, "the function is idempotent");
});

// FOLD exercise: FOLD only matters when the name carries i, s
// or k — "janedoe" carries none — so this pin uses a name that does, and a folded form no
// other rule would catch (not a misheard word: too long for withinOne, and the fold is
// what makes the EXACT name match at all).
test("a folded variant of the name matches even when no other rule would catch it", () => {
  const g = makeRedact({ name: "iris", short: "iri", firstSounds: "iir" });
  const dotless = String.fromCodePoint(0x131);
  assert.equal(g(`xyz${dotless}r${dotless}sxyz`), "xyz[redacted]xyz");
});
