/**
 * dsh-session-navigator — the last resort for changes no event announces.
 *
 * Almost everything the panel shows arrives as a Cordis event (see
 * lib/host/session-sync.js). One important thing does not: the workspace
 * registry. 归档 / 置顶 / 取消置顶 rewrite `<dshHome>/storages/workspace.json`,
 * and the registry publishes nothing when it happens — it has no change event at
 * all (`packages/workspace/workspace/src/index.ts`, the archive/pin methods
 * write and return). So a session archived in DSH's own sidebar stayed in the
 * panel's 未归档 group until the panel was reopened.
 *
 * A stat of that one file every few seconds closes the gap for a cost that does
 * not grow with the number of sessions: no walk, no log reads, one `stat` per
 * tick. It is deliberately *not* a `fs.watch`: a recursive watch over the whole
 * session tree is a lot of machinery here, and a missed rename on a network home
 * is worse than a four-second lag.
 *
 * The first read is a baseline, never a notification: the panel that just asked
 * for /bootstrap already has the state this file describes.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

/** How often the storage file is stat'ed. */
const INTERVAL_MS = 4000;

/**
 * Watch the durable workspace file.
 *
 * @param {object} options
 * @param {() => string} options.dshHome the DSH home, resolved per tick so a
 *   relocation is followed
 * @param {any} [options.bridge] the panel ↔ window bus
 * @param {() => Set<string>} [options.runningIds] the live running set
 * @param {number} [options.intervalMs]
 * @param {(level: string, message: string) => void} [options.log]
 */
export function createStorageWatch(options = {}) {
  const { dshHome, bridge, runningIds, log } = options;
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : INTERVAL_MS;

  /** Last signature seen, or null before the first read. */
  let signature = null;
  let timer = null;
  let disposed = false;
  let busy = false;

  /** @returns {Promise<string | null>} */
  async function readSignature() {
    let home = "";
    try {
      home = typeof dshHome === "function" ? dshHome() : dshHome;
    } catch {
      home = "";
    }
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
   * Compare the file with the last tick, and speak only when it moved.
   *
   * @returns {Promise<{ changed: boolean, published: boolean, reason?: string }>}
   */
  async function check() {
    if (disposed || busy) return { changed: false, published: false };
    busy = true;
    let next = null;
    try {
      next = await readSignature();
    } finally {
      busy = false;
    }
    if (next === null) return { changed: false, published: false };
    const previous = signature;
    signature = next;
    if (previous === null || previous === next) return { changed: false, published: false };

    let running = [];
    try {
      const ids = runningIds?.();
      if (ids instanceof Set) running = [...ids];
    } catch {
      running = [];
    }
    // No listener means the next /bootstrap is authoritative; a queued event
    // would only be replayed at someone who is about to read everything.
    const listeners = typeof bridge?.listeners === "number" ? bridge.listeners : 1;
    let published = false;
    if (listeners > 0 && typeof bridge?.publish === "function") {
      try {
        bridge.publish("sessions-changed", { reason: "workspace", refresh: true, structural: false, running });
        published = true;
      } catch (error) {
        log?.("warn", "storage watch: publish failed: " + (error?.message ?? error));
      }
    }
    return { changed: true, published, reason: "workspace" };
  }

  function tick() {
    void check().catch((error) => {
      log?.("warn", "storage watch: " + (error?.message ?? error));
    });
  }

  if (typeof setInterval === "function") {
    // One baseline read now, so the first interval does not report the state the
    // panel is already showing.
    void readSignature()
      .then((value) => {
        if (!disposed && signature === null) signature = value;
      })
      .catch(() => {});
    timer = setInterval(tick, intervalMs);
    timer?.unref?.();
  }

  return {
    /** Answer one tick now (tests, and the API's own writes). */
    check,
    /** The file as last seen. */
    get signature() {
      return signature;
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
