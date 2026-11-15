// Runs src/modules/messenger/read.js and src/modules/messenger/collector.js against a
// synthetic Messenger page in node:vm and prints the resulting state as JSON on stdout.
// Usage: node test/fixtures/messenger_page.cjs <scenario> [tabTitle]
// Synthetic data only: Ada Example, Bo Example, Cy Example.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const scenario = process.argv[2] || "full";
const customTitle = process.argv[3];

const THREAD_ID = "789012345";
const pathname = scenario === "off-thread" ? "/t/abc" : `/e2ee/t/${THREAD_ID}`;
const origin = "https://www.messenger.com";
const href = `${origin}${pathname}`;

// Synthetic JPEG (starts with FF D8 FF) and MP4 (....ftypmp42) payloads >= 80 bytes so
// first-64 and last-64 byte signatures cover multi-word ranges.
const makeJpegBytes = (tagByte = 1) => {
  const b = new Uint8Array(96);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  for (let i = 4; i < 94; i++) b[i] = (i + tagByte) & 0xff;
  b[94] = 0xff;
  b[95] = 0xd9;
  return b;
};

const makeMp4Bytes = (tagByte = 1) => {
  const b = new Uint8Array(96);
  // 00 00 00 18 'f' 't' 'y' 'p' 'm' 'p' '4' '2'
  const head = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32];
  for (let i = 0; i < head.length; i++) b[i] = head[i];
  for (let i = head.length; i < b.length; i++) b[i] = (i * 3 + tagByte) & 0xff;
  return b;
};

const toDataUrl = (mime, bytes) => {
  const b64 = Buffer.from(bytes).toString("base64");
  return `data:${mime};base64,${b64}`;
};

const JPEG_DATA_LATE = toDataUrl("image/jpeg", makeJpegBytes(10));
const JPEG_DATA_FILTERED_OK = toDataUrl("image/jpeg", makeJpegBytes(20));
const JPEG_DATA_COLLIDE_1 = toDataUrl("image/jpeg", makeJpegBytes(30));
const JPEG_DATA_COLLIDE_2 = toDataUrl("image/jpeg", makeJpegBytes(40));
const MP4_BYTES = makeMp4Bytes(50);
const REMINT_MP4_BYTES = makeMp4Bytes(60);

const blobStore = new Map([
  ["blob:https://www.messenger.com/video-ok", { bytes: MP4_BYTES, type: "" }],
  ["blob:https://www.messenger.com/video-throw", { error: "MediaSource blob is not readable" }],
  ["blob:https://www.messenger.com/link-thumb", { bytes: makeJpegBytes(70), type: "image/jpeg" }],
  ["blob:https://www.messenger.com/remint-1", { bytes: REMINT_MP4_BYTES, type: "video/mp4" }],
  ["blob:https://www.messenger.com/remint-2", { bytes: REMINT_MP4_BYTES, type: "video/mp4" }],
  ["blob:https://www.messenger.com/remint-3", { bytes: REMINT_MP4_BYTES, type: "video/mp4" }],
  ["blob:https://www.messenger.com/photo-remount-1", { bytes: makeJpegBytes(80), type: "image/jpeg" }],
  ["blob:https://www.messenger.com/photo-remount-2", { bytes: makeJpegBytes(85), type: "image/jpeg" }],
]);

const msPair = (ms) => [Math.floor(ms / 2 ** 32), ms | 0];
const baseMs = Date.UTC(2026, 10, 15, 10, 0, 0);

// Builds a React fiber chain where depth 24 has the matching message, depth 40 has outgoing,
// depth 56 has value.contact.name, and depths 10 and 30 hold decoy messages with other ids.
function buildFiberChain(message, outgoing, contactName) {
  const nodes = [];
  for (let d = 0; d <= 64; d++) {
    let memoizedProps = {};
    if (d === 10) {
      memoizedProps = {
        message: {
          messageId: "decoy-below-id",
          timestampMs: msPair(baseMs - 999000),
          senderId: [0, 999],
          text: "decoy below text",
          displayedContentTypes: [0, 1],
        },
        outgoing: !outgoing,
        value: { contact: { name: "Decoy Below" } },
      };
    } else if (d === 24) {
      memoizedProps = { message };
    } else if (d === 30) {
      memoizedProps = {
        message: {
          messageId: "decoy-above-id",
          timestampMs: msPair(baseMs - 888000),
          senderId: [0, 998],
          text: "decoy above text",
          displayedContentTypes: [0, 1],
        },
      };
    } else if (d === 40) {
      if (typeof outgoing === "boolean") memoizedProps = { outgoing };
    } else if (d === 56) {
      if (contactName) memoizedProps = { value: { contact: { name: contactName } } };
    }
    nodes.push({ memoizedProps, return: null });
  }
  for (let d = 0; d < nodes.length - 1; d++) {
    nodes[d].return = nodes[d + 1];
  }
  return nodes[0];
}

