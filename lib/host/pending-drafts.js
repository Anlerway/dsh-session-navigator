/**
 * dsh-session-navigator — filing a draft into the folder it was asked from.
 *
 * DSH can only start a session *in a workspace*: `uiWorkspace.startSession(workspaceId)`
 * opens a draft at that workspace's root, and the sidebar it draws has no level
 * below a workspace at all. Folders are this plugin's idea, so the plugin is the
 * one that has to put the row in one — and it cannot do that before the session
 * exists, because the session id is DSH's to make.
 *
 * Three shapes were possible, and this module is the third:
 *
 *   1  ask DSH for a draft inside the folder — no such API (the only parameter
 *      is the workspace, see `startSession` in the GUI bundle);
 *   2  guess from the log afterwards which session "looks new" — a session the
 *      user opened in DSH's own sidebar two seconds earlier looks exactly the
 *      same, and filing that one would move a conversation the user never
 *      asked this plugin to touch;
 *   3  remember the intent. The panel says "a draft is about to be opened in
 *      this folder, and these are the sessions that exist right now", and the
 *      first session that appears afterwards *in that workspace* is that draft.
 *
 * An intent is deliberately short-lived and one per folder: a click that never
 * becomes a session (the user closed the draft) must not file the next session
 * they create in DSH's own sidebar ten minutes later. Two minutes is a long
 * time for a request the panel sent milliseconds before asking DSH to open the
 * draft; past it, the intent is dropped and the draft quietly stays where DSH
 * put it — the pre-existing behaviour, never a wrong home.
 *
 * @module lib/host/pending-drafts
 */

/** How often an armed intent looks for the session it is waiting for. */
const DEFAULT_POLL_MS = 1500;

/** How long an armed intent stays armed. */
const DEFAULT_TTL_MS = 120_000;

/**
 * How far before the intent a session may have been created and still count.
 *
 * The panel arms the intent and calls `startSession` in the same tick, but the
 * two requests travel on different wires: the draft can win by a few
 * milliseconds. A window this small cannot swallow a session a user made by
 * hand, and it cannot admit one either — such a session would have to be born
 * within three seconds of a click that was itself opening a draft.
 */
const SLACK_MS = 3_000;

/**
 * @typedef {object} PendingIntent
 * @property {string} parent folder node id the draft belongs in
 * @property {string} workspaceId workspace the draft was opened in
 * @property {number} since host clock when the intent was armed
 * @property {number} expiresAt host clock when the intent is dropped
 * @property {Set<string>} known session ids that existed when it was armed
 */

/**
 * @param {object} options
 * @param {(options?: { refresh?: boolean }) => Promise<any>} options.readSnapshot
 *   the session listing (`api.reader.snapshot`)
 * @param {(sessionId: string, parent: string) => Promise<any>} options.place
 *   writes one placement, and tells the other document if it can
 * @param {() => number} [options.now] injectable clock, for the tests
 * @param {(level: string, message: string) => void} [options.log]
 * @param {number} [options.pollMs]
 * @param {number} [options.ttlMs]
 */
