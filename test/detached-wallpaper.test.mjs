/**
 * The wallpaper the window borrows from DSH.
 *
 * The script is a page asset, not a module: it boots from `document`, `location`
 * and `fetch` the way a static page does. This file runs it against the same
 * miniature DOM the window's other tests use, with the two HTTP answers the
 * plugin actually serves, and checks the layer that comes out.
 *
 * The interesting cases are the ones that are easy to get wrong: the media URL
 * only exists after the inventory was asked for (the token lives in the host's
 * memory), a Scene wallpaper has no media to play and falls back to the frame
 * the plugin already rendered, and a DSH without the plugin has to leave no
 * layer at all rather than an empty black one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDom } from "./support/dom.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(HERE, "..", "assets", "detached", "wallpaper.js"), "utf8");

const IMAGE = {
  id: "up-1",
  type: "image",
  media: "/wallpaper-engine/media/tok-image",
  preview: "/wallpaper-engine/preview/tok-image",
  frameUrl: null,
};
const VIDEO = {
  id: "up-2",
  type: "video",
  media: "/wallpaper-engine/media/tok-video",
  preview: "/wallpaper-engine/preview/tok-video",
  frameUrl: null,
};
const SCENE = {
  id: "up-3",
  type: "scene",
  media: null,
  preview: "/wallpaper-engine/preview/tok-scene",
  frameUrl: "/wallpaper-engine/scene-frame/tok-scene",
};

/** This plugin's own document, defaulting to a sharp picture under the usual panel. */
const OWN = {
  wallpaper: { enabled: true, blur: 0, frost: 88, dim: 0, sync: true, custom: "", customName: "" },
};

/** The uploaded file the Host would describe, as `GET /wallpaper` answers it. */
const UPLOAD = { file: "wallpaper.mp4", name: "海边.mp4", bytes: 2048, type: "video/mp4", modified: 1730000000000 };

/**
 * Run the asset once, with the Host answering from these tables.
 *
 * Two sources answer here because the script reads two: this plugin's own
 * settings and uploaded file, and the wallpaper plugin's settings and inventory.
 *
 * @param {{ settings: object | null, wallpapers: object[], search?: string,
 *   later?: (object | null)[], own?: object, file?: object | null }} options
 *   `later` answers the plugin's settings on the polls after the first; `own` is
 *   this plugin's settings document and `file` what `GET /wallpaper` reports.
 */
