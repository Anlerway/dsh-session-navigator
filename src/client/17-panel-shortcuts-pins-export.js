      // ── shortcuts, pins, export, reveal ─────────────────────────────────
      const addShortcutTo = useCallback(
        (parent, kind, targetId) => {
          if (!parent || !targetId) return;
          mutate(() => apiSend("POST", "/shortcuts", { parent, kind, targetId }), T("已添加快捷方式（原位置不变）"));
        },
        [mutate],
      );

      /** The same, for several sessions at once (a drag of a checked set). */
      const addShortcutMany = useCallback(
        (parent, kind, targetIds) => {
          const ids = Array.isArray(targetIds) ? targetIds.filter(Boolean) : [];
          if (!parent || ids.length === 0) return;
          mutate(async () => {
            for (const id of ids) await apiSend("POST", "/shortcuts", { parent, kind, targetId: id });
          }, T("已添加 {0} 个快捷方式（原位置不变）", [ids.length]));
        },
        [mutate],
      );

      /**
       * Add a *container* to 收藏 / 待办 by reference.
       *
       * A workspace keeps its own id space (DSH's), a folder its node id, so the
       * kind has to be read off the node instead of assumed from the caller.
       */
      const addShortcutForNode = useCallback(
        (parent, nodeId) => {
          const node = tree?.nodes?.[nodeId] ?? null;
          if (!parent || !node) return;
          if (node.kind === "shortcut") {
            setHint(T("快捷方式不能再放进收藏 / 待办"));
            return;
          }
          const kind = node.type === "workspace" ? "workspace" : "folder";
          const targetId = kind === "workspace" ? node.workspaceId ?? node.id : node.id;
          addShortcutTo(parent, kind, targetId);
        },
        [addShortcutTo, tree],
      );

      // 收藏 / 待办 are the pages where a row *is* a membership, so "where does this
      // live originally" is a question that only arises there.
      const memberScope = scope === FIXED.favorites || scope === FIXED.todos;

      /**
       * Where 在本目录生成快捷方式 puts the reference: the container the user is
       * standing in, and nowhere else — "在本目录" has to mean this directory.
       *
       * 根目录 and 所有会话 cannot hold one (they are views, not containers), so the
       * menu entry explains itself instead of quietly filing into 收藏: a command
       * that lands somewhere other than the folder it names is a command that
       * lies about what it did.
       *
       * 收藏 and 待办 are excluded on purpose. Their rows *are* memberships, so a
       * reference created there reads as "add to favorites" wearing a directory
       * command's name; those two pages take references by drag and by the star in
       * the session header. A workspace, a plain folder and 未分组 are real places
       * and keep the command.
       */
      const shortcutParent =
        tree?.nodes?.[scope]?.accepts?.shortcut && !memberScope ? scope : null;

      /** 创建快捷方式 for one entity, in the container the user is standing in. */
      const createShortcutHere = useCallback(
        (kind, id) => {
          if (!id) return;
          if (!shortcutParent) {
            setHint(T("当前位置不能放快捷方式：先进入一个文件夹或工作区"));
            return;
          }
          if (kind === "session") {
            addShortcutTo(shortcutParent, "session", id);
            return;
          }
          // A workspace's tree id is its native id with the `w-` prefix; the
          // shortcut stores the native id, which is what `addShortcutForNode` reads.
          addShortcutForNode(shortcutParent, kind === "workspace" ? "w-" + id : id);
        },
        [addShortcutForNode, addShortcutTo, setHint, shortcutParent],
      );


      /**
       * Drop whatever is being dragged onto a fixed rail entry.
       *
       * The rail entries carry the host's answers, so nothing here names a fixed
       * id: 未分组 takes sessions (as a virtual placement) and directories (a
       * real move), 收藏 / 待办 take anything as a *reference* and never move the
       * target.
       */
      const dropOnFixed = useCallback(
        (targetId, event) => {
          const node = tree?.nodes?.[targetId] ?? null;
          const ids = draggedSessionIds(event);
          if (ids.length > 0) {
            if (node?.accepts?.session) {
              // 未分组 owns real sessions, so this is a virtual placement: the
              // payload stays in its workspace directory, the row moves here.
              placeSessions(ids, targetId).catch(() => {});
            } else if (node?.accepts?.shortcut) {
              // 收藏 / 待办 hold *references*: a session dropped here becomes a
              // shortcut and never moves.
              addShortcutMany(targetId, "session", ids);
            } else {
              setHint(T("会话只能放进 未分组 或某个工作区；要放进 收藏 / 待办，拖到对应入口或用头部的星标"));
            }
            return;
          }
          const nodeIds = draggedNodeIds();
          if (nodeIds.length === 0) return;
          if (node?.accepts?.folder) moveNodesTo(nodeIds, targetId);
          else if (node?.accepts?.shortcut) {
            for (const id of nodeIds) addShortcutForNode(targetId, id);
          }
        },
        [addShortcutForNode, addShortcutMany, moveNodesTo, placeSessions, tree],
      );

      const canDropOnFixed = useCallback(
        (targetId) => {
          const node = tree?.nodes?.[targetId];
          if (!node) return false;
          // 收藏 / 待办 take anything as a reference; 未分组 takes real sessions
          // and real directories. A check-set can hold both kinds, so the rail
          // lights up when *either* half may land here.
          if (draggedSessionIds().length > 0 && (node.accepts?.session || node.accepts?.shortcut)) return true;
          if (draggedNodeIds().length > 0 && (node.accepts?.folder || node.accepts?.shortcut)) return true;
          return false;
        },
        // `dragPayload` is module state, not a prop: it changes during a drag
        // gesture the same way `dragging` does, and this predicate is only ever
        // called mid-gesture.
        [tree],
      );

      /**
       * Paste the clipboard into 收藏 / 待办 as *shortcuts*.
       *
       * The clipboard carries ids of things that may live anywhere; this is the
       * one paste that must not move them, so it creates one reference per id
       * and leaves every target exactly where it was.
       */
      const pasteAsShortcut = useCallback(
        async (parent) => {
          const ids = clipboard.ids ?? [];
          const nodes = clipboard.nodes ?? [];
          if (ids.length === 0 && nodes.length === 0) {
            setHint(T("剪贴板是空的：先复制一个会话或目录"));
            return;
          }
          const ok = await mutate(async () => {
            for (const id of ids) await apiSend("POST", "/shortcuts", { parent, kind: "session", targetId: id });
            for (const nodeId of nodes) {
              const node = tree?.nodes?.[nodeId] ?? null;
              if (!node) continue;
              const kind = node.type === "workspace" ? "workspace" : "folder";
              const targetId = kind === "workspace" ? node.workspaceId ?? nodeId : nodeId;
              await apiSend("POST", "/shortcuts", { parent, kind, targetId });
            }
          }, T("已添加 {0} 个快捷方式", [ids.length + nodes.length]));
          if (ok) setClipboard({ mode: null, ids: [], nodes: [] });
        },
        [clipboard, mutate, tree],
      );

      /**
       * Jump to what a shortcut points at: select and reveal the target, never
       * copy it. A deleted target says so instead of navigating nowhere.
       */
      const revealShortcutTarget = useCallback(
        (shortcut) => {
          if (!shortcut) return;
          if (shortcut.shortcutKind === "session") {
            const session = sessionsById.get(shortcut.targetId);
            if (!session) {
              setHint(T("快捷方式指向的会话已经不存在"));
              return;
            }
            // A reference has to land on what it names. The session lives in its
            // own workspace, and that page is where a row for it can be revealed;
            // selecting the id from here would only highlight something the
            // current page does not draw.
            if (session.home && scope !== session.home) navigate(session.home);
            selectAndReveal(shortcut.targetId);
            return;
          }
          const nodeId = shortcut.shortcutKind === "workspace" ? "w-" + shortcut.targetId : shortcut.targetId;
          if (!tree?.nodes?.[nodeId]) {
            setHint(T("快捷方式指向的目录已经不存在"));
            return;
          }
          navigate(nodeId);
        },
        [navigate, scope, selectAndReveal, sessionsById, tree],
      );

      /**
       * 转到会话原位置: stand where the session actually lives.
       *
       * 所有会话 / 收藏 / 待办 can show a session away from its workspace, so a row
       * on one of those pages is no proof of where the file is. The home the
       * host resolved for the session is where it really lives; walking there and
       * revealing the row is the same pair used to follow a shortcut.
       */
      const goToSessionOrigin = useCallback(
        (id) => {
          const session = sessionsById.get(id);
          if (!session) {
            setHint(T("这个会话已经不存在"));
            return;
          }
          if (!session.home) {
            setHint(T("这个会话没有可定位的原位置"));
            return;
          }
          if (scope !== session.home) navigate(session.home);
          selectAndReveal(id);
        },
        [navigate, scope, selectAndReveal, sessionsById],
      );

      /** Delete a workspace registration. DSH keeps the files and sessions. */
      const removeWorkspace = useCallback(
        (workspaceId) => {
          if (!workspaceId) return;
          const node = tree?.nodes?.["w-" + workspaceId] ?? null;
          dialogs
            .confirm({
              title: T("删除工作区"),
              message: T("删除「{0}」的工作区登记？文件夹和会话都会保留，里面的会话会回到 未分组。", [node?.name ?? workspaceId]),
              confirmLabel: T("删除"),
              danger: true,
            })
            .then((confirmed) => {
              if (!confirmed) return;
              mutate(
                () => apiSend("POST", `/workspaces/${encodeURIComponent(workspaceId)}/delete`, {}),
                T("工作区已删除，会话已归入 未分组"),
              );
            });
        },
        [dialogs, mutate, tree],
      );

      // Unlinking a shortcut goes through `deleteSelection`: the row is a normal
      // row in the tree and the list, so 删除 on it has to do the obvious thing —
      // remove the pointer (DELETE /shortcuts/:id) and leave the payload alone.
      // What the panel must never do is delete a *payload* through a reference,
      // which is why every row under 所有会话 is refused instead.

      /** 置顶 a folder or a workspace. Sessions keep DSH's own pin. */
      const togglePinNode = useCallback(
        (nodeId, pinned) => {
          if (!nodeId) return;
          mutate(() => apiSend("POST", `/nodes/${encodeURIComponent(nodeId)}/pin`, { pinned }), pinned ? T("已置顶") : T("已取消置顶"));
        },
        [mutate],
      );

      /**
       * 快速访问: park a container in the strip above the tree.
       *
       * Separate from 置顶 on purpose — a pin reorders the row where it lives, a
       * bookmark adds a button that stays in reach — so this writes its own map
       * and the tree reads it back as `quickAccessNodes`.
       */
      const toggleQuickAccess = useCallback(
        (nodeId, on) => {
          if (!nodeId) return;
          mutate(
            () => apiSend("POST", `/nodes/${encodeURIComponent(nodeId)}/quick-access`, { quickAccess: on }),
            on ? T("已放到快速访问") : T("已移出快速访问"),
          );
        },
        [mutate],
      );

      /**
       * A drop on the 快速访问 *label*.
       *
       * This parks a container in the strip and nothing else: the strip is one
       * sequence, a new bookmark goes last, and the host is given the whole order
       * (`POST /quick-access`). A drop on one of its *rows* is not this gesture —
       * a row is the folder itself, so the drop goes inside it through
       * `moveNodeHere` / `onDropSessions`.
       */
      const dropOnQuickAccess = useCallback(
        (sourceIds) => {
          const nodesById = tree?.nodes ?? {};
          const list = (Array.isArray(sourceIds) ? sourceIds : [sourceIds]).map(String).filter(Boolean);
          if (list.length === 0) return;
          // 快速访问 lists entry points, so it takes exactly the nodes that are a
          // place. The band already refused the obvious cases while hovering;
          // deciding it again here is what keeps the hint honest when the drop
          // arrives from a window that had no payload to validate.
          const legal = [];
          const refused = [];
          for (const id of list) (isBookmarkableNode(nodesById[id]) ? legal : refused).push(id);
          if (legal.length === 0) {
            setHint(T("快速访问只能放文件夹或工作区：固定入口、快捷方式和会话都放不进来"));
            return;
          }
          // A multi-drag parks every container it carries; the ones
          // already in the strip are skipped, so dropping a set on 快速访问 twice
          // does not reorder it.
          const current = tree?.quickAccessNodes ?? [];
          const added = legal.filter((id) => !current.includes(id));
          if (added.length === 0) {
            // A bookmark that is already parked used to be dropped without a
            // word, which reads as a broken gesture rather than as a no-op.
            setHint(T("已经在快速访问里了"));
            return;
          }
          const hint =
            refused.length > 0
              ? T("已加入 {0} 个；{1} 项放不进快速访问（只收文件夹和工作区）", [added.length, refused.length])
              : T("已放到快速访问");
          mutate(
            () => apiSend("POST", "/quick-access", { ids: [...current, ...added] }),
            hint,
            // The host answers 200 even when it skipped an id, so the response is
            // the last place a refusal can still be reported; without this the
            // toast says 已放到快速访问 about a bookmark that was never written.
            (result) => {
              const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
              return skipped.length > 0
                ? T("{0} 项没能加入快速访问（只收文件夹和工作区）", [skipped.length])
                : null;
            },
          );
        },
        [mutate, setHint, tree],
      );

      /**
       * 置顶 for a whole check-set: a session uses DSH's pin, a container the
       * plugin's own — the same split as togglePinOrNode, applied row by row,
       * and in one direction read from the row under the pointer.
       */
      const pinMany = useCallback(() => {
        if (targets.length === 0) {
          setHint(T("先选择要操作的项"));
          return;
        }
        // Same rule as flagMany: unpin only when everything is pinned already.
        const pinned = targets.every((id) => isPinned(id));
        if (blockedByBinding(targets)) return;
        mutate(async () => {
          for (const id of targets) {
            const target = bulkTargetOf(id);
            if (!target) continue;
            if (target.sessionId) {
              await apiSend("POST", "/sessions/" + encodeURIComponent(target.sessionId) + (pinned ? "/unpin" : "/pin"), {});
              continue;
            }
            await apiSend("POST", "/nodes/" + encodeURIComponent(target.targetId) + "/pin", { pinned: !pinned });
          }
        }, pinned ? T("已取消置顶") : T("已置顶"));
      }, [blockedByBinding, bulkTargetOf, isPinned, mutate, targets]);

      /** 快速访问 of one row: the container it points at is parked in the strip. */
      const isParked = useCallback(
        (id) => {
          const target = bulkTargetOf(id);
          if (!target || target.sessionId) return false;
          return Boolean(tree?.quickAccess?.[target.targetId]);
        },
        [bulkTargetOf, tree],
      );

      /**
       * 快速访问 for a whole check-set.
       *
       * Sessions are not part of this list at all — a bookmark is a *container*
       * button — so the menu item is only offered for a container-only set and
       * this loop skips anything else rather than inventing a home for it. One
       * direction, read once, exactly like pinMany.
       */
      const quickMany = useCallback(() => {
        if (targets.length === 0) {
          setHint(T("先选择要操作的项"));
          return;
        }
        const parked = targets.every((id) => isParked(id));
        if (blockedByBinding(targets)) return;
        mutate(async () => {
          for (const id of targets) {
            const target = bulkTargetOf(id);
            if (!target || target.sessionId) continue;
            await apiSend("POST", "/nodes/" + encodeURIComponent(target.targetId) + "/quick-access", { quickAccess: !parked });
          }
        }, parked ? T("已移出快速访问") : T("已放到快速访问"));
      }, [blockedByBinding, bulkTargetOf, isParked, mutate, targets]);
      /**
       * 置顶 for whatever is selected: a session uses DSH's pin, a container
       * uses the plugin's own. One button, one visual band, two stores.
       */
      const togglePinOrNode = useCallback(() => {
        const nodeId = focusNode && !focusNode.fixed && focusNode.kind !== "shortcut" ? focusNode.id : null;
        if (nodeId && targets.every((id) => !sessionsById.has(id))) {
          togglePinNode(nodeId, !(tree?.pins?.[nodeId]));
          return;
        }
        togglePin();
      }, [focusNode, sessionsById, targets, togglePin, togglePinNode, tree]);

      /**
       * 导出 one session.
       *
       * The route answers with the file itself, not an envelope, so this is a
       * plain navigation to a download URL: the browser writes the bytes and the
       * panel never has to hold a multi-megabyte string.
       */
      const exportSession = useCallback(
        (sessionId, format) => {
          if (!sessionId) return;
          const kind = format === "jsonl" ? "jsonl" : "md";
          try {
            const url = `${API}/export?sessionId=${encodeURIComponent(sessionId)}&format=${kind}&download=1`;
            if (typeof document !== "undefined" && document.body) {
              const link = document.createElement("a");
              link.href = url;
              link.rel = "noopener";
              link.download = "";
              document.body.appendChild(link);
              link.click();
              link.remove();
            }
            setHint(T("已导出 {0}", [kind === "jsonl" ? "JSONL" : "Markdown"]));
          } catch (error) {
            setHint(String(error?.message ?? error));
          }
        },
        [],
      );

      /**
       * Reveal a workspace's directory in the OS file manager.
       *
       * Sessions go through the id-based routes instead (`revealSessionDir`,
       * `copySessionPath`): their directory is the host's answer to give, not
       * a path the panel assembles. A workspace node is different — its id maps
       * to exactly one directory, and the host resolves that one.
       */
      const revealNode = useCallback(
        async (target) => {
          const descriptor = target && typeof target === "object" ? target : null;
          const id = descriptor?.id ?? (typeof target === "string" ? target : "");
          if (!id) return;
          // The host reports whether the window actually reached the front:
          // an Explorer window opened behind the panel looks exactly like one
          // that never opened, so "已打开" alone would be a lie half the time.
          try {
            const result = await apiSend("POST", `/workspaces/${encodeURIComponent(id)}/reveal`, {});
            const path = result?.path ?? T("工作区目录");
            const detail = result?.detail ?? "";
            if (detail === "behind") setHint(T("已打开 {0}，但窗口没有到前台", [path]));
            else if (detail === "activated") setHint(T("已打开 {0}（未能确认是否在前台）", [path]));
            else setHint(T("已在文件管理器中打开 {0}", [path]));
          } catch (error) {
            setHint(T("打开失败：{0}", [error?.message ?? error]));
          }
        },
        [],
      );

      /**
       * 复制文件路径 for one session: the host resolves the log file, the panel
       * puts that path on the clipboard.
       *
       * Nothing is opened, so this works where the host is not — the path can
       * be pasted into an editor, a terminal, or a file dialog on another
       * machine. The hint names the file, because a clipboard write that
       * silently failed looks exactly like one that worked.
       */
      const copySessionPath = useCallback(
        async (id) => {
          if (typeof id !== "string" || !id) return;
          try {
            const result = await apiSend("POST", `/sessions/${encodeURIComponent(id)}/log-path`, {});
            const path = typeof result?.path === "string" ? result.path : "";
            if (!path) throw new Error(T("宿主没有返回路径"));
            const copied = await copyText(path);
            setHint(copied ? T("已复制文件路径：{0}", [result?.name ?? path]) : T("复制失败，请手动复制：{0}", [path]));
          } catch (error) {
            setHint(T("获取路径失败：{0}", [error?.message ?? error]));
          }
        },
        [],
      );

      /**
       * 复制文件夹地址 for a workspace: 复制文件路径 one level up.
       *
       * The host owns the mapping from a workspace id to its directory (the
       * registry can move or rename it), so the panel asks for the path rather
       * than reading it out of the node it happens to be showing.
       */
      const copyNodePath = useCallback(
        async (id) => {
          if (typeof id !== "string" || !id) return;
          try {
            const result = await apiSend("POST", `/workspaces/${encodeURIComponent(id)}/path`, {});
            const path = typeof result?.path === "string" ? result.path : "";
            if (!path) throw new Error(T("宿主没有返回路径"));
            const copied = await copyText(path);
            setHint(copied ? T("已复制文件夹地址：{0}", [path]) : T("复制失败，请手动复制：{0}", [path]));
          } catch (error) {
            setHint(T("获取路径失败：{0}", [error?.message ?? error]));
          }
        },
        [],
      );

      /**
       * 在文件管理器中显示 for a session: open the directory it ran in.
       *
       * Goes through the host by id for the same reason as 定位会话文件 — the
       * panel does not know whether a session still has a cwd, and a path the
       * client builds itself is a path DSH never verified.
       */
      const revealSessionDir = useCallback(
        async (id) => {
          if (typeof id !== "string" || !id) return;
          try {
            const result = await apiSend("POST", `/sessions/${encodeURIComponent(id)}/reveal-dir`, {});
            await load(true);
            setHint(T("已在文件管理器中打开 {0}", [result?.path ?? T("会话目录")]));
          } catch (error) {
            setHint(T("打开失败：{0}", [error?.message ?? error]));
            await load(true);
          }
        },
        [load],
      );

      const body = () => {
        if (boot.phase === "loading") {
          return h("div", { className: "se-searching" }, h("div", { className: "empty" }, h("div", { className: "t" }, T("正在读取会话…"))));
        }
        if (boot.phase === "error") {
          return h(
            "div",
            { className: "empty", style: { flex: 1 } },
            h("div", { className: "big" }, h(Icon, { name: "x", size: 30 })),
            h("div", { className: "t" }, T("加载失败")),
            h("div", { className: "s" }, boot.error ?? ""),
            h("button", { className: "act", onClick: () => load(true) }, T("重试")),
          );
        }
        return h(
          React.Fragment,
          null,
          h(TreePane, {
            tree,
            scope,
            onSelect: navigate,
            expanded,
            onToggle: toggleExpanded,
            width: navWidth,
            // A drop may carry a whole check-set; `moveNodesTo` takes a
            // single id too, so the tree's one-node gesture is unchanged.
            onMove: moveNodesTo,
            onDropSessions: moveSessionsTo,
            onPlaceSessions: placeSessions,
            // Sessions dropped on a user folder become a *shortcut*: the
            // payload stays in its workspace directory (hard constraint 1).
            onDropShortcut: (nodeId, ids) => addShortcutMany(nodeId, "session", ids),
            onHint: setHint,
            rename: renameProps,
            onBeginRename: beginRename,
            onNodeContextMenu: openContextMenu,
            onShortcutContextMenu: openContextMenu,
            onBlankContextMenu: (event) => openContextMenu(event, { kind: "blank" }),
            onHighlight: highlightNode,
            onOpenShortcut: revealShortcutTarget,
            onDropOnFixed: dropOnFixed,
            canDropOnFixed: canDropOnFixed,
            pins: tree?.pins ?? {},
            quickAccess: tree?.quickAccessNodes ?? [],
            onDropOnQuick: dropOnQuickAccess,
            sessionsById,
          }),
          h("div", { className: "rsz", onMouseDown: (event) => resizePane(event, "tree") }),
          h(ListPane, {
            sessions: filteredInScope,
            sessionsById,
            tree,
            onOpenShortcut: revealShortcutTarget,
            scope,
            selected,
            onSelect: selectRow,
            onCheck: checkRow,
            onMarquee: marqueeStart,
            checked,
            query,
            // 搜索范围: the pane can test 会话名 / 标签 / 备注 from the rows
            // it holds. 会话内容 cannot be tested there at all — the hits come back
            // from the host index, and `contentPending` says the answer is still
            // partial while that index is cold.
            searchScopes,
            contentHits,
            contentPending,
            sortKey,
            onSort: cycleSort,
            sortDir,
            showArchived: listSettings.showArchived,
            // 筛选 turns the list into a result view: only what matched, with the
            // containers that hold it. The pane needs both halves of that state.
            filterActive,
            filterAll: filter.scope === "all",
            now,
            view,
            onOpenWorkspace: navigate,
            colWidths,
            onResizeColumn: resizeColumn,
            listRef: null,
            collapsed: effectiveCollapsed,
            onToggleChildren: toggleChildren,
            foldedBands,
            onToggleBand: toggleBand,
            rename: renameProps,
            onBeginRename: beginRename,
            onRename: renameEntity,
            onRowContextMenu: openContextMenu,
            onNodeContextMenu: openContextMenu,
            clipboard,
            onDropSessions: moveSessionsTo,
            onPlaceSessions: placeSessions,
            onDropShortcut: (nodeId, ids) => addShortcutMany(nodeId, "session", ids),
            onCanAcceptNode: canDropHere,
            onDropNode: moveNodeHere,
            onOpenSession: openInDsh,
            onBlankContextMenu: (event) => openContextMenu(event, { kind: "blank" }),
            onHint: setHint,
          }),
          h("div", { className: "rsz rsz-detail", onMouseDown: (event) => resizePane(event, "detail") }),
          h(DetailPane, {
            session: current,
            // With no session selected, the detail pane describes the container
            // the user picked (or, failing that, the one they are standing in),
            // so a workspace or folder can be renamed from the same title row
            // and is labelled by its real type.
            node: focusNode,
            tree,
            sessionOf: (id) => sessionsById.get(id) ?? null,
            now,
            parent,
            children: currentChildren,
            forks: currentForks,
            forkSource,
            onOpen: selectAndReveal,
            onEnterNode: navigate,
            onOpenSession: openInDsh,
            onClose: () => setShowDetail(false),
            onHint: setHint,
            // Applying a field writes to the session record (title) or to the
            // annotations document (note, tags), so the list, the tag picker and
            // this pane are all stale until the bootstrap payload is re-read.
            onApplied: () => load(true),
            tagLibrary: data?.tagLibrary ?? EMPTY_LIST,
            onAddTag: addTag,
            onRemoveTag: removeTag,
            onNewTag: newTag,
            onDropTag: dropTag,
            onSetNote: setNote,
            onToggleFlag: toggleFlag,
            onArchive: toggleArchive,
            onFork: forkSession,
            onRename: renameEntity,
            onRestore: restoreSelection,
            onDelete: deleteSelection,
            onExport: exportSession,
            onReveal: revealNode,
            onCopyPath: copySessionPath,
            onCopyNodePath: copyNodePath,
            onRevealDir: revealSessionDir,
          }),
        );
      };

      // The scrim and the shell are siblings: the scrim paints behind the shell
      // and only exists when settings.shell.modal.dim is above zero. With the
      // default settings (dim = 0) it renders nothing at all, so a wallpaper is
      // never darkened (hard constraint 10).
      const scrim = h("div", {
        className: "se-scrim",
        "data-clickable": closeOnBackdrop && modalDim > 0 ? "1" : "0",
        style: { "--se-dim": String(modalDim) },
        onClick: closeOnBackdrop && modalDim > 0 ? () => panelStore.set(false, "user") : undefined,
      });

      /**
       * The 排序 menu: a field section and a direction section.
       *
       * Direction is shown as its own two rows rather than a toggle, because a
       * check mark on the current state is easier to read than a button whose
       * label is the *next* state.
       */
      const sortItems = [
        ...SORT_FIELDS.map((field) => ({
          label: field.label,
          icon: sortKey === field.key ? "check" : "minus",
          run: () => {
            setSortKey(field.key);
            if (sortKey !== field.key) setSortDir(SORT_DEFAULT_DIR[field.key] ?? "desc");
          },
        })),
        { sep: true },
        {
          label: T("递增"),
          icon: sortDir === "asc" ? "check" : "minus",
          run: () => setSortDir("asc"),
        },
        {
          label: T("递减"),
          icon: sortDir === "desc" ? "check" : "minus",
          run: () => setSortDir("desc"),
        },
      ];

      /**
       * The 新建 menu.
       *
       * 新建会话 asks DSH to open its own draft (the panel is a browser, not a
       * chat surface), 新建文件夹 is the plugin's own virtual folder. Both land
       * where the user is standing, which is what the toolbar button always
       * meant.
       *
       * 新建会话 is only listed inside a workspace (see `canStartDraft`): a draft
       * asked for from 根目录 or 未分组 would open in DSH's default workspace, a
       * place the user was not looking at. 新建文件夹 has no such limit — the
       * plugin can make a folder anywhere it draws.
       */
      newSessionRef.current = newSession;
      openInDshRef.current = openInDsh;

      const createItems = [
        ...(canStartDraft(scope, tree)
          ? [{ label: T("新建会话"), icon: "plus", key: "Ctrl+N", run: () => newSession() }]
          : []),
        { label: T("新建文件夹"), icon: "folderplus", run: () => newFolder() },
      ];

      // 更多 is a short list of things that have nowhere else to live. A command
      // that already has a toolbar button (新建 / 重命名 / 归档 / 全选 / 新建标签页)
      // does not belong here: a menu that repeats the toolbar is just a slower
      // toolbar, and it buries the three entries that matter.
      const moreItems = [
        // Undo belongs here as well as on Ctrl+Z: a mouse-only user has no
        // other way to reach it (S6).
        { label: T("撤回"), icon: "refresh", key: "Ctrl+Z", run: () => undo() },
        // 刷新 means both halves: this list, and DSH's own sidebar. A window can
        // only ask for the second one through the Host.
        { label: T("刷新"), icon: "refresh", key: "F5", run: () => { load(true); void requestDshRefresh(); } },
        { sep: true },
        {
          label: listSettings.autoCollapse ? T("自动折叠：开") : T("自动折叠：关"),
          icon: listSettings.autoCollapse ? "check" : "minus",
          run: () => saveListSettings({ autoCollapse: !listSettings.autoCollapse }),
        },
        {
          label: listSettings.showArchived ? T("显示已归档的会话") : T("隐藏已归档的会话"),
          icon: listSettings.showArchived ? "check" : "minus",
          run: () => saveListSettings({ showArchived: !listSettings.showArchived }),
        },
        {
          // 过滤空会话 — a shortcut to the settings switch, not a second copy of
          // the preference: both write the same `list.hideBlank`.
          label: listSettings.hideBlank ? T("过滤空会话：开") : T("过滤空会话：关"),
          icon: listSettings.hideBlank ? "check" : "minus",
          run: () => saveListSettings({ hideBlank: !listSettings.hideBlank }),
        },
        { sep: true },
        { label: T("更多设置…"), icon: "settings", run: () => openSettingsPage() },
      ];

      // The row context menu (target resolution, item list, and the one-render
      // delay before it opens) lives in useContextMenu.
      const { contextMenu, setContextMenu, openContextMenu, renameCurrent } = useContextMenu({
        beginRename,
        beginRenameAfterClick,
        bulkTargetOf,
        checked,
        clipboard,
        copySessionPath,
        createShortcutHere,
        current,
        cutOrCopy,
        deleteSelection,
        emptyContainer,
        exportSession,
        flagMany,
        flagMemberIn,
        focusNode,
        forkSession,
        goToSessionOrigin,
        isParked,
        isPinned,
        load,
        memberScope,
        navigate,
        newFolder,
        newSession,
        nodePasteTarget,
        openInDsh,
        pasteAsShortcut,
        pasteClipboard,
        pasteTarget,
        pinMany,
        quickMany,
        removeFolder,
        removeWorkspace,
        restoreSelection,
        revealNode,
        revealSessionDir,
        revealShortcutTarget,
        scope,
        selectAndReveal,
        selectionTarget,
        sessionsById,
        setArchive,
        setChecked,
        setHint,
        setSelected,
        shortcutParent,
        toggleArchive,
        toggleFlag,
        togglePinNode,
        toggleQuickAccess,
        tree,
        renameCurrentRef,
        selectionTargetRef,
      });

