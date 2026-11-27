// `leket convert sms`: src/lib/xml.js reads the backup, src/convert/sms.js groups and renders
// it, bin/leket.js reads the file, saves attachments and writes. The fixture is synthetic
// (invented names, 555-01xx numbers), shaped on SMS Backup & Restore's sms-*.xml. With the
// original private converter's fixed names and zone given as options, its --number --groups
// render of the fixture matched sam-groups.md line for line, apart from the source line,
// the zone's name and the final line break.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { attrValue, parseTag, reader } from "../src/lib/xml.js";
import { keyOf, messages, plan } from "../src/convert/sms.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "bin", "leket.js");
const FIXTURE = join(here, "fixtures", "convert-sms", "backup.xml");
const leket = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "leket-sms-"));
const chr = (...c) => String.fromCodePoint(...c);

// the whole fixture through messages() and plan(), fed in pieces of `size` characters
const convert = (xml, opts = {}, size = Infinity) => {
  const m = messages(opts);
  for (let i = 0; i < xml.length; i += size) m.feed(xml.slice(i, i + size));
  return plan(m.end(), { source: "backup.xml", ...opts });
};
const sms = (attrs) => `<sms ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")} />`;
const doc = (...els) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<smses>\n${els.join("\n")}\n</smses>\n`;

test("attrValue: line ends and tabs become one space each; references decode, a &#10; stays a line break", () => {
  assert.equal(attrValue("x&#10;y\nz\tw\r\nq\rr"), "x\ny z w q r");
  assert.equal(attrValue("&amp;&lt;&gt;&quot;&apos;&#x41;&#66;"), "&<>\"'AB");
  assert.equal(attrValue("&#x1F600;"), chr(0x1f600));
});

test("attrValue: a surrogate pair's references are its character; a half alone or a forbidden character is U+FFFD", () => {
  assert.equal(attrValue("a&#55357;&#56835;b"), `a${chr(0x1f603)}b`);
  assert.equal(attrValue("&#55357;x&#56835;"), `${chr(0xfffd)}x${chr(0xfffd)}`);
  assert.equal(attrValue("&#55357;"), chr(0xfffd));
  assert.equal(attrValue("&#56835;x"), `${chr(0xfffd)}x`);
  assert.equal(attrValue("&#55357;&#55357;&#56835;"), `${chr(0xfffd)}${chr(0x1f603)}`);
  assert.equal(attrValue("&#55357;&#65;"), `${chr(0xfffd)}A`);
  assert.equal(attrValue("&#0;&#x1;&#99999999999;"), chr(0xfffd).repeat(3));
});

test("attrValue: an undefined entity, a bare & or a < is refused, as expat refuses it", () => {
  assert.throws(() => attrValue("&nbsp;"), /undefined entity/);
  assert.throws(() => attrValue("fish & chips"), /starts no reference/);
  assert.throws(() => attrValue("a<b"), /</);
});

test("parseTag: quotes of either kind, a > inside one, an empty tag; a repeated or broken attribute is refused", () => {
  const t = parseTag(`<sms a="1>2" b='x "y"' />`);
  assert.equal(t.name, "sms");
  assert.equal(t.empty, true);
  assert.deepEqual({ ...t.attrs }, { a: "1>2", b: 'x "y"' });
  assert.equal(parseTag("<mms\n date=\"1\">").empty, false);
  assert.throws(() => parseTag('<sms a="1" a="2"/>'), /twice/);
  assert.throws(() => parseTag("<sms a=1/>"), /malformed/);
});

test("reader: the same elements however the text is cut into chunks, a character at a time included", () => {
  const xml = readFileSync(FIXTURE, "utf8");
  const whole = convert(xml, { groups: true });
  for (const size of [1, 2, 3, 7, 64]) assert.deepEqual(convert(xml, { groups: true }, size), whole, `chunks of ${size}`);
  assert.equal(whole.stats.messages, 11);
});

test("reader: a cut-off file, a mismatched end tag, text outside the root or a DOCTYPE subset is refused", () => {
  const read = (xml) => { const r = reader(["sms"], () => {}); r.feed(xml); r.end(); };
  assert.throws(() => read('<smses><sms date="1" />'), /ends before <smses> closes/);
  assert.throws(() => read('<smses><sms date="1'), /ends inside a tag/);
  assert.throws(() => read("<smses></sms>"), /closes <smses>/);
  assert.throws(() => read("junk<smses/>"), /outside/);
  assert.throws(() => read("<smses/><smses/>"), /after the document's end/);
  assert.throws(() => read('<!DOCTYPE x [<!ENTITY e "boom">]><smses/>'), /internal subset/);
  assert.throws(() => read(""), /no element/);
  assert.throws(() => read("</smses>"), /with nothing open/);
  // a comment, a PI and CDATA inside the element are passed over; an end tag may end in spaces
  assert.doesNotThrow(() => read("<!-- a > b --><?pi x?><smses><![CDATA[ <sms> ]]></smses \n>"));
});

test("reader: a malformed tag or declaration throws instead of losing the elements after it", () => {
  const read = (xml) => { const r = reader(["sms"], () => {}); r.feed(xml); r.end(); };
  assert.throws(() => read('<smses><other<sms a="1"/></smses>'), /a < inside a tag/);
  assert.throws(() => read('<smses><sms="1"/></smses>'), /malformed tag/);
  assert.throws(() => read('<smses><sms"a"/></smses>'), /malformed tag/);
  assert.throws(() => read('<smses><sms a="1"b="2"/></smses>'), /malformed attribute/);
  assert.throws(() => read("<![CDATA[x]]><smses/>"), /CDATA outside/);
  assert.throws(() => read("<smses><!bogus></smses>"), /malformed declaration/);
  assert.throws(() => read("<smses><!DOCTYPE x></smses>"), /DOCTYPE after/);
});

test("reader: a BOM, a DOCTYPE and CDATA split anywhere, after an empty first chunk", () => {
  const xml = `${chr(0xfeff)}<!DOCTYPE smses><smses><![CDATA[ <sms a="no"/> ]]><sms a="1" /></smses>`;
  for (const size of [1, 2, 5]) {
    const got = [];
    const r = reader(["sms"], (el) => got.push(el.attrs.a));
    r.feed("");
    for (let i = 0; i < xml.length; i += size) r.feed(xml.slice(i, i + size));
    r.end();
    assert.deepEqual(got, ["1"], `chunks of ${size}`);
  }
});

test("reader: a wanted element's children come at any depth; elements outside one aren't kept", () => {
  const got = [];
  const r = reader(["mms"], (el) => got.push(el));
  r.feed('<smses><other a="1"/><mms date="5"><parts><part ct="text/plain" text="hi"/></parts><addrs><addr type="137"/></addrs></mms></smses>');
  r.end();
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].children.map((c) => c.name), ["parts", "part", "addrs", "addr"]);
  assert.equal(got[0].children[1].attrs.text, "hi");
});

test("reader: a > or the other quote inside a quoted value doesn't end the tag, however it is chunked", () => {
  const xml = `<smses><sms body="a > b 'c'" /><sms body='x>"y"' /></smses>`;
  for (const size of [1, 4, xml.length]) {
    const got = [];
    const r = reader(["sms"], (el) => got.push(el.attrs.body));
    for (let i = 0; i < xml.length; i += size) r.feed(xml.slice(i, i + size));
    r.end();
    assert.deepEqual(got, ["a > b 'c'", 'x>"y"'], `chunks of ${size}`);
  }
});

test("keyOf: a number's last 10 digits whatever its format; an address with no digits is itself", () => {
  assert.equal(keyOf("+1 (555) 010-0001"), "5550100001");
  assert.equal(keyOf("5550100001"), "5550100001");
  assert.equal(keyOf("72345"), "72345");
  assert.equal(keyOf(" ACMEBANK "), "ACMEBANK");
});

test("conversations: one per number (formats merged), sender names apart, groups left out and counted", () => {
  const { files, stats } = convert(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(files.map((f) => f.name), ["sms-Sam.md", "sms-Alex.md", "sms-ACMEBANK.md", `sms-${chr(0x2026)}2345.md`]);
  assert.equal(stats.skippedGroups, 2);
  const sam = files[0].text;
  assert.match(sam, /^# Texts with Sam\n/);
  assert.match(sam, /5 messages \(SMS and MMS\), 2024-03-05 to 2024-03-06\. Times are UTC\..* 2 group messages were left out\./);
  assert.match(sam, /> -# Me — Mar 5 2024 2:01 PM\n> \[no text\]/, "an empty body");
  assert.match(sam, /> -# Me — Mar 5 2024 2:02 PM \(not sent\)/, "type 5, a failed send");
  assert.match(sam, /> -# Me — Mar 6 2024 2:00 PM \(not sent\)\n> a draft\n/, "type 3, trailing spaces gone");
  // the MMS dated in seconds, its SMIL part passed over, its text parts joined, its
  // attachments named by cl, by a "null" cl (part<n>.<type>) and by name
  assert.match(sam, /> -# Sam — Mar 6 2024 2:00 AM\n> look at this\n> and this\n> \[attachment: 2024-03-06_1709690400000_2_photo\.jpg\]\n> \[attachment: 2024-03-06_1709690400000_3_part3\.png\]\n> \[attachment: 2024-03-06_1709690400000_4_voice\.amr\]/);
  assert.match(files[1].text, /> -# Alex — Mar 6 2024 6:00 PM\n> \[no text\]/, "an MMS with only a SMIL part");
  assert.match(files[2].text, /only the conversation with `ACMEBANK`/);
});

test("--number: only that conversation (its other format too); with groups, its groups folded in and marked", () => {
  const xml = readFileSync(FIXTURE, "utf8");
  const one = convert(xml, { number: "(555) 010-0001", base: "sam" });
  assert.deepEqual(one.files.map((f) => f.name), ["sam.md"]);
  assert.equal(one.stats.messages, 5);
  assert.equal(one.stats.skippedGroups, 2);
  const g = convert(xml, { number: "5550100001", groups: true, names: { 5550100001: "Sam" }, me: "Robin", timeZone: "America/New_York", title: "Texts with Sam", base: "sam-groups" });
  assert.equal(g.files[0].text, readFileSync(join(here, "fixtures", "convert-sms", "sam-groups.md"), "utf8"));
  // contact_name lining up with the numbers names the members and the sender (type 137);
  // when it doesn't, an unsaved member is its last digits
  assert.match(g.files[0].text, /> -# Alex \(group: Sam, Alex\) — /);
  assert.match(g.files[0].text, new RegExp(`> -# Robin \\(group: Sam, ${chr(0x2026)}0003\\) — `));
});

