// 路由组 folders（9 条）
import { createFolder, deleteFolder, renameFolder, reorderNode } from "../domain/folders.js";
import { applyQuickAccessOrder, isBookmarkable } from "../domain/quick-access.js";
import { createShortcut, deleteShortcut, dropShortcutsTo } from "../domain/shortcuts.js";
import { badRequest, expectedRevision, newId } from "../routes/shared.js";
import { codedError } from "../store/sidecar.js";
import { optionalObject, requireFiniteNumber, requireIdArray, requireText } from "../validate.js";

export const foldersRoutes = {


  /** Create a folder (新建文件夹). */
  "POST /folders": async (api, req) => {
    const snapshot = await api.reader.snapshot({});
    const body = req.body ?? {};
    /** @type {string} */
    let created = "";
    const document = await api.documents.tree.mutate(
      (draft) => {
        created = createFolder(draft, { name: body.name, parent: body.parent }, snapshot.tree, newId);
      },
      expectedRevision(req, api),
    );
    return { id: created, folder: document.folders[created], revision: document.revision };
  },


  /** Rename a folder. */
  "PATCH /folders/:id": async (api, req) => {
    const id = String(req.params.id ?? "");
    // A rename without a name is a malformed request, not a no-op: answering
    // 200 for it claimed a write that never happened.
    const name = requireText(optionalObject(req.body).name, "name");
    const document = await api.documents.tree.mutate(
      (draft) => {
        renameFolder(draft, id, name);
      },
      expectedRevision(req, api),
    );
    return { id, folder: document.folders[id] ?? null, revision: document.revision };
  },


  /** Delete a folder, lifting its contents to the parent first. */
  "DELETE /folders/:id": async (api, req, _res, query) => {
    const id = String(req.params.id ?? "");
    const snapshot = await api.reader.snapshot({});
    const liftContents = query?.get("lift") !== "0";
    /** @type {any} */
    let result = null;
    const document = await api.documents.tree.mutate(
      (draft) => {
        result = deleteFolder(draft, id, snapshot.tree, { liftContents });
        // A shortcut is only ever removed together with its target: deleting the
        // folder leaves every reference to it dangling, and a row that opens
        // nothing is worse than a row that is gone.
        dropShortcutsTo(draft, "folder", id);
      },
      expectedRevision(req, api),
    );
    return { ...result, revision: document.revision };
  },


  /**
   * Create a shortcut (快捷方式).
   *
   * `{ kind, targetId, parent? }` — a reference, never a move (hard constraint
   * 5). The target keeps living where it lives; 收藏 / 待办 / any folder can hold
   * the row.
   */
  "POST /shortcuts": async (api, req) => {
    const snapshot = await api.reader.snapshot({});
    const body = req.body ?? {};
    // 收藏 / 待办 are session references. The domain validates container targets
    // against the tree; a session target needs the listing, and a reference to a
    // session nobody has heard of would be a row that opens nothing.
    if (body.kind === "session") {
      const targetId = String(body.targetId ?? "");
      const trash = await api.documents.trash.read();
      const known = snapshot.sessions.some((session) => session.id === targetId) || Boolean(trash.entries?.[targetId]);
      if (!known) throw codedError("session-not-found", `unknown session ${targetId}`);
    }
    /** @type {string} */
    let created = "";
    const document = await api.documents.tree.mutate(
      (draft) => {
        created = createShortcut(
          draft,
          { kind: body.kind, targetId: body.targetId, parent: body.parent, label: body.label },
          newId,
          snapshot.tree,
        );
      },
      expectedRevision(req, api),
    );
    return { id: created, shortcut: document.shortcuts[created], revision: document.revision };
  },


  /** Delete one shortcut. The target is untouched. */
  "DELETE /shortcuts/:id": async (api, req) => {
    const id = String(req.params.id ?? "");
    const document = await api.documents.tree.mutate(
      (draft) => {
        deleteShortcut(draft, id);
      },
      expectedRevision(req, api),
    );
    return { removed: id, revision: document.revision };
  },


  /**
   * Pin / unpin a container (a folder or a workspace).
   *
   * DSH pins sessions; this stores a container pin in the tree sidecar. Both
   * appear in the list's 置顶 group, which is why the two sets live in different
   * stores but one visual band.
   */
  "POST /nodes/:id/pin": async (api, req) => {
    const nodeId = String(req.params.id ?? "");
    if (!nodeId) throw badRequest("node id is required");
    // A pin is a reference; pinning a row that does not exist would keep an
    // entry in the map forever, since no view could ever unpin it.
    const snapshot = await api.reader.snapshot({});
    const known = Boolean(snapshot.tree.nodes[nodeId] ?? snapshot.tree.shortcuts?.[nodeId]);
    if (!known) throw codedError("node-not-found", `unknown node ${nodeId}`);
    const pinned = req.body?.pinned !== false;
    const document = await api.documents.tree.mutate(
      (draft) => {
        draft.pins ??= {};
        if (pinned) draft.pins[nodeId] = Date.now();
        else delete draft.pins[nodeId];
      },
      expectedRevision(req, api),
    );
    return { nodeId, pinned, revision: document.revision };
  },


  /**
   * Put a container in 快速访问 — the strip of buttons above 目录 — or take it
   * back out.
   *
   * Deliberately its own store: 置顶 ranks the row inside the tree it already
   * lives in, while a bookmark adds a second entry point. Sharing one map is
   * what made the two features indistinguishable. The client filters
   * which nodes may live here (real folders and workspaces), the host keeps the
   * sequence so the strip stays in the order things were added.
   */
  "POST /nodes/:id/quick-access": async (api, req) => {
    const nodeId = String(req.params.id ?? "");
    if (!nodeId) throw badRequest("node id is required");
    const on = req.body?.quickAccess !== false;
    const document = await api.documents.tree.mutate(
      (draft) => {
        draft.quickAccess ??= {};
        if (!on) {
          delete draft.quickAccess[nodeId];
          return;
        }
        // 快速访问 holds containers the user can open. A view, a reference or a
        // folder this sidecar never had would draw a row that leads nowhere.
        if (!isBookmarkable(draft, nodeId)) throw badRequest("this node cannot be bookmarked");
        draft.quickAccess[nodeId] = Date.now();
      },
      expectedRevision(req, api),
    );
    return { nodeId, quickAccess: on, revision: document.revision };
  },


  /**
   * Reorder one node among its siblings.
   *
   * `{ order }` — the same number the sidecar sorts by. A shortcut and a folder
   * share the one write; a workspace is ranked in `workspaceOrder`, because its
   * row belongs to the workspace band rather than to a parent folder.
   */
  "POST /nodes/:id/reorder": async (api, req) => {
    const nodeId = String(req.params.id ?? "");
    if (!nodeId) throw badRequest("node id is required");
    const order = requireFiniteNumber(req.body?.order, "order");
    // `reorderNode` can only rank what it can find; a workspace lives in the
    // registry rather than in the document, so the check happens here — without
    // it a typo in an id writes an order nobody will ever read back.
    const before = await api.reader.snapshot();
    const known = Boolean(before.tree.nodes[nodeId] ?? before.tree.shortcuts?.[nodeId]);
    if (!known) throw codedError("node-not-found", `unknown node ${nodeId}`);
    const document = await api.documents.tree.mutate(
      (draft) => {
        reorderNode(draft, nodeId, order);
      },
      expectedRevision(req, api),
    );
    return { nodeId, order, revision: document.revision };
  },


  /**
   * The 快速访问 strip, written as one ordered list.
   *
   * A bookmark has no `order` field of its own — the strip is a single sequence —
   * so a drag that drops one button next to another cannot be a per-row PATCH.
   * It also cannot be "move row X to index N" alone: dragging a folder straight
   * from 目录 onto the strip has to *add* it, and dropping one bookmark on another
   * has to reorder. Both are the same sentence ("here is the order now"), so
   * they are the same request.
   *
   * The host validates every id (`isBookmarkable`): a list that names a view, a
   * shortcut or a folder this sidecar does not know is skipped, never a 400 —
   * the gesture came from a live tree, and one stale row must not void it.
   */
  "POST /quick-access": async (api, req) => {
    const ids = requireIdArray(req.body?.ids, "ids", { allowEmpty: true, message: "ids must be an array of node ids" });
    /** @type {string[]} */
    let order = [];
    /** @type {string[]} */
    let skipped = [];
    const document = await api.documents.tree.mutate(
      (draft) => {
        const result = applyQuickAccessOrder(draft, ids);
        order = result.order;
        skipped = result.skipped;
      },
      expectedRevision(req, api),
    );
    return { order, skipped, quickAccess: document.quickAccess ?? {}, revision: document.revision };
  },
};
