/**
 * dsh-session-navigator — the picture under the panel in the detached window.
 *
 * Two sources, in this order. A picture the user uploaded through 设置 ›
 * 独立窗口美化 wins; otherwise the window mirrors the wallpaper DSH itself is
 * showing, painted by `dsh-plugin-wallpaper-engine`; and 跟随壁纸插件 off, or
 * 美化 off, means no picture at all.
 *
 * The plugin paints into its own document (a div under `document.body`, not a
 * window and not a `background-image`), and this window is a different document,
 * so the picture has to be asked for again over same-origin HTTP:
 *
 *   GET /session-navigator/api/settings        → { ok, result: { settings: { wallpaper } } }
 *   GET /session-navigator/api/wallpaper       → { ok, result: { file } | { result: { file: null } } }
 *   GET /session-navigator/api/wallpaper/media → the uploaded bytes
 *   GET /wallpaper-engine/settings             → { settings: { id, objectFit, … } }
 *   GET /wallpaper-engine/inventory            → { wallpapers: [ { id, type, … } ] }
 *
 * Two facts about the plugin's routes decide the shape of the mirror. The media
 * token is a base64url of the absolute file path, held in the host's memory, so
 * it only exists after something asked for the inventory — hence the inventory
 * fetch before every media URL, never a URL built here. And nothing is pushed
 * when the wallpaper changes: the plugin has no event bus, so the window polls
 * the one small settings object and re-renders only when the id it names
 * changes. This plugin's own routes follow the same rule, so the poll reads both
 * documents; a settings write from 设置 lands within a few seconds.
 *
 * What this deliberately is not: the plugin's glass or its parallax offsets.
 * Those live in the other document's custom properties and in its render loop;
 * a copy that guessed at them would drift. A video is different: the decoder is
 * allowed to run at its own rate, but this window only paints it into a canvas
 * at VIDEO_FPS, so a 60 or 120 fps clip does not make the whole window repaint
 * at that rate. A picture at the same crop is what "the window shows my
 * wallpaper" means.
 */
