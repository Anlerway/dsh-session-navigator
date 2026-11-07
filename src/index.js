/**
 * dsh-session-navigator — host half.
 *
 * A Cordis plugin loaded as an out-of-tree bundle row (see cordis.patch.yml).
 * It owns the server side of the session explorer: a single `/session-navigator/api`
 * prefix route registered on the DSH webserver, plus the sidecar store that
 * lives in a directory next to `~/.dsh` (see src/paths.js).
 *
 * Scope of this file: service wiring, route dispatch, capability probing and
 * error mapping. Business logic lives in `domain/`, data access in `sources/`
 * and `store/`; nothing else is invented here.
 *
 * The plugin declares `webServer` as its only hard dependency: a profile
 * without an HTTP server has no browser half either, so there is nothing to do
 * there and the loader should skip the row entirely.
 */

import { join } from "node:path";
import { getService, capabilities as probeCapabilities } from "./capabilities.js";
import { componentManagerFor } from "./component/manager.js";
import { createDetachedController } from "./detached/launcher.js";
import { tagVocabulary } from "./domain/annotations.js";
import { normalizeSettings } from "./domain/settings.js";
import { dshHome } from "./dsh/home.js";
import { statusFor } from "./errors.js";
import { createBridge } from "./host/bridge.js";
import { readNotes } from "./host/changelog.js";
import { migrateFlagsToShortcuts } from "./host/flags.js";
import { reconcileMoves } from "./host/move.js";
import { readNotesSeen } from "./host/notes-seen.js";
import { createPendingDrafts } from "./host/pending-drafts.js";
import { createSessionSync } from "./host/session-sync.js";
import { createStatusBoard } from "./host/status-board.js";
import { createStorageWatch } from "./host/storage-watch.js";
import { createSummarizer } from "./host/summarize.js";
import { createThemeStore } from "./host/theme.js";
import { reconcileTrash } from "./host/trash.js";
import { pluginVersion } from "./host/update.js";
import { fail, ok, readJsonBody, routeOf, send } from "./http.js";
import { normalizeLang } from "./lang.js";
import { dataPaths, ensureDataDir, resolveDataDir } from "./paths.js";
import { createIndexBuilder, log, readOverlay, runningSessionIds, searchSessionContent, sessionForSummary } from "./plugin-runtime.js";
import { UI_ASSETS, clientBuild, serveAsset, serveClientModule } from "./routes/assets.js";
import { announceWrite, assertSameOrigin, errorCodeOf } from "./routes/dispatch-support.js";
import { expectedRevision, knownDirectory, newId, sameTokens, shortcutSessionTargets } from "./routes/shared.js";
import { createContentIndex } from "./sources/content.js";
import { createReader } from "./sources/reader.js";
import { openDocuments } from "./store/documents.js";
import { codedError } from "./store/sidecar.js";
import { libraryRoutes } from "./routes/library.js";
import { foldersRoutes } from "./routes/folders.js";
import { layoutRoutes } from "./routes/layout.js";
import { settingsRoutes } from "./routes/settings.js";
import { summariesRoutes } from "./routes/summaries.js";
import { releaseRoutes } from "./routes/release.js";
import { maintenanceRoutes } from "./routes/maintenance.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { toolsRoutes } from "./routes/tools.js";
import { bridgeRoutes } from "./routes/bridge.js";
import { detachedRoutes } from "./routes/detached.js";

export const name = "dsh-session-navigator";
// The plugin needs the HTTP server and nothing else. The detached window no
// longer loads the DSH app (it has its own local page and talks to the API
// through the helper preload), so the `connection` service is not required —
// asking for it would make the plugin refuse to load on a profile that has none.
export const inject = ["webServer"];

/**
 * `:name` segments are decoded into `req.params` before the handler runs, so
 * path parameters reach a handler through the request and never as an extra
 * argument.
 *
 * @typedef {(api: PluginApi, req: any, res: any, url: URLSearchParams) => Promise<any> | any} RouteHandler
 */

/**
 * @param {any} ctx
 */
