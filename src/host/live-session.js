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
 * The delete is therefore split into three steps, each called at the point it
 * belongs to:
 *
 *   stopSession    cancel the agent, dispose it, drop its registry row. Before
 *                  the move: nothing may keep writing into the directory.
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

/** How long a dispose may take before the session counts as unstoppable. */
const DISPOSE_TIMEOUT_MS = 3000;

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
 * The live agent record for a session id, from either registry shape.
 *
 * @param {any} agents
 * @param {string} id
 * @returns {any}
 */
function agentOf(agents, id) {
  try {
    if (typeof agents?.get === "function") return agents.get(id) ?? null;
    const list = agents?.list?.();
    if (!Array.isArray(list)) return null;
    return list.find((agent) => agent?.id === id || agent?.sessionId === id) ?? null;
  } catch {
    return null;
  }
}

/**
 * The live session record for a session id.
 *
 * @param {any} sessions
 * @param {string} id
 * @returns {any}
 */
function sessionOf(sessions, id) {
  try {
    if (typeof sessions?.get === "function") return sessions.get(id) ?? null;
    const store = sessions?.store;
    if (typeof store?.get === "function") return store.get(id) ?? null;
    return null;
  } catch {
    return null;
  }
}

/**
 * Dispose an agent, but never wait on it forever.
 *
 * A cancel that resolves is the normal path. `scope.dispose()` is the one that
 * releases the writer, so it races a timer: an agent wedged in a tool call must
 * not hold the delete dialog open.
 *
 * @param {any} agent
 * @param {number} timeoutMs
 */
async function disposeAgent(agent, timeoutMs) {
  const dispose = agent?.scope?.dispose;
  if (typeof dispose !== "function") return;
  try {
    await Promise.race([
      Promise.resolve(dispose.call(agent.scope)),
      sleep(timeoutMs),
    ]);
  } catch {
    /* a throwing dispose is reported through the status re-read below */
  }
}

/**
 * Stop a live session before its directory moves. Safe for a session that is
 * not open at all.
 *
 * @param {any} ctx plugin context; missing services are skipped
 * @param {string} sessionId
 * @param {{ disposeTimeoutMs?: number }} [options]
 * @returns {Promise<{ wasRunning: boolean, stillRunning: boolean }>}
 */
export async function stopSession(ctx, sessionId, options = {}) {
  const id = String(sessionId ?? "");
  if (!ctx || id === "") return { wasRunning: false, stillRunning: false };
  const timeoutMs = Number.isFinite(options.disposeTimeoutMs)
    ? Number(options.disposeTimeoutMs)
    : DISPOSE_TIMEOUT_MS;

  const agents = getService(ctx, "agents");
  const agent = agentOf(agents, id);
  if (!agent) return { wasRunning: false, stillRunning: false };
  const wasRunning = agent.status === "running";
  try {
    await agent.cancel?.({ kind: "disposed" });
  } catch {
    /* already gone, or the agent refuses to cancel; the re-read decides */
  }
  await disposeAgent(agent, timeoutMs);
  // Deleting the registry row is what stops a disposed agent from being
  // re-listed (and re-persisted) while the directory is already moving.
  try {
    agents?.store?.delete?.(id);
  } catch {
    /* older registries have no delete; detaching the session still helps */
  }
  return { wasRunning, stillRunning: agentOf(agents, id)?.status === "running" };
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
  try {
    await sessions.flush(sessionOf(sessions, String(sessionId ?? "")) ?? undefined);
  } catch {
    /* a flush that throws is the host's business; the move is still attempted */
  }
}

/**
 * Let go of the session: `detach()` emits `session/disposed`, which is what
 * makes every client drop the row and the persistence layer do its last drain.
 * The short settle lets that retirement land.
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @param {{ settleMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function detachSession(ctx, sessionId, options = {}) {
  const id = String(sessionId ?? "");
  const sessions = getService(ctx, "sessions");
  const settleMs = Number.isFinite(options.settleMs) ? Number(options.settleMs) : SETTLE_MS;
  let detached = false;
  try {
    const session = sessions?.store?.get?.(id) ?? null;
    const detach = session?.detach;
    if (typeof detach === "function") {
      detach.call(session);
      detached = true;
    }
  } catch {
    /* no detach on this profile: the move has already happened */
  }
  // Only wait when there is something to wait for: a profile that never lent a
  // session store must not pay 200 ms per id in a batch delete.
  if (detached && settleMs > 0) await sleep(settleMs);
}
