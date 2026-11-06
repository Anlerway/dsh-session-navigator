    // ── Panel hook: the clipboard ──────────────────────────────────────────
    // 剪切 / 复制 / 粘贴 is the panel's own clipboard, not the OS one: it names
    // ids and a mode, never a file, so a cut that was never pasted leaves every
    // payload exactly where it was. The host route underneath it *is* a real
    // cross-workspace move (artifact re-homed, header cwd rewritten).

    /**
     * Cut / copy / paste, the two paste targets and the drag-move transaction.
     *
     * The setters it writes (`hint`, `errorText`, the undo stack) stay in Panel:
     * every other write in the panel reports through the same three.
     */
    function useClipboard({
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
    }) {      // ── clipboard (剪切 / 复制 / 粘贴) ────────────────────────────────────
      // The host route is a real cross-workspace move (artifact re-homed + the
      // header cwd rewritten + registry accounting swapped; lib/host/move.js).
      // The clipboard itself is client state: it names the ids and the mode, and
      // it never stores a file — a cut that was never pasted leaves everything
      // exactly where it was, which is what users expect from Explorer.
      const [clipboard, setClipboard] = useState({ mode: null, ids: [], nodes: [] });

      const cutOrCopy = useCallback(
        (mode) => {
          const sessions = idsToActOn();
          const nodes = nodeIdsToActOn();
          if (sessions.length === 0 && nodes.length === 0) {
            setHint(T("先选择要操作的会话或目录"));
            return;
          }
          const blocked = sessions.find((id) => sessionsById.get(id)?.trashed);
          if (blocked) {
            setHint(T("回收站里的会话不能移动；先还原它"));
            return;
          }
          // Cutting or copying a delegation would paste a fragment of one run as
          // a session of its own; the parent is the unit of movement.
          if (blockedByBinding(sessions)) return;
          // A container is only ever moved: duplicating a folder would have to
          // duplicate its children, and the registry has no notion of a copied
          // workspace. This is the one place the rule lives — the menu items and
          // the command bar disable 复制 to say it before the click, and paste is
          // refused again below in case a stale clipboard gets that far.
          if (mode === "copy" && nodes.length > 0) {
            setHint(T("目录只能剪切，不能复制：只勾选会话才能复制"));
            return;
          }
          // A container is not pasted into a workspace: it moves to another
          // *folder*. The clipboard carries both kinds so one 剪切/复制 button
          // works on whichever row is selected.
          setClipboard({ mode, ids: sessions, nodes });
          const total = sessions.length + nodes.length;
          const noun = nodes.length > 0 && sessions.length === 0 ? T("目录") : T("会话");
          setHint(
            mode === "cut"
              ? T("已剪切 {0} 个{1}，转到目标位置后粘贴", [total, noun])
              : T("已复制 {0} 个{1}，转到目标位置后粘贴", [total, noun]),
          );
        },
        [blockedByBinding, idsToActOn, nodeIdsToActOn, sessionsById],
      );

      /**
       * Where a paste would land, as a native workspace id.
       *
       * The clipboard needs a *workspace*, not a tree node: a folder is the
       * plugin's own grouping, and moving a session into it is a virtual
       * placement, not a file move. Reading the nearest workspace from the tree
       * is the same rule the rest of the panel uses (nearestWorkspace on the
       * host, the parent chain here).
       */
      const pasteTarget = useMemo(() => {
        const nodes = tree?.nodes ?? {};
        let cursor = nodes[scope] ?? null;
        const guard = new Set();
        while (cursor && !guard.has(cursor.id)) {
          guard.add(cursor.id);
          if (cursor.workspaceId) return { workspaceId: cursor.workspaceId, name: nodeLabel(cursor, tree) };
          cursor = cursor.parent ? nodes[cursor.parent] ?? null : null;
        }
        return null;
      }, [scope, tree]);

      /**
       * Where a *container* paste would land: the node the user is standing in.
       *
       * Sessions need a workspace (that is where a session lives); folders and
       * workspaces need a container, and the current scope already is one. The
       * two targets are separate because "paste a session" and "paste a folder"
       * are different operations with different validity rules.
       */
      const nodePasteTarget = useMemo(() => {
        const node = tree?.nodes?.[scope] ?? null;
        if (!node) return null;
        // A fixed view (收藏 / 待办 / 回收站) is not a directory. 未分组 is one — it
        // holds real sessions and, since folders may live there, directories too.
        if (node.fixed && node.id !== FIXED.root && node.id !== FIXED.ungrouped) return null;
        return { nodeId: node.id, name: nodeLabel(node, tree) };
      }, [scope, tree]);

      /**
       * Put sessions into a container *without* touching their directory.
       *
       * 未分组 holds sessions of its own, but a session that belongs to a
       * workspace can only be re-homed by moving it — DSH reads the workspace
       * from the header `cwd`, and hard constraint 1 forbids rewriting
       * `sessions/`. The host therefore stores a grouping override in the tree
       * sidecar; this is the one call that writes it.
       */
      const placeSessions = useCallback(
        async (ids, parentId) => {
          if (!ids?.length || !parentId) return false;
          const name = nodeLabel(tree?.nodes?.[parentId], tree) || T("未分组");
          // The workspace each session is filed in *now*, so undo can put a
          // payload that had to be re-homed back where it came from.
          const before = new Map();
          for (const id of ids) before.set(id, sessionsById.get(id)?.workspaceId ?? null);
          let result = null;
          try {
            // `move: true`: a folder that sits in another workspace pulls the
            // payload into that workspace first and only then files it inside
            // the folder — 工作区内的文件夹里移动就是一次真实移动, not a label the
            // row wears while the file stays behind. Same workspace keeps the
            // old, purely virtual write.
            result = await apiSend("POST", "/sessions/placement", { ids, parent: parentId, move: true });
            await load(true);
          } catch (error) {
            setErrorText(describeError(error));
            setHint("");
            if (error?.code === "revision-conflict") await load(true);
            return false;
          }
          const moved = Array.isArray(result?.moved) ? result.moved.filter((id) => typeof id === "string") : [];
          const failed = Array.isArray(result?.failed) ? result.failed.filter((row) => row?.sessionId) : [];
          if (moved.length > 0) {
            // A real move changed the header cwd, so DSH's own sidebar is
            // showing a stale workspace until it re-pulls: tell it, exactly as
            // 剪切/粘贴 does.
            await requestDshRefresh();
          }
          if (failed.length > 0) {
            // Half a batch landed; name the ones that did not instead of
            // implying the whole drop was accepted.
            setErrorText(describeError(failed[0]));
            setHint("");
            if (moved.length === 0) return false;
          } else {
            setErrorText("");
            setHint(
              moved.length > 0
                ? T("已移动 {0} 个会话到「{1}」", [ids.length, name])
                : T("已把 {0} 个会话放到「{1}」", [ids.length, name]),
            );
          }
          setClipboard({ mode: null, ids: [], nodes: [] });
          undoStack.current.push({
            label:
              moved.length > 0
                ? T("已把 {0} 个会话移回原来的工作区", [ids.length])
                : T("已把 {0} 个会话放回原来的位置", [ids.length]),
            run: async () => {
              await apiSend("POST", "/sessions/placement", { ids, parent: "" });
              if (moved.length === 0) return;
              // Undoing a re-home is a move back, grouped by the workspace each
              // session came from.
              const groups = new Map();
              for (const id of moved) {
                const workspaceId = before.get(id) ?? null;
                if (!workspaceId) continue;
                const bucket = groups.get(workspaceId) ?? [];
                bucket.push(id);
                groups.set(workspaceId, bucket);
              }
              for (const [workspaceId, backIds] of groups) {
                await apiSend("POST", "/move", { ids: backIds, target: { workspaceId } });
              }
              await requestDshRefresh();
            },
          });
          return true;
        },
        [describeError, load, refreshDshViews, sessionsById, tree],
      );

      const pasteClipboard = useCallback(async () => {
        if (clipboard.ids.length === 0 && (clipboard.nodes?.length ?? 0) === 0) {
          setHint(T("剪贴板是空的：先剪切或复制"));
          return;
        }
        // 收藏 / 待办 are pages of references, not destinations: a session paste
        // would have to invent a workspace and a folder paste a container, and
        // quietly turning either into "add a shortcut" would make the page's own
        // verbs (the star, 收藏 N 项, 粘贴到此处（快捷方式） on the container row)
        // ambiguous. So paste stays out of these two pages.
        if (scope === FIXED.favorites || scope === FIXED.todos) {
          setHint(T("收藏和待办页不能粘贴：用星标把会话加进来"));
          return;
        }
        // Containers first: they are the operation the user can see in the tree,
        // and a session paste below still needs its own workspace target.
        if ((clipboard.nodes?.length ?? 0) > 0) {
          if (!nodePasteTarget) {
            setHint(T("当前位置不能放目录，先进入一个文件夹或根目录再粘贴"));
            return;
          }
          if (clipboard.mode === "copy") {
            setHint(T("目录不支持复制粘贴；请用拖拽移动"));
            return;
          }
          const moving = clipboard.nodes;
          const ok = await mutate(async () => {
            for (const nodeId of moving) {
              if (nodeId === nodePasteTarget.nodeId) continue;
              await apiSend("POST", `/nodes/${encodeURIComponent(nodeId)}/move`, { parent: nodePasteTarget.nodeId });
            }
          }, T("已移动 {0} 个目录到「{1}」", [moving.length, nodePasteTarget.name]));
          if (!ok) return;
          setClipboard({ mode: null, ids: [], nodes: [] });
          setHint(T("已移动 {0} 个目录到「{1}」", [moving.length, nodePasteTarget.name]));
          return;
        }
        // Standing inside a folder makes that folder the destination. A cut is
        // a real move into the folder's workspace plus a placement inside the
        // folder; a copy has to duplicate the payload first and then file the
        // *new* ids. Without this branch the paste landed in the workspace root,
        // one level above the folder the user had just opened.
        const hereNode = tree?.nodes?.[scope] ?? null;
        const folderHere =
          hereNode && hereNode.type === "folder" && hereNode.kind === "folder" && !hereNode.fixed ? hereNode : null;
        if (folderHere) {
          const folderIds = clipboard.ids;
          const folderCopy = clipboard.mode !== "cut";
          if (!folderCopy) {
            const placed = await placeSessions(folderIds, scope);
            if (placed) setClipboard({ mode: null, ids: [], nodes: [] });
            return;
          }
          if (!pasteTarget) {
            setHint(T("当前位置不属于任何工作区，先进入一个工作区再粘贴"));
            return;
          }
          try {
            const result = await apiSend("POST", "/move", {
              ids: folderIds,
              target: { workspaceId: pasteTarget.workspaceId },
              copy: true,
            });
            const fresh = (Array.isArray(result?.results) ? result.results : [])
              .filter((row) => row && row.ok !== false && typeof row.sessionId === "string")
              .map((row) => row.sessionId);
            if (fresh.length > 0) await apiSend("POST", "/sessions/placement", { ids: fresh, parent: scope });
            await load(true);
            await requestDshRefresh();
            const problem = moveFailureHint(result, true);
            if (problem) {
              setErrorText(problem);
              setHint("");
              return;
            }
            setErrorText("");
            setHint(T("已复制 {0} 个会话到「{1}」", [fresh.length, nodeLabel(folderHere, tree)]));
          } catch (error) {
            setErrorText(describeError(error));
            setHint("");
            if (error?.code === "revision-conflict") await load(true);
          }
          return;
        }
        if (!pasteTarget) {
          setHint(T("当前位置不属于任何工作区，先进入一个工作区再粘贴"));
          return;
        }
        const ids = clipboard.ids;
        const copy = clipboard.mode !== "cut";
        const previous = ids.map((id) => sessionsById.get(id)).filter(Boolean);
        const ok = await mutate(
          () => apiSend("POST", "/move", { ids, target: { workspaceId: pasteTarget.workspaceId }, copy }),
          copy ? T("已复制 {0} 个会话到「{1}」", [ids.length, pasteTarget.name]) : T("已移动 {0} 个会话到「{1}」", [ids.length, pasteTarget.name]),
          (payload) => moveFailureHint(payload, copy),
        );
        if (!ok) return;
        // A cut is consumed by a successful paste; a copy stays on the
        // clipboard so the user can paste it into several workspaces.
        // DSH's sidebar does not know the file moved until it re-pulls its
        // baseline; do that before the undo entry so the user sees the row in
        // its new workspace while the toast is still on screen.
        await requestDshRefresh();
        if (!copy) {
          setClipboard({ mode: null, ids: [], nodes: [] });
          // Undo (S6) sends the sessions back to the workspace they came from,
          // which is itself a move. It is registered only for a cut: undoing a
          // copy would mean deleting the copy, a far more dangerous operation
          // than the one the user asked to take back.
          const groups = new Map();
          for (const session of previous) {
            if (!session.workspaceId || session.workspaceId === pasteTarget.workspaceId) continue;
            const bucket = groups.get(session.workspaceId) ?? [];
            bucket.push(session.id);
            groups.set(session.workspaceId, bucket);
          }
          if (groups.size > 0) {
            undoStack.current.push({
              label: T("已把 {0} 个会话移回原来的工作区", [ids.length]),
              run: async () => {
                for (const [workspaceId, movedIds] of groups) {
                  await apiSend("POST", "/move", { ids: movedIds, target: { workspaceId } });
                }
                // Undoing a move is a move too — the sidebar was told
                // about the forward direction, so it has to be told about this.
                await requestDshRefresh();
              },
            });
          }
        }
      }, [
        clipboard,
        describeError,
        idsToActOn,
        load,
        moveFailureHint,
        mutate,
        nodePasteTarget,
        pasteTarget,
        placeSessions,
        refreshDshViews,
        scope,
        sessionsById,
        tree,
      ]);

      /**
       * Drag a session row onto a workspace row: the same transaction as paste,
       * with the target taken from the row that was dropped on.
       */
      const moveSessionsTo = useCallback(
        async (ids, workspaceId, copy) => {
          const target = Object.values(tree?.nodes ?? {}).find((node) => node.workspaceId === workspaceId);
          const name = target?.name ?? workspaceId;
          const previous = ids.map((id) => sessionsById.get(id)).filter(Boolean);
          // A session that is already *shown* in this workspace only needs its
          // virtual placement cleared; a real move would rewrite the header cwd
          // and relocate the payload for no visible change. `homeOverride` is
          // the host's answer to "does a placement override exist", so the
          // client never reads the placement map itself.
          const settled = copy
            ? []
            : ids.filter((id) => {
                const session = sessionsById.get(id);
                return Boolean(session?.homeOverride) && session.workspaceId === workspaceId;
              });
          if (settled.length > 0) {
            await mutate(
              () => apiSend("POST", "/sessions/placement", { ids: settled, parent: "" }),
              T("已把 {0} 个会话放回「{1}」", [settled.length, name]),
            );
          }
          const moving = ids.filter((id) => !settled.includes(id));
          if (moving.length === 0) return true;
          const ok = await mutate(
            () => apiSend("POST", "/move", { ids: moving, target: { workspaceId }, copy }),
            copy ? T("已复制 {0} 个会话到「{1}」", [moving.length, name]) : T("已移动 {0} 个会话到「{1}」", [moving.length, name]),
            (payload) => moveFailureHint(payload, copy),
          );
          if (ok) await requestDshRefresh();
          if (ok && !copy) setClipboard({ mode: null, ids: [] });
          if (ok && !copy) {
            // Same undo entry as a paste: a drag-move is a move, and S6 asks
            // for every destructive write to be reversible.
            const groups = new Map();
            for (const session of previous) {
              if (!session.workspaceId || session.workspaceId === workspaceId) continue;
              const bucket = groups.get(session.workspaceId) ?? [];
              bucket.push(session.id);
              groups.set(session.workspaceId, bucket);
            }
            if (groups.size > 0) {
              undoStack.current.push({
                label: T("已把 {0} 个会话移回原来的工作区", [ids.length]),
                run: async () => {
                  for (const [fromId, movedIds] of groups) {
                    await apiSend("POST", "/move", { ids: movedIds, target: { workspaceId: fromId } });
                  }
                  await requestDshRefresh();
                },
              });
            }
          }
          return ok;
        },
        [moveFailureHint, mutate, refreshDshViews, sessionsById, tree],
      );

      // Ctrl+X / Ctrl+C / Ctrl+V belong to the list, not to the browser: the
      // panel has its own clipboard and the OS one would carry text instead.
      // A field or an open editor keeps the native shortcuts, and a dialog
      // stands them down entirely (the dialog layer owns the keyboard).
      useEffect(() => {
        const onClipboardKey = (event) => {
          if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
          const element = event.target;
          const typing =
            element &&
            (element.tagName === "INPUT" ||
              element.tagName === "TEXTAREA" ||
              element.isContentEditable);
          if (typing || dialogOpenRef.current) return;
          const key = event.key.toLowerCase();
          if (key === "x") {
            event.preventDefault();
            cutOrCopy("cut");
          } else if (key === "c") {
            event.preventDefault();
            cutOrCopy("copy");
          } else if (key === "v") {
            event.preventDefault();
            pasteClipboard();
          }
        };
        window.addEventListener("keydown", onClipboardKey);
        return () => window.removeEventListener("keydown", onClipboardKey);
      }, [cutOrCopy, pasteClipboard]);
      return {
        clipboard,
        setClipboard,
        cutOrCopy,
        pasteTarget,
        nodePasteTarget,
        placeSessions,
        pasteClipboard,
        moveSessionsTo,
      };
    }
