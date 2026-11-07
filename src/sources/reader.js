/**
 * dsh-session-navigator — the read pipeline behind `/bootstrap` and `/sessions`.
 *
 * Three sources, one merged answer (see src/domain/sessions.js for the merge
 * rules). This module owns the I/O and the caching policy:
 *
 *   L2 headers  — the expensive-but-truthful path: directory walk + one zstd
 *                 frame per session. Cached in-process and invalidated by a
 *                 short TTL, because a listing that re-decodes every header on
 *                 every keystroke would be a visible stall.
 *   L1 cache    — one small JSON per session, and the whole directory is needed
 *                 on every request. It is the most volatile source (DSH rewrites
 *                 it as the user types), so it is cached by file size+mtime
 *                 rather than by time: a rewritten file is always re-read, an
 *                 untouched one never is (see sources/projcache.js).
 *   registry    — live service when available, durable file otherwise.
 *
 * The TTL is deliberately short: correctness of "did a new session appear" must
 * not lag more than a second or two behind the sidebar, while still collapsing
 * a burst of requests into one walk.
 */

import { FIXED_NODES } from "../constants.js";
import { buildSessionView } from "../domain/sessions.js";
import { shortcutTargetsIn } from "../domain/shortcuts.js";
import { buildAutoTree } from "../domain/tree.js";
import { readAllHeaders } from "../sources/heads.js";
import { readLogFacts } from "../sources/logfacts.js";
import { projcacheDir, readProjcache } from "../sources/projcache.js";
import { readWorkspaceFile, readWorkspaceService } from "../sources/workspaces.js";

/** How long a header scan stays fresh, in milliseconds. */
const HEADER_TTL_MS = 1500;

/** How many log tails are classified at once (same bound as the header walk). */
const LOG_READ_CONCURRENCY = 8;

/**
 * @typedef {object} Snapshot
 * @property {object[]} sessions merged, sorted session list
 * @property {object} view the merged view (for scoped queries)
 * @property {any} tree derived tree, built on first read
 * @property {any} registry normalized registry
 * @property {object} stats counters (source mix, timings)
 * @property {number} scannedAt epoch ms of the header scan behind this snapshot
 */

/**
 * Create the reader. One instance per plugin instance.
 *
 * @param {object} options
 * @param {() => string} options.dshHome resolves the DSH home each call, so a
 *   relocation is picked up without a restart
 * @param {() => any} [options.workspaceService] live `ctx.workspaceRegistry`
 * @param {() => Set<string>} [options.runningIds] live session ids
 * @param {() => Promise<{ userTree: object | null, trashedIds: Set<string>, listSettings?: object | null }>} [options.overlay]
 *   the sidecar state that decorates the derived tree: user folders, placements,
 *   the trash index, and the view settings that decide which sessions are hidden.
 *   Async because the documents live on disk.
 * @param {number} [options.ttlMs]
 */
