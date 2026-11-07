    // ── Panel hook: the inline rename editor ───────────────────────────────
    // Selecting a row is enough to rename it: the name turns into an input in
    // place, so the list never loses its context the way a dialog would. The
    // draft and the three entry points live here because they are one piece of
    // state; who may be renamed is a rule, not a UI detail.

    /**
     * The panel's rename draft and its entry points.
     *
     * Named `useRenameEditor` rather than `useDialogs`: 13-dialogs.js already
     * owns that name in this factory scope for DSH's own dialog channel.
     */
    function useRenameEditor({ mutate, tree, sessionsById, setHint, blockedByBinding }) {
      // The row being renamed: { kind, id, value, original }. One at a time —
      // two open editors would race on the same list.
      const [renaming, setRenaming] = useState(null);
      // One rename entry point for all three surfaces (detail title row, list
      // row, tree row). `kind` says which store owns the name — a session and a
      // workspace are DSH's own (native calls, nothing stored here), a folder is
      // the plugin's own node.
      const renameEntity = useCallback(
        (kind, id, value) => {
          if (!id || !value) return;
          if (kind === "session") {
            mutate(
              () => apiSend("POST", `/sessions/${encodeURIComponent(id)}/rename`, { title: value }),
              T("会话已重命名为「{0}」", [value]),
            );
            return;
          }
          if (kind === "workspace") {
            mutate(
              () => apiSend("POST", `/workspaces/${encodeURIComponent(id)}/rename`, { title: value }),
              T("工作区已重命名为「{0}」", [value]),
            );
            return;
          }
          mutate(() => apiSend("PATCH", `/folders/${encodeURIComponent(id)}`, { name: value }), T("已重命名"));
        },
        [mutate],
      );

      // ── inline rename ───────────────────────────────────────────
      // Selecting a row is enough to rename it: the name turns into an input in
      // place, so the list never loses its context the way a dialog would.
      // A workspace is addressed by its native workspaceId, a folder by its own
      // node id — the two id spaces never mix.
      const nodeOfEntity = useCallback(
        (kind, id) => {
          if (kind === "folder") return tree?.nodes?.[id] ?? null;
          if (kind === "workspace") {
            return Object.values(tree?.nodes ?? {}).find((node) => node.workspaceId === id) ?? null;
          }
          return null;
        },
        [tree],
      );

      /**
       * Translate whatever the caller has into the id the owning store expects.
       *
       * The list row hands over a *tree node id* for a workspace (`w-<uuid>`),
       * but DSH's rename takes its own id. Normalising here — not at every call
       * site — is what keeps "重命名工作区没反应" from happening: a request sent
       * with `w-…` gets workspace/not-found from the host.
       */
      const resolveRenameTarget = useCallback(
        (kind, id) => {
          if (kind === "folder") return id;
          if (kind !== "workspace") return id;
          const node = tree?.nodes?.[id] ?? null;
          if (node?.workspaceId) return node.workspaceId;
          // Already a native id (the context menu and the detail pane pass one).
          return id.startsWith("w-") ? id.slice(2) : id;
        },
        [tree],
      );

      const beginRename = useCallback(
        (kind, id, surface) => {
          if (!id) return;
          id = resolveRenameTarget(kind, id);
          let initial = "";
          if (kind === "session") {
            const session = sessionsById.get(id);
            // A trashed session has no log for DSH to append a title event to;
            // renaming it would fail at the host. Say so instead of opening an
            // editor that cannot commit.
            if (session?.trashed) {
              setHint(T("回收站里的会话不能重命名，先还原它"));
              return;
            }
            // A delegation has no title of its own: DSH appends the title event
            // to the parent's log, and the parent is what the user names.
            if (blockedByBinding([id])) return;
            // The displayed name, not the raw title: an untitled session shows
            // its cwd folder name, and the user should edit what they see.
            initial = session?.displayTitle ?? session?.title ?? "";
          } else {
            const node = nodeOfEntity(kind, id);
            initial = node?.name ?? "";
          }
          // Where the editor should appear. A folder or workspace is drawn in
          // both panes, so "all surfaces" would mount two editors, and the one
          // that mounts second steals focus from the first — blur means commit,
          // so the field vanished before a key could be typed (m0xxxx). The
          // surface that started the rename is the only one that draws it.
          const home = surface ?? (kind === "session" ? "list" : "tree");
          setRenaming({ kind, id, value: initial, original: initial, surface: home });
        },
        [blockedByBinding, nodeOfEntity, resolveRenameTarget, sessionsById],
      );

      const cancelRename = useCallback(() => setRenaming(null), []);

      // A context-menu item is activated by mouse, and the browser hands focus
      // back to the row the moment the menu unmounts. Mounting the inline
      // editor inside that click makes it blur instantly, and blur means
      // "commit" — the field would vanish before a single key could be typed.
      // So the menu defers the mount to after the click finishes; F2 and the
      // detail pane have no pointer event and call beginRename directly.
      const beginRenameAfterClick = useCallback(
        (kind, id, surface) => {
          window.setTimeout(() => beginRename(kind, id, surface), 0);
        },
        [beginRename],
      );

      const commitRename = useCallback(() => {
        const draft = renaming;
        setRenaming(null);
        if (!draft) return;
        const value = String(draft.value ?? "").trim();
        // An unchanged or emptied name is a cancel, not a write: a blank title
        // would make the session fall back to its cwd and look like a bug.
        if (!value || value === draft.original) return;
        renameEntity(draft.kind, draft.id, value);
      }, [renaming, renameEntity]);

      const renameProps = useMemo(
        () =>
          renaming
            ? {
                kind: renaming.kind,
                id: renaming.id,
                surface: renaming.surface,
                value: renaming.value,
                onChange: (next) => setRenaming((previous) => (previous ? { ...previous, value: next } : previous)),
                onCommit: commitRename,
                onCancel: cancelRename,
              }
            : null,
        [cancelRename, commitRename, renaming],
      );
      // `renameEntity` travels out too: the list and tree rows take it as
      // `onRename`, so the panel needs the same function this hook commits with.
      return { renaming, beginRename, beginRenameAfterClick, cancelRename, commitRename, renameProps, renameEntity };
    }
