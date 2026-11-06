    // ── Panel hook: the tree's rows ────────────────────────────────────────
    // Which sessions the current node shows is one switch over data the host
    // ships: the node's mode, each session's home, the flag predicates and the
    // 过滤空会话 switch. The panel draws them; this hook decides them.

    /**
     * The rows of the current scope, and the session lookups derived from them.
     *
     * Everything here is a projection of `allSessions` + `tree`: no hook in this
     * file writes. `sessionsById` / `parent` / `currentChildren` travel with the
     * rows because the detail pane reads them for the same selected session.
     */
    function useTreeView({ allSessions, data, tree, scope, selected, listSettings, query, searchScopes, filter }) {
      // What the selected node shows. The host ships the mode (`node.scope`) and
      // each session's home container (`session.home`), so this is one switch
      // over data — the client keeps no copy of "a folder shows its subtree".
      /**
       * The live sessions this panel lists, after 过滤空会话.
       *
       * A session that never started a turn holds nothing to read — it is what
       * closing the window before typing leaves behind — so it is hidden by
       * default. Two exceptions keep the filter honest: 回收站 is never filtered
       * (a bin that hides its contents cannot be emptied), and the session the
       * user is standing on stays visible even when it is blank, so turning the
       * switch on can never make the current row vanish from under them.
       */
      const liveSessions = useMemo(() => {
        const live = allSessions.filter((session) => !session.trashed);
        if (!listSettings.hideBlank) return live;
        return live.filter((session) => session.blank !== true || session.id === selected);
      }, [allSessions, listSettings.hideBlank, selected]);

      const sessionsInScope = useMemo(() => {
        if (!data) return [];
        const nodes = tree?.nodes ?? {};
        // Standing *in* a shortcut to a session: the row has no children and its
        // scope is "none", so the list would come out empty even though the
        // reference is perfectly alive. A reference to a session shows exactly
        // that session — the same one row its container lists.
        const self = nodes[scope];
        if (self?.kind === "shortcut" && self.shortcutKind === "session") {
          const target = allSessions.find((session) => session.id === self.targetId) ?? null;
          return target ? [target] : [];
        }
        const mode = nodes[scope]?.scope ?? "none";
        if (mode === "trash") return allSessions.filter((session) => session.trashed);
        // Everything outside the bin sees live sessions only: a trashed session
        // keeps its flags in the annotations sidecar, but it must not reappear
        // under 收藏 or 根目录 while its payload sits in the bin.
        const live = liveSessions;
        if (mode === "all") return live;
        // 收藏 / 待办 list the sessions that carry the flag; a reference row to a
        // session shows up as that session, which is why the badge counts both.
        if (mode === "favorites") return live.filter((session) => session.favorite);
        if (mode === "todos") return live.filter((session) => session.todo);
        // 根目录 lists directories, not sessions: the flat list is 所有会话.
        if (mode !== "tree") return [];
        // A container lists the sessions that live *in* it, never the ones that
        // live below it. Flattening the subtree put a nested workspace's
        // sessions on the same level as the workspace row itself, so a folder
        // read as if it owned them. A session shows where it
        // actually is — its own workspace's page — and a reference row still
        // shows what it points at, which is what a reference is for.
        const holder = self?.kind === "shortcut" ? self.ref ?? scope : scope;
        return live.filter((session) => session.home === holder);
      }, [allSessions, data, scope, tree, liveSessions]);

      // ── filter ───────────────────────────────────────────────────────────
      // What the list may draw: the container's own rows, or — once a needle is
      // in the box — the whole library (see searchBaseSessions).
      const scopeBase = useMemo(
        () =>
          searchBaseSessions({
            needle: query.trim(),
            place: searchScopes.place,
            scope,
            trashScope: FIXED.trash,
            own: sessionsInScope,
            library: liveSessions,
          }),
        [liveSessions, query, scope, sessionsInScope, searchScopes.place],
      );

      // The prototype's 筛选 dialog: a set of predicates applied on top of the
      // scope. It is a view, never a write: clearing it restores exactly the
      // scope's own listing. 回收站 ignores it, because a bin that hides its
      // contents is a bin you cannot empty.
      const filteredInScope = useMemo(() => {
        // 回收站 ignores the filter: a bin that hides its contents is a bin you
        // cannot empty. 全局 scope applies the predicates to the whole library
        // instead of the current container, which is what "find every 收藏"
        // means when you are standing three folders deep.
        if (scope === FIXED.trash) return sessionsInScope;
        const base = filter.scope === "all" ? liveSessions : scopeBase;
        return base.filter((session) => {
          if (filter.favorite !== "all" && session.favorite !== (filter.favorite === "yes")) return false;
          if (filter.archived !== "all" && session.archived !== (filter.archived === "yes")) return false;
          if (filter.todo !== "all" && session.todo !== (filter.todo === "yes")) return false;
          if (filter.tags.length > 0) {
            const tags = new Set(session.tags ?? []);
            // Every selected tag must be present: tags intersect, they do not
            // union, or picking two would widen the result instead of narrowing.
            if (!filter.tags.every((tag) => tags.has(tag))) return false;
          }
          return true;
        });
      }, [allSessions, filter, scope, scopeBase, liveSessions]);

      const current = useMemo(() => allSessions.find((session) => session.id === selected) ?? null, [allSessions, selected]);

      /**
       * The container the detail pane describes when no session is selected.
       *
       * It follows the *selection* first and the scope second. Reading only the
       * scope was a real bug: selecting a workspace row in the list left the
       * scope on 根目录, so the detail pane showed the root — a folder — and a
       * workspace was reported as 文件夹.
       */
      const focusNode = useMemo(() => {
        if (current) return null;
        const picked = selected ? tree?.nodes?.[selected] ?? null : null;
        return picked ?? tree?.nodes?.[scope] ?? null;
      }, [current, scope, selected, tree]);

      // Subagent relations, both directions: the detail pane shows where a child
      // came from and how many children a parent has. Forks are deliberately
      // excluded — a fork is an independent session, not a child.
      const sessionsById = useMemo(() => new Map(allSessions.map((session) => [session.id, session])), [allSessions]);
      const parent = useMemo(
        () => (current?.isSubagent && current.parentSession ? sessionsById.get(current.parentSession) ?? null : null),
        [current, sessionsById],
      );
      const currentChildren = useMemo(
        () => (current ? allSessions.filter((session) => session.isSubagent && session.parentSession === current.id) : []),
        [allSessions, current],
      );
      return {
        liveSessions,
        sessionsInScope,
        scopeBase,
        filteredInScope,
        current,
        focusNode,
        sessionsById,
        parent,
        currentChildren,
      };
    }