const nonPanelClicks = [];
// message id -> how many times a harvest read the row's React fiber
const fiberReads = {};
const makeEl = (tag, props = {}) => {
  const node = {
    tag: String(tag).toLowerCase(),
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    parentElement: null,
    textContent: "",
    ...props,
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
        this.parentElement = null;
      }
    },
    getAttribute(attr) {
      if (attr === "data-message-id") return this.dataset.messageId || null;
      if (attr === "data-scope") return this.dataset.scope || null;
      if (attr === "href") return this.href || null;
      if (attr === "role") return this.role || null;
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n.children || []) {
          if (matchesSelector(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    click() {
      if (!this._isPanelButton && this.tag !== "a") nonPanelClicks.push(this.id || this.tag);
      if (typeof this.onclick === "function") return this.onclick();
    },
  };
  return node;
};

function matchesSelector(el, sel) {
  if (sel === "*") return true;
  if (sel === '[role="main"]') return el.role === "main";
  if (sel === 'div[data-message-id][data-scope="messages_table"]') {
    return el.tag === "div" && Boolean(el.dataset && el.dataset.messageId) && el.dataset.scope === "messages_table";
  }
  if (sel === "div[data-message-id]") {
    return el.tag === "div" && Boolean(el.dataset && el.dataset.messageId);
  }
  if (sel === "img") return el.tag === "img";
  if (sel === "video") return el.tag === "video";
  if (sel === 'a[href^="http"], a' || sel === 'a[href^="http"]' || sel === "a") {
    return el.tag === "a" && (sel === "a" || sel.includes(", a") || String(el.href || "").startsWith("http"));
  }
  return false;
}

const TOTAL_ROWS = scenario === "short" ? 5 : scenario === "pin" ? 0 : 60;
const rowSpecs = [];

for (let i = 0; i < TOTAL_ROWS; i++) {
  const isAda = i % 2 === 0;
  let senderIdNum = isAda ? 101 : 102;
  let senderName = isAda ? "Ada Example" : "Bo Example";
  let outgoing = isAda;
  if (scenario === "group" && i % 3 === 2) {
    senderIdNum = 103;
    senderName = "Cy Example";
    outgoing = false;
  }

  let id = `msg-${String(i + 1).padStart(3, "0")}`;
  if (i === 42) id = "MsgCollide";
  if (i === 43) id = "msgcollide";

  const ts = i === 43 ? baseMs + 42 * 60000 : baseMs + i * 60000;
  let bits = 1; // text
  let text = `synthetic message ${i + 1}`;
  let isUnsent = false;
  let editCount = i === 5 ? 1 : 0;
  let replyText = i === 10 ? "earlier synthetic line" : undefined;

  if (i === 25) {
    // Photo late: completes only on its second mount
    bits = 3; // text | media
    text = "late photo row";
  } else if (i === 28 && (scenario === "video" || scenario === "remount-no-double" || scenario === "large" || scenario === "move-fetch" || scenario === "move-fetch-throw")) {
    bits = 3;
    text = "video row";
  } else if (i === 29 && scenario === "broken-img") {
    bits = 3;
    text = "broken image row";
  } else if (i === 30) {
    bits = 1 | 2 | 1024; // text | media | link
    text = "check out https://example.com/shared";
  } else if (i === 32 && scenario === "remint") {
    bits = 3;
    text = "reminted video row";
  } else if (i === 34 && (scenario === "remount-no-double" || scenario === "move-fetch-photo" || scenario === "move-fetch-photo-throw")) {
    bits = 3;
    text = "remounted photo row";
  } else if (i === 35) {
    isUnsent = true;
    text = "";
    bits = 0;
  } else if (i === 40) {
    bits = 3;
    text = "media row with small icons and one real photo";
  } else if (i >= 44 && i <= 48 && scenario === "settled") {
    bits = 3;
    text = `https media row ${i}`;
  } else if (i === 42 || i === 43) {
    bits = 3;
    text = `collision photo ${i}`;
  }

  rowSpecs.push({
    index: i,
    id,
    ts,
    senderIdNum,
    senderName,
    outgoing,
    bits,
    text,
    isUnsent,
    editCount,
    replyText,
    mountCount: 0,
    currentlyMounted: false,
    visits: 0,
  });
}

function buildRowDom(spec) {
  spec.visits++;
  const isLateFieldRow = spec.index === 20;
  // On Mount 1, row 20 is missing contact.name, outgoing, and replyMessageText; on Mount 2 they are present.
  // Also in remint scenario (row 32) and remount-no-double scenario (rows 28 and 34), contact.name is missing on Mount 1 so the row is re-harvested on Mount 2.
  const omitMetaOnFirstMount = (
    isLateFieldRow
    || (scenario === "remint" && spec.index === 32)
    || (scenario === "remount-no-double" && (spec.index === 28 || spec.index === 34))
  ) && spec.mountCount === 1;
  // Row 15 never carries contact.name on its own fiber chain, testing resolution from `senders` map at Save time.
  const neverHasOwnContact = spec.index === 15;

  const message = {
    messageId: spec.id,
    timestampMs: msPair(spec.ts),
    senderId: [0, spec.senderIdNum],
    text: spec.text || undefined,
    isUnsent: spec.isUnsent,
    editCount: spec.editCount,
    replyMessageText: isLateFieldRow ? (spec.mountCount >= 2 ? "reply filled on second mount" : undefined) : spec.replyText,
    displayedContentTypes: [0, spec.bits],
  };

  const outgoing = omitMetaOnFirstMount ? null : spec.outgoing;
  const contactName = (omitMetaOnFirstMount || neverHasOwnContact) ? null : spec.senderName;

  const row = makeEl("div", {
    dataset: { messageId: spec.id, scope: "messages_table" },
  });
  if (scenario === "throw-row" && spec.index === 17) {
    Object.defineProperty(row, "__reactFiber$throw", {
      enumerable: true,
      get() {
        throw new Error("corrupt fiber");
      },
    });
  } else {
    // a getter, so each read of the row's fiber (one per harvest read of the row) is counted
    const chain = buildFiberChain(message, outgoing, contactName);
    Object.defineProperty(row, `__reactFiber$r${spec.index}`, {
      enumerable: true,
      get() {
        fiberReads[spec.id] = (fiberReads[spec.id] || 0) + 1;
        return chain;
      },
    });
  }

  if (spec.index === 25) {
    // Late photo: incomplete on Mount 1 (with 200x200 bounding rect), complete on Mount 2+
    const complete = spec.mountCount >= 2;
    row.appendChild(makeEl("img", {
      src: JPEG_DATA_LATE,
      complete,
      naturalWidth: complete ? 240 : 0,
      naturalHeight: complete ? 180 : 0,
      getBoundingClientRect: () => ({ width: 240, height: 180 }),
    }));
  } else if (spec.index === 28 && scenario === "video") {
    // First video uses currentSrc (with empty src) to exercise video.currentSrc
    row.appendChild(makeEl("video", {
      src: "",
      currentSrc: "blob:https://www.messenger.com/video-ok",
      videoWidth: 640,
      videoHeight: 360,
      duration: 13.5,
    }));
    row.appendChild(makeEl("video", {
      src: "blob:https://www.messenger.com/video-throw",
      videoWidth: 640,
      videoHeight: 360,
      duration: 8.0,
    }));
  } else if (spec.index === 28 && scenario === "remount-no-double") {
    // Mount 1: valid video source; Mount 2+: no video source on remount
    const hasSrc = spec.mountCount === 1;
    row.appendChild(makeEl("video", {
      src: "",
      currentSrc: hasSrc ? "blob:https://www.messenger.com/video-ok" : "",
      videoWidth: 640,
      videoHeight: 360,
      duration: 13.5,
    }));
  } else if (spec.index === 29 && scenario === "broken-img") {
    // Broken img: complete === true, naturalWidth === 0 -> treated as never loaded and reported
    row.appendChild(makeEl("img", {
      src: "blob:https://www.messenger.com/broken-img",
      complete: true,
      naturalWidth: 0,
      naturalHeight: 0,
      getBoundingClientRect: () => ({ width: 200, height: 150 }),
    }));
  } else if (spec.index === 30) {
    // Link row (bits 1|2|1024) with thumbnail img (>=150) inside <a href="https://...">
    const linkA = makeEl("a", { href: "https://example.com/shared-card" });
    linkA.appendChild(makeEl("img", {
      src: "blob:https://www.messenger.com/link-thumb",
      complete: true,
      naturalWidth: 300,
      naturalHeight: 200,
      getBoundingClientRect: () => ({ width: 300, height: 200 }),
    }));
    row.appendChild(linkA);
    row.appendChild(makeEl("a", { href: "https://example.com/second-link" }));
  } else if (spec.index === 32 && scenario === "remint") {
    const urlIdx = Math.min(spec.mountCount, 3);
    row.appendChild(makeEl("video", {
      src: `blob:https://www.messenger.com/remint-${urlIdx}`,
      videoWidth: 320,
      videoHeight: 240,
      duration: 5.0,
    }));
  } else if (spec.index === 34 && (scenario === "remount-no-double" || scenario === "move-fetch-photo" || scenario === "move-fetch-photo-throw")) {
    // Mount 1: complete blob: photo; Mount 2+: new blob: URL and incomplete
    const firstMount = spec.mountCount === 1;
    row.appendChild(makeEl("img", {
      src: firstMount
        ? "blob:https://www.messenger.com/photo-remount-1"
        : "blob:https://www.messenger.com/photo-remount-2",
      complete: firstMount,
      naturalWidth: firstMount ? 200 : 0,
      naturalHeight: firstMount ? 200 : 0,
      getBoundingClientRect: () => ({ width: 200, height: 200 }),
    }));
  } else if (spec.index === 40) {
    // Filtered imgs: 16x16 receipt, 100x100 https avatar, 24x24 emoji (complete and incomplete), plus one valid 180x180 photo
    row.appendChild(makeEl("img", {
      src: "blob:https://www.messenger.com/receipt",
      complete: true,
      naturalWidth: 16,
      naturalHeight: 16,
      getBoundingClientRect: () => ({ width: 16, height: 16 }),
    }));
    row.appendChild(makeEl("img", {
      src: "https://scontent.xx.fbcdn.net/v/avatar_100x100.jpg",
      complete: true,
      naturalWidth: 100,
      naturalHeight: 100,
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
    }));
    row.appendChild(makeEl("img", {
      src: "https://static.xx.fbcdn.net/images/emoji.png",
      alt: "❤️",
      complete: true,
      naturalWidth: 24,
      naturalHeight: 24,
      getBoundingClientRect: () => ({ width: 24, height: 24 }),
    }));
    row.appendChild(makeEl("img", {
      src: "",
      alt: "👍",
      complete: false,
      naturalWidth: 0,
      naturalHeight: 0,
      getBoundingClientRect: () => ({ width: 24, height: 24 }),
    }));
    row.appendChild(makeEl("img", {
      src: JPEG_DATA_FILTERED_OK,
      complete: true,
      naturalWidth: 180,
      naturalHeight: 180,
      getBoundingClientRect: () => ({ width: 180, height: 180 }),
    }));
  } else if (spec.index === 44 && scenario === "settled") {
    // a 100x100 https avatar (filtered) and a large https preview: nothing here is ever capturable
    row.appendChild(makeEl("img", {
      src: "https://scontent.xx.fbcdn.net/v/avatar_100x100.jpg",
      complete: true,
      naturalWidth: 100,
      naturalHeight: 100,
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
    }));
    row.appendChild(makeEl("img", {
      src: "https://scontent.xx.fbcdn.net/v/preview_1032.jpg",
      complete: true,
      naturalWidth: 1032,
      naturalHeight: 540,
      getBoundingClientRect: () => ({ width: 1032, height: 540 }),
    }));
  } else if (spec.index === 45 && scenario === "settled") {
    row.appendChild(makeEl("video", {
      src: "https://video.xx.fbcdn.net/v/clip.mp4",
      videoWidth: 640,
      videoHeight: 360,
      duration: 4.0,
    }));
  } else if (spec.index === 46 && scenario === "settled") {
    // an https preview plus a tiny still-loading emoji: the emoji is filtered, so the row settles
    row.appendChild(makeEl("img", {
      src: "https://scontent.xx.fbcdn.net/v/preview_800.jpg",
      complete: true,
      naturalWidth: 800,
      naturalHeight: 600,
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
    }));
    row.appendChild(makeEl("img", {
      src: "",
      alt: "👍",
      complete: false,
      naturalWidth: 0,
      naturalHeight: 0,
      getBoundingClientRect: () => ({ width: 24, height: 24 }),
    }));
  } else if (spec.index === 47 && scenario === "settled") {
    // a blob: video whose first read fails and a later one works
    row.appendChild(makeEl("video", {
      src: "blob:https://www.messenger.com/video-flaky",
      videoWidth: 320,
      videoHeight: 240,
      duration: 3.0,
    }));
  } else if (spec.index === 48 && scenario === "settled") {
    // one captured photo and a second qualifying img still loading on the first mounts
    row.appendChild(makeEl("img", {
      src: toDataUrl("image/jpeg", makeJpegBytes(90)),
      complete: true,
      naturalWidth: 200,
      naturalHeight: 200,
      getBoundingClientRect: () => ({ width: 200, height: 200 }),
    }));
    const lateOk = spec.mountCount >= 2;
    row.appendChild(makeEl("img", {
      src: toDataUrl("image/jpeg", makeJpegBytes(91)),
      complete: lateOk,
      naturalWidth: lateOk ? 200 : 0,
      naturalHeight: lateOk ? 200 : 0,
      getBoundingClientRect: () => ({ width: 200, height: 200 }),
    }));
  } else if (spec.index === 28 && (scenario === "large" || scenario === "move-fetch" || scenario === "move-fetch-throw")) {
    // one video whose Blob reports more than 1 GiB
    row.appendChild(makeEl("video", {
      src: "",
      currentSrc: scenario === "large" ? "blob:https://www.messenger.com/video-huge" : "blob:https://www.messenger.com/video-ok",
      videoWidth: 640,
      videoHeight: 360,
      duration: 90.0,
    }));
  } else if (spec.index === 42) {
    row.appendChild(makeEl("img", {
      src: JPEG_DATA_COLLIDE_1,
      complete: true,
      naturalWidth: 160,
      naturalHeight: 160,
      getBoundingClientRect: () => ({ width: 160, height: 160 }),
    }));
  } else if (spec.index === 43) {
    row.appendChild(makeEl("img", {
      src: JPEG_DATA_COLLIDE_2,
      complete: true,
      naturalWidth: 160,
      naturalHeight: 160,
      getBoundingClientRect: () => ({ width: 160, height: 160 }),
    }));
  }

  return row;
}

const mainEl = makeEl("div", { role: "main" });
const isShort = scenario === "short";
const scrollerEl = makeEl("div", {
  clientHeight: 500,
  scrollHeight: isShort ? 250 : 3000,
});

let currentScrollTop = isShort ? 0 : scenario === "fractional" ? 2499.6 : 2500;
let reachedTopOnce = false;
let scrollWrites = 0;
const scrollHistory = [];
const mountedDomByIndex = new Map();
let asyncMountTimer = null;

// The tab has moved to another conversation (an SPA navigation): the same scroller now holds that thread's rows.
let onForeign = false;
const FOREIGN_IDS = ["foreign-1", "foreign-2", "foreign-3"];
const buildForeignRow = (id, n) => {
  const row = makeEl("div", { dataset: { messageId: id, scope: "messages_table" } });
  const message = {
    messageId: id,
    timestampMs: msPair(baseMs + (100 + n) * 60000),
    senderId: [0, 201],
    text: `foreign thread message ${n}`,
    isUnsent: false,
    editCount: 0,
    displayedContentTypes: [0, 1],
  };
  row[`__reactFiber$f${n}`] = buildFiberChain(message, false, "Dee Example");
  return row;
};

// scroll writes made once the tab is on the foreign path: a collector that has moved must make none
let scrollsAtMove = null;
let released = scenario !== "move-wait" && scenario !== "move-wait-empty";
let moveAtVnow = null;
const doMove = () => {
  sandbox.location.pathname = "/e2ee/t/555000111";
  sandbox.location.href = `${origin}/e2ee/t/555000111`;
  document.title = "(1) Dee Example | Messenger";
  scrollsAtMove = scrollHistory.length;
  moveAtVnow = vnow;
  onForeign = true;
  syncMountedRows();
};
const comeBack = () => {
  sandbox.location.pathname = `/e2ee/t/${THREAD_ID}`;
  sandbox.location.href = href;
  onForeign = false;
  released = true;
  syncMountedRows();
};

function syncMountedRows() {
  scrollerEl.children = [];
  if (scenario === "pin" || ((scenario === "move-wait" || scenario === "move-wait-empty") && !released && !onForeign)) return;
  if (onForeign && scenario === "move-wait-empty") return;
  if (onForeign) {
    FOREIGN_IDS.forEach((id, n) => scrollerEl.appendChild(buildForeignRow(id, n + 1)));
    return;
  }

  const firstIdx = isShort ? 0 : Math.max(0, Math.min(TOTAL_ROWS - 20, Math.floor(currentScrollTop / 50)));
  const lastIdx = isShort ? TOTAL_ROWS : Math.min(TOTAL_ROWS, firstIdx + 20);

  for (let i = 0; i < TOTAL_ROWS; i++) {
    const inWindow = i >= firstIdx && i < lastIdx;
    const spec = rowSpecs[i];
    if (inWindow && !spec.currentlyMounted) {
      spec.currentlyMounted = true;
      spec.mountCount++;
      mountedDomByIndex.set(i, buildRowDom(spec));
    } else if (!inWindow && spec.currentlyMounted) {
      spec.currentlyMounted = false;
      mountedDomByIndex.delete(i);
    }
  }

  // Mount the 60x60 thread header img before the first row only when top rows are mounted (unless stalled)
  if (firstIdx === 0 && scenario !== "stalled") {
    const headerImg = makeEl("img", {
      width: 60,
      height: 60,
      naturalWidth: 60,
      naturalHeight: 60,
      complete: true,
      getBoundingClientRect: () => ({ width: 60, height: 60 }),
    });
    scrollerEl.appendChild(headerImg);
  }

  for (let i = firstIdx; i < lastIdx; i++) {
    const rowDom = mountedDomByIndex.get(i);
    if (rowDom) scrollerEl.appendChild(rowDom);
  }
}

Object.defineProperty(scrollerEl, "scrollTop", {
  get() {
    return currentScrollTop;
  },
  set(v) {
    scrollWrites++;
    if (scenario === "sweep-throw" && scrollWrites >= 4) {
      throw new Error("scroller detached");
    }
    const raw = Number(v) || 0;
    const minScroll = scenario === "fractional" ? 0.4 : scenario === "scroll-stuck-up" && scrollWrites > 1 ? 1000 : 0;
    const maxScroll = scenario === "fractional"
      ? scrollerEl.scrollHeight - scrollerEl.clientHeight - 0.4
      : scenario === "scroll-stuck-down" && reachedTopOnce
        ? 1800
        : Math.max(0, scrollerEl.scrollHeight - scrollerEl.clientHeight);
    currentScrollTop = Math.max(minScroll, Math.min(maxScroll, raw));
    if (currentScrollTop <= 2) reachedTopOnce = true;
    scrollHistory.push(currentScrollTop);
    if (scenario === "async-mount") {
      scrollerEl.children = [];
      if (asyncMountTimer) virtualClearTimeout(asyncMountTimer);
      asyncMountTimer = virtualSetTimeout(() => {
        asyncMountTimer = null;
        syncMountedRows();
      }, 50);
    } else {
      syncMountedRows();
    }
  },
});

syncMountedRows();
mainEl.appendChild(scrollerEl);

// Decoy interactive element on the page to assert the collector never clicks outside its panel
const decoyPageButton = makeEl("button", { id: "page-pin-submit", textContent: "Submit PIN" });
mainEl.appendChild(decoyPageButton);

const bodyEl = makeEl("body");
bodyEl.appendChild(mainEl);

const createdElements = [];
let downloadedFile = null;
let downloadedJson = null;
const revokedUrls = [];

const hasBridgeMark = scenario !== "handoff-no-bridge";
const ACK_MODES = {
  "handoff-too-soon": "too-soon",
  "handoff-not-a-thread": "not-a-thread",
  "handoff-pending-late": "pending-late",
  "handoff-pending-never": "pending-never",
  "handoff-no-ack": "none",
  "move-save-noack": "none",
  "save-close": "none",
  "save-close-ack": "none",
  "handoff-nack": "nack",
};
const bridgeAckMode = ACK_MODES[scenario] || "ok";

const document = {
  title: customTitle !== undefined ? customTitle : "(2) Ada Example | Messenger",
  body: bodyEl,
  documentElement: {
    dataset: hasBridgeMark ? { leketMessengerBridge: "1" } : {},
  },
  getElementById(id) {
    const all = bodyEl.querySelectorAll("*");
    return all.find((el) => el.id === id) || null;
  },
  querySelectorAll(sel) {
    return bodyEl.querySelectorAll(sel);
  },
  querySelector(sel) {
    return bodyEl.querySelector(sel);
  },
  createElement(tag) {
    const el = makeEl(tag);
    if (String(tag).toLowerCase() === "button") {
      el._isPanelButton = true;
    }
    if (String(tag).toLowerCase() === "a") {
      el.click = function () {
        downloadedFile = this.download;
        downloadedJson = this.href && this.href._blobText ? this.href._blobText : null;
      };
    }
    createdElements.push(el);
    return el;
  },
};

let vnow = Date.UTC(2026, 10, 15, 12, 0, 0);
const startVnow = vnow;
const timers = new Map();
let nextTimerId = 1;
let pumpScheduled = false;

const pumpTimers = () => {
  pumpScheduled = false;
  if (timers.size === 0) return;
  let earliest = null;
  for (const item of timers.values()) {
    if (!earliest || item.dueAt < earliest.dueAt || (item.dueAt === earliest.dueAt && item.id < earliest.id)) {
      earliest = item;
    }
  }
  if (!earliest) return;
  timers.delete(earliest.id);
  if (earliest.dueAt > vnow) vnow = earliest.dueAt;
  earliest.fn(...earliest.args);
  if (timers.size > 0 && !pumpScheduled) {
    pumpScheduled = true;
    setImmediate(pumpTimers);
  }
};

const virtualSetTimeout = (fn, ms = 0, ...args) => {
  const id = nextTimerId++;
  const delay = Math.max(0, Number(ms) || 0);
  timers.set(id, { id, dueAt: vnow + delay, fn, args });
  if (!pumpScheduled) {
    pumpScheduled = true;
    setImmediate(pumpTimers);
  }
  return id;
};

const virtualClearTimeout = (id) => {
  timers.delete(id);
};

class VirtualDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(vnow);
    else super(...args);
  }
  static now() {
    return vnow;
  }
}

