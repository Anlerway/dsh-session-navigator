/**
 * dsh-session-navigator — 快速访问, the strip of container buttons above 目录.
 *
 * The strip is *one sequence*, not a property of each container: the store keeps
 * `{ nodeId: sequence }` and the tree sorts by it, newest first. That shape is
 * what lets two different gestures be one write — dropping a folder on the strip
 * adds it, dropping one button next to another reorders the strip — because both
 * can be expressed as "here is the whole order now".
 *
 * Kept apart from `pins` on purpose: a pin is a ranking inside the band a row
 * already lives in, a bookmark is a second entry point to the same container
 * (m03020). Sharing one map made the two features indistinguishable, and 置顶 a
 * folder silently moved it out of 目录.
 */

import { FOLDER_NODE_PREFIX } from "./tree.js";

/** The workspace node ids look like `w-<native id>`; nothing else uses the prefix. */
export const WORKSPACE_NODE_PREFIX = "w-";

/**
 * May this node be a bookmark at all?
 *
 * Only a real container: a folder that still exists, or a workspace. The views
 * (根目录 / 所有会话 / 回收站), the reference containers (收藏 / 待办) and
 * shortcuts are not places, and a row for them would open a page that is already
 * one click away in the rail.
 *
 * @param {{ folders?: Record<string, any> }} draft
 * @param {unknown} id
 * @returns {boolean}
 */
export function isBookmarkable(draft, id) {
  if (typeof id !== "string" || id === "") return false;
  if (id.startsWith(WORKSPACE_NODE_PREFIX)) return id.length > WORKSPACE_NODE_PREFIX.length;
  if (!id.startsWith(FOLDER_NODE_PREFIX)) return false;
  return Boolean(draft?.folders?.[id]);
}

/**
 * Write the strip in the given order.
 *
 * Ids that are not bookmarkable are skipped rather than rejected: the list comes
 * from a drag gesture, where a stale row is a fact of life, and refusing the
 * whole gesture over one entry would make the drop look broken. An id that is
 * not in the strip yet is *added* — dropping a folder on the strip and dropping
 * a button next to a button are the same sentence, so the host has no reason to
 * treat them differently.
 *
 * Anything already in the strip but missing from `ids` keeps its old sequence,
 * which puts it below the rewritten ones: a drag never silently drops a bookmark
 * the user did not touch.
 *
 * @param {{ quickAccess?: Record<string, number>, folders?: Record<string, any> }} draft
 * @param {string[]} ids in display order, first row first
 * @param {number} [now]
 * @returns {{ order: string[], skipped: string[] }}
 */
export function applyQuickAccessOrder(draft, ids, now = Date.now()) {
  draft.quickAccess ??= {};
  /** @type {string[]} */
  const order = [];
  /** @type {string[]} */
  const skipped = [];
  let slot = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!isBookmarkable(draft, id)) {
      skipped.push(String(id));
      continue;
    }
    // Descending so the first row in the list has the largest sequence: the
    // projection reads "newest first" and every other writer uses Date.now().
    draft.quickAccess[id] = now - slot;
    slot += 1;
    order.push(id);
  }
  return { order, skipped };
}