export function apply(ctx) {
  const webServer = getService(ctx, "webServer");
  if (!webServer || typeof webServer.register !== "function") return;

  // The data directory is mutable: a completed migration moves it, and every
  // later request must read and write the new location without a restart.
  let dataDir = resolveDataDir();
  let paths = dataPaths(dataDir);
  let documents = openDocuments(paths);

  const openAt = (dir) => {
    const created = ensureDataDir(dir);
    if (created.created) log(ctx, "info", `data directory created at ${dir}`);
    dataDir = dir;
    paths = dataPaths(dir);
    documents = openDocuments(paths);
  };
  openAt(dataDir);

  // ── Electron component + detached window ─────────────────────────────────
  // Both are optional: the plugin is fully usable without the component, and
  // `POST /detached/open` is refused (with a reason) until it is ready.
  const componentFor = (dir) => componentManagerFor(dir, { ctx });
  let component = componentFor(dataDir);
  let detached = null;
  // The panel and the detached window are two documents that cannot call each
  // other; this is the one place they can meet (see src/host/bridge.js).
  const bridge = createBridge();
  // The newest session-state snapshot the panel announced. The rows are the
  // panel's knowledge (only DSH's renderer has `uiSession`), but keeping the last
  // one here is what lets the Host answer a window on its own — see
  // src/host/status-board.js for the two lateness bugs that made this necessary.
  const statusBoard = createStatusBoard();
  // The live palette, pushed by the panel and read by the detached window.
  const theme = createThemeStore();

  const detachedFor = () => {
    if (detached) return detached;
    detached = createDetachedController({
      dataDir,
      // `.cjs` on purpose: this package sets "type": "module", so a `.js`
      // file is loaded as ESM and the helper's `require("electron")` throws
      // "require is not defined in ES module scope" before any window opens.
      helperMain: join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "detached", "main.cjs"),
      runtime: async () => {
        const status = await component.status();
        // `component.binary` resolves against the *installed* runtime name (or
        // the borrowed one); `component.paths.binary` is the un-stamped default
        // and does not exist once an install has published into a stamped
        // directory. A borrowed runtime additionally needs its app passed
        // explicitly, because that tree belongs to another plugin and nothing may
        // be written into it.
        return {
          binary: component.binary,
          ready: status.phase === "ready",
          appDir: status.borrowed ? component.paths.helperApp : null,
          borrowed: status.borrowed ?? null,
        };
      },
      webPort: () => (typeof webServer.port === "number" ? webServer.port : Number(process.env.DSH_WEB_PORT ?? 0)),
      /**
       * Window → Host reports are forwarded to the panel as bridge commands.
       *
       * The helper owns the OS window; whether it was closed by the user, or
       * whether it is still loading, is knowledge only that process has. Passing
       * it through the same bus the window already publishes on means the panel
       * needs no second channel to learn it.
       */
      onEvent: (event) => {
        if (event === "closed") bridge.publish("window-closed", null);
        else if (event === "hello") bridge.publish("window-open", null);
      },
      log: (level, message) => log(ctx, level === "warn" ? "warn" : "info", message),
      profileKey: dataDir,
    });
    return detached;
  };

  /** @type {PluginApi} */
  const api = {
    ctx,
    get dataDir() {
      return dataDir;
    },
    get paths() {
      return paths;
    },
    get documents() {
      return documents;
    },
    /** A migration in flight, or null. Writes are refused while it is set. */
    migration: null,
    /** Point the plugin at another directory (used by the migration). */
    reopen: (dir) => {
      openAt(dir);
      // The component lives inside the data directory, so a migration moves it
      // too: the manager has to be rebuilt for the new root.
      component = componentFor(dir);
      detached = null;
    },
    /** Electron component state machine (install / remove / status). */
    get component() {
      return component;
    },
    /** Detached window controller (spawn / focus / close). */
    get detached() {
      return detachedFor();
    },
    /** The panel ↔ window command bus. */
    bridge,
    /** The last session states announced through that bus. */
    statusBoard,
    /** The panel's last reported palette (see /theme). */
    theme,
    /**
     * The capability snapshot, async because the component phase is.
     *
     * `component.snapshot` is the in-memory record, which starts as `absent`
     * and is only refreshed by `status()` (it reconciles against the disk).
     * Reading the snapshot here answered `absent` for every `/bootstrap` even
     * when the runtime was installed and working, so the panel greyed out
     * 独立窗口 with "没有Electron 组件" on a machine that had one.
     */
    capabilities: async () => {
      const status = await component.status();
      return probeCapabilities(ctx, {
        dataDir,
        component: status.phase,
      });
    },
    reader: createReader({
      dshHome: () => dshHome(),
      // Live services are optional: `getService` is re-asked on every read, so
      // a row that appears after this plugin was applied is still picked up.
      workspaceService: () => getService(ctx, "workspaceRegistry") ?? getService(ctx, "workspaces"),
      runningIds: () => runningSessionIds(ctx),
      // The sidecar decorates the derived tree: user folders, placements and the
      // trash index. A broken document degrades to "no folders, empty trash" in
      // the reader rather than failing the whole listing.
      overlay: () => readOverlay(documents),
    }),
    /**
     * 会话内容 index: the only state the panel cannot derive from the
     * listing. Lazy and bounded, so a panel that never searches content never
     * reads a log.
     *
     * The cache file is derived and disposable, so it is keyed off the
     * live `paths` getter rather than a snapshot taken at startup: a data
     * directory migration moves it with everything else. It is written
     * unconditionally.
     */
    content: createContentIndex({
      store: {
        get path() {
          return paths.contentIndex;
        },
        get tmpDir() {
          return paths.tmpDir;
        },
      },
    }),
    /**
     * The background half of 搜索索引设置: 允许空闲时自动建立 spends a slice
     * of the build between requests, and 重新建立 runs the same loop on demand.
     * One builder owns both so two builds can never read the same logs twice.
     */
    indexBuilder: createIndexBuilder(),
  };

  /**
   * AI 字段.
   *
   * Deliberately *not* in the object literal above: it needs `api` itself (the
   * reader snapshot for a session's title and log path, the annotations for its
   * note and tags), and a literal cannot refer to the binding it is defining.
   *
   * `getLlm` is a getter and not a captured value for the same reason the
   * workspace service is: the llm service may be activated after this plugin,
   * and a plugin that resolved it once at load would answer "模型服务不可用"
   * forever on a profile that has it.
   */
  api.summarizer = createSummarizer({
    getLlm: () => getService(ctx, "llm"),
    // The GUI's own model catalogue. Reading it here means 设置页 offers the
    // routes the rest of DSH offers — same names, same effort ids — instead of
    // a second opinion assembled in this plugin. Optional: a profile without
    // the session controller falls back to walking the llm registry.
    getSessionController: () => getService(ctx, "sessionController"),
    // Both closures read `documents`, which is reassigned by a data directory
    // migration: a captured sidecar would keep writing to the old file.
    summaries: {
      read: () => documents.summaries.read(),
      mutate: (mutator, revision) => documents.summaries.mutate(mutator, revision),
    },
    settings: async () => normalizeSettings(await documents.settings.read()),
    // The words this user already files sessions under: shown to the model so it
    // reuses an existing tag instead of inventing a synonym.
    existingTags: async () => tagVocabulary(await documents.annotations.read()).map((row) => row.tag),
    session: (id) => sessionForSummary(api, id),
    log: (level, message) => log(ctx, level === "warn" ? "warn" : "info", message),
  });

  /**
   * Keep the panel in step with DSH.
   *
   * DSH creates, retitles, archives and runs sessions on its own; the panel is
   * only a view of that state, so without this it kept yesterday's list, kept
   * 进行中 on a finished turn, and needed a reopen to show a new title. Built
   * after `api` because a structural event invalidates `api.reader`.
   */
  const sync = createSessionSync({
    ctx,
    bridge,
    reader: api.reader,
    runningIds: () => runningSessionIds(ctx),
    log: (level, message) => log(ctx, level === "warn" ? "warn" : "info", message),
  });
  ctx.effect?.(() => () => sync.dispose(), "session-navigator: session sync");

  // Two writes announce nothing, so this is the only way to hear them: 归档 /
  // 置顶 rewrites `storages/workspace.json` without publishing (a session
  // archived in DSH's own sidebar stayed in the panel's 未归档 group), and
  // deleting a conversation in DSH's sidebar removes its directory without a
  // `session/disposed` (that event belongs to the kernel; a session nobody runs
  // never reaches it, so the panel kept a deleted row). One stat of the registry
  // and one `readdir` of `sessions/` every few seconds cover both holes without
  // walking the session tree.
  const storageWatch = createStorageWatch({
    dshHome: () => dshHome(),
    bridge,
    runningIds: () => runningSessionIds(ctx),
    // The reader walks the same tree this watcher just found changed. Dropping
    // its cache here — rather than waiting for the 1.5 s TTL — is what makes the
    // reload this event triggers read the new layout, so a session deleted in
    // DSH's sidebar disappears on the first push instead of the second.
    invalidate: () => api.reader.invalidate(),
    log: (level, message) => log(ctx, level === "warn" ? "warn" : "info", message),
  });
  ctx.effect?.(() => () => storageWatch.dispose(), "session-navigator: storage watch");

  /**
   * 新建会话 inside a folder.
   *
   * DSH opens a draft at the workspace root: its sidebar has no level below a
   * workspace, and a folder is this plugin's idea. The panel therefore asks for
   * the intent *before* it asks DSH for the draft, and the session that appears
   * in that workspace afterwards is filed into the folder — the only order that
   * works, because DSH decides the session id, and a session the user opened in
   * DSH's own sidebar must never be mistaken for the one a click just made.
   */
  api.pendingDrafts = createPendingDrafts({
    readSnapshot: () => api.reader.snapshot({}),
    place: async (sessionId, parent) => {
      await api.documents.tree.mutate((draft) => {
        draft.sessionPlacement ??= {};
        draft.sessionPlacement[sessionId] = parent;
      });
      // This write answers no request the document made, so nothing announces
      // it: the click that armed the intent is long gone, and a window in its
      // own process never saw the fetch at all. One event, and both documents
      // re-read the bootstrap they draw from.
      try {
        api.bridge.publish("sessions-changed", {
          reason: "placed",
          refresh: true,
          structural: false,
          running: [...runningSessionIds(ctx)],
        });
      } catch {
        /* a bus that is down must not undo a placement that landed */
      }
    },
    log: (level, message) => log(ctx, level === "warn" ? "warn" : "info", message),
  });
  ctx.effect?.(() => () => api.pendingDrafts.dispose(), "session-navigator: pending drafts");

  // A crash between "index entry written" and "payload moved" is reconciled
  // here: the entry is promoted when its payload arrived, dropped when it did
  // not. Best effort — a failure must never stop the plugin from serving.
  reconcileTrash(api).catch(() => {});
  reconcileMoves(api).catch(() => {});
  // 收藏 / 待办 were annotation flags before they were shortcut containers.
  // One-way migration, idempotent, best effort: see src/host/flags.js.
  migrateFlagsToShortcuts(api, newId).catch(() => {});

  // A component uninstall that could not delete its runtime (a scanner, the
  // search indexer, a helper that had not finished exiting) left the paths on a
  // pending list. This is the first moment they can be removed: the process that
  // held them is the one that just exited. Best effort, and deliberately not
  // awaited — the plugin must serve requests immediately.
  component
    .sweep()
    .then((result) => {
      if (result?.removed?.length > 0) {
        log(ctx, "info", `Electron component: removed ${result.removed.length} leftover director(ies) from a previous uninstall`);
      }
    })
    .catch(() => {});

  const dispose = webServer.register({
    kind: "prefix",
    path: "/session-navigator/api",
    handler: (req, res) => handle(api, req, res),
  });

  if (typeof dispose === "function") {
    ctx.effect?.(() => dispose, "session-navigator: api routes");
  }

  // The helper is a child process: if the plugin is disabled or reloaded while
  // the detached window is open, nothing else would stop it, and the window
  // would outlive the code that owns it. `stop()` existed but was never called.
  ctx.effect?.(() => () => {
    try {
      api.detached.stop();
    } catch {
      /* the controller may never have been created */
    }
  }, "session-navigator: detached helper");
}

