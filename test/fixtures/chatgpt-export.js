// A synthetic ChatGPT data export (no real conversation): two exports, as
// { conversations, names }, covering what `leket convert chatgpt` has to handle.
//   c-plans  a root with no message, a system message, an edited prompt (the abandoned
//            answer stays out), images (named, unnamed, no pointer), a tool message, a
//            hidden one, code with no text parts, a blank answer, a message with no time,
//            a voice transcription; title with "/" and trailing dots. The second export
//            renames it (a later export wins).
//   c-null   no title and no start time
//   c-same1, c-same2  same day and title: the second gets its id added
//   c-pad    a title padded with whitespace; times in another zone
const T0 = 1709651220.75; // 2024-03-05T15:07:00.75Z

const msg = (id, role, parts, { t = T0, parent, children = [], hidden, content } = {}) => [id, {
  id,
  message: {
    id,
    author: { role },
    create_time: t,
    content: content || { content_type: parts.some((p) => typeof p !== "string") ? "multimodal_text" : "text", parts },
    metadata: hidden ? { is_visually_hidden_from_conversation: true } : {},
  },
  parent,
  children,
}];

const conv = (id, title, create_time, nodes, current_node) => ({
  conversation_id: id, id, title, create_time, update_time: create_time + 3600,
  mapping: Object.fromEntries(nodes), current_node,
});

const plans = (title) => conv("c-plans-0001", title, T0, [
  ["root", { id: "root", message: null, parent: null, children: ["sys"] }],
  msg("sys", "system", [""], { parent: "root", children: ["u1"] }),
  msg("u1", "user", ["first question"], { parent: "sys", children: ["a-old", "a1"] }),
  msg("a-old", "assistant", ["an answer from before the edit"], { t: T0 + 10, parent: "u1" }),
  msg("a1", "assistant", ["the kept answer\n\nwith a second paragraph"], { t: T0 + 20, parent: "u1", children: ["u2"] }),
  msg("u2", "user", [
    "see these",
    { content_type: "image_asset_pointer", asset_pointer: "file-service://file-NAMED1" },
    { content_type: "image_asset_pointer", asset_pointer: "sediment://file_UNNAMED2" },
    { content_type: "image_asset_pointer" },
    "  ",
  ], { t: T0 + 60, parent: "a1", children: ["tool"] }),
  msg("tool", "tool", ["tool output"], { parent: "u2", children: ["hid"] }),
  msg("hid", "assistant", ["a hidden note"], { parent: "tool", children: ["code"], hidden: true }),
  msg("code", "assistant", [], { parent: "hid", children: ["blank"], content: { content_type: "code", text: "print(1)" } }),
  msg("blank", "assistant", [" \n "], { parent: "code", children: ["notime"] }),
  msg("notime", "assistant", ["an answer with no time"], { t: null, parent: "blank", children: ["voice"] }),
  msg("voice", "user", [{ content_type: "audio_transcription", text: "spoken words" }], { t: T0 + 120, parent: "notime" }),
], "voice");

const one = (id, title, t) => conv(id, title, t, [
  msg(`${id}-u`, "user", ["hello"], { t, children: [`${id}-a`] }),
  msg(`${id}-a`, "assistant", ["hi"], { t: t + 5, parent: `${id}-u` }),
], `${id}-a`);

export const chatgptExports = () => [
  {
    label: "export one",
    conversations: [
      plans("an older title"),
      one("c-null-0002", null, 0),
      one("c-same1-0003", "Same", T0 + 86400),
    ],
    names: { "file-NAMED1.dat": "photo.png" },
  },
  {
    label: "export two",
    conversations: [
      plans("Plans / ideas.."),
      one("c-same2-0004", "Same", T0 + 86400 + 60),
      one("c-pad-0005", "  Padded\t", T0 + 2 * 86400),
    ],
    names: {},
  },
];
