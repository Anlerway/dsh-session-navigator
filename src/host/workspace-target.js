/**
 * dsh-session-navigator — the workspace a move is aiming at.
 *
 * A target is not just an id: it is an id, the title beside it, and the spelling
 * of a directory that DSH will accept as that workspace's own path. That third
 * part is compared as a string, not as a location — the registry folds a
 * session's cwd through realpath and then demands `===` the path it stored when
 * the workspace was added (that package's entity.ts:152, via realpathNormalize
 * in paths.ts:52-57) — so the header is written with the realpath spelling, and
 * the attach that follows is allowed to disagree: `attachThroughIndex` files the
 * session through the entity's own ledger write when it does.
 */

import { mkdir, realpath } from "node:fs/promises";

import { codedError } from "../store/sidecar.js";
import { releaseWriters, stopSession } from "./live-session.js";
import { registryOrNull } from "./registry.js";

/**
 * @param {any} error
 * @returns {string}
 */
function messageOf(error) {
  return String(error?.message ?? error);
}
/**
 * Make sure the target workspace's directory exists.
 *
 * The registry is the authority on which workspaces exist; the directory on
 * disk is only where their payload goes. A workspace whose folder was deleted
 * by hand (or whose drive was unmounted) is still a workspace — it still has a
 * row, a title and its other sessions — so refusing the move with "目标工作区
 * 不存在" answers a question nobody asked and leaves the user unable to file
 * anything there. Re-create the directory instead, and only report a missing
 * workspace when the directory cannot be made.
 *
 * @param {string} path absolute workspace path
 * @returns {Promise<void>}
 */
export async function ensureWorkspaceDir(path) {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    throw codedError("workspace-not-found", `workspace directory ${path} cannot be created: ${messageOf(error)}`);
  }
}

/**
 * The spelling of the target directory a header is written with.
 *
 * `attachSession` does not compare paths, it compares *strings*: it folds the
 * header's cwd through its own realpath and then requires that result to be
 * `===` the workspace record's path (packages/workspace/workspace/src/entity.ts
 * :152, fed by realpathNormalize in that package's paths.ts:52-57). The
 * realpath spelling is therefore the only one a header can carry and still be
 * validated against a record DSH created from a directory picker.
 *
 * A record that spells its folder differently — Windows reaches one directory
 * as `C:\Users\RUNNER~1\…` through %TEMP% and as `C:\Users\runneradmin\…`
 * through realpath, and a re-added workspace can carry other capitalisation —
 * cannot satisfy that `===` from this side whatever header is written. It is
 * not refused here: refusing would make such a workspace impossible to file
 * into, and the payload would be the thing left in the wrong place. The header
 * carries this spelling, `attachThroughIndex` then falls back to the entity's
 * own ledger write, and the session stays where the user dropped it.
 *
 * @param {{ id: string, title: string, path: string }} resolved
 * @returns {Promise<string>} the path to store as the header's cwd
 */
export async function canonicalWorkspacePath(resolved) {
  try {
    return await realpath(resolved.path);
  } catch (error) {
    throw codedError(
      "workspace-not-found",
      `workspace directory ${resolved.path} cannot be opened: ${messageOf(error)}`,
    );
  }
}

/**
 * Attach through the registry, translating DSH's own sentence when it refuses.
 *
 * The registry answers a failed attach with one long line naming the session,
 * the workspace and the path it actually resolved to. That is the right thing
 * to log and the wrong thing to put on a status bar, so it becomes the detail
 * behind a short sentence whose code names the next step.
 *
 * @param {any} entity
 * @param {string} sessionId
 * @param {string} workspacePath
 * @returns {Promise<void>}
 */
export async function attachOrExplain(entity, sessionId, workspacePath) {
  try {
    await entity.attachSession(sessionId);
  } catch (error) {
    const text = String(/** @type {any} */ (error)?.message ?? error ?? "").trim();
    const resolvedTo = /its cwd resolves to '([^']*)'/i.exec(text);
    if (resolvedTo) {
      throw codedError(
        "workspace-path-mismatch",
        `session ${sessionId} is filed under ${workspacePath}, but its cwd resolves to ${resolvedTo[1]}`,
      );
    }
    if (/\bcarries no cwd\b/i.test(text)) {
      throw codedError("session-corrupt", `session ${sessionId} has no cwd in its header: ${text}`);
    }
    if (/\bdoes not resolve\b|\bis not a directory\b/i.test(text)) {
      throw codedError(
        "workspace-path-mismatch",
        `session ${sessionId} cannot be validated against ${workspacePath}: ${text}`,
      );
    }
    throw error;
  }
}

/**
 * The workspace registry (native service), or a coded error.
 *
 * @param {any} ctx
 * @returns {any}
 */
export function registryOf(ctx) {
  const registry = registryOrNull(ctx);
  if (!registry) {
    throw codedError("capability-missing", "this DSH build mounts no workspace registry, so sessions cannot be moved");
  }
  return registry;
}


/**
 * Resolve a target workspace entity and the canonical directory its sessions
 * must claim.
 *
 * @param {any} registry
 * @param {any} target
 * @returns {{ id: string, title: string, path: string }}
 */
