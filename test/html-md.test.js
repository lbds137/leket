// src/lib/html-md.js: Takeout's reply HTML → GitHub Markdown. Its output was checked against
// pandoc 3.7 (-t gfm --wrap=none) on a real Gemini Takeout: every reply kept the same
// letters and digits, and most matched byte for byte. These cases are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";

import { decode, escapeHeading, htmlToMarkdown, oneLineText, parse } from "../src/lib/html-md.js";

const md = (h) => htmlToMarkdown(h).md;

test("text is escaped so it shows as written", () => {
  assert.equal(md("<p>*a* _b_ `c` [d] &lt;e&gt; f|g back\\slash $5 ~x~ snake_case &amp;copy;</p>"),
    "\\*a\\* \\_b\\_ \\`c\\` \\[d\\] \\<e\\> f\\|g back\\\\slash \\$5 \\~x\\~ snake_case \\&copy;");
  // what would start a block at the start of a line
  assert.equal(md("<p># h</p><p>1. n</p><p>12) n</p><p>- d</p><p>+ p</p><p>= e</p><p>#tag</p>"),
    "\\# h\n\n1\\. n\n\n12\\) n\n\n\\- d\n\n\\+ p\n\n\\= e\n\n#tag");
  assert.equal(md("<p>a<br>\n# b</p>"), "a\\\n\\# b");
});

test("inline marks, code spans and links", () => {
  assert.equal(md("<p><strong>b<em>i</em></strong> wo<strong>rd</strong>s <em> sp </em><strong></strong>x</p>"),
    "**b*i*** wo**rd**s *sp* x");
  assert.equal(md("<p><code>a`b</code> <code>`x`</code> <code>p|q</code></p>"), "``a`b`` `` `x` `` `p|q`");
  // spaces at a link label's ends stay outside the brackets
  assert.equal(md('<p>See<a href="https://e.com"> this page </a>for more.</p>'), "See [this page](https://e.com) for more.");
  assert.equal(md('<p><a href="https://e.com/a?b=1&amp;c=2">t</a> <a href="https://e.com">https://e.com</a> <a href="">empty</a> <a href="javascript:x">js</a> <a href="https://e.com/(x)">p</a></p>'),
    "[t](https://e.com/a?b=1&c=2) <https://e.com> empty js [p](<https://e.com/(x)>)");
  // only http(s), mailto and relative links stay links; any other scheme keeps its label
  assert.equal(md('<p><a href="data:text/html,x">d</a> <a href=" VBScript:x">v</a> <a href="java\nscript:x">j</a> <a href="mailto:a@b.c">m</a> <a href="../r.md">r</a> <a href="#f">f</a> <a href="a/b:c">p</a></p>'),
    "d v j [m](mailto:a@b.c) [r](../r.md) [f](#f) [p](a/b:c)");
  // another scheme keeps its address as text after the label, or as the label when it has none
  // or the label already is the address; a scripted one still shows only its label
  assert.equal(md('<p><a href="tel:+1-555">call</a> <a href="ftp://x.org/f_1"> get </a>it <a href="sms:1"></a> <a href="tel:2">tel:2</a> <a href=" file:///etc">f</a> <a href="javascript:x"></a>.</p>'),
    "call (tel:+1-555) get (ftp://x.org/f_1) it sms:1 tel:2 f .");
});

test("a line break inside a tel:/sms: address can't start a heading, list or table row", () => {
  assert.equal(md('<p><a href="tel:1\n\n# Injected">call</a></p><h2><a href="tel:2\n- x">c</a></h2>' +
    '<table><tr><td><a href="sms:3\r\n|y">d</a></td></tr></table><p><a href="ftp://h/a b\tc">f</a></p>'),
  "call (tel:1# Injected)\n\n## c (tel:2- x)\n\n| d (sms:3\\\\|y) |\n|---|\n\nf (ftp://h/a bc)");
});

test("other control characters go from a non-web address as shown too", () => {
  const c = String.fromCharCode;
  assert.equal(md(`<p><a href="tel:1${c(1)}2${c(0x1b)}[31m3${c(0x7f)}">call</a></p>`), "call (tel:12\\[31m3)");
  // C1 too: NEL, CSI (an escape sequence's one-character start) and the range's ends
  assert.equal(md(`<p><a href="tel:4${c(0x80)}5${c(0x85)}6${c(0x9b)}31m7${c(0x9f)}">call</a></p>`), "call (tel:45631m7)");
});

test("oneLineText: line breaks become spaces, a trailing # run is kept from CommonMark's closing sequence", () => {
  assert.equal(oneLineText("Moth\n\n# Keeper\r\n- x"), "Moth # Keeper - x");
  assert.equal(oneLineText("Issue #"), "Issue \\#");
  assert.equal(oneLineText("Tags ## \t"), "Tags \\## \t");
  assert.equal(oneLineText("#"), "\\#");
  assert.equal(oneLineText("C#"), "C#"); // no space before it: not a closing sequence
  assert.equal(oneLineText("a #1 b"), "a #1 b");
});