let flakyReads = 0;
const fetchCalls = [];
let fullBlobArrayBufferCalls = 0;
const blobSlices = [];
const fetchedBlobs = new Set();

const fakeFetch = async (url) => {
  const s = String(url);
  fetchCalls.push(s);
  if (!s.startsWith("blob:")) throw new Error(`unexpected non-blob fetch: ${s}`);
  if (s === "blob:https://www.messenger.com/video-flaky") {
    flakyReads++;
    if (flakyReads === 1) throw new Error("transient read failure");
    return { ok: true, status: 200, blob: async () => new Blob([makeMp4Bytes(95)], { type: "video/mp4" }) };
  }
  if ((scenario === "move-fetch" || scenario === "move-fetch-throw") && s === "blob:https://www.messenger.com/video-ok") {
    // the tab navigates away while this read is in flight
    doMove();
    if (scenario === "move-fetch-throw") throw new Error("read failed after the move");
  }
  if (scenario.startsWith("move-fetch-photo") && s === "blob:https://www.messenger.com/photo-remount-1") {
    doMove();
    if (scenario === "move-fetch-photo-throw") throw new Error("read failed after the move");
  }
  if (s === "blob:https://www.messenger.com/video-huge") {
    // a Blob stand-in that reports 1.2 GiB but holds only the bytes the collector slices
    const real = new Blob([MP4_BYTES], { type: "video/mp4" });
    const huge = {
      size: Math.round(1.2 * 1024 * 1024 * 1024),
      type: "video/mp4",
      slice: (start, end) => real.slice(start === undefined ? 0 : Math.min(start, 32), end === undefined || end === null ? undefined : end),
      arrayBuffer: async () => { throw new Error("full blob.arrayBuffer() must not be called"); },
    };
    return { ok: true, status: 200, blob: async () => huge };
  }
  const entry = blobStore.get(s);
  if (!entry) throw new Error(`unknown blob URL: ${s}`);
  if (entry.error) throw new Error(entry.error);
  const blob = new Blob([entry.bytes], { type: entry.type || "" });
  const origSlice = blob.slice.bind(blob);
  blob.arrayBuffer = async () => {
    fullBlobArrayBufferCalls++;
    throw new Error("full blob.arrayBuffer() must not be called");
  };
  blob.slice = (start, end, contentType) => {
    blobSlices.push([start, end === undefined ? null : end]);
    return origSlice(start, end, contentType);
  };
  fetchedBlobs.add(blob);
  return {
    ok: true,
    status: 200,
    blob: async () => blob,
  };
};