export async function resolveTarget(registry, target) {
  const workspaceId = typeof target?.workspaceId === "string" ? target.workspaceId : "";
  if (!workspaceId) throw codedError("bad-request", "a target workspace id is required");
  const entity = registry.list().find((candidate) => candidate?.id === workspaceId);
  if (!entity) throw codedError("workspace-not-found", `workspace ${workspaceId} does not exist`);
  const path = typeof entity.path === "string" ? entity.path : "";
  if (!path) throw codedError("workspace-not-found", `workspace ${workspaceId} has no directory`);
  return { id: workspaceId, title: entity.title || workspaceId, path };
}

/**
 * Teach the registry's header index the cwd the payload now carries.
 *
 * The registry answers "which cwd does this session have?" from the index, and
 * its membership test is `sessionPaths.get(id) === record.path`
 * (packages/workspace/workspace/src/index.ts:200-217, whose
 * `rememberSessionPath` sets that map and clears the missing/invalid sets). A
 * session left in those sets keeps a stale answer, and the entity's
 * `sessionIds` getter then filters the moved id straight back out of its own
 * workspace (entity.ts:110-112) — the row silently disappears from the sidebar
 * even though every byte moved. So the index is corrected before anything is
 * attached.
 *
 * @param {any} registry
 * @param {string} sessionId
 * @param {string} workspacePath
 * @param {any} header the header the payload now stores
 */
function teachIndex(registry, sessionId, workspacePath, header) {
  if (!registry) return;
  if (header && typeof registry.headers?.set === "function") registry.headers.set(sessionId, header);
  registry.host?.rememberSessionPath?.(sessionId, workspacePath);
  registry.invalidSessionPaths?.delete?.(sessionId);
  registry.missingSessionPaths?.delete?.(sessionId);
}

/**
 * Write the membership ledger through the entity's own single write path.
 *
 * `mutate` is what `attachSession` itself ends in (entity.ts:160-162), applying
 * the same idempotence, so this is the official write with the validation step
 * skipped rather than a hand edit of stored state.
 *
 * @param {any} entity
 * @param {string} sessionId
 * @returns {Promise<boolean>} whether the ledger could be written at all
 */
async function writeLedger(entity, sessionId) {
  if (typeof entity?.mutate !== "function") return false;
  const current = Array.isArray(entity.record?.sessionIds) ? entity.record.sessionIds : [];
  if (current.includes(sessionId)) return true;
  await entity.mutate((record) => (Array.isArray(record?.sessionIds) && record.sessionIds.includes(sessionId)
    ? record
    : { ...record, sessionIds: [sessionId, ...(record?.sessionIds ?? [])] }));
  return true;
}

/**
 * Attach to the target without ever refusing a payload that is already there.
 *
 * `attachSession` validates the session's cwd against the workspace path, and
 * it reads that cwd from the registry index — which prefers a *live* session's
 * in-memory header (packages/workspace/workspace/src/index.ts:892-897), while a
 * live header is deep-frozen creation metadata that no move can rewrite
 * (packages/core/session/src/index.ts:566-574). The session is left open on
 * purpose here: detaching it would make every client drop the row
 * (`session/disposed` → `api-session/removed`), which is worse than the stale
 * header. So the index is taught the new truth first, the ordinary attach is
 * tried next, and only the refusal the stale header causes falls through to a
 * direct ledger write.
 *
 * A genuine disagreement between the spellings still surfaces: that one fails
 * the very same way, but `teachIndex` cannot fix it, so the message from
 * `attachOrExplain` is what the user ends up reading.
 *
 * @param {any} ctx host context (logger only; a profile without one is fine)
 * @param {any} entity target workspace entity
 * @param {string} sessionId
 * @param {string} workspacePath
 * @param {any} header the header the payload now stores
 * @returns {Promise<void>}
 */
export async function attachThroughIndex(ctx, entity, sessionId, workspacePath, header) {
  teachIndex(registryOrNull(ctx), sessionId, workspacePath, header);
  try {
    await attachOrExplain(entity, sessionId, workspacePath);
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== "workspace-path-mismatch") throw error;
    if (!(await writeLedger(entity, sessionId))) throw error;
    ctx?.logger?.warn?.(`session-navigator: attach refused for ${sessionId} (${/** @type {any} */ (error)?.message ?? error}); wrote the membership ledger directly`);
  }
}

/**
 * Is this error "a lock, and nothing worse"?
 *
 * `renameWithRetry` turns a spent retry budget into `session-busy`, while a
 * first-attempt failure still arrives as the raw `EBUSY`/`EPERM`/`EACCES` code;
 * both mean the same thing here, and both are worth one harder attempt.
 *
 * @param {any} error
 * @returns {boolean}
 */
function isLockError(error) {
  const code = /** @type {any} */ (error)?.code;
  return code === "session-busy" || code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

/**
 * Relocate the payload, going one step harder if the directory stays locked.
 *
 * {@link releaseForMove} already took the cheap locks off and left the session on
 * screen. When Windows still refuses the rename something else holds a file in
 * there, and the only bigger hammer is to take the session away from the host
 * entirely — which costs the user the row, so it is the last resort and the last
 * attempt.
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @param {(from: string, to: string) => Promise<void>} relocate
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
export async function relocateReleasing(ctx, sessionId, relocate, from, to) {
  try {
    await relocate(from, to);
    return;
  } catch (error) {
    if (!isLockError(error)) throw error;
    const stopped = await stopSession(ctx, sessionId);
    if (stopped.stillRunning) throw error;
    await releaseWriters(ctx, sessionId);
    await relocate(from, to);
  }
}
