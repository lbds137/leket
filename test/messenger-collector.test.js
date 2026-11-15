// Unit tests for src/modules/messenger/collector.js against test/fixtures/messenger_page.cjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const RUN = fileURLToPath(new URL("./fixtures/messenger_page.cjs", import.meta.url));

function loadRead() {
  const src = readFileSync(new URL("../src/modules/messenger/read.js", import.meta.url), "utf8");
  const mod = { exports: {} };
  vm.runInNewContext(src, { module: mod });
  return mod.exports;
}

const { validSaveName, validMediaName } = loadRead();

const keyOf = (scenario, args = []) => JSON.stringify([scenario, args]);
const pages = new Map();

const runPage = async (scenario, args = []) => {
  const key = keyOf(scenario, args);
  if (!pages.has(key)) {
    const p = new Promise((resolve, reject) => {
      execFile("node", [RUN, scenario, ...args], { encoding: "utf8" }, (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(new Error(`messenger_page ${scenario} printed invalid JSON (${parseErr.message}): ${stdout.slice(0, 200)}`));
        }
      });
    });
    p.catch(() => {});
    pages.set(key, p);
  }
  return structuredClone(await pages.get(key));
};

// Warm scenarios through a bounded pool
const WARM = [
  ["full"],
  ["video"],
  ["stalled"],
  ["pin"],
  ["group"],
  ["handoff-too-soon"],
  ["handoff-no-bridge"],
  ["handoff-no-ack"],
  ["handoff-nack"],
  ["off-thread"],
  ["short", ["(3) שלום עולם | Messenger"]],
  ["short", ["🎉🚀🌟 | Messenger"]],
  ["short"],
  ["remint"],
  ["fractional"],
  ["scroll-stuck-down"],
  ["scroll-stuck-up"],
  ["async-mount"],
  ["throw-row"],
  ["sweep-throw"],
  ["remount-no-double"],
  ["save-close"],
  ["save-close-ack"],
  ["control-stop-save"],
  ["control-stop-start"],
  ["control-start-while-sweeping"],
  ["control-save-mid-sweep"],
  ["second-launch"],
  ["broken-img"],
];
const POOL = 8;
const warmQueue = [...WARM];
for (let i = 0; i < POOL && warmQueue.length; i++) {
  (async () => {
    while (warmQueue.length) {
      const [s, a] = warmQueue.shift();
      await runPage(s, a).catch(() => {});
    }
  })();
}

test("1. full: 60 messages from two senders, swept up and down, sorted with senders and validSaveName", async () => {
  const page = await runPage("full");
  const exp = page.export;
  assert.equal(exp.leket, "messenger");
  assert.equal(exp.version, 1);
  assert.equal(exp.count, 60);
  assert.equal(exp.messages.length, 60);
  assert.equal(new Set(exp.messages.map((m) => m.id)).size, 60);

  for (let i = 1; i < exp.messages.length; i++) {
    const prev = exp.messages[i - 1];
    const cur = exp.messages[i];
    const cmp = Date.parse(prev.time) - Date.parse(cur.time) || String(prev.id).localeCompare(String(cur.id));
    assert.ok(cmp <= 0, `messages sorted at index ${i}: ${prev.id} (${prev.time}) vs ${cur.id} (${cur.time})`);
  }

  assert.deepEqual(exp.senders, { "101": "Ada Example", "102": "Bo Example" });
  for (const m of exp.messages) {
    assert.ok(m.sender === "Ada Example" || m.sender === "Bo Example", `sender set on ${m.id}`);
    assert.equal(typeof m.outgoing, "boolean", `outgoing boolean on ${m.id}`);
  }

  assert.equal(validSaveName(page.file), page.file);
  assert.equal(page.posted.type, "leket:messenger-export");
  assert.equal(page.downloaded, false);
  assert.match(page.statusAfterSweep, /^Done: 60 messages from the start of the conversation\. Press Save\./);
  assert.match(page.statusAfterSave, /^Handed to the export tab \(it opens next to this one\): 60 messages, /);
});

