// A synthetic Google Takeout of Gemini activity, in two snapshots (older first): every
// shape the converter handles. Not a real conversation.
const link = (id) => [{ name: "Gemini Apps", url: `https://gemini.google.com/app/${id}` }];
const row = (time, title, more = {}) => ({ header: "Gemini Apps", title, time, products: ["Gemini Apps"], activityControls: ["Gemini Apps Activity"], ...more });

export function geminiSnapshots() {
  const older = [
    row("2025-03-01T09:00:00.250Z", "Prompted Plan a trip to Lisbon: 3 days, *cheap*", {
      details: link("aaa111"),
      safeHtmlItem: [
        { html: "<p>Here is a <strong>plan</strong>:</p>\n<ol>\n<li>Day one: Alfama</li>\n<li>Day two: Belém</li>\n</ol>" },
        { html: "<p>Here is a <strong>plan</strong>:</p>\n<ol>\n<li>Day one: Alfama</li>\n<li>Day two: Belém</li>\n</ol>" },
        { html: "<p>A shorter plan: walk.</p>" },
        { html: "<p> </p>" },
      ],
      subtitles: [{ name: "Trip Gem was used in this chat. Manage your Gems.", url: "https://gemini.google.com/gems/view" },
        { name: "Attached 1 file.", url: "" }, { name: "-  map.jpg", url: "map-1a2b.jpg" }],
      attachedFiles: ["map-1a2b.jpg", "notes.txt"],
    }),
    row("2025-03-01T09:05:00.000Z", "Prompted and Porto?", {
      details: link("aaa111"),
      safeHtmlItem: [{ html: "<p>Porto has:</p>\n<ul>\n<li>.</li>\n<li>. .</li>\n<li>Livraria Lello</li>\n</ul>" }],
    }),
    row("2025-03-01T09:06:00.000Z", "Created Gemini Canvas titled Packing / List", {
      details: link("aaa111"),
      subtitles: [{ name: "# Packing\n\n- socks\n- charger" }],
    }),
    row("2025-03-02T10:00:00.000Z", "Added chat from link: https://g.co/gemini/share/abc", {
      details: link("bbb222"),
      safeHtmlItem: [{ html: "<p>Shared answer with $5 and a|pipe.</p>" }],
    }),
    row("2025-03-02T11:00:00.000Z", "Used an Assistant feature", { details: link("ccc333") }),
    row("2025-03-03T08:00:00.000Z", "Created Gemini Canvas titled Trip Plan", {
      subtitles: [{ name: "# Trip Plan\n\nDay one." }],
    }),
    row("2025-03-03T08:30:00.000Z", "Gave feedback: Good response"),
    row("2025-03-04T12:00:00.000Z", "Prompted שלום, מה שלומך היום? (טסט)", {
      details: link("ddd444"),
      safeHtmlItem: [{ html: "<pre><code>model A {\n<p>id String\n}</p>\n</code><p><code>-- end\n</code></p></pre>" }],
      imageFile: "photo.png",
    }),
    row("2025-03-01T18:00:00.000Z", "Prompted Plan a trip to Lisbon: 3 days, *cheap*", {
      details: link("eee555"),
      safeHtmlItem: [{ html: "<p>Again?</p>" }],
    }),
  ];
  const newer = [
    // the same row as in the older snapshot, its reply since changed: the first given wins
    row("2025-03-01T09:05:00.000Z", "Prompted and Porto?", {
      details: link("aaa111"), safeHtmlItem: [{ html: "<p>Changed later.</p>" }],
    }),
    row("2025-03-05T07:00:00.000Z", "Prompted thanks", { details: link("aaa111") }),
    { header: "Search", title: "Searched for lisbon trams", time: "2025-03-05T07:30:00.000Z", products: ["Search"] },
  ];
  return [{ label: "older", rows: older }, { label: "newer", rows: newer }];
}
