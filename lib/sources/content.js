/**
 * 会话内容 index (m00001).
 *
 * 搜索范围 grew a fourth field: 会话内容. The three metadata fields are already on
 * the rows the panel holds, but the conversation itself is only in the session
 * logs — 63 files, 106 MB compressed, ~6.5 s to read all of them on this machine.
 * So the text is read here, once per change, and kept in memory as plain
 * lowercased strings; a search then costs one `indexOf` pass per session.
 *
 * Two rules shape the design:
 *
 *   1. **Nothing is read unless someone searches.** The index is lazy: a request
 *      plans the work and spends a bounded slice of it, so a panel that never
 *      uses 会话内容 never pays for the index and never blocks the host.
 *   2. **A stale entry is worth nothing.** Entries are keyed by id and invalidated
 *      by `logPath | sizeBytes | activityAt` — the same signal `logfacts` uses —
 *      so a session that is still being written is re-read rather than answered
 *      from a snapshot of yesterday.
 *
 * @module lib/sources/content
 */
import { readArtifact } from "./artifact.js";
import { turnsOf } from "../domain/export.js";

/** How much wall clock one request may spend building, before it answers. */
const DEFAULT_BUDGET_MS = 700;

/** The longest needle the route will look for; a paragraph is not a search. */
const MAX_NEEDLE = 120;

/** Hits per response. The list only draws what it can show. */
const MAX_HITS = 200;

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * An in-process 会话内容 index.
 *
 * @param {{ read?: typeof readArtifact, turns?: typeof turnsOf, budgetMs?: number }} [options]
 */
export function createContentIndex(options = {}) {
  const read = options.read ?? readArtifact;
  const turns = options.turns ?? turnsOf;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;

  /** @type {Map<string, { sig: string, text: string, lower: string }>} */
  const entries = new Map();
  /** @type {{ id: string, sig: string, logPath: string }[]} */
  let queue = [];
  let total = 0;
  /** The slice currently being spent, so a second caller waits instead of doubling it. */
  let inFlight = null;

  const sigOf = (session) =>
    `${session.logPath ?? ""}\u0000${session.sizeBytes ?? 0}\u0000${session.activityAt ?? 0}`;

  /**
   * The plain text of a log: every turn's words, not its tools or reasoning.
   *
   * `readArtifact` is async and a cold read of the largest log here takes about
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
    for (const id of [...entries.keys()]) if (!live.has(id)) entries.delete(id);

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
  }

  /**
   * Spend one bounded slice of the build.
   *
   * Two things matter here and neither is about matching:
   *
   *  - **Bounded.** Reading one large log takes about half a second, so this
   *    stops after the session that crosses the budget and answers with a
   *    partial index rather than making the caller wait for all 63.
   *  - **One at a time.** The client asks again every 700 ms while the index is
   *    cold; without this guard two passes would read the same logs twice and
   *    the queue would drain no faster.
   *
   * `setImmediate` between sessions is what lets the host's own work run: the
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
    }
  }

  async function drain(limitMs) {
    const startedAt = Date.now();
    while (queue.length > 0) {
      const job = queue.shift();
      await buildOne(job);
      if (Date.now() - startedAt >= limitMs) break;
      await yieldToLoop();
    }
    return state();
  }

  /**
   * Sessions whose text contains `needle`.
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

  return { sync, work, search, state };
}