test("escapeHeading: escapes only the break-class (trailing #, odd backticks, <tag and &entity;), with escapeTag before the backtick sweep", () => {
  assert.equal(escapeHeading("Issue #"), "Issue \\#");
  assert.equal(escapeHeading("Issue ##"), "Issue \\##");
  assert.equal(escapeHeading("Issue ## \t "), "Issue \\##");
  assert.equal(escapeHeading("###"), "\\###");
  assert.equal(escapeHeading("<b> </i> <?x <!x <https://e.com>"), "\\<b> \\</i> \\<?x \\<!x \\<https://e.com>");
  assert.equal(escapeHeading("&amp; &#65; &#x41;"), "\\&amp; \\&#65; \\&#x41;");
  assert.equal(escapeHeading("a ` b"), "a \\` b");
  assert.equal(escapeHeading("`a` `b"), "\\`a\\` \\`b");
  assert.equal(escapeHeading("`a`"), "`a`");
  assert.equal(escapeHeading("`a` `b`"), "`a` `b`");
  assert.equal(escapeHeading("`<b>"), "\\`\\<b>");
  assert.equal(escapeHeading("*bold* _em_ [x](y) a #1 b #lead"), "*bold* _em_ [x](y) a #1 b #lead");
  assert.equal(escapeHeading("two\nlines"), "two\nlines");
});

test("a leading non-ASCII space doesn't unmask a scripted scheme", () => {
  assert.equal(md('<p><a href="&nbsp;javascript:alert(1)">x</a> <a href="&#x3000;data:x">y</a></p>'), "x y");
});

test("a NUL in an href is U+FFFD too, never a line break", () => {
  const r = String.fromCharCode(0xfffd);
  assert.equal(md('<p><a href="https://e.com/a\u0000b">x</a> <a href="tel:1\u00002">call</a></p><h2><a href="https://e.com/c\u0000d">h</a></h2>'),
    `[x](https://e.com/a${r}b) call (tel:1${r}2)\n\n## [h](https://e.com/c${r}d)`);
});

test("a NUL in the text is U+FFFD, never a line break", () => {
  assert.equal(md("<p>a\u0000b <code>c\u0000d</code></p><h2>x\u0000y</h2><pre>p\u0000q  </pre>"),
    "a\uFFFDb `c\uFFFDd`\n\n## x\uFFFDy\n\n```\np\uFFFDq  \n```");
});

test("lists: nesting, start numbers, loose items, empty items, two lists in a row", () => {
  assert.equal(md("<ul><li><strong>A:</strong> one<ul><li>n1</li><li>n2</li></ul></li><li>two</li></ul>"),
    "- **A:** one\n  - n1\n  - n2\n- two");
  assert.equal(md('<ol start="3"><li>c<ul><li>x</li></ul></li><li>d</li></ol>'), "3. c\n   - x\n4. d");
  assert.equal(md("<ol><li><p>p1</p><p>p2</p></li><li>q</li></ol>"), "1. p1\n\n   p2\n\n2. q");
  assert.equal(md("<ul><li></li><li>.</li></ul>"), "-\n- .");
  // two lists of one kind would merge without something between them
  assert.equal(md("<ul><li>a</li></ul><ul><li>b</li></ul><ol><li>c</li></ol>"), "- a\n\n<!-- -->\n\n- b\n\n1. c");
  // in a tight item, text after a quote or a nested list, or a rule under text, gets a
  // blank line: without it the text joins the quote or list, or the rule makes a heading
  assert.equal(md("<ul><li><blockquote><p>q</p></blockquote>out</li><li>head<hr>after</li><li>a<ul><li>b</li></ul>c</li></ul>"),
    "- > q\n\n  out\n- head\n\n  ---\n  after\n- a\n  - b\n\n  c");
  // an unclosed <li> closes at the next one
  assert.equal(md("<ul><li>a<li>b</ul>"), "- a\n- b");
});

test("headings, rules, quotes, hard breaks", () => {
  assert.equal(md("<h1>A</h1><h3>B <strong>c</strong></h3><h4></h4><hr><blockquote>\n<p>q <em>e</em></p>\n<p>r</p></blockquote>"),
    "# A\n\n### B **c**\n\n---\n\n> q *e*\n>\n> r");
  assert.equal(md("<p>one<br>\ntwo<br></p>"), "one\\\ntwo");
  assert.equal(md("<h2>a<br>b</h2>"), "## a b");
});

