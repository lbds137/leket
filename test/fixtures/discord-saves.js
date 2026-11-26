// Synthetic Discord saves for `leket convert discord` (test/convert-discord.test.js).
// Every name, id and line here is made up. Shapes follow the collector's JSON
// (src/modules/discord/collector.js): one DM saved twice, one server channel saved twice.

// two ids one apart past 2^53: as Numbers they are equal, so only a BigInt sort orders them
const BIG = 1234567890123456789n;
export const ids = { a: String(BIG), b: String(BIG + 1n) };

const msg = (id, datetime, over = {}) => ({
  id, datetime, author: "Wren", author_username: "wren.k", author_id: "111", nick: null, text: "",
  reply_to: null, attachments: [], embeds: [], edited: false, type: 0, ...over,
});
const fox = { author: "Fox", author_username: "fox_77", author_id: "222" };

export function dmSaves() {
  const first = {
    source: "discord", channel: "fox_77", channel_id: "900", guild_id: null, guild_name: null,
    extracted_at: "2025-01-03T10:00:00.000Z", reached_start: false, reached_since: null,
    messages: [
      // New Year's Eve in New York, already the next year in UTC: the year split follows --tz
      msg("100", "2025-01-01T04:30:00.000Z", { text: "last one of the year  \nsecond line" }),
      msg("101", "2025-01-01T05:10:00.000Z", { ...fox, text: "happy new year 🎉", edited: true }),
      // a reply quoting a long message: 80 characters, an emoji never split
      msg("102", "2025-01-01T05:11:00.000Z", { reply_to: "103" }),
      msg("103", "2025-01-01T05:12:00.000Z", { ...fox, text: `${"word ".repeat(15)}🎉🎉🎉 and\n\nmore   spaced   text` }),
      msg("104", "2025-01-01T05:13:00.000Z", { reply_to: "105", text: "about that file" }),
      msg("105", "2025-01-01T05:14:00.000Z", { ...fox, attachments: [{ filename: "voice-message.ogg", url: "https://x.test/v" }] }),
      msg("106", "2025-01-01T05:15:00.000Z", { reply_to: "1", text: "replying to something older" }),
      // a forward saved before its snapshot arrived: the second save has it
      msg("107", "2025-01-01T05:16:00.000Z", { forward_of: { message_id: "5", channel_id: "6", guild_id: null }, forwarded: [] }),
      msg("108", "2025-01-01T05:17:00.000Z", { ...fox, forward_of: { message_id: "7", channel_id: "8", guild_id: null }, forwarded: [] }),
      msg("109", "2025-01-01T05:18:00.000Z", { embeds: [{ type: "gifv", url: "https://x.test/g" }] }),
      msg("110", "2025-01-01T05:19:00.000Z", { text: "look", embeds: [{ type: "link", title: "A page" }, { type: "rich" }] }),
      msg("111", "2025-01-02T15:00:00.000Z", { author: null, author_username: null, author_id: null, type: 7 }),
      msg(ids.b, "2025-01-02T16:00:00.000Z", { text: "the later of two near ids" }),
    ],
  };
  const second = {
    ...first, extracted_at: "2025-01-05T10:00:00.000Z", reached_start: true,
    messages: [
      { ...first.messages[0], text: "a different copy: the first save's wins" },
      msg("107", "2025-01-01T05:16:00.000Z", {
        forward_of: { message_id: "5", channel_id: "6", guild_id: null },
        forwarded: [{ text: "forwarded words\nline two", datetime: null, attachments: [{ filename: "clip.ogg", url: "u" }], embeds: [] }],
      }),
      msg(ids.a, "2025-01-02T16:00:00.000Z", { ...fox, text: "the earlier of two near ids" }),
    ],
  };
  return [first, second];
}

// voice transcripts for the DM: an attachment's and a forward's
export const dmVoice = {
  "105_0": { duration: 65, text: "hello there" },
  "107_f0_0": { duration: 7, text: "" },
};

export function channelSaves() {
  const people = [
    { id: "111", username: "wren.k", global_name: "Wren", nick: "Wrennie", roles: [{ id: "r1", name: "Mods" }, { id: "r2", name: null }, { id: "r3", name: "Art | Craft" }], shown_as: "Wrennie", webhook: false },
    { id: "222", username: "fox_77", global_name: "Fox", nick: null, roles: [], shown_as: null, webhook: false },
    { id: "333", username: "proxybot", global_name: null, nick: null, roles: null, shown_as: "Moth", webhook: true },
  ];
  const first = {
    source: "discord", channel: "general", channel_id: "700", guild_id: "50", guild_name: "Test Server",
    extracted_at: "2025-02-01T10:00:00.000Z", reached_start: false, reached_since: null,
    hidden_groups: { groups: [{ kind: "blocked", count: 2, opened: true }, { kind: "ignored", count: 1, opened: true }, { kind: "blocked", count: 9, opened: false }] },
    participants: people,
    messages: [
      msg("200", "2025-01-31T12:00:00.000Z", { text: "hi all" }),
      msg("201", "2025-01-31T12:05:00.000Z", { ...fox, reply_to: "200", text: "hey" }),
      msg("202", "2025-02-01T03:00:00.000Z", { author: "Moth", author_username: "proxybot", author_id: "333", text: "proxied" }),
      msg("203", "2025-02-01T03:01:00.000Z", { author: "Beetle", author_username: "proxybot", author_id: "333", text: "another name, same id" }),
      msg("204", "2025-02-01T03:02:00.000Z", { author: "Moth", author_username: "proxybot", author_id: "333", text: "again" }),
      msg("205", "2025-02-02T09:00:00.000Z", { author: "Deleted User", author_username: "deleted_user_x", author_id: "456", hand_added: true, text: "gone now" }),
    ],
  };
  const second = {
    ...first, extracted_at: "2025-02-03T10:00:00.000Z",
    hidden_groups: { groups: [{ kind: "blocked", count: 3, opened: true }] },
    messages: [msg("206", "2025-02-03T09:00:00.000Z", { text: "pipes | in | text" })],
  };
  return [first, second];
}
