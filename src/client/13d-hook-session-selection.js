    // ── Panel hook: picking rows ───────────────────────────────────────────
    // Selection is a gesture, not a state: the panel owns `selected` and
    // `checked`, this hook owns what each gesture does to them. The rules that
    // matter — a plain click picks one row, a modifier or a checkbox adds to
    // that set, the header box means "the rows on screen", a right-click never
    // collapses a multi-selection — are the four callbacks below.

    /**
     * Row gestures: click, right-click highlight, checkbox, marquee.
     *
     * The two setters come in from Panel because the same state is read by the
     * toolbar and by every multi-row command, so it cannot move in here.
     */
    function useSessionSelection({ setSelected, setChecked, filteredInScope, checked, selected }) {
      /**
       * Pick one row — the row under the pointer, and only that one.
       *
       * A plain click is a single selection: the check-set becomes this row,
       * whatever it held before. A box that stayed ticked on five other rows
       * made the click look as if it had done nothing, and the set is what
       * every multi-row command reads. Adding is the modifier's job (Ctrl/⌘
       * toggles one row in or out) and the checkbox is the third way into the
       * same set.
       *
       * A container is picked exactly like a session: a folder and a workspace
       * are things you move, cut and delete, not only places you stand in, and
       * the row draws the same checkbox for them.
       *
       * The one exception is a right-click (`preserve`): it must never
       * collapse a multi-selection, because the menu it opens acts on all of
       * it — the items are built from the set as it stood when the press
       * arrived.
       */
      const selectRow = useCallback((id, event) => {
        const modifier = Boolean(event && (event.ctrlKey || event.metaKey));
        setSelected(id);
        setChecked((previous) => {
          if (modifier) {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          }
          if (event?.preserve === true && previous.size > 1 && previous.has(id)) return previous;
          return previous.size === 1 && previous.has(id) ? previous : new Set([id]);
        });
      }, []);

      /**
       * Select a container without navigating into it.
       *
       * A tree row's click both selects and enters; a right-click must only
       * select, because entering clears the checked set and collapses a
       * multi-selection onto the row under the pointer.
       */
      const highlightNode = useCallback((id) => {
        if (!id) return;
        setSelected(id);
        setChecked((previous) => (previous.size > 1 && previous.has(id) ? previous : new Set()));
      }, []);

      /**
       * Check one row, or the whole view.
       *
       * The second argument only matters for the "all" pseudo-id: a click on the
       * header box toggles (pressing it twice undoes itself), while Ctrl+A asks
       * for "all" and has to be idempotent — a shortcut that emptied the list on
       * its second press would read like a bug, not like an undo.
       *
       * The third argument is the id list "all" stands for. It comes from the
       * pane, which is the only place that knows what it actually drew: sessions
       * plus the folders, workspaces and references that carry a box. This hook
       * can only see sessions, and a 全选 that quietly skipped every folder left
       * the user ticking them one by one afterwards.
       */
      const checkRow = useCallback((id, mode = "toggle", ids = null) => {
        setChecked((previous) => {
          if (id === null) return new Set();
          if (id === "all") {
            // The header box means "all of the rows this view lists", not "if
            // anything is checked, uncheck everything" — that never lets a click
            // complete a partial selection. The set it fills comes from the rows
            // on screen, not from the scope.
            const visible = ids ?? filteredInScope.map((session) => session.id);
            if (mode === "on") return new Set(visible);
            const everything = visible.length > 0 && visible.every((each) => previous.has(each));
            return everything ? new Set() : new Set(visible);
          }
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }, [filteredInScope]);

      /**
       * 框选: a press on the blank part of the list, and the box it
       * drags. The check set is what multi-row commands act on, so the box
       * writes there — one id per row it touches, live, while the pointer moves.
       *
       * A press that never moved is a click on nothing, and that clears what was
       * selected rather than leaving a stale set behind.
       */
      const marqueeStart = useCallback((event, pane, rect) => {
        marqueeDrag({
          event,
          pane,
          rect,
          checked,
          // 拖动要先选中: the rows only drag when they are picked, so a
          // press on one of those is that drag. Every other row — an unpicked
          // one — is surface, and drags a box over itself.
          canDragRow: (id) => rowDraggable({ selected: id === selected, checked: checked.has(id) }),
          onPick: (ids) => {
            if (ids === null) {
              setChecked(new Set());
              setSelected(null);
              return;
            }
            setChecked(new Set(ids));
          },
        });
      }, [checked, selected]);
      return { selectRow, highlightNode, checkRow, marqueeStart };
    }
