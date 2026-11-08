/**
 * dsh-session-navigator — the read pipeline behind `/bootstrap` and `/sessions`.
 *
 * Three sources, one merged answer (see src/domain/sessions.js for the merge
 * rules). This module owns the I/O and the caching policy:
 *
 *   L0 manifest — the last process's answers, keyed by the version of the file
 *                 they came from (sources/manifest.js). Read once per start, and
 *                 the reason a cold start no longer decodes every header.
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

import { dirname } from "node:path";

import { FIXED_NODES } from "../constants.js";
import { buildSessionView } from "../domain/sessions.js";
import { shortcutTargetsIn } from "../domain/shortcuts.js";
import { buildAutoTree } from "../domain/tree.js";
import { scanHeaders } from "../sources/heads.js";
import { readLogFacts } from "../sources/logfacts.js";
import { readManifest, sameVersion, writeManifest } from "../sources/manifest.js";
import { projcacheDir, readProjcache } from "../sources/projcache.js";
import { readWorkspaceFile, readWorkspaceService } from "../sources/workspaces.js";

/** How long a header scan stays fresh, in milliseconds. */
const HEADER_TTL_MS = 1500;

/** How many log tails are classified at once (same bound as the header walk). */
const LOG_READ_CONCURRENCY = 8;

/**
 * How long the manifest write waits for the home to go quiet.
 *
 * The mirror is a cache for the *next* start, and the running process already
 * holds it in memory: writing while the user works buys nothing and costs a
 * 3.4 MB rewrite per burst at 2000 sessions. Every new scan pushes the write
 * back again, so a panel that keeps answering turns never touches the disk.
 */
const MANIFEST_QUIET_MS = 60_000;

/**
 * The longest an unwritten change may wait for that quiet, in milliseconds.
 *
 * A crash loses whatever the mirror had not caught up on, so "never while busy"
 * needs a floor: ten minutes of continuous work still lands on disk, and an
 * ordinary evening of use ends with one more write at shutdown.
 */
const MANIFEST_MAX_DELAY_MS = 600_000;

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
 * @param {() => string | null} [options.manifestPath] absolute path of the
 *   sessions manifest (sources/manifest.js); absent disables the mirror, which is
 *   what a test or a checkout without a data directory wants
 * @param {() => string | null} [options.manifestTmpDir] same-volume scratch
 *   directory for the atomic write of that file
 * @param {number} [options.manifestQuietMs] how long a dirtied mirror waits for
 *   the home to stop changing before it is written
 * @param {number} [options.manifestMaxDelayMs] the longest that wait may grow
 *   while changes keep arriving
 * @param {number} [options.ttlMs]
 */
