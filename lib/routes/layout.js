// 路由组 layout（3 条）
import { moveNode } from "../domain/folders.js";
import { canAcceptSessions, canMove, nearestWorkspace } from "../domain/tree.js";
import { moveSessions } from "../host/move.js";
import { assertStandalone, badRequest, expectedRevision } from "../routes/shared.js";
import { codedError } from "../store/sidecar.js";
import { optionalObject, requireIdArray } from "../validate.js";

export const layoutRoutes = {


  /**
   * Re-home sessions *virtually*: show them under another container without
   * moving their directory.
   *
   * DSH derives a session's workspace from the header `cwd`; changing that means
   * moving the payload, which hard constraint 1 forbids. So a drop onto 未分组
   * (or back into a workspace) writes a grouping override into the sidecar and
   * leaves the file exactly where DSH put it.
   *
   * `{ ids, parent }` — `parent` is a container node id; omitting it (or passing
   * the node the session already lives in) clears the override.
   */
  "POST /sessions/placement": async (api, req) => {
    const body = optionalObject(req.body);
    const ids = requireIdArray(body.ids, "ids", { message: "ids is required" });
    const parent = typeof body.parent === "string" && body.parent ? body.parent : "";
    // `move: true` turns a cross-workspace drop into the real thing. A folder
    // inside a workspace is that workspace's own sub-group, so a session filed
    // elsewhere was refused below; with `move` the payload is re-homed into the
    // folder's workspace first (header cwd rewritten, directory relocated — the
    // same transaction as 剪切/粘贴) and the placement then only files it inside
    // the folder. Without it the older, purely virtual behaviour is unchanged.
    const wantsMove = body.move === true;
    // One listing answers every question: which ids exist, which are subagents,
    // what the parent node accepts, and which sessions live in another workspace.
    const snapshot = await api.reader.snapshot({});
    const known = new Set(snapshot.sessions.map((session) => session.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      // A placement for an id no view holds is a map entry that can never be
      // seen or cleared; the caller that sent it has a stale selection.
      throw codedError("session-not-found", `unknown session ${unknown[0]}`);
    }
    // A child is filed under its parent's workspace by derivation, so a
    // placement written for it would be a second, contradictory home.
    await assertStandalone(api, ids, snapshot);
    const tree = snapshot.tree;
    /** @type {string[]} */
    const moved = [];
    /** @type {{ sessionId: string, code: string, message: string }[]} */
    const failed = [];
    // Validate against the *live* tree: a placement must name a node that can
    // actually hold sessions, otherwise the row would disappear from every view.
    if (parent) {
      const node = tree.nodes[parent];
      if (!node) throw badRequest("parent node does not exist");
      if (!canAcceptSessions(parent, tree)) throw badRequest("this container cannot hold sessions");
      if (node.kind === "folder" && !node.fixed) {
        const home = nearestWorkspace(parent, tree);
        const byId = new Map(snapshot.sessions.map((session) => [session.id, session]));
        const foreign = ids.filter((id) => {
          const session = byId.get(id);
          return session ? (session.workspaceId ?? null) !== home : false;
        });
        // Without `move` this is still a refusal: a virtual placement across
        // workspaces made the row appear in a container the workspace's own
        // count did not include.
        if (foreign.length > 0 && !wantsMove) {
          throw badRequest("这个文件夹只接受它所在工作区里的会话");
        }
        if (foreign.length > 0) {
          if (!home) throw badRequest("这个文件夹不在任何工作区里");
          const outcome = await moveSessions(api, { ids: foreign, target: { workspaceId: home } });
          for (const row of outcome?.results ?? []) {
            if (row && row.ok === false) {
              failed.push({
                sessionId: String(row.sessionId ?? ""),
                code: String(row.code ?? "io-error"),
                message: String(row.message ?? ""),
              });
            } else if (row) moved.push(String(row.sessionId));
          }
        }
      }
    }
    // A session that could not be re-homed has no business being filed in the
    // folder it was dropped on: it keeps whatever placement it had.
    const keep = ids.filter((id) => !failed.some((row) => row.sessionId === id));
    const document = await api.documents.tree.mutate(
      (draft) => {
        draft.sessionPlacement ??= {};
        for (const id of keep) {
          if (parent) draft.sessionPlacement[id] = parent;
          else delete draft.sessionPlacement[id];
        }
      },
      expectedRevision(req, api),
    );
    return {
      ids,
      parent: parent || null,
      revision: document.revision,
      sessionPlacement: document.sessionPlacement ?? {},
      moved,
      failed,
    };
  },


  /**
   * Arm "the next session in this folder" — the other half of 新建会话.
   *
   * DSH only takes a workspace (`uiWorkspace.startSession(workspaceId)` opens a
   * draft at that workspace's root; its own sidebar has no level below one), so
   * a click inside a folder sends two things: this intent, and then the draft
   * request. The intent names the folder *and* the sessions that already exist,
   * and the Host files the first session that appears in that workspace
   * afterwards (see lib/host/pending-drafts.js for why it has to be this way
   * round).
   *
   * `{ parent }` — a container node id that can hold sessions and sits inside a
   * workspace. Nothing is written here: the answer says what was remembered.
   */
  "POST /sessions/placement/pending": async (api, req) => {
    const parent = typeof req.body?.parent === "string" ? req.body.parent : "";
    if (!parent) throw badRequest("parent is required");
    // Validated against the live tree exactly like a placement: an intent for a
    // node no view draws would file the draft into nothing.
    const snapshot = await api.reader.snapshot({});
    const tree = snapshot.tree;
    if (!tree.nodes[parent]) throw badRequest("parent node does not exist");
    if (!canAcceptSessions(parent, tree)) throw badRequest("this container cannot hold sessions");
    const workspaceId = nearestWorkspace(parent, tree);
    if (!workspaceId) throw badRequest("这个位置不在任何工作区里，DSH 没法在那里新建会话");
    return api.pendingDrafts.arm({
      parent,
      workspaceId,
      known: snapshot.sessions.map((session) => session.id),
    });
  },


  /** Move a folder or workspace to a new parent. */
  "POST /nodes/:id/move": async (api, req) => {
    const nodeId = String(req.params.id ?? "");
    const parentId = String(req.body?.parent ?? "");
    if (!parentId) throw badRequest("parent is required");
    const snapshot = await api.reader.snapshot({});
    const verdict = canMove(nodeId, parentId, snapshot.tree);
    if (!verdict.ok) throw codedError(verdict.code, verdict.message);
    const document = await api.documents.tree.mutate(
      (draft) => {
        moveNode(draft, nodeId, parentId);
      },
      expectedRevision(req, api),
    );
    return { nodeId, parent: parentId, revision: document.revision };
  },
};
