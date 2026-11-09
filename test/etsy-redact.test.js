// The redact guard block (src/modules/etsy/redact.js), received from Jackalope and
// genericized. Every pin above the markup section (it opens "Etsy message bodies are
// HTML") is written against the block as received, and must keep passing unchanged: a
// pin that cannot pass is a STOP-report, not a fix. The markup section covers what was
// added here (the glued short form and the markup reading). Nothing here fetches; the fetch red line
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

const POSITIVES = [
  // 1. the class that cuts escapes (email after a control character)
  "Email me:\njanedoe@gmail.com",
  "Email me:\tjane.x@y.com",
  "x\x1fjanedoe@x.com",
  // 2. the short form after an escape that ends in a letter
  "x\x1fjane", "x\x08jane", "x\x0cjane", "see\njane",
  // 3. a misheard form after backslash-b or -f
  "to\x08jnedoe", "to\x0cjnedoe",
  // 4. a split name with one edit across backslash-b or -f
  "jan\x0cedoo", "jan\x08edoo",
  // 5. a split name across a two-character gap containing an escape
  "jan\r\nedoe", "jan\n\nedoe", "jan\n edoe", "jan\t edoe",
  // baseline
  "janedoe", "gane doe", "xjanedoex", "jnaedoe", "janedoes",
];
const NEGATIVES = ["janet", "ajane", "jan"];
const RESIDUES = ["jane", "gane", "jnedo", "jnaed", "edoo"];

test("all 20 acceptance positives redact and still JSON.parse with no residue and escapes intact", () => {
  for (const [i, input] of POSITIVES.entries()) {
    const fed = JSON.stringify(input);
    const out = f(fed);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(out); }, `case ${i + 1} must parse as JSON: ${out}`);
    const low = parsed.toLowerCase();
    for (const r of RESIDUES) {
      assert.ok(!low.includes(r), `case ${i + 1} left residue "${r}" in ${JSON.stringify(parsed)}`);
    }
  }
  // the email cases keep their escape intact in both the JSON text and the parsed value
  const emailNl = f(JSON.stringify(POSITIVES[0]));
  assert.ok(emailNl.includes("\\n"), emailNl);
  assert.equal(JSON.parse(emailNl), "Email me:\n[email redacted]");
  const emailTab = f(JSON.stringify(POSITIVES[1]));
  assert.ok(emailTab.includes("\\t"), emailTab);
  assert.equal(JSON.parse(emailTab), "Email me:\t[email redacted]");
  const emailUs = f(JSON.stringify(POSITIVES[2]));
  assert.ok(emailUs.includes("\\u001f"), emailUs);
  assert.equal(JSON.parse(emailUs), "x\x1f[email redacted]");
});

test("acceptance negatives stay byte-untouched when fed through JSON.stringify", () => {
  for (const input of NEGATIVES) {
    const fed = JSON.stringify(input);
    assert.equal(f(fed), fed);
  }
});

test("acceptance positive-control config maryanne/mary/m leaves all 20 positives and 3 negatives untouched", () => {
  const control = makeRedact({ name: "maryanne", short: "mary", firstSounds: "m" });
  for (const input of [...POSITIVES, ...NEGATIVES]) {
    const fed = JSON.stringify(input);
    assert.equal(control(fed), fed);
  }
});

