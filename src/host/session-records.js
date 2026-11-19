/**
 * dsh-session-navigator — the records this plugin keeps about one session.
 *
 * Deleting a session removes its directory from DSH's sessions tree and nothing
 * else. The plugin, though, holds a few things *about* it:
 *
 *   - `annotations.v1.json`  tags, note, 收藏, 待办 — the user's own words about
 *     the session, which must not outlive it;
 *   - `summaries.v1.json`    the AI fields (标题/描述/标签) the user paid for, and
 *     the note they were merged into;
 *   - `tree.v1.json`         a `sessionPlacement` row and any 快捷方式 (shortcut)
 *     pointing at the session;
 *   - the 会话内容 index       the transcript text cached for search.
 *
 * Two callers need the same sweep, and they ask the opposite question:
 *
 *   - 永久删除 (purge) knows exactly which ids are gone. Its records must go at
 *     the same moment as the payload, or the bin empties while the annotations
 *     page still lists rows for sessions that cannot be opened.
 *   - 清理缓存 knows which ids *exist* and treats every other key as an orphan —
 *     a session deleted by DSH itself, by an earlier build of this plugin, or by
 *     anything else that never told us. Nothing else would ever collect those,
 *     because no code path revisits a key it has no session for.
 *
 * Both go through `prune`, so the two answers cannot drift apart.
 */

import { dropShortcutsTo } from "../domain/shortcuts.js";

/**
 * The ids in `ids` that are usable as document keys.
 *
 * @param {any} ids
 * @returns {Set<string>}
 */
function idSet(ids) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === "string" && id !== "") out.add(id);
  }
  return out;
}

/**
 * Drop the cached transcript text of these sessions.
 *
 * Not a sidecar, but the same promise: the index holds the conversation itself,
 * and a purged session leaving its text in a file the user cannot see is exactly
 * the leak the rest of this module exists to prevent. The disk write is
 * best-effort — the index in memory is already correct, and a stale file is
 * dropped by the next flush.
 *
 * @param {any} api
 * @param {string[]} ids
 * @returns {Promise<number>} how many cached transcripts were dropped
 */
async function forgetContent(api, ids) {
  if (ids.length === 0) return 0;
  let dropped = 0;
  try {
    if (typeof api?.content?.forget === "function") dropped = api.content.forget(ids);
  } catch {
    /* the next sync drops the entries anyway */
  }
  try {
    await api?.content?.flush?.();
  } catch {
    /* a locked index file is retried on the next flush */
  }
  return dropped;
}

/**
 * Delete every record whose session id `shouldDrop` accepts.
 *
 * A document is only written when it actually holds something to drop, because
 * every write bumps a revision and wakes the client's revision watcher.
 *
 * @param {any} api
 * @param {(id: string) => boolean} shouldDrop
 * @returns {Promise<{ annotations: string[], summaries: string[], placements: string[], shortcuts: string[] }>}
 */
async function prune(api, shouldDrop) {
  /** @type {{ annotations: string[], summaries: string[], placements: string[], shortcuts: string[] }} */
  const removed = { annotations: [], summaries: [], placements: [], shortcuts: [] };

  const annotations = await api.documents.annotations.read();
  const staleAnnotations = Object.keys(annotations?.sessions ?? {}).filter((id) => shouldDrop(id));
  if (staleAnnotations.length > 0) {
    await api.documents.annotations.mutate((draft) => {
      for (const id of staleAnnotations) delete draft.sessions[id];
    });
    removed.annotations = staleAnnotations;
  }

  const summaries = await api.documents.summaries.read();
  const staleSummaries = Object.keys(summaries?.sessions ?? {}).filter((id) => shouldDrop(id));
  if (staleSummaries.length > 0) {
    await api.documents.summaries.mutate((draft) => {
      for (const id of staleSummaries) delete draft.sessions[id];
    });
    removed.summaries = staleSummaries;
  }

  const tree = await api.documents.tree.read();
  const stalePlacements = Object.keys(tree?.sessionPlacement ?? {}).filter((id) => shouldDrop(id));
  const staleShortcuts = Object.entries(tree?.shortcuts ?? {})
    .filter(([, entry]) => entry?.kind === "session" && typeof entry.targetId === "string" && shouldDrop(entry.targetId))
    .map(([id]) => id);
  if (stalePlacements.length > 0 || staleShortcuts.length > 0) {
    await api.documents.tree.mutate((draft) => {
      for (const id of stalePlacements) delete draft.sessionPlacement[id];
      // `dropShortcutsTo` is the one place that knows a shortcut's shape; the
      // ids were collected above so the draft is written only once.
      for (const id of new Set(staleShortcuts.map((shortcutId) => tree.shortcuts[shortcutId]?.targetId))) {
        if (typeof id === "string") dropShortcutsTo(draft, "session", id);
      }
    });
    removed.placements = stalePlacements;
    removed.shortcuts = staleShortcuts;
  }

  return removed;
}

/**
 * Forget everything this plugin stored about these sessions.
 *
 * Called the moment their payload is deleted permanently. Failures are not
 * swallowed here: purge reports them per id, the same way it reports a locked
 * file, so the user is not told the bin is empty while a record remains.
 *
 * @param {any} api
 * @param {string[]} ids
 * @returns {Promise<{ annotations: string[], summaries: string[], placements: string[], shortcuts: string[], content: number }>}
 */
export async function forgetSessionRecords(api, ids) {
  const wanted = idSet(ids);
  if (wanted.size === 0) return { annotations: [], summaries: [], placements: [], shortcuts: [], content: 0 };
  const removed = await prune(api, (id) => wanted.has(id));
  const content = await forgetContent(api, [...wanted]);
  return { ...removed, content };
}

/**
 * Forget every record whose session no longer exists.
 *
 * `known` is the answer to "which sessions exist right now": the live ones and
 * the ones in the bin (a trashed session is not gone, and its annotation is what
 * makes the bin row readable). Anything else is an orphan.
 *
 * The 会话内容 index is deliberately left out: its own `sync` already drops
 * entries whose session left the listing, and 清理缓存 deletes the whole file
 * when it wants the bytes back.
 *
 * @param {any} api
 * @param {Iterable<string>} known
 * @returns {Promise<{ annotations: string[], summaries: string[], placements: string[], shortcuts: string[] }>}
 */
export async function sweepOrphanSessionRecords(api, known) {
  const keep = known instanceof Set ? known : new Set(known);
  return prune(api, (id) => !keep.has(id));
}

/**
 * How many records a `prune` result found, for a report line.
 *
 * @param {{ annotations: string[], summaries: string[], placements: string[], shortcuts: string[] }} removed
 * @returns {number}
 */
export function recordCount(removed) {
  return (
    removed.annotations.length +
    removed.summaries.length +
    removed.placements.length +
    removed.shortcuts.length
  );
}
