/**
 * dsh-session-navigator — taking a session away from the running host.
 *
 * Trashing a session renames its directory. A session the host still has open
 * is a second owner of that directory: its agent keeps the log writer alive,
 * its registry row keeps the session on screen, and its write-behind may still
 * have events buffered. Moving the bytes under it produces the failure the user
 * sees as "deleted, but the session is now in 未分组" — the row survives
 * because the host re-creates the log at the old path, or because the panel
 * keeps rendering a session DSH no longer has a registration for.
 *
 * The delete is therefore split into steps, each called at the point it belongs
 * to:
 *
 *   stopSession    cancel the agent, wait for it to become idle and drop its
 *                  registry row. Before the move: nothing may keep writing into
 *                  the directory. It deliberately does *not* dispose the
 *                  loop’s fiber — see the note on {@link stopSession}.
 *   releaseWriters close the persistence write handle the agent left behind.
 *                  Windows keeps the directory renameable only while no handle
 *                  inside it is open, so this is the step that turns "open it
 *                  once and it can never be moved again" into a move.
 *   flushSession   push buffered events to disk. Before the move, because a
 *                  flush afterwards would re-create the directory that just
 *                  left.
 *   detachSession  `session/disposed` — what makes every client drop the row
 *                  and the persistence layer finish its write-behind. After the
 *                  move, so no further event is written to the old path.
 *
 * Everything is best effort: a profile without `agents` or `sessions` (and
 * every unit test) skips the step, and the caller decides whether a session
 * that would not stop is fatal.
 */

import { getService } from "../capabilities.js";

/** How long a teardown may take before the session counts as unstoppable. */
const TEARDOWN_TIMEOUT_MS = 3000;

/** Grace period for the host's write-behind to finish after `detach()`. */
const SETTLE_MS = 200;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Resolve with `value`, or give up after `timeoutMs` — never both, never a throw.
 *
 * Every host call this module makes is a courtesy: a wedged agent must not hold
 * the delete dialog (or the move) open forever, so each one is bounded and its
 * failure is reported through the caller's status re-read instead of thrown.
 *
 * @template T
 * @param {Promise<T> | T} value
 * @param {number} timeoutMs
 * @returns {Promise<{ done: boolean, value?: T }>}
 */
async function bounded(value, timeoutMs) {
  try {
    const settled = await Promise.race([
      Promise.resolve(value).then((result) => ({ done: true, value: result })),
      sleep(Math.max(0, timeoutMs)).then(() => ({ done: false })),
    ]);
    return settled;
  } catch {
    return { done: false };
  }
}

/**
 * The live *agent record* for a session id, from either registry shape.
 *
 * `agents.store` holds carrier entries `{ id, agent, carrier, ... }`, while the
 * service accessor answers the agent itself on some versions. Both are unwrapped
 * here so callers always get the agent.
 *
 * @param {any} agents
 * @param {string} id
 * @returns {any}
 */
function agentOf(agents, id) {
  try {
    if (typeof agents?.get === "function") {
      const found = agents.get(id);
      if (found) return found.agent ?? found;
    }
    const entry = agents?.store?.get?.(id);
    if (entry) return entry.agent ?? entry;
    const list = agents?.list?.();
    if (!Array.isArray(list)) return null;
    return list.find((agent) => agent?.id === id || agent?.sessionId === id)?.agent ?? null;
  } catch {
    return null;
  }
}

/**
 * The registry carrier entry for a session id, or null.
 *
 * `detachEntered` is exact-identity: it refuses an entry that is no longer the
 * live row for that id, which is why the entry is re-read right before use
 * rather than captured earlier.
 *
 * @param {any} agents
 * @param {string} id
 * @returns {any}
 */
