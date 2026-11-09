/**
 * dsh-session-navigator — the Electron helper's main process.
 *
 * This file runs *inside* the downloaded browser component, not inside DSH.
 * It is deliberately tiny: one window, no Node integration, no remote content,
 * and a single local page loaded from the plugin's own assets.
 *
 * Security posture (mirrors the advice in 实现粗规划 §5.6 ⑦):
 *
 *   - `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`;
 *   - the only preload is the plugin's own, and it exposes three IPC calls;
 *   - `setWindowOpenHandler` denies every popup and `will-navigate` refuses
 *     every navigation except the origin the page came from; links open in the
 *     user's real browser instead;
 *   - the page is the Host's own `/session-navigator/api/ui`, served on loopback
 *     out of the plugin's directory. It is the explorer itself, not the DSH app:
 *     the window runs the same module the in-app panel runs, so there is no
 *     second copy of the UI and no second copy of DSH behind it.
 *
 * The helper talks to the Host over the same HTTP API the in-app panel uses,
 * authenticated with the token the Host put in the environment. The token never
 * reaches the page's JavaScript: the preload attaches it to fetches.
 *
 * NOTE: this file is shipped as-is; Electron loads it as a CommonJS main.
 */

const { app, BrowserWindow, ipcMain, screen, shell, session } = require("electron");
const { join } = require("node:path");
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { createConnection } = require("node:net");

const TOKEN = process.env.DSH_SE_HELPER_TOKEN ?? "";
const PORT = Number(process.env.DSH_SE_HELPER_PORT ?? 0);
const WEB_PORT = Number(process.env.DSH_SE_WEB_PORT ?? 0);
const DATA_DIR = process.env.DSH_SE_DATA_DIR ?? "";
const WINDOW_FILE = DATA_DIR ? join(DATA_DIR, "detached", "window.json") : "";

/**
 * The languages this plugin draws in.
 *
 * A copy of src/lang.js LANGS rather than an import: this file is the only one
 * that travels into the downloaded Electron runtime, so a relative import would
 * point at a directory that is not there. test/lang-chain.test.mjs keeps the
 * copies honest.
 */
const LANGS = ["zh", "en", "ja", "ko", "de", "fr", "es", "ru", "pt", "zh-hant"];

/**
 * A region-tagged code belongs to its base language; anything else is "".
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeLang(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/_/g, "-") : "";
  // 繁體中文 — DSH has no 繁體 switch of its own, so the codes that reach the
  // panel are zh-TW / zh-HK / zh-MO / zh-Hant, from the plugin's own override or
  // from a detached window's URL. They all mean the one traditional table.
  if (/^zh-(hant|tw|hk|mo)(-|$)/.test(raw) && LANGS.includes("zh-hant")) return "zh-hant";
  const base = raw.split("-")[0];
  return LANGS.includes(base) ? base : "";
}

/**
 * The language the shim draws the page in, as last reported by the panel.
 *
 * The window has its own document and no view of DSH's locale, so the page is
 * told in its URL. It is mutable because a language switch arrives later, as a
 * control message, and the page has to be reloaded to pick it up.
 *
 * @type {string} one of LANGS
 */
let pageLang = normalizeLang(process.env.DSH_SE_LANG) || "zh";

/**
 * The page the window shows: the Host's own route, on loopback.
 *
 * Served by the Host instead of read from disk with `loadFile`, because the page
 * has to share an origin with `/session-navigator/api`: that is what lets it load
 * the panel's own module and call the API without a token. The Host is the only
 * side that knows its port.
 *
 * @returns {string} the page URL, or "" when the port is unknown
 */
function pageUrl() {
  if (!WEB_PORT) return "";
  return `http://127.0.0.1:${WEB_PORT}/session-navigator/api/ui?lang=${pageLang}`;
}

/**
 * Switch the page's language, reloading it when it has to change.
 *
 * The shim fixes its dictionary at load time — it is the panel's own bundle,
 * and the panel reads the language once per render — so a new language means a
 * new document. Nothing else about the window changes: same URL, same origin,
 * same Host, and the panel keeps its state in the Host rather than the page.
 *
 * @param {unknown} lang the requested language, as the panel reported it
 */