test("tables: alignment, pipes in cells and code, ragged rows", () => {
  const t = '<table><thead><tr><th align="left">A</th><th align="center">B|x</th><th>C</th></tr></thead>' +
    '<tbody><tr><td align="left"><strong>1</strong></td><td><code>p|q</code></td></tr></tbody></table>';
  // text B|x is escaped twice: B\| as text, then one more for the cell
  assert.equal(md(t), "| A | B\\\\|x | C |\n|:---|:---:|---|\n| **1** | `p\\|q` |  |");
  assert.equal(md("<table></table>"), "");
  // GFM splits cells at bare pipes, then drops one backslash before every pipe, code spans
  // included: each pipe gets one more backslash, so text x\|y and a code span's own \|
  // come through as written (both checked on GitHub's renderer); a list or a <pre> in a
  // cell stays one spaced line, the <pre> as code
  assert.equal(md("<table><tr><th>Op</th></tr><tr><td><code>a || b</code> x\\|y <code>c\\|d</code></td></tr></table>"),
    "| Op |\n|---|\n| `a \\|\\| b` x\\\\\\\\|y `c\\\\|d` |");
  assert.equal(md("<table><tr><td><ul><li>First</li><li>Second</li></ul></td><td><pre><code>x * y</code></pre></td></tr></table>"),
    "| First Second | `x * y` |\n|---|---|");
});

test("pre: tags inside it are dropped, its text kept; the fence outlasts any inside it", () => {
  // what Takeout writes: <p> inside <pre><code>, and a </code><p><code> seam
  assert.equal(md("<pre><code>model A {\n<p>id String\n}</p>\n</code><p><code>-- next &amp; last\n</code></p></pre><p>after</p>"),
    "```\nmodel A {\nid String\n}\n-- next & last\n```\n\nafter");
  assert.equal(md("<pre>```\nx\n```</pre>"), "````\n```\nx\n```\n````");
  assert.equal(md("<ol><li>run:\n<pre><code>a\n  b\n</code></pre></li></ol>"), "1. run:\n   ```\n   a\n     b\n   ```");
  // the last line keeps its trailing spaces too; only final newlines go, and a blank block is dropped
  assert.equal(md("<pre>a  \nb  \n\n</pre><pre>c  </pre><pre> \n </pre>"), "```\na  \nb  \n```\n\n```\nc  \n```");
  // code keeps its trailing spaces (in a quote too); other lines lose theirs; a NUL in code
  // shows as U+FFFD
  assert.equal(md("<pre>a  \nb\t\nc</pre><p>x  </p><blockquote><pre>q \nr</pre></blockquote><pre>n\u0000</pre>"),
    "```\na  \nb\t\nc\n```\n\nx\n\n> ```\n> q \n> r\n> ```\n\n```\nn\uFFFD\n```");
});

test("an unknown tag keeps its text and is counted", () => {
  const r = htmlToMarkdown("<p>a <mark>b</mark> <span>c</span></p><custom>d</custom>");
  assert.equal(r.md, "a b c\n\nd");
  assert.deepEqual({ ...r.unknown }, { mark: 1, custom: 1 });
});

test("entities: named, numeric, unknown and out of range", () => {
  assert.equal(decode("&quot;&#39;&amp;&nbsp;&hellip;&#x1F600;&bogus;&#0;&#xD800;"),
    `"'&${String.fromCodePoint(0xa0, 0x2026, 0x1f600)}&bogus;${String.fromCodePoint(0xfffd, 0xfffd)}`);
  // non-Latin text passes through, an underscore inside a word stays bare
  assert.equal(md("<p>שלום_עולם _x</p>"), "שלום_עולם \\_x");
});

test("a slash ending an unquoted value is the value's; one after it or a quote closes the tag", () => {
  assert.equal(md("<a target=\"_blank\" href=http://b.example/>b</a>"), "[b](http://b.example/)");
  assert.equal(md("<a href=x />t"), "[x](x)t");
  assert.equal(md("<a href=\"x\"/>t"), "[x](x)t");
  assert.equal(md("<b/>t"), "t");
});

test("an unquoted value runs to a space or the tag's end, = and / inside it its own", () => {
  assert.equal(md("<a href=/>home</a>"), "[home](/)");
  assert.equal(md("<a target=x href=http://v.example/watch?v=1&feature=r>v</a>"), "[v](http://v.example/watch?v=1&feature=r)");
  assert.equal(md("<a href='x'/>t"), "[x](x)t");
  assert.equal(md("<a b/>t"), "t");
  // a quoted attribute holding "=" before "/>" still self-closes; an unquoted one holding "/" does not
  const closed = parse('<a title="x=y"/>next').children;
  assert.equal(closed.length, 2);
  assert.deepEqual([closed[0].tag, closed[0].attrs.title, closed[0].children, closed[1]], ["a", "x=y", [], "next"]);
  const unquoted = parse("<a href=x/>next").children;
  assert.equal(unquoted.length, 1);
  assert.deepEqual([unquoted[0].tag, unquoted[0].attrs.href, unquoted[0].children], ["a", "x/", ["next"]]);
  assert.equal(md("<a href=x/>next"), "[next](x/)");
  const normal = parse('<a title="x=y">t</a>').children;
  assert.equal(normal.length, 1);
  assert.deepEqual([normal[0].tag, normal[0].attrs.title, normal[0].children], ["a", "x=y", ["t"]]);
  assert.equal(md('<a title="x=y">t</a>'), "t");
});