export function createPendingDrafts(options = {}) {
  const { readSnapshot, place, log } = options;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : DEFAULT_POLL_MS;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;

  /** @type {Map<string, PendingIntent>} */
  const intents = new Map();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let disposed = false;
  let settling = false;

  /**
   * Remember that the next session in `workspaceId` belongs in `parent`.
   *
   * One intent per folder: clicking 新建会话 twice while standing in the same
   * folder means the second click supersedes the first, not that two sessions
   * belong there.
   *
   * @param {{ parent: string, workspaceId: string, known?: Iterable<string> }} request
   * @returns {{ parent: string, workspaceId: string, since: number, expiresAt: number }}
   */
  function arm(request) {
    const parent = typeof request?.parent === "string" ? request.parent : "";
    const workspaceId = typeof request?.workspaceId === "string" ? request.workspaceId : "";
    if (!parent || !workspaceId) throw new Error("pending draft: parent and workspaceId are required");
    const since = now();
    /** @type {PendingIntent} */
    const intent = {
      parent,
      workspaceId,
      since,
      expiresAt: since + ttlMs,
      known: new Set(request.known ?? []),
    };
    intents.delete(parent);
    intents.set(parent, intent);
    schedule();
    return publicView(intent);
  }

  /** @param {string} parent */
  function cancel(parent) {
    return intents.delete(String(parent));
  }

  /** @returns {{ parent: string, workspaceId: string, since: number, expiresAt: number }[]} */
  function list() {
    return [...intents.values()].map(publicView);
  }

  /**
   * Look for the sessions the armed intents are waiting for, and file them.
   *
   * Exposed because it is the whole behaviour, and a test that has to wait for
   * a timer is a test that fails on a slow machine. The poll calls it too.
   *
   * @returns {Promise<{ parent: string, sessionId: string, workspaceId: string }[]>}
   */
  async function settle() {
    if (disposed || settling || intents.size === 0) return [];
    settling = true;
    /** @type {{ parent: string, sessionId: string, workspaceId: string }[]} */
    const filed = [];
    try {
      const snapshot = await readSnapshot({});
      const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
      const tree = snapshot?.tree ?? { nodes: {} };
      const nodes = tree.nodes ?? {};
      const placed = tree.sessionPlacement ?? {};
      for (const intent of [...intents.values()]) {
        if (now() > intent.expiresAt) {
          intents.delete(intent.parent);
          log?.("debug", `pending draft: gave up on ${intent.parent} (nothing appeared in time)`);
          continue;
        }
        // The folder was deleted or moved out of the workspace while the intent
        // was armed. Writing the placement anyway would file the row into a node
        // no view draws, so the intent dies with its container.
        if (!nodes[intent.parent]) {
          intents.delete(intent.parent);
          log?.("debug", `pending draft: dropped ${intent.parent} (the folder is gone)`);
          continue;
        }
        const pick = sessions.find((session) => isCandidate(session, intent, placed));
        if (!pick) continue;
        try {
          await place(pick.id, intent.parent);
        } catch (error) {
          // A refusal is final: the same ask would be refused again on the next
          // tick. The draft keeps the home DSH gave it.
          intents.delete(intent.parent);
          log?.("warn", `pending draft: cannot file ${pick.id} in ${intent.parent}: ${messageOf(error)}`);
          continue;
        }
        intents.delete(intent.parent);
        filed.push({ parent: intent.parent, sessionId: pick.id, workspaceId: intent.workspaceId });
      }
    } catch (error) {
      log?.("warn", "pending draft: settle failed: " + messageOf(error));
    } finally {
      settling = false;
      if (intents.size === 0) stop();
    }
    if (filed.length > 0) {
      log?.("info", "pending draft: filed " + filed.map((row) => `${row.sessionId} in ${row.parent}`).join(", "));
    }
    return filed;
  }

  function schedule() {
    if (disposed || timer || intents.size === 0) return;
    timer = setTimeout(tick, pollMs);
    // Node keeps the process alive for a pending timer; a sidecar with nothing
    // to do should not.
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  async function tick() {
    timer = null;
    if (disposed) return;
    await settle();
    schedule();
  }

  function dispose() {
    disposed = true;
    intents.clear();
    stop();
  }

  return {
    arm,
    cancel,
    list,
    settle,
    dispose,
    get size() {
      return intents.size;
    },
    get pollMs() {
      return pollMs;
    },
    get ttlMs() {
      return ttlMs;
    },
  };
}

/**
 * Whether `session` is the draft an intent is waiting for.
 *
 * Every test here is a reason the row is *not* the draft: another workspace's
 * session was never going to land in this folder; a subagent and a trashed
 * session have no place of their own; a session that already carries a
 * placement was filed by someone who meant it; and a session older than the
 * intent existed before the click.
 *
 * @param {any} session
 * @param {PendingIntent} intent
 * @param {Record<string, string>} placed session id → container node id
 * @returns {boolean}
 */
function isCandidate(session, intent, placed) {
  if (!session || typeof session.id !== "string" || session.id === "") return false;
  if (session.trashed === true || session.archived === true) return false;
  if (session.isSubagent === true) return false;
  if ((session.workspaceId ?? null) !== intent.workspaceId) return false;
  if (placed[session.id] !== undefined && placed[session.id] !== null) return false;
  const created = Number.isFinite(session.createdAt) ? session.createdAt : null;
  // A header without `createdAt` (a log this build does not tag) can only be
  // recognised by not having been there when the intent was armed.
  if (created === null) return !intent.known.has(session.id);
  return created >= intent.since - SLACK_MS;
}

/**
 * @param {PendingIntent} intent
 * @returns {{ parent: string, workspaceId: string, since: number, expiresAt: number }}
 */
function publicView(intent) {
  return {
    parent: intent.parent,
    workspaceId: intent.workspaceId,
    since: intent.since,
    expiresAt: intent.expiresAt,
  };
}

/**
 * @param {any} error
 * @returns {string}
 */
function messageOf(error) {
  return String(error?.message ?? error);
}
