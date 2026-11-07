/**
 * dsh-session-navigator — the last resort for changes no event announces.
 *
 * Almost everything the panel shows arrives as a Cordis event (see
 * src/host/session-sync.js). Two important things do not:
 *
 *   the workspace registry  归档 / 置顶 / 取消置顶 rewrite
 *                           `<dshHome>/storages/workspace.json`, and the registry
 *                           publishes nothing when it happens — it has no change
 *                           event at all (`packages/workspace/workspace/src/index.ts`,
 *                           the archive/pin methods write and return). So a
 *                           session archived in DSH's own sidebar stayed in the
 *                           panel's 未归档 group until the panel was reopened;
 *
 *   the session directories  deleting a conversation in DSH's own sidebar
 *                           removes `<dshHome>/sessions/<workspace>/<session-…>/`
 *                           and emits no `session/disposed`: that event belongs
 *                           to the *kernel*, and a session nobody is running
 *                           never passes through it. The panel therefore kept
 *                           listing a conversation DSH had already deleted, and
 *                           only a reopen (a fresh walk) dropped the row.
 *
 * Both are closed by a signature read every few seconds whose cost does not grow
 * with the number of sessions: one `stat` of the registry file, one `readdir` of
 * `sessions/` plus one `stat` per workspace directory. A directory's mtime moves
 * when an entry is created, removed or renamed inside it — the log file's own
 * writes happen one level deeper and never touch it, so a busy conversation does
 * not look like a structural change. It is deliberately *not* an `fs.watch`: a
 * recursive watch over the whole session tree is a lot of machinery here, and a
 * missed rename on a network home is worse than a four-second lag.
 *
 * The first read of each signature is a baseline, never a notification: the
 * panel that just asked for /bootstrap already has the state these describe.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** How often the two signatures are read. */
const INTERVAL_MS = 4000;

/** What one signature read saw, and which half moved. */
const NO_CHANGE = Object.freeze({ changed: false, published: false });

/**
 * Watch the durable workspace file and the session directories.
 *
 * @param {object} options
 * @param {() => string} options.dshHome the DSH home, resolved per tick so a
 *   relocation is followed
 * @param {any} [options.bridge] the panel ↔ window bus
 * @param {() => Set<string>} [options.runningIds] the live running set
 * @param {() => void} [options.invalidate] drops the reader's header walk, so the
 *   reload this very event triggers cannot read the cache from before the change
 * @param {number} [options.intervalMs]
 * @param {(level: string, message: string) => void} [options.log]
 */
export function createStorageWatch(options = {}) {
  const { dshHome, bridge, runningIds, log } = options;
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : INTERVAL_MS;

  /** Last signature of `storages/workspace.json`, or null before the first read. */
  let workspaceSignature = null;
  /** Last signature of the `sessions/` layout, or null before the first read. */
  let sessionsSignature = null;
  let timer = null;
  let disposed = false;
  let busy = false;

  /** @returns {string} the resolved DSH home, or "" when it cannot be read. */
  function resolvedHome() {
    try {
      const home = typeof dshHome === "function" ? dshHome() : dshHome;
      return typeof home === "string" ? home : "";
    } catch {
      return "";
    }
  }

  /** @returns {Promise<string | null>} */
  async function readWorkspaceSignature() {
    const home = resolvedHome();
    if (!home) return null;
    const file = join(home, "storages", "workspace.json");
    try {
      const info = await stat(file);
      return file + "|" + info.mtimeMs + "|" + info.size;
    } catch {
      // A home without the file yet is a stable state, not a change every tick.
      return file + "|missing";
    }
  }

  /**
   * The shape of `sessions/`: every workspace directory with its mtime.
   *
   * A workspace directory gains an mtime tick when a session directory is
   * created, removed or renamed inside it, which is exactly "the set of sessions
   * changed". Session logs live one level deeper, so writing to one does not
   * disturb this signature.
   *
   * @returns {Promise<string | null>}
   */
  async function readSessionsSignature() {
    const home = resolvedHome();
    if (!home) return null;
    const root = join(home, "sessions");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return root + "|missing";
    }
    const parts = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      try {
        const info = await stat(dir);
        parts.push(entry.name + "|" + info.mtimeMs);
      } catch {
        // Vanished between readdir and stat: the next tick reports the removal.
      }
    }
    parts.sort();
    return parts.join(",");
  }

  /**
   * Compare both signatures with the last tick, and speak only when one moved.
   *
   * @returns {Promise<{ changed: boolean, published: boolean, reason?: string }>}
   */
  async function check() {
    if (disposed || busy) return NO_CHANGE;
    busy = true;
    let workspace = null;
    let sessions = null;
    try {
      workspace = await readWorkspaceSignature();
      sessions = await readSessionsSignature();
    } finally {
      busy = false;
    }
    if (workspace === null && sessions === null) return NO_CHANGE;

    const hadWorkspace = workspaceSignature !== null;
    const hadSessions = sessionsSignature !== null;
    const workspaceMoved = hadWorkspace && workspace !== null && workspace !== workspaceSignature;
    const sessionsMoved = hadSessions && sessions !== null && sessions !== sessionsSignature;
    if (workspace !== null) workspaceSignature = workspace;
    if (sessions !== null) sessionsSignature = sessions;
    if (!workspaceMoved && !sessionsMoved) return NO_CHANGE;

    let running = [];
    try {
      const ids = runningIds?.();
      if (ids instanceof Set) running = [...ids];
    } catch {
      running = [];
    }
    // A removed session directory invalidates the header walk (the row is gone);
    // the registry file is about grouping, so the rows themselves are unchanged.
    const structural = sessionsMoved;
    const reason = sessionsMoved ? "sessions" : "workspace";
    if (structural) {
      // The reload this event triggers reads the header walk, and a four-second
      // tick can land inside that walk's own 1.5 s window: dropping it here is
      // what makes the reload see the removed row instead of the one the
      // previous walk still holds.
      try {
        options.invalidate?.();
      } catch (error) {
        log?.("warn", "storage watch: invalidate failed: " + (error?.message ?? error));
      }
    }
    // Published whether or not an SSE listener is attached. A document that
    // cannot keep a stream open — one behind a proxy, or a window in another
    // process whose stream died — polls /bridge/poll instead, and gating on
    // `listeners` would silence the event for exactly that consumer.
    let published = false;
    if (typeof bridge?.publish === "function") {
      try {
        bridge.publish("sessions-changed", { reason, refresh: true, structural, running });
        published = true;
      } catch (error) {
        log?.("warn", "storage watch: publish failed: " + (error?.message ?? error));
      }
    }
    return { changed: true, published, reason };
  }

  function tick() {
    void check().catch((error) => {
      log?.("warn", "storage watch: " + (error?.message ?? error));
    });
  }

  if (typeof setInterval === "function") {
    // One baseline read now, so the first interval does not report the state the
    // panel is already showing. Both halves are seeded together: a baseline that
    // only covered the registry would report every existing session directory as
    // news on the first tick.
    void Promise.all([readWorkspaceSignature(), readSessionsSignature()])
      .then(([workspace, sessions]) => {
        if (disposed) return;
        if (workspaceSignature === null) workspaceSignature = workspace;
        if (sessionsSignature === null) sessionsSignature = sessions;
      })
      .catch(() => {});
    timer = setInterval(tick, intervalMs);
    timer?.unref?.();
  }

  return {
    /** Answer one tick now (tests, and the API's own writes). */
    check,
    /** The registry file as last seen. */
    get signature() {
      return workspaceSignature;
    },
    /** The session layout as last seen. */
    get sessionsSignature() {
      return sessionsSignature;
    },
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
