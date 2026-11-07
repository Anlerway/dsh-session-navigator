    // ── 总结进度 ───────────────────────────────────────────────────────────
    /**
     * The AI 总结 run, as one progress bar.
     *
     * It subscribes on its own instead of being fed by `Panel`. A running batch
     * emits once per finished session — about once a second — and a panel that
     * held the subscription repainted every row, the whole tree and the detail
     * pane at that rate, for a bar that is 156px wide. Here the emit reaches a
     * component whose output is one bar, so the cost of the batch is the batch.
     *
     * `useSummaries` is also what keeps the poller alive while the panel is open,
     * which is why the progress survives closing and reopening the panel mid-run.
     */
    function SummaryRunProgress({ onError }) {
      const summaryState = useSummaries();
      if (summaryState.state?.running !== true) return null;
      const state = summaryState.state ?? {};
      const done = Math.max(0, Number(state.done) || 0);
      const total = Math.max(0, Number(state.total) || 0);
      // A batch whose size is still unknown walks an indeterminate bar rather
      // than pretending to know how far it got.
      const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
      const progress = T("正在生成 {0}/{1}", [formatCount(done), formatCount(total)]);
      const detail = state.current?.title ? T("{0} · {1}", [progress, state.current.title]) : progress;
      return h(
        "div",
        {
          className:
            "s-progress" + (percent === null ? " indeterminate" : "") + (Number(state.failed) > 0 ? " failed" : ""),
          role: "progressbar",
          "aria-label": detail,
          "aria-valuemin": 0,
          "aria-valuemax": percent === null ? undefined : total,
          "aria-valuenow": percent === null ? undefined : done,
          title: detail + " · " + T("点击停止总结"),
          onClick: () => {
            summaryStore.cancel().catch((failure) => onError?.(String(failure?.message ?? failure)));
          },
        },
        h("span", { className: "s-progress-label" }, T("AI 总结")),
        h(
          "span",
          { className: "s-progress-track" },
          h("span", { className: "s-progress-fill", style: percent === null ? null : { width: percent + "%" } }),
        ),
        h("span", { className: "s-progress-num" }, done + "/" + total),
      );
    }

    // ── Panel ──────────────────────────────────────────────────────────────
    function Panel({ t }) {
      // Every T() below reads this. A saved 界面语言 outranks DSH's translator;
      // a translator that does not know our namespace answers with the key
      // itself, which normalizes to "" and leaves the panel as it was.
      panelLang = uiLangOverride || normalizeLang(typeof t === "function" ? t("langCode") : "") || panelLang;
      const [boot, setBoot] = useState({ phase: "loading", data: null, error: null });
      // 日期格式 / 大小单位 / 界面语言 — read once per render, because the rows
      // below call the formatters themselves and never receive a display prop.
      const display = boot.data?.settings?.list ?? {};
      applyUiLang(boot.data?.settings);
      panelFormat.date = display.dateFormat === "relative" ? "relative" : "date";
      panelFormat.size = display.sizeFormat === "kb" ? "kb" : "auto";
      // Whether the host is serving a different build than the one this page is
      // running. Without this check a panel that survived an update keeps
      // calling the old routes and reporting the old messages, which reads as a
      // bug in the new code.
      const [staleBuild, setStaleBuild] = useState(false);
      useEffect(() => {
        let alive = true;
        apiSend("GET", "/version")
          .then((info) => {
            if (alive && CLIENT_BUILD && info?.build && info.build !== CLIENT_BUILD) setStaleBuild(true);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);
      // The palette only becomes reachable once this shell is in the document:
      // DSH declares it on <body>, and apply() reported before anything was
      // mounted. Without this the window would keep its fallback accent.
      useEffect(() => {
        reportTheme();
      }, []);
      // A switch of DSH's own language redraws this panel — every T() reads the
      // new translator — but the detached window is a separate process whose
      // dictionary was fixed by its URL when it loaded. Tell the Host on the
      // transition (not on every render) and let it pass the new code on. The
      // first run only records the baseline, so opening the panel is silent.
      const publishedLang = useRef(null);
      useEffect(() => {
        const previous = publishedLang.current;
        publishedLang.current = panelLang;
        if (previous === null || previous === panelLang) return;
        if (windowHost()) return;
        void sendBridgeCommand("lang-changed", { lang: panelLang });
      }, [panelLang]);
      const stored = useRef(readLayout()).current;
      // 根目录 is the landing scope: its list shows the directories plus the
      // 所有会话 folder, which is where the flat list of sessions lives.
      const initialScope = typeof stored.scope === "string" ? stored.scope : FIXED.root;
      /**
       * Tabs.
       *
       * A tab is { id, scope, history, cursor, checked }: everything a tab is
       * *for* is the ability to stand in two places at once without losing the
       * other one's selection. Sort/view/filter stay panel-wide — they describe
       * how a list is drawn, not which list is open, and duplicating them per
       * tab would make the toolbar disagree with itself.
       *
       * The tab list is persisted with the rest of the layout, so reopening the
       * panel restores the same tabs; a stale tab whose scope no longer exists
       * degrades to 根目录 instead of failing the whole restore.
       */
      const initialTabs = Array.isArray(stored.tabs) && stored.tabs.length > 0
        ? stored.tabs
            .filter((tab) => tab && typeof tab.scope === "string")
            .map((tab, index) => ({
              id: typeof tab.id === "string" && tab.id ? tab.id : "t" + index + "-" + Date.now().toString(36),
              scope: tab.scope,
              history: Array.isArray(tab.history) && tab.history.length > 0 ? tab.history : [tab.scope],
              cursor: Number.isInteger(tab.cursor) ? tab.cursor : 0,
              checked: Array.isArray(tab.checked) ? tab.checked : [],
            }))
        : null;
      const [tabs, setTabs] = useState(() => initialTabs ?? [{ id: "t0", scope: initialScope, history: [initialScope], cursor: 0, checked: [] }]);
      const initialTabIndex = (() => {
        const index = Number(stored.activeTab);
        return Number.isInteger(index) && index >= 0 && index < (initialTabs?.length ?? 1) ? index : 0;
      })();
      const [activeTab, setActiveTab] = useState(initialTabIndex);
      const [scope, setScope] = useState(() => initialTabs?.[initialTabIndex]?.scope ?? initialScope);
      const [history, setHistory] = useState(() => initialTabs?.[initialTabIndex]?.history ?? [initialScope]);
      const [cursor, setCursor] = useState(() => initialTabs?.[initialTabIndex]?.cursor ?? 0);
      // Whether the Electron component is ready; refreshed by /bootstrap and by
      // the settings page. Drives the 独立窗口 button and the mode chip.
      const [componentReady, setComponentReady] = useState(
        (stored.componentPhase ?? "absent") === "ready",
      );
      // Whether a detached window is on screen right now. Separate from
      // componentReady on purpose: the component is a download that stays
      // installed after the window closes, and the two were once the same flag,
      // so closing the window made the 独立窗口 button claim the component was
      // missing. The Host says when a window opens (its `hello`) and when it
      // closes (`window-closed`).
      const [detachedOpen, setDetachedOpen] = useState(false);

      /**
       * Open (or focus) the detached window.
       *
       * The button and Ctrl+Shift+D both land here. When the component is not
       * installed the click is not a silent no-op: it says what is missing and
       * where to get it, because "nothing happened" is the worst possible answer
       * for a button that looks available.
       */
      const openDetachedWindow = useCallback(async () => {
        // Asking for the window from inside the window means "focus me", not
        // "open another copy and close this one" — the Host answers that with a
        // focus, and the panel below must not treat it as a reason to close.
        if (windowHost()) return;
        if (!componentReady) {
          setHint(T("独立窗口需要先下载Electron 组件：设置 → 会话资源管理器 → Electron 组件"));
          return;
        }
        try {
          await apiSend("POST", "/detached/open", { lang: uiLang() });
          setDetachedOpen(true);
          // The window is outside this page; leaving the in-app panel on top
          // would just be a second copy of what the user asked to move out.
          panelStore.set(false);
        } catch (error) {
          setHint(String(error?.message ?? error));
        }
      }, [componentReady]);


      const openDetachedWindowRef = useRef(openDetachedWindow);
      openDetachedWindowRef.current = openDetachedWindow;
      const [selected, setSelected] = useState(null);
      const [checked, setChecked] = useState(() => new Set());
      const [query, setQuery] = useState("");
      // Sort state is a field plus a direction, not a cycle: the toolbar shows
      // both, and a click on a column header only changes the field (keeping
      // the direction the user chose).
      const [sortKey, setSortKey] = useState(
        SORT_FIELDS.some((field) => field.key === stored.sortKey) ? stored.sortKey : "updated",
      );
      const [sortDir, setSortDir] = useState(stored.sortDir === "asc" ? "asc" : "desc");
      const [view, setView] = useState(stored.view ?? "details");
      const [showDetail, setShowDetail] = useState(stored.showDetail !== false);
      // 根目录 starts open: it is the app's home, and a collapsed root would
      // show an empty 目录 section on first launch.
      const [expanded, setExpanded] = useState(
        () => new Set(Array.isArray(stored.expanded) ? stored.expanded : [FIXED.root]),
      );
      // 分组折叠: the band captions in 所有会话 — one per workspace — are
      // buttons, and what they folded is remembered with the rest of the layout.
      // The key is "scope\u0000band key" because 会话 and 置顶 exist in every
      // folder: folding one folder's caption must not hide the same caption in
      // another one, while a workspace band keeps its key everywhere.
      const [foldedBands, setFoldedBands] = useState(
        () => new Set(Array.isArray(stored.foldedBands) ? stored.foldedBands.filter((key) => typeof key === "string") : []),
      );
      /** Fold or unfold one band. The key already carries the scope. */
      const toggleBand = useCallback((key) => {
        setFoldedBands((previous) => {
          const next = new Set(previous);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }, []);
      // Collapsed parents in the session list (subagent disclosure), kept apart
      // from `expanded` because the tree and the list collapse independently.
      // This set holds the parents the user *explicitly* folded; the default for
      // everyone else comes from the 折叠子智能体 setting (see effectiveCollapsed).
      const [collapsed, setCollapsed] = useState(() => new Set());
      // The opposite override: parents the user opened while the setting says
      // "collapsed". Two sets, not one, because "the default folded this" and
      // "I folded this" must survive a settings change in opposite directions.
      const [expandedChildren, setExpandedChildren] = useState(() => new Set());
      const [navWidth, setNavWidth] = useState(Number(stored.navWidth) || 260);
      const [detailWidth, setDetailWidth] = useState(Number(stored.detailWidth) || 320);
      const [colWidths, setColWidths] = useState(() => ({
        name: 260, tags: 116, note: 150, updated: 104, size: 74, status: 78,
        ...(stored.colWidths && typeof stored.colWidths === "object" ? stored.colWidths : {}),
      }));
      const [hint, setHint] = useState(peekLaunchHint);
      // Failures get their own line, not the 2.6 s hint: on the hint a refused
      // move flashes an English sentence at the bottom of the window for a moment
      // and then vanishes, which reads as "nothing happened". This one stays until
      // the next successful action or a click.
      const [errorText, setErrorText] = useState("");
      React.useEffect(() => {
        // One launch, one message: the panel has shown it now.
        clearLaunchHint();
      }, []);
      // List filter (筛选). A view state, so it persists with the rest of the
      // layout instead of being re-picked on every open.
      const [filter, setFilter] = useState(() => ({
        favorite: stored.filter?.favorite ?? "all",
        archived: stored.filter?.archived ?? "all",
        todo: stored.filter?.todo ?? "all",
        tags: Array.isArray(stored.filter?.tags) ? stored.filter.tags : [],
        // 范围: "scope" narrows the current container, "all" applies the same
        // predicates to every session the panel can see. It is part of the
        // filter (not a separate switch) because "收藏 but only here" and
        // "收藏 everywhere" are two readings of the same question.
        scope: stored.filter?.scope === "all" ? "all" : "scope",
      }));
      const [filterOpen, setFilterOpen] = useState(false);
      // 搜索范围: the fields the search box reads. A preference, so it
      // persists with the layout instead of being re-picked every open.
      const [searchScopes, setSearchScopes] = useState(() => normalizeSearchScopes(stored.searchScopes));
      const [scopeOpen, setScopeOpen] = useState(false);
      // 会话内容 hits for the current needle, keyed by session id, plus the
      // progress of the host index that produced them.
      const [contentHits, setContentHits] = useState(() => EMPTY_HITS);
      const [contentState, setContentState] = useState(null);
      // The 更多 menu is the only popover in the panel; null means closed.
      const [more, setMore] = useState(null);
      const [sortOpen, setSortOpen] = useState(null);
      const [createOpen, setCreateOpen] = useState(null);
      const newSessionRef = useRef(null);
      // The bridge reaches `openInDsh` through a ref for the same reason: the
      // subscription outlives any one render of the panel.
      const openInDshRef = useRef(null);
      const selectionTargetRef = useRef(null);
      // The row context menu state moved into useContextMenu (declared below).
      // F2 is registered once, above the callbacks it calls; the ref keeps the
      // listener stable while still reaching the current implementation.
      const renameCurrentRef = useRef(null);
      const dialogOpenRef = useRef(false);
      // The rename draft lives in the rename hook (13e), with its editor.
      // Undo is deliberately shallow: it remembers the inverse of the last few
      // destructive actions, not a full history (S6 asks for "one step back",
      // not time travel). Entries are closures, so each one captures exactly
      // the ids it touched.
      const undoStack = useRef([]);
      const [now, setNow] = useState(() => Date.now());
      const [bp, setBp] = useState("wide");
      const shellRef = useRef(null);
      const searchRef = useRef(null);

      // The feed itself lives in a hook (13b-hook-live-refresh.js): the first
      // load, the pushed updates and the clock tick, all on the same callbacks.
      const { load } = useLiveRefresh({ setBoot, setComponentReady, setNow });

      // 会话内容 is the one scope the client cannot answer from the rows
      // it holds: the text lives in the session logs, and reading 63 of them here
      // would freeze the window. The host keeps an index and answers this route
      // with what it has covered so far, so the first search of a session builds
      // in the background while the list fills in behind it.
      useEffect(() => {
        const needle = query.trim();
        if (!searchScopes.content || !needle) {
          setContentHits(EMPTY_HITS);
          setContentState(null);
          return undefined;
        }
        let cancelled = false;
        let timer = 0;
        const run = async () => {
          try {
            const data = await apiGet("/search/content?q=" + encodeURIComponent(needle));
            if (cancelled) return;
            const hits = {};
            for (const hit of data?.hits ?? []) hits[hit.id] = hit;
            const state = { ready: data?.ready === true, indexed: data?.indexed ?? 0, total: data?.total ?? 0 };
            setContentHits(hits);
            setContentState(state);
            // Poll until the index has covered every session; a ready index
            // answers a new needle in milliseconds, so this is a first-use cost.
            if (!state.ready) timer = setTimeout(run, 700);
          } catch (error) {
            if (cancelled) return;
            setContentHits(EMPTY_HITS);
            setContentState({ ready: true, error: true, indexed: 0, total: 0 });
          }
        };
        timer = setTimeout(run, 240);
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [query, searchScopes.content]);

      // Layout memory: the newest snapshot of what should be remembered, written
      // at most every 150ms.
      //
      // Not every value here changes at human speed: `colWidths` moves with each
      // pointermove of a column drag and `checked`/`cursor` with each row a
      // marquee crosses, so writing on every change meant a full parse,
      // serialise and store of the layout hundreds of times per gesture. Each
      // patch is a complete snapshot of the same keys, so a pending write can be
      // replaced rather than queued.
      const layoutPending = useRef(null);
      const layoutTimer = useRef(0);
      const flushLayout = useCallback(() => {
        if (layoutTimer.current) {
          clearTimeout(layoutTimer.current);
          layoutTimer.current = 0;
        }
        const patch = layoutPending.current;
        layoutPending.current = null;
        if (patch) mergeLayout(patch);
      }, []);
      useEffect(() => {
        layoutPending.current = {
          scope,
          view,
          sortKey,
          sortDir,
          showDetail,
          navWidth,
          detailWidth,
          colWidths,
          expanded: [...expanded],
          foldedBands: [...foldedBands],
          filter,
          searchScopes,
          // The tabs as they should be remembered: the active tab carries the
          // live editing state, every other tab what it had when it was left.
          tabs: tabs.map((tab, index) =>
            index === activeTab ? { ...tab, scope, history, cursor, checked: [...checked] } : tab,
          ),
          activeTab,
          componentPhase: componentReady ? "ready" : "absent",
        };
        if (layoutTimer.current) return;
        layoutTimer.current = setTimeout(() => {
          layoutTimer.current = 0;
          flushLayout();
        }, 150);
      }, [scope, history, cursor, checked, view, sortKey, sortDir, showDetail, navWidth, detailWidth, colWidths, expanded, foldedBands, filter, searchScopes, tabs, activeTab, componentReady, flushLayout]);

      // Closing the panel unmounts everything: the last gesture must land before
      // the timer does, or resizing the detail pane and closing straight after
      // would forget the width. Same for a reload, hence pagehide.
      useEffect(() => {
        const flush = () => flushLayout();
        window.addEventListener("pagehide", flush);
        return () => {
          window.removeEventListener("pagehide", flush);
          flush();
        };
      }, [flushLayout]);

      useEffect(() => {
        const onKey = (event) => {
          // While a dialog or an inline editor owns the keyboard, the panel's
          // own shortcuts must not also fire (Escape would close the panel
          // behind the dialog that is being dismissed).
          const typing =
            event.target &&
            (event.target.tagName === "INPUT" ||
              event.target.tagName === "TEXTAREA" ||
              event.target.isContentEditable);
          if (event.key === "Escape") {
            if (typing) return;
            // A dialog owns Escape while it is open — the comment above is the
            // promise, this line is the promise kept. Without it, Escape on a
            // delete confirmation closed the panel (or the window) and left the
            // confirmation orphaned in front of nothing.
            if (dialogOpenRef.current) return;
            if (query) {
              setQuery("");
              return;
            }
            // Escape is the user dismissing the panel, and in a window that is
            // the user dismissing the window.
            panelStore.set(false, "user");
          }
          if (typing) return;
          if (event.key === "F2") {
            // A dialog is open: F2 belongs to it, not to the list behind it.
            if (dialogOpenRef.current) return;
            event.preventDefault();
            renameCurrentRef.current?.();
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "e") {
            event.preventDefault();
            searchRef.current?.focus();
            return;
          }
          // Ctrl+N is the one shortcut the 新建 menu advertises, so it has to
          // exist. It is claimed here rather than left to the browser, which
          // would open a new DSH window instead of a draft.
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
            event.preventDefault();
            newSessionRef.current?.();
          }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [query]);

      // Ctrl+Z undoes the last destructive write (S6). It is registered apart
      // from the Escape handler so a rename in progress can swallow the key
      // first: while an inline editor is open, Ctrl+Z belongs to the browser's
      // own text undo, not to the session list.
      const undo = useCallback(async () => {
        const entry = undoStack.current.pop();
        if (!entry) {
          setHint(T("没有可撤销的操作"));
          return;
        }
        try {
          await entry.run();
          await load(true);
          setHint(entry.label);
        } catch (error) {
          setHint(String(error?.message ?? error));
          undoStack.current.push(entry);
        }
      }, [load]);

      useEffect(() => {
        const onUndo = (event) => {
          if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
          const element = event.target;
          const typing =
            element &&
            (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable);
          if (typing) return;
          // Ctrl+Z is a write. While a dialog is open it belongs to the dialog's
          // own field (or to nobody), never to the list behind it.
          if (dialogOpenRef.current) return;
          event.preventDefault();
          undo();
        };
        window.addEventListener("keydown", onUndo);
        return () => window.removeEventListener("keydown", onUndo);
      }, [undo]);

      // The prototype switches layout by measured width, not by media query,
      // because the panel is a floating window whose width is independent of
      // the window size.
      useEffect(() => {
        const element = shellRef.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
          const width = element.getBoundingClientRect().width;
          setBp(width >= 1000 ? "wide" : width >= 760 ? "mid" : "narrow");
        });
        observer.observe(element);
        return () => observer.disconnect();
      }, []);

      const data = boot.data;
      const tree = data?.tree;
      // Trashed sessions are not in `sessions` any more: their payload has left
      // DSH's sessions tree, so the host can only describe them from the bin
      // index. They still have to be listed here, because 回收站 is a view over
      // this very array (and the detail pane edits them the same way).
      // `dshStatuses` is DSH's own client status (running / pending interaction /
      // unread completion); `withDshStatus` folds it into the rows so a badge
      // says what DSH's sidebar says. Everything else in this array is still the
      // host's description — see the rule at the top of the file.
      const dshStatuses = useDshSessionStatus();
      const allSessions = useMemo(
        () => withDshStatus([...(data?.sessions ?? []), ...(data?.trashed ?? [])], dshStatuses),
        [data, dshStatuses],
      );

      // Settings live on the host so they follow the user across browsers; the
      // shape is normalised there, so these fallbacks only matter for the first
      // paint before /bootstrap lands.
      const settings = data?.settings ?? null;
      // The list switches (自动折叠 / 显示已归档) are panel-wide preferences that
      // the 更多 menu toggles. They live in the settings document, so the
      // settings page and this menu always agree — the menu is a shortcut, not
      // a second source of truth.
      const listSettings = {
        autoCollapse: settings?.list?.autoCollapse === true,
        showArchived: settings?.list?.showArchived !== false,
        // 折叠子智能体 — folded by default: a run that delegated ten times would
        // otherwise push ten non-actionable rows into the list.
        collapseSubagents: settings?.list?.collapseSubagents !== false,
        // 过滤空会话 — on by default: a session that never started a turn has
        // nothing to show and only pads the list.
        hideBlank: settings?.list?.hideBlank !== false,
      };

      /**
       * The parents the session list should draw as folded.
       *
       * Three inputs, one answer: the setting decides the default, `collapsed`
       * holds the parents folded against an "expanded" default, and
       * `expandedChildren` holds the parents opened against a "collapsed"
       * default. Only sessions that actually have a subagent below them enter
       * the set — a caret on a childless row would promise a disclosure that
       * does not exist.
       */
      const effectiveCollapsed = useMemo(() => {
        const set = new Set(collapsed);
        if (listSettings.collapseSubagents) {
          const parents = new Set();
          for (const session of allSessions) {
            if (session.isSubagent && session.parentSession) parents.add(session.parentSession);
          }
          for (const id of parents) {
            if (!expandedChildren.has(id)) set.add(id);
          }
        }
        return set;
      }, [allSessions, collapsed, expandedChildren, listSettings.collapseSubagents]);
      /**
       * Write one list preference and fold the answer back into the bootstrap
       * document, so the toggle reflects the host's normalised value instead of
       * the optimistic guess.
       */
      const saveListSettings = useCallback(async (patch) => {
        try {
          const result = await apiSend("PUT", "/settings", { list: patch });
          setBoot((previous) =>
            previous.data
              ? { ...previous, data: { ...previous.data, settings: result.settings } }
              : previous,
          );
        } catch (error) {
          setHint(String(error?.message ?? error));
        }
      }, []);
      /**
       * 更多设置… opens DSH's own settings window on this plugin's section.
       *
       * `openSettingsTarget` decides which document can do that: the panel
       * opens it when it is running inside DSH, and asks the DSH page to open it
       * when the panel *is* the detached window — see the comment there. The
       * panel does not draw its own settings surface: DSH has one settings UI,
       * and this button goes to it.
       *
       * The panel is only closed once the window is *verified* to be open, so a
       * host that refuses leaves the user looking at something instead of
       * staring at the desktop.
       */
      const openSettingsPage = useCallback(async () => {
        // Only one layer at a time: a command menu left open behind the
        // settings window would still answer the pointer when it closes.
        setMore(null);
        const hintKey = await openSettingsTarget(t("navLabel"));
        if (hintKey) {
          setHint(t(hintKey));
          return;
        }
        // The panel is an overlay over the app; the settings window wants the
        // screen, so step out of the way.
        panelStore.set(false);
      }, [t]);
      const sizing = settings?.shell?.modal?.sizing === "percent" ? "percent" : "fixed";
      // One attribute carries the size: the fixed presets and the percentage
      // presets never overlap, so the CSS can key off data-size alone once
      // data-sizing says which vocabulary it belongs to.
      const modalSize = sizing === "percent"
        ? settings?.shell?.modal?.percent ?? "p70"
        : settings?.shell?.modal?.size ?? "md";
      const modalDim = Number(settings?.shell?.modal?.dim) || 0;
      const closeOnBackdrop = settings?.shell?.modal?.closeOnBackdrop !== false;

      /**
       * 自动折叠: entering a container folds its siblings.
       *
       * "Siblings" means the other children of the same parent, not the whole
       * tree — collapsing everything on every navigation made the tree jump
       * back to a single row, which is the opposite of a navigator. The node
       * just entered is expanded; its parent stays open so the path is visible.
       */
      const autoCollapseTo = useCallback(
        (id) => {
          const nodes = tree?.nodes ?? {};
          const parent = nodes[id]?.parent ?? null;
          if (!parent) return;
          const siblings = tree?.children?.[parent] ?? [];
          setExpanded((previous) => {
            const next = new Set(previous);
            next.add(parent);
            next.add(id);
            for (const sibling of siblings) if (sibling !== id) next.delete(sibling);
            return next;
          });
        },
        [tree],
      );

      const navigate = useCallback(
        (next) => {
          if (!next) return;
          if (listSettings.autoCollapse) autoCollapseTo(next);
          setScope(next);
          setChecked(new Set());
          setSelected(null);
          setHistory((previous) => {
            const trimmed = previous.slice(0, cursor + 1);
            if (trimmed[trimmed.length - 1] === next) return previous;
            const merged = [...trimmed, next];
            setCursor(merged.length - 1);
            return merged;
          });
        },
        [autoCollapseTo, cursor, listSettings.autoCollapse],
      );

      const goBack = useCallback(() => {
        setCursor((index) => {
          const next = Math.max(0, index - 1);
          setScope(history[next] ?? FIXED.root);
          return next;
        });
      }, [history]);

      const goForward = useCallback(() => {
        setCursor((index) => {
          const next = Math.min(history.length - 1, index + 1);
          setScope(history[next] ?? FIXED.root);
          return next;
        });
      }, [history]);

      // ── tabs ─────────────────────────────────────────────────────────────
      // The tab strip is the panel's own, not the browser's: each tab keeps its
      // own scope, back/forward history and checked set, and switching tabs is
      // the only operation that writes one into the other. The live editing
      // state (scope/history/cursor/checked) stays in the same four state
      // variables the rest of the panel already uses, so nothing downstream has
      // to know a tab exists.
      const snapshotActiveTab = useCallback(
        () => ({ scope, history, cursor, checked: [...checked] }),
        [checked, cursor, history, scope],
      );

      const applyTab = useCallback((tab) => {
        setScope(tab.scope);
        setHistory(tab.history);
        setCursor(tab.cursor);
        setChecked(new Set(tab.checked));
        setSelected(null);
      }, []);

      const switchTab = useCallback(
        (index) => {
          if (index === activeTab || !tabs[index]) return;
          const next = tabs.map((tab, position) =>
            position === activeTab ? { ...tab, ...snapshotActiveTab() } : tab,
          );
          setTabs(next);
          setActiveTab(index);
          applyTab(next[index]);
        },
        [activeTab, applyTab, snapshotActiveTab, tabs],
      );

      const addTab = useCallback(() => {
        const nextTabs = tabs.map((tab, position) =>
          position === activeTab ? { ...tab, ...snapshotActiveTab() } : tab,
        );
        // A new tab opens where the user is standing: duplicating the scope is
        // more useful than always landing on 根目录, and both tabs keep separate
        // histories from there.
        const tab = {
          id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          scope,
          history: [scope],
          cursor: 0,
          checked: [],
        };
        nextTabs.push(tab);
        setTabs(nextTabs);
        setActiveTab(nextTabs.length - 1);
        applyTab(tab);
        setHint(T("已新建标签页"));
      }, [activeTab, applyTab, scope, snapshotActiveTab, tabs]);

      const closeTab = useCallback(
        (index) => {
          if (tabs.length <= 1) {
            setHint(T("至少保留一个标签页"));
            return;
          }
          const nextTabs = tabs
            .map((tab, position) => (position === activeTab ? { ...tab, ...snapshotActiveTab() } : tab))
            .filter((_, position) => position !== index);
          const nextActive = index < activeTab ? activeTab - 1 : index > activeTab ? activeTab : Math.min(activeTab, nextTabs.length - 1);
          setTabs(nextTabs);
          setActiveTab(nextActive);
          applyTab(nextTabs[nextActive]);
        },
        [activeTab, applyTab, snapshotActiveTab, tabs],
      );

      /** Drag a tab onto another to reorder the strip. */
      const moveTab = useCallback(
        (from, to) => {
          if (from === to || from < 0 || to < 0 || from >= tabs.length || to >= tabs.length) return;
          const nextTabs = tabs.map((tab, position) =>
            position === activeTab ? { ...tab, ...snapshotActiveTab() } : tab,
          );
          const [moved] = nextTabs.splice(from, 1);
          nextTabs.splice(to, 0, moved);
          // Reordering must not change which tab is showing. Highlighting the tab
          // that was dropped on while the list keeps the old range lets the next
          // switch snapshot that live range into the wrong tab, overwriting the
          // dragged-to tab's own scope.
          let nextActive = activeTab;
          if (from === activeTab) nextActive = to;
          else if (from < activeTab && activeTab <= to) nextActive = activeTab - 1;
          else if (to <= activeTab && activeTab < from) nextActive = activeTab + 1;
          setTabs(nextTabs);
          setActiveTab(nextActive);
          applyTab(nextTabs[nextActive]);
        },
        [activeTab, applyTab, snapshotActiveTab, tabs],
      );

      /** A tab's label: the same words the breadcrumb's last crumb uses. */
      const titleOfScope = useCallback(
        (id) => {
          const node = tree?.nodes?.[id];
          // A shortcut has no name of its own: the tab reads what the row reads.
          const label = FIXED_META[id]?.label ?? nodeLabel(node, tree, (sid) => sessionsById.get(sid) ?? null);
          return label || T("会话");
        },
        [tree],
      );

      /** A tab's glyph, following the same node-kind table as the tree. */
      const iconOfScope = useCallback(
        (id) => {
          const meta = FIXED_META[id];
          if (meta) return meta.icon;
          return iconOfNode(tree?.nodes?.[id], tree);
        },
        [tree],
      );

      // Tab and window shortcuts, registered apart from Escape/F2 so this
      // effect's dependency list stays about tabs and the chrome key.
      // Ctrl+T / Ctrl+W are the browser's own pair, so a panel that draws tabs
      // has to claim them while focused; Ctrl+Tab cycles and Ctrl+1…9 jumps.
      useEffect(() => {
        const onKey = (event) => {
          if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
          const element = event.target;
          const typing =
            element &&
            (element.tagName === "INPUT" ||
              element.tagName === "TEXTAREA" ||
              element.isContentEditable);
          if (typing || dialogOpenRef.current) return;
          // Shift+D is 在独立窗口中打开; everything below is shift-free.
          if (event.shiftKey) {
            if (event.key.toLowerCase() === "d") {
              event.preventDefault();
              openDetachedWindowRef.current?.();
              return;
            }
            if (event.key === "Tab" && tabs.length > 1) {
              event.preventDefault();
              switchTab((activeTab - 1 + tabs.length) % tabs.length);
            }
            return;
          }
          const key = event.key.toLowerCase();
          if (key === "t") {
            event.preventDefault();
            addTab();
            return;
          }
          if (key === "w") {
            event.preventDefault();
            closeTab(activeTab);
            return;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            if (tabs.length > 1) switchTab((activeTab + 1) % tabs.length);
            return;
          }
          if (/^[1-9]$/.test(event.key)) {
            const index = Number(event.key) - 1;
            if (index < tabs.length) {
              event.preventDefault();
              switchTab(index);
            }
          }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [activeTab, addTab, closeTab, switchTab, tabs]);


      // The scope's rows are a projection (13c-hook-tree-view.js); the panel
      // only names the inputs it already holds.
      const {
        liveSessions,
        sessionsInScope,
        scopeBase,
        filteredInScope,
        current,
        focusNode,
        sessionsById,
        parent,
        currentChildren,
      } = useTreeView({ allSessions, data, tree, scope, selected, listSettings, query, searchScopes, filter });

      /**
       * 在会话资源管理器查看 — land on one session from outside the panel.
       *
       * The home container is where the row is really listed (the session's
       * workspace folder, or 所有会话 when it has no home), so navigating there
       * is what makes the selection visible instead of marking a row the list
       * is not showing. A trashed session is reached through 回收站, the only
       * container that can still describe it.
       */
      const revealSession = useCallback(
        (sessionId) => {
          const session = sessionsById.get(sessionId) ?? null;
          if (!session) {
            // The request can arrive before this surface knows any session at
            // all: the detached window is opened *by* a reveal, so the command
            // is already waiting in the bus while the window is still loading
            // its first snapshot. Queue it instead of dropping it — the effect
            // below spends it on the first snapshot that contains the session.
            pendingReveal = sessionId;
            // A window that has been on screen since before the session existed
            // is the other way to miss it, and that one has an answer: ask the
            // host to look again. `load(true)` keeps the snapshot on screen
            // while it runs (phase "refreshing"), and the queue above is what
            // carries the request across it.
            if (data) load(true);
            return;
          }
          // A home naming a node that is gone degrades to 所有会话 — the same
          // rule the tree rules apply to a virtual placement.
          const home = session.trashed
            ? FIXED.trash
            : session.home && tree?.nodes?.[session.home]
              ? session.home
              : FIXED.all;
          navigate(home);
          setSelected(sessionId);
        },
        [data, load, navigate, sessionsById, tree],
      );
      // DSH's header and row menu call this. Assigned on every render so the
      // closures they reach always see the current snapshot.
      bridgeActions.reveal = revealSession;
      // A request queued while the panel was closed — or while it was still
      // loading — is honoured once the first snapshot that contains that
      // session arrives. A snapshot that has arrived *without* it settles the
      // question: the session was purged (or this window is reading another
      // data directory), and waiting for it to appear would be waiting
      // forever, which would pin the panel open on a queued reveal.
      useEffect(() => {
        const wanted = pendingReveal;
        if (!wanted) return;
        if (!sessionsById.has(wanted)) {
          if (data) pendingReveal = null;
          return;
        }
        pendingReveal = null;
        revealSession(wanted);
      }, [data, sessionsById, revealSession]);
      // The same idea for 打开 / 新建会话 that arrived while this page had no
      // panel: the panel was raised *because* it is the only surface that can
      // say why a request could not be served, so the request is spent on the
      // first render that has the callbacks. The refs are assigned in this
      // render body, so they are ready by the time an effect runs.
      useEffect(() => {
        const request = pendingBridgeRequest;
        if (!request) return;
        const open = openInDshRef.current;
        const create = newSessionRef.current;
        if (!open || !create) return;
        pendingBridgeRequest = null;
        if (request.kind === "new-session") create(request.workspaceId);
        else open(request.sessionId);
      }, [sessionsById]);
      const forkSource = useMemo(
        () => (current && !current.isSubagent && current.parentSession ? sessionsById.get(current.parentSession) ?? null : null),
        [current, sessionsById],
      );
      const currentForks = useMemo(
        () => (current ? allSessions.filter((session) => !session.isSubagent && session.parentSession === current.id) : []),
        [allSessions, current],
      );

      // Selecting a child from the detail pane must also reveal it in the list,
      // which means un-collapsing its ancestors first. Under the "collapsed"
      // default that means recording an explicit expansion, not just clearing
      // the fold — otherwise the setting would fold it straight back.
      const selectAndReveal = useCallback(
        (id) => {
          if (!id) return;
          /** @type {string[]} */
          const ancestors = [];
          const self = sessionsById.get(id);
          let cursorId = self?.isSubagent ? self.parentSession ?? null : null;
          let guard = 0;
          while (cursorId && guard < 32) {
            ancestors.push(cursorId);
            const ancestor = sessionsById.get(cursorId);
            cursorId = ancestor?.isSubagent ? ancestor.parentSession ?? null : null;
            guard += 1;
          }
          if (ancestors.length > 0) {
            setCollapsed((previous) => {
              let next = previous;
              for (const ancestorId of ancestors) {
                if (!next.has(ancestorId)) continue;
                if (next === previous) next = new Set(previous);
                next.delete(ancestorId);
              }
              return next;
            });
            setExpandedChildren((previous) => {
              let next = previous;
              for (const ancestorId of ancestors) {
                if (next.has(ancestorId)) continue;
                if (next === previous) next = new Set(previous);
                next.add(ancestorId);
              }
              return next;
            });
          }
          setSelected(id);
        },
        [sessionsById],
      );

      /**
       * 打开 — the detail pane's primary action.
       *
       * DSH owns session navigation: ctx.uiWorkspace.openSession(id) swaps the
       * main view. The plugin must not invent its own route into the chat, or a
       * session opened from here would be a second, divergent main view. A
       * trashed session has no payload left for DSH to open, so it is refused
       * with a readable hint instead of a silent no-op.
       */
      // The bridge's landing point. `openInDsh` is the one function that can
      // actually navigate DSH, so the window's 打开 ends up here.
      bridgeActions.openSession = (sessionId) => openInDshRef.current?.(sessionId);
      bridgeActions.newSession = (workspaceId) => newSessionRef.current?.(workspaceId);
      bridgeActions.windowClosed = () => setDetachedOpen(false);
      bridgeActions.windowOpened = () => setDetachedOpen(true);

      const openInDsh = useCallback(
        (sessionId) => {
          if (!sessionId) return;
          const session = sessionsById.get(sessionId) ?? null;
          if (session?.trashed) {
            setHint(T("会话在回收站里，先还原才能在 DSH 中打开"));
            return;
          }
          const uiWorkspace = serviceOf("uiWorkspace");
          if (!uiWorkspace || typeof uiWorkspace.openSession !== "function") {
            setHint(T("当前 DSH 版本没有开放会话导航接口"));
            return;
          }
          try {
            uiWorkspace.openSession(sessionId);
            // In DSH the panel is an overlay, so leaving it open would cover the
            // main view the user just asked for. In the detached window the
            // panel *is* the window: closing it there would take the window away
            // the instant a session was opened. The window stays put and says
            // where the session went instead.
            if (windowHost()) setHint(T("已在 DSH 中打开"));
            else panelStore.set(false);
          } catch (error) {
            setHint(String(error?.message ?? error));
          }
        },
        [sessionsById],
      );

      const archivedInScope = filteredInScope.filter((session) => session.archived).length;
      const totalSize = filteredInScope.reduce((sum, session) => sum + (session.sizeBytes ?? 0), 0);
      const filterActive =
        filter.scope === "all" ||
        filter.favorite !== "all" ||
        filter.archived !== "all" ||
        filter.todo !== "all" ||
        filter.tags.length > 0;

      // 搜索范围, reduced to the three things the navbar needs: whether it was
      // narrowed from the default (the funnel lights up), a one-line summary for
      // the button title, and a placeholder that admits 会话名 is not being read.
      const scopesNarrowed =
        searchScopes.place !== DEFAULT_SEARCH_SCOPES.place ||
        searchScopes.name !== DEFAULT_SEARCH_SCOPES.name ||
        searchScopes.tags !== DEFAULT_SEARCH_SCOPES.tags ||
        searchScopes.note !== DEFAULT_SEARCH_SCOPES.note ||
        searchScopes.content !== DEFAULT_SEARCH_SCOPES.content;
      const scopeSummary =
        [
          searchScopes.place === "here" ? T("当前目录") : null,
          searchScopes.name ? T("会话名") : null,
          searchScopes.tags ? T("标签") : null,
          searchScopes.note ? T("备注") : null,
          searchScopes.content ? T("会话内容") : null,
        ]
          .filter(Boolean)
          .join(" · ") || T("（未选择）");
      const searchOnlyContent = searchScopes.content && !searchScopes.name && !searchScopes.tags && !searchScopes.note;
      // The placeholder is the only place the box says what it will read, so it
      // has to say where too once 搜索位置 leaves the default.
      const scopePlaceholder =
        searchScopes.place === "here"
          ? searchOnlyContent
            ? T("在当前目录搜索会话内容（Ctrl+E）")
            : T("在当前目录搜索（Ctrl+E）")
          : searchOnlyContent
            ? T("搜索会话内容（Ctrl+E）")
            : T("搜索标题 / 备注 / 标签（Ctrl+E）");
      const contentPending =
        Boolean(searchScopes.content && query.trim()) &&
        Boolean(contentState) &&
        contentState.ready !== true &&
        contentState.error !== true;

      const crumbs = useMemo(() => crumbsFor(tree, scope), [tree, scope]);

      const toggleExpanded = useCallback((id) => {
        setExpanded((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }, []);


      /**
       * Open or fold one parent's delegations.
       *
       * The caret flips whatever the list is currently showing, so it records
       * the override in the set that matches the setting: folding under an
       * "expanded" default goes into `collapsed`, opening under a "collapsed"
       * default goes into `expandedChildren`. Both sets are cleared of the
       * other's id, so the two can never disagree about one parent.
       */
      const toggleChildren = useCallback(
        (id) => {
          const wasCollapsed = effectiveCollapsed.has(id);
          setCollapsed((previous) => {
            const next = new Set(previous);
            if (wasCollapsed) next.delete(id);
            else next.add(id);
            return next;
          });
          setExpandedChildren((previous) => {
            const next = new Set(previous);
            if (wasCollapsed) next.add(id);
            else next.delete(id);
            return next;
          });
        },
        [effectiveCollapsed],
      );

      // The four row gestures live in 13d-hook-session-selection.js; the state
      // they write stays here because the toolbar reads it too.
      const { selectRow, highlightNode, checkRow, marqueeStart } = useSessionSelection({
        setSelected,
        setChecked,
        tree,
        filteredInScope,
        checked,
        selected,
      });

      /** A column header picks the field; clicking the active one flips direction. */
      const cycleSort = useCallback((key) => {
        setSortKey((previous) => {
          if (previous === key) {
            setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
            return previous;
          }
          setSortDir(SORT_DEFAULT_DIR[key] ?? "desc");
          return key;
        });
      }, []);

      const resizeColumn = useCallback((event, key) => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startWidth = colWidths[key] ?? 100;
        // The strip is inside the header cell, which is a button: a press must
        // not also sort, and a drag must not also select the label text.
        const strip = event.currentTarget ?? null;
        if (strip?.classList) strip.classList.add("on");
        const move = (moveEvent) => {
          const raw = startWidth + (moveEvent.clientX - startX);
          const width = Math.max(key === "size" ? 54 : 64, Math.min(480, raw));
          setColWidths((previous) => ({ ...previous, [key]: width }));
        };
        const up = () => {
          if (strip?.classList) strip.classList.remove("on");
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }, [colWidths]);

      // 独立窗口 is a separate browser window. Until it ships, 窗口模式 is
      // the plugin's own floating surface with remembered bounds — and there is
      // deliberately no in-page drag: a titlebar that slides the panel around
      // inside DSH is not the detached window the setting promises.


      const resizePane = useCallback((event, side) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = side === "tree" ? navWidth : detailWidth;
        const move = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          if (side === "tree") setNavWidth(Math.max(180, Math.min(420, startWidth + delta)));
          else setDetailWidth(Math.max(240, Math.min(520, startWidth - delta)));
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }, [navWidth, detailWidth]);

      // Every confirmation and prompt is a DSH dialog, rendered by one host at
      // the end of the shell. `dialogs.confirm()` resolves false when the user
      // dismisses it, so callers read like the old window.confirm.
      const dialogs = useDialogs();
      // True while a dialog is on screen, so global shortcuts can stand down.
      // The notes layer (更新说明) covers the panel the way a dialog does, and
      // Escape (or Ctrl+Z, or F2) belongs to whichever surface is on top. It
      // lives with the sidebar entry, not here, so the panel has to ask it.
      dialogOpenRef.current = Boolean(dialogs.open) || notesLayer.open;