test("groups without --number: each member set is its own conversation; --name beats contact_name", () => {
  const { files } = convert(readFileSync(FIXTURE, "utf8"), { groups: true, names: { 5550100002: "Al" } });
  const names = files.map((f) => f.name);
  assert.ok(names.includes("sms-Sam, Al.md") && names.includes(`sms-Sam, ${chr(0x2026)}0003.md`), names.join(" | "));
  assert.match(files.find((f) => f.name === "sms-Sam, Al.md").text, /only the conversation with the group of …0001, …0002\.\n[^]*> -# Al \(group: Sam, Al\)/);
});

test("names: two conversations of one name are told apart by the number, on a case-blind disk too", () => {
  const xml = doc(
    sms({ address: "5550100004", date: "1000", type: "1", body: "a", contact_name: "Sam" }),
    sms({ address: "5550100005", date: "2000", type: "1", body: "b", contact_name: "sam" }),
    sms({ address: "5550100006", date: "3000", type: "1", body: "c", contact_name: "Sam" }),
  );
  assert.deepEqual(convert(xml).files.map((f) => f.name), ["sms-Sam.md", `sms-sam (${chr(0x2026)}0005).md`, `sms-Sam (${chr(0x2026)}0006).md`]);
  // the same name and the same last 4 digits: then a count
  const same = doc(
    sms({ address: "2125551234", date: "1000", type: "1", body: "a", contact_name: "Sam" }),
    sms({ address: "3105551234", date: "2000", type: "1", body: "b", contact_name: "Sam" }),
    sms({ address: "4155551234", date: "3000", type: "1", body: "c", contact_name: "Sam" }),
  );
  assert.deepEqual(convert(same).files.map((f) => f.name), ["sms-Sam.md", `sms-Sam (${chr(0x2026)}1234).md`, "sms-Sam (2).md"]);
});

test("an address that is an Object property's name, or empty, is an ordinary conversation", () => {
  const xml = doc(
    sms({ address: "constructor", date: "1000", type: "1", body: "a" }),
    sms({ address: "", date: "2000", type: "3", body: "draft" }),
  );
  const { files } = convert(xml, { names: Object.assign(Object.create(null), { __proto__: "P" }) });
  assert.deepEqual(files.map((f) => f.name), ["sms-constructor.md", `sms-${chr(0x2026)}.md`]);
  assert.match(files[1].text, /only the conversation with no address\./);
});

test("an MMS draft, outbox or failed send is marked (not sent), and neither it nor an unsent SMS counts as sent", () => {
  const mms = (box, text) => `<mms date="17096${box}0000000" msg_box="${box}" address="5550100001"><parts><part ct="text/plain" text="${text}"/></parts></mms>`;
  const xml = doc(mms(1, "in"), mms(2, "out"), mms(3, "draft"), mms(4, "outbox"), mms(5, "failed"),
    sms({ address: "5550100001", date: "1709700000000", type: "3", body: "sms draft" }),
    sms({ address: "5550100001", date: "1709700000001", type: "2", body: "sms sent" }));
  const { files, stats } = convert(xml, { me: "Me" });
  assert.deepEqual(files[0].text.match(/^> -# .*$/gm).map((l) => l.replace(/ — .* (AM|PM)/, "")),
    ["> -# …0001", "> -# Me", "> -# Me (not sent)", "> -# Me (not sent)", "> -# Me (not sent)", "> -# Me (not sent)", "> -# Me"]);
  assert.equal(stats.mine, 2);
});

test("--number: an MMS kept because an <addr> names the number goes in that conversation's one file", () => {
  const xml = doc(
    `<mms date="1709600000000" msg_box="1" address="5550100002"><parts><part ct="text/plain" text="via addr"/></parts><addrs><addr address="5550100001" type="151"/></addrs></mms>`,
    sms({ address: "5550100001", date: "1709647200000", type: "1", body: "direct", contact_name: "Sam" }),
  );
  const { files } = convert(xml, { number: "5550100001", base: "sam", title: "Texts with Sam" });
  assert.deepEqual(files.map((f) => f.name), ["sam.md"]);
  assert.match(files[0].text, /via addr[^]*direct/);
});

test("a group's file and heading use the names its contact_name listed; (Unknown) is no name; a sender not named is …", () => {
  const xml = doc(
    `<mms date="1709740800000" msg_box="1" address="5550100001~5550100002" contact_name="Sam, (Unknown)"><parts><part ct="text/plain" text="hi"/></parts><addrs><addr address="5550100002" type="137"/></addrs></mms>`,
    `<mms date="1709740900000" msg_box="1" address="5550100001~5550100002"><parts><part ct="text/plain" text="who"/></parts></mms>`,
  );
  const { files } = convert(xml, { groups: true });
  assert.deepEqual(files.map((f) => f.name), [`sms-Sam, ${chr(0x2026)}0002.md`]);
  assert.match(files[0].text, /^# Texts with Sam, …0002\n/);
  assert.match(files[0].text, /> -# …0002 \(group: Sam, …0002\)/);
  assert.match(files[0].text, /> -# … \(group: Sam, …0002\) — [^\n]*\n> who/);
});

test("attachments: a cl of \"null\" falls through to the name; two named alike are numbered", () => {
  const saved = [];
  const xml = doc(
    `<mms date="1709690400" msg_box="1" address="5550100001"><parts><part ct="audio/amr" cl="null" name="voice.amr" data="QUJD"/><part ct="image/png" cl="" name="" data="QUJD"/></parts></mms>`,
    `<mms date="1709690400" msg_box="1" address="5550100001"><parts><part ct="audio/amr" cl="null" name="voice.amr" data="REVG"/></parts></mms>`,
    `<mms date="1709690400" msg_box="1" address="5550100002"><parts><part ct="audio/amr" cl="VOICE.amr" data="R0hJ"/></parts></mms>`,
  );
  const m = messages({ media: true, onAttachment: (name, b64) => saved.push([name, b64]) });
  m.feed(xml);
  m.end();
  assert.deepEqual(saved, [
    ["2024-03-06_1709690400000_0_voice.amr", "QUJD"],
    ["2024-03-06_1709690400000_1_part1.png", "QUJD"],
    ["2024-03-06_1709690400000_0_voice (2).amr", "REVG"],
    ["2024-03-06_1709690400000_0_VOICE (3).amr", "R0hJ"],
  ]);
});

test("an attachment name from the phone can't leave the media folder; an undated message is left out and counted", () => {
  const saved = [];
  const xml = doc(
    `<mms date="1709690400000" msg_box="1" address="5550100001"><parts><part ct="image/jpeg" cl="../../evil/x.sh" data="QUJD" /></parts></mms>`,
    sms({ address: "5550100001", date: "", type: "1", body: "no date" }),
    sms({ address: "5550100001", date: "soon", type: "1", body: "no date" }),
  );
  const m = messages({ media: true, onAttachment: (name, b64) => saved.push([name, b64]) });
  m.feed(xml);
  const read = m.end();
  assert.deepEqual(saved, [["2024-03-06_1709690400000_0_..-..-evil-x.sh", "QUJD"]]);
  assert.equal(read.undated, 2);
  assert.equal(plan(read, { source: "b.xml" }).stats.undated, 2);
  const out = tmp(), file = join(out, "b.xml");
  writeFileSync(file, xml);
  const r = leket(["convert", "sms", file, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Messages with no usable date, left out: 2\./);
});

test("CLI: writes one file per conversation and, with --media, the attachments and their list", () => {
  const out = tmp(), media = join(out, "media");
  const r = leket(["convert", "sms", FIXTURE, "--out", out, "--media", media]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out).sort(), ["media", "sms-ACMEBANK.md", "sms-Alex.md", "sms-Sam.md", `sms-${chr(0x2026)}2345.md`].sort());
  assert.match(r.stderr, /4 conversations, 9 messages \(1 sent from the backup's phone\)/);
  assert.match(r.stderr, /Group messages left out \(give --groups to keep them\): 2\./);
  const tsv = readFileSync(join(media, "attachments.tsv"), "utf8").trim().split("\n");
  assert.equal(tsv[0], "file\tsize\tmd5");
  assert.equal(tsv.length, 4);
  assert.match(tsv[1], /^2024-03-06_1709690400000_2_photo\.jpg\t19\t2bc30c202c0ee0a960b44af28f9940cf$/);
  assert.equal(readFileSync(join(media, "2024-03-06_1709690400000_2_photo.jpg"), "latin1"), "GIF89a-fake-picture");
});

test("CLI: no match, a cut-off backup or a missing file exits 1 with no transcript written", () => {
  const out = tmp();
  let r = leket(["convert", "sms", FIXTURE, "--out", out, "--number", "5550109999"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no messages matched the number ending 9999; no transcript written/);
  const cut = join(out, "cut.xml");
  const text = readFileSync(FIXTURE, "utf8");
  writeFileSync(cut, text.slice(0, text.indexOf("</mms>") + 6)); // cut after an MMS with 3 attachments
  r = leket(["convert", "sms", cut, "--out", out, "--media", join(out, "m")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /isn't a readable SMS backup \(the file ends .*; no transcript written \(3 attachments were already saved in .*m\)\./);
  assert.equal(readdirSync(join(out, "m")).length, 3);
  r = leket(["convert", "sms", join(out, "nope.xml"), "--out", out]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ENOENT/);
  assert.deepEqual(readdirSync(out).filter((f) => f.endsWith(".md")), []);
  assert.ok(!existsSync(join(out, "m", "attachments.tsv")));
});

test("CLI: usage errors exit 2", () => {
  const BAD_BASE = /^leket: --base takes a file name, not a path \(no \/ \\ or :\), not ending in a dot or space, and not a Windows reserved name like con or nul\n$/;
  const bad = [
    [[FIXTURE, FIXTURE], /give one backup/],
    [[FIXTURE, "--title", "T"], /--title goes with --number/],
    [[FIXTURE, "--base", "b"], /--base goes with --number/],
    [[FIXTURE, "--number", "abc"], /--number takes a phone number/],
    [[FIXTURE, "--number", "5550100001", "--base", "a/b"], BAD_BASE],
    [[FIXTURE, "--name", "Sam"], /--name takes NUMBER=LABEL/],
    [[FIXTURE, "--name", "5550100001= "], /takes a one-line label/],
    [[FIXTURE, "--me", "a\nb"], /--me takes a one-line label/],
    [[FIXTURE, "--tz", "Mars/Base"], /unknown time zone/],
  ];
  for (const [args, msg] of bad) {
    const r = leket(["convert", "sms", ...args]);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, msg);
  }
  assert.equal(leket(["convert", "sms"]).status, 2);
});

test("a < that would start a tag is escaped in a text; an address with a backtick stays one code span", () => {
  const xml = doc(sms({ address: "a`b", date: "1000", type: "1", body: "&lt;b&gt;hi&lt;/b&gt; 1 &lt; 2" }));
  const [f] = convert(xml).files;
  assert.match(f.text, /^> \\<b>hi\\<\/b> 1 < 2$/m);
  assert.match(f.text, /only the conversation with ``a`b``\./);
});
