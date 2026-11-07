    // ── context menu hook ─────────────────────────────────────────────────
    // The row context menu: who it targets, what the items are, and the
    // one-render delay that lets a right-click select its row first. Moved out
    // of Panel verbatim; only the free variables became parameters.
    function useContextMenu({
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
    }) {
      // The row context menu, anchored to the pointer.
      const [contextMenu, setContextMenu] = useState(null);
      /**
       * 打开 from the context menu. A session goes to DSH's own main view; a
       * node is entered in this panel, because a workspace has no chat to open.
       */
      const openContextTarget = useCallback(
        (kind, target) => {
          if (kind === "session") {
            openInDsh(target.id);
            return;
          }
          // A workspace node is navigated by its tree id, never by the native
          // workspace id (w-<uuid> vs <uuid>).
          navigate(target.nodeId);
        },
        [navigate, openInDsh],
      );

      /**
       * 重命名 as a command (toolbar button, context menu, F2).
       *
       * It applies to whatever the detail pane is describing: the selected
       * session, or the node the user is standing in.
       */
      const renameCurrent = useCallback(() => {
        // One target, resolved once: a selected session, a selected container,
        // or — when nothing is selected — the container the user is standing in.
        // The old version read `focusNode` and then re-derived the id space, and
        // passing the tree id of a workspace to the native rename is what made
        // the button look broken.
        // Rename names one thing. With several rows checked, the first click
        // would have to guess which name the user meant, so it says so instead.
        if (checked.size > 1) {
          setHint(T("一次只能重命名一个项目"));
          return;
        }
        if (selectionTarget) {
          if (selectionTarget.kind === "session") {
            beginRename("session", selectionTarget.actionId);
            return;
          }
          if (!selectionTarget.editable) {
            setHint(T("这一项不能重命名"));
            return;
          }
          beginRename(selectionTarget.kind, selectionTarget.actionId);
          return;
        }
        const node = focusNode;
        if (!node || node.fixed) {
          setHint(T("这里没有可重命名的项目"));
          return;
        }
        if (node.type === "workspace") beginRename("workspace", node.workspaceId ?? node.id);
        else beginRename("folder", node.id);
      }, [beginRename, current, focusNode, selectionTarget]);
      renameCurrentRef.current = renameCurrent;
      selectionTargetRef.current = selectionTarget;

      /**
       * Context menu for one row.
       *
       * The item set is derived from what the row *is*, not from a single
       * generic list: a session can be opened/renamed/trashed, a workspace can
       * be entered/renamed, a folder can be renamed and deleted. Offering
       * disabled items would be noise, so each row type gets its own list.
       */
      const buildContextMenu = useCallback(
        // Called with a point and a descriptor, not with the DOM event: the menu
        // is built one render *after* the right-click, so the selection has
        // already settled and the items act on the row the user pointed at
        // (see openContextMenu below).
        (x, y, descriptor) => {
          const kind = descriptor.kind;
          const id = descriptor.id;
          const payload = descriptor.node ?? null;
          /** @type {any[]} */
          const items = [];
          // The tree id and the native workspace id are different things: the
          // menu acts on the native id but navigation needs the tree node.
          const nodeId = kind === "workspace" ? descriptor.nodeId ?? null : id;
          const target = kind === "session" ? { id } : { id, nodeId };

          // 空白处: the list's own background, not a row. Three things act on the
          // container the user is standing in — 刷新, 粘贴, 新建文件夹 — and nothing
          // here reads or clears the selection, because no row was pointed at.
          if (kind === "blank") {
            const clipboardEmpty = clipboard.ids.length === 0 && (clipboard.nodes?.length ?? 0) === 0;
            const pasteBlockedHere = scope === FIXED.favorites || scope === FIXED.todos;
            const directoryClipboard = (clipboard.nodes?.length ?? 0) > 0;
            items.push({
              label: T("刷新"),
              icon: "refresh",
              key: "F5",
              run: () => {
                load(true);
                void requestDshRefresh();
              },
            });
            items.push({
              label: T("粘贴"),
              icon: "paste",
              key: "Ctrl+V",
              disabled: clipboardEmpty || pasteBlockedHere || (directoryClipboard ? !nodePasteTarget : !pasteTarget),
              onDisabled: () => {
                if (clipboardEmpty) setHint(T("剪贴板是空的：先剪切或复制"));
                else if (pasteBlockedHere) setHint(T("收藏和待办页不能粘贴：用星标把会话加进来"));
                else if (directoryClipboard) setHint(T("剪贴板里是目录：进入一个文件夹或根目录再粘贴"));
                else setHint(T("当前位置不属于任何工作区，先进入一个工作区再粘贴"));
              },
              run: () => pasteClipboard(),
            });
            items.push({ sep: true });
            items.push({
              label: T("新建文件夹"),
              icon: "folderplus",
              run: () => newFolder(),
            });
            setContextMenu({ left: x, top: y, items });
            return;
          }

          // Right-clicking a row inside a multi-selection must act on the whole
          // selection, not collapse it to the row under the pointer (the bug
          // this branch fixes). The trimmed menu is deliberate: a bulk edit of
          // tags/notes across unrelated rows is a different feature, and offering
          // it here would silently apply one row's values to fifty others.
          const bulk = checked.size > 1 && (checked.has(id) || checked.has(nodeId));
          if (bulk) {
            const count = checked.size;
            // 复制 is sessions only, and cutOrCopy is where that rule lives: a
            // container can be moved but not duplicated. Saying so on the item
            // beats letting the paste refuse two steps later.
            const bulkHasContainer = [...checked].some((checkedId) => !sessionsById.has(checkedId));
            items.push({
              label: T("复制 {0} 项到…", [count]),
              icon: "copy",
              key: "Ctrl+C",
              disabled: bulkHasContainer,
              onDisabled: () => setHint(T("目录只能剪切，不能复制：只勾选会话才能复制")),
              run: () => cutOrCopy("copy"),
            });
            items.push({
              label: T("剪切 {0} 项", [count]),
              icon: "cut",
              key: "Ctrl+X",
              run: () => cutOrCopy("cut"),
            });
            const clipboardEmpty = clipboard.ids.length === 0 && (clipboard.nodes?.length ?? 0) === 0;
            const pasteBlockedHere = scope === FIXED.favorites || scope === FIXED.todos;
            items.push({
              label: T("粘贴到此处"),
              icon: "paste",
              key: "Ctrl+V",
              disabled:
                clipboardEmpty ||
                pasteBlockedHere ||
                ((clipboard.nodes?.length ?? 0) > 0 ? !nodePasteTarget : !pasteTarget),
              onDisabled: () => {
                if (clipboardEmpty) setHint(T("剪贴板是空的：先剪切或复制"));
                else if (pasteBlockedHere) setHint(T("收藏和待办页不能粘贴：用星标把会话加进来"));
                else if ((clipboard.nodes?.length ?? 0) > 0) setHint(T("剪贴板里是目录：进入一个文件夹或根目录再粘贴"));
                else setHint(T("当前位置不属于任何工作区，先进入一个工作区再粘贴"));
              },
              run: () => pasteClipboard(),
            });
            // 收藏 / 待办 / 置顶 work row by row, so a mixed set (sessions and
            // containers together) is fine. 归档 is DSH's own session lifecycle,
            // so it is only offered when every checked row is a session.
            const bulkIds = [...checked];
            const allSessions = bulkIds.length > 0 && bulkIds.every((checkedId) => sessionsById.has(checkedId));
            // Labels follow the direction the click will take, as 归档 does: a set
            // that is already collected everywhere offers to take it back out.
            const everyIn = (container) => bulkIds.length > 0 && bulkIds.every((checkedId) => Boolean(flagMemberIn(container, checkedId)));
            const allFavorite = everyIn(FIXED.favorites);
            const allTodo = everyIn(FIXED.todos);
            const allPinned = bulkIds.length > 0 && bulkIds.every((checkedId) => isPinned(checkedId));
            // 快速访问 holds containers only (a session's name lives in the tree
            // already), so this item appears for a container-only set — the same
            // shape as 归档 above, which needs "all sessions".
            const allContainers =
              bulkIds.length > 0 &&
              bulkIds.every((checkedId) => {
                const resolved = bulkTargetOf(checkedId);
                return Boolean(resolved && !resolved.sessionId);
              });
            const allParked = allContainers && bulkIds.every((checkedId) => isParked(checkedId));
            items.push({ sep: true });
            items.push({
              label: allFavorite ? T("取消收藏 {0} 项", [count]) : T("收藏 {0} 项", [count]),
              icon: "star",
              run: () => flagMany("favorite"),
            });
            items.push({
              label: allTodo ? T("取消待办 {0} 项", [count]) : T("待办 {0} 项", [count]),
              icon: "todo",
              run: () => flagMany("todo"),
            });
            items.push({
              label: allPinned ? T("取消置顶 {0} 项", [count]) : T("置顶 {0} 项", [count]),
              icon: "pin",
              run: () => pinMany(),
            });
            if (allContainers) {
              items.push({
                label: allParked ? T("移出快速访问 {0} 项", [count]) : T("添加到快速访问 {0} 项", [count]),
                icon: "quick",
                run: () => quickMany(),
              });
            }
            if (allSessions) {
              const archived = bulkIds.every((checkedId) => sessionsById.get(checkedId)?.archived === true);
              items.push({
                label: archived ? T("取消归档 {0} 项", [count]) : T("归档 {0} 项", [count]),
                icon: "archive",
                run: () => setArchive(!archived),
              });
            }
            // AI 总结: handing a batch to a model in one go is the reason this
            // menu exists for a multi-selection, so it sits with the bulk verbs.
            // Containers have no transcript, so only the sessions in the set go.
            const bulkSessionIds = bulkIds.filter((checkedId) => sessionsById.has(checkedId));
            if (bulkSessionIds.length > 0) {
              items.push({ sep: true });
              items.push({
                label: T("AI 总结 {0} 项", [bulkSessionIds.length]),
                icon: "spark",
                run: () => startSummary(bulkSessionIds.map((checkedId) => {
                  const row = sessionsById.get(checkedId);
                  return { id: checkedId, title: row?.displayTitle ?? row?.title ?? checkedId };
                }), setHint),
              });
            }
            items.push({ sep: true });
            items.push({
              label: T("删除 {0} 项", [count]),
              icon: "trash",
              danger: true,
              run: () => deleteSelection(),
            });
            setContextMenu({ left: x, top: y, items });
            return;
          }

          // A shortcut opens what it points at, and that branch lives below
          // (kind === "shortcut"), so this generic 打开 stays off it.
          if (kind !== "shortcut") {
            items.push({ label: kind === "session" ? T("打开会话") : T("打开"), icon: "external", run: () => openContextTarget(kind, target) });
          }
          // 新建 lives on the container rows, next to "open": creating a folder
          // inside the folder you right-clicked is the one action a file manager
          // puts here, and it saves a trip to the toolbar. A shortcut is a pointer:
          // 新建 under it would have to land somewhere else, and an entry that
          // navigates before it acts is a lie about its destination.
          //
          // The two entries answer to different rules. 新建文件夹 belongs to every
          // real directory — a workspace, a folder, and the two fixed places that
          // hold them (根目录 / 未分组) — because the plugin can write a folder
          // wherever it draws. 新建会话 belongs only inside a workspace (see
          // `canStartDraft`): DSH files drafts under a workspace, so one asked for
          // from 未分组 would open in the *default* workspace instead.
          const creatableHere =
            kind === "workspace" ||
            kind === "folder" ||
            (kind === "fixed" && ((nodeId ?? id) === FIXED.root || (nodeId ?? id) === FIXED.ungrouped));
          const draftableHere =
            (kind === "workspace" || kind === "folder") && canStartDraft(nodeId ?? id, tree);
          if (draftableHere) {
            items.push({
              label: T("在此新建会话"),
              icon: "plus",
              run: () => {
                navigate(nodeId);
                // The node, not the entity id: a folder has no workspace of its
                // own, so the answer has to come from its parent chain. Passing
                // `undefined` for folders read the *previous* scope, because
                // navigate() has not landed yet when this line runs.
                newSession(nodeId);
              },
            });
          }
          if (creatableHere) {
            items.push({
              label: T("在此新建文件夹"),
              icon: "folderplus",
              run: () => newFolder(nodeId),
            });
          }
          items.push({ sep: true });
          // Every session row is the session itself: 所有会话 lists the real logs,
          // so its menu is the session menu and 删除 bins the file. Only 收藏 /
          // 待办 draw shortcut rows, and those go through kind === "shortcut".
          if (kind === "session") {
            const session = sessionsById.get(id) ?? payload;
            // A subagent's menu is mostly read-only: the operations that change
            // its *parent's* run belong to the parent (domain/subagents.js), and
            // the host refuses them anyway; offering them here would only produce
            // a hint after a failed round-trip. 删除 is the exception — a bin
            // entry is its own payload — so it is offered at the bottom.
            if (session?.isSubagent === true) {
              // 转到会话原位置 answers a question only 收藏 / 待办 raise: there the row
              // is a membership, so where it really lives is not on screen.
              if (memberScope) {
                items.push({ label: T("转到会话原位置"), icon: "locate", run: () => goToSessionOrigin(id) });
              }
              items.push({ label: T("在文件管理器中显示"), icon: "folder", run: () => revealSessionDir(id) });
              items.push({ label: T("复制文件路径"), icon: "copy", run: () => copySessionPath(id) });
              items.push({
                label: T("跳转到父会话"),
                icon: "branch",
                disabled: !session.parentSession,
                onDisabled: () => setHint(T("这个子智能体没有可解析的父会话")),
                run: () => {
                  if (session.parentSession) selectAndReveal(session.parentSession);
                },
              });
              items.push({ sep: true });
              // A summary is not a change to the store — it lands in its own
              // sidecar — so a delegation can have one even though every other
              // write belongs to its parent. A long-running subagent is exactly
              // the session people never open, which is when a summary pays.
              items.push({
                label: summaryStore.snapshot().sessions?.[id] ? T("重新生成") : T("AI 总结"),
                icon: "spark",
                run: () => startSummary([{ id, title: session.displayTitle ?? id }], setHint),
              });
              items.push({ sep: true });
              items.push({
                label: T("复制会话 id"),
                icon: "copy",
                run: () => {
                  navigator.clipboard?.writeText(id).catch(() => {});
                  setHint(T("已复制会话 id"));
                },
              });
              items.push({ sep: true });
              // 删除 is the one write a delegation can take on its own. The bin
              // only moves the payload and restore puts it back, so the parent's
              // run is untouched and its transcript keeps resolving the child it
              // points at; every other verb above stays the parent's. Inside 回收站
              // the same row offers the bin's two verbs.
              if (session?.trashed) {
                items.push({ label: T("还原"), icon: "restore", run: () => restoreSelection() });
                items.push({ sep: true });
                items.push({ label: T("永久删除"), icon: "trash", danger: true, run: () => deleteSelection() });
              } else {
                items.push({ label: T("删除到回收站"), icon: "trash", danger: true, run: () => deleteSelection() });
              }
              items.push({ label: T("子智能体 · 随父会话操作"), disabled: true });
              setContextMenu({ left: x, top: y, items });
              return;
            }
            items.push({ label: T("重命名"), icon: "pencil", key: "F2", run: () => beginRenameAfterClick("session", id, descriptor.surface ?? "list") });
            if (session?.trashed) {
              items.push({ label: T("还原"), icon: "restore", run: () => restoreSelection() });
              items.push({ sep: true });
              items.push({ label: T("永久删除"), icon: "trash", danger: true, run: () => deleteSelection() });
            } else {
              items.push({
                label: session?.favorite ? T("取消收藏") : T("收藏"),
                icon: "star",
                run: () => toggleFlag("favorite"),
              });
              items.push({ label: session?.todo ? T("取消待办") : T("待办"), icon: "todo", run: () => toggleFlag("todo") });
              items.push({ label: session?.archived ? T("取消归档") : T("归档"), icon: "archive", run: () => toggleArchive() });
              items.push({ label: T("分叉"), icon: "branch", run: () => forkSession() });
              items.push({ sep: true });
              items.push({ label: T("剪切"), icon: "cut", key: "Ctrl+X", run: () => cutOrCopy("cut") });
              items.push({ label: T("复制"), icon: "copy", key: "Ctrl+C", run: () => cutOrCopy("copy") });
              const pasteBlockedHere = scope === FIXED.favorites || scope === FIXED.todos;
              items.push({
                label: pasteTarget ? T("粘贴到「{0}」", [pasteTarget.name]) : T("粘贴（先进入工作区）"),
                icon: "paste",
                key: "Ctrl+V",
                disabled: clipboard.ids.length === 0 || !pasteTarget || pasteBlockedHere,
                onDisabled: () => {
                  if (clipboard.ids.length === 0 && (clipboard.nodes?.length ?? 0) === 0) {
                    setHint(T("剪贴板是空的：先剪切或复制"));
                  } else if (pasteBlockedHere) {
                    setHint(T("收藏和待办页不能粘贴：用星标把会话加进来"));
                  } else if ((clipboard.nodes?.length ?? 0) > 0) {
                    setHint(T("剪贴板里是目录：进入一个文件夹或根目录再粘贴"));
                  } else setHint(T("当前位置不属于任何工作区，先进入一个工作区再粘贴"));
                },
                run: () => pasteClipboard(),
              });
              // 在本目录生成快捷方式: one command, one destination — the directory the
              // user is standing in. 收藏 / 待办 keep taking references by drag and by
              // the star in the session header, so a flyout of destinations is not
              // needed here; it only made "where did it go?" a question.
              if (shortcutParent) {
                items.push({ sep: true });
                items.push({
                  label: T("在本目录生成快捷方式"),
                  icon: "shortcut",
                  run: () => createShortcutHere("session", id),
                });
                items.push({ sep: true });
              }
              items.push({ label: T("导出为 Markdown"), icon: "download", run: () => exportSession(id, "md") });
              items.push({ label: T("导出为 JSONL"), icon: "download", run: () => exportSession(id, "jsonl") });
              items.push({ sep: true });
              // 总结 sits next to 导出: both produce a text about this session, and
              // 重新生成 appears only once there is something to regenerate.
              items.push({
                label: summaryStore.snapshot().sessions?.[id] ? T("重新生成") : T("AI 总结"),
                icon: "spark",
                run: () => startSummary([{ id, title: session?.displayTitle ?? id }], setHint),
              });
              items.push({ sep: true });
              // 在文件管理器中显示 opens the session's cwd; 定位会话文件 selects the
              // log itself. Two different questions, two entries.
              if (memberScope) {
                items.push({ label: T("转到会话原位置"), icon: "locate", run: () => goToSessionOrigin(id) });
              }
              items.push({ label: T("在文件管理器中显示"), icon: "folder", run: () => revealSessionDir(id) });
              items.push({ label: T("复制文件路径"), icon: "copy", run: () => copySessionPath(id) });
              items.push({ sep: true });
              items.push({ label: T("删除到回收站"), icon: "trash", danger: true, run: () => deleteSelection() });
            }
          } else if (kind === "workspace") {
            const pinned = Boolean(tree?.pins?.[nodeId]);
            const quick = Boolean(tree?.quickAccess?.[nodeId]);
            items.push({ label: T("重命名工作区"), icon: "pencil", key: "F2", run: () => beginRenameAfterClick("workspace", id, descriptor.surface) });
            items.push({
              label: pinned ? T("取消置顶") : T("置顶"),
              icon: "pin",
              run: () => togglePinNode(nodeId, !pinned),
            });
            items.push({
              label: quick ? T("移出快速访问") : T("添加到快速访问"),
              icon: "quick",
              run: () => toggleQuickAccess(nodeId, !quick),
            });
            items.push({
              label: T("在文件管理器中显示"),
              icon: "locate",
              run: () => revealNode({ kind: "workspace", id }),
            });
            // 在本目录生成快捷方式: see the session menu — the destination is the
            // current directory and nothing else.
            if (shortcutParent) {
              items.push({
                label: T("在本目录生成快捷方式"),
                icon: "shortcut",
                run: () => createShortcutHere("workspace", id),
              });
            }
            items.push({ sep: true });
            items.push({
              label: T("剪切"),
              icon: "cut",
              key: "Ctrl+X",
              run: () => cutOrCopy("cut"),
            });
            items.push({
              label: T("删除工作区"),
              icon: "trash",
              danger: true,
              run: () => removeWorkspace(id),
            });
          } else if (kind === "mapping") {
            // A member of 收藏 / 待办 that names a folder or a workspace is shown
            // as that container, so its menu leads to it. The membership is the
            // only thing this page owns, hence one item for it and nothing else.
            const member = payload?.mapped ?? null;
            const what = member?.container === FIXED.todos ? T("待办") : T("收藏");
            items.push({
              label: T("跳转到原位置"),
              icon: "locate",
              // openId is always built for a member row, so this only trips when
              // the target left the tree between snapshot and click.
              disabled: !member?.openId || !tree?.nodes?.[member.openId],
              onDisabled: () => setHint(T("原来的位置已经不在了")),
              run: () => navigate(member.openId),
            });
            items.push({ sep: true });
            items.push({ label: T("移出{0}", [what]), icon: "x", danger: true, run: () => deleteSelection() });
          } else if (kind === "shortcut") {
            const shortcutNode = payload ?? tree?.nodes?.[id] ?? null;
            // 打开 on a pointer means the thing behind it: a bookmark to a session
            // resumes that session, a bookmark to a place enters the place.
            items.push({
              label: T("打开"),
              icon: "external",
              run: () => {
                if (!shortcutNode) return;
                if (shortcutNode.shortcutKind === "session") openInDsh(shortcutNode.targetId);
                else revealShortcutTarget(shortcutNode);
              },
            });
            items.push({
              label: T("跳转到原位置"),
              icon: "locate",
              run: () => revealShortcutTarget(shortcutNode),
            });
            items.push({ sep: true });
            // Deleting a shortcut removes the pointer, never the payload — the
            // payload only ever goes away from its own folder or from 回收站.
            items.push({
              label: T("移除快捷方式"),
              icon: "x",
              danger: true,
              run: () => deleteSelection(),
            });
          } else if (kind === "fixed") {
            const fixedId = nodeId ?? id;
            if (fixedId === FIXED.todos || fixedId === FIXED.favorites) {
              items.push({
                label: T("粘贴到此处（快捷方式）"),
                icon: "paste",
                disabled: clipboard.ids.length === 0 && (clipboard.nodes?.length ?? 0) === 0,
                run: () => pasteAsShortcut(fixedId),
              });
              // A container of pointers can be emptied in one move. It is 移出 in
              // bulk, so it carries the same promise: only the pointers go.
              const what = fixedId === FIXED.favorites ? T("收藏") : T("待办");
              const pointers = Object.values(tree?.nodes ?? {}).filter(
                (node) => node?.kind === "shortcut" && node.parent === fixedId,
              ).length;
              items.push({
                label: T("清空{0}", [what]),
                icon: "x",
                danger: true,
                disabled: pointers === 0,
                run: () => emptyContainer(fixedId),
              });
            }
            items.push({ sep: true });
            items.push({ label: T("查看全部"), icon: "external", run: () => navigate(fixedId) });
          } else {
            items.push({ label: T("重命名文件夹"), icon: "pencil", key: "F2", run: () => beginRenameAfterClick("folder", id, descriptor.surface) });
            const folderPinned = Boolean(tree?.pins?.[nodeId]);
            items.push({
              label: folderPinned ? T("取消置顶") : T("置顶"),
              icon: "pin",
              run: () => togglePinNode(nodeId, !folderPinned),
            });
            items.push({
              label: tree?.quickAccess?.[nodeId] ? T("移出快速访问") : T("添加到快速访问"),
              icon: "quick",
              run: () => toggleQuickAccess(nodeId, !tree?.quickAccess?.[nodeId]),
            });
            // 在本目录生成快捷方式: see the session menu — the destination is the
            // current directory and nothing else.
            if (shortcutParent) {
              items.push({
                label: T("在本目录生成快捷方式"),
                icon: "shortcut",
                run: () => createShortcutHere("folder", id),
              });
            }
            items.push({ sep: true });
            items.push({
              label: T("剪切"),
              icon: "cut",
              key: "Ctrl+X",
              run: () => cutOrCopy("cut"),
            });
            // Deleting a folder acts on the scope, so the scope has to be the
            // folder the menu was opened on, not wherever the user stood before.
            items.push({
              label: T("删除文件夹"),
              icon: "trash",
              danger: true,
              run: () => {
                navigate(nodeId);
                removeFolder(nodeId);
              },
            });
          }
          setContextMenu({ left: x, top: y, items });
        },
        // The menu closes over the current selection state on purpose: the
        // items act on "what is selected now", not on what it was when the
        // menu was opened.
        [
          beginRenameAfterClick,
          checked,
          clipboard,
          copySessionPath,
          createShortcutHere,
          cutOrCopy,
          deleteSelection,
          emptyContainer,
          exportSession,
          flagMany,
          flagMemberIn,
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
          openContextTarget,
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
          sessionsById,
          setArchive,
          setHint,
          shortcutParent,
          startSummary,
          summaryStore,
          toggleArchive,
          toggleFlag,
          togglePinNode,
          toggleQuickAccess,
          tree,
        ],
      );

      // ── right-click, one render later ────────────────────────────────────
      // A row selects itself on right-click and then asks for the menu. Doing
      // both in one event handler meant the menu was built from the *previous*
      // render, so its 收藏/归档/分叉 acted on the old selection — right-clicking
      // row B while row A was selected starred A — and with nothing selected the
      // items reported "先选择要操作的会话" even though the row was visibly
      // selected. Recording the click and building the menu after React has
      // committed the selection is what makes the menu describe the row under
      // the pointer.
      const pendingMenuRef = useRef(null);
      // The row under the pointer decides the subject of its own menu. A checked
      // set that row is not part of belongs to an earlier gesture; acting on it
      // while the menu names this row is how one right-click ended up starring
      // two other rows (and renaming a third). A ref keeps openContextMenu
      // stable — it is a prop on every row.
      const checkedRef = useRef(checked);
      checkedRef.current = checked;
      const [menuTick, setMenuTick] = useState(0);
      const openContextMenu = useCallback(
        // Two call shapes by design: tree/workspace rows pass a descriptor
        // ({kind,id,nodeId,node}), list rows pass positional arguments, because
        // that is what each component naturally has.
        (event, kindOrDescriptor, maybeId, maybeSession) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          const descriptor =
            kindOrDescriptor && typeof kindOrDescriptor === "object"
              ? kindOrDescriptor
              : {
                  kind: kindOrDescriptor,
                  id: maybeId,
                  nodeId: maybeId,
                  node: maybeSession ?? null,
                };
          const rect = event?.currentTarget?.getBoundingClientRect?.();
          const x = Number.isFinite(event?.clientX) && event.clientX > 0 ? event.clientX : (rect?.left ?? 200) + 20;
          const y = Number.isFinite(event?.clientY) && event.clientY > 0 ? event.clientY : (rect?.top ?? 100) + 20;
          const rowKey = descriptor.nodeId ?? descriptor.id ?? null;
          const checkedNow = checkedRef.current;
          if (rowKey && checkedNow.size > 0 && !checkedNow.has(rowKey) && !checkedNow.has(descriptor.id)) {
            setChecked(new Set());
            setSelected(rowKey);
          }
          pendingMenuRef.current = { x, y, descriptor };
          setMenuTick((tick) => tick + 1);
        },
        [],
      );
      useEffect(() => {
        const pending = pendingMenuRef.current;
        if (!pending) return;
        pendingMenuRef.current = null;
        buildContextMenu(pending.x, pending.y, pending.descriptor);
      }, [buildContextMenu, menuTick]);
      return { contextMenu, setContextMenu, openContextMenu, renameCurrent };
    }