function applyLang(lang) {
  const next = normalizeLang(lang) || "zh";
  if (next === pageLang) return;
  pageLang = next;
  const url = pageUrl();
  if (!win || !url) return;
  win.loadURL(url).catch((error) => {
    console.error(`session-navigator detached: reload for language failed: ${error?.message ?? error}`);
  });
}

/**
 * The colour the frame is painted before the page has drawn anything.
 *
 * The caption buttons themselves are page-drawn (shim.js `mountCaption`), so
 * they need no native colours; this only stops a white flash between the window
 * appearing and the stylesheet loading.
 */
const CAPTION_FALLBACK = { color: "#232324", symbol: "#e6e6e6" };

// Hardware acceleration is on by default: the page is a dense list with a
// video-capable wallpaper layer, and software compositing made both the
// panel and the window feel heavier than the same page inside DSH.
// `DSH_SE_DISABLE_GPU=1` is the escape hatch for a broken driver or a
// remote session, where Chromium's GPU process would otherwise take the
// window down with it. The switch has to be decided before `whenReady`.
const DISABLE_GPU = process.env.DSH_SE_DISABLE_GPU === "1";
const LOG_GPU = process.env.DSH_SE_GPU_LOG === "1";
if (DISABLE_GPU) app.disableHardwareAcceleration?.();
else {
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  // Chromium's blocklist is conservative about virtual GPUs (VMware SVGA,
  // VirtualBox, some RDP adapters). Without this switch the window starts a
  // GPU process and then composites in software anyway — which is exactly the
  // case this option exists for.
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
}

/** @type {BrowserWindow | null} */
let win = null;
/** @type {import("node:net").Socket | null} */
let control = null;
/** The Host only accepts messages after it has answered the hello. */
let controlReady = false;
/** A GPU report that arrived before the handshake finished. */
let gpuReport = null;
/** A machine reports its missing GPU once, not once per frame. */
let gpuReported = false;
/** A GPU process torn down on quit is not a driver failure. */
let quitting = false;

/**
 * Remembered geometry, clamped to a visible display.
 *
 * @returns {{ width: number, height: number, x?: number, y?: number }}
 */
function initialBounds() {
  const fallback = { width: 1280, height: 820 };
  try {
    if (!WINDOW_FILE || !existsSync(WINDOW_FILE)) return fallback;
    const raw = JSON.parse(readFileSync(WINDOW_FILE, "utf8"));
    const width = Number(raw.width);
    const height = Number(raw.height);
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 720 || height < 480) return fallback;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height };
    // A window restored onto a monitor that is gone would be invisible.
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return x >= area.x - 40 && y >= area.y - 40 && x < area.x + area.width - 80 && y < area.y + area.height - 80;
    });
    return visible ? { width, height, x, y } : { width, height };
  } catch {
    return fallback;
  }
}

/**
 * @param {string} event
 * @param {any} payload
 */
function send(event, payload) {
  if (control?.writable) {
    try {
      control.write(`${JSON.stringify({ type: event, ...payload })}\n`);
    } catch {
      /* the Host is gone; the window stays usable read-only */
    }
  }
}

/**
 * Chromium answers with the feature set it actually enabled. A report that is
 * missing (older Electron) is not evidence against the GPU.
 *
 * @param {any} status
 * @returns {boolean}
 */
function gpuUsable(status) {
  const compositing = typeof status?.gpu_compositing === "string" ? status.gpu_compositing : "";
  return compositing === "" || compositing.startsWith("enabled");
}

/**
 * Tell the Host that this machine cannot use the GPU.
 *
 * The settings page owns the switch, so the helper must not write settings
 * itself; it reports the fact and the Host remembers it for the next launch.
 * The message is queued until `hello-ok`: writing earlier would look like an
 * unauthenticated client and the Host would drop the connection.
 *
 * @param {string} reason
 * @param {any} [status]
 */
function reportGpu(reason, status) {
  if (DISABLE_GPU || gpuReported) return;
  gpuReported = true;
  gpuReport = { available: false, reason, status: status ?? null };
  if (!controlReady) return;
  send("gpu", gpuReport);
  gpuReport = null;
}

/**
 * Run `fn` at most once per `ms`, trailing edge.
 *
 * A resize fires dozens of events per second; writing the geometry (and posting
 * it to the Host) on each one would turn a drag into a disk-thrashing loop.
 *
 * @param {() => void} fn
 * @param {number} ms
 * @returns {() => void}
 */