test("2. dedupe: rows seen on both legs are one message each, and null fields filled on the second read are merged", async () => {
  const page = await runPage("full");
  const exp = page.export;
  assert.equal(exp.messages.filter((m) => m.id === "msg-021").length, 1);
  assert.equal(page.rowVisits["msg-021"], 2, "row 20 (msg-021) was mounted on both legs");

  const lateFieldMsg = exp.messages.find((m) => m.id === "msg-021");
  assert.equal(lateFieldMsg.sender, "Ada Example");
  assert.equal(lateFieldMsg.outgoing, true);
  assert.deepEqual(lateFieldMsg.reply_to, { text: "reply filled on second mount" });

  // msg-016 never had contact.name on its own fiber chain, but gets it from senders map at Save
  const fromMapMsg = exp.messages.find((m) => m.id === "msg-016");
  assert.equal(fromMapMsg.sender, "Bo Example");
});

test("3. photo late: a data: photo row whose img completes only on its second mount is captured on the way down", async () => {
  const page = await runPage("full");
  const exp = page.export;
  const m = exp.messages.find((x) => x.id === "msg-026");
  assert.equal(page.rowVisits["msg-026"], 2);
  assert.equal(m.media.length, 1);
  const photo = m.media[0];
  assert.equal(photo.kind, "photo");
  assert.equal(photo.mime, "image/jpeg");
  assert.equal(photo.width, 240);
  assert.equal(photo.height, 180);
  assert.equal(photo.bytes, 96);
  assert.equal(photo.duration_s, null);

  const postedFile = page.posted.files.find((f) => f.name === photo.file);
  assert.ok(postedFile, "photo blob is in posted files");
  assert.equal(postedFile.isBlob, true);
  assert.equal(postedFile.size, 96);
  assert.deepEqual(postedFile.head.slice(0, 3), [0xff, 0xd8, 0xff]);
  assert.deepEqual(exp.media_not_captured, []);
});

test("4. video: a blob: video is captured with sniffed mime and duration_s; a throwing video is in media_not_captured", async () => {
  const page = await runPage("video");
  const exp = page.export;
  const m = exp.messages.find((x) => x.id === "msg-029");
  assert.ok(m.kinds.includes("video"), "video added to message kinds");
  assert.equal(m.media.length, 1);
  const vid = m.media[0];
  assert.equal(vid.kind, "video");
  assert.equal(vid.mime, "video/mp4");
  assert.ok(vid.file.endsWith(".mp4"), `expected .mp4 file name, got ${vid.file}`);
  assert.equal(vid.width, 640);
  assert.equal(vid.height, 360);
  assert.equal(vid.bytes, 96);
  assert.equal(vid.duration_s, 13.5);

  const postedVid = page.posted.files.find((f) => f.name === vid.file);
  assert.ok(postedVid);
  assert.equal(postedVid.size, 96);

  assert.equal(exp.media_not_captured.length, 1);
  assert.equal(exp.media_not_captured[0].message_id, "msg-029");
  assert.equal(exp.media_not_captured[0].kind, "video");
  assert.match(exp.media_not_captured[0].reason, /^fetch failed: .*MediaSource/);
});

test("5. link row: records first a[href^='http'] href as link and ignores its thumbnail img", async () => {
  const page = await runPage("full");
  const exp = page.export;
  const m = exp.messages.find((x) => x.id === "msg-031");
  assert.deepEqual(m.kinds, ["text", "media", "link"]);
  assert.equal(m.link, "https://example.com/shared-card");
  assert.deepEqual(m.media, []);
  assert.ok(!exp.media_not_captured.some((x) => x.message_id === "msg-031"));
});

test("6. unsent row: unsent is true and the message is kept", async () => {
  const page = await runPage("full");
  const exp = page.export;
  const m = exp.messages.find((x) => x.id === "msg-036");
  assert.ok(m, "unsent message is kept");
  assert.equal(m.unsent, true);
  assert.deepEqual(m.media, []);
});