export function createReader(options) {
  const ttlMs = options.ttlMs ?? HEADER_TTL_MS;

  /** @type {{ headers: Map<string, object>, logs: Map<string, object>, at: number } | null} */
  let headerCache = null;
  /** @type {Promise<{ headers: Map<string, object>, logs: Map<string, object> }> | null} */
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
   * Header scan, reusing the last walk when it is still fresh.
   *
   * Concurrent callers share one walk: a burst of requests must not multiply
   * the filesystem cost. `known` is the manifest's log mirror, which turns a
   * decode into a stat for every log the last process already read.
   *
   * @param {boolean} refresh force a rescan
   * @param {{ logs: Map<string, any> } | null} known
   * @returns {Promise<{ headers: Map<string, object>, logs: Map<string, object> }>}
   */
  async function headers(refresh, known) {
    const now = Date.now();
    if (!refresh && headerCache && now - headerCache.at < ttlMs) return headerCache;
    if (inflight) {
      // A refresh must not join a walk that began before the write it is
      // refreshing for; let the older walk finish, then read the tree again.
      if (!refresh) return inflight;
      await inflight.catch(() => {});
    }
    const startedEpoch = epoch;
    /** @type {Promise<{ headers: Map<string, object>, logs: Map<string, object> }>} */
    const walk = scanHeaders(options.dshHome(), { known: known?.logs })
      .then((scan) => {
        if (startedEpoch === epoch) headerCache = { headers: scan.headers, logs: scan.logs, at: Date.now() };
        return scan;
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
      // The manifest is read once per start, and everything below consults it
      // before going to disk: an unchanged log is a stat, an unchanged cache
      // file is a stat, and only what changed is read the old way.
      const known = await manifestOf();
      // The data directory can be relocated mid-read (see `manifestOf`); a scan
      // that started against one mirror must not write its answers into the
      // other one's file.
      const knownPath = known === null ? null : known.path;
      const [scan, cacheMap, registry] = await Promise.all([
        headers(refresh, known),
        projcacheOf(home, known),
        readRegistry(),
      ]);
      const logFacts = await logFactsOf(scan, known);
      rememberScan(known, knownPath, scan, logFacts);
      rememberFacts(known, knownPath, cacheMap);
      return { headerMap: scan.headers, cacheMap, registry, logFacts };
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
   * @param {{ facts: Map<string, any> } | null} known
   * @returns {Promise<Map<string, object>>}
   */
  function projcacheOf(home, known) {
    if (projcacheInflight && projcacheInflight.home === home) return projcacheInflight.run;
    const entry = { home, run: null };
    entry.run = readProjcache(projcacheDir(home), { known: known?.facts }).finally(() => {
      if (projcacheInflight === entry) projcacheInflight = null;
    });
    projcacheInflight = entry;
    return entry.run;
  }

  /**
   * Classify every log: has it ever started a turn?
   *
   * The manifest answers for a log whose header and file version it already
   * recorded, which is what makes a warm start open no logs at all. Everything
   * else is read here, bounded twice: a fixed worker count, and a per-log cache
   * keyed by size+mtime (`sources/logfacts.js`).
   *
   * A log whose facts could not be read stores nothing (`undefined`), so the
   * next scan tries again instead of remembering a failure as an answer.
   *
   * @param {{ logs: Map<string, { size: number, mtimeMs: number, ctimeMs: number, header: object }> }} scan
   * @param {{ logs: Map<string, any> } | null} known
   * @returns {Promise<Map<string, { turnStart: boolean | null }>>}
   */
  async function logFactsOf(scan, known) {
    /** @type {Map<string, { turnStart: boolean | null }>} */
    const out = new Map();
    /** @type {Array<{ logPath: string, entry: any }>} */
    const pending = [];
    for (const [logPath, entry] of scan.logs) {
      const prior = known?.logs.get(logPath);
      if (prior && prior.turnStart !== undefined && sameVersion(prior, entry)) {
        out.set(entry.header.id, { turnStart: prior.turnStart });
        continue;
      }
      pending.push({ logPath, entry });
    }
    let cursor = 0;
    const workers = Array.from({ length: Math.min(LOG_READ_CONCURRENCY, pending.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= pending.length) return;
        const { logPath, entry } = pending[index];
        const facts = await readLogFacts(logPath, entry.size, entry.mtimeMs);
        if (facts) out.set(entry.header.id, facts);
      }
    });
    await Promise.all(workers);
    return out;
  }

  /**
   * The manifest mirror: the previous process's answers, plus the write that
   * hands them to the next one.
   *
   * Deliberately not dropped by `invalidate()`. Every entry validates itself
   * against the file it describes (size + times), so a stale mirror can only
   * miss, never lie — and `invalidate()` runs on every storage event, so
   * dropping it would re-read the file for an answer it already had.
   *
   * @type {{ path: string | null, ready: Promise<void> | null, logs: Map<string, any>, facts: Map<string, any>, timer: any, writing: Promise<boolean> | null, dirty: boolean, dirtySince: number, forgotten: boolean }}
   */
  const manifest = {
    path: null,
    ready: null,
    logs: new Map(),
    facts: new Map(),
    timer: null,
    writing: null,
    dirty: false,
    // Set by `forgetManifest()`: the file is gone because the user cleared the
    // caches, so nothing may write it back until a scan fills the mirror again.
    forgotten: false,
    // When the oldest change still missing from the file happened, 0 for none.
    // The quiet window restarts on every change; this one does not, which is
    // what turns "wait for calm" into a bounded wait.
    dirtySince: 0,
  };

  /**
   * The mirror for the current data directory, reading it on first use.
   *
   * `manifestPath` is a live getter: the data directory can be relocated at
   * runtime (src/index.js rebuilds `paths`), and a mirror keyed to the old
   * directory describes logs nobody is reading any more. A relocation therefore
   * drops the mirror and reads the new file.
   *
   * @returns {Promise<object | null>} the mirror, or null when it is disabled
   */
  async function manifestOf() {
    const path = typeof options.manifestPath === "function" ? options.manifestPath() : null;
    if (!path) return null;
    if (manifest.path !== path) {
      manifest.path = path;
      manifest.logs = new Map();
      manifest.facts = new Map();
      manifest.dirty = false;
      manifest.dirtySince = 0;
      // A timer armed for the old file would fire against the new path and
      // overwrite it with the empty maps above.
      if (manifest.timer !== null) {
        clearTimeout(manifest.timer);
        manifest.timer = null;
      }
      manifest.ready = readManifest(path).then((read) => {
        // A relocation that happened while the file was being read wins: those
        // entries describe another directory.
        if (manifest.path !== path) return;
        manifest.logs = read.logs;
        manifest.facts = read.facts;
      });
    }
    await manifest.ready;
    return manifest;
  }

  /**
   * Replace the log mirror with what this scan actually found.
   *
   * Replacing rather than merging is what drops the entries of sessions that
   * were removed: the walk just enumerated the home, so anything it did not see
   * is not there. Not dirty means byte-for-byte the same mirror, and a quiet
   * panel never touches the disk.
   *
   * @param {object | null} known
   * @param {string | null} knownPath the mirror path this scan was read against
   * @param {{ logs: Map<string, { size: number, mtimeMs: number, ctimeMs: number, header: object }> }} scan
   * @param {Map<string, { turnStart: boolean | null }>} logFacts
   */
  function rememberScan(known, knownPath, scan, logFacts) {
    if (known === null || known.path !== knownPath) return;
    let dirty = scan.logs.size !== known.logs.size;
    /** @type {Map<string, any>} */
    const next = new Map();
    for (const [logPath, entry] of scan.logs) {
      const facts = logFacts.get(entry.header.id);
      const turnStart = facts ? facts.turnStart : undefined;
      /** @type {any} */
      const record = {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        ctimeMs: entry.ctimeMs,
        header: entry.header,
      };
      if (turnStart !== undefined) record.turnStart = turnStart;
      const prior = known.logs.get(logPath);
      if (!prior || prior.turnStart !== turnStart || !sameVersion(prior, entry)) dirty = true;
      next.set(logPath, record);
    }
    known.logs = next;
    known.forgotten = false;
    if (dirty) markDirty(known);
  }

  /**
   * Replace the facts mirror with what the projection cache just returned.
   *
   * @param {object | null} known
   * @param {string | null} knownPath the mirror path this read was made against
   * @param {Map<string, { size?: number, mtimeMs?: number, version?: number, facts?: object }>} cacheMap
   */
  function rememberFacts(known, knownPath, cacheMap) {
    if (known === null || known.path !== knownPath) return;
    /** @type {Map<string, any>} */
    const next = new Map();
    for (const [sessionId, record] of cacheMap) {
      if (!Number.isFinite(record?.size) || !Number.isFinite(record?.mtimeMs)) continue;
      if (!Number.isInteger(record?.version)) continue;
      next.set(sessionId, {
        size: record.size,
        mtimeMs: record.mtimeMs,
        version: record.version,
        facts: record.facts,
      });
    }
    let dirty = next.size !== known.facts.size;
    for (const [sessionId, record] of next) {
      const prior = known.facts.get(sessionId);
      if (!prior || prior.version !== record.version || !sameVersion(prior, record)) dirty = true;
    }
    known.facts = next;
    known.forgotten = false;
    if (dirty) markDirty(known);
  }

  /**
   * Arm the write: the home has to be quiet for the full window, and the oldest
   * unwritten change caps how long that can be postponed.
   *
   * Both numbers are read here rather than captured, so a test can drive them
   * per reader without a global.
   */
  function markDirty(known) {
    known.dirty = true;
    // A write already in flight re-arms this from its own finally().
    if (known.writing !== null) return;
    const now = Date.now();
    if (!known.dirtySince) known.dirtySince = now;
    const quiet = options.manifestQuietMs ?? MANIFEST_QUIET_MS;
    const cap = options.manifestMaxDelayMs ?? MANIFEST_MAX_DELAY_MS;
    // Restart the quiet window on every change; the cap counts from the first.
    const wait = Math.max(0, Math.min(quiet, cap - (now - known.dirtySince)));
    if (known.timer !== null) {
      clearTimeout(known.timer);
      known.timer = null;
    }
    known.timer = setTimeout(() => {
      known.timer = null;
      void flushManifest();
    }, wait);
    // A cache write must never be the reason the process stays alive.
    known.timer.unref?.();
  }

  /**
   * Write the mirror now, or join the write already in flight.
   *
   * Exposed for tests and for a caller that is about to exit; the wait for quiet
   * above is what runs in normal operation. A failed write is reported as `false` and
   * not thrown: the manifest is a cache, and a start that could not refresh it
   * is still a correct start.
   *
   * @returns {Promise<boolean>} whether the file was written
   */
  async function flushManifest() {
    const known = manifest;
    const path = known.path;
    if (!path) return false;
    // The file was deleted on purpose and nothing has been read since: writing
    // an empty one back would leave the user a manifest that holds no answers.
    if (known.forgotten) return false;
    if (known.timer !== null) {
      clearTimeout(known.timer);
      known.timer = null;
    }
    if (known.writing) return known.writing;
    known.dirty = false;
    known.dirtySince = 0;
    const tmpDir = typeof options.manifestTmpDir === "function" ? options.manifestTmpDir() : dirname(path);
    known.writing = writeManifest(path, tmpDir ?? dirname(path), known.logs, known.facts)
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        known.writing = null;
        if (known.dirty) markDirty(known);
      });
    return known.writing;
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
    flushManifest,
    invalidate() {
      epoch += 1;
      headerCache = null;
      // Nobody joins a read that began before this bump; the callers already
      // waiting on it keep their (pre-bump) answer, as before.
      baseInflight = null;
    },
    /**
     * Let go of the mirror, so a deleted manifest stays deleted.
     *
     * 清理缓存 takes `sessions-manifest.v1.json`; without this the pending
     * quiet-window write — and the flush on shutdown — would put it straight
     * back, and the user would watch the bytes they just freed return. The next
     * scan fills the mirror again and the next quiet window writes it.
     *
     * Deliberately not part of `invalidate()`: that runs on every storage event,
     * and a mirror dropped there would be rewritten after each one.
     */
    forgetManifest() {
      if (manifest.timer !== null) {
        clearTimeout(manifest.timer);
        manifest.timer = null;
      }
      manifest.logs = new Map();
      manifest.facts = new Map();
      manifest.dirty = false;
      manifest.dirtySince = 0;
      manifest.forgotten = true;
    },
    get headerCacheAge() {
      return headerCache ? Date.now() - headerCache.at : null;
    },
  };
}
