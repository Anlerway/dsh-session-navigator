    // ── Fixed-node presentation ────────────────────────────────────────────
    // The host names its fixed nodes for the API; the window chrome labels them
    // the way the prototype does, because these five entries are the app's own
    // navigation, not data.
    const FIXED_META = {
      [FIXED.root]: { get label() { return T("根目录"); }, icon: "folder", tone: "default" },
      [FIXED.all]: { get label() { return T("所有会话"); }, icon: "details", tone: "default" },
      [FIXED.ungrouped]: { get label() { return T("未分组"); }, icon: "chat", tone: "default" },
      [FIXED.trash]: { get label() { return T("回收站"); }, icon: "trash", tone: "default" },
      [FIXED.todos]: { get label() { return T("待办"); }, icon: "todo", tone: "default" },
      [FIXED.favorites]: { get label() { return T("收藏"); }, icon: "star", tone: "default" },
    };

    /** Icon per node `kind`, mirroring the prototype's tree glyphs. */
    const KIND_ICON = {
      root: "folder",
      all: "details",
      "default-workspace": "home",
      workspace: "monitor",
      ungrouped: "chat",
      favorites: "star",
      todos: "todo",
      trash: "trash",
      shortcut: "shortcut",
    };

    /**
     * The label of a node, resolved for shortcuts.
     *
     * A shortcut stores no name of its own unless the user renamed it: the row
     * shows the target's current name, so renaming the target updates every
     * reference without touching the sidecar.
     *
     * A session is not a tree node, so a shortcut to one cannot be resolved
     * through `node.ref`; `sessionOf` is the session lookup that closes that
     * gap. Without it the row fell back to 失效的快捷方式 — which is exactly how
     * a brand-new shortcut to a session looked broken.
     *
     * @param {any} node
     * @param {{ nodes?: Record<string, any> } } [tree]
     * @param {(id: string) => any} [sessionOf]
     * @returns {string}
     */
    function nodeLabel(node, tree, sessionOf) {
      if (!node) return "";
      if (node.id === FIXED.root) return T("根目录");
      if (node.id === FIXED.all) return T("所有会话");
      if (node.kind === "shortcut") {
        if (node.name) return node.name;
        const target = shortcutTarget(node, tree);
        if (target) return nodeLabel(target, tree, sessionOf);
        const session =
          node.shortcutKind === "session" && typeof sessionOf === "function" ? sessionOf(node.targetId) : null;
        return session ? session.displayTitle ?? session.id : T("失效的快捷方式");
      }
      // A fixed entry's name arrives from the host in one language (it is an
      // identifier there: 所有会话 is not a title anyone typed). The panel is the
      // only side that knows what the reader reads, so the label comes from the
      // table above rather than from the wire.
      const fixed = FIXED_META[node.id];
      if (node.fixed && fixed) return fixed.label;
      // The default workspace's label is synthetic as well: the registry calls it
      // "default-workspace", the host paints 默认工作区, and the row has to follow
      // the reader's language. A workspace the user renamed carries their own
      // name, which is why this asks the flag and not the string.
      if (node.default === true) return T("默认工作区");
      return node.name ?? node.path ?? node.id;
    }

    /**
     * Resolve a shortcut's target node, or null when the target is gone.
     *
     * `ref` is the resolved target node id the host ships with the row — the
     * client never assembles a workspace id itself.
     *
     * @param {any} node a shortcut node
     * @param {{ nodes?: Record<string, any> } } [tree]
     * @returns {any | null}
     */
    function shortcutTarget(node, tree) {
      if (!node || node.kind !== "shortcut") return null;
      return node.ref ? (tree?.nodes ?? null)?.[node.ref] ?? null : null;
    }

    /**
     * Node id → icon name, so the tree and breadcrumbs agree.
     *
     * A shortcut wears the glyph of its *target*: a referenced session still
     * looks like a session, a folder like a folder, a workspace like a monitor.
     * The 快捷方式 tag is what marks the row as a pointer — swapping the glyph
     * for an arrow made the row read as a third kind of thing.
     *
     * @param {any} node
     * @param {{ nodes?: Record<string, any> } } [tree]
     */
    function iconOfNode(node, tree) {
      if (!node) return "folder";
      if (node.kind === "shortcut") {
        const target = shortcutTarget(node, tree);
        if (target) return iconOfNode(target, tree);
        // A session has no tree node to copy a glyph from; the type it points
        // at still does: sessions are conversations, so they wear the chat icon.
        if (node.shortcutKind === "session") return KIND_ICON.session ?? "chat";
        return "shortcut";
      }
      return KIND_ICON[node.kind] ?? (node.type === "workspace" ? "monitor" : "folder");
    }

    /**
     * Which DSH workspace a 新建会话 started *here* belongs to.
     *
     * Three id spaces meet at this one question: the panel asks with a tree node
     * id (`d-…` folder, `w-<uuid>` workspace, `session-…`), the detached window
     * asks with the native workspace id it learned over the bridge, and the
     * toolbar asks with nothing at all (wherever the reader is standing).
     *
     * A folder never stores the workspace it sits in — the tree derives that as
     * `homeWorkspaceId` (src/domain/tree-rules.js) — so reading `node.workspaceId`
     * answered `undefined` for every folder, and `startSession(undefined)` put the
     * draft in DSH's default workspace even when the reader was two folders deep
     * inside another one. That was the whole bug.
     *
     * A *known* node with no workspace above it (根目录, 未分组, a folder filed
     * outside every workspace) answers `null` on purpose: DSH's default workspace
     * is the honest destination there, not whichever folder happened to be open
     * before. Only an id the tree cannot place at all falls back to the scope.
     *
     * @param {string | null | undefined} asked
     * @param {string | null | undefined} scope
     * @param {{ nodes?: Record<string, any> } } [tree]
     * @returns {string | null}
     */
    function workspaceForDraft(asked, scope, tree) {
      const nodes = tree?.nodes ?? {};
      const value = typeof asked === "string" && asked ? asked : null;
      if (value) {
        const node = nodes[value] ?? null;
        if (node) return node.homeWorkspaceId ?? null;
        // A native id that arrived from the window: `w-<uuid>` names the node
        // that carries it, and a node's own id is its home workspace.
        if (nodes[`w-${value}`]?.workspaceId === value) return value;
      }
      const standing = typeof scope === "string" && scope ? nodes[scope] ?? null : null;
      return standing?.homeWorkspaceId ?? null;
    }

    /**
     * Whether 新建会话 can be honoured from `nodeId`.
     *
     * DSH files every session under a workspace — its own sidebar has no level
     * below one — so a draft asked for from 根目录, 未分组, 收藏, 待办 or 回收站
     * opens in DSH's *default* workspace, somewhere the user was not looking.
     * The entry is only offered where the answer is unambiguous: a workspace, or
     * a folder that sits inside one (`homeWorkspaceId`, derived in
     * src/domain/tree-rules.js). Every other place hides it, and `newSession`
     * refuses it too, because the keyboard and the detached window reach that
     * function without passing a menu.
     *
     * @param {string | null | undefined} nodeId
     * @param {{ nodes?: Record<string, any> } | null | undefined} [tree]
     * @returns {boolean}
     */
    function canStartDraft(nodeId, tree) {
      const value = typeof nodeId === "string" && nodeId ? nodeId : null;
      if (!value) return false;
      const node = tree?.nodes?.[value] ?? null;
      return Boolean(node && node.homeWorkspaceId);
    }

    /**
     * The folder a draft belongs in, or null when DSH's own answer is right.
     *
     * A workspace is where DSH puts the draft anyway, so only a folder asks for
     * an extra step. `asked` is whatever the caller named — a tree node id from
     * the panel, a native workspace id from a detached window — and a native id
     * names no folder, which is why the reader's own scope is the fallback.
     *
     * @param {string | null | undefined} asked
     * @param {string | null | undefined} scope
     * @param {{ nodes?: Record<string, any> } | null | undefined} [tree]
     * @param {string | null} workspaceId the workspace the draft opens in
     * @returns {string | null}
     */
    function draftFolderOf(asked, scope, tree, workspaceId) {
      const nodes = tree?.nodes ?? {};
      const direct = typeof asked === "string" && asked ? nodes[asked] ?? null : null;
      const standing = typeof scope === "string" && scope ? nodes[scope] ?? null : null;
      const node = direct ?? standing;
      if (!node || node.kind !== "folder" || node.fixed === true) return null;
      // A folder outside every workspace cannot receive the draft: the host
      // refuses the placement, and the row would have nowhere to appear.
      if (!workspaceId || node.homeWorkspaceId !== workspaceId) return null;
      return node.id;
    }

    /**
     * Tell the host to file the draft this click is about to open into `parent`.
     *
     * DSH's `startSession` only takes a workspace, and it decides the session id,
     * so a folder can only be applied *after* the session exists. The intent is
     * armed first on purpose: the host then knows which sessions were already
     * there, and the next one in that workspace is unambiguously the draft. The
     * panel closes as soon as the draft opens, which is exactly why the host —
     * not this component — has to be the one waiting for it.
     *
     * Best effort: a draft that opens at the workspace root is what happened
     * before this existed, and a failed request must never stop the draft.
     *
     * @param {string} parent folder node id
     * @returns {Promise<unknown>}
     */
    function armDraftPlacement(parent) {
      return fetch(`${API}/sessions/placement/pending`, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ parent }),
      }).catch(() => null);
    }

    const COLUMNS = {
      name: { get label() { return T("名称"); }, cls: "col-name" },
      tags: { get label() { return T("标签"); }, cls: "col-tags" },
      note: { get label() { return T("备注"); }, cls: "col-note" },
      updated: { get label() { return T("上次对话"); }, cls: "col-date" },
      size: { get label() { return T("大小"); }, cls: "col-size" },
      status: { get label() { return T("状态"); }, cls: "col-status" },
    };
    const COL_ORDER = ["name", "tags", "note", "updated", "size", "status"];

    /**
     * CSS size for the panel, mirroring `modalSizeOf` in src/domain/settings.js.
     *
     * The client cannot import a host module (the bundle is a single file with
     * no build step), so the two implementations are kept in step by the test
     * suite rather than by a shared import. Keeping the numbers here instead of
     * only in CSS is what lets the native Modal frame receive an exact size.
     *
     * @param {{ sizing?: string, size?: string, percent?: string } | null} modal
     * @returns {{ width: string, height: string }}
     */
    function frameSizeOf(modal) {
      if (modal?.sizing === "percent") {
        const share = MODAL_SHARE[modal?.percent] ?? MODAL_SHARE.p70;
        return { width: `${share}vw`, height: `${share}vh` };
      }
      const [width, height] = MODAL_FIXED[modal?.size] ?? MODAL_FIXED.md;
      return { width: `min(${width}px, 94vw)`, height: `min(${height}px, 90vh)` };
    }

    // ── Session status ─────────────────────────────────────────────────────
    // The ladder is DSH's own (`sessionStatuses()`, ui-workspace
    // rows/Rows.tsx:344): a pending interaction outranks live activity, live
    // activity outranks a completion reminder, and 空闲 is what is left.
    //
    // The panel reports no state DSH does not report, so two plausible-looking
    // states are left out:
    //
    //   已中断 — it would have to be inferred from the log ending inside a turn. A
    //            crashed turn and a turn whose tail is a `session/title` look the
    //            same from outside, DSH decides liveness in memory, and the list
    //            would mark finished conversations interrupted.
    //   异常   — `formatVersion !== 4`. DSH treats an old payload as a session
    //            that needs a migration, not as a fault.
    //
    // 回收站 stays: it is not a claim about liveness but this plugin's own bin,
    // and those payloads are absent from DSH's list entirely — a row has to say
    // why it cannot be opened.

    /**
     * DSH's pending-interaction kinds and the copy it draws for each.
     *
     * Getters, not plain strings, for the same reason `FIXED_META` uses them: a
     * string would freeze at whichever language the module happened to load in,
     * and switching language would leave these three labels behind.
     */
    const PENDING_LABEL = {
      get approval() { return T("等待审批"); },
      get "plan-review"() { return T("计划待审"); },
      get question() { return T("等待回答"); },
    };

    /**
     * The kind of one pending interaction, as DSH's tree names it.
     *
     * @param {unknown} interaction
     * @returns {"approval" | "plan-review" | "question" | null}
     */
    function pendingKindOf(interaction) {
      const kind = typeof interaction === "string" ? interaction : interaction?.kind;
      return typeof kind === "string" && Object.prototype.hasOwnProperty.call(PENDING_LABEL, kind) ? kind : null;
    }

    /**
     * Fold DSH's client status snapshot into the rows the list draws.
     *
     * `uiSession.sessionStatus` is the client-side twin of the answer DSH's own
     * sidebar is built from — running, the highest-precedence pending
     * interaction, and the unread-completion reminder
     * (`packages/client/ui-session/src/client/index.ts:299-305`) — so reading it
     * is what makes the panel agree with the sidebar instead of guessing from
     * the bootstrap snapshot. A host that does not provide the service yields an
     * empty map, and every row then falls back to the `running` flag the plugin
     * already has.
     *
     * The subagent count is computed here rather than read from DSH's
     * `subagentCatalog` projection: the panel holds every row already, so a
     * running child is a row whose `isSubagent` links to this parent.
     *
     * @param {object[]} sessions
     * @param {Map<string, { running?: boolean, pendingInteraction?: unknown, completionUnread?: boolean }> | null} statuses
     * @returns {object[]}
     */
    function withDshStatus(sessions, statuses) {
      if (!sessions.length) return sessions;
      const isRunning = (session) => statuses?.get(session.id)?.running ?? session.running === true;
      /** @type {Map<string, number>} */
      const runningChildren = new Map();
      for (const session of sessions) {
        if (!session.isSubagent || !session.parentSession) continue;
        if (!isRunning(session)) continue;
        runningChildren.set(session.parentSession, (runningChildren.get(session.parentSession) ?? 0) + 1);
      }
      let changed = false;
      const out = sessions.map((session) => {
        const entry = statuses?.get(session.id) ?? null;
        const pending = pendingKindOf(entry?.pendingInteraction);
        const dsh = {
          pending,
          running: entry ? entry.running === true : undefined,
          completed: entry?.completionUnread === true,
          subagents: runningChildren.get(session.id) ?? 0,
        };
        if (!dsh.pending && dsh.running === undefined && !dsh.completed && dsh.subagents === 0) return session;
        changed = true;
        return { ...session, dsh };
      });
      return changed ? out : sessions;
    }

    /**
     * DSH's live session status, as a React subscription.
     *
     * The client service is optional: a DSH build without `uiSession` (or a
     * panel opened before the service activates) subscribes to nothing and
     * reports `null`, which `withDshStatus` reads as "no opinion".
     *
     * @returns {Map<string, object> | null}
     */
    function useDshSessionStatus() {
      const source = () => {
        try {
          return serviceOf("uiSession")?.sessionStatus ?? null;
        } catch {
          return null;
        }
      };
      // A panel mounted before the service activates would otherwise never learn
      // about it: nothing re-renders on the service appearing. `ctx.inject` runs
      // its callback now when the service is already there and again when it
      // shows up, so the subscription starts at the right moment either way.
      const [, bump] = useState(0);
      useEffect(() => {
        if (source() || !hostCtx || typeof hostCtx.inject !== "function") return undefined;
        let off = null;
        try {
          off = hostCtx.inject(["uiSession"], () => bump((tick) => tick + 1));
        } catch {
          off = null;
        }
        return typeof off === "function" ? off : undefined;
      }, []);
      const subscribe = useCallback((onChange) => {
        const observable = source();
        if (!observable || typeof observable.subscribe !== "function") return () => {};
        try {
          const off = observable.subscribe(onChange);
          return typeof off === "function" ? off : () => {};
        } catch {
          return () => {};
        }
      }, []);
      const read = useCallback(() => {
        const observable = source();
        if (!observable || typeof observable.getSnapshot !== "function") return null;
        try {
          return observable.getSnapshot() ?? null;
        } catch {
          return null;
        }
      }, []);
      const local = useSyncExternalStore(subscribe, read, read);
      // A document without the service (the detached window runs against a
      // shim) has no status of its own, so the peer's rows are all it has.
      // The version is what re-renders when those rows arrive.
      const version = useSyncExternalStore(subscribePeerStatus, readPeerStatus, readPeerStatus);
      // The result is rebuilt, never handed back as the live map. Everything
      // downstream memoises on its identity — `withDshStatus` folds these rows
      // into the list, and the list rebuilds only when that input changes. The
      // window was returning `peerStatus` itself, so every announcement arrived,
      // bumped the version, re-rendered this component and then died in a
      // `useMemo` that saw the same reference: the rows kept the badges from the
      // last reload and the screen was a beat behind the data it already had.
      const merged = useMemo(() => {
        if (peerStatus.size === 0) return local;
        if (!local) return new Map(peerStatus);
        // Local wins per id: this document is looking at the live service, the
        // peer's rows are only the last thing it published.
        const out = new Map(peerStatus);
        local.forEach((entry, id) => out.set(id, entry));
        return out;
      }, [local, version]);
      // Hand this document's rows to the peer so both surfaces draw the same
      // badges. Only a document that has the service publishes — the other one
      // has nothing to add, and republishing what it just received would keep
      // the two echoing each other. `publishStatusSnapshot` also drops a
      // repaint that changed nothing, and carries the rows across processes.
      useEffect(() => {
        if (!local) return;
        publishStatusSnapshot(statusRowsOf(local));
      }, [local]);
      // A held question expires on the clock, not on a message: a turn that
      // stops quietly would otherwise keep 等待回答 on screen until something
      // else happened to re-render. Wait exactly as long as the longest one
      // still running, then ask for the frame that drops it.
      const [, expireLinger] = useState(0);
      useEffect(() => {
        const now = Date.now();
        let soonest = Infinity;
        for (const held of pendingLinger.values()) {
          if (held.until > now && held.until < soonest) soonest = held.until;
        }
        if (!Number.isFinite(soonest)) return undefined;
        const timer = setTimeout(
          () => expireLinger((tick) => tick + 1),
          Math.max(8, soonest - now) + 8,
        );
        return () => clearTimeout(timer);
      }, [version, expireLinger]);
      return merged;
    }

    /**
     * The status badge for one row.
     *
     * @param {any} session
     * @returns {{ cls: string, text: string }}
     */
    function statusOf(session) {
      const id = session.id;
      // A trashed session cannot be running: its process was stopped before the
      // payload moved. Saying 空闲 would imply it is ready to open.
      if (session.trashed) return { cls: "", text: T("已删除") };
      const dsh = session.dsh ?? null;
      const pending = dsh?.pending ? PENDING_LABEL[dsh.pending] : null;
      if (pending) return { cls: "warn", text: pending };
      // A question answered a moment ago keeps its badge: the turn takes a
      // little longer to report that it stopped, and drawing that gap is what
      // made the row flash 进行中 on its way to 空闲 (see PENDING_LINGER_MS).
      //
      // Only while the row has gone quiet, though. A row the page still calls
      // live is not owed an old badge: the question was answered and the turn
      // went on, and holding the badge over that draws 等待回答 on a session
      // that is plainly working — the mirror image of the flash this hold was
      // added to remove.
      const held = pendingLinger.get(id);
      const peerRow = peerStatus.get(id);
      if (held && held.until > Date.now()) {
        const label = PENDING_LABEL[held.kind];
        if (peerRow?.running !== true && label) return { cls: "warn", text: label };
      }
      // Live next: DSH's in-memory answer wins, and the plugin's own `running`
      // (the same `agents.get(id)?.status === 'running'` read on the host) is the
      // fallback when the UI service is not there.
      const pageRunning = dsh?.running;
      if (pageRunning ?? session.running === true) return { cls: "run", text: T("进行中") };
      const subagents = dsh?.subagents ?? 0;
      if (subagents > 0) return { cls: "run", text: T("{n} 个子智能体运行中", { n: subagents }) };
      if (dsh?.completed) return { cls: "done", text: T("已完成") };
      return { cls: "", text: T("空闲") };
    }

    /**
     * The three sortable fields, in the order the menu lists them.
     *
     * Only these are sortable. Tags and notes are free text with no natural
     * order, and the status badge is a label users read as a filter rather than
     * a sort key — offering it produced headers that did nothing.
     */
    const SORT_FIELDS = Object.freeze([
      { key: "name", get label() { return T("名称"); } },
      { key: "updated", get label() { return T("会话日期"); } },
      { key: "size", get label() { return T("大小"); } },
    ]);

    /** Default direction per field: names read A→Z, dates and sizes newest/biggest first. */
    const SORT_DEFAULT_DIR = Object.freeze({ name: "asc", updated: "desc", size: "desc" });

    function sortValue(session, key) {
      if (key === "name") return session.displayTitle ?? "";
      if (key === "updated") return session.activityAt ?? 0;
      if (key === "size") return session.sizeBytes ?? 0;
      return 0;
    }

    function compareBy(key, dir) {
      return (a, b) => {
        const left = sortValue(a, key);
        const right = sortValue(b, key);
        let result;
        if (typeof left === "string" || typeof right === "string") {
          result = String(left).localeCompare(String(right), "zh-CN");
        } else {
          result = left - right;
        }
        // A stable tiebreak keeps equal rows from swapping on every re-render.
        if (result === 0) result = String(a.id).localeCompare(String(b.id));
        return result * dir;
      };
    }