function entryOf(agents, id) {
  try {
    return agents?.store?.get?.(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * The live *session object* for a session id.
 *
 * The host has two shapes in play and they are not interchangeable:
 * `sessions.get(id)` answers the session, while `sessions.store.get(id)` answers
 * a carrier entry `{ id, session, carrier, detach, ... }`. The entry is what
 * `detach()` hangs off, and the session is what `flush()` needs; passing the
 * wrong one to `flush()` throws (`session "<id>" is not live in this store`). The
 * old code swallowed that throw, so a move over a session the host had open went
 * ahead with its buffered events still only in memory. Both shapes are unwrapped
 * here so callers get the session itself.
 *
 * @param {any} sessions
 * @param {string} id
 * @returns {any}
 */
function sessionOf(sessions, id) {
  try {
    if (typeof sessions?.get === "function") {
      const found = sessions.get(id);
      if (found) return found.session ?? found;
    }
    const store = sessions?.store;
    if (typeof store?.get === "function") {
      const entry = store.get(id);
      if (entry) return entry.session ?? entry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Is this session *generating* right now?
 *
 * "Open in DSH" and "producing tokens" are two different states, and only the
 * second one is a reason to refuse a move: an agent that is streaming holds a
 * writer on the log and would keep appending to the old path. An idle session
 * the user merely has on screen appends nothing, so its log can be relocated
 * (the caller flushes it first) and the host's view is detached afterwards.
 *
 * @param {any} ctx plugin context; a missing `agents` service answers "no"
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isSessionRunning(ctx, sessionId) {
  const id = String(sessionId ?? "");
  if (!ctx || id === "") return false;
  const agent = agentOf(getService(ctx, "agents"), id);
  if (!agent) return false;
  // Registries in the wild spell the same fact two ways: `status` on the agent
  // record, and a boolean on an inner run. Either one claiming "running" wins.
  return agent.status === "running" || agent.running === true;
}

/**
 * Stop a live session before its directory moves. Safe for a session that is
 * not open at all.
 *
 * What this must *not* do is dispose the agent's fiber. `scope.dispose()` looks
 * like the tidy way to close a log handle, and it does close it — by unloading
 * the agent loop's Cordis scope, which is shared with the plugin instance that
 * creates agents. The next `create` then runs on that now-inactive context and
 * DSH refuses it with `cannot create effect on inactive context` — the
 * "新建会话失败" a user sees after deleting a session, until a restart rebuilds
 * the scopes. The supported teardown is the one DSH itself uses: cancel the
 * run, wait for the agent to go idle, then drop its registry row. The writer
 * that outlives that row is closed by {@link releaseWriters}, which touches one
 * handle instead of a whole plugin scope.
 *
 * @param {any} ctx plugin context; missing services are skipped
 * @param {string} sessionId
 * @param {{ disposeTimeoutMs?: number, teardownTimeoutMs?: number }} [options]
 * @returns {Promise<{ wasRunning: boolean, stillRunning: boolean, released: boolean }>}
 */
export async function stopSession(ctx, sessionId, options = {}) {
  const id = String(sessionId ?? "");
  if (!ctx || id === "") return { wasRunning: false, stillRunning: false, released: true };
  const timeoutMs = Number.isFinite(options.teardownTimeoutMs)
    ? Number(options.teardownTimeoutMs)
    : Number.isFinite(options.disposeTimeoutMs)
      ? Number(options.disposeTimeoutMs)
      : TEARDOWN_TIMEOUT_MS;

  const agents = getService(ctx, "agents");
  const agent = agentOf(agents, id);
  if (!agent) return { wasRunning: false, stillRunning: false, released: true };
  const wasRunning = agent.status === "running" || agent.running === true;
  try {
    await agent.cancel?.({ kind: "disposed" });
  } catch {
    /* already gone, or the agent refuses to cancel; the re-read decides */
  }
  // `whenIdle()` is the contract that says "the run stopped and the unstored
  // suffix is appended"; it is what a dispose would have waited for anyway.
  const idle = typeof agent.whenIdle === "function" ? agent.whenIdle.bind(agent) : null;
  if (idle) await bounded(Promise.resolve().then(idle), timeoutMs);
  // Drop the registry row. Prefer the exact-identity detach DSH exposes; a
  // registry without it is handled by removing the id, which is what the old
  // code did unconditionally.
  const entry = entryOf(agents, id);
  let detached = false;
  try {
    if (entry && typeof agents.detachEntered === "function") {
      agents.detachEntered(entry);
      detached = true;
    }
  } catch {
    /* an entry that is not the live row is refused; the fallback below runs */
  }
  if (agentOf(agents, id)) {
    try {
      agents?.store?.delete?.(id);
      detached = true;
    } catch {
      /* older registries have no delete; detaching the session still helps */
    }
  }
  const after = agentOf(agents, id);
  return {
    wasRunning,
    stillRunning: after?.status === "running" || after?.running === true,
    released: after === null && (detached || entry === null),
  };
}

/**
 * How long a single handle close may take before the writer counts as stuck.
 */
const CLOSE_TIMEOUT_MS = 2000;

/**
 * Handles already closed by this module.
 *
 * A delete and a move both call {@link releaseWriters}, and a move calls it
 * twice on purpose (once in `prepare`, once a line before the rename). Closing a
 * handle twice is at best a no-op in the backend and at worst an error on a
 * retired one, so the second call is made free instead of merely harmless.
 */
const CLOSED_HANDLES = new WeakSet();

/**
 * Every persistence write handle currently open for one session.
 *
 * The backend keeps its bookkeeping in a tracker: `tracker.writers` is the
 * per-session owner and `tracker.openHandles` every handle it adopted, retirees
 * included. Only `access === "write"` handles block a directory rename — a read
 * handle is opened with delete-sharing on Windows — so only those are reported.
 * A backend without a tracker answers an empty list, which makes every caller
 * here degrade to "try the rename and report what Windows says".
 *
 * @param {any} persistence
 * @param {string} id
 * @returns {any[]}
 */
function writeHandlesOf(persistence, id) {
  /** @type {Set<any>} */
  const handles = new Set();
  const tracker = persistence?.tracker;
  const direct = tracker?.writers?.get?.(id);
  if (direct) handles.add(direct);
  const all = tracker?.openHandles;
  if (all && typeof all[Symbol.iterator] === "function") {
    for (const handle of all) {
      const owner = handle?.id ?? handle?.sessionId;
      if (owner === id && handle?.access === "write") handles.add(handle);
    }
  }
  return [...handles];
}

/**
 * Close the write handle a stopped agent leaves behind.
 *
 * This is the difference between "the session is stopped" and "the session can
 * be moved". An idle agent that was opened once still holds the log writer;
 * Windows refuses to rename a directory that contains an open file, and no
 * amount of retrying changes that, because nothing is racing — the handle simply
 * stays. Closing it is a per-handle operation, so unlike a scope dispose it
 * cannot unload anything else.
 *
 * Best effort by design: a backend that does not expose its tracker (or a
 * handle it refuses to close) leaves the caller with a rename that fails and
 * says why. Nothing here may throw.
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @param {{ closeTimeoutMs?: number }} [options]
 * @returns {Promise<{ closed: number, stillOwned: boolean }>}
 */
export async function releaseWriters(ctx, sessionId, options = {}) {
  const id = String(sessionId ?? "");
  const persistence = ctx ? getService(ctx, "sessionPersistence") : undefined;
  if (!persistence || id === "") return { closed: 0, stillOwned: false };
  const timeoutMs = Number.isFinite(options.closeTimeoutMs)
    ? Number(options.closeTimeoutMs)
    : CLOSE_TIMEOUT_MS;
  let closed = 0;
  for (const handle of writeHandlesOf(persistence, id)) {
    const close = handle?.close;
    if (typeof close !== "function") continue;
    if (CLOSED_HANDLES.has(handle)) continue;
    const result = await bounded(Promise.resolve().then(() => close.call(handle)), timeoutMs);
    if (result.done) {
      CLOSED_HANDLES.add(handle);
      closed += 1;
    }
  }
  // A close starts an asynchronous retirement inside the backend: the file is
  // released only after the queued writes land. Waiting for it is what makes the
  // rename that follows reliable instead of a coin flip.
  const retirement = persistence?.coordinator?.retirements?.get?.(id);
  if (retirement) await bounded(Promise.resolve(retirement), timeoutMs);
  let stillOwned = false;
  try {
    stillOwned = persistence?.coordinator?.states?.get?.(id)?.owner !== undefined;
  } catch {
    stillOwned = false;
  }
  return { closed, stillOwned };
}

/**
 * Write out whatever the session has buffered, so the move takes every event
 * with it. Best effort: a profile without a session registry has nothing to
 * flush.
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function flushSession(ctx, sessionId) {
  const sessions = getService(ctx, "sessions");
  if (!sessions || typeof sessions.flush !== "function") return;
  const session = sessionOf(sessions, String(sessionId ?? ""));
  // Nothing live means nothing buffered: a detached session has already had its
  // writer drained and closed by the host, and flushing by id alone would throw.
  if (!session) return;
  try {
    await sessions.flush(session);
  } catch {
    /* a flush that throws is the host's business; the move is still attempted */
  }
}

/**
 * Take the file locks off a session a move is about to relocate.
 *
 * An idle session is not writable in theory, and yet "open it once and it can
 * never be moved again" is exactly what users hit: the agent keeps a write handle
 * on the log (and the persistence layer a write-behind that re-creates the file at
 * the old path after the rename), and Windows refuses a directory rename while
 * anything still holds a file inside it. Flushing and closing that handle is what
 * releases the directory.
 *
 * Dropping the agent's registry row would release it too, but `detach()` emits
 * `session/disposed` and every client then drops the row the user is looking at —
 * the "moved the session and it vanished" report. So the row is left standing
 * here; a caller that still cannot rename goes one step further by itself.
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function releaseForMove(ctx, sessionId) {
  // Buffered events first, then the handle: the flush appends through the
  // writer, so it has to happen before the writer goes away.
  await flushSession(ctx, sessionId);
  await releaseWriters(ctx, sessionId);
}
/**
 * Point the session's open bookkeeping at the header the payload now carries.
 *
 * Rewriting the stored header moves the bytes, but three in-memory copies keep
 * the old cwd: the persistence write handle's `header` (which decides where the
 * next append reopens the log — left alone, the next turn re-creates the old
 * project directory and the conversation splits in two across a ghost log), the
 * live session's own `header`, and the registry's header index. DSH hands out a
 * deep-frozen header (packages/core/session/src/index.ts:566-574), so these are
 * replaced rather than mutated; each assignment is its own try/catch because a
 * frozen carrier refusing the write is not a reason to abandon a finished move.
 *
 * Best effort by design: a profile with no persistence tracker, no live session
 * and no registry still moves the bytes.
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @param {any} header the header the payload now stores
 * @returns {{ writer: boolean, live: boolean }} what was actually repointed
 */
export function repointSession(ctx, sessionId, header) {
  const id = String(sessionId ?? "");
  const outcome = { writer: false, live: false };
  if (!ctx || id === "" || !header || typeof header !== "object") return outcome;
  const persistence = getService(ctx, "sessionPersistence");
  for (const handle of writeHandlesOf(persistence, id)) {
    try {
      handle.header = { ...(handle.header ?? {}), ...header, id };
      outcome.writer = true;
    } catch {
      /* a frozen handle keeps the old cwd; the move itself still stands */
    }
  }
  const live = sessionOf(getService(ctx, "sessions"), id);
  if (live) {
    try {
      live.header = { ...(live.header ?? {}), ...header, id };
      outcome.live = true;
    } catch {
      /* same: a frozen session object is not a failed move */
    }
  }
  return outcome;
}
/**
 * Let go of the session: `detach()` emits `session/disposed`, which is what
 * makes every client drop the row and the persistence layer do its last drain.
 * The short settle lets that retirement land.
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @param {{ settleMs?: number }} [options]
 * @returns {Promise<boolean>} whether anything was detached
 */
export async function detachSession(ctx, sessionId, options = {}) {
  const id = String(sessionId ?? "");
  const sessions = getService(ctx, "sessions");
  const settleMs = Number.isFinite(options.settleMs) ? Number(options.settleMs) : SETTLE_MS;
  let detached = false;
  try {
    // `detach` lives on the carrier entry, not on the session: the entry's
    // `detach()` is what removes the row, clears the attachment and emits
    // `session/disposed`. A host that exposes it on the session itself is
    // served by the second lookup.
    const entry = sessions?.store?.get?.(id) ?? null;
    const target = typeof entry?.detach === "function" ? entry : (sessionOf(sessions, id) ?? null);
    const detach = target?.detach;
    if (typeof detach === "function") {
      detach.call(target);
      detached = true;
    }
  } catch {
    /* no detach on this profile: the move has already happened */
  }
  // Only wait when there is something to wait for: a profile that never lent a
  // session store must not pay 200 ms per id in a batch delete.
  if (detached && settleMs > 0) await sleep(settleMs);
  return detached;
}

/**
 * Tell the clients a session is gone.
 *
 * DSH relays `api-session/removed` from `session/disposed`, and only a live
 * session ever emits that: a *cold* session — one DSH never opened in this run,
 * which is exactly a row the sidebar renders from the persisted list — has no
 * Session instance to dispose, so its deletion is silent. The client keeps the
 * row until the next full reload, and opening it resolves to nothing: the
 * "无效" tab users report after deleting a session. Emitting the same event by
 * hand is what DSH's own session manager does for the cold case.
 *
 * Best effort, and never on a profile without an event bus.
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @returns {boolean} whether the event went out
 */
export function announceSessionRemoved(ctx, sessionId) {
  const id = String(sessionId ?? "");
  if (!ctx || id === "" || typeof ctx.emit !== "function") return false;
  try {
    ctx.emit("api-session/removed", id);
    return true;
  } catch {
    return false;
  }
}
