/**
 * dsh-session-navigator — workspace-registry accounting.
 *
 * A session appears in two places that do not follow each other: the panel lists
 * whatever artifacts exist under `<home>/sessions`, while DSH's own sidebar
 * lists the ids each workspace accounts for in its registry
 * (`<home>/storages/workspace.json`). Moving a directory therefore makes the
 * row disappear from the panel and *not* from DSH — and a session the user has
 * open in DSH keeps its tab alive, which is what "deleted but still there"
 * looked like.
 *
 * Every helper here tolerates a host without a registry: older hosts, and the
 * unit tests that build an api out of files alone, have no `ctx`. Callers decide
 * whether a missing or refusing registry is fatal, because only they know
 * whether their own file work can still be undone.
 */

import { getService } from "../capabilities.js";

/**
 * The workspace registry, or null when this host does not expose one.
 *
 * @param {any} ctx
 * @returns {any}
 */
export function registryOrNull(ctx) {
  const registry = getService(ctx, "workspaceRegistry") ?? getService(ctx, "workspaces");
  return registry && typeof registry.list === "function" ? registry : null;
}

/**
 * One workspace entity by id, or null.
 *
 * @param {any} registry
 * @param {string} workspaceId
 * @returns {any}
 */
function entityOf(registry, workspaceId) {
  const list = registry.list();
  if (!Array.isArray(list)) return null;
  return list.find((entity) => entity?.id === workspaceId) ?? null;
}

/**
 * The raw id list one entity holds.
 *
 * `entity.sessionIds` is a filtered view: it hides ids whose stored `cwd` no
 * longer resolves to the workspace path, and an id whose payload was just moved
 * away is exactly such an id. Reading `record.sessionIds` first is what makes a
 * detach possible after the move.
 *
 * @param {any} entity
 * @returns {string[]}
 */
function idsOf(entity) {
  if (Array.isArray(entity?.record?.sessionIds)) return entity.record.sessionIds;
  if (Array.isArray(entity?.sessionIds)) return entity.sessionIds;
  return [];
}

/**
 * Every workspace that currently accounts for one session.
 *
 * @param {any} registry
 * @param {string} sessionId
 * @returns {string[]}
 */
export function holdersOf(registry, sessionId) {
  /** @type {string[]} */
  const ids = [];
  for (const entity of registry.list()) {
    if (idsOf(entity).includes(sessionId)) ids.push(entity.id);
  }
  return ids;
}

/**
 * Run one registry mutation on the registry's own write chain when it has one.
 *
 * DSH serialises registry writes through `enqueueOperation`. Bypassing it would
 * let our detach race a concurrent rename or attach and lose one of them.
 *
 * @param {any} registry
 * @param {() => Promise<void>} operation
 * @returns {Promise<void>}
 */
export async function enqueue(registry, operation) {
  if (typeof registry.enqueueOperation === "function") return registry.enqueueOperation(operation);
  return operation();
}

/**
 * Drop one session from every workspace that still accounts for it.
 *
 * @param {any} registry
 * @param {string} sessionId
 * @returns {Promise<string[]>} the workspace ids it was detached from
 */
export async function detachEverywhere(registry, sessionId) {
  // Nothing to say means nothing to write: a startup pass over every entry in
  // the bin must not rewrite the registry for the ones that are already clean.
  if (holdersOf(registry, sessionId).length === 0) return [];
  /** @type {string[]} */
  let detached = [];
  await enqueue(registry, async () => {
    // Re-read inside the write chain: another window may have moved the same
    // session in between, and detaching twice is a no-op, but detaching from a
    // stale list can miss the workspace that now holds it.
    const holders = holdersOf(registry, sessionId);
    for (const workspaceId of holders) {
      const entity = entityOf(registry, workspaceId);
      if (typeof entity?.detachSession !== "function") continue;
      await entity.detachSession(sessionId);
      detached.push(workspaceId);
    }
  });
  return detached;
}

/**
 * Account one session to a workspace again, the way a restore expects.
 *
 * `attachSession` validates the header's `cwd` against the workspace path and
 * throws when that directory is gone, so a caller should treat a rejection as
 * "the panel still has it, DSH's sidebar does not" rather than as a failed
 * restore.
 *
 * @param {any} registry
 * @param {string} workspaceId
 * @param {string} sessionId
 * @returns {Promise<boolean>} whether the workspace accepted it
 */
export async function attachTo(registry, workspaceId, sessionId) {
  if (!workspaceId) return false;
  const entity = entityOf(registry, workspaceId);
  if (typeof entity?.attachSession !== "function") return false;
  await enqueue(registry, async () => {
    await entity.attachSession(sessionId);
  });
  return true;
}