function throttle(fn, ms) {
  let timer = null;
  return () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        fn();
      } catch {
        /* geometry memory is a convenience */
      }
    }, ms);
    timer.unref?.();
  };
}

function persistBounds() {
  if (!win || win.isDestroyed() || !WINDOW_FILE) return;
  try {
    mkdirSync(join(WINDOW_FILE, ".."), { recursive: true });
    writeFileSync(WINDOW_FILE, `${JSON.stringify(win.getBounds(), null, 2)}\n`, "utf8");
  } catch {
    /* geometry memory is a convenience */
  }
}

function connectControl() {
  if (!PORT) return;
  controlReady = false;
  const socket = createConnection({ host: "127.0.0.1", port: PORT });
  control = socket;
  socket.setEncoding("utf8");
  socket.write(`${JSON.stringify({ type: "hello", token: TOKEN, pid: process.pid })}\n`);

  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.trim()) continue;
      let message;
      try {
        message = JSON.parse(part);
      } catch {
        continue;
      }
      if (message.type === "focus" && win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      } else if (message.type === "close") {
        app.quit();
      } else if (message.type === "lang") {
        applyLang(message.lang);
      } else if (message.type === "hello-ok") {
        controlReady = true;
        if (gpuReport) {
          send("gpu", gpuReport);
          gpuReport = null;
        }
      }
    }
  });
  socket.on("error", () => {
    control = null;
    controlReady = false;
  });
  socket.on("close", () => {
    control = null;
    controlReady = false;
  });

  const heartbeat = setInterval(() => send("ping", {}), 20_000);
  heartbeat.unref?.();
}

function createWindow() {
  const bounds = initialBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    // The taskbar and Alt-Tab entry must not be Electron's atom, which reads as
    // "some Electron app" rather than as the explorer. The plugin's own folder
    // mark (the one the sidebar button draws) is shipped as a PNG, so the
    // window is identifiable without a build step.
    icon: join(__dirname, "..", "..", "assets", "icon.png"),
    // Frameless: the page draws its own title bar and the tab strip is the drag
    // region. The window's three controls come from the page too (see `mountCaption`
    // in shim.js) rather than from Electron's `titleBarOverlay`: the overlay is
    // styled by native chrome, which cannot read the panel's tokens, and it is
    // drawn by Chromium *above* the page — where it refused to appear at all in
    // this window (it reports `navigator.windowControlsOverlay.visible === true`
    // and then paints nothing). Buttons the page draws are the same buttons in
    // both themes, and the IPC they need was already here.
    frame: false,
    // Opaque, because a transparent window is not composited with the same
    // rounding and shadow as a normal one. The page paints over this immediately;
    // the value is only ever seen if the page fails to load at all.
    backgroundColor: CAPTION_FALLBACK.color,
    webPreferences: {
      // The page and the API share an origin, so the preload carries no API
      // access and no helper token — only the three window actions.
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The preload attaches the Host token to API requests, so the page needs
      // network access to 127.0.0.1 only; nothing else is allowed below.
      webSecurity: true,
      // This window is a monitor: it is opened, left in the background and read
      // later. Chromium throttles timers in a hidden page — the 1 s status pull
      // collapses to about one call a minute — which is precisely the case here,
      // so throttling is off for this window alone (the panel runs inside the
      // DSH page and keeps the browser's normal behaviour).
      backgroundThrottling: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // A popup the page asks for is still a new OS window, which this helper does
    // not manage: send real links to the browser and refuse the rest.
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The window stays on the page it was opened with. Anything else is either a
  // link the user meant to follow (their browser opens it) or an attempt to
  // navigate the window away from the explorer (refused). Navigation within the
  // page's own origin is allowed — that is what a reload does.
  win.webContents.on("will-navigate", (event, url) => {
    if (WEB_PORT && url.startsWith(`http://127.0.0.1:${WEB_PORT}/`)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  // A window that never paints would otherwise stay invisible forever: the
  // page comes from loopback and paints as soon as it has it, so
  // "ready-to-show" is the normal path, and the timer is the fallback for a
  // renderer that failed to paint at all (a syntax error in the page, a
  // GPU-less profile, a Host that is not answering).
  win.once("ready-to-show", () => win?.show());
  const showTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  }, 2500);
  showTimer.unref?.();
  win.webContents.on("did-finish-load", () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  });
  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`session-navigator detached: page failed to load (${code} ${description}) ${url}`);
  });
  // The renderer's own errors are the only signal a broken page gives: without
  // this, a thrown error while the panel's module loads is an empty window and
  // nothing else.
  win.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level >= 2) console.error(`session-navigator detached: ${source}:${line} ${message}`);
  });
  // The Host owns the remembered geometry, but it can only learn it if this
  // process reports it. `bounds` was wired into the launcher from the start and
  // nothing ever sent it, so every reopen landed on the fallback size.
  const reportBounds = throttle(() => {
    if (win && !win.isDestroyed() && !win.isMinimized() && !win.isMaximized()) {
      send("bounds", { bounds: win.getBounds() });
    }
  }, 500);
  win.on("resize", reportBounds);
  win.on("move", reportBounds);
  win.on("close", () => {
    persistBounds();
    if (win && !win.isDestroyed() && !win.isMinimized() && !win.isMaximized()) {
      send("bounds", { bounds: win.getBounds() });
    }
  });
  win.on("closed", () => {
    win = null;
    send("closed", {});
    app.quit();
  });
  // A renderer that crashed or was reloaded leaves a window that exists but
  // cannot hear commands; logging it is the only signal the Host ever gets.
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`session-navigator detached: renderer gone (${details?.reason ?? "unknown"})`);
  });

  // The window is the explorer, not the DSH app: it loads the Host's own page,
  // which is the plugin's module on the plugin's origin. Nothing here navigates
  // to the app itself, so the window cannot show a second DSH.
  const url = pageUrl();
  if (!url) {
    console.error("session-navigator detached: the Host port is unknown, so there is no page to load");
    return;
  }
  win.loadURL(url).catch((error) => {
    console.error(`session-navigator detached: page failed to load: ${error?.message ?? error}`);
  });
}

