    // ── List pane ──────────────────────────────────────────────────────────

    /**
     * A node the list draws as a container row: a workspace, the user's own
     * folder, or a reference. Fixed views are navigation, not rows.
     *
     * @param {any} node
     * @returns {boolean}
     */
    function isListContainer(node) {
      return (
        Boolean(node) &&
        (node.type === "workspace" ||
          node.kind === "shortcut" ||
          (node.type === "folder" && node.kind === "folder" && !node.fixed))
      );
    }

    /**
     * Which sessions a search may answer with: the whole library.
     *
     * The first cut widened the scope to the subtree of the container you stood
     * in, which still answers "not in this folder" about a session that plainly
     * exists two branches away — and 收藏 answered only with favorited sessions
     * even when the title typed into the box was found elsewhere. A search box
     * asks "where is this?", never "what is at this level", so it looks at
     * everything unless the needle is empty (then the container lists its own
     * rows again).
     *
     * 回收站 keeps its own rows: the bin is a place you are looking *at*, and a
     * search that jumps back out of it makes 清空 impossible to aim at a subset.
     *
     * @param {object} input
     * @param {string} input.needle lowercased search text, "" for none
     * @param {string} [input.place] "all" (default) or "here"
     * @param {string} input.scope id of the container the user stands in
     * @param {string} input.trashScope id of 回收站
     * @param {object[]} input.own the rows that container lists by itself
     * @param {object[]} input.library every live session
     * @returns {object[]}
     */
    function searchBaseSessions({ needle, place, scope, trashScope, own, library }) {
      if (!needle) return own;
      // 当前目录: the user asked the box to stay where they are. It
      // outranks everything below — including 回收站, which this only ever
      // repeats, since the bin already answers with its own rows.
      if (place === "here") return own;
      if (scope === trashScope) return own;
      return library;
    }

    /**
     * The container rows a list shows, given what it is currently answering.
     *
     * Three questions shape the answer, and they are one function because they
     * are one rule: *which* containers are candidates (a container's children, or
     * — when the list is a result view rather than a place — the whole tree),
     * which of them match the search box, and which hold at least one of the
     * sessions the list is about to draw.
     *
     * A filter asks about sessions, so a folder answers it by *containing* a
     * match: testing its name would answer a question nobody asked, and a folder
     * whose matching sessions are all gone has nothing left to show inside it.
     * Search widens to the whole tree because a search box that cannot find a
     * folder three levels down is a search box that lies; 范围=全部 widens the
     * filter for the same reason — it is a question about the library, not about
     * the place the user happens to stand in.
     *
     * @param {object} input
     * @param {object | null | undefined} input.tree
     * @param {string} input.scope id of the node the user stands in
     * @param {string} input.needle lowercased search text, "" for none
     * @param {boolean} input.filterActive whether any 筛选 predicate is set
     * @param {boolean} input.filterAll 范围=全部
     * @param {object[]} input.sessions the rows the list is about to draw
     * @param {boolean} [input.matchNames] false when 搜索范围 leaves 会话名 out
     * @param {boolean} [input.local] true when 搜索位置 is 当前目录
     * @returns {object[]}
     */
    function listContainers({ tree, scope, needle, filterActive, filterAll, sessions, matchNames = true, local = false }) {
      // The bin lists sessions only: there is no container to navigate out of.
      if (scope === FIXED.trash) return [];
      const nodes = tree?.nodes ?? {};
      const childMap = tree?.children ?? {};
      // 当前目录 keeps the candidates local even while a needle is set: a
      // search that promises to stay here and then lists a folder from three
      // levels down has broken its promise, and 范围=全部 still widens the filter
      // because that is a different question with its own switch.
      const wide = !local && (Boolean(needle) || (filterActive && filterAll));
      const candidates = wide
        ? Object.values(nodes)
        : (childMap[scope] ?? []).map((id) => nodes[id]);
      // `session.home` is resolved host-side (R2), so this is a membership test
      // against the subtree, not a second pass over the placement rules.
      const homes = new Set();
      for (const session of sessions) if (session.home) homes.add(session.home);
      const holdsRow = (node) => {
        if (homes.size === 0) return false;
        const within = subtreeIds(node.id, nodes, childMap);
        for (const home of homes) if (within.has(home)) return true;
        return false;
      };
      return candidates.filter(isListContainer).filter((node) => {
        if (needle && matchNames) {
          const haystack = `${node.name ?? ""}\n${node.path ?? ""}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        // A search that leaves 会话名 out has no name to test: the folder still
        // earns its row when it holds one of the rows, which is how it answers a
        // filter. Without this, 仅搜会话内容 would drop the folder that holds the
        // very session the search found.
        if (needle && !matchNames) return holdsRow(node);
        if (!filterActive) return true;
        if (homes.size === 0) return false;
        const within = subtreeIds(node.id, nodes, childMap);
        for (const home of homes) if (within.has(home)) return true;
        return false;
      });
    }

    /**
     * 所有会话, cut into one band per workspace.
     *
     * 所有会话 is the whole library at once, and the library is not one place:
     * DSH files every session under a workspace, so a single flat band of rows
     * made the user read the workspace out of each row's subtitle. The band
     * caption *is* the workspace name — the same string the tree draws for the
     * same node — so the two surfaces answer "where does this live" the same way.
     *
     * Standing inside a workspace or a folder is left alone: there the list
     * already answers "what is in here", and a caption per workspace would be
     * one word repeated down the pane. A search or a filter is left alone too:
     * that list answers a question about rows, not about places.
     *
     * Order follows the tree's own workspace order, so the bands appear in the
     * sequence 目录 shows them; a workspace the tree does not know about (a node
     * that is gone, a registry that has not caught up) sorts after those it
     * knows, by name. 未分组 sinks to the bottom: it is the leftover, not a place.
     *
     * @param {object[]} sessions the rows the list is about to draw
     * @param {object | null | undefined} tree
     * @returns {Array<{ key: string, title: string, icon: string, count: number, sessions: object[] }>}
     */
    function workspaceBands(sessions, tree) {
      /** @type {Map<string, object[]>} sessionId → rows, keyed by workspaceId ("" for none) */
      const buckets = new Map();
      for (const session of sessions) {
        const id = session.workspaceId ?? "";
        const bucket = buckets.get(id);
        if (bucket) bucket.push(session);
        else buckets.set(id, [session]);
      }
      // The tree's own order, walked the way 目录 walks it: a workspace can sit
      // inside a user folder (drag one there and it moves), so reading only
      // 根目录's children would order those by name instead of by placement.
      /** @type {Map<string, number>} native workspaceId → position */
      const order = new Map();
      const walk = (id) => {
        const node = tree?.nodes?.[id];
        if (!node) return;
        if (node.type === "workspace") {
          const native = node.workspaceId ?? node.id;
          if (!order.has(native)) order.set(native, order.size);
          // A workspace's children are sessions: nothing below it is a band.
          return;
        }
        for (const child of tree?.children?.[id] ?? []) walk(child);
      };
      for (const id of tree?.children?.[FIXED.root] ?? []) walk(id);
      const UNKNOWN = Number.MAX_SAFE_INTEGER;
      const bands = [...buckets].map(([id, rows]) => ({
        key: id,
        // A session with no workspace is in 未分组, and so is a workspace node the
        // tree has already dropped: both are "nowhere", which is one word here.
        title: id ? rows[0]?.workspaceTitle ?? id : T("未分组"),
        icon: id ? "monitor" : "chat",
        count: rows.length,
        sessions: rows,
      }));
      bands.sort((a, b) => {
        const rank = (band) => (band.key === "" ? UNKNOWN : order.get(band.key) ?? UNKNOWN - 1);
        const delta = rank(a) - rank(b);
        // Array#sort is stable, so the rows keep the sort the toolbar asked for;
        // the name only breaks ties between workspaces the tree cannot order.
        return delta !== 0 ? delta : a.title.localeCompare(b.title);
      });
      return bands;
    }

    /**
     * 框选: the list could only be multi-selected one checkbox at a
     * time. A box drag is the gesture every file manager has, and the blank
     * space in the list is where it starts — pressing there and never moving is
     * "a click on nothing", which clears the selection.
     *
     * Two pure functions so the geometry can be tested without a DOM, and one
     * that only touches the elements it is handed.
     */

    /** Normalise two corners into a rectangle: dragging up-left is still a box. */
    function marqueeRect(x0, y0, x1, y1) {
      return {
        left: Math.min(x0, x1),
        top: Math.min(y0, y1),
        right: Math.max(x0, x1),
        bottom: Math.max(y0, y1),
      };
    }

    /**
     * The rows a box touches, in the order they were handed in.
     *
     * "Touches" is any overlap, not full containment: a box dragged from the
     * first row to the third has to take all three, and demanding containment
     * would drop the rows it only clipped. A zero-area rectangle (a click)
     * touches nothing, which is what keeps a click from selecting whatever row
     * its corner happened to land on.
     *
     * @param {{ left: number, top: number, right: number, bottom: number }} rect
     * @param {Array<{ id: string, left: number, top: number, right: number, bottom: number }>} boxes
     * @returns {string[]}
     */
    function marqueeIds(rect, boxes) {
      // A rectangle with no area is a click, not a box. It is answered here
      // rather than by the caller so "a click selects nothing" holds for any
      // geometry a drag could hand over.
      if (rect.right <= rect.left || rect.bottom <= rect.top) return [];
      const picked = [];
      for (const box of boxes) {
        if (box.right <= rect.left || box.left >= rect.right) continue;
        if (box.bottom <= rect.top || box.top >= rect.bottom) continue;
        picked.push(box.id);
      }
      return picked;
    }

    /**
     * Run one box drag.
     *
     * @param {{
     *   event: any,
     *   pane: any,
     *   rect: any,
     *   checked?: Set<string>,
     *   canDragRow?: (id: string) => boolean,
     *   onPick: (ids: string[] | null) => void,
     * }} options
     *   `pane` is the list the box lives in, `rect` the element it paints into,
     *   and `onPick` receives the ids under the box — or null for a press that
     *   never became one. `canDragRow` answers "would a press on this row start
     *   a drag?" — the same question the rows ask before they set `draggable`.
     * @returns {() => void} stops the drag, for callers that unmount mid-gesture.
     */
    function marqueeDrag({ event, pane, rect, checked, canDragRow, onPick }) {
      const stop = () => {};
      // A press on a checkbox, a button or a resize strip belongs to that
      // control: a box never starts there.
      if (event?.target?.closest?.("button, input, textarea, .chk, .colrsz, .twist, a, label")) return stop;
      // 拖动要先选中: a row that would drag keeps the gesture for
      // itself — the browser is already starting its native drag, and a box on
      // top of it would fight for the pointer. A row that would not drag is just
      // a surface, so the press starts a box. When the caller offers no
      // predicate, no row can drag and every row counts as surface.
      const pressed = event?.target?.closest?.(".row[data-id]");
      const pressedId = pressed
        ? String(pressed.dataset?.id ?? pressed.getAttribute?.("data-id") ?? "")
        : "";
      if (pressedId && canDragRow?.(pressedId)) return stop;
      // Only the primary button draws a box: the secondary one belongs to the
      // context menu, and its mouseup must not be read as "a click on blank".
      if (event?.button !== undefined && event.button !== 0) return stop;
      if (!pane || !rect || typeof onPick !== "function") return stop;
      event.preventDefault?.();
      // The pane's rectangle is read again on *every* frame (see `paneBoxOf`
      // below): a gesture outlives the layout it started in. The wheel scrolls
      // the rows out from under the box, the edge scroll moves them, and the
      // pane itself can be resized or pushed by an ancestor. A box built from
      // the press-time rectangle would then draw — and hit-test — offset from
      // the pointer by exactly that movement.
      const paneBoxOf = () => pane.getBoundingClientRect();
      const body = pane.querySelector?.(".listbody") ?? pane;
      // Where the list stood when the box started; see the anchor in paint().
      const startScroll = { top: body.scrollTop ?? 0, left: body.scrollLeft ?? 0 };
      const schedule = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (fn) => setTimeout(() => fn(0), 16);
      const unschedule = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
      // Ctrl / ⌘ adds the box to what was already checked, like every other
      // modifying gesture in the panel; a plain drag replaces the set.
      const base = checked && (event.ctrlKey || event.metaKey) ? new Set(checked) : null;
      const startX = event.clientX;
      const startY = event.clientY;
      // Past the edge the list follows the pointer, so a box can reach rows that
      // are scrolled out of sight without letting go of the mouse.
      const edge = 24;
      let x = startX;
      let y = startY;
      let moved = false;
      let dirty = true;
      let frame = 0;
      let lastKey = "";

      // Rows move under a box that is not moving: the wheel, the scrollbar and
      // the edge scroll all change what the box covers without a single
      // mousemove, so the gesture repaints on scroll instead of waiting for the
      // pointer to move again.
      const onScroll = () => {
        dirty = true;
      };
      body.addEventListener?.("scroll", onScroll, { passive: true });

      const paint = () => {
        const paneBox = paneBoxOf();
        // The anchor belongs to the *content*, not to the screen. The
        // wheel, the scrollbar and the edge scroll all slide the rows under a
        // pointer that never moved; a start point left at its screen position
        // would then drag the whole selection down with the scroll instead of
        // holding the row it started on. Undoing the scroll delta puts the press
        // back onto that row, so what the box gains by scrolling is the rows that
        // scrolled up under it.
        const anchorX = startX - paneBox.left + (startScroll.left - (body.scrollLeft ?? 0));
        const anchorY = startY - paneBox.top + (startScroll.top - (body.scrollTop ?? 0));
        const box = marqueeRect(anchorX, anchorY, x - paneBox.left, y - paneBox.top);
        rect.style.display = moved ? "block" : "none";
        if (!moved) return;
        rect.style.left = box.left + "px";
        rect.style.top = box.top + "px";
        rect.style.width = Math.max(0, box.right - box.left) + "px";
        rect.style.height = Math.max(0, box.bottom - box.top) + "px";
        const boxes = [];
        for (const element of pane.querySelectorAll?.(".row[data-id]") ?? []) {
          // Only rows that own a checkbox can join the set: a subagent row and a
          // 特殊文件夹 draw no box, and a checked id that nothing can act on
          // would only inflate 已选 N 项.
          if (!element.querySelector?.(".chk")) continue;
          const rowBox = element.getBoundingClientRect();
          boxes.push({
            id: String(element.dataset?.id ?? element.getAttribute?.("data-id") ?? ""),
            left: rowBox.left - paneBox.left,
            top: rowBox.top - paneBox.top,
            right: rowBox.right - paneBox.left,
            bottom: rowBox.bottom - paneBox.top,
          });
        }
        const hits = marqueeIds(box, boxes);
        const next = base ? [...new Set([...base, ...hits])] : hits;
        const key = next.join("\u0000");
        // The pointer moves every frame; the answer only changes when the box
        // crosses a row edge. Comparing the set keeps React out of the other
        // 59 frames.
        if (key === lastKey) return;
        lastKey = key;
        onPick(next);
      };

      const tick = () => {
        frame = schedule(tick);
        const view = body.getBoundingClientRect?.();
        if (view && moved) {
          const overshoot = y < view.top + edge
            ? y - (view.top + edge)
            : y > view.bottom - edge
              ? y - (view.bottom - edge)
              : 0;
          if (overshoot) {
            const before = body.scrollTop ?? 0;
            body.scrollTop = before + (overshoot < 0 ? Math.max(overshoot, -28) : Math.min(overshoot, 28));
            if (body.scrollTop !== before) dirty = true;
          }
        }
        if (!dirty) return;
        dirty = false;
        paint();
      };

      const move = (moveEvent) => {
        x = moveEvent.clientX;
        y = moveEvent.clientY;
        if (!moved && Math.abs(x - startX) + Math.abs(y - startY) > 3) moved = true;
        dirty = true;
      };

      const teardown = () => {
        if (frame) unschedule(frame);
        frame = 0;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", finish);
        body.removeEventListener?.("scroll", onScroll);
        pane.removeAttribute?.("data-marquee");
        rect.style.display = "none";
      };
      const finish = () => {
        teardown();
        // A press that never moved selected nothing: it is a click on the blank
        // part of the list, and that clears the selection.
        if (!moved) onPick(null);
      };

      pane.setAttribute?.("data-marquee", "1");
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", finish);
      frame = schedule(tick);
      // Handing back the teardown rather than the mouseup handler keeps the two
      // meanings apart: stopping a gesture early must not look like a click.
      return teardown;
    }

    /**
     * The search box.
     *
     * Calling the panel's `setQuery` on every keystroke re-renders all of it and
     * re-runs the filter (four passes over the list) before the next key arrives —
     * the panel owns the tree, every row and the detail pane. The box therefore
     * holds its own draft, so the text never lags, and hands the needle to the
     * panel once typing pauses.
     */
    function SearchInput({ inputRef, value, placeholder, onCommit }) {
      const [draft, setDraft] = useState(value);
      const timer = useRef(0);
      // What the panel currently has. A value that differs came from outside the
      // box (Escape, 上一级, a new tab) and has to be adopted; a value that matches
      // is the echo of our own commit and must not interrupt typing.
      const committed = useRef(value);
      useEffect(() => {
        if (value === committed.current) return;
        committed.current = value;
        setDraft(value);
      }, [value]);
      useEffect(() => () => clearTimeout(timer.current), []);
      const commit = (next) => {
        clearTimeout(timer.current);
        timer.current = 0;
        if (next === committed.current) return;
        committed.current = next;
        onCommit(next);
      };
      return h("input", {
        ref: inputRef,
        value: draft,
        placeholder,
        onChange: (event) => {
          const next = event.target.value;
          setDraft(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => commit(next), 110);
        },
        onKeyDown: (event) => {
          // Enter is the user saying "I am done typing": filter now, not later.
          if (event.key === "Enter") {
            commit(event.target.value);
            return;
          }
          // Escape clears the box even while a commit is still pending. The
          // panel closes on Escape, but it ignores keys typed into a field, so
          // without this the first press after typing would do nothing at all.
          if (event.key === "Escape" && (draft !== "" || committed.current !== "")) {
            event.preventDefault();
            setDraft("");
            commit("");
          }
        },
      });
    }

    function ListPane(props) {
      const {
        sessions,
        sessionsById,
        tree,
        onRename,
        onOpenShortcut,
        scope,
        selected,
        onSelect,
        onCheck,
        onMarquee,
        checked,
        query,
        // 搜索范围: which fields the box reads, plus the 会话内容 hits
        // that came back from the host for the current needle.
        searchScopes = DEFAULT_SEARCH_SCOPES,
        contentHits,
        contentPending,
        sortKey,
        sortDir,
        onSort,
        showArchived,
        // The 筛选 dialog's state, already reduced to what this pane asks: is any
        // predicate set, and is it asking about the whole library (范围=全部)
        // rather than about the container the user stands in.
        filterActive,
        filterAll,
        now,
        view,
        onOpenWorkspace,
        colWidths,
        onResizeColumn,
        listRef,
        collapsed,
        onToggleChildren,
        // 分组折叠: which bands are folded, and the button that folds one.
        foldedBands = EMPTY_BANDS,
        onToggleBand,
        rename,
        onBeginRename,
        onRowContextMenu,
        onNodeContextMenu,
        clipboard,
        onDropSessions,
        // A session dropped on a folder *inside* a workspace is filed there
        // (a placement), not referenced: the row carries `accepts.session` and
        // this is the call that writes it.
        onPlaceSessions,
        onDropNode,
        onDropShortcut,
        onCanAcceptNode,
        onOpenSession,
        // 空白处 right-click: 刷新 / 粘贴 / 新建文件夹, i.e. the container's own
        // commands. The panel builds them; the pane only forwards the event.
        onBlankContextMenu,
        // One sentence per refused drop, written to the same status bar the
        // tree uses: a greyed row that cannot say why is only half an answer.
        onHint,
      } = props;

      // 分组折叠: every band caption is a button, so 所有会话 can be folded
      // down to its workspace names. The stored key carries the scope — the same
      // 会话 band exists in every folder, and folding one must not fold the rest.
      const bandKey = (key) => scope + "\u0000" + key;
      const bandFolded = (key) => foldedBands.has(bandKey(key));
      const foldBand = (key) => onToggleBand?.(bandKey(key));

      const bodyRef = useRef(null);
      const paneRef = useRef(null);
      // 框选: the box the drag paints into.
      const selRectRef = useRef(null);
      const [colMode, setColMode] = useState("full");
      const hasSelection = checked.size > 0;

      // 多选拖动: one drag carries the whole check-set, not just the row
      // under the pointer. It is split into the sessions a workspace can take
      // and the containers that move as nodes, and the drop target acts on the
      // half it can accept. The split happens here because the pane is the one
      // place that knows both the tree and the session index.
      const dragSetOf = (id) => {
        const ids = checked.has(id) && checked.size > 1 ? [...checked] : [id];
        return splitDragIds(ids, { nodes: tree?.nodes, sessionsById });
      };

      // The prototype picks column density from the *list pane's* width, not
      // the window's: the tree and detail panes are resizable, so the same
      // viewport can need any of the three densities.
      useEffect(() => {
        const element = paneRef.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
          const width = element.getBoundingClientRect().width;
          setColMode(width >= 660 ? "full" : width >= 480 ? "mid" : "slim");
        });
        observer.observe(element);
        return () => observer.disconnect();
      }, []);

      // The search box reads the fields 搜索范围 asked for. Three of them
      // are on the rows the pane already holds; 会话内容 is not — the panel has no
      // session text — so its hits arrive from the host index and are matched
      // here by id.
      const needle = query.trim().toLowerCase();
      const filtered = useMemo(() => {
        if (!needle) return sessions;
        return sessions.filter((session) => sessionMatchesQuery(session, needle, searchScopes, contentHits));
      }, [needle, sessions, searchScopes, contentHits]);

      const sorted = useMemo(
        () => filtered.slice().sort(compareBy(sortKey, sortDir === "asc" ? 1 : -1)),
        [filtered, sortKey, sortDir],
      );

      const pinned = sorted.filter((session) => session.pinned && !session.archived);
      const normal = sorted.filter((session) => !session.pinned && !session.archived);
      // 显示已归档的会话 is a view preference, not a deletion: with it off the
      // rows are simply not rendered, and the status bar still counts them so
      // the user can see that something is being hidden.
      const archived = showArchived === false ? EMPTY_LIST : sorted.filter((session) => session.archived);

      // Containers shown above the sessions, split into two groups because they
      // are two different things:
      //
      //   特殊文件夹 — 根目录 / 未分组 / 收藏 / 待办: views over the session set.
      //                Fixed: no rename, no delete.
      //   工作区与文件夹 — DSH workspaces and the user's own folders: real
      //                containers that can be renamed, checked and moved.
      //
      // 特殊文件夹 hang inside 根目录 and nowhere else: they are views over the
      // whole session set, so repeating them inside every folder would be noise.
      //
      // 根目录 itself is *not* in the list — you are already standing in it, and a
      // row that navigates to where you are is a no-op that reads like a bug.
      // The bin lists trashed sessions only: no container to navigate out of.
      // 所有会话 is listed here too: 根目录 holds no session rows of its own, so
      // the flat list has to be reachable as a folder from the root's list.
      //
      // A projected list (search, or a filter) shows results instead of a
      // container's contents, and a fixed view is not a result.
      const specialNodes =
        scope !== FIXED.root || needle || filterActive
          ? []
          : [FIXED.all, FIXED.ungrouped, FIXED.favorites, FIXED.todos]
              .map((id) => tree?.nodes?.[id])
              .filter(Boolean);

      // Which containers are rows at all — a container's children, or the whole
      // tree when the list is answering a question rather than showing a place.
      //
      // 收藏 / 待办 show their sessions as session rows (the flag is derived from
      // the shortcut), so a *session* shortcut must not also be drawn as a
      // shortcut row: one favorite would appear twice, once as a pointer and
      // once as the thing it points at.
      const inShortcutScope = scope === FIXED.favorites || scope === FIXED.todos;
      // A member of 收藏 / 待办 that names a folder or a workspace is drawn as that
      // container (glyph, name, 工作区 / 文件夹 tag, no 快捷方式), which is why the
      // row carries the target's fields and only keeps its own id: the id is the
      // shortcut, so 移出收藏 has something to delete and the original container
      // is never touched. A pointer whose target is gone is dropped, exactly like
      // the tree drops it.
      const asMember = (node) => {
        if (!inShortcutScope || node?.kind !== "shortcut") return node;
        const target = shortcutTarget(node, tree);
        if (!target) return null;
        return {
          ...target,
          id: node.id,
          mapped: {
            shortcutId: node.id,
            container: scope,
            kind: node.shortcutKind,
            openId: node.shortcutKind === "workspace" ? "w-" + node.targetId : node.targetId,
          },
        };
      };
      const containerNodes = listContainers({
        tree,
        scope,
        needle,
        // 搜索范围 decides whether a folder's *name* can match. With 会话名 off the
        // folder has to hold a matched row instead (see listContainers).
        matchNames: searchScopes.name,
        // 搜索位置 decides whether a folder from elsewhere may appear at all.
        local: searchScopes.place === "here",
        filterActive,
        filterAll,
        sessions,
      })
        .filter((node) => !(inShortcutScope && node.kind === "shortcut" && node.shortcutKind === "session"))
        .map(asMember)
        .filter(Boolean);

      // Subagent sessions follow their parent instead of sitting beside it.
      const rowsOf = (list) =>
        nestSessions(list, collapsed).map((entry) =>
          h(SessionRow, {
            key: entry.session.id,
            session: entry.session,
            selected: selected === entry.session.id,
            checked: checked.has(entry.session.id),
            onCheck,
            onSelect,
            now,
            depth: entry.depth,
            childCount: entry.childCount,
            collapsed: entry.collapsed,
            onToggleChildren,
            rename:
              rename?.kind === "session" && rename.id === entry.session.id && rename.surface !== "tree" ? rename : null,
            onBeginRename: onBeginRename ? (id) => onBeginRename("session", id, "list") : undefined,
            onRowContextMenu: onRowContextMenu
              ? (event, session) => onRowContextMenu(event, "session", session.id, session)
              : undefined,
            onOpenSession,
            clipboard,
            contentHit: contentHits?.[entry.session.id] ?? null,
            dragSet: dragSetOf(entry.session.id),
          }),
        );

      /**
       * Rows for a list of container nodes, wired to the right id space.
       *
       * A workspace row is also a drop target: dragging session rows onto it is
       * the pointer gesture for 跨工作区移动, and it goes through the same
       * `onDropSessions` the clipboard paste uses. `highlight` is the native
       * drag-and-drop cue browsers already implement, so no custom overlay is
       * needed.
       */
      const containerRows = (nodes) =>
        nodes.map((node) => {
          const mapped = node.mapped ?? null;
          const isWorkspace = node.type === "workspace" && !mapped;
          // A shortcut's menu acts on the reference, so it gets its own kind —
          // ContainerRow uses the same rule, and the two must agree or the row
          // renders one thing and the menu does another. A mapping is a third
          // kind: it reads as the container and acts on the membership.
          const kind = mapped ? "mapping" : isWorkspace ? "workspace" : node.kind === "shortcut" ? "shortcut" : "folder";
          const isShortcut = kind === "shortcut";
          const entityId = isWorkspace ? node.workspaceId ?? node.id : node.id;
          // A workspace is always editable (the default one included); only a
          // fixed view is not. This is the list's copy of ContainerRow's rule, and
          // the two must agree: a disagreement renders the pencil, sets the rename
          // state on click, and then refuses to hand the editor down — exactly
          // "点了编辑按钮却不弹出输入框".
          const editable = mapped ? false : isWorkspace ? true : node.kind === "folder";
          return h(ContainerRow, {
            key: node.id,
            node,
            tree,
            // A shortcut to a session points outside the tree; the row still has
            // to find it to show a name and a glyph.
            sessionOf: (id) =>
              sessionsById?.get?.(id) ?? sessions.find((session) => session.id === id) ?? null,
            pinned: Boolean(tree?.pins?.[node.id]),
            // The badge belongs to the container the row stands for, not to the
            // membership node — a pointer has no sessions of its own.
            count: tree?.counts?.[mapped ? mapped.openId : node.id] ?? 0,
            // Selected means "picked in this list", which is what makes the
            // detail pane describe this container; the scope is only where the
            // user currently stands (they may have selected without entering).
            selected: selected === node.id || scope === node.id,
            checked: checked.has(node.id),
            onCheck,
            onSelect,
            onOpen: onOpenWorkspace,
            onOpenShortcut,
            // The rename state may carry either id space: a workspace is
            // addressed by its native id in one place and by its tree node id
            // (w-…) in another, and a mismatch here opens an editor the row then
            // refuses to draw.
            rename:
              editable &&
              (rename?.id === entityId || rename?.id === node.id) &&
              rename.kind === kind &&
              rename.surface !== "tree"
                ? rename
                : null,
            onBeginRename: onBeginRename && editable ? (id) => onBeginRename(kind, id, "list") : undefined,
            // The row's own editor commits through here; the panel stays the
            // only writer of a name, which is what undo and the refresh rely on.
            onRename: onRename ? (renameKind, id, value) => onRename(renameKind, id, value) : undefined,
            // A shortcut is not editable (no rename, no checkbox) but it still
            // needs its menu — 跳转到原位置 / 移除快捷方式. Refusing the handler for
            // every non-editable row leaves those rows dead on right-click.
            onNodeContextMenu:
              onNodeContextMenu && (editable || isShortcut || Boolean(mapped)) ? onNodeContextMenu : undefined,
            // Three session targets, one rule: `node.accepts.session` is the
            // host's answer, so a folder that sits inside a workspace takes the
            // rows for 存放 while a folder outside every workspace takes nothing —
            // the reference below is what it offers instead.
            dropTarget:
              isWorkspace && onDropSessions && node.workspaceId
                ? (ids, copy) => onDropSessions(ids, node.workspaceId, copy)
                : !isWorkspace && !mapped && node.accepts?.session && onPlaceSessions
                  ? (ids) => onPlaceSessions(ids, node.id)
                  : null,
            // A session dropped on a *folder* that is not part of a workspace (or
            // on 收藏 / 待办) leaves a reference there: a session belongs to a
            // workspace, so such a folder can only ever hold a pointer to it.
            onDropShortcut:
              onDropShortcut && !isWorkspace && !mapped && !node.accepts?.session
                ? (ids) => onDropShortcut(node.id, ids)
                : undefined,
            // Containers are drop targets too: a folder or workspace dragged
            // from the tree (or from this very list) lands here through the same
            // `moveNodeTo` the tree uses, so both surfaces share one rule set.
            canAcceptNode: onCanAcceptNode && !mapped ? () => onCanAcceptNode(node.id) : undefined,
            onDropNode: onDropNode && !mapped ? (targetId, sourceIds) => onDropNode(targetId, sourceIds) : undefined,
            // One sentence per row per hover, in the status bar the rest of the
            // panel already writes to.
            onRefuse: typeof onHint === "function" ? (message) => onHint(message) : undefined,
            // Same rule as a session row: dragging one ticked container takes the
            // whole tick-set with it.
            dragSet: dragSetOf(node.id),
          });
        });

      // Group order: 置顶, 特殊文件夹, 文件夹, 工作区, 会话, then 已归档 sinks last.
      // Workspaces and folders are separate groups on purpose — they are
      // different objects with different owners, and mixing them made a folder
      // look like a workspace with the wrong icon. Folders come first because
      // they are the user's own containers (and the thing 新建文件夹 just made).
      const groups = [];
      // 置顶 is one band for sessions *and* containers: a pinned folder is as
      // much "at the top" as a pinned session, and two separate pinned groups
      // would make the user look in two places for the same idea.
      const pinnedContainers = containerNodes.filter((node) => tree?.pins?.[node.id]);
      const pinnedTotal = pinned.length + pinnedContainers.length;
      if (pinnedTotal > 0) {
        groups.push({
          key: "pinned",
          title: T("置顶"),
          icon: "pin",
          count: pinnedTotal,
          rows: bandFolded("pinned") ? null : [...containerRows(pinnedContainers), ...rowsOf(pinned)],
        });
      }
      if (specialNodes.length > 0) {
        groups.push({
          key: "special",
          title: T("特殊文件夹"),
          icon: "star",
          count: specialNodes.length,
          rows: bandFolded("special") ? null : containerRows(specialNodes),
        });
      }
      // While searching, workspaces and folders are listed together under one
      // 搜索结果 caption: a query is about finding a thing, not about which kind
      // of thing it turned out to be. A filter is the same kind of list — the
      // answer to "which of these match" — so it borrows the shape, and the
      // caption says which question produced it.
      // Pinned containers are already in the 置顶 band; repeating them below
      // would show one folder twice in one list.
      const unpinnedContainers = containerNodes.filter((node) => !tree?.pins?.[node.id]);
      // A shortcut carries `type: "shortcut"`, so neither the 文件夹 nor the
      // 工作区 bucket below would claim it — and a row that no group renders is
      // exactly "新建的快捷方式…主列表没有任何显示". References get their own
      // band instead of being folded into the type they point at, because the
      // shortcut is the row that lives *here*.
      const shortcuts = unpinnedContainers.filter((node) => node.kind === "shortcut");
      const workspaces = unpinnedContainers.filter((node) => node.type === "workspace");
      const folders = unpinnedContainers.filter((node) => node.type === "folder");
      if ((needle || filterActive) && containerNodes.length > 0) {
        groups.push({
          key: "found",
          title: needle ? T("搜索到的目录") : T("筛选到的目录"),
          icon: needle ? "search" : "tag",
          count: containerNodes.length,
          rows: bandFolded("found") ? null : containerRows(containerNodes),
        });
      } else {
        // 文件夹 first, then 工作区: folders are the user's own containers and the
        // thing they just created, so they belong where the eye lands first.
        // Workspaces are DSH's registry and read as a reference list below them.
        if (folders.length > 0) {
          groups.push({
            key: "folders",
            title: T("文件夹"),
            icon: "folder",
            count: folders.length,
            rows: bandFolded("folders") ? null : containerRows(folders),
          });
        }
        if (shortcuts.length > 0) {
          groups.push({
            key: "shortcuts",
            title: T("快捷方式"),
            icon: "shortcut",
            count: shortcuts.length,
            rows: bandFolded("shortcuts") ? null : containerRows(shortcuts),
          });
        }
        if (workspaces.length > 0) {
          groups.push({
            key: "workspaces",
            title: T("工作区"),
            icon: "monitor",
            count: workspaces.length,
            rows: bandFolded("workspaces") ? null : containerRows(workspaces),
          });
        }
      }
      // 所有会话 is cut by workspace (see workspaceBands): the flat band made every
      // row repeat its workspace in the subtitle, and the caption is the name the
      // tree already uses. Anywhere else — inside a container, or answering a
      // search or a filter — the list is already about a place or a question, so
      // it keeps one 会话 band.
      const byWorkspace = scope === FIXED.all && !needle && !filterActive;
      if (normal.length > 0) {
        if (byWorkspace) {
          for (const band of workspaceBands(normal, tree)) {
            groups.push({
              key: "ws:" + (band.key || "ungrouped"),
              title: band.title,
              icon: band.icon,
              count: band.count,
              rows: bandFolded("ws:" + (band.key || "ungrouped")) ? null : rowsOf(band.sessions),
            });
          }
        } else {
          groups.push({
            key: "normal",
            title: T("会话"),
            icon: null,
            count: normal.length,
            rows: bandFolded("normal") ? null : rowsOf(normal),
          });
        }
      }
      if (archived.length > 0) {
        groups.push({
          key: "archived",
          title: T("已归档（沉底）"),
          icon: "archive",
          count: archived.length,
          rows: bandFolded("archived") ? null : rowsOf(archived),
        });
      }
      const style = {
        "--w-name": `${colWidths.name}px`,
        "--w-tags": `${colWidths.tags}px`,
        "--w-note": `${colWidths.note}px`,
        "--w-date": `${colWidths.updated}px`,
        "--w-size": `${colWidths.size}px`,
        "--w-status": `${colWidths.status}px`,
      };

      return h(
        "main",
        { className: "pane-list", id: "se-listpane", style, ref: paneRef, "data-cw": colMode },
        h(
          "div",
          { className: "listhead", ref: listRef },
          h(
            "div",
            { className: "lh col-check" },
            h(
              "span",
              {
                className: "chk" + (filtered.length > 0 && filtered.every((s) => checked.has(s.id)) ? " on" : ""),
                onClick: () => {
                  const all = filtered.length > 0 && filtered.every((s) => checked.has(s.id));
                  onCheck(all ? null : "all");
                },
              },
              filtered.length > 0 && filtered.every((s) => checked.has(s.id)) ? h(Icon, { name: "check", size: 10 }) : null,
            ),
          ),
          COL_ORDER.map((key) => {
            const column = COLUMNS[key];
            const sortedCol = sortKey === key;
            return h(
              "div",
              {
                key,
                className: "lh " + column.cls + (sortedCol ? " sorted" : ""),
                "data-col": key,
                // The resize strip stops the click itself, so a press on it never
                // reaches the sort handler underneath.
                onClick: () => onSort(key),
              },
              h("span", { className: "lhlabel" }, column.label),
              h("span", { className: "sortdot", "aria-hidden": "true" }, "▼"),
              h("span", {
                className: "colrsz",
                "data-cw": key,
                title: T("拖动调整列宽"),
                onMouseDown: (event) => onResizeColumn(event, key),
              }),
            );
          }),
          h("div", { className: "lh col-fill" }),
        ),
        // The box itself: an absolutely placed rectangle the drag paints in
        // place instead of re-rendering the list on every frame.
        h("div", { className: "selrect", ref: selRectRef, "aria-hidden": "true" }),
        h(
          "div",
          {
            className: "listbody" + (hasSelection ? " has-sel" : ""),
            ref: bodyRef,
            // 框选 starts on the space between rows and on any row
            // that is not picked; a press on a picked row belongs to
            // its own drag, and a press on a control inside one is that
            // control's own.
            onMouseDown: onMarquee
              ? (event) => onMarquee(event, paneRef.current, selRectRef.current)
              : undefined,
            // A row stops its own contextmenu, so this only fires on the space
            // between rows, on a band caption or on the empty state — which is
            // exactly what 空白处 means here.
            onContextMenu: onBlankContextMenu
              ? (event) => {
                  event.preventDefault();
                  onBlankContextMenu(event);
                }
              : undefined,
          },
          groups.length === 0
            ? h(Empty, {
                icon: scope === FIXED.trash ? "trash" : "folder",
                title: needle
                  ? contentPending
                    ? T("正在索引会话内容")
                    : T("没有匹配的项目")
                  : filterActive
                    ? T("没有符合条件的项目")
                    : scope === FIXED.trash
                      ? T("回收站是空的")
                      : T("这里还是空的"),
                hint: needle
                  ? contentPending
                    ? T("索引建好后，命中会话内容的行会自动出现")
                    : T("试试别的关键词，或清空搜索框")
                  : filterActive
                    ? T("放宽或清除筛选条件，列表就回到当前容器的内容")
                    : T("可以用「新建文件夹」把会话分组，或把工作区拖进来"),
              })
            : groups.map((group) => {
                const folded = bandFolded(group.key);
                return h(
                  "div",
                  { key: group.key },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "grp" + (folded ? " folded" : ""),
                      // The caption *is* the control, and it says its state out
                      // loud: a chevron next to a bare word is a guess.
                      "aria-expanded": folded ? "false" : "true",
                      title: folded ? T("展开此分组") : T("折叠此分组"),
                      onClick: () => foldBand(group.key),
                    },
                    h("span", { className: "gcaret" }, h(Icon, { name: folded ? "chevright" : "chevdown", size: 12 })),
                    group.icon ? h(Icon, { name: group.icon, size: 12 }) : null,
                    h("span", { className: "gtitle" }, group.title),
                    h("span", { className: "gcount" }, formatCount(group.count)),
                  ),
                  // A folded band builds no rows at all: collapsing a 500-row list
                  // must not cost the same as showing it.
                  folded ? null : group.rows,
                );
              }),
        ),
      );
    }

