    // ── Panel hook: picking rows ───────────────────────────────────────────
    // Selection is a gesture, not a state: the panel owns `selected` and
    // `checked`, this hook owns what each gesture does to them. The rules that
    // matter — never collapse a multi-selection by accident, a container click
    // leaves the check-set alone, the header box means "the rows on screen" —
    // are the four callbacks below.

    /**
     * Row gestures: click, right-click highlight, checkbox, marquee.
     *
     * The two setters come in from Panel because the same state is read by the
     * toolbar and by every multi-row command, so it cannot move in here.
     */
    function useSessionSelection({ setSelected, setChecked, tree, filteredInScope, checked, selected }) {
      /**
       * Select one row.
       *
       * The rule that matters here is "never collapse a multi-selection by
       * accident": a plain click on a checked row keeps the check-set, and a
       * right-click on a checked row keeps it too (the caller passes
       * `{ preserve: true }`). Only a click on an unchecked row starts a new
       * single selection — which is what makes 拖动 with a multi-selection move
       * everything, instead of dropping to the one row under the pointer.
       */
      const selectRow = useCallback((id, event) => {
        const preserve = event?.preserve === true || Boolean(event && (event.ctrlKey || event.metaKey));
        setSelected(id);
        // A container row is not a session: clicking it selects the container
        // (so the detail pane describes it) without touching the session
        // check-set. Checking is the checkbox's own gesture.
        if (tree?.nodes?.[id]) {
          // A container row keeps a multi-selection it belongs to: right-
          // clicking one of several checked folders must act on all of them,
          // and clearing here would silently shrink the set to one row.
          setChecked((previous) => (previous.size > 1 && previous.has(id) ? previous : new Set()));
          return;
        }
        setChecked((previous) => {
          if (previous.has(id)) {
            // Already part of the selection: keep the whole set. A modifier
            // still toggles this one row off, which is the Explorer contract.
            if (event && (event.ctrlKey || event.metaKey)) {
              const next = new Set(previous);
              next.delete(id);
              return next;
            }
            return previous;
          }
          if (preserve && previous.size > 1) {
            const next = new Set(previous);
            next.add(id);
            return next;
          }
          return new Set([id]);
        });
      }, [tree]);

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

      const checkRow = useCallback((id) => {
        setChecked((previous) => {
          if (id === null) return new Set();
          if (id === "all") {
            // The header box means "all of the rows this view lists", not "if
            // anything is checked, uncheck everything" — that never lets a click
            // complete a partial selection. The set it fills comes from the rows
            // on screen, not from the scope.
            const visible = filteredInScope.map((session) => session.id);
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
