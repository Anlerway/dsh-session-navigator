      // ── native operations ────────────────────────────────────────────────
      // Rename, fork, archive and pin all exist in DSH itself. These callbacks
      // only forward to the host routes that wrap the native services; the
      // plugin stores none of them, so the official UI and this panel always
      // agree (hard constraint 2 / S8).

      // The editor itself lives in 13e-hook-rename-editor.js: one entry point
      // for the three surfaces, the draft, and the commit rule (an unchanged or
      // emptied name is a cancel, not a write).
      const { renaming, beginRename, beginRenameAfterClick, cancelRename, commitRename, renameProps, renameEntity } = useRenameEditor({
        mutate,
        tree,
        sessionsById,
        setHint,
        blockedByBinding,
      });

      /**
       * Run one native session operation over every target session.
       *
       * 归档/置顶/分叉 are DSH's own session lifecycle, and a container can sit in
       * the check-set (folders and workspaces have a checkbox), so a container
       * must never be sent to a route that would only answer session/not-found.
       * Skipping it is right; skipping it *silently* is not: with one session and
       * three folders checked, a plain "已归档" leaves the user believing the
       * folders went with it.
       */
      const forEachTarget = useCallback(
        async (path, body, successHint) => {
          const ids = targets.filter((id) => sessionsById.has(id));
          const skipped = targets.length - ids.length;
          if (ids.length === 0) {
            setHint(targets.length > 0 ? T("这些操作只作用于会话，请先选择会话") : T("先选择要操作的会话"));
            return;
          }
          // 归档/置顶/取消归档 are the parent's to make: a child inherits both.
          if (blockedByBinding(ids)) return;
          await mutate(async () => {
            for (const id of ids) {
              await apiSend("POST", `/sessions/${encodeURIComponent(id)}${path}`, body ?? {});
            }
          }, skipped > 0 ? T("{0}（已跳过 {1} 个目录）", [successHint, skipped]) : successHint);
          // 归档 / 置顶 live in DSH's workspace registry, and it announces nothing
          // when they change: DSH's own sidebar kept the old grouping until the
          // app restarted. The panel made the change, so the panel is the side
          // that tells DSH to re-pull.
          await requestDshRefresh();
        },
        [blockedByBinding, mutate, sessionsById, targets],
      );

      const togglePin = useCallback(() => {
        if (targets.length === 0) {
          setHint(T("先选择要置顶的会话"));
          return;
        }
        if (!sessionsById.has(targets[0])) {
          setHint(T("置顶只对会话有效"));
          return;
        }
        // The first *session* decides the direction: a container sitting in front
        // of it in the check-set must not turn the whole action into a refusal.
        const firstSession = targets.find((id) => sessionsById.has(id));
        if (!firstSession) {
          setHint(T("置顶只对会话有效"));
          return;
        }
        // 最新置顶在最前, so "all pinned" means "the first target is pinned".
        const pinned = sessionsById.get(firstSession)?.pinned === true;
        forEachTarget(pinned ? "/unpin" : "/pin", {}, pinned ? T("已取消置顶") : T("已置顶"));
      }, [forEachTarget, sessionsById, targets]);

      /**
       * 归档 / 取消归档.
       *
       * `value` makes the direction explicit so the 更多 menu can offer both
       * without guessing: the toolbar button toggles (undefined), the menu items
       * ask for a specific direction. Archiving keeps the log and the position,
       * it only de-emphasises the row (hard constraint 3).
       */
      const setArchive = useCallback(async (value) => {
        if (targets.length === 0) {
          setHint(T("先选择要归档的会话"));
          return;
        }
        if (!targets.some((id) => sessionsById.has(id))) {
          setHint(T("归档只对会话有效"));
          return;
        }
        // true = archive, false = unarchive, undefined = toggle off the first row.
        const wantArchive = value === undefined
          ? sessionsById.get(targets[0])?.archived !== true
          : value === true;
        if (!wantArchive) {
          forEachTarget("/unarchive", {}, T("已取消归档"));
          return;
        }
        // Archiving keeps the log and the position; it only de-emphasises the
        // row (hard constraint 3). A session with running work is refused by the
        // host with workspace/session-active, so the user gets a confirmation
        // instead of a silent failure.
        const running = targets.some((id) => sessionsById.get(id)?.running === true);
        if (running) {
          const confirmed = await dialogs.confirm({
            title: T("会话正在运行"),
            message: T("其中有会话正在运行。停止运行并归档？未完成的回合会被中断。"),
            confirmLabel: T("停止并归档"),
            danger: true,
          });
          if (!confirmed) return;
          forEachTarget("/archive", { stopActivity: true }, T("已停止运行并归档"));
          return;
        }
        forEachTarget("/archive", {}, T("已归档"));
      }, [dialogs, forEachTarget, sessionsById, targets]);
      const toggleArchive = useCallback(() => setArchive(undefined), [setArchive]);

      const forkSession = useCallback(() => {
        const session = selected ? sessionsById.get(selected) : null;
        if (!session) {
          setHint(T("先选择一个会话再分叉"));
          return;
        }
        // A fork of a delegation would be a standalone copy of part of a run.
        if (blockedByBinding([session.id])) return;
        mutate(async () => {
          const result = await apiSend("POST", `/sessions/${encodeURIComponent(session.id)}/fork`, {});
          if (result?.sessionId) setSelected(result.sessionId);
        }, T("已分叉出一个新会话"));
      }, [blockedByBinding, mutate, selected, sessionsById]);

      // ── commands that are still placeholders ─────────────────────────────
      // Toggle, not open: the outside-mousedown handler cannot close a menu the
      // same pointer press is about to re-open, so the button owns the switch.
      const moreMenu = useCallback((event) => {
        const element = event?.currentTarget ?? null;
        const rect = element?.getBoundingClientRect?.();
        setMore((previous) =>
          previous
            ? null
            : { element, left: rect?.left ?? 200, bottom: rect?.bottom ?? 100 },
        );
      }, []);

      // 剪切 / 复制 / 粘贴 lives in 13f-hook-clipboard.js: the clipboard state,
      // the two paste targets, the three transactions and Ctrl+X/C/V.
      const {
        clipboard,
        setClipboard,
        cutOrCopy,
        pasteTarget,
        nodePasteTarget,
        placeSessions,
        pasteClipboard,
        moveSessionsTo,
      } = useClipboard({
        idsToActOn,
        nodeIdsToActOn,
        setHint,
        sessionsById,
        blockedByBinding,
        tree,
        scope,
        load,
        setErrorText,
        describeError,
        undoStack,
        mutate,
        moveFailureHint,
        dialogOpenRef,
      });

      /**
       * 新建会话.
       *
       * DSH owns session creation: uiWorkspace.startSession(workspaceId) opens a
       * draft bound to that workspace, and a draft only becomes a real session
       * once the user sends something. Creating one any other way would produce
       * a session DSH's own sidebar does not know about, so the plugin asks the
       * host instead of writing anything.
       */
      const newSession = useCallback((targetWorkspaceId) => {
        const uiWorkspace = serviceOf("uiWorkspace");
        if (!uiWorkspace || typeof uiWorkspace.startSession !== "function") {
          setHint(T("当前 DSH 版本没有开放新建会话接口"));
          return;
        }
        // The draft belongs where the user is standing: the row they asked from
        // (a workspace, a folder inside one, a session), else the scope's nearest
        // workspace. `workspaceForDraft` owns that rule — reading
        // `node.workspaceId` here is what used to send every draft made inside a
        // folder to the default workspace.
        const workspaceId = workspaceForDraft(targetWorkspaceId, scope, tree);
        // 新建会话 outside a workspace is refused rather than redirected to DSH's
        // default one (maintainer instruction, 2026-11-05): the menus do not
        // offer it there, and the keyboard (Ctrl+N) and the detached window
        // arrive without a menu, so the rule belongs here as well.
        if (!workspaceId) {
          setHint(T("新建会话只能在某个工作区里"));
          return;
        }
        // A folder is not a place DSH knows about. Arm the host *before* the
        // draft exists — the baseline it remembers is what makes the new row
        // recognisable — and it files the session into the folder the moment
        // DSH's log appears, panel open or not.
        const folder = draftFolderOf(targetWorkspaceId, scope, tree, workspaceId);
        if (folder) void armDraftPlacement(folder);
        try {
          uiWorkspace.startSession(workspaceId);
          // Same rule as 打开: an overlay steps aside for the draft it just
          // opened, a window does not — it would be closing itself.
          if (windowHost()) setHint(T("已在 DSH 中新建会话"));
          else panelStore.set(false);
        } catch (error) {
          setHint(String(error?.message ?? error));
        }
      }, [scope, tree]);

      useEffect(() => {
        if (!hint) return;
        const timer = setTimeout(() => setHint(""), 2600);
        return () => clearTimeout(timer);
      }, [hint]);

