// assets：从 src/index.js 原样切出
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { codedError } from "../store/sidecar.js";

/**
 * The plugin's own directory.
 *
 * `import.meta.dirname` is Node 21+; the URL fallback keeps the module loadable
 * on an older runtime. Both are only ever used to read files, never compared.
 */
const HERE = import.meta.dirname ?? new URL(".", import.meta.url).pathname;
const PLUGIN_ROOT = join(HERE, "..");

/**
 * The detached window's files.
 *
 * Constants, not request parameters: no part of a request decides which file is
 * read, so there is nothing to traverse. The window loads the panel's own module
 * (`lib/client.js`) rather than a second UI — see assets/detached/shim.js.
 */
export const UI_ASSETS = Object.freeze({
  page: join(PLUGIN_ROOT, "..", "assets", "detached", "index.html"),
  stylesheet: join(PLUGIN_ROOT, "..", "assets", "detached", "window.css"),
  shim: join(PLUGIN_ROOT, "..", "assets", "detached", "shim.js"),
  // The picture the window borrows from DSH's own wallpaper plugin.
  wallpaper: join(PLUGIN_ROOT, "..", "assets", "detached", "wallpaper.js"),
  // The one file under lib/: the bundle the build writes from src/client.
  module: join(PLUGIN_ROOT, "..", "lib", "client.js"),
  react: join(PLUGIN_ROOT, "..", "assets", "vendor", "react.production.min.js"),
  reactDom: join(PLUGIN_ROOT, "..", "assets", "vendor", "react-dom.production.min.js"),
  // The window's tab and taskbar icon, and the same file package.json names as
  // the plugin's own icon: one folder mark, drawn once.
  icon: join(PLUGIN_ROOT, "..", "assets", "icon.png"),
  // 悬浮球样式 — one fixed file per face, never a path from the request. The
  // client builds the URL from the same five stems it stores in settings.
  ballFolder: join(PLUGIN_ROOT, "..", "assets", "ball", "folder.png"),
  ballDeepseek: join(PLUGIN_ROOT, "..", "assets", "ball", "deepseek.png"),
  ballChatgpt: join(PLUGIN_ROOT, "..", "assets", "ball", "chatgpt.png"),
  ballClaude: join(PLUGIN_ROOT, "..", "assets", "ball", "claude.png"),
  ballGrok: join(PLUGIN_ROOT, "..", "assets", "ball", "grok.png"),
});

/**
 * The stamp identifying this copy of the client module: size + mtime, base36.
 *
 * Recomputing it per request is cheaper than caching it wrong: the stamp exists
 * to change the moment the file does.
 */
export function clientBuild() {
  try {
    const stat = statSync(UI_ASSETS.module);
    return `${stat.size.toString(36)}${Math.floor(stat.mtimeMs).toString(36)}`;
  } catch {
    return "0";
  }
}

/**
 * The last stamped copy of the client module, per build stamp.
 *
 * The module is 679KB and every panel load asks for it, so the read and the
 * stamping happen once per build rather than once per request. The stamp is
 * size + mtime: a rebuilt file misses the cache, which is the same event that
 * makes a running panel notice it is out of date.
 */
let clientModuleCache = { stamp: "", body: "" };

/**
 * Serve the client module with its build stamp baked in.
 *
 * The stamp has to travel *inside* the module: only the running copy knows
 * which version of the code it is, and comparing that against the host's answer
 * is how a panel that survived an update can notice it is out of date.
 */
export async function serveClientModule(res) {
  const stamp = clientBuild();
  let stamped = stamp !== "0" && clientModuleCache.stamp === stamp ? clientModuleCache.body : "";
  if (!stamped) {
    let body;
    try {
      body = await readFile(UI_ASSETS.module, "utf8");
    } catch {
      throw codedError("ui-asset-missing", `缺少独立窗口需要的文件：${UI_ASSETS.module}`);
    }
    stamped = `globalThis.__SE_BUILD__ = ${JSON.stringify(stamp)};\n${body}`;
    clientModuleCache = { stamp, body: stamped };
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(stamped)));
  res.setHeader("Cache-Control", "no-store");
  res.end(stamped);
}

/**
 * Send one of the plugin's own files, unmodified.
 *
 * `no-store` on purpose: the panel and the window must run the same code, and a
 * cached copy of one after a plugin update is exactly the drift this whole
 * arrangement exists to remove.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {string} file absolute path, from UI_ASSETS only
 * @param {string} type content type
 * @returns {Promise<void>}
 */
export async function serveAsset(res, file, type) {
  let body;
  try {
    body = await readFile(file);
  } catch {
    throw codedError("ui-asset-missing", `缺少独立窗口需要的文件：${file}`);
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Length", String(body.byteLength));
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}