// Known-and-accepted over-redaction: when the configured name starts with n/r/t/b/f,
// readings(w) tries w[1] + w[2] (prepending the JSON escape's letter) before w[2] alone.
// A word after \n whose letters, with "n" in front, are within one edit of the name
// ("atalia" -> "natalia", one substitution from "natalie"; "atali" -> "natali", one
// deletion) is redacted after \n even though the same word after a space is untouched
// (two edits from "natalie" without the "n"). pastEscape still keeps the \n intact.
test("known-and-accepted over-redaction: a name starting with n/r/t/b/f over-redacts after that escape while keeping valid JSON", () => {
  const nat = makeRedact({ name: "natalie", short: "nat", firstSounds: "n" });
  assert.equal(nat(JSON.stringify("line atalia")), JSON.stringify("line atalia"));
  const afterEscape = nat(JSON.stringify("line\natalia"));
  assert.equal(afterEscape, JSON.stringify("line\n[redacted]"));
  assert.equal(JSON.parse(afterEscape), "line\n[redacted]");

  assert.equal(nat(JSON.stringify("line atali")), JSON.stringify("line atali"));
  const shortAfterEscape = nat(JSON.stringify("line\natali"));
  assert.equal(shortAfterEscape, JSON.stringify("line\n[redacted]"));
  assert.equal(JSON.parse(shortAfterEscape), "line\n[redacted]");

  // the short-form path reaches further: the escape letter plus a common word spells the
  // short form exactly, so a line starting with "at" loses that word ("n" + "at" = "nat")
  assert.equal(nat(JSON.stringify("see you at noon")), JSON.stringify("see you at noon"));
  const lineStart = nat(JSON.stringify("see you\nat noon"));
  assert.equal(lineStart, JSON.stringify("see you\n[redacted] noon"));
  assert.equal(JSON.parse(lineStart), "see you\n[redacted] noon");
});

// Etsy message bodies are HTML, so the name can arrive spelled through an entity, split
// by a tag, percent-encoded, or glued to the word before it. Each case rides a JSON body,
// as the export does, and the output must still parse.
const inBody = (text) => JSON.stringify({ text: `hello ${text} there` });
const bodyOf = (out) => JSON.parse(out).text;

test("an entity, a tag or a percent escape inside the name cannot hide it", () => {
  for (const spelled of ["j&#97;ne", "J&#x61;nedoe", "Ja<wbr>ne", "Ja<br />ne", "jane%64oe"]) {
    assert.equal(bodyOf(f(inBody(spelled))), "hello [redacted] there", spelled);
  }
});

test("the short form glued to the word before it goes when it starts a capital", () => {
  assert.equal(bodyOf(f(inBody("HiJane"))), "hello Hi[redacted] there");
  assert.equal(bodyOf(f(inBody("JaneSmith"))), "hello [redacted]Smith there");
  assert.equal(bodyOf(f(inBody("thanksGane!"))), "hello thanks[redacted]! there", "a first-sound variant");
});

test("entity spellings: uppercase X, no semicolon, named, and layered ones decode", () => {
  for (const spelled of ["J&#X61;nedoe", "j&#97ne", "j&#0097;ne", "jane&nbsp;doe", "Ja&shy;ne", "j&amp;#97;ne", "jane%2564oe", "Ja&lt;br&gt;ne"]) {
    assert.equal(bodyOf(f(inBody(spelled))), "hello [redacted] there", spelled);
  }
});

test("a tag carrying a quoted attribute is skipped whole; the JSON quotes around it stay", () => {
  assert.equal(bodyOf(f(inBody('Ja<span class="x">ne'))), "hello [redacted] there");
});

test("a tag never reaches across a JSON string's own quote", () => {
  // as the stripping must not read it: "<i" in one string and "x>" in the next would make
  // one tag spanning the structure between them, joining Ja and ne
  const fed = JSON.stringify({ a: "Ja<i", b: "x>ne" });
  assert.equal(f(fed), fed);
});

test("entities that name no character leave the text alone and do not throw", () => {
  for (const odd of ["&#55357;", "&#xD800;", "&#1114112;", "&#x110000;", "&bogus;", "%E9", "100%"]) {
    const fed = inBody(odd);
    assert.equal(f(fed), fed, odd);
  }
});

test("words and keys that only resemble the short form stay untouched", () => {
  for (const word of ["ORGANELLE", "Organelle", "myJanet", "JANET", "isGaneral", "hasJaneway"]) {
    const fed = JSON.stringify({ [word]: word });
    assert.equal(f(fed), fed, word);
  }
});
