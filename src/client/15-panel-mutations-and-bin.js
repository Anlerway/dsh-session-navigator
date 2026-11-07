      // ── mutations ────────────────────────────────────────────────────────
      // Every write goes through `mutate`, which reloads the snapshot on
      // success and surfaces the host's error text on failure. The panel never
      // guesses at the new state locally: the host owns the tree and the
      // annotations, and a stale local copy is exactly the bug this avoids.
      /**
       * Say what went wrong in words the user can act on.
       *
       * The host speaks in error codes with English messages ("<id> is open in
       * this DSH process; close it before moving it" — advice the panel gives no
       * way to follow). The codes map to a sentence that names the next step;
       * anything unrecognised is passed through rather than swallowed.
       *
       * @param {any} error
       * @returns {string}
       */
      const describeError = useCallback((error) => {
        const code = String(error?.code ?? "");
        const raw = String(error?.message ?? error ?? "").trim();
        if (code === "session-active") return T("这个会话正在 DSH 中打开，无法移动或删除；可以先复制它，或重启 DSH 后再试");
        if (code === "subagent-unsupported") return T("子智能体跟随父会话，不能单独操作：请选择父会话");
        if (code === "target-exists") return T("目标位置已有同名会话，未覆盖");
        if (code === "workspace-not-found") return T("目标工作区不存在，或它的目录已经失效");
        if (code === "session-not-found") return T("这个会话不存在，或已经被永久删除");
        if (code === "node-not-found") return T("这个位置已经不存在了，刷新后再试");
        if (code === "revision-conflict") return T("数据已被其他窗口修改，已重新载入，请再试一次");
        if (!raw) return T("操作失败，请重试");
        return raw;
      }, []);

      const mutate = useCallback(
        async (run, successHint, inspect) => {
          try {
            const result = await run();
            await load(true);
            // A batch write answers per item: HTTP 200, some ids applied, some
            // not. `inspect` is how a caller turns that into a visible failure
            // instead of a success toast (batch-write item 4).
            const problem = typeof inspect === "function" ? inspect(result) : null;
            if (problem) {
              setErrorText(problem);
              setHint("");
            } else {
              setErrorText("");
              if (successHint) setHint(successHint);
            }
            return true;
          } catch (error) {
            setErrorText(describeError(error));
            setHint("");
            if (error?.code === "revision-conflict") await load(true);
            return false;
          }
        },
        [describeError, load],
      );

      /**
       * Turn per-session move/copy results into one sentence, or null.
       *
       * POST /move answers 200 with `results[]` even when half the batch was
       * refused (a live session, a missing workspace). The status code alone
       * would let the toast say 已复制 N 个会话 while the copy of the refused ones
       * never happened. Naming them is the whole point of the sentence.
       *
       * @param {any} payload
       * @param {boolean} copy
       * @returns {string | null}
       */
      const moveFailureHint = useCallback(
        (payload, copy) => {
          const results = Array.isArray(payload?.results) ? payload.results : [];
          const failed = results.filter((entry) => entry && entry.ok === false);
          if (failed.length === 0) return null;
          const verb = copy ? T("复制") : T("移动");
          const reason = describeError(failed[0]);
          if (failed.length === results.length) return T("{0} 个会话都没能{1}：{2}", [failed.length, verb, reason]);
          const names = failed
            .slice(0, 3)
            .map((entry) => sessionsById.get(entry.sessionId)?.displayTitle ?? entry.sessionId);
          const label = names.join(T("、")) + (failed.length > names.length ? T(" 等") : "");
          return T("已{0} {1} 个会话；{2} 个没成功（{3}）：{4}", [
            verb,
            results.length - failed.length,
            failed.length,
            label,
            reason,
          ]);
        },
        [describeError, sessionsById],
      );

      /**
       * The same treatment for the bin: /trash and /restore report per session.
       *
       * @param {string} verb
       * @param {any} payload
       * @returns {string | null}
       */
      const binFailureHint = useCallback(
        (verb, payload) => {
          const errors = Array.isArray(payload?.errors) ? payload.errors.filter((entry) => entry?.sessionId) : [];
          if (errors.length === 0) return null;
          return T("{0} 个会话没能{1}：{2}", [errors.length, verb, describeError(errors[0])]);
        },
        [describeError],
      );

      // `refreshDshViews` is module-level: a row menu deletes sessions too, and
      // it is not rendered by the panel. It is a stable reference, so it can sit
      // in a dependency list like any callback.

      const newFolder = useCallback(async (parentId) => {
        // window.prompt is disabled in Electron and returns null, so the name
        // comes from a dialog.
        const name = await dialogs.ask({
          title: T("新建文件夹"),
          message: T("文件夹建在当前所在的目录里，取消则不创建。"),
          placeholder: T("新建文件夹"),
          value: T("新建文件夹"),
          confirmLabel: T("创建"),
          maxLength: 64,
          validate: (text) => (text ? true : T("文件夹名称不能为空")),
        });
        if (name === null) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        // A folder is created where the user is looking: an explicit parent (the
        // row that was right-clicked), otherwise the container on screen. That
        // includes a *workspace*, so 工作区里再分一层文件夹 is one click — the
        // drop target and the host rule agree on which containers can hold one.
        // 收藏/待办/回收站 hold references rather than a tree, so the root is the
        // honest fallback there.
        const explicit = typeof parentId === "string" && parentId ? parentId : null;
        const here = tree?.nodes?.[scope];
        const parent = explicit ?? (here?.accepts?.folder ? scope : FIXED.root);
        try {
          const result = await apiSend("POST", "/folders", { name: trimmed, parent });
          await load(true);
          // Show it, do not enter it. Creating something invisible is a bug, but
          // so is a creation that navigates away from the rows the user was
          // working with — the new folder is empty, so stepping into it hides
          // the sessions they just filed. Expanding the parent puts the row on
          // screen; the row is highlighted, and the next click opens it.
          setExpanded((previous) => {
            const next = new Set(previous);
            next.add(parent);
            return next;
          });
          if (result?.id) setSelected(result.id);
          // The host numbers a duplicate name (工作 → 工作（1）), so the hint has
          // to quote the stored name, not the one that was typed.
          const stored = result?.folder?.name ?? trimmed;
          setHint(T("已新建文件夹「{0}」", [stored]));
        } catch (error) {
          setHint(String(error?.message ?? error));
          if (error?.code === "revision-conflict") await load(true);
        }
      }, [dialogs, load, scope, tree]);

      const removeFolder = useCallback(
        async (targetId) => {
          // `targetId` comes from the context menu; without it the command acts
          // on the folder the user is standing in.
          const id = typeof targetId === "string" && targetId ? targetId : scope;
          const node = tree?.nodes?.[id];
          if (!node || node.type !== "folder" || node.fixed) {
            setHint(T("只有自建文件夹可以删除"));
            return;
          }
          const confirmed = await dialogs.confirm({
            title: T("删除文件夹"),
            message: T("删除「{0}」？其中的内容会移动到上一级，不会丢失。", [node.name]),
            confirmLabel: T("删除"),
            danger: true,
          });
          if (!confirmed) return;
          mutate(() => apiSend("DELETE", `/folders/${encodeURIComponent(id)}?lift=1`), T("已删除文件夹"));
        },
        [dialogs, mutate, scope, tree],
      );

      /**
       * What the user has selected, resolved to one of two kinds.
       *
       * `selected` holds *either* a session id *or* a tree node id, and the two
       * id spaces are different: a workspace node is `w-<uuid>` while DSH's own
       * record is `<uuid>`, and a folder is `d-<…>`. A command that re-derives
       * the kind for itself gets it wrong eventually, and a workspace id read as a
       * tree node cannot be renamed or moved. Resolving once, here, is what keeps
       * the two id spaces apart.
       */
      const selectionTarget = useMemo(() => {
        if (!selected) return null;
        const node = tree?.nodes?.[selected] ?? null;
        if (node) {
          const isWorkspace = node.type === "workspace";
          return {
            kind: isWorkspace ? "workspace" : "folder",
            node,
            // The id a command must send: DSH's own for a workspace, ours for a
            // folder. `nodeId` stays the tree id for navigation and placement.
            actionId: isWorkspace ? node.workspaceId ?? node.id : node.id,
            nodeId: node.id,
            editable: isWorkspace ? true : node.kind === "folder",
          };
        }
        const session = sessionsById.get(selected) ?? null;
        return session ? { kind: "session", session, actionId: session.id, nodeId: null, editable: true } : null;
      }, [selected, sessionsById, tree]);

      /**
       * Refuse a selection that contains a subagent, with a hint that says what
       * to do instead.
       *
       * A subagent follows its parent: delete, cut, copy, 收藏, 待办, 归档, 重命名
       * and 分叉 are the parent's operations, and the host refuses them too
       * (`subagent-unsupported`). Checking here as well is not redundant — it
       * turns a failed round-trip into an explanation, and it stops a bulk
       * action from doing half its work before the host rejects the child.
       *
       * @param {string[]} ids
       * @returns {boolean} true when the caller must stop
       */
      const blockedByBinding = useCallback(
        (ids) => {
          const bound = ids.filter((id) => sessionsById.get(id)?.isSubagent === true);
          if (bound.length === 0) return false;
          setHint(
            bound.length === 1
              ? T("子智能体跟随父会话，不能单独操作：请选择父会话")
              : T("{0} 个子智能体跟随父会话，不能单独操作：请选择父会话", [bound.length]),
          );
          return true;
        },
        [sessionsById],
      );

      // The list rows the user can act on: the checked set, or the selected row.
      // Containers are included: a workspace or a folder is a thing you move and
      // rename, not only a place you stand in.
      const targets = useMemo(() => {
        const ids = checked.size > 0 ? [...checked] : selected ? [selected] : [];
        return ids.filter((id) => sessionsById.has(id) || Boolean(tree?.nodes?.[id]));
      }, [checked, selected, sessionsById, tree]);

      /**
       * The one row 重命名 can act on, or null.
       *
       * A session, a folder and a workspace all have a name; a fixed node
       * (所有会话 / 收藏 / 待办 / 回收站), a session shortcut (whose name is the
       * target's) and a multi-row selection do not, and the button greys out
       * for them instead of opening an editor over the wrong name. This is the
       * same resolution `selectionTarget` does, done from `targets` so the
       * checked set and the selected row cannot disagree.
       */
      const renameTarget = useMemo(() => {
        if (targets.length !== 1) return null;
        const id = targets[0];
        const node = tree?.nodes?.[id];
        if (node) {
          if (node.type === "workspace") return { kind: "workspace", id: node.workspaceId ?? node.id };
          return node.kind === "folder" ? { kind: "folder", id: node.id } : null;
        }
        return sessionsById.has(id) ? { kind: "session", id } : null;
      }, [targets, tree, sessionsById]);

      // ── the bin (S4) ─────────────────────────────────────────────────────
      // 删除 is a real move: the payload leaves DSH's sessions tree, so the
      // session disappears from the official sidebar too. That is what a bin
      // means, and it is why every bin write is paired with an undo entry
      // (S6) — the user can always take the last step back.
      const idsToActOn = useCallback(
        () => (checked.size > 0 ? [...checked] : selected ? [selected] : []).filter((id) => sessionsById.has(id)),
        [checked, selected, sessionsById],
      );

      /** The same set, but only the container nodes in it. */
      const nodeIdsToActOn = useCallback(
        () => (checked.size > 0 ? [...checked] : selected ? [selected] : []).filter((id) => {
          const node = tree?.nodes?.[id];
          // 默认工作区 is an ordinary workspace: it can be moved, pinned and
          // deleted like any other, so it must not be filtered out of the actions.
          return Boolean(node) && !node.fixed;
        }),
        [checked, selected, tree],
      );

      /**
       * Ids of the checked folders that can actually be deleted.
       *
       * 特殊文件夹 (根目录/未分组/收藏/待办) are excluded here as well as in the
       * row: they have no checkbox, and a programmatic call must not be able to
       * smuggle one in either. Workspaces are not folders: they are DSH's own
       * record, and deleting one is DSH's own operation — see
       * workspaceTargets below.
       */
      const folderTargets = useCallback(() => {
        // Checked rows first; when nothing is checked, the selected row counts
        // too, so 删除 on a selected folder does what the button says instead of
        // silently deleting the folder the user happens to be standing in.
        const ids = checked.size > 0 ? [...checked] : selected ? [selected] : [];
        return ids.filter((id) => {
          const node = tree?.nodes?.[id];
          return Boolean(node && node.type === "folder" && node.kind === "folder" && !node.fixed);
        });
      }, [checked, selected, tree]);

      /**
       * The checked workspaces, as the ids DSH's own delete expects.
       *
       * 删除 on a workspace removes the registration, never the directory: DSH
       * keeps the files and every log, and the sessions that were grouped under
       * it reappear under 未分组 (src/host/actions.js deleteWorkspace already
       * lifts its references into 收藏 for the same reason). That is why the
       * workspace can sit behind the same 删除 as everything else.
       */
      const workspaceTargets = useCallback(() => {
        const ids = checked.size > 0 ? [...checked] : selected ? [selected] : [];
        return ids
          .map((id) => tree?.nodes?.[id] ?? null)
          .filter((node) => Boolean(node) && node.type === "workspace" && !node.fixed)
          .map((node) => ({
            nodeId: node.id,
            workspaceId: node.workspaceId ?? node.id,
            name: node.name ?? node.workspaceId ?? node.id,
          }));
      }, [checked, selected, tree]);

      /**
       * The shortcut that puts `sessionId` in `container`, if there is one.
       *
       * 收藏 and 待办 hold shortcuts, so membership has no flag to flip: taking a
       * session out of the page means deleting this pointer. The session file is
       * never touched — that is the promise the confirmation makes.
       */
      const shortcutFor = useCallback(
        (container, sessionId) => {
          for (const [id, node] of Object.entries(tree?.nodes ?? {})) {
            if (node?.kind !== "shortcut" || node.shortcutKind !== "session") continue;
            if (node.targetId === sessionId && node.parent === container) return id;
          }
          return null;
        },
        [tree],
      );

      /**
       * 清空 收藏 / 待办: drop every pointer the container holds.
       *
       * The batch form of 移出. A container of shortcuts owns nothing but the
       * pointers, so this deletes those and stops there — the sessions keep
       * their files, their workspaces and their own 回收站.
       */
      const emptyContainer = useCallback(
        async (container) => {
          const what = container === FIXED.favorites ? T("收藏") : T("待办");
          const pointers = Object.entries(tree?.nodes ?? {})
            .filter(([, node]) => node?.kind === "shortcut" && node.parent === container)
            .map(([id]) => id);
          if (pointers.length === 0) {
            setHint(T("「{0}」里没有内容", [what]));
            return;
          }
          const confirmed = await dialogs.confirm({
            title: T("清空{0}", [what]),
            message: T("清空{0}？{1} 个快捷方式会被移出，原会话不会删除。", [what, pointers.length]),
            confirmLabel: T("清空"),
          });
          if (!confirmed) return;
          await mutate(async () => {
            for (const id of pointers) await apiSend("DELETE", `/shortcuts/${encodeURIComponent(id)}`);
          }, T("已清空{0}（{1} 个）", [what, pointers.length]));
          setChecked(new Set());
        },
        [dialogs, mutate, setChecked, setHint, tree],
      );

      const deleteSelection = useCallback(async () => {
        const ids = idsToActOn();
        const folders = folderTargets();
        const workspaces = workspaceTargets();
        const selectionNow = checked.size > 0 ? [...checked] : selected ? [selected] : [];
        // Standing in 收藏 or 待办, 删除 means "take it out of this page". The
        // payload has its own home, its own workspace and its own 回收站, so
        // there is nothing to move here and the dialog says so.
        const container = scope === FIXED.favorites || scope === FIXED.todos ? scope : null;
        if (container && selectionNow.length > 0) {
          // Two ways in: a session member is picked by the session id (the flag is
          // derived from the shortcut), a folder or workspace member by its own
          // shortcut id — the row already wears it.
          const removing = selectionNow
            .map((id) => {
              const node = tree?.nodes?.[id];
              const member = node?.kind === "shortcut" && node.parent === container ? id : shortcutFor(container, id);
              return { id, shortcutId: member };
            })
            .filter((entry) => entry.shortcutId);
          if (removing.length === 0) return;
          const what = container === FIXED.favorites ? T("收藏") : T("待办");
          const confirmed = await dialogs.confirm({
            title: T("移出{0}", [what]),
            message: T("是否移出{0}？原文件不会删除，只是不再出现在「{0}」里。", [what]),
            confirmLabel: T("移出"),
          });
          if (!confirmed) return;
          await mutate(async () => {
            for (const entry of removing) {
              await apiSend("DELETE", `/shortcuts/${encodeURIComponent(entry.shortcutId)}`);
            }
          }, T("已移出{0}（{1} 个）", [what, removing.length]));
          setChecked(new Set());
          return;
        }
        // 删除 is the one operation a subagent can take on its own: the bin moves
        // its payload and restore puts it back, so the parent's run is untouched
        // (the cascade below still takes the whole chain when a *parent* is
        // deleted). Every other verb — 剪切/复制/归档/收藏/待办/重命名 — stays the
        // parent's and is still refused by blockedByBinding at its own call site.
        // Shortcuts are listed in the tree and the list, so they have to be
        // deletable there — deleting one removes the pointer, never the payload.
        const shortcuts = selectionNow.filter((id) => tree?.nodes?.[id]?.kind === "shortcut");
        if (ids.length === 0 && folders.length === 0 && shortcuts.length === 0 && workspaces.length === 0) {
          // Nothing is checked and no session is selected: 删除 applies to the
          // folder the user is standing in, which is what the button did before
          // the bin existed.
          removeFolder();
          return;
        }
        if (scope === FIXED.trash) {
          // Purging is the one operation with no undo, so it asks for a typed
          // acknowledgement instead of a plain yes/no.
          const confirmed = await dialogs.confirm({
            title: T("永久删除"),
            message: T("永久删除 {0} 个会话？日志和全部历史都会从磁盘移除。", [ids.length]),
            confirmLabel: T("永久删除"),
            danger: true,
            acknowledge: true,
            acknowledgeLabel: T("我明白此操作不可撤销"),
          });
          if (!confirmed) return;
          mutate(
            // DSH's sidebar keeps a row until it re-pulls its
            // baseline, and a purge is the only write here with no undo — the
            // row has to leave the sidebar in the same breath, or the next
            // click lands on a session that no longer exists.
            async () => {
              const result = await apiSend("POST", "/purge", { ids });
              await requestDshRefresh();
              return result;
            },
            T("已永久删除 {0} 个会话", [ids.length]),
            (payload) => binFailureHint(T("永久删除"), payload),
          );
          return;
        }
        const parts = [];
        if (workspaces.length > 0) parts.push(T("{0} 个工作区（删除登记，会话移到「未分组」）", [workspaces.length]));
        if (folders.length > 0) parts.push(T("{0} 个文件夹（其中内容会移到上一级）", [folders.length]));
        if (ids.length > 0) parts.push(T("{0} 个会话（移入回收站）", [ids.length]));
        if (shortcuts.length > 0) parts.push(T("{0} 个快捷方式（只移除标注，原文件保留）", [shortcuts.length]));
        const doneParts = [];
        if (workspaces.length > 0) doneParts.push(T("已删除 {0} 个工作区", [workspaces.length]));
        if (folders.length > 0) doneParts.push(T("已删除 {0} 个文件夹", [folders.length]));
        if (ids.length > 0) doneParts.push(T("已移入回收站 {0} 个会话", [ids.length]));
        if (shortcuts.length > 0) doneParts.push(T("已移除 {0} 个快捷方式", [shortcuts.length]));
        const confirmed = await dialogs.confirm({
          title: T("删除"),
          message: T("删除 {0}？", [parts.join(T("，以及 "))]),
          confirmLabel: T("删除"),
          danger: true,
        });
        if (!confirmed) return;
        // The bin answers per session; keep its payload so a partial delete can
        // be reported instead of implied to have all landed.
        let trashed = null;
        mutate(async () => {
          // Workspaces first: DSH's delete unregisters the workspace and the
          // sessions under it fall back to 未分组, so the rest of the batch sees
          // the same sessions it did before.
          for (const workspace of workspaces) {
            await apiSend("POST", `/workspaces/${encodeURIComponent(workspace.workspaceId)}/delete`, {});
          }
          // Folders next: deleting a folder lifts its contents to the parent,
          // so the sessions are still there and any session ids in the same
          // batch are unaffected by the order.
          for (const folderId of folders) {
            await apiSend("DELETE", `/folders/${encodeURIComponent(folderId)}?lift=1`);
          }
          for (const shortcutId of shortcuts) {
            await apiSend("DELETE", `/shortcuts/${encodeURIComponent(shortcutId)}`);
          }
          // The checked rows are cleared only after every write in the batch has
          // landed. Clearing them before the trash call meant a failed trash
          // left the user with no selection and no explanation of which rows it
          // had been.
          if (ids.length > 0) {
            trashed = await binWrite("POST", "/trash", { ids });
            undoStack.current.push({
              label: T("已还原 {0} 个会话", [ids.length]),
              run: () => binWrite("POST", "/restore", { ids }),
            });
          }
          setChecked(new Set());
          return trashed;
        }, doneParts.join(T("，")), (payload) => binFailureHint(T("删除"), payload));
      }, [
        binFailureHint,
        describeError,
        dialogs,
        folderTargets,
        idsToActOn,
        workspaceTargets,
        mutate,
        removeFolder,
        scope,
        selected,
        checked,
        setChecked,
        setHint,
        shortcutFor,
        tree,
      ]);

      const restoreSelection = useCallback(() => {
        const ids = idsToActOn();
        if (ids.length === 0) {
          setHint(T("先选择要还原的会话"));
          return;
        }
        mutate(async () => {
          const restored = await binWrite("POST", "/restore", { ids });
          // Only a session that actually came back is worth an undo entry:
          // re-deleting one the host skipped would delete something else.
          if (Array.isArray(restored?.restored) && restored.restored.length > 0) {
            undoStack.current.push({
              label: T("已重新删除 {0} 个会话", [restored.restored.length]),
              run: () => binWrite("POST", "/trash", { ids: restored.restored }),
            });
          }
          return restored;
        }, T("已还原 {0} 个会话", [ids.length]), (payload) => binFailureHint(T("还原"), payload));
      }, [binFailureHint, idsToActOn, mutate]);

      const emptyTrashNow = useCallback(async () => {
        const count = allSessions.filter((session) => session.trashed).length;
        if (count === 0) {
          setHint(T("回收站已经是空的"));
          return;
        }
        const confirmed = await dialogs.confirm({
          title: T("清空回收站"),
          message: T("清空回收站？{0} 个会话会被永久删除，日志和历史都不会保留。", [count]),
          confirmLabel: T("清空"),
          danger: true,
          acknowledge: true,
          acknowledgeLabel: T("我明白此操作不可撤销"),
        });
        if (!confirmed) return;
        mutate(() => binWrite("POST", "/trash/empty", {}), T("已清空回收站"));
      }, [allSessions, dialogs, mutate]);

      const toggleFlag = useCallback(
        (flag) => {
          if (targets.length === 0) {
            setHint(T("先选择要操作的会话"));
            return;
          }
          // 收藏/待办 describe a session the user keeps; a delegation is part of
          // its parent's run, so the flag belongs on the parent.
          if (blockedByBinding(targets)) return;
          // 收藏 / 待办 are shortcut containers, so this writes a pointer: adding
          // one puts the session on the page, deleting one takes it off. The
          // session file is untouched in both directions.
          const container = flag === "favorite" ? FIXED.favorites : FIXED.todos;
          const currentValue = sessionsById.get(targets[0])?.[flag] === true;
          const next = !currentValue;
          const what = flag === "favorite" ? T("收藏") : T("待办");
          mutate(async () => {
            for (const id of targets) {
              const existing = shortcutFor(container, id);
              if (next && !existing) {
                await apiSend("POST", "/shortcuts", { parent: container, kind: "session", targetId: id });
              } else if (!next && existing) {
                await apiSend("DELETE", `/shortcuts/${encodeURIComponent(existing)}`);
              }
            }
          }, next ? T("已加入{0}", [what]) : T("已移出{0}", [what]));
        },
        [blockedByBinding, mutate, sessionsById, shortcutFor, targets],
      );

      /**
       * Membership of one row in 收藏 / 待办, whatever the row is.
       *
       * `shortcutFor` only knows session pointers; a folder or a workspace is
       * stored with its own target id, and a workspace keeps DSH's id space, so
       * the two lookups cannot share one key.
       */
      const shortcutMemberIn = useCallback(
        (container, id) => {
          const node = tree?.nodes?.[id] ?? null;
          if (!node || node.kind === "shortcut") return null;
          const kind = node.type === "workspace" ? "workspace" : "folder";
          const targetId = kind === "workspace" ? node.workspaceId ?? node.id : node.id;
          for (const [nodeId, candidate] of Object.entries(tree?.nodes ?? {})) {
            if (candidate?.kind !== "shortcut" || candidate.parent !== container) continue;
            if (candidate.shortcutKind !== kind || candidate.targetId !== targetId) continue;
            return nodeId;
          }
          return null;
        },
        [tree],
      );

      /**
       * What a checked row actually points at.
       *
       * 收藏 / 待办 draw members, so their row id is the shortcut, not the thing
       * behind it. Acting on the shortcut would create a shortcut to a shortcut,
       * so every bulk action resolves one step first: a session pointer becomes
       * its session, a container reference its container.
       */
      const bulkTargetOf = useCallback(
        (id) => {
          if (sessionsById.has(id)) return { sessionId: id };
          let node = tree?.nodes?.[id] ?? null;
          if (node?.kind === "shortcut") {
            if (node.shortcutKind === "session") return { sessionId: node.targetId };
            const target = shortcutTarget(node, tree);
            if (!target) {
              if (node.fixed) return null;
              return { kind: node.shortcutKind, targetId: node.targetId };
            }
            node = target;
          }
          if (!node || node.fixed) return null;
          const kind = node.type === "workspace" ? "workspace" : "folder";
          const targetId = kind === "workspace" ? node.workspaceId ?? node.id : node.id;
          return { kind, targetId };
        },
        [sessionsById, tree],
      );

      /**
       * Where one row already sits in 收藏 / 待办, whatever that row is: the
       * member id when the row is a function of that container (a session
       * pointer, a container by reference, or the member itself), else null.
       */
      const flagMemberIn = useCallback(
        (container, id) => {
          const session = sessionsById.get(id) ?? null;
          if (session) return shortcutFor(container, id);
          const node = tree?.nodes?.[id] ?? null;
          if (node?.kind === "shortcut" && node.parent === container) return id;
          return shortcutMemberIn(container, id);
        },
        [sessionsById, shortcutFor, shortcutMemberIn, tree],
      );

      /** 置顶 of one row: DSH's pin for a session, the plugin's own for a container. */
      const isPinned = useCallback(
        (id) => {
          const target = bulkTargetOf(id);
          if (!target) return false;
          if (target.sessionId) return sessionsById.get(target.sessionId)?.pinned === true;
          return Boolean(tree?.pins?.[target.targetId]);
        },
        [bulkTargetOf, sessionsById, tree],
      );

      /**
       * 收藏 / 待办 for a whole check-set.
       *
       * Bulk is not "toggle each row": in a mixed set that would flip half of it
       * either way. The direction is read once — from the row under the pointer —
       * and applied to every row, which is what "collect these" means. A
       * container goes in by reference too, so this cannot just call toggleFlag:
       * that one only knows sessions.
       */
      const flagMany = useCallback(
        (flag) => {
          if (targets.length === 0) {
            setHint(T("先选择要操作的项"));
            return;
          }
          const container = flag === "favorite" ? FIXED.favorites : FIXED.todos;
          const what = flag === "favorite" ? T("收藏") : T("待办");
          // The whole set goes one way: remove only when every row is already
          // in, otherwise add what is missing. Mixed sets never flip halfway.
          const already = targets.every((id) => Boolean(flagMemberIn(container, id)));
          if (blockedByBinding(targets)) return;
          mutate(async () => {
            for (const id of targets) {
              const membership = flagMemberIn(container, id);
              if (!already) {
                if (membership) continue;
                const target = bulkTargetOf(id);
                if (!target) continue;
                if (target.sessionId) {
                  await apiSend("POST", "/shortcuts", { parent: container, kind: "session", targetId: target.sessionId });
                  continue;
                }
                await apiSend("POST", "/shortcuts", { parent: container, kind: target.kind, targetId: target.targetId });
              } else if (membership) {
                await apiSend("DELETE", `/shortcuts/${encodeURIComponent(membership)}`);
              }
            }
          }, already ? T("已移出{0}", [what]) : T("已加入{0}", [what]));
        },
        [blockedByBinding, bulkTargetOf, flagMemberIn, mutate, targets],
      );
      const setNote = useCallback(
        (id, note) => {
          if (!id) return;
          mutate(() => apiSend("PATCH", `/annotations/${encodeURIComponent(id)}`, { note }));
        },
        [mutate],
      );

      const addTag = useCallback(
        (id, tag) => {
          const session = sessionsById.get(id);
          if (!session) return;
          const tags = [...(session.tags ?? []), tag];
          mutate(() => apiSend("PATCH", `/annotations/${encodeURIComponent(id)}`, { tags }));
        },
        [mutate, sessionsById],
      );

      const removeTag = useCallback(
        (id, tag) => {
          const session = sessionsById.get(id);
          if (!session) return;
          const tags = (session.tags ?? []).filter((entry) => entry !== tag);
          mutate(() => apiSend("PATCH", `/annotations/${encodeURIComponent(id)}`, { tags }));
        },
        [mutate, sessionsById],
      );

      // The tag library is a vocabulary, not a constraint: adding a tag to the
      // library does not tag anything, and dropping one leaves every session
      // that already carries it alone (src/domain/annotations.js).
      const newTag = useCallback(
        (id, tag) => {
          const session = sessionsById.get(id);
          if (!session || !tag) return;
          const tags = session.tags ?? [];
          mutate(async () => {
            await apiSend("POST", "/tags", { tag });
            if (!tags.includes(tag)) {
              await apiSend("PATCH", `/annotations/${encodeURIComponent(id)}`, { tags: [...tags, tag] });
            }
          }, T("已把「{0}」加入标签库", [tag]));
        },
        [mutate, sessionsById],
      );

      const dropTag = useCallback(
        (tag) => {
          if (!tag) return;
          mutate(() => apiSend("DELETE", `/tags/${encodeURIComponent(tag)}`), T("已从标签库移除「{0}」", [tag]));
        },
        [mutate],
      );

      // Dropping a container is its own transaction (13g-hook-drag-and-drop.js).
      const { moveNodeTo, moveNodesTo, canDropHere, moveNodeHere } = useDragAndDrop({ mutate, tree, setHint });