(function () {
  "use strict";

  /** This plugin's own API, the same prefix the panel uses. */
  const API = "/session-navigator/api";

  /** 设置文档 — holds 美化 enabled / blur / frost / dim / sync / which custom file. */
  const OWN_SETTINGS_URL = API + "/settings";

  /**
   * The uploaded file's name, size and stamp.
   *
   * Only read when a custom file is named: its cache-buster has to change when
   * the bytes change, and a rename or a replacement of the same name is exactly
   * the case a URL alone cannot see.
   */
  const OWN_WALLPAPER_URL = API + "/wallpaper";

  /** The uploaded bytes themselves, streamed by the host (Range supported). */
  const OWN_MEDIA_URL = API + "/wallpaper/media";

  /**
   * The plugin's two read-only routes.
   *
   * The whole settings document, not one namespace: the plugin splits it into
   * `core` (the chosen id, objectFit, flip) and `appearance` (brightness,
   * contrast, blur, wallpaper opacity), and the window needs both. Asking for
   * the merged document is one request instead of two, and it is the same
   * snapshot the plugin's own page reads.
   */
  const SETTINGS_URL = "/wallpaper-engine/settings";
  const INVENTORY_URL = "/wallpaper-engine/inventory";

  /** How often the chosen wallpaper is re-read. One small JSON, not a stream. */
  const POLL_MS = 4000;

  /**
   * The frame budget for a video wallpaper.
   *
   * A wallpaper is motion, not a game: 30 fps is enough to read as video, and
   * drawing into a canvas at that rate keeps a 60 or 120 fps clip from asking
   * the window to composite every frame the decoder produces.
   */
  const VIDEO_FPS = 30;
  const VIDEO_FRAME_MS = 1000 / VIDEO_FPS;

  /** The highest device pixel ratio worth copying; beyond 2× the extra pixels are invisible. */
  const VIDEO_DPR_MAX = 2;

  /** The inventory is a full directory scan; it is reused for this long. */
  const INVENTORY_TTL_MS = 30000;

  const LAYER_ID = "se-wallpaper";

  /** 模糊度, 磨砂度 and 壁纸暗度 are percentages; see settings.js MAX_WALLPAPER_PERCENT. */
  const MAX_PERCENT = 100;

  /**
   * The picture's own blur is still pixels, so the percentage is read as a share
   * of the widest radius the setting page's slider can reach.
   */
  const MAX_RADIUS = 40;

  /** Read by window.css: html[data-se-wallpaper] .se-shell takes its alpha from it. */
  const GLASS_PROPERTY = "--se-wallpaper-alpha";

  /** Read by window.css: the black veil painted over the picture. */
  const DIM_PROPERTY = "--se-wallpaper-dim";

  /** `?wallpaper=0` on the window URL turns the mirror off, for a plain window. */
  const disabled = new URLSearchParams(location.search).get("wallpaper") === "0";

  /** The container the picture is drawn into: first child, behind the panel. */
  const layer = document.createElement("div");
  layer.id = LAYER_ID;
  layer.setAttribute("aria-hidden", "true");

  /** Which wallpaper the layer currently shows, so a poll can skip the DOM. */
  let shown = "";

  /** Cached inventory: { at, byId }. */
  let inventory = { at: 0, byId: null };

  /** The last look, recomputed from settings so a re-render keeps crop and filters. */
  let appearance = null;

  /** Stops the last video's frame pump and releases its decoder. */
  let stopFrames = null;

  function stopVideoFrames() {
    const stop = stopFrames;
    stopFrames = null;
    if (typeof stop !== "function") return;
    try {
      stop();
    } catch {
      /* a decoder that is already gone has nothing to release */
    }
  }

  function number(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  async function readJson(url) {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(url + " → " + response.status);
    return response.json();
  }

  /**
   * This plugin's own routes, unwrapped.
   *
   * The Host answers every one of its routes inside `{ ok, result }`; the
   * wallpaper plugin next door answers bare objects. Reading `settings` off the
   * envelope is how "美化 off" turned into "keep mirroring": the field was one
   * level down, so every switch read as unset and the window fell through to the
   * plugin's own picture. Unwrap first, then read.
   *
   * @param {string} url
   * @returns {Promise<any>}
   */
  async function readResult(url) {
    const data = await readJson(url);
    return data && data.ok === true && data.result && typeof data.result === "object" ? data.result : data;
  }

  /**
   * The plugin's wallpaper entries, keyed by id.
   *
   * A failed read answers nothing rather than a stale map: a wallpaper that
   * cannot be resolved is a layer that should not be drawn, and keeping the
   * previous picture under a new id would look like a bug of ours.
   */
  async function entries() {
    const now = Date.now();
    if (inventory.byId && now - inventory.at < INVENTORY_TTL_MS) return inventory.byId;
    const data = await readJson(INVENTORY_URL);
    const byId = new Map();
    for (const entry of Array.isArray(data.wallpapers) ? data.wallpapers : []) {
      if (entry && typeof entry.id === "string") byId.set(entry.id, entry);
    }
    inventory = { at: now, byId };
    return byId;
  }

  /** A stored percentage, whatever the document says. */
  function percent(value, fallback) {
    const n = number(value, fallback);
    return Math.min(MAX_PERCENT, Math.max(0, Math.round(n)));
  }

  /**
   * The look of the window, computed from three numbers the settings page shows.
   *
   * They are separate surfaces on purpose. 模糊度 is the picture's own softness
   * (0–40 px), 磨砂度 is how much tint the panel keeps in front of it, and
   * 壁纸暗度 is a black veil on the picture, for a wallpaper too bright to read
   * over. Each is the percentage the slider displays: no curve in between, so the
   * window and the number on screen cannot disagree.
   *
   * None of them is the wallpaper plugin's: a plugin value added on top would
   * make the window disagree with the number the user just moved.
   */
  function lookOf(wallpaper) {
    return {
      blur: percent(wallpaper.blur, 0),
      frost: percent(wallpaper.frost, 60),
      dim: percent(wallpaper.dim, 10),
    };
  }

  const radiusFor = (look) => (look.blur / MAX_PERCENT) * MAX_RADIUS;

  /**
   * A filter list, or "none".
   *
   * blur(0px) is not a no-op to the compositor: it still gives the layer an
   * offscreen filter pass that Chromium repeats whenever the canvas below it
   * changes. The wallpaper engine avoids a permanent blur(0px) for the same
   * reason, so a default look leaves the layer on the plain compositor path.
   */
  function filterOf(radius, brightness, contrast, saturate) {
    const parts = [];
    if (radius > 0) parts.push("blur(" + radius + "px)");
    if (brightness !== 100) parts.push("brightness(" + brightness + "%)");
    if (contrast !== 100) parts.push("contrast(" + contrast + "%)");
    if (saturate !== 100) parts.push("saturate(" + saturate + "%)");
    return parts.length > 0 ? parts.join(" ") : "none";
  }

  function styleFor(settings, look) {
    const brightness = number(settings.backgroundBrightness, 100);
    const contrast = number(settings.backgroundContrast, 100);
    const saturate = number(settings.backgroundSaturate, 100);
    const hidden = number(settings.wallpaperOpacity, 0);
    return {
      fit: settings.objectFit === "contain" ? "contain" : "cover",
      flip: settings.flip === true,
      filter: filterOf(radiusFor(look), brightness, contrast, saturate),
      // The plugin's key is how *transparent* the wallpaper is (0–90), inverted
      // against its own opacity variable the same way its stylesheet does.
      opacity: Math.max(0, Math.min(1, (100 - hidden) / 100)),
      glass: look.frost,
      dim: look.dim,
    };
  }

  /**
   * An uploaded picture has no plugin behind it, so it gets its own look: full
   * strength, cover crop, and only the blur the user asked for.
   */
  function ownStyleFor(look) {
    return {
      fit: "cover",
      flip: false,
      filter: filterOf(radiusFor(look), 100, 100, 100),
      opacity: 1,
      glass: look.frost,
      dim: look.dim,
    };
  }

  function applyAppearance() {
    if (!appearance) return;
    layer.style.filter = appearance.filter;
    layer.style.opacity = String(appearance.opacity);
    const root = document.documentElement;
    if (root && root.style && typeof root.style.setProperty === "function") {
      root.style.setProperty(GLASS_PROPERTY, appearance.glass + "%");
      root.style.setProperty(DIM_PROPERTY, String(appearance.dim / 100));
    }
    const media = layer.querySelector(".se-wallpaper-media");
    if (media) {
      media.style.objectFit = appearance.fit;
      media.style.transform = appearance.flip ? "scaleX(-1)" : "";
    }
  }

  /**
   * A video, drawn into a canvas at VIDEO_FPS, or a still.
   *
   * The video element stays in the layer as an invisible source: a detached
   * element still decodes, but keeping it here makes that true on every engine
   * and gives the canvas a frame to copy. The canvas is the element the window
   * actually paints, so object-fit and flip apply to it exactly as they did to
   * the video before.
   *
   * Scene and web wallpapers are shown as their still (frameUrl / preview) on
   * purpose: a live Scene needs WebGL, and the window asks Electron to run
   * without it. A still that always draws beats a canvas that cannot.
   */
  function videoFor(entry) {
    const video = document.createElement("video");
    video.className = "se-wallpaper-source";
    video.muted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("preload", "auto");
    video.setAttribute("disablepictureinpicture", "");
    video.setAttribute("disableremoteplayback", "");

    const canvas = document.createElement("canvas");
    canvas.className = "se-wallpaper-media";
    canvas.width = 16;
    canvas.height = 9;
    const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
    if (!context) {
      // A window without a 2D canvas can still show the clip; it just cannot
      // cap it. The video is the media element in that fallback.
      stopFrames = () => {
        try {
          video.pause();
        } catch {
          /* nothing to stop */
        }
      };
      video.className = "se-wallpaper-media";
      video.setAttribute("src", entry.media);
      const played = typeof video.play === "function" ? video.play() : null;
      if (played && typeof played.catch === "function") played.catch(() => {});
      return video;
    }

    let frameHandle = null;
    let frameKind = "";
    let running = false;
    let stopped = false;
    let lastPaintAt = 0;
    let resizeObserver = null;

    const clock = () => {
      const perf = globalThis.performance;
      return perf && typeof perf.now === "function" ? perf.now() : Date.now();
    };
    const deviceScale = () => {
      const value = Number(globalThis.devicePixelRatio);
      return Number.isFinite(value) && value > 1 ? Math.min(value, VIDEO_DPR_MAX) : 1;
    };

    /**
     * The canvas bitmap is the window's pixels, never the clip's. A 4K clip on
     * a 1080p window used to copy 8.3 million pixels thirty times a second;
     * capping at the displayed size (and at 2× DPR) copies a quarter of that.
     * When there is no layout yet (a hidden window, a test DOM), the native
     * size is the only honest answer.
     */
    function sizeCanvas() {
      const vw = Number(video.videoWidth) || 0;
      const vh = Number(video.videoHeight) || 0;
      if (!vw || !vh) return false;
      const shownWidth = Number(canvas.clientWidth) || 0;
      const shownHeight = Number(canvas.clientHeight) || 0;
      const scale = deviceScale();
      let cw = vw;
      let ch = vh;
      if (shownWidth > 0 && shownHeight > 0) {
        cw = Math.max(1, Math.min(vw, Math.round(shownWidth * scale)));
        ch = Math.max(1, Math.min(vh, Math.round(shownHeight * scale)));
      } else if (shownWidth > 0) {
        cw = Math.max(1, Math.min(vw, Math.round(shownWidth * scale)));
        ch = Math.max(1, Math.round((cw * vh) / vw));
      } else if (shownHeight > 0) {
        ch = Math.max(1, Math.min(vh, Math.round(shownHeight * scale)));
        cw = Math.max(1, Math.round((ch * vw) / vh));
      }
      if (canvas.width === cw && canvas.height === ch) return false;
      canvas.width = cw;
      canvas.height = ch;
      return true;
    }

    function paint() {
      if (stopped) return;
      const vw = Number(video.videoWidth) || 0;
      const vh = Number(video.videoHeight) || 0;
      if (video.readyState < 2 || !vw || !vh) return;
      sizeCanvas();
      const cw = canvas.width;
      const ch = canvas.height;
      // object-fit is done here because the bitmap now has the window's
      // aspect, not the clip's. CSS object-fit would have nothing left to crop.
      const fit = appearance && appearance.fit === "contain" ? "contain" : "cover";
      const scale = fit === "contain" ? Math.min(cw / vw, ch / vh) : Math.max(cw / vw, ch / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      const dx = (cw - dw) / 2;
      const dy = (ch - dh) / 2;
      try {
        if (typeof context.clearRect === "function") context.clearRect(0, 0, cw, ch);
        context.drawImage(video, 0, 0, vw, vh, dx, dy, dw, dh);
      } catch {
        // The next frame may be decodable; one bad frame is not a reason to
        // stop the pump.
      }
    }

    function stopPump() {
      running = false;
      if (frameKind === "rvfc" && typeof video.cancelVideoFrameCallback === "function") {
        try {
          video.cancelVideoFrameCallback(frameHandle);
        } catch {
          /* a callback that already ran is not cancellable */
        }
      } else if (frameKind === "raf" && typeof globalThis.cancelAnimationFrame === "function") {
        try {
          globalThis.cancelAnimationFrame(frameHandle);
        } catch {
          /* ignore */
        }
      } else if (frameKind === "timer") {
        clearInterval(frameHandle);
      }
      frameHandle = null;
      frameKind = "";
    }

    /**
     * One painted frame per video frame, capped at VIDEO_FPS. requestVideoFrame-
     * Callback is the important half: a paused, hidden or finished clip produces
     * no callbacks, so the window does no work at all. rAF and setInterval are
     * only fallbacks for engines that lack it.
     */
    function tick(now) {
      if (!running || stopped) return;
      const at = Number(now);
      const stamp = Number.isFinite(at) ? at : clock();
      if (frameKind === "timer" || lastPaintAt === 0 || stamp - lastPaintAt >= VIDEO_FRAME_MS - 1) {
        // setInterval already *is* the budget; the other two schedulers tick at
        // the display or decode rate and have to skip frames themselves.
        lastPaintAt = stamp;
        paint();
      }
      if (frameKind !== "timer") schedule();
    }

    function schedule() {
      if (!running || stopped) return;
      if (typeof video.requestVideoFrameCallback === "function") {
        frameKind = "rvfc";
        frameHandle = video.requestVideoFrameCallback(tick);
        return;
      }
      if (typeof globalThis.requestAnimationFrame === "function") {
        frameKind = "raf";
        frameHandle = globalThis.requestAnimationFrame(tick);
        return;
      }
      frameKind = "timer";
      frameHandle = setInterval(() => tick(clock()), VIDEO_FRAME_MS);
    }

    function start() {
      if (running || stopped || document.hidden) return;
      running = true;
      lastPaintAt = 0;
      paint();
      lastPaintAt = clock();
      schedule();
    }

    function onResize() {
      if (sizeCanvas()) paint();
    }
    function onPause() {
      stopPump();
    }
    function onVisible() {
      if (document.hidden) {
        stopPump();
        try {
          video.pause();
        } catch {
          /* a video that is already gone has nothing to pause */
        }
        return;
      }
      const played = typeof video.play === "function" ? video.play() : null;
      if (played && typeof played.catch === "function") played.catch(() => {});
      start();
    }

    video.addEventListener("loadeddata", start);
    video.addEventListener("playing", start);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onPause);
    if (typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", onVisible);
    }
    if (typeof globalThis.ResizeObserver === "function") {
      resizeObserver = new globalThis.ResizeObserver(onResize);
      resizeObserver.observe(canvas);
    }
    if (typeof globalThis.addEventListener === "function") {
      globalThis.addEventListener("resize", onResize);
    }
    stopFrames = () => {
      stopped = true;
      stopPump();
      try {
        resizeObserver?.disconnect?.();
      } catch {
        /* ignore */
      }
      try {
        globalThis.removeEventListener?.("resize", onResize);
      } catch {
        /* ignore */
      }
      try {
        document.removeEventListener?.("visibilitychange", onVisible);
      } catch {
        /* ignore */
      }
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      try {
        video.removeAttribute("src");
      } catch {
        /* ignore */
      }
      try {
        video.load?.();
      } catch {
        /* ignore */
      }
    };
    video.setAttribute("src", entry.media);
    const played = typeof video.play === "function" ? video.play() : null;
    if (played && typeof played.catch === "function") played.catch(() => {});
    return [video, canvas];
  }

  function elementFor(entry) {
    if (entry.type === "video" && entry.media) return videoFor(entry);
    const still = entry.type === "image" ? entry.media || entry.preview : entry.frameUrl || entry.preview;
    if (!still) return null;
    const image = document.createElement("img");
    image.className = "se-wallpaper-media";
    image.setAttribute("src", still);
    image.setAttribute("alt", "");
    return image;
  }

  function clear() {
    stopVideoFrames();
    shown = "";
    appearance = null;
    layer.replaceChildren();
    layer.remove();
    const root = document.documentElement;
    if (root && root.style && typeof root.style.removeProperty === "function") {
      root.style.removeProperty(GLASS_PROPERTY);
      root.style.removeProperty(DIM_PROPERTY);
    }
    document.documentElement.removeAttribute("data-se-wallpaper");
  }

  function show(entry) {
    stopVideoFrames();
    const media = elementFor(entry);
    if (!media) {
      clear();
      return;
    }
    layer.replaceChildren(...(Array.isArray(media) ? media : [media]));
    if (!layer.parentNode) document.body.insertBefore(layer, document.body.firstChild);
    document.documentElement.setAttribute("data-se-wallpaper", entry.type || "image");
    applyAppearance();
  }

  /**
   * Paint the uploaded file.
   *
   * The cache-buster is the file's stamp plus its size, so replacing
   * `wallpaper.png` with another picture reloads the layer while an untouched
   * file keeps the one it already decoded.
   */
  async function showOwn(look) {
    const data = await readResult(OWN_WALLPAPER_URL);
    const file = data && data.file ? data.file : null;
    if (!file || typeof file.file !== "string" || !file.file) {
      clear();
      return;
    }
    const stamp = String(file.modified || "") + "-" + String(file.bytes || "");
    const url = OWN_MEDIA_URL + "?v=" + encodeURIComponent(stamp);
    const type = typeof file.type === "string" && file.type.indexOf("video/") === 0 ? "video" : "image";
    appearance = ownStyleFor(look);
    const key = "own|" + type + "|" + url;
    if (key !== shown) {
      shown = key;
      show({ type, media: url });
      return;
    }
    applyAppearance();
  }

  /** Paint whatever DSH's wallpaper plugin is showing. */
  async function showPlugin(look) {
    const data = await readJson(SETTINGS_URL);
    const settings = data && data.settings ? data.settings : data;
    if (!settings || typeof settings.id !== "string" || !settings.id) {
      clear();
      return;
    }
    appearance = styleFor(settings, look);
    const entry = (await entries()).get(settings.id);
    if (!entry) {
      clear();
      return;
    }
    const key = "plugin|" + settings.id + "|" + entry.type + "|" + (entry.media || entry.frameUrl || entry.preview || "");
    if (key !== shown) {
      shown = key;
      show(entry);
      return;
    }
    applyAppearance();
  }

  async function tick() {
    // Not skipped while hidden: 美化 off is a decision this window has to carry
    // out the moment it reads it, and a window that is behind the settings page
    // is exactly when the user flips that switch.
    const payload = await readResult(OWN_SETTINGS_URL);
    const own = payload && payload.settings ? payload.settings : payload;
    const wallpaper = own && own.wallpaper ? own.wallpaper : {};
    if (wallpaper.enabled === false) {
      clear();
      return;
    }
    const look = lookOf(wallpaper);
    if (typeof wallpaper.custom === "string" && wallpaper.custom !== "") {
      await showOwn(look);
      return;
    }
    // Off means the window has no picture, not "fall back to the plugin": the
    // switch is the user saying they do not want one here.
    if (wallpaper.sync === false) {
      clear();
      return;
    }
    await showPlugin(look);
  }

  function start() {
    if (disabled) return;
    const run = () => {
      tick().catch(() => {
        // A window that outlived the host has nothing to show, and a layer that
        // is not there is the correct picture of that.
        clear();
      });
    };
    run();
    setInterval(run, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) run();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();