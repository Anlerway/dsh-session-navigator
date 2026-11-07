    // ── Breadcrumbs ────────────────────────────────────────────────────────
    function crumbsFor(tree, scope) {
      const nodes = tree?.nodes ?? {};
      const trail = [];
      let current = nodes[scope];
      const guard = new Set();
      while (current && !guard.has(current.id)) {
        guard.add(current.id);
        const meta = FIXED_META[current.id];
        trail.unshift({
          id: current.id,
          label: current.id === FIXED.root ? T("根目录") : meta?.label ?? current.name ?? current.path ?? current.id,
          icon: meta?.icon ?? iconOfNode(current, tree),
        });
        current = current.parent ? nodes[current.parent] : null;
      }
      if (trail.length === 0) trail.push({ id: FIXED.root, get label() { return T("根目录"); }, icon: "folder" });
      return trail;
    }

    // ── Row renderers ──────────────────────────────────────────────────────

    /**
     * The drag channel for session rows.
     *
     * A node drag (tree → tree) already uses "text/plain" with a bare node id.
     * Session drags carry a prefixed, JSON payload on a private type instead, so
     * the two gestures can never be mistaken for one another — dropping a
     * folder onto a workspace is a *virtual* move, dropping sessions is a real
     * file move, and the difference is not recoverable from a bare id.
     */
    const SESSION_DRAG_TYPE = "application/x-dsh-session-ids";

    /**
     * The node currently being dragged, as a module-level value.
     *
     * `dataTransfer.getData` returns nothing during `dragover` for custom
     * types (browsers only expose the type list until the drop), so a drop
     * target cannot learn *what* it would receive in time to grey itself out.
     * The drag source therefore records its payload here when the drag starts
     * and clears it when it ends; the target reads this instead of the
     * DataTransfer.
     */
    let dragPayload = null;

    /**
     * The one sentence 快速访问 already said during this gesture.
     *
     * The band refuses two kinds of payload — a session, and anything that is
     * not a place — and says why instead of swallowing the drop. dragover fires
     * on every pointer frame, so the sentence is written once per gesture
     * rather than repainting the status bar sixty times a second.
     */
    let quickHinted = "";
    /**
     * May a dragged node land on one row?
     *
     * The host already answered the hard part: `/bootstrap` ships
     * `accepts.folder` / `accepts.workspace` and `hasWorkspace` on every node,
     * derived once by `src/domain/tree-rules.js`. So this is a *reader*, not a
     * second copy of the rules — the only thing it decides by itself is the one
     * question that depends on the drag: a node may never land in its own
     * subtree.
     *
     * @param {string} nodeId the node being dragged
     * @param {string} parentId the row it would land on
     * @param {Record<string, any>} nodes
     * @param {Record<string, string[]>} children
     * @returns {boolean}
     */
    function canDropInTree(nodeId, parentId, nodes, children) {
      const node = nodes[nodeId];
      const parent = nodes[parentId];
      if (!node || !parent) return false;
      if (node.fixed) return false;
      // R1 from the target's side: a workspace drag — or a folder carrying one —
      // may only land where the host says a workspace may go.
      const bringsWorkspace = node.kind === "workspace" || node.hasWorkspace === true;
      const accepts = bringsWorkspace ? parent.accepts?.workspace : parent.accepts?.folder;
      if (!accepts) return false;
      // A node may never land inside its own subtree — structurally. A
      // reference row is not a parent edge, so a shortcut to the target is not
      // a cycle, and a folder holding one does not carry the target with it.
      return !subtreeIds(nodeId, nodes, children, { followReferences: false }).has(parentId);
    }

    /**
     * May a container be parked in 快速访问?
     *
     * The strip is a row of entry points, so it holds exactly the nodes that are
     * a *place*: a user folder or a workspace. A fixed view (所有会话, 回收站), a
     * reference (a shortcut) and 根目录 open nothing one click away, and the host
     * leaves them out of its own projection. Asking the same question here is
     * what lets the band refuse a bad drag before it writes, instead of
     * promising 已放到快速访问 for a request the host quietly skipped.
     *
     * @param {any} node
     * @returns {boolean}
     */
    function isBookmarkableNode(node) {
      return Boolean(node) && !node.fixed && (node.type === "folder" || node.type === "workspace");
    }

    /**
     * The drop effect to ask for, given what the drag source allows.
     *
     * `effectAllowed` and `dropEffect` have to intersect: a source that offers
     * only "move" cannot satisfy a "copy" request, and the browser then cancels
     * the whole drop — the target still sees every dragover (so it lights up and
     * says it will take the item) and then `drop` never fires. That is exactly
     * how dragging a folder or a workspace onto the 快速访问 caption behaved:
     * the band highlighted, nothing happened. The sources now offer "copyMove"
     * (see the row dragstarts), and this keeps the request inside that set.
     *
     * @param {any} dataTransfer
     * @param {"copy" | "move"} preferred
     * @returns {"copy" | "move"}
     */
    function dropEffectFor(dataTransfer, preferred = "copy") {
      const allowed = String(dataTransfer?.effectAllowed ?? "");
      // "" and "uninitialized" are the browsers that never fill the field in;
      // "all" is every gesture at once. Neither narrows the request.
      if (!allowed || allowed === "all" || allowed === "uninitialized") return preferred;
      if (allowed === "copy" || allowed === "copyLink" || allowed === "copyMove") return "copy";
      if (allowed === "link" || allowed === "linkMove") return preferred === "copy" ? "copy" : "move";
      return "move";
    }

    /**
     * Why a payload may not land on one row, as a sentence — or null when it may.
     *
     * Every row answers a hover now, including the ones that take nothing, so a
     * greyed-out target always has a reason beside it. The reasons come from the
     * host's own answers (`accepts`) plus the one question that depends on the
     * drag itself — never from the row's type.
     *
     * @param {string} targetId the row the payload hovers
     * @param {"node" | "session"} kind which half of the drag is being dropped
     * @param {{ nodes?: Record<string, any>, children?: Record<string, string[]>, sources?: string[] }} [context]
     * @returns {string | null}
     */
    function dropRefusalFor(targetId, kind, context = {}) {
      const nodes = context.nodes ?? {};
      const children = context.children ?? {};
      const target = nodes[targetId];
      if (!target) return null;
      if (kind === "session") {
        if (target.accepts?.session || target.accepts?.shortcut) return null;
        return target.fixed
          ? T("这里是视图，不能放会话进去：拖到某个工作区，或用行头的星标收藏")
          : T("会话只能放进工作区，或工作区里的文件夹");
      }
      // The payload keeps the row it hangs over: dragging a folder onto itself is
      // the cycle case below, not an empty drag.
      const sources = (context.sources ?? draggedNodeIds()).map(String).filter(Boolean);
      if (sources.length === 0) return null;
      // 根目录 is fixed too, and it *is* a destination — the accepts table, not
      // the fixed flag, decides whether a row can hold something. 收藏 / 待办 are
      // the same story on the reference channel: they take a folder as a
      // shortcut, so a fixed row is only a dead end when it accepts nothing.
      if (target.fixed && !target.accepts?.folder && !target.accepts?.workspace) {
        // 收藏 / 待办 answer on the reference channel: a folder dropped there
        // becomes a shortcut and nothing moves, so the drag is legal.
        if (target.accepts?.shortcut) return null;
        return targetId === FIXED.trash
          ? T("回收站只收删除掉的东西，不能当成目录用")
          : T("这里是汇总视图，不能放东西进来");
      }
      const dragged = sources.map((id) => nodes[id]).filter(Boolean);
      if (dragged.length === 0) return null;
      // A fixed entry is the app's own navigation: it is a target, never a
      // payload. A synthetic drag can still carry one, so say it out loud.
      if (dragged.every((node) => node.fixed)) return T("固定入口不能移动，只能往里放东西");
      if (dragged.some((node) => subtreeIds(node.id, nodes, children, { followReferences: false }).has(targetId))) {
        return T("不能把一个文件夹放进它自己的里面");
      }
      const bringsWorkspace = dragged.some((node) => node.kind === "workspace" || node.hasWorkspace === true);
      if (bringsWorkspace && !target.accepts?.workspace) {
        return T("工作区只能放在根目录，或一个还没有工作区的文件夹里");
      }
      if (!bringsWorkspace && !target.accepts?.folder) return T("这个位置不能放文件夹");
      return null;
    }

    /**
     * Ids at or below one node, itself included.
     *
     * The shape of the tree is the one thing the client still walks for itself:
     * it is a generic traversal (children, plus what a reference row points at),
     * not a rule about who may live where.
     *
     * @param {string} start
     * @param {Record<string, any>} nodes
     * @param {Record<string, string[]>} children
     * @param {{ followReferences?: boolean }} [options] whether a reference row
     *   contributes its target (the list question) or only what actually moves
     *   with the node (the drag question)
     * @returns {Set<string>}
     */
    function subtreeIds(start, nodes, children, options = {}) {
      const followReferences = options.followReferences !== false;
      const ids = new Set();
      const stack = [start];
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current || ids.has(current)) continue;
        ids.add(current);
        // A shortcut row shows what it points at, without the target moving here.
        const ref = nodes[current]?.ref;
        if (followReferences && ref && ref !== current) stack.push(ref);
        if (nodes[current]?.kind === "shortcut") continue;
        for (const child of children[current] ?? []) stack.push(child);
      }
      return ids;
    }

    /**
     * @param {string} raw
     * @returns {string[]}
     */
    function parseDragIds(raw) {
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
      } catch {
        return [];
      }
    }

    /**
     * Split a drag's ids into the two things the panel can act on.
     *
     * A check-set can hold sessions *and* containers at once — the bulk commands
     * already run over both — so a drag carries both halves and each drop target
     * takes the part it can accept. Telling them apart needs the tree and the
     * session index; an id prefix cannot answer it, because a workspace node is
     * named `w-…`, a folder `f-…`, but a session's own id is opaque.
     *
     * @param {(string | null | undefined)[]} ids
     * @param {{ nodes?: Record<string, any>, sessionsById?: Map<string, any> }} source
     * @returns {{ ids: string[], sessions: string[], nodes: string[] }}
     */
    function splitDragIds(ids, source = {}) {
      const nodes = source.nodes ?? null;
      const sessionsById = source.sessionsById ?? null;
      const sessions = [];
      const containers = [];
      const seen = new Set();
      for (const raw of ids ?? []) {
        const id = String(raw ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (nodes?.[id]) containers.push(id);
        // Without an index there is nothing to test against, so the id keeps the
        // meaning its own row gave it; with one, an id nothing knows is dropped
        // rather than sent to a host route that would only refuse it.
        else if (!sessionsById || sessionsById.has?.(id)) sessions.push(id);
      }
      return { ids: [...containers, ...sessions], sessions, nodes: containers };
    }

    /**
     * The session ids a drag carries — the whole check-set, not just the pressed
     * row. The DataTransfer is the primary source (it is what the browser hands
     * a drop target), and the module payload is the fallback for a synthetic
     * event: a test, or a drop that fires after the browser cleared the data.
     *
     * @param {any} [event]
     * @returns {string[]}
     */
    function draggedSessionIds(event) {
      const fromData = parseDragIds(event?.dataTransfer?.getData?.(SESSION_DRAG_TYPE) ?? "");
      if (fromData.length > 0) return fromData;
      const carried = dragPayload?.sessions;
      if (Array.isArray(carried) && carried.length > 0) return carried.map(String);
      return dragPayload?.kind === "session" && Array.isArray(dragPayload.ids) ? dragPayload.ids.map(String) : [];
    }

    /**
     * The container ids a drag carries. Independent of `kind`: a drag started on
     * a session row may still carry folders, and the folder half has to survive.
     *
     * @returns {string[]}
     */
    function draggedNodeIds() {
      const payload = dragPayload;
      if (!payload) return [];
      const carried = Array.isArray(payload.nodes) ? payload.nodes.map(String).filter(Boolean) : [];
      if (carried.length > 0) return carried;
      if (payload.kind === "node" && payload.id) return [String(payload.id)];
      return [];
    }

    /**
     * Flatten the session list into parent/child rows.
     *
     * A subagent session is a real session with `parentSession` set, but showing
     * it as a sibling of its parent makes one delegation read like two
     * conversations. Children therefore follow their parent, indented, and the
     * parent gains a disclosure caret. Orphans (a parent that is filtered out or
     * missing) stay at depth 0 so nothing can disappear from the list.
     *
     * `collapsed` is the set the caller already merged from the 折叠子智能体
     * default and the per-parent caret overrides (see `effectiveCollapsed` in
     * the panel). It is a Set, not a predicate: the merge happens once, where
     * both inputs are known, and a list must not re-derive the rule.
     */
    function nestSessions(sessions, collapsed) {
      const byId = new Map(sessions.map((session) => [session.id, session]));
      /** @type {Map<string, object[]>} */
      const kids = new Map();
      const roots = [];
      for (const session of sessions) {
        // Only real subagents nest. A fork also carries parentSession, but it is
        // an independent conversation and must stay a sibling of its source.
        const parentId = session.isSubagent ? session.parentSession : null;
        if (parentId && parentId !== session.id && byId.has(parentId)) {
          const bucket = kids.get(parentId);
          if (bucket) bucket.push(session);
          else kids.set(parentId, [session]);
        } else {
          roots.push(session);
        }
      }

      const rows = [];
      const walk = (session, depth) => {
        const children = kids.get(session.id) ?? [];
        const folded = children.length > 0 && collapsed.has(session.id);
        rows.push({ session, depth, childCount: children.length, collapsed: folded });
        if (children.length === 0 || folded) return;
        for (const child of children) walk(child, depth + 1);
      };
      for (const session of roots) walk(session, 0);
      return rows;
    }

    /**
     * 拖动要先选中: a row only starts a native drag while it is part of
     * the pick — the row the user last clicked, or one that is ticked. Pressing
     * another row and moving draws a 框选 box instead. The price is one click
     * before a drag on a fresh row; the reward is that dragging through a list
     * you have not picked from selects what it crosses instead of silently
     * moving the row it happened to start on.
     *
     * The rows and `marqueeDrag` ask this same question and must agree: a row
     * that stayed draggable would hand the press to the browser and the box
     * would never see it, so both read the check set and the picked id.
     */
    function rowDraggable({ selected, checked }) {
      return Boolean(selected || checked);
    }

    /**
     * 双击要有时限: the browser decides what a double click is, and it
     * takes that answer from the OS double-click speed. With a slow setting two
     * leisurely presses on a row still count, and a session opens in DSH — an
     * expensive thing to do by accident while only picking rows. So the count is
     * ours: the same target, both presses inside DOUBLE_CLICK_MS. Slower than
     * that is two single clicks and nothing opens.
     *
     * `key` names the target ("session:<id>", "node:<id>"), which is what keeps
     * two clicks on *different* rows from pairing up. A hit spends the pair, so a
     * third click starts over instead of opening a second time.
     */
    const DOUBLE_CLICK_MS = 400;
    let lastPress = { key: "", at: 0 };
    function countsAsDoublePress(key, now = Date.now()) {
      const hit = Boolean(key) && key === lastPress.key && now - lastPress.at <= DOUBLE_CLICK_MS;
      lastPress = hit ? { key: "", at: 0 } : { key, at: now };
      return hit;
    }

    function SessionRow({ session, selected, now, onSelect, checked, onCheck, depth = 0, childCount = 0, collapsed = false, onToggleChildren, rename, onBeginRename, onRowContextMenu, onOpenSession, clipboard, dragSet, contentHit }) {
      const status = statusOf(session);
      const isChild = Boolean(session.isSubagent);
      return h(
        "div",
        {
          onContextMenu: onRowContextMenu
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                // Right-clicking an unselected row selects it first, so the
                // menu always acts on what the pointer is over (Explorer rule).
                if (!selected) onSelect(session.id, event);
                onRowContextMenu(event, session);
              }
            : undefined,
          className:
            "row" +
            (selected ? " sel" : "") +
            (session.archived ? " arch" : "") +
            (session.pinned ? " pinned-row" : "") +
            // A cut row stays visible but reads as "about to leave": Explorer
            // and Finder both do this, and it is the only feedback a cut has
            // until the paste happens.
            (clipboard?.mode === "cut" && clipboard.ids?.includes(session.id) ? " cut" : "") +
            (isChild ? " bound-row" : "") +
            (depth > 0 ? " sub-row" : ""),
          "data-id": session.id,
          // --indent moves the name cell; --rail is where the guide line meets
          // the *parent's* collapse chevron. Depth 0's chevron centre is 43px
          // from the row's left edge (32px check column + 8px name padding +
          // 14px twist - 4px negative margin, centre at 7px); a deeper row
          // zeroes that 8px padding, so from depth 2 on the centre is
          // 19px + indent. Both are computed here because only the row knows
          // its depth.
          style: depth > 0
            ? {
                "--indent": `${depth * 16}px`,
                "--rail": `${depth === 1 ? 43 : 19 + depth * 16}px`,
              }
            : undefined,
          // 双击要有时限: a second press on the same row within
          // DOUBLE_CLICK_MS opens the session in DSH, exactly like a double click
          // on a file opens it. The count is the panel's, not the browser's, so a
          // slow pair stays two single clicks. A trashed row has nothing to open.
          onClick: (event) => {
            if (!session.trashed && countsAsDoublePress("session:" + session.id)) {
              onOpenSession?.(session.id);
              return;
            }
            onSelect(session.id, event);
          },
          // Nothing left to do here: the second press already opened. Swallowing
          // it keeps the browser from selecting the label text instead.
          onDoubleClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
          },
          // A session row can be dragged onto a workspace row. The payload is
          // the whole checked set when the dragged row is part of it, so a
          // multi-selection moves as one gesture.
          // A subagent is part of its parent's run, so it has no checkbox: the
          // operations behind one (delete, cut, copy, 收藏, 待办, 归档) are the
          // parent's to make, and a box that can be ticked would promise them.
          // And it only drags once it is picked: an unpicked row leaves
          // the press to 框选, which is what dragging across a list should do.
          draggable: rowDraggable({ selected, checked }) && session.trashed !== true && !rename && !isChild,
          onDragStart: (event) => {
            // 多选拖动: the payload is the whole check-set, split into the
            // sessions a workspace can take and the containers that move as
            // nodes. The DataTransfer carries only the sessions — that is what a
            // session drop target can act on — while `dragPayload` keeps both
            // halves for the targets that read it.
            const set = dragSet ?? { ids: [session.id], sessions: [session.id], nodes: [] };
            const ids = set.sessions.length > 0 ? set.sessions : set.ids;
            dragPayload = { kind: "session", id: session.id, ids: set.ids, sessions: set.sessions, nodes: set.nodes };
            event.dataTransfer.setData(SESSION_DRAG_TYPE, JSON.stringify(ids));
            event.dataTransfer.effectAllowed = "copyMove";
          },
        },
        h(
          "div",
          { className: "cell col-check col-check-cell" },
          isChild
            ? h("span", { className: "chk-bound", title: T("子智能体跟随父会话：请操作父会话") }, h(Icon, { name: "branch", size: 10 }))
            : h(
                "span",
                {
                  className: "chk" + (checked ? " on" : ""),
                  onClick: (event) => {
                    event.stopPropagation();
                    onCheck(session.id);
                  },
                },
                checked ? h(Icon, { name: "check", size: 10 }) : null,
              ),
        ),
        h(
          "div",
          { className: "cell col-name" },
          h(
            "div",
            { className: "namecell" },
            childCount > 0
              ? h("span", {
                  className: "twist",
                  title: collapsed ? T("展开子智能体会话") : T("收起子智能体会话"),
                  onClick: (event) => {
                    event.stopPropagation();
                    onToggleChildren(session.id);
                  },
                }, h(Icon, { name: collapsed ? "chevright" : "chevdown", size: 12 }))
              : null,
            // A session keeps the session glyph: 所有会话 lists the same rows the
            // workspaces do, not a second, pointer-shaped kind of row.
            h(Icon, { name: isChild ? "external" : "chat", className: "ic" }),
            rename
              ? h(RenameInput, {
                  className: "nm-edit",
                  value: rename.value,
                  onChange: rename.onChange,
                  onCommit: rename.onCommit,
                  onCancel: rename.onCancel,
                })
              // Renaming is a command, never a double click: a double click on a
              // row means "open", and overloading it made the first click select
              // and the second start editing (m0xxxx).
              : h("span", { className: "nm", title: session.id }, session.displayTitle ?? session.id),
            // The pencil only exists while the row is selected or hovered: the
            // list must not sprout a control on every line. A subagent
            // has none — its title belongs to the parent's run.
            !rename && onBeginRename && !isChild
              ? h(
                  "span",
                  {
                    className: "nm-editbtn",
                    title: T("重命名"),
                    onClick: (event) => {
                      event.stopPropagation();
                      onBeginRename(session.id);
                    },
                  },
                  h(Icon, { name: "pencil", size: 11 }),
                )
              : null,
            isChild ? h("span", { className: "subtag", title: T("子智能体 · 深度 {0}", [session.delegationDepth ?? 1]) }, T("子")) : null,
            childCount > 0 && !isChild ? h("span", { className: "subtag", title: T("包含子智能体会话") }, T("{0} 子", [childCount])) : null,
            session.isSeeded && !isChild ? h("span", { className: "subtag fork", title: T("分叉自另一个会话，是独立会话") }, T("分叉")) : null,
            session.pinned ? h("span", { style: { color: "var(--sm-accent)", opacity: 0.85 } }, h(Icon, { name: "pin", size: 12 })) : null,
            session.archived ? h("span", { className: "arcbadge", title: T("已归档") }, h(Icon, { name: "archive", size: 9 })) : null,
          ),
        ),
        h(
          "div",
          { className: "cell col-tags" },
          (session.tags ?? []).slice(0, 2).map((tag) =>
            h("span", { className: "tag", key: tag, title: tag }, tag),
          ),
          // 会话内容 hits are a different kind of match from a tag, so they read
          // as a different badge, and the title carries the snippet the match came
          // from — a count with no context would only say "trust me".
          contentHit
            ? h(
                "span",
                { className: "tag hit", title: contentHit.snippet || T("会话内容命中") },
                T("内容 {0}", [formatCount(contentHit.count)]),
              )
            : null,
        ),
        h(
          "div",
          { className: "cell col-note" + (session.note ? "" : " dim"), title: session.note || undefined },
          session.note || "",
        ),
        h("div", { className: "cell col-date dim" }, formatWhen(session.activityAt, now)),
        h("div", { className: "cell col-size num dim" }, formatSize(session.sizeBytes)),
        h(
          "div",
          { className: "cell col-status" },
          h(
            "span",
            { className: "st" },
            h("span", { className: "dot " + status.cls }),
            status.text,
          ),
        ),
        h("div", { className: "cell col-fill" }),
      );
    }

    /**
     * A container row in the list: a workspace, a user folder, or one of the
     * fixed special folders.
     *
     * All three are things the user navigates *into*, so they share one row
     * shape — glyph, name, type tag, session count, checkbox — and differ in
     * what may be done to them:
     *
     *   workspace — DSH's own record; rename through the native controller.
     *   folder    — the plugin's node; rename and delete through the sidecar.
     *   special   — 未分组 / 收藏 / 待办 / 根目录: views over the session set. They
     *               cannot be renamed or deleted, because they are not the
     *               user's — deleting 收藏 would not delete anything, it would
     *               just make the shortcut disappear.
     */
    function ContainerRow({ node, count, selected, checked, onCheck, onOpen, onOpenShortcut, onSelect, rename, onBeginRename, onRename, onNodeContextMenu, dropTarget, onDropShortcut, canAcceptNode, onDropNode, onRefuse, tree, pinned, onTogglePin, sessionOf, dragSet }) {
      // Native HTML5 drag state. Two payloads may arrive: a session id list
      // (SESSION_DRAG_TYPE) and a container node id (text/plain). `over` is
      // tri-state — null (idle), "ok" (legal target), "bad" (refused) — because
      // a target that silently accepts and then fails at the host is exactly
      // the bug this validation exists to prevent.
      const [over, setOver] = useState(null);
      // The sentence already shown for the payload hovering this row; dragover
      // fires on every pointer frame and a row must not repaint the status bar
      // sixty times a second.
      const [refused, setRefused] = useState(null);
      // The row owns its editor as a fallback. The panel-driven `rename` prop is
      // the normal path, but a pencil that only *asks* the panel and then waits
      // for the answer is a pencil that looks broken whenever the answer does
      // not arrive (a stale payload, a gate that disagrees, a window that never
      // re-rendered). Clicking the pencil puts this row into editing
      // immediately, and the commit still goes through the panel's renameEntity
      // — one writer, two ways in.
      const [draft, setDraft] = useState(null);
      const editingHere = draft !== null;
      const nameOfNode = node.name ?? node.path ?? node.id;
      // A *mapping* is a member of 收藏 / 待办 that points at a folder or a
      // workspace. It is drawn as the container it names — same glyph, same
      // name, same tag — because the row stands for that container, not for a
      // second thing called 快捷方式. Only the membership is this row's own:
      // double-click goes to the original place, and the menu can only take the
      // member out of the container.
      const mapped = node.mapped ?? null;
      // A row answers a hover when it can decide about it, even when it owns no
      // handler for that payload: a 特殊文件夹 that takes nothing still greys out
      // and says why, instead of staying silent for the whole gesture.
      const accepts =
        !mapped &&
        (typeof dropTarget === "function" ||
          typeof onDropNode === "function" ||
          typeof onDropShortcut === "function" ||
          typeof canAcceptNode === "function");
      // `canAcceptNode` answers "may the container currently being dragged land
      // here?"; the list rows are the same targets as the tree rows, so they
      // share one validator instead of re-deriving the rules.
      const isWorkspace = node.type === "workspace" && !mapped;
      const isShortcut = node.kind === "shortcut";
      const isFolder = node.type === "folder" && node.kind === "folder" && !mapped;
      // A mapping keeps the target's kind for its glyph and its tag, but it is
      // its own entity for the menu: it wears the shortcut id, because that is
      // what 移出收藏 deletes.
      const kind = mapped ? "mapping" : isWorkspace ? "workspace" : isShortcut ? "shortcut" : "folder";
      // A shortcut shows its target's name; a real row shows its own.
      const label = nodeLabel(node, tree, sessionOf);
      // A folder is addressed by its own node id; a workspace by its native
      // workspaceId, because DSH owns that record and the tree id (w-<uuid>) is
      // only this panel's alias.
      const actionId = isWorkspace ? node.workspaceId ?? node.id : node.id;
      // Fixed containers are not the user's to rename or delete. The default
      // workspace is included: the host always renders that label as
      // 默认工作区, so an edit would be a silent no-op round trip.
      // A shortcut and a fixed view are not renameable; a workspace — the
      // default one included — is editable.
      const editable = mapped ? false : isWorkspace ? true : isFolder;
      // The glyph follows what the row *is*: a shortcut borrows its target's
      // type icon, and the 快捷方式 tag below is what marks the reference.
      // Row-local editing: the click opens the editor here, and the commit is
      // handed to the panel so a rename still has exactly one writer.
      const beginHere = () => {
        setDraft(nameOfNode);
        if (typeof onBeginRename === "function") onBeginRename(actionId);
      };
      // Closing the local editor must also close the panel's, otherwise a
      // `rename` the click asked for would arrive late and reopen the input.
      const closePanelEditor = () => {
        if (rename && typeof rename.onCancel === "function") rename.onCancel();
      };
      const cancelHere = () => {
        setDraft(null);
        closePanelEditor();
      };
      const commitHere = () => {
        const next = String(draft ?? "").trim();
        setDraft(null);
        closePanelEditor();
        if (!next || next === nameOfNode) return;
        if (typeof onRename === "function") onRename(kind, actionId, next);
      };
      const icon = iconOfNode(node, tree);
      // The tag names what the row stands for; a mapping therefore reads 工作区 /
      // 文件夹 and never 快捷方式 — that word is for the rows the user placed
      // themselves in a folder.
      const tag = node.type === "workspace"
        ? T("工作区")
        : node.kind === "folder"
          ? T("文件夹")
          : node.kind === "shortcut"
            ? T("快捷方式")
            : T("特殊文件夹");
      // A workspace and a user folder are the user's own containers, so they can
      // be dragged like session rows can; a 特殊文件夹 is a view and cannot. A
      // shortcut drags too: what moves is the reference, and leaving it out made
      // every pointer in the list impossible to move by hand.
      //
      // Same gate as a session row: only a picked row (clicked, or
      // ticked) drags. Every other press belongs to the 框选 box.
      const draggable = (editable || isShortcut) && rowDraggable({ selected, checked });
      return h(
        "div",
        {
          className:
            "row frow " +
            (node.type === "workspace"
              ? "wsrow"
              : node.kind === "folder"
                ? "folderrow"
                : node.kind === "shortcut"
                  ? "scrow"
                  : "specialrow") +
            (mapped ? " mapped-row" : "") +
            (selected ? " sel" : "") +
            (pinned ? " pinned-row" : ""),
          "data-id": node.id,
          "data-drop": accepts && over ? (over === "bad" ? "bad" : "1") : undefined,
          // 双击要有时限: only a second press on this row inside
          // DOUBLE_CLICK_MS enters the container. A member of 收藏 / 待办 enters
          // the *original* — the row is that container's second sighting, so
          // opening it must land where the container lives, not on a page about a
          // pointer.
          onClick: (event) => {
            if (!countsAsDoublePress("node:" + node.id)) {
              onSelect(node.id, event);
              return;
            }
            // A shortcut row opens what it points at. Navigating to its own id
            // goes nowhere, so opening a session bookmark looks dead.
            if (!mapped && node.kind === "shortcut") {
              if (typeof onOpenShortcut === "function") onOpenShortcut(node);
              else onOpen(node.id);
              return;
            }
            onOpen(mapped ? mapped.openId : node.id);
          },
          onDoubleClick: (event) => {
            event.preventDefault();
            event.stopPropagation();
          },
          // Dropping sessions on a workspace row moves them into it. Ctrl (or
          // Cmd) held at drop time asks for a copy, exactly like Explorer.
          // Only a workspace accepts sessions (one session, one workspace); a
          // folder or 特殊文件夹 greys out, which is the whole point of
          // validating here rather than letting the host refuse the write.
          draggable,
          onDragStart: draggable
            ? (event) => {
                // 多选拖动: dragging one ticked container takes every
                // ticked container with it. The payload keeps both halves, so a
                // check-set that also holds sessions still moves the folders.
                const set = dragSet ?? { ids: [node.id], sessions: [], nodes: [node.id] };
                dragPayload = { kind: "node", id: node.id, ids: set.ids, sessions: set.sessions, nodes: set.nodes };
                event.dataTransfer.setData("text/plain", node.id);
                // The same payload also feeds the 快速访问 caption, which copies.
                event.dataTransfer.effectAllowed = "copyMove";
              }
            : undefined,
          onDragEnd: () => {
            dragPayload = null;
            setOver(null);
            setRefused(null);
          },
          onDragOver: accepts
            ? (event) => {
                const types = Array.from(event.dataTransfer?.types ?? []);
                const sessionDrag = types.includes(SESSION_DRAG_TYPE);
                const nodeDrag = !sessionDrag && types.includes("text/plain");
                if (!sessionDrag && !nodeDrag) return;
                // Sessions: a workspace (a real move), a folder inside one (a
                // placement) or 收藏 / 待办 (a shortcut). Containers: the same
                // rules the tree uses, so an illegal combination greys out here
                // too. `dropTarget` is the row's own "this accepts sessions".
                const legal = sessionDrag
                  ? typeof dropTarget === "function" || typeof onDropShortcut === "function"
                  : canAcceptNode?.() === true || typeof onDropShortcut === "function";
                if (!legal) {
                  event.dataTransfer.dropEffect = "none";
                  if (over !== "bad") setOver("bad");
                  // Grey is a verdict, not an explanation: name the rule that
                  // refused it, once per hover (dragover fires every frame).
                  const reason = dropRefusalFor(node.id, sessionDrag ? "session" : "node", {
                    nodes: tree?.nodes ?? {},
                    children: tree?.children ?? {},
                  });
                  if (reason && reason !== refused) {
                    setRefused(reason);
                    onRefuse?.(reason);
                  }
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = sessionDrag && (event.ctrlKey || event.metaKey) ? "copy" : "move";
                if (over !== "ok") setOver("ok");
              }
            : undefined,
          onDragLeave: accepts
            ? () => {
                setOver(null);
                setRefused(null);
              }
            : undefined,
          onDrop: accepts
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                setOver(null);
                const types = Array.from(event.dataTransfer?.types ?? []);
                const sessionDrag = types.includes(SESSION_DRAG_TYPE);
                const sources = draggedNodeIds().filter((id) => id !== node.id);
                if (sessionDrag) {
                  const ids = draggedSessionIds(event);
                  if (ids.length === 0) return;
                  // A workspace receives the rows themselves (跨工作区移动); a
                  // folder inside a workspace receives them as 存放, so the
                  // session stays in that workspace and only its filing changes;
                  // 收藏 / 待办 receive references. One gesture, three meanings,
                  // chosen by the target's own answers — never by the row's type.
                  if (isWorkspace && typeof dropTarget === "function") dropTarget(ids, event.ctrlKey || event.metaKey);
                  else if (typeof onDropShortcut === "function") onDropShortcut(ids);
                  else if (typeof dropTarget === "function") dropTarget(ids, false);
                  return;
                }
                if (sources.length > 0 && onDropNode) onDropNode(node.id, sources);
              }
            : undefined,
          // A shortcut gets a menu too, with the one command that makes sense
          // for a reference (跳转到原位置) and no checkbox: a reference is not a
          // batch-deletable thing, it is a second sighting of one.
          onContextMenu:
            onNodeContextMenu && (editable || isShortcut || Boolean(mapped))
              ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!selected) onSelect(node.id, event);
                  onNodeContextMenu(event, { kind, id: actionId, nodeId: node.id, node, surface: "list" });
                }
              : undefined,
        },
        // A checkbox, like every other row: a folder, a workspace and a shortcut
        // are all things the user owns — a container is deleted or moved as a
        // group, a reference is taken out in bulk (the only way to drop several
        // pointers at once). A 特殊文件夹 gets no box at all — it cannot be deleted
        // or renamed, so offering a selection that no command can act on would
        // only inflate 已选 N 项.
        editable || isShortcut || Boolean(mapped)
          ? h(
              "div",
              { className: "cell col-check col-check-cell" },
              h(
                "span",
                {
                  className: "chk" + (checked ? " on" : ""),
                  title: T("选择"),
                  onClick: (event) => {
                    event.stopPropagation();
                    onCheck(node.id);
                  },
                },
                checked ? h(Icon, { name: "check", size: 10 }) : null,
              ),
            )
          : h("div", { className: "cell col-check col-check-cell" }),
        h(
          "div",
          { className: "cell col-name" },
          h(
            "div",
            { className: "namecell" },
            h("span", { className: "fl-ic" }, h(Icon, { name: icon, className: "ic " + (node.type === "workspace" ? "wsic" : node.kind === "folder" ? "folderic" : "specialic") })),
            // The editor shows when *either* owner says so: the panel through
            // `rename`, or this row through its own draft. The row-local draft
            // wins, because it is the one the click just created.
            editingHere || rename
              ? h(RenameInput, {
                  className: "nm-edit",
                  value: editingHere ? draft : rename.value,
                  onChange: editingHere ? setDraft : rename.onChange,
                  onCommit: editingHere ? commitHere : rename.onCommit,
                  onCancel: editingHere ? cancelHere : rename.onCancel,
                })
              : h("span", { className: "nm", title: node.path || node.id }, label),
            !rename && !editingHere && editable && (onBeginRename || onRename)
              ? h(
                  "span",
                  {
                    className: "nm-editbtn",
                    title: T("重命名"),
                    onClick: (event) => {
                      event.stopPropagation();
                      beginHere();
                    },
                  },
                  h(Icon, { name: "pencil", size: 11 }),
                )
              : null,
            h(
              "span",
              {
                className: "wstag" + (isWorkspace ? "" : isFolder ? " ftag" : " stag"),
                // The tag doubles as the lifecycle rule for a reference.
                title: isShortcut ? T("快捷方式 · 删除只移除标注，原节点保留") : undefined,
              },
              tag,
            ),
          ),
        ),
        h("div", { className: "cell col-tags dim" }),
        h("div", { className: "cell col-note dim" }),
        h("div", { className: "cell col-date dim" }, count ? T("{0} 个会话", [formatCount(count)]) : ""),
        h("div", { className: "cell col-size num dim" }),
        h("div", { className: "cell col-status" }),
        h("div", { className: "cell col-fill" }),
      );
    }