/**
 * The window's own three controls, and nothing else.
 *
 * The page draws the buttons (shim.js `mountCaption`) because they have to look
 * like the rest of the panel in either theme; this side only performs the action
 * and reports back whether the window ended up maximised, which is what the
 * middle button's glyph follows.
 */
ipcMain.handle("se:window", (_event, action) => {
  if (!win) return null;
  if (action === "minimize") win.minimize();
  else if (action === "maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (action === "close") win.close();
  else if (action === "focus") {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  return { maximized: win.isMaximized() };
});


// The detached window is a monitor: it has to keep asking while it is not the
// focused window. `backgroundThrottling: false` covers the page's own timers;
// these two cover the process-level scheduling the renderer sits under, which
// the page cannot reach from JavaScript.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

// A GPU process that dies is otherwise just a window that stops repainting.
// The Host log gets one line, which is enough to tell a driver problem from a
// page problem; the `DSH_SE_DISABLE_GPU=1` fallback is documented in
// docs/component.md.
app.on("before-quit", () => {
  quitting = true;
});
app.on("child-process-gone", (_event, details) => {
  if (details?.type === "GPU") {
    console.error(`session-navigator detached: gpu process gone (${details.reason ?? "unknown"})`);
    if (!quitting) reportGpu(`gpu-process-${details.reason ?? "gone"}`);
  }
});

app.whenReady().then(() => {
  // The page comes from the Host on loopback; no other origin may ever share its
  // session. Local assets, devtools and loopback are reachable; everything else
  // is cancelled before it leaves.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const allowed =
      url.startsWith("file://") ||
      url.startsWith("devtools://") ||
      url.startsWith("blob:") ||
      url.startsWith("data:") ||
      /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
    callback({ cancel: !allowed });
  });
  connectControl();
  createWindow();
  if (!DISABLE_GPU) {
    // `getGPUFeatureStatus()` reports what Chromium decided, not what it was
    // asked for; giving the window a few seconds is what makes the answer
    // about this machine rather than about a process that has not started.
    setTimeout(() => {
      let status = null;
      try {
        status = app.getGPUFeatureStatus();
      } catch {
        return;
      }
      if (LOG_GPU) console.log(`session-navigator detached: gpu ${JSON.stringify(status)}`);
      if (!gpuUsable(status)) {
        console.error(`session-navigator detached: gpu unusable (${status?.gpu_compositing ?? "unknown"}); asking for software rendering`);
        reportGpu("feature-status", status);
      }
    }, 3000).unref?.();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
