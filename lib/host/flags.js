/**
 * dsh-session-navigator — 收藏 / 待办 migrate into shortcuts.
 *
 * 收藏 and 待办 used to be two boolean flags in `annotations.v1.json`
 * (`favorite`, `todo`). They are *shortcut containers* now: putting a session in
 * 收藏 creates a `s-…` node that points at it, and removing it deletes that node
 * — the session file is never touched. Membership is therefore derived from
 * `tree.v1.json` (see lib/sources/reader.js), and the old flags are history.
 *
 * This module is the one-way door between the two: on start, every session the
 * old flags mark is given the shortcut it would have had, and the flag is
 * cleared. Clearing matters — a flag left behind would resurrect a shortcut the
 * user had just removed on the next start, which is worse than the migration
 * never having run.
 *
 * Best effort, idempotent, and safe to interrupt: the shortcut write is first,
 * and the annotation cleanup only clears flags whose shortcut now exists.
 */

import { FIXED_NODES } from "../constants.js";
import { normalizeAnnotation, patchAnnotation } from "../domain/annotations.js";
import { SHORTCUT_NODE_PREFIX } from "../domain/shortcuts.js";

/**
 * Give one session a shortcut in a container, unless it already has one.
 *
 * Not `createShortcut`: that function validates against a built tree (parent
 * must resolve, the target must exist), and the migration must not fail on a
 * stale flag whose session has since been deleted. A stale flag is dropped by
 * the tree projection itself, which already discards a session shortcut whose
 * target is gone.
 *
 * @param {{ shortcuts?: Record<string, any> }} draft tree sidecar draft
 * @param {string} container container node id (f-favorites / f-todos)
 * @param {string} targetId session id
 * @param {() => string} newId id factory
 * @returns {{ id: string, created: boolean }} the shortcut, and whether this
 *   call wrote it
 */
function ensureShortcut(draft, container, targetId, newId) {
  const shortcuts = draft.shortcuts ?? (draft.shortcuts = {});
  for (const [id, entry] of Object.entries(shortcuts)) {
    if (!entry || entry.kind !== "session" || entry.targetId !== targetId) continue;
    if ((entry.parent ?? FIXED_NODES.favorites) === container) return { id, created: false };
  }
  // Append: the migrated rows keep the order the flags were read in, after any
  // shortcut the user made by hand.
  const siblings = Object.values(shortcuts).filter((entry) => (entry?.parent ?? FIXED_NODES.root) === container);
  const id = SHORTCUT_NODE_PREFIX + newId();
  shortcuts[id] = {
    id,
    kind: "session",
    targetId,
    parent: container,
    order: siblings.length,
    label: null,
    createdAt: Date.now(),
  };
  return { id, created: true };
}

/**
 * Move every 收藏 / 待办 flag into a shortcut, then clear the flag.
 *
 * @param {any} api
 * @param {() => string} newId id factory (the same one folders and shortcuts use)
 * @returns {Promise<{ moved: number, created: number }>} sessions migrated,
 *   shortcuts created (a session in both containers counts once as a session
 *   and twice as a shortcut)
 */
export async function migrateFlagsToShortcuts(api, newId) {
  const annotations = await api.documents.annotations.read();
  const entries = annotations?.sessions ?? {};
  /** @type {Array<{ id: string, favorite: boolean, todo: boolean }>} */
  const flagged = [];
  for (const [id, entry] of Object.entries(entries)) {
    const state = normalizeAnnotation(entry);
    if (!state.favorite && !state.todo) continue;
    flagged.push({ id, favorite: state.favorite, todo: state.todo });
  }
  if (flagged.length === 0) return { moved: 0, created: 0 };

  let created = 0;
  await api.documents.tree.mutate((draft) => {
    for (const item of flagged) {
      if (item.favorite && ensureShortcut(draft, FIXED_NODES.favorites, item.id, newId).created) created += 1;
      if (item.todo && ensureShortcut(draft, FIXED_NODES.todos, item.id, newId).created) created += 1;
    }
  });

  await api.documents.annotations.mutate((draft) => {
    // `patchAnnotation` drops an entry that carries nothing else, so a session
    // that was only favorited leaves the sidecar entirely.
    for (const item of flagged) patchAnnotation(draft, item.id, { favorite: false, todo: false });
  });

  return { moved: flagged.length, created };
}
