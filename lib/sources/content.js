/**
 * 会话内容 index (m00001) and its on-disk cache (m00561).
 *
 * 搜索范围 grew a fourth field: 会话内容. The three metadata fields are already on
 * the rows the panel holds, but the conversation itself is only in the session
 * logs — 63 files, 106 MB compressed, ~6.5 s to read all of them on this machine.
 * So the text is read here, once per change, and kept in memory as plain
 * lowercased strings; a search then costs one indexOf pass per session.
 *
 * Four rules shape the design:
 *
 *   1. Nothing is read unless someone searches. The index is lazy: a request
 *      plans the work and spends a bounded slice of it, so a panel that never
 *      uses 会话内容 never pays for the index and never blocks the host. 允许空闲时
 *      自动建立 (settings.search.indexIdle) is the user opting into paying it
 *      early, in slices, while nothing else is happening.
 *   2. A stale entry is worth nothing. Entries are keyed by id and invalidated
 *      by logPath | sizeBytes | activityAt — the same signal logfacts uses —
 *      so a session that is still being written is re-read rather than answered
 *      from a snapshot of yesterday.
 *   3. The cache is derived, never authoritative. It is one JSON file inside the
 *      data directory, written by writeAtomic, and every entry carries the
 *      signal it was built from; a file this build cannot parse is ignored
 *      rather than migrated. Losing it costs one rebuild and nothing else, which
 *      is why 清理缓存 and 清除数据 may delete it freely.
 *   4. A cache that cannot be written is not an error. A read-only data
 *      directory, a scanner holding the file open, a full disk: the search still
 *      answers from memory, and the next flush tries again.
 *
 * @module lib/sources/content
 */
import { mkdir, readFile, rm, stat } from "node:fs/promises";

import { readArtifact } from "./artifact.js";
import { turnsOf } from "../domain/export.js";
import { writeAtomic } from "../store/sidecar.js";

/** How much wall clock one request may spend building, before it answers. */
const DEFAULT_BUDGET_MS = 700;

/** The longest needle the route will look for; a paragraph is not a search. */
const MAX_NEEDLE = 120;

/** Hits per response. The list only draws what it can show. */
const MAX_HITS = 200;

/** Bumped when the shape on disk changes; an older file is ignored, not read. */
const CACHE_VERSION = 1;

/** Longest a running build may leave the file behind the memory it mirrors. */
const FLUSH_AFTER_MS = 3000;

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * An in-process 会话内容 index, optionally mirrored to one file on disk.
 *
 * @param {{
 *   read?: typeof readArtifact,
 *   turns?: typeof turnsOf,
 *   budgetMs?: number,
 *   store?: { path: string, tmpDir: string } | null,
 *   cacheEnabled?: () => boolean | Promise<boolean>,
 *   now?: () => number,
 * }} [options]
 */