test("7. filtered imgs: 16x16 receipt, 100x100 https avatar, and emoji img in a media row are neither captured nor reported", async () => {
  const page = await runPage("full");
  const exp = page.export;
  const m = exp.messages.find((x) => x.id === "msg-041");
  assert.equal(m.media.length, 1, "only the 180x180 photo is captured");
  assert.equal(m.media[0].width, 180);
  assert.equal(m.media[0].height, 180);
  assert.ok(!exp.media_not_captured.some((x) => x.message_id === "msg-041"));
});

test("8. name collision: two photos whose mediaName collides case-insensitively get -2", async () => {
  const page = await runPage("full");
  const exp = page.export;
  const m1 = exp.messages.find((x) => x.id === "MsgCollide");
  const m2 = exp.messages.find((x) => x.id === "msgcollide");
  assert.equal(m1.media.length, 1);
  assert.equal(m2.media.length, 1);
  const f1 = m1.media[0].file;
  const f2 = m2.media[0].file;
  assert.notEqual(f1.toLowerCase(), f2.toLowerCase());
  assert.match(f1, /^2026-11-15_MsgCollide_1\.jpg$/i);
  assert.match(f2, /^2026-11-15_msgcollide_1-2\.jpg$/i);
  assert.equal(validMediaName(f1), true);
  assert.equal(validMediaName(f2), true);
});

test("9. stalled: when the header never mounts, status contains STALLED and Save still works", async () => {
  const page = await runPage("stalled");
  assert.match(
    page.statusAfterSweep,
    /^STALLED, not at the start: 60 messages collected\. Press Save to keep them, or Start to try again\./,
  );
  assert.equal(page.export.count, 60);
  assert.equal(page.export.messages.length, 60);
  assert.equal(page.posted.type, "leket:messenger-export");
});

test("10. pin: when no rows mount within 10 virtual seconds, status shows PIN sentence and collector never clicks page elements", async () => {
  const page = await runPage("pin");
  assert.equal(page.elapsedMs, 10000);
  assert.equal(
    page.statusAfterSweep,
    "No messages are showing. If Messenger is asking for your PIN to restore chats, enter it there, then press Start again.",
  );
  assert.equal(page.statusAfterSave, "Nothing collected yet: press Start.");
  assert.deepEqual(page.nonPanelClicks, []);
  assert.equal(page.posted, false);
  assert.equal(page.downloaded, false);
});

test("11. group: three distinct senders set group_warning: true and show the warning in the status", async () => {
  const page = await runPage("group");
  assert.equal(page.export.group_warning, true);
  assert.equal(Object.keys(page.export.senders).length, 3);
  assert.ok(page.statusAfterSweep.includes("This looks like a group conversation; groups aren't checked yet."));
  assert.ok(page.statusAfterSave.includes("This looks like a group conversation; groups aren't checked yet."));
});

