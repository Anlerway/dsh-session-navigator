/**
 * One session's explorer state, as the buttons DSH renders outside the panel
 * need to see it.
 *
 * Those surfaces (the conversation header strip, the sidebar row's "…" menu)
 * have no bootstrap snapshot: they know one session id. Answering them is
 * therefore a question about three documents, not about the tree, which is why
 * this lives here as a pure function of them — no filesystem, no HTTP, and no
 * second definition of "archived" or "in the bin" to drift from the panel's.
 */

import { FIXED_NODES } from "../constants.js";
import { normalizeShortcut } from "./shortcuts.js";

/**
 * The shortcut that puts this session in one container, if there is one.
 *
 * 收藏 / 待办 are shortcut containers, so membership has no flag of its own: the
 * shortcut *is* the membership, and its id is what 取消收藏 has to delete.
 *
 * @param {Record<string, any> | null | undefined} shortcuts tree sidecar map
 * @param {string} id session id
 * @param {string} container container node id (f-favorites / f-todos)
 * @returns {string | null} the shortcut node id
 */
function membershipOf(shortcuts, id, container) {
  for (const [key, raw] of Object.entries(shortcuts ?? {})) {
    const shortcut = normalizeShortcut(raw, key);
    if (!shortcut || shortcut.kind !== "session") continue;
    if (shortcut.targetId !== id || shortcut.parent !== container) continue;
    return shortcut.id;
  }
  return null;
}

/**
 * @param {{
 *   shortcuts?: Record<string, any> | null,
 *   trash?: { entries?: Record<string, unknown> } | null,
 *   sessions?: Array<{ id: string, archived?: boolean, trashed?: boolean, isSubagent?: boolean }> | null,
 * }} documents
 * @param {string} id
 * @returns {{ id: string, favorite: boolean, todo: boolean, favoriteShortcut: string | null, todoShortcut: string | null, archived: boolean, trashed: boolean, subagent: boolean }}
 */
export function sessionStateOf(documents, id) {
  const session = (documents?.sessions ?? []).find((candidate) => candidate.id === id) ?? null;
  const favoriteShortcut = membershipOf(documents?.shortcuts, id, FIXED_NODES.favorites);
  const todoShortcut = membershipOf(documents?.shortcuts, id, FIXED_NODES.todos);
  return {
    id,
    favorite: favoriteShortcut !== null,
    todo: todoShortcut !== null,
    // The ids travel with the state because the strip's 取消收藏 deletes the
    // shortcut rather than writing a flag: without the id it would have to
    // re-derive the answer it was just given.
    favoriteShortcut,
    todoShortcut,
    archived: session?.archived === true,
    // Two sources, both authoritative in their own layer: the bin is this
    // plugin's own record (it holds the payload), `trashed` is what DSH reports
    // while a restore is still settling. Either one means "not live".
    trashed: Object.prototype.hasOwnProperty.call(documents?.trash?.entries ?? {}, id) || session?.trashed === true,
    // A subagent's menu must not offer the operations its parent owns; the
    // header strip and the row menu have no snapshot, so the answer travels
    // with the state they already fetch.
    subagent: session?.isSubagent === true,
  };
}