let posted = null;
let postCount = 0;
const messageListeners = [];

const sandbox = {
  location: {
    hostname: "www.messenger.com",
    pathname,
    origin,
    href,
  },
  document,
  console,
  Blob,
  Uint8Array,
  ArrayBuffer,
  BigInt,
  Date: VirtualDate,
  Intl,
  JSON,
  Map,
  Set,
  Object,
  Array,
  Number,
  String,
  Boolean,
  RegExp,
  Promise,
  Error,
  Math,
  atob: (b64) => Buffer.from(b64, "base64").toString("binary"),
  btoa: (bin) => Buffer.from(bin, "binary").toString("base64"),
  fetch: fakeFetch,
  URL: {
    createObjectURL(blob) {
      return { _blob: blob, _blobText: blob ? null : null };
    },
    revokeObjectURL(u) {
      revokedUrls.push(Boolean(u));
    },
  },
  getComputedStyle(el) {
    if (el === scrollerEl && !isShort) return { overflowY: "auto" };
    return { overflowY: "visible" };
  },
  setTimeout: virtualSetTimeout,
  clearTimeout: virtualClearTimeout,
  addEventListener(type, fn) {
    if (type === "message") messageListeners.push(fn);
  },
  removeEventListener(type, fn) {
    if (type === "message") {
      const i = messageListeners.indexOf(fn);
      if (i >= 0) messageListeners.splice(i, 1);
    }
  },
  postMessage(data, targetOrigin) {
    if (data && data.type === "leket:messenger-export") {
      postCount++;
      posted = { data, origin: targetOrigin };
      if (scenario === "save-close-ack") {
        const closeBtn = findButton("Close");
        if (closeBtn) closeBtn.click();
      }
      if (bridgeAckMode !== "none") {
        const winProxy = vm.runInContext("window", sandbox);
        const send = (payload, ms) => virtualSetTimeout(() => {
          for (const fn of [...messageListeners]) {
            fn({ source: winProxy, origin, data: payload });
          }
        }, ms);
        const finalAck = bridgeAckMode === "too-soon"
          ? { type: "leket:ack", id: data.id, ok: false, reason: "too-soon" }
          : bridgeAckMode === "not-a-thread"
            ? { type: "leket:ack", id: data.id, ok: false, reason: "not-a-thread" }
            : bridgeAckMode === "nack"
              ? { type: "leket:ack", id: data.id, ok: false }
              : { type: "leket:ack", id: data.id, ok: true };
        if (bridgeAckMode === "pending-late" || bridgeAckMode === "pending-never") {
          // the bridge accepted the post at once; the worker takes 30 virtual seconds to open the export tab (or never answers)
          send({ type: "leket:ack", id: data.id, pending: true }, 5);
          if (bridgeAckMode === "pending-late") send(finalAck, 30000);
          // a repeated pending ack must not restart the wait
          if (bridgeAckMode === "pending-never") send({ type: "leket:ack", id: data.id, pending: true }, 60000);
        } else {
          send(finalAck, 5);
        }
      }
    }
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const readSrc = fs.readFileSync(path.join(__dirname, "../../src/modules/messenger/read.js"), "utf8");
const collectorSrc = fs.readFileSync(path.join(__dirname, "../../src/modules/messenger/collector.js"), "utf8");

vm.runInNewContext(readSrc, sandbox);
vm.runInNewContext(collectorSrc, sandbox);
if (scenario === "second-launch") {
  vm.runInNewContext(collectorSrc, sandbox);
}

const panel = document.getElementById("leket-messenger-panel");
const panelCount = bodyEl.querySelectorAll("*").filter((el) => el.id === "leket-messenger-panel").length;
const getButtons = () => (panel ? panel.children.filter((c) => c.tag === "button") : []);
const findButton = (label) => getButtons().find((b) => b.textContent === label) || null;
const getPanelDivs = () => (panel ? panel.children.filter((c) => c.tag === "div") : []);

const getStatusText = () => {
  const divs = getPanelDivs();
  return divs.length ? divs[divs.length - 1].textContent : "";
};

const getCountsText = () => {
  const divs = getPanelDivs();
  return divs.length >= 2 ? divs[1].textContent : "";
};

const waitUntil = (pred, maxTicks = 5000) => new Promise((resolve, reject) => {
  let ticks = 0;
  const check = () => {
    if (pred()) return resolve();
    if (++ticks > maxTicks) return reject(new Error(`waitUntil timed out; status="${getStatusText()}"`));
    setImmediate(check);
  };
  check();
});

const isSweepTerminal = (s) =>
  s.startsWith("Done:")
  || s.startsWith("STALLED,")
  || s.startsWith("No messages are showing.")
  || s.startsWith("ERROR:");

(async () => {
  if (scenario === "off-thread") {
    process.stdout.write(JSON.stringify({
      panelMounted: Boolean(panel),
      status: getStatusText(),
      buttons: getButtons().map((b) => b.textContent),
    }));
    return;
  }

  const startBtn = findButton("Start");
  const stopBtn = findButton("Stop");
  const saveBtn = findButton("Save");
  const closeBtn = findButton("Close");
  startBtn.click();

  let statusAfterStop = null;
  let scrollStepsAfterSave = 0;

  if (scenario === "control-stop-save") {
    await waitUntil(() => getStatusText().startsWith("Going up:") && currentScrollTop < 2000 && currentScrollTop > 0);
    stopBtn.click();
    await waitUntil(() => getStatusText().startsWith("Stopped:"));
    statusAfterStop = getStatusText();
  } else if (scenario === "control-stop-start") {
    await waitUntil(() => getStatusText().startsWith("Going up:") && currentScrollTop < 2000 && currentScrollTop > 0);
    stopBtn.click();
    await waitUntil(() => getStatusText().startsWith("Stopped:"));
    statusAfterStop = getStatusText();
    startBtn.click();
    await waitUntil(() => isSweepTerminal(getStatusText()));
  } else if (scenario === "control-start-while-sweeping") {
    await waitUntil(() => getStatusText().startsWith("Going up:") && currentScrollTop < 2000 && currentScrollTop > 0);
    startBtn.click();
    await waitUntil(() => isSweepTerminal(getStatusText()));
  } else if (scenario === "control-save-mid-sweep") {
    await waitUntil(() => getStatusText().startsWith("Going up:") && currentScrollTop < 2000 && currentScrollTop > 0);
    const statusMidSweep = getStatusText();
    await saveBtn.click();
    const lenAtSave = scrollHistory.length;
    await new Promise((r) => setImmediate(r));
    scrollStepsAfterSave = scrollHistory.length - lenAtSave;
    const exp = posted ? JSON.parse(posted.data.json) : null;
    process.stdout.write(JSON.stringify({
      statusMidSweep,
      statusAfterSave: getStatusText(),
      postCount,
      scrollStepsAfterSave,
      export: exp,
    }));
    return;
  } else if (scenario === "move-thread") {
    const MOVED = "This tab moved to another conversation. Go back to the conversation this panel was opened on, or close this panel.";
    await waitUntil(() => getStatusText().startsWith("Going up:") && currentScrollTop < 2000 && currentScrollTop > 0);
    const countsBeforeMove = getCountsText();
    // an SPA navigation to another thread: the path, the tab title and the mounted rows all change
    sandbox.location.pathname = "/e2ee/t/555000111";
    sandbox.location.href = `${origin}/e2ee/t/555000111`;
    document.title = "(1) Dee Example | Messenger";
    onForeign = true;
    syncMountedRows();
    await waitUntil(() => getStatusText() === MOVED);
    // let the stopped sweep settle, then try to save from the wrong conversation
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    const statusAfterMove = getStatusText();
    const postsBeforeSave = postCount;
    await saveBtn.click();
    const statusAfterSaveMoved = getStatusText();
    const postsAfterSaveMoved = postCount;
    const downloadedWhileMoved = Boolean(downloadedFile);
    // back on the launch path: Save works again and holds only that conversation
    sandbox.location.pathname = `/e2ee/t/${THREAD_ID}/`;
    sandbox.location.href = href;
    onForeign = false;
    syncMountedRows();
    await saveBtn.click();
    const statusAfterReturnSave = getStatusText();
    const savedAfterReturn = posted ? JSON.parse(posted.data.json) : null;
    const fileAfterReturn = posted ? posted.data.file : null;
    // and Start works again
    startBtn.click();
    await waitUntil(() => isSweepTerminal(getStatusText()));
    const statusAfterRestart = getStatusText();
    process.stdout.write(JSON.stringify({
      countsBeforeMove,
      statusAfterMove,
      statusAfterSaveMoved,
      postsBeforeSave,
      postsAfterSaveMoved,
      downloadedWhileMoved,
      statusAfterReturnSave,
      export: savedAfterReturn,
      file: fileAfterReturn,
      postCount,
      statusAfterRestart,
      heading: getPanelDivs()[0].textContent,
    }));
    return;
  } else if (["move-fetch", "move-fetch-throw", "move-fetch-photo", "move-fetch-photo-throw", "move-wait", "move-wait-empty", "move-save-noack", "move-save-midsweep", "move-start", "move-stop"].includes(scenario)) {
    const MOVED = "This tab moved to another conversation. Go back to the conversation this panel was opened on, or close this panel.";
    const settleTicks = async () => { for (let i = 0; i < 80; i++) await new Promise((r) => setImmediate(r)); };
    let scrollsAfterStart = null;
    let skipFinalSave = false;
    let movedLatencyMs = null;
    if (scenario.startsWith("move-fetch")) {
      await waitUntil(() => getStatusText() === MOVED);
    } else if (scenario === "move-wait") {
      virtualSetTimeout(doMove, 3000);
      await waitUntil(() => getStatusText() === MOVED);
    } else if (scenario === "move-wait-empty") {
      // the tab moves to a page with no rows at all, 3 virtual s into the wait for rows
      virtualSetTimeout(doMove, 3000);
      await waitUntil(() => getStatusText() === MOVED || isSweepTerminal(getStatusText()));
      movedLatencyMs = vnow - moveAtVnow;
    } else if (scenario === "move-save-noack") {
      await waitUntil(() => isSweepTerminal(getStatusText()));
      const sp = saveBtn.click();
      await waitUntil(() => postCount >= 1);
      doMove();
      await sp;
      skipFinalSave = true;
    } else if (scenario === "move-save-midsweep") {
      await waitUntil(() => getStatusText().startsWith("Going up:") && currentScrollTop < 2000 && currentScrollTop > 0);
      const sp = saveBtn.click();
      doMove();
      await sp;
      skipFinalSave = true;
    } else if (scenario === "move-stop") {
      await waitUntil(() => getStatusText().startsWith("Going up:") && currentScrollTop < 2000 && currentScrollTop > 0);
      // Stop, and the tab moves before the stopped sweep gets to report
      stopBtn.click();
      doMove();
      await settleTicks();
    } else if (scenario === "move-start") {
      await waitUntil(() => getStatusText().startsWith("Going up:") && currentScrollTop < 2000 && currentScrollTop > 0);
      doMove();
      await waitUntil(() => getStatusText() === MOVED);
      await settleTicks();
      const before = scrollHistory.length;
      startBtn.click();
      await settleTicks();
      scrollsAfterStart = scrollHistory.length - before;
    }
    await settleTicks();
    const statusWhileMoved = getStatusText();
    const scrollsAfterMove = scrollHistory.length - (scrollsAtMove === null ? scrollHistory.length : scrollsAtMove);
    const postsWhileMoved = postCount;
    const downloadedWhileMoved = Boolean(downloadedFile);
    comeBack();
    let statusAfterReturnSave = null;
    if (!skipFinalSave) {
      await saveBtn.click();
      statusAfterReturnSave = getStatusText();
    }
    process.stdout.write(JSON.stringify({
      statusWhileMoved,
      scrollsAfterMove,
      scrollsAfterStart,
      movedLatencyMs,
      postsWhileMoved,
      downloadedWhileMoved,
      statusAfterReturnSave,
      postCount,
      export: posted ? JSON.parse(posted.data.json) : null,
    }));
    return;
  } else if (scenario === "save-close") {
    await waitUntil(() => getStatusText().startsWith("Going up:") && currentScrollTop < 2000 && currentScrollTop > 0);
    const savePromise = saveBtn.click();
    closeBtn.click();
    await savePromise;
    await new Promise((r) => setImmediate(r));
    process.stdout.write(JSON.stringify({
      posted: posted ? { type: posted.data.type } : null,
      downloaded: Boolean(downloadedFile),
      panelMountedAfterClose: Boolean(document.getElementById("leket-messenger-panel")),
    }));
    return;
  } else {
    // Wait for sweep to finish, or cap at 60 virtual seconds so a termination bug fails the test's virtual-time bound assertion cleanly
    await waitUntil(() => isSweepTerminal(getStatusText()) || vnow - startVnow >= 60000);
  }

  const statusAfterSweep = getStatusText();
  const countsAfterSweep = getCountsText();
  const elapsedMs = vnow - startVnow;
  if (!isSweepTerminal(statusAfterSweep) && !statusAfterSweep.startsWith("Stopped:")) {
    stopBtn.click();
    await waitUntil(() => isSweepTerminal(getStatusText()) || getStatusText().startsWith("Stopped:"));
  }

  if (scenario === "pin") {
    await saveBtn.click();
    process.stdout.write(JSON.stringify({
      statusAfterSweep,
      statusAfterSave: getStatusText(),
      elapsedMs,
      nonPanelClicks,
      posted: Boolean(posted),
      downloaded: Boolean(downloadedFile),
    }));
    return;
  }

  const saveStartedAt = vnow;
  await saveBtn.click();
  const saveElapsedMs = vnow - saveStartedAt;
  const collectorBlobSlices = [...blobSlices];

  let fallbackExport = null;
  if (downloadedFile) {
    const linkEl = createdElements.find((e) => e.tag === "a" && e.download === downloadedFile);
    if (linkEl && linkEl.href && linkEl.href._blob) {
      const text = await linkEl.href._blob.text();
      fallbackExport = JSON.parse(text);
    }
  }

  let postedOut = null;
  if (posted) {
    const filesMeta = [];
    for (const f of posted.data.files || []) {
      const buf = await f.blob.slice(0, 12).arrayBuffer();
      const bytes = new Uint8Array(buf);
      filesMeta.push({
        name: f.name,
        size: f.blob.size,
        type: f.blob.type,
        isBlob: f.blob instanceof Blob,
        sameBlobInstance: fetchedBlobs.has(f.blob),
        head: [...bytes.subarray(0, 12)],
      });
    }
    postedOut = {
      type: posted.data.type,
      file: posted.data.file,
      origin: posted.origin,
      files: filesMeta,
    };
  }

  // let timers still pending after Save (the fallback's delayed object-URL revoke) run
  for (let i = 0; i < 100 && timers.size > 0; i++) await new Promise((r) => setImmediate(r));

  const exp = fallbackExport || (posted ? JSON.parse(posted.data.json) : null);
  const file = downloadedFile || (posted ? posted.data.file : null);

  process.stdout.write(JSON.stringify({
    file,
    export: exp,
    posted: postedOut,
    postCount,
    downloaded: Boolean(downloadedFile),
    revokedUrlsCount: revokedUrls.length,
    statusAfterSweep,
    statusAfterStop,
    statusAfterSave: getStatusText(),
    countsAfterSweep,
    elapsedMs,
    scrollHistory,
    panelCount,
    fetchCalls,
    fullBlobArrayBufferCalls,
    blobSlices: collectorBlobSlices,
    nonPanelClicks,
    saveElapsedMs,
    fiberReads,
    rowVisits: Object.fromEntries(rowSpecs.map((r) => [r.id, r.visits])),
  }));
})();