test("12. handoff: too-soon ack does not download and says wait; no-ack, nack, and no-bridge fall back to JSON download", async () => {
  const tooSoon = await runPage("handoff-too-soon");
  assert.equal(tooSoon.downloaded, false);
  assert.equal(tooSoon.statusAfterSave, "Saved less than 10 seconds ago: wait a moment and press Save again.");

  const noBridge = await runPage("handoff-no-bridge");
  assert.equal(noBridge.downloaded, true);
  assert.equal(noBridge.revokedUrlsCount, 1);
  assert.equal(noBridge.posted, null);
  assert.ok(noBridge.export.messages.every((m) => m.media.length === 0), "all message media lists emptied on fallback");
  const moved = noBridge.export.media_not_captured.filter(
    (x) => x.reason === "saved without the extension, so media files were not kept",
  );
  assert.equal(moved.length, 4, "all 4 captured photos in full scenario moved to media_not_captured");
  assert.deepEqual(
    moved.map((x) => x.message_id).sort(),
    ["MsgCollide", "msg-026", "msg-041", "msgcollide"],
  );

  for (const mode of ["handoff-no-ack", "handoff-nack"]) {
    const fb = await runPage(mode);
    assert.ok(fb.posted, `${mode}: tried to post to bridge first`);
    assert.equal(fb.downloaded, true, `${mode}: fell back to anchor download`);
    assert.equal(fb.revokedUrlsCount, 1, `${mode}: revoked fallback anchor object URL`);
    assert.match(fb.statusAfterSave, /^The extension didn't answer /);
    assert.ok(fb.export.messages.every((m) => m.media.length === 0));
  }
});

test("13. off-thread path (/t/abc): mounts open-a-conversation panel with Close only and no Start button", async () => {
  const page = await runPage("off-thread");
  assert.equal(page.panelMounted, true);
  assert.equal(
    page.status,
    "Open a one-to-one conversation on messenger.com or facebook.com/messages, then click Leket's button again.",
  );
  assert.deepEqual(page.buttons, ["Close"]);
});

test("14. title cleanup: Hebrew title with unread count and emoji title produce validSaveName files", async () => {
  const heb = await runPage("short", ["(3) שלום עולם | Messenger"]);
  assert.equal(heb.export.title, "שלום עולם");
  assert.equal(heb.file, "messenger-שלום_עולם-789012345.json");
  assert.equal(validSaveName(heb.file), heb.file);

  const emoji = await runPage("short", ["🎉🚀🌟 | Messenger"]);
  assert.equal(emoji.export.title, "🎉🚀🌟");
  assert.equal(emoji.file, "messenger-_-789012345.json");
  assert.equal(validSaveName(emoji.file), emoji.file);
});

test("15. short: 5 rows with no overflow and header mounted ends as Done with 5 messages", async () => {
  const page = await runPage("short");
  assert.equal(page.statusAfterSweep, "Done: 5 messages from the start of the conversation. Press Save.");
  assert.equal(page.export.count, 5);
  assert.equal(page.export.messages.length, 5);
});

test("16. remint: a video row whose blob: URL is new on each mount (same bytes) is captured only once", async () => {
  const page = await runPage("remint");
  const exp = page.export;
  const m = exp.messages.find((x) => x.id === "msg-033");
  assert.ok(page.fetchCalls.includes("blob:https://www.messenger.com/remint-1"));
  assert.ok(page.fetchCalls.includes("blob:https://www.messenger.com/remint-2"));
  assert.equal(m.media.length, 1);
  const videoFiles = page.posted.files.filter((f) => f.name.endsWith(".mp4"));
  assert.equal(videoFiles.length, 1);
});

test("17. termination: fractional scrollTop (0.4 px from top/bottom) and stuck scrollTop on either leg finish within virtual-time bound", async () => {
  const frac = await runPage("fractional");
  assert.ok(frac.elapsedMs < 35000, `fractional sweep finished in ${frac.elapsedMs}ms (< 35000ms)`);
  assert.match(frac.statusAfterSweep, /^Done: 60 messages from the start of the conversation\. Press Save\./);
  assert.equal(frac.export.count, 60);

  const stuckDown = await runPage("scroll-stuck-down");
  assert.ok(stuckDown.elapsedMs < 35000, `stuck-down sweep finished in ${stuckDown.elapsedMs}ms (< 35000ms)`);
  assert.match(stuckDown.statusAfterSweep, /^Done: 60 messages from the start of the conversation\. Press Save\./);

  const stuckUp = await runPage("scroll-stuck-up");
  assert.ok(stuckUp.elapsedMs < 35000, `stuck-up sweep finished in ${stuckUp.elapsedMs}ms (< 35000ms)`);
  assert.match(stuckUp.statusAfterSweep, /^STALLED, not at the start: /);
});

test("18. order: async-mounting scroller (rows mount after a setTimeout on scrollTop change) still harvests all 60 messages and the late photo", async () => {
  const page = await runPage("async-mount");
  assert.match(page.statusAfterSweep, /^Done: 60 messages from the start of the conversation\. Press Save\./);
  assert.equal(page.export.count, 60);
  const late = page.export.messages.find((m) => m.id === "msg-026");
  assert.equal(late.media.length, 1);
  assert.deepEqual(page.export.media_not_captured, []);
});

test("19. robustness: a throwing row fiber getter is skipped and counted in status; an unexpected sweep throw sets ERROR and Save still works", async () => {
  const rowThrow = await runPage("throw-row");
  assert.equal(
    rowThrow.statusAfterSweep,
    "Done: 59 messages from the start of the conversation. Press Save. (1 row could not be read)",
  );
  assert.equal(rowThrow.export.count, 59);
  assert.ok(!rowThrow.export.messages.some((m) => m.id === "msg-018"));

  const sweepThrow = await runPage("sweep-throw");
  assert.equal(
    sweepThrow.statusAfterSweep,
    "ERROR: scroller detached. Press Save to keep what was collected.",
  );
  assert.ok(sweepThrow.export.count > 0 && sweepThrow.export.count < 60);
  assert.equal(sweepThrow.posted.type, "leket:messenger-export");
});

test("20. no double bookkeeping: captured video remounted without src and captured photo remounted incomplete with new blob URL stay out of media_not_captured", async () => {
  const page = await runPage("remount-no-double");
  const exp = page.export;
  const vidMsg = exp.messages.find((m) => m.id === "msg-029");
  const photoMsg = exp.messages.find((m) => m.id === "msg-035");
  assert.equal(page.rowVisits["msg-029"], 2);
  assert.equal(page.rowVisits["msg-035"], 2);
  assert.equal(vidMsg.media.length, 1);
  assert.equal(vidMsg.media[0].kind, "video");
  assert.equal(photoMsg.media.length, 1);
  assert.equal(photoMsg.media[0].kind, "photo");
  assert.deepEqual(exp.media_not_captured, []);
});

test("21. memory: blob: reads slice only first/last 64 bytes, never call arrayBuffer() on the whole blob, and keep the Blob itself for posting", async () => {
  const page = await runPage("video");
  assert.equal(page.fullBlobArrayBufferCalls, 0);
  assert.deepEqual(page.blobSlices, [[0, 64], [32, null]]);
  const vidMsg = page.export.messages.find((m) => m.id === "msg-029");
  const postedVid = page.posted.files.find((f) => f.name === vidMsg.media[0].file);
  assert.ok(postedVid);
  assert.equal(postedVid.sameBlobInstance, true);
});

test("22. close: Save pressed mid-sweep then Close before ack posts nothing and downloads nothing; Close during ack wait skips fallback download", async () => {
  const mid = await runPage("save-close");
  assert.equal(mid.panelMountedAfterClose, false);
  assert.equal(mid.posted, null);
  assert.equal(mid.downloaded, false);

  const duringAck = await runPage("save-close-ack");
  assert.equal(duringAck.downloaded, false);
});

test("23. controls and broken img: Stop+Save, Stop+Start, Start while sweeping, Save during sweep, second launch, and broken complete img", async () => {
  const stopSave = await runPage("control-stop-save");
  assert.equal(stopSave.statusAfterStop, "Stopped: press Save to keep what was collected, or Start to go on.");
  assert.ok(stopSave.export.count > 0 && stopSave.export.count < 60);
  assert.equal(stopSave.posted.type, "leket:messenger-export");

  const stopStart = await runPage("control-stop-start");
  assert.equal(stopStart.statusAfterStop, "Stopped: press Save to keep what was collected, or Start to go on.");
  assert.equal(stopStart.statusAfterSweep, "Done: 60 messages from the start of the conversation. Press Save.");
  assert.equal(stopStart.export.count, 60);

  const full = await runPage("full");
  const startWhileSweeping = await runPage("control-start-while-sweeping");
  assert.deepEqual(startWhileSweeping.scrollHistory, full.scrollHistory);
  assert.equal(startWhileSweeping.export.count, 60);

  const saveMidSweep = await runPage("control-save-mid-sweep");
  assert.equal(saveMidSweep.postCount, 1);
  assert.equal(saveMidSweep.scrollStepsAfterSave, 0);
  assert.ok(saveMidSweep.export.count > 0 && saveMidSweep.export.count < 60);

  const secondLaunch = await runPage("second-launch");
  assert.equal(secondLaunch.panelCount, 1);
  assert.equal(secondLaunch.export.count, 60);

  const broken = await runPage("broken-img");
  assert.deepEqual(broken.export.media_not_captured, [
    { message_id: "msg-030", kind: "photo", reason: "the photo never finished loading" },
  ]);
});