export function createContentIndex(options = {}) {
  const read = options.read ?? readArtifact;
  const turns = options.turns ?? turnsOf;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  /** Where the cache lives; null turns the file off entirely (tests, alternate roots). */
  const store = options.store ?? null;
  /**
   * Whether the cache may be used right now. A function because the answer is a
   * setting: turning 会话内容索引缓存 off has to stop the next write without
   * rebuilding the index, and it is async because reading the settings document
   * is.
   */
  const cacheEnabled = options.cacheEnabled ?? (() => true);
  const now = options.now ?? (() => Date.now());

  /** @type {Map<string, { sig: string, text: string, lower: string }>} */
  const entries = new Map();
  /** @type {{ id: string, sig: string, logPath: string }[]} */
  let queue = [];
  let total = 0;
  /** The slice currently being spent, so a second caller waits instead of doubling it. */
  let inFlight = null;
  /** The one read of the cache file; never reset, since a re-read would undo 删除缓存. */
  let opening = null;
  /** True when memory holds something the file does not. */
  let dirty = false;
  /** Bytes of the file as this process last saw it. */
  let bytes = 0;
  let lastFlushAt = 0;

  const sigOf = (session) =>
    [session.logPath ?? "", session.sizeBytes ?? 0, session.activityAt ?? 0].join("\u0000");

  /** The switch, read defensively: a settings read that throws means "no cache". */
  async function cacheOn() {
    if (!store) return false;
    try {
      return (await cacheEnabled()) !== false;
    } catch {
      return false;
    }
  }

  /**
   * The plain text of a log: every turn's words, not its tools or reasoning.
   *
   * readArtifact is async and a cold read of the largest log here takes about
   * half a second, so this is awaited rather than assumed — a promise treated as
   * a value yields an empty index that looks like "nothing matches".
   */
  async function textOf(logPath) {
    const artifact = await read(logPath, { tolerateTail: true });
    const parts = [];
    for (const turn of turns(artifact?.events ?? [])) {
      if (turn.text) parts.push(turn.text);
    }
    return parts.join("\n");
  }

  /**
   * Load the cache once, if there is one this build understands.
   *
   * Every restored entry keeps the signal it was built from, so sync can throw
   * away the ones whose log moved on. The file is read as one string and parsed
   * as JSON: 1 MB of text costs a few milliseconds, and a partial reader would
   * have to tolerate a truncated tail that writeAtomic never produces.
   */
  async function readCache() {
    if (!(await cacheOn())) return { restored: 0 };
    let text;
    try {
      text = await readFile(store.path, "utf8");
    } catch {
      // No cache yet is the normal first run, not a failure.
      return { restored: 0 };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A half-written or hand-edited file: ignore it and overwrite it later.
      return { restored: 0 };
    }
    if (!parsed || parsed.version !== CACHE_VERSION) return { restored: 0 };
    const sessions = parsed.sessions;
    if (!sessions || typeof sessions !== "object") return { restored: 0 };
    let restored = 0;
    for (const [id, record] of Object.entries(sessions)) {
      if (!record || typeof record.sig !== "string" || typeof record.text !== "string") continue;
      entries.set(id, { sig: record.sig, text: record.text, lower: record.text.toLowerCase() });
      restored += 1;
    }
    bytes = Buffer.byteLength(text, "utf8");
    lastFlushAt = now();
    return { restored };
  }

  /**
   * Make sure the cache has been consulted exactly once.
   *
   * Callers await this before sync: without it a sync on a cold process would
   * queue every session for reading, which is the very work the cache exists to
   * avoid.
   */
  function open() {
    if (!opening) opening = readCache();
    return opening;
  }

  /**
   * Reconcile the index with the sessions that exist right now.
   *
   * Forgetful in both directions: a session that is gone is dropped, and a
   * session whose log changed is queued again. Returns the ids still to read.
   */
  function sync(sessions) {
    const live = new Map();
    for (const session of sessions ?? []) {
      if (!session?.id || !session.logPath) continue;
      live.set(session.id, session);
    }
    for (const id of [...entries.keys()]) {
      if (live.has(id)) continue;
      entries.delete(id);
      dirty = true;
    }

    queue = [];
    for (const session of live.values()) {
      const sig = sigOf(session);
      const entry = entries.get(session.id);
      if (entry && entry.sig === sig) continue;
      queue.push({ id: session.id, sig, logPath: session.logPath });
    }
    total = live.size;
    return state();
  }

  /** Where the index stands: how many sessions are covered, out of how many. */
  function state() {
    return { indexed: total - queue.length, total, pending: queue.length };
  }

  async function buildOne(job) {
    let text = "";
    try {
      text = await textOf(job.logPath);
    } catch {
      // A log that cannot be read is not a match: cache an empty entry under the
      // same signal, so this session is skipped rather than retried forever.
      text = "";
    }
    entries.set(job.id, { sig: job.sig, text, lower: text.toLowerCase() });
    dirty = true;
  }

  /**
   * Write the file, if it is worth writing.
   *
   * force writes even when nothing changed, which only 清理缓存 needs: it wants
   * to know the bytes it removed, and a stat is cheaper than a rewrite. A
   * failure is reported, not thrown: the index in memory is still correct.
   */
  async function flush(force = false) {
    if (!store) return { written: false, bytes };
    if (!dirty && !force) return { written: false, bytes };
    if (!(await cacheOn())) return { written: false, bytes, skipped: "cache-off" };
    const sessions = {};
    for (const [id, entry] of entries) sessions[id] = { sig: entry.sig, text: entry.text };
    const text = JSON.stringify({ version: CACHE_VERSION, savedAt: now(), sessions });
    try {
      await mkdir(store.tmpDir, { recursive: true });
      await writeAtomic(store.path, store.tmpDir, text);
    } catch (error) {
      return { written: false, bytes, error: String(error?.message ?? error) };
    }
    bytes = Buffer.byteLength(text, "utf8");
    dirty = false;
    lastFlushAt = now();
    return { written: true, bytes };
  }

  /**
   * Spend one bounded slice of the build.
   *
   * Three things matter here and none is about matching:
   *
   *  - Bounded. Reading one large log takes about half a second, so this stops
   *    after the session that crosses the budget and answers with a partial
   *    index rather than making the caller wait for all 63.
   *  - One at a time. The client asks again every 700 ms while the index is
   *    cold; without this guard two passes would read the same logs twice and
   *    the queue would drain no faster.
   *  - Settled then saved. A finished index (or one that has been running for a
   *    few seconds) is flushed, so a build survives the restart that follows it.
   *    FLUSH_AFTER_MS is the throttle: the file follows the build in steps
   *    instead of being rewritten once per log.
   *
   * setImmediate between sessions is what lets the host's own work run: the
   * read is asynchronous, but its decompression is not, and a stop-start of
   * 63 logs would otherwise land as one long stall somewhere else.
   */
  async function work(limitMs = budgetMs) {
    if (inFlight) return inFlight;
    inFlight = drain(limitMs);
    try {
      return await inFlight;
    } finally {
      inFlight = null;
      if (dirty && (queue.length === 0 || now() - lastFlushAt >= FLUSH_AFTER_MS)) await flush();
    }
  }

  async function drain(limitMs) {
    const startedAt = now();
    while (queue.length > 0) {
      const job = queue.shift();
      await buildOne(job);
      if (now() - startedAt >= limitMs) break;
      await yieldToLoop();
    }
    return state();
  }

  /**
   * Sessions whose text contains the needle.
   *
   * @param {string} needle
   * @returns {{ id: string, count: number, snippet: string }[]}
   */
  function search(needle) {
    const raw = String(needle ?? "").trim();
    if (!raw) return [];
    const lowered = raw.slice(0, MAX_NEEDLE).toLowerCase();
    const hits = [];
    for (const [id, entry] of entries) {
      if (!entry.lower) continue;
      let at = entry.lower.indexOf(lowered);
      if (at === -1) continue;
      const first = at;
      let count = 0;
      while (at !== -1 && count < 999) {
        count += 1;
        at = entry.lower.indexOf(lowered, at + lowered.length);
      }
      hits.push({ id, count, snippet: snippetOf(entry.text, first) });
    }
    hits.sort((a, b) => b.count - a.count);
    return hits.slice(0, MAX_HITS);
  }

  /** The matched line-ish region, flattened: a table row is one line high. */
  function snippetOf(text, at) {
    const from = Math.max(0, at - 30);
    const to = Math.min(text.length, at + 70);
    const body = text.slice(from, to).replace(/\s+/g, " ").trim();
    return (from > 0 ? "…" : "") + body + (to < text.length ? "…" : "");
  }

  /** Delete the file, reporting the bytes it held. A locked or absent file reports 0. */
  async function dropDisk() {
    if (!store) return 0;
    let held = 0;
    try {
      held = (await stat(store.path)).size;
    } catch {
      // Nothing on disk: nothing to free.
      return 0;
    }
    try {
      await rm(store.path, { force: true });
    } catch {
      // A scanner holding the file open is the usual reason on Windows. The
      // report has to say nothing was freed, because nothing was.
      return 0;
    }
    bytes = 0;
    return held;
  }

  /**
   * Forget everything — memory and file — and keep forgetting.
   *
   * opening is left resolved, otherwise the next open() would read the file that
   * was just deleted and the user's 删除缓存 would appear to do nothing.
   */
  async function clear() {
    entries.clear();
    queue = [];
    total = 0;
    dirty = false;
    lastFlushAt = 0;
    if (!opening) opening = Promise.resolve({ restored: 0 });
    const freedBytes = await dropDisk();
    return { freedBytes, sessions: 0 };
  }

  /** 重新建立: throw the cache away, then plan every session again. */
  async function rebuild(sessions) {
    await clear();
    return sync(sessions);
  }

  /** What the settings page prints: on/off, how big, and how many sessions. */
  async function cacheInfo() {
    const enabled = await cacheOn();
    let onDisk = 0;
    if (store) {
      try {
        onDisk = (await stat(store.path)).size;
      } catch {
        onDisk = 0;
      }
    }
    return { enabled, bytes: onDisk, exists: onDisk > 0, sessions: entries.size };
  }

  return { sync, work, search, state, open, flush, clear, rebuild, cacheInfo, dropDisk };
}
