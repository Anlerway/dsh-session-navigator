// 路由组 maintenance（7 条）
import { deleteWorkspace, renameSession } from "../host/actions.js";
import { moveSessions } from "../host/move.js";
import { emptyTrash, purgeSessions, restoreSessions, trashSessions } from "../host/trash.js";
import { assertStandalone, badRequest, trashClosure, withBoundChildren } from "../routes/shared.js";
import { requireIdArray, requireText } from "../validate.js";

export const maintenanceRoutes = {


  /**
   * Cross-workspace move / copy.
   *
   * `{ ids, target: { workspaceId }, copy? }` — the artifact is re-homed (its
   * header cwd rewritten, the directory relocated) and the registry accounting
   * swapped in one transaction; see lib/host/move.js. `copy: true` writes a
   * second, independent session under a fresh id instead of moving.
   */
  "POST /move": async (api, req) => {
    // 剪切/复制: a subagent moves with its parent's workspace by derivation, so
    // moving one alone (or copying it into a second standalone session) would
    // break the delegation the parent's transcript points at. Refused for the
    // whole request, not per session: a half-applied batch is worse than none.
    await assertStandalone(api, req.body?.ids);
    return moveSessions(api, req.body ?? {});
  },


  /**
   * Move sessions to the trash.
   *
   * This is a real move: the session directory leaves DSH's sessions tree, so
   * the session disappears from DSH's own sidebar too. That is the point — the
   * bin is a bin, not a filter — and it is also why restore has to put the
   * payload back where it came from (see lib/host/trash.js).
   */
  "POST /trash": async (api, req) => {
    // The batch itself must be named here: `withBoundChildren` turns ids it
    // cannot resolve into an empty list, and "delete nothing" is a malformed
    // request rather than a successful delete.
    const ids = requireIdArray(req.body?.ids, "ids", { message: "ids must be a non-empty array", emptyWhen: "input" });
    // A subagent may be binned on its own. The bin moves the payload and
    // restore puts it back, so nothing about the parent's run changes and the
    // parent's transcript still resolves the delegation it points at; a child
    // nobody wants to keep was otherwise stuck for as long as its parent lived.
    // The cascade below keeps the other direction: binning a parent still takes
    // every subagent under it in the same call.
    return trashSessions(api, await withBoundChildren(api, ids));
  },


  /** Put sessions back. Ids that are not in the bin are skipped, not refused. */
  "POST /restore": async (api, req) => restoreSessions(api, await trashClosure(api, req.body?.ids)),


  /** Delete payloads for good. */
  "POST /purge": async (api, req) => purgeSessions(api, await trashClosure(api, req.body?.ids)),


  /** Empty the bin in one call. */
  "POST /trash/empty": async (api) => emptyTrash(api),


  /**
   * Rename a session.
   *
   * This is DSH's own rename: it appends a user-authored `session/title` event
   * and supersedes automatic title generation, so the name survives later
   * turns. Nothing is written to a sidecar.
   */
  "POST /sessions/:id/rename": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    // The title belongs to the parent's run as a whole: renaming a delegation
    // would only make the parent's transcript disagree with its own label.
    await assertStandalone(api, sessionId);
    const title = requireText(req.body?.title, "title");
    return renameSession(api, sessionId, title);
  },


  /**
   * Delete a workspace registration.
   *
   * DSH keeps the directory and every session log: only the grouping entry goes
   * away, so the sessions fall back to 未分组. That is the behaviour the user
   * asked for ("删除后内部结构解散，其会话归为未分类") and it is also what the
   * native delete means, which is why there is no custom unlink here.
   */
  "POST /workspaces/:id/delete": async (api, req) => {
    const workspaceId = String(req.params.id ?? "");
    if (!workspaceId) throw badRequest("workspace id is required");
    return deleteWorkspace(api, workspaceId);
  },
};