/**
 * The route table: the handlers live in src/routes/, grouped by the part of the
 * panel each serves; the keys stay "METHOD /path" without the API prefix.
 *
 * Three entries stay here on purpose: test/detached-window.test.mjs and
 * test/notes-gate.test.mjs read this file as text and pin their bodies.
 *
 * @type {Record<string, RouteHandler>}
 */
const ROUTES = {
  ...libraryRoutes,
  ...foldersRoutes,
  ...layoutRoutes,
  ...settingsRoutes,
  ...summariesRoutes,
  ...releaseRoutes,
  ...maintenanceRoutes,
  ...sessionsRoutes,
  ...toolsRoutes,
  ...bridgeRoutes,
  ...detachedRoutes,


  /**
   * The theme DSH is using right now, as CSS custom properties.
   *
   * A `file://` window has no access to the app's stylesheet, so every
   * `--dsw-alias-*` token there falls back to a hard-coded dark palette. The
   * panel *does* see the live tokens (it is a child of the app document), so it
   * reports them here on request and the window applies them to its own root.
   *
   * The token list is fixed on purpose: this route exists to theme one window,
   * not to expose an arbitrary CSS scrape of the host UI.
   */
  "GET /theme": async (api, req) => {
    return api.theme.snapshot();
  },


  /**
   * Record the panel's live theme so /theme can answer for the window.
   *
   * Stored in memory: a theme is per-process state (DSH reloads it from its own
   * settings on start), and persisting it would let a stale palette outlive the
   * theme that produced it.
   */
  "POST /theme": async (api, req) => {
    const before = api.theme.snapshot();
    const next = api.theme.record(req.body ?? {});
    // The window reads the palette once, when it loads. A flip in DSH has to be
    // announced or a window that is already on screen keeps the old colours for
    // as long as it stays open. Announced only when the palette really moved:
    // the panel reports on mount and on every class/style mutation of the
    // document element, and a repaint per report would be a round trip each.
    if (!before || before.mode !== next.mode || !sameTokens(before.tokens, next.tokens)) {
      api.bridge.publish("theme-changed", { mode: next.mode });
    }
    return next;
  },


  /**
   * The detached window.
   *
   * The window is not a `file://` page with its own UI: it runs the panel's own
   * module — this page, the shim that stands in for DSH while that module mounts,
   * and a stylesheet that turns the floating overlay into a whole window. One UI,
   * two surfaces.
   *
   * Same-origin is the point. A `file://` page cannot import the plugin's
   * module, cannot fetch the API without a token, and gets a CSP of its own; a
   * page served from here is the same origin as `/session-navigator/api`, so the
   * module's existing `fetch("/session-navigator/api/…")` calls work unchanged.
   *
   * These are the only routes that answer with something other than the JSON
   * envelope: each writes its own body, and `handle()` leaves a finished
   * response alone.
   */
  "GET /ui": async (api, req, res) => serveAsset(res, UI_ASSETS.page, "text/html; charset=utf-8"),

  "GET /ui/window.css": async (api, req, res) => serveAsset(res, UI_ASSETS.stylesheet, "text/css; charset=utf-8"),

  "GET /ui/shim.js": async (api, req, res) => serveAsset(res, UI_ASSETS.shim, "text/javascript; charset=utf-8"),

  "GET /ui/client.js": async (api, req, res) => serveClientModule(res),


  /**
   * The build stamp of the client module currently on disk.
   *
   * A panel that was loaded before the plugin was updated keeps running the old
   * module until the page reloads — and a stale panel looks exactly like a
   * broken one: it posts to routes that behave differently and reports
   * what the old code believed. The client compares this against the stamp
   * baked into its own copy and offers a reload when they differ.
   */
  "GET /version": async () => ({ build: clientBuild(), version: pluginVersion() }),

  "GET /ui/react.js": async (api, req, res) => serveAsset(res, UI_ASSETS.react, "text/javascript; charset=utf-8"),

  "GET /ui/react-dom.js": async (api, req, res) => serveAsset(res, UI_ASSETS.reactDom, "text/javascript; charset=utf-8"),

  "GET /ui/icon.png": async (api, req, res) => serveAsset(res, UI_ASSETS.icon, "image/png"),


  /**
   * 更新说明 — what changed since the last published version, as blocks.
   *
   * The text comes from a document (更新说明.md in a checkout, CHANGELOG.md in
   * the package), never from a string in this plugin's source: see
   * src/host/changelog.js for why, and src/domain/notes.js for the small subset
   * of markdown that becomes blocks.
   *
   * `version` rides along so the client can decide "already read this one?"
   * without a second request: the announcement fires at startup, and a startup
   * that only needs to know the version should not scan sessions to learn it.
   * `seen` is the other half of that decision — the version already delivered,
   * recorded here rather than in the page; see src/host/notes-seen.js for why.
   */
  "GET /release-notes": async (api) => ({
    ...(await readNotes()),
    version: pluginVersion(),
    seen: await readNotesSeen(api.paths.notesSeen),
  }),


  /**
   * List Electron runtimes other plugins already have, so one can be borrowed
   * instead of downloading 150 MB again.
   *
   * Read-only and unauthenticated-by-nature (it is a GET behind the same origin
   * check every other route uses): it lists directories under the DSH home and
   * reads the version file Electron ships, nothing else.
   */
  "GET /component/scan": async (api) => api.component.scan({ home: dshHome() }),


  /**
   * Open (or focus) the detached window.
   *
   * `lang` is the language the caller's DSH is drawing in. The window is a
   * separate process on its own document, so it cannot ask DSH for that — the
   * panel is the only side that knows, and this is the request where it says so.
   * A code this plugin cannot draw in (or none at all) means 中文, which is also
   * the window's own default.
   */
  "POST /detached/open": async (api, req) => {
    const status = await api.component.status();
    if (status.phase !== "ready") {
      throw codedError("component-not-installed", "download the Electron component before opening a detached window");
    }
    const result = await api.detached.open({ lang: normalizeLang(req.body?.lang) || "zh" });
    return { open: true, ...result };
  },
};

/**
 * Compile a route pattern into a matcher. Patterns may carry `:name` segments;
 * everything else is literal.
 *
 * @param {string} pattern e.g. `PATCH /folders/:id`
 * @returns {{ method: string, segments: string[], match: (path: string) => Record<string, string> | null }}
 */
function compileRoute(pattern) {
  const [method, path] = pattern.split(" ");
  const segments = path.split("/").filter(Boolean);
  return {
    method,
    segments,
    match(candidate) {
      const parts = candidate.split("/").filter(Boolean);
      if (parts.length !== segments.length) return null;
      /** @type {Record<string, string>} */
      const params = {};
      for (let index = 0; index < segments.length; index += 1) {
        const expected = segments[index];
        const actual = parts[index];
        if (expected.startsWith(":")) {
          try {
            params[expected.slice(1)] = decodeURIComponent(actual);
          } catch {
            // `%` that is not an escape (`/folders/%zz`) throws URIError. Treat the
            // route as unmatched: a malformed URL is a 404 from this table, not an
            // unhandled rejection that escapes the handler's try/catch.
            return null;
          }
          continue;
        }
        if (expected !== actual) return null;
      }
      return params;
    },
  };
}

const COMPILED = Object.entries(ROUTES).map(([pattern, handler]) => ({
  ...compileRoute(pattern),
  handler,
}));