export function createReader(options) {
  const ttlMs = options.ttlMs ?? HEADER_TTL_MS;

  /** @type {{ headers: Map<string, object>, at: number } | null} */
  let headerCache = null;
  /** @type {Promise<Map<string, object>> | null} */
  let inflight = null;
  /**
   * Single-flight for the projection-cache directory: two requests arriving
   * together must stat each file once, not twice. Keyed by home, because the
   * user can point the plugin at another DSH home mid-flight.
   *
   * @type {{ home: string, run: Promise<Map<string, object>> } | null}
   */
  let projcacheInflight = null;
  /**
   * Single-flight for the session-world half of a snapshot (headers, projection
   * cache, registry, log facts). See `baseData` for what is and is not shared.
   *
   * @type {{ home: string, run: Promise<{ headerMap: Map<string, object>, cacheMap: Map<string, object>, registry: any, logFacts: Map<string, any> }> } | null}
   */
  let baseInflight = null;
  /**
   * Bumped by `invalidate()`. A walk that started before the bump must not
   * publish its result: it read the tree before the change that invalidated it,
   * and writing it back would resurrect the state the caller just dropped.
   */
  let epoch = 0;

  /**
   * Header map, reusing the last scan when it is still fresh.
   *
   * Concurrent callers share one walk: a burst of requests must not multiply
   * the filesystem cost.
   *
   * @param {boolean} refresh force a rescan
   * @returns {Promise<Map<string, object>>}
   */
  async function headers(refresh) {
    const now = Date.now();
    if (!refresh && headerCache && now - headerCache.at < ttlMs) return headerCache.headers;
    if (inflight) {
      // A refresh must not join a walk that began before the write it is
      // refreshing for; let the older walk finish, then read the tree again.
      if (!refresh) return inflight;
      await inflight.catch(() => {});
    }
    const startedEpoch = epoch;
    /** @type {Promise<Map<string, object>>} */
    const walk = readAllHeaders(options.dshHome())
      .then((headers) => {
        if (startedEpoch === epoch) headerCache = { headers, at: Date.now() };
        return headers;
      })
      .finally(() => {
        if (inflight === walk) inflight = null;
      });
    inflight = walk;
    return walk;
  }

  /**
   * The session-world half of a snapshot: header scan, projection cache,
   * registry, per-log facts.
   *
   * This is the expensive part and it does not depend on the sidecar overlay.
   * When the panel opens, `/bootstrap`, `/summaries` and one summary lookup per
   * running session arrive together, and each used to repeat the same walk; now
   * they join one read.
   *
   * Only a read that is still running is shared, never a finished one. The
   * overlay changes without `invalidate()` — a sidecar document write does not
   * bump `epoch` — so handing a completed base to a later caller would answer it
   * with the tree as it was before that write. Callers that overlap were going
   * to see that state anyway; a caller that arrives later gets a fresh read.
   *
   * @param {string} home
   * @param {boolean} refresh
   */
  async function baseData(home, refresh) {
    if (baseInflight) {
      if (baseInflight.home === home && !refresh) return baseInflight.run;
      if (refresh) {
        // A refresh must not slide under a read that began before the change it
        // is refreshing for; let that read finish, then start its own.
        await baseInflight.run.catch(() => {});
      }
    }
    /** @type {{ home: string, run: Promise<any> | null }} */
    const entry = { home, run: null };
    entry.run = (async () => {
      const [headerMap, cacheMap, registry] = await Promise.all([
        headers(refresh),
        projcacheOf(home),
        readRegistry(),
      ]);
      const logFacts = await logFactsOf(headerMap);
      return { headerMap, cacheMap, registry, logFacts };
    })().finally(() => {
      if (baseInflight === entry) baseInflight = null;
    });
    baseInflight = entry;
    return entry.run;
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.refresh] bypass the header TTL
   * @returns {Promise<Snapshot>}
   */
  async function snapshot(opts = {}) {
    const startedAt = performance.now();
    const home = options.dshHome();
    // Read the overlay per call, never joined: it is the one input that changes
    // without a reader epoch bump, and reading it is cheap.
    const overlayRead = safeOverlay();
    const { headerMap, cacheMap, registry, logFacts } = await baseData(home, opts.refresh === true);
    const overlay = await overlayRead;

    const running = safeRunning();
    const trashedIds = overlay.trashedIds;
    const view = buildSessionView({
      headers: headerMap,
      projcache: cacheMap,
      registry,
      running,
      logFacts,
      annotations: overlay.annotations,
    });
    // 收藏 / 待办 are shortcut containers, so membership *is* the shortcut: the
    // flags are derived here, once, before anything reads them. Doing it after
    // the session view but before the tree keeps the counts, the list and the
    // detail header on the same answer, and keeps the sidecar's old
    // annotation flags from being a second, disagreeing source.
    const favorites = shortcutTargetsIn(overlay.userTree?.shortcuts, FIXED_NODES.favorites);
    const todos = shortcutTargetsIn(overlay.userTree?.shortcuts, FIXED_NODES.todos);
    for (const session of view.sessions) {
      session.favorite = favorites.has(session.id);
      session.todo = todos.has(session.id);
    }
    // Trashed sessions are removed from the live view: they belong to the trash
    // node and must not be counted (or searched) as if they were still there.
    const live = view.sessions.filter((session) => !trashedIds.has(session.id));
    const trashed = view.sessions.filter((session) => trashedIds.has(session.id));
    /** @type {any} */
    let tree = null;
    /**
     * Built on first read. Only the bootstrap, folder and layout routes look at
     * the tree; the summary poll and the per-session lookups take
     * `sessions`/`view` and used to pay for it anyway — 1.5 ms and 134 KB of
     * nodes per snapshot at 5 000 sessions.
     */
    const treeOf = () =>
      (tree ??= buildAutoTree({
        registry,
        sessions: view.sessions,
        trashedIds,
        userTree: overlay.userTree,
        // Counts describe rows, and the rows are the ones the list renders: a
        // session hidden by 过滤空会话 is not counted either.
        listSettings: overlay.listSettings,
      }));

    return {
      sessions: live,
      trashed,
      view: { sessions: view.sessions, live, trashed },
      get tree() {
        return treeOf();
      },
      registry,
      annotations: overlay.annotations,
      stats: {
        ...view.stats,
        trashed: trashed.length,
        projcacheEntries: cacheMap.size,
        workspaces: registry?.workspaceIds.length ?? 0,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      },
      scannedAt: headerCache?.at ?? Date.now(),
    };
  }

  /**
   * The projection cache for one DSH home, shared by concurrent callers.
   *
   * The read itself is cheap once the per-file cache in sources/projcache.js is
   * warm — it is 99 stats — but a burst of requests would still repeat it, so
   * they join one read instead.
   *
   * @param {string} home
   * @returns {Promise<Map<string, object>>}
   */
  function projcacheOf(home) {
    if (projcacheInflight && projcacheInflight.home === home) return projcacheInflight.run;
    const entry = { home, run: null };
    entry.run = readProjcache(projcacheDir(home)).finally(() => {
      if (projcacheInflight === entry) projcacheInflight = null;
    });
    projcacheInflight = entry;
    return entry.run;
  }

  /**
   * Classify every log: has it ever started a turn?
   *
   * This is the only part of a snapshot that opens a log at all, so it is
   * bounded twice: a fixed worker count, and a per-log cache keyed by
   * size+mtime (`sources/logfacts.js`). In steady state a listing therefore
   * reads nothing — only the session whose turn is running has a new mtime.
   *
   * @param {Map<string, any>} headerMap
   * @returns {Promise<Map<string, { turnStart: boolean | null }>>}
   */
  async function logFactsOf(headerMap) {
    /** @type {Array<any>} */
    const logs = [];
    for (const header of headerMap.values()) {
      if (header?.id && header?.logPath) logs.push(header);
    }
    /** @type {Map<string, any>} */
    const out = new Map();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(LOG_READ_CONCURRENCY, logs.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= logs.length) return;
        const header = logs[index];
        const facts = await readLogFacts(header.logPath, header.sizeBytes, header.mtimeMs);
        if (facts) out.set(header.id, facts);
      }
    });
    await Promise.all(workers);
    return out;
  }

  /**
   * Registry: live service first, durable file second.
   *
   * @returns {Promise<any | null>}
   */
  async function readRegistry() {
    const file = await readWorkspaceFile(options.dshHome()).catch(() => null);
    try {
      const service = options.workspaceService?.();
      const live = readWorkspaceService(service);
      if (live && live.workspaceIds.length > 0) {
        // The live service does not expose `defaultWorkspaceId`, but the tree
        // needs it to label one workspace 默认工作区. The durable file still
        // carries it, so prefer the file's value when the ids agree.
        const defaultWorkspaceId =
          file?.defaultWorkspaceId && live.workspaces.has(file.defaultWorkspaceId)
            ? file.defaultWorkspaceId
            : live.defaultWorkspaceId;
        return { ...live, defaultWorkspaceId };
      }
    } catch {
      /* fall through to the file */
    }
    return file;
  }

  /** @returns {Set<string>} */
  function safeRunning() {
    try {
      const ids = options.runningIds?.();
      return ids instanceof Set ? ids : new Set();
    } catch {
      return new Set();
    }
  }

  /**
   * The sidecar overlay. A broken or missing document degrades to "no user
   * folders, empty trash" rather than failing the listing: the derived tree is
   * always renderable on its own.
   *
   * `listSettings` rides along because the tree counts rows, and 过滤空会话 is a
   * setting that removes rows: dropping it here left `buildTree` filtering blank
   * sessions whatever the user chose, which is the badge/list disagreement the
   * tree module goes out of its way to avoid.
   *
   * @returns {Promise<{ userTree: object | null, trashedIds: Set<string>, annotations: Record<string, any>, listSettings: object | null }>}
   */
  async function safeOverlay() {
    const empty = { userTree: null, trashedIds: new Set(), annotations: {}, listSettings: null };
    if (typeof options.overlay !== "function") return empty;
    try {
      const overlay = await options.overlay();
      return {
        userTree: overlay?.userTree ?? null,
        trashedIds: overlay?.trashedIds instanceof Set ? overlay.trashedIds : new Set(),
        annotations: overlay?.annotations ?? {},
        listSettings: overlay?.listSettings ?? null,
      };
    } catch {
      return empty;
    }
  }

  return {
    snapshot,
    invalidate() {
      epoch += 1;
      headerCache = null;
      // Nobody joins a read that began before this bump; the callers already
      // waiting on it keep their (pre-bump) answer, as before.
      baseInflight = null;
    },
    get headerCacheAge() {
      return headerCache ? Date.now() - headerCache.at : null;
    },
  };
}
