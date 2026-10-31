/**
 * dsh-session-navigator — which sessions are live, as the kernel sees it.
 *
 * "进行中" cannot be answered from the log files: a log that ends inside a turn
 * means the turn was cut off, not that someone is writing it right now. The only
 * truthful source is the process that owns the agents.
 *
 * The wrong source was used until now: `ctx.sessions` lists every session the
 * process has *loaded* — every one the user has opened since launch, idle ones
 * included — so taking that list as "running" painted 进行中 on the whole sidebar
 * after a restart, and kept it there for sessions that had finished hours
 * earlier.
 *
 * `ctx.agents` carries the answer: one agent per live session, its `status` is
 * `running` exactly while a driver is active (`packages/core/agent/src/
 * runtime-types.ts:102-109`), and an agent's id *is* its session id
 * (`AgentRegistry.get(id: SessionId)`, `packages/core/agent/src/index.ts:568`).
 * That is the same answer DSH's own sidebar renders.
 */

import { getService } from "../capabilities.js";

/**
 * @typedef {object} LiveSessions
 * @property {Set<string>} running session ids whose agent is running right now
 * @property {Set<string>} idle session ids whose agent exists but is not driving
 * @property {"agents" | "sessions" | "none"} source which registry answered
 */

/**
 * Read the live session sets.
 *
 * Every lookup is defensive: a profile without the agent row still needs a
 * listing, and a service that throws mid-read must degrade to "nothing is
 * running" rather than fail `/bootstrap`.
 *
 * @param {any} ctx the plugin context
 * @returns {LiveSessions}
 */
export function liveSessions(ctx) {
  /** @type {Map<string, boolean>} id → running */
  const agents = new Map();
  const registry = getService(ctx, "agents");
  if (registry && typeof registry.list === "function") {
    let list = null;
    try {
      list = registry.list();
    } catch {
      list = null;
    }
    if (Array.isArray(list)) {
      for (const agent of list) {
        const id = idOf(agent);
        if (!id) continue;
        // A replaced agent keeps the session id, and the newest one wins: the
        // registry returns registration order, so a later entry is the live one.
        agents.set(id, agent?.status === "running");
      }
      return split(agents, "agents");
    }
  }

  // No agent registry: the session registry is all there is. It cannot tell
  // running from idle, so nothing is reported as running — a wrong 进行中 is
  // worse than a missing one, because 进行中 blocks archive and delete.
  const sessions = getService(ctx, "sessions");
  if (!sessions) return { running: new Set(), idle: new Set(), source: "none" };
  for (const id of sessionIdsOf(sessions)) agents.set(id, false);
  return split(agents, "sessions");
}

/**
 * Ids of the sessions the session registry holds, in either shape it exposes.
 *
 * @param {any} sessions
 * @returns {string[]}
 */
function sessionIdsOf(sessions) {
  try {
    if (Array.isArray(sessions.ids)) return sessions.ids.map(String);
    if (typeof sessions.list !== "function") return [];
    const listed = sessions.list();
    if (!Array.isArray(listed)) return [];
    const ids = [];
    for (const entry of listed) {
      const id = typeof entry === "string" ? entry : idOf(entry);
      if (id) ids.push(id);
    }
    return ids;
  } catch {
    /* an unreadable registry means "nothing is known to be live" */
    return [];
  }
}

/**
 * @param {any} agent
 * @returns {string | null}
 */
function idOf(agent) {
  const raw = agent?.id ?? agent?.session?.id;
  if (raw === undefined || raw === null) return null;
  const id = String(raw);
  return id === "" ? null : id;
}

/**
 * @param {Map<string, boolean>} statuses
 * @param {LiveSessions["source"]} source
 * @returns {LiveSessions}
 */
function split(statuses, source) {
  /** @type {Set<string>} */
  const running = new Set();
  /** @type {Set<string>} */
  const idle = new Set();
  for (const [id, isRunning] of statuses) {
    if (isRunning) running.add(id);
    else idle.add(id);
  }
  return { running, idle, source };
}