/**
 * Dispatch one request against the route table.
 *
 * @param {PluginApi} api
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
async function handle(api, req, res) {
  const route = routeOf(req.url);
  if (!route) return fail(res, 404, "bad-request", "unknown route");

  const method = (req.method ?? "GET").toUpperCase();
  /** @type {any} */
  let matched = null;
  /** @type {Record<string, string>} */
  let params = {};
  for (const entry of COMPILED) {
    if (entry.method !== method) continue;
    const result = entry.match(route.path);
    if (result) {
      matched = entry;
      params = result;
      break;
    }
  }
  if (!matched) return fail(res, 404, "bad-request", `no route for ${method} ${route.path}`);

  try {
    // A migration rewrites every sidecar; letting a write through mid-move
    // would either be lost in the copy or resurrect the old directory.
    if (api.migration && method !== "GET" && method !== "HEAD" && !route.path.startsWith("/datadir")) {
      throw codedError("migration-in-progress", "a data directory migration is running");
    }
    if (method !== "GET" && method !== "HEAD") {
      assertSameOrigin(req);
      /** @type {any} */ (req).body = await readJsonBody(req);
    }
    /** @type {any} */ (req).params = params;
    const result = await matched.handler(api, req, res, route.query);
    // A streaming route (SSE) has already taken over the response: writing an
    // envelope after its headers would corrupt the event stream.
    if (res.writableEnded || res.headersSent) return;
    ok(res, result);
    announceWrite(api, route.path, method);
    // The panel just got what it asked for; if 允许空闲时自动建立 is on, this is
    // the quiet moment to spend a slice of the 会话内容 index. The call
    // is free when a slice is already queued or the switch is off — the switch
    // itself is checked inside the builder, so no settings read happens here.
    api.indexBuilder.nudge(api);
  } catch (err) {
    const code = errorCodeOf(err);
    const status = statusFor(code);
    log(api.ctx, "warn", `${method} ${route.path} failed: ${err?.message ?? err}`);
    if (!res.writableEnded) fail(res, status, code, String(err?.message ?? err));
  }
}

// `statusFor` used to be a 52-case switch here: one line per code, edited by
// hand whenever a code was added — and the one time the line was not added, a
// 404 was answered as a 500. The mapping is a table now (src/errors.js), where
// a new code is one row instead of one more case, imported at the top of this
// file so the dispatcher and the panel read the same status.

// Re-exported for tests: the envelope helpers, the two halves of the revision
// contract, and the dispatcher itself. `handle` is here because the error
// mapping only exists on its catch path — the same throw is a 400 or a 500
// depending on one table row — and test/routes-contract.test.mjs drives every
// route through the real dispatcher to pin which. Everything exported is a pure
// function of its arguments (plus a fake req/res), so testing needs no server.
export { ROUTES, expectedRevision, handle, send, statusFor };

export { announceWrite, createIndexBuilder, knownDirectory, searchSessionContent, shortcutSessionTargets };