async function boot({ settings, wallpapers, search = "", later = [], own = OWN, file = null }) {
  const { document } = createDom();
  document.readyState = "complete";
  const asked = [];
  const timers = [];
  const intervals = [];
  let answered = 0;
  const fetch = async (url) => {
    asked.push(String(url));
    // The Host wraps every route in an envelope. Answering without one would
    // let the script read a shape no real Host produces, which is exactly how
    // "美化 off" once failed to take effect.
    if (String(url) === "/session-navigator/api/settings") {
      return { ok: true, json: async () => ({ ok: true, result: { settings: own, revision: 1 } }) };
    }
    if (String(url) === "/session-navigator/api/wallpaper") {
      return { ok: true, json: async () => ({ ok: true, result: { file } }) };
    }
    if (String(url) === "/wallpaper-engine/settings") {
      const next = answered === 0 ? settings : later[answered - 1] ?? settings;
      answered += 1;
      return { ok: true, json: async () => ({ ok: true, settings: next }) };
    }
    if (String(url) === "/wallpaper-engine/inventory") {
      return { ok: true, json: async () => ({ total: wallpapers.length, wallpapers }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const location = { search };
  const setInterval = (fn, ms) => {
    timers.push(fn);
    intervals.push(ms);
    return timers.length;
  };
  new Function("document", "location", "fetch", "setInterval", SCRIPT)(
    document,
    location,
    fetch,
    setInterval,
  );
  // One turn for the promise chain of the first poll.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { document, asked, timers, intervals };
}

/** Run one more poll of the asset and let its promise chain settle. */
async function poll(timers) {
  await timers[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("an image wallpaper becomes a layer under the panel", async () => {
  const { document, asked } = await boot({
    settings: { id: "up-1", objectFit: "cover", backgroundBrightness: 85 },
    wallpapers: [IMAGE],
  });

  // The picture source is decided first; the inventory then mints the media token.
  assert.deepEqual(asked, [
    "/session-navigator/api/settings",
    "/wallpaper-engine/settings",
    "/wallpaper-engine/inventory",
  ]);

  const layer = document.getElementById("se-wallpaper");
  assert.ok(layer, "the layer exists");
  assert.equal(document.body.childNodes[0], layer, "and it is the first thing in the body");
  assert.equal(document.documentElement.getAttribute("data-se-wallpaper"), "image");

  const image = layer.querySelector("img");
  assert.ok(image, "the picture is an <img>");
  assert.equal(image.getAttribute("src"), IMAGE.media);
  assert.equal(image.getAttribute("alt"), "");
  assert.equal(image.className, "se-wallpaper-media");

  // The plugin's look is recomputed, not guessed: brightness comes from settings.
  assert.match(layer.style.filter, /brightness\(85%\)/);
  assert.equal(layer.style.opacity, "1");
  assert.equal(image.style.objectFit, "cover");
});

test("a video wallpaper loops, muted, and sizes itself the same way", async () => {
  const { document } = await boot({
    settings: { id: "up-2", objectFit: "contain", flip: true },
    wallpapers: [VIDEO],
  });

  const layer = document.getElementById("se-wallpaper");
  assert.equal(layer.style.filter, "none", "a default look keeps the layer off the filter path");
  const video = layer.querySelector("video");
  assert.ok(video, "the clip is the source");
  assert.equal(video.className, "se-wallpaper-source", "the source itself is not painted");
  assert.equal(video.getAttribute("src"), VIDEO.media);
  assert.equal(video.muted, true);
  assert.equal(video.loop, true);
  assert.equal(video.autoplay, true);

  const canvas = layer.querySelector("canvas");
  assert.ok(canvas, "the painted element is a canvas");
  assert.equal(canvas.className, "se-wallpaper-media");
  assert.equal(canvas.style.objectFit, "contain");
  assert.equal(canvas.style.transform, "scaleX(-1)", "flipped the way the plugin flips it");
});

test("a video wallpaper paints at a fixed frame budget, not the clip's own cadence", async () => {
  const { document, timers, intervals } = await boot({
    settings: { id: "up-2", objectFit: "cover" },
    wallpapers: [VIDEO],
  });
  const canvas = document.getElementById("se-wallpaper").querySelector("canvas");
  const video = document.getElementById("se-wallpaper").querySelector("video");
  assert.ok(canvas && video, "the layer holds a source and a canvas");

  // A decoded frame reports its dimensions; the pump copies it at that size and
  // lets CSS object-fit do the crop, exactly as it did for the video element.
  video.readyState = 2;
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  video.dispatchEvent({ type: "loadeddata" });
  assert.equal(canvas.width, 1920);
  assert.equal(canvas.height, 1080);

  const frame = intervals.findIndex((ms) => ms > 30 && ms < 40);
  assert.notEqual(frame, -1, "the pump asks for roughly one frame every 33 ms");

  const paints = canvas.draws;
  timers[frame]();
  assert.equal(canvas.draws, paints + 1, "one tick paints one frame, never a burst");
});

test("a 4K clip is painted at the window's pixels, not the clip's", async () => {
  const { document } = await boot({ settings: { id: "up-2" }, wallpapers: [VIDEO] });
  const canvas = document.getElementById("se-wallpaper").querySelector("canvas");
  const video = document.getElementById("se-wallpaper").querySelector("video");
  const hadDpr = Object.prototype.hasOwnProperty.call(globalThis, "devicePixelRatio");
  const previousDpr = globalThis.devicePixelRatio;
  Object.defineProperty(globalThis, "devicePixelRatio", { value: 2, configurable: true });
  try {
    // A 4K clip in a 960×540 CSS box at 2× DPR is a 1920×1080 bitmap: the
    // window never copies pixels it cannot show.
    canvas.clientWidth = 960;
    canvas.clientHeight = 540;
    video.readyState = 2;
    video.videoWidth = 3840;
    video.videoHeight = 2160;
    video.dispatchEvent({ type: "loadeddata" });
    assert.equal(canvas.width, 1920);
    assert.equal(canvas.height, 1080);
  } finally {
    if (hadDpr) Object.defineProperty(globalThis, "devicePixelRatio", { value: previousDpr, configurable: true });
    else delete globalThis.devicePixelRatio;
  }
});

test("a clip with frame callbacks paints only when the decoder has a frame", async () => {
  const { document, intervals } = await boot({ settings: { id: "up-2" }, wallpapers: [VIDEO] });
  const canvas = document.getElementById("se-wallpaper").querySelector("canvas");
  const video = document.getElementById("se-wallpaper").querySelector("video");
  const callbacks = [];
  video.requestVideoFrameCallback = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  video.cancelVideoFrameCallback = () => {};
  video.readyState = 2;
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  video.dispatchEvent({ type: "loadeddata" });

  assert.equal(callbacks.length, 1, "the decoder schedules the next callback, not a timer");
  assert.equal(intervals.some((ms) => ms > 30 && ms < 40), false, "no frame timer when the engine can say when a frame exists");

  const initial = canvas.draws;
  callbacks.shift()(1000);
  assert.equal(canvas.draws, initial + 1, "a new frame paints");
  assert.equal(callbacks.length, 1, "and asks for the next one");

  callbacks.shift()(1010);
  assert.equal(canvas.draws, initial + 1, "a second frame inside the budget is skipped");
  callbacks.shift()(1040);
  assert.equal(canvas.draws, initial + 2, "the next budgeted frame paints");
});

test("a Scene wallpaper falls back to the frame the plugin rendered", async () => {
  const { document } = await boot({ settings: { id: "up-3" }, wallpapers: [SCENE] });
  const image = document.getElementById("se-wallpaper").querySelector("img");
  assert.ok(image, "a still, because a live Scene needs the GPU the window does not ask for");
  assert.equal(image.getAttribute("src"), SCENE.frameUrl);
});

test("no wallpaper, or a wallpaper the inventory does not know, leaves no layer", async () => {
  for (const settings of [null, { id: "" }, { id: "up-gone" }]) {
    const { document } = await boot({ settings, wallpapers: [IMAGE] });
    assert.equal(document.getElementById("se-wallpaper"), null, "nothing to draw");
    assert.equal(document.documentElement.hasAttribute("data-se-wallpaper"), false);
  }
});

test("the poll replaces the picture when the chosen wallpaper changes", async () => {
  const { document, timers } = await boot({
    settings: { id: "up-1" },
    wallpapers: [IMAGE, VIDEO],
    // The plugin pushes nothing, so this is the only way the window learns.
    later: [{ id: "up-2" }],
  });
  assert.ok(document.getElementById("se-wallpaper").querySelector("img"), "the first wallpaper is a picture");

  await poll(timers);

  const layer = document.getElementById("se-wallpaper");
  assert.equal(layer.querySelector("img"), null, "the picture is gone");
  assert.equal(layer.querySelector("video").getAttribute("src"), VIDEO.media, "the video took its place");
  assert.ok(layer.querySelector("canvas.se-wallpaper-media"), "and it is painted through the frame pump");
});

test("an uploaded picture wins over the plugin's, stamped so a replacement lands", async () => {
  const { document, asked } = await boot({
    settings: { id: "up-1", backgroundBrightness: 60 },
    wallpapers: [IMAGE],
    own: { wallpaper: { enabled: true, blur: 0, sync: true, custom: "wallpaper.mp4", customName: "海边.mp4" } },
    file: UPLOAD,
  });

  assert.deepEqual(
    asked,
    ["/session-navigator/api/settings", "/session-navigator/api/wallpaper"],
    "the plugin is not asked at all when the user picked their own file",
  );
  const layer = document.getElementById("se-wallpaper");
  assert.equal(document.documentElement.getAttribute("data-se-wallpaper"), "video");
  const video = layer.querySelector("video");
  assert.equal(
    video.getAttribute("src"),
    "/session-navigator/api/wallpaper/media?v=" + encodeURIComponent(UPLOAD.modified + "-" + UPLOAD.bytes),
    "the stamp changes when the bytes do, so a replaced file is re-fetched",
  );
  assert.equal(layer.style.filter, "none", "an uploaded file gets no plugin look and no filter layer");
  assert.equal(layer.querySelector("canvas.se-wallpaper-media").style.objectFit, "cover");
});

test("美化 off is a plain window, even with a wallpaper chosen everywhere else", async () => {
  const { document, asked } = await boot({
    settings: { id: "up-1" },
    wallpapers: [IMAGE],
    own: { wallpaper: { enabled: false, blur: 0, sync: true, custom: "wallpaper.mp4", customName: "海边.mp4" } },
    file: UPLOAD,
  });

  assert.deepEqual(asked, ["/session-navigator/api/settings"], "nothing else is read");
  assert.equal(document.getElementById("se-wallpaper"), null);
  assert.equal(
    document.documentElement.style.getPropertyValue("--se-wallpaper-alpha"),
    "",
    "a plain window keeps the panel it had before the picture",
  );
  assert.equal(
    document.documentElement.style.getPropertyValue("--se-wallpaper-dim"),
    "",
    "and no veil is left behind either",
  );
});

test("跟随壁纸插件 off does not quietly fall back to the plugin", async () => {
  const { document, asked } = await boot({
    settings: { id: "up-1" },
    wallpapers: [IMAGE],
    own: { wallpaper: { enabled: true, blur: 0, sync: false, custom: "", customName: "" } },
  });

  assert.deepEqual(asked, ["/session-navigator/api/settings"], "the switch is the answer, not a hint");
  assert.equal(document.getElementById("se-wallpaper"), null);
});

test("an uploaded wallpaper that the Host no longer has leaves no layer", async () => {
  const { document } = await boot({
    settings: { id: "up-1" },
    wallpapers: [IMAGE],
    own: { wallpaper: { enabled: true, blur: 4, sync: true, custom: "wallpaper.mp4", customName: "海边.mp4" } },
    file: null,
  });

  assert.equal(
    document.getElementById("se-wallpaper"),
    null,
    "the file moved or was removed: a black rectangle is not a fallback",
  );
});

test("模糊度 blurs the picture, and only the picture", async () => {
  const onPlugin = await boot({
    settings: { id: "up-1", wallpaperBlur: 6, backgroundBrightness: 80 },
    wallpapers: [IMAGE],
    own: { wallpaper: { enabled: true, blur: 10, frost: 88, dim: 0, sync: true, custom: "", customName: "" } },
  });
  const onPluginFilter = onPlugin.document.getElementById("se-wallpaper").style.filter;
  assert.match(onPluginFilter, /^blur\(4px\)/, "10% is 10% of the 40 px the slider can spend");
  assert.match(onPluginFilter, /brightness\(80%\)/, "the plugin's colour still counts");
  // The three sliders are three surfaces: 模糊度 must not move the panel.
  assert.equal(
    onPlugin.document.documentElement.style.getPropertyValue("--se-wallpaper-alpha"),
    "88%",
    "a soft picture leaves the glass where 磨砂度 put it",
  );

  const onOwn = await boot({
    settings: null,
    wallpapers: [],
    own: { wallpaper: { enabled: true, blur: 10, frost: 88, dim: 0, sync: true, custom: "wallpaper.png", customName: "a.png" } },
    file: { ...UPLOAD, file: "wallpaper.png", type: "image/png" },
  });
  assert.equal(onOwn.document.getElementById("se-wallpaper").style.filter, "blur(4px)");
});

test("磨砂度 is the panel's density: 0 is clear glass, 100 is the old panel", async () => {
  const clear = await boot({
    settings: { id: "up-1" },
    wallpapers: [IMAGE],
    own: { wallpaper: { enabled: true, blur: 0, frost: 0, dim: 0, sync: true, custom: "", customName: "" } },
  });
  assert.equal(
    clear.document.documentElement.style.getPropertyValue("--se-wallpaper-alpha"),
    "0%",
    "0 is a percentage like any other: the glass is gone",
  );
  assert.equal(clear.document.getElementById("se-wallpaper").style.filter, "none", "a sharp picture needs no filter layer");

  const frosted = await boot({
    settings: { id: "up-1" },
    wallpapers: [IMAGE],
    own: { wallpaper: { enabled: true, blur: 100, frost: 100, dim: 0, sync: true, custom: "", customName: "" } },
  });
  assert.equal(
    frosted.document.documentElement.style.getPropertyValue("--se-wallpaper-alpha"),
    "100%",
    "100 is the panel a window without a picture always had",
  );
  assert.match(frosted.document.getElementById("se-wallpaper").style.filter, /^blur\(40px\)/, "and 40 px of picture blur");

  const middle = await boot({
    settings: { id: "up-1" },
    wallpapers: [IMAGE],
    own: { wallpaper: { enabled: true, blur: 0, frost: 35, dim: 0, sync: true, custom: "", customName: "" } },
  });
  assert.equal(
    middle.document.documentElement.style.getPropertyValue("--se-wallpaper-alpha"),
    "35%",
    "the number is the percentage, not a position on a curve",
  );
});

test("壁纸暗度 is a veil on the picture, and 0 is no veil", async () => {
  const veiled = await boot({
    settings: { id: "up-1" },
    wallpapers: [IMAGE],
    own: { wallpaper: { enabled: true, blur: 0, frost: 88, dim: 40, sync: true, custom: "", customName: "" } },
  });
  assert.equal(
    veiled.document.documentElement.style.getPropertyValue("--se-wallpaper-dim"),
    "0.4",
    "the percentage becomes the veil's opacity",
  );
  assert.equal(
    veiled.document.documentElement.style.getPropertyValue("--se-wallpaper-alpha"),
    "88%",
    "and it leaves the glass alone",
  );

  const plain = await boot({
    settings: { id: "up-1" },
    wallpapers: [IMAGE],
    own: { wallpaper: { enabled: true, blur: 0, frost: 88, dim: 0, sync: true, custom: "", customName: "" } },
  });
  assert.equal(plain.document.documentElement.style.getPropertyValue("--se-wallpaper-dim"), "0");
});

test("the window's own bars let the picture through", () => {
  // The panel's tint is translucent, but the status line and the fixed toolbar
  // cluster paint a tint of their own on top of it. Anything near-opaque there
  // stacks into a black slab, which is what the window showed over a picture.
  const css = readFileSync(join(HERE, "..", "assets", "detached", "window.css"), "utf8");
  const scoped = css.match(/html\[data-se-wallpaper\][^{]*\{[^}]*\}/g) ?? [];
  // The alpha is whatever sits between the tint and ", transparent)", which for a
  // calc() is not a single token.
  const tints = scoped.flatMap((block) =>
    [...block.matchAll(/var\(--sm-tint\)([^;{}]*?), transparent\)/g)].map((match) => match[1].trim()),
  );
  assert.ok(tints.length > 0, "a bar over the picture is re-tinted, not merely inherited");
  for (const alpha of tints) {
    assert.match(
      alpha,
      /^calc\(var\(--se-wallpaper-alpha, \d+%\) \* \d+ \/ 100\)$/,
      `a bar painted at ${alpha} is a slab that ignores 模糊度`,
    );
  }

  // The panel itself reads its alpha from the variable the slider writes, so a
  // window with a picture cannot fall back to a fixed, solid 88%.
  const panel = css.match(/\.se-shell\[data-material="auto"\]\s*\{[^}]*\}/);
  assert.ok(panel, "the auto material still has a rule of its own");
  assert.match(
    panel[0],
    /--panel-alpha:\s*var\(--se-wallpaper-alpha,\s*\d+%\)/,
    "the panel's alpha follows 磨砂度 instead of being frozen",
  );

  // 壁纸暗度 needs a surface to be painted on: a veil between the picture and the
  // panel, driven by the variable the script writes.
  const veil = css.match(/#se-wallpaper::after\s*\{[^}]*\}/);
  assert.ok(veil, "the dim slider has a layer of its own");
  assert.match(veil[0], /opacity:\s*var\(--se-wallpaper-dim/, "and its opacity is that variable");
});

test("?wallpaper=0 leaves the window plain", async () => {
  const { document, asked } = await boot({ settings: { id: "up-1" }, wallpapers: [IMAGE], search: "?wallpaper=0" });
  assert.deepEqual(asked, [], "nothing is even asked for");
  assert.equal(document.getElementById("se-wallpaper"), null);
});