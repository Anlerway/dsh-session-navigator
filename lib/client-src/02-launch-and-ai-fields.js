    // ── Launch surface (默认打开方式) ──────────────────────────────────────
    /**
     * How the explorer opens when it is launched from DSH's sidebar.
     *
     * The sidebar entry mounts outside the panel, so it never sees the panel's
     * `/bootstrap` payload — but it is the *first* thing that runs, and it must
     * already know whether 浮窗 or 独立弹窗 was chosen. `GET /settings` answers
     * exactly that and nothing else (no session scan), so the launch path reads
     * it, caches it here, and the panel's own bootstrap refreshes the same cache
     * on every open; long-lived disagreements are therefore limited to a change
     * made between two launches, which is the next launch.
     */
    const openMode = { mode: "panel", readAt: 0 };

    /**
     * 会话界面按钮样式, shared by every mount of the header strip.
     *
     * The strip mounts outside the panel and is re-created for each
     * conversation, so the choice lives here instead of in one component's
     * state: a setting changed in the settings window reaches the strip that is
     * already on screen, and a remount does not flash the old layout.
     *
     * `auto` is the shipped behaviour (words, dropped when the bar is narrow);
     * `icon` hides them at every width.
     */
    const headerStyle = {
      style: "auto",
      readAt: 0,
      listeners: new Set(),
      subscribe(listener) {
        headerStyle.listeners.add(listener);
        return () => headerStyle.listeners.delete(listener);
      },
      snapshot() {
        return headerStyle.style;
      },
      set(next) {
        const style = next === "icon" ? "icon" : "auto";
        if (style === headerStyle.style) return;
        headerStyle.style = style;
        for (const listener of headerStyle.listeners) listener();
      },
    };

    // ── AI 字段 ───────────────────────────────────────────────────
    /**
     * Progress, totals and stored summaries, shared by every surface that shows
     * them: the settings group, the status bar and the session detail pane.
     *
     * One store, not one poll per surface. A batch is a single host-side queue,
     * so two surfaces polling separately would show two different counts for
     * the same run — and the status bar has to be right while the settings
     * window is shut, which is the only way 累计花费 appears in front of someone
     * who never opened settings.
     *
     * Polling is bounded by construction: a timer exists only while the host
     * says a batch is running, plus one read when a surface first mounts. An
     * idle panel asks the host nothing at all.
     */
    const summaryStore = (() => {
      const listeners = new Set();
      /** @type {any} */
      let value = {
        loaded: false,
        error: "",
        // GET /summarize/state — the queue, not the document.
        state: null,
        // GET /summaries — what is stored, and what it cost.
        sessions: {},
        spend: null,
        pending: [],
        choice: null,
      };
      /** @type {any} */
      let timer = null;
      let ticks = 0;
      let watchers = 0;

      function emit(patch) {
        value = { ...value, ...patch };
        for (const listener of listeners) listener();
      }

      function stopTimer() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      }

      function ensureTimer() {
        if (timer !== null || watchers === 0) return;
        if (!value.state?.running) return;
        timer = setTimeout(tick, 1000);
        // A browser that throttles a background tab must not keep this panel
        // alive: the timer is not a resource the page owes anyone.
        timer?.unref?.();
      }

      async function refreshDocument() {
        try {
          const data = await apiGet("/summaries");
          emit({
            loaded: true,
            readAt: Date.now(),
            error: "",
            sessions: data?.sessions ?? {},
            spend: data?.spend ?? null,
            pending: Array.isArray(data?.pending) ? data.pending : [],
            choice: data?.choice ?? null,
          });
          return data;
        } catch (failure) {
          emit({ loaded: true, error: String(failure?.message ?? failure) });
          return null;
        }
      }

      async function refreshState() {
        try {
          const data = await apiGet("/summarize/state");
          const before = value.state;
          emit({ state: data });
          // The batch just ended: the ledger and the stored summaries moved, so
          // read them once now instead of polling for them.
          if (before?.running && !data?.running) await refreshDocument();
          return data;
        } catch (failure) {
          emit({ error: String(failure?.message ?? failure) });
          return null;
        }
      }

      async function tick() {
        timer = null;
        if (watchers === 0) return;
        const state = await refreshState();
        if (!state?.running) {
          stopTimer();
          return;
        }
        // While it runs, the spent total climbs: refresh it every fifth tick
        // (5 s) rather than every second, because that read scans the library.
        ticks += 1;
        if (ticks % 5 === 0) await refreshDocument();
        ensureTimer();
      }

      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        snapshot() {
          return value;
        },
        /** Called once per mounting surface; the last one out stops the timer. */
        attach() {
          watchers += 1;
          if (watchers === 1) {
            // A mount is not a reason to re-read the whole library: the listing
            // scan behind /summaries is the expensive half, so a document read
            // less than half a minute ago is reused. The queue state is cheap
            // and is always read, because that is how a running batch is noticed.
            if (!value.loaded || Date.now() - (value.readAt ?? 0) > 30000) refreshDocument();
            refreshState().then(ensureTimer, () => {});
          }
          return () => {
            watchers = Math.max(0, watchers - 1);
            if (watchers === 0) stopTimer();
          };
        },
        refresh() {
          return Promise.all([refreshDocument(), refreshState()]);
        },
        /**
         * Queue these sessions, then take the host's answer as the new state.
         *
         * The host returns the queue it accepted, so the panel never has to
         * guess how many of the N ids were already done or already running.
         */
        async start(ids, titles, lang) {
          const state = await apiSend("POST", "/summarize", { ids, titles, lang }, { ifMatch: false });
          emit({ state, error: "" });
          ensureTimer();
          return state;
        },
        async startPending(lang) {
          const state = await apiSend("POST", "/summarize/pending", { lang }, { ifMatch: false });
          emit({ state, error: "" });
          ensureTimer();
          return state;
        },
        async cancel() {
          const state = await apiSend("POST", "/summarize/cancel", {}, { ifMatch: false });
          emit({ state });
          stopTimer();
          return state;
        },
        async forget(sessionId) {
          await apiSend("DELETE", `/summaries/${encodeURIComponent(sessionId)}`, {}, { ifMatch: false });
          await refreshDocument();
        },
        /**
         * Take one generated field over: the title becomes the session's name,
         * or the tags are merged into the user's own list.
         *
         * Two writes, two sidecars behind one route: the panels refresh
         * everything afterwards rather than patching locally, because applying a
         * title also changes the row in the tree and the header in DSH itself.
         */
        async apply(sessionId, field, tags) {
          const body = tags === undefined ? { field } : { field, tags };
          const result = await apiSend("POST", `/summaries/${encodeURIComponent(sessionId)}/apply`, body, { ifMatch: false });
          await refreshDocument();
          return result;
        },
        /** Local-only: surfaces report a refused request without re-reading. */
        noteError(message) {
          emit({ error: String(message ?? "") });
        },
        clearError() {
          emit({ error: "" });
        },
      };
    })();

    /**
     * Subscribe one component to the summary store, and keep the poller alive
     * for as long as that component is on screen.
     *
     * @returns {any}
     */
    function useSummaries() {
      const snapshot = useSyncExternalStore(summaryStore.subscribe, summaryStore.snapshot, summaryStore.snapshot);
      useEffect(() => summaryStore.attach(), []);
      return snapshot;
    }

    /**
     * Queue these sessions for summarization, with the titles the panel shows.
     *
     * The titles are passed through because a summary names the session it
     * belongs to, and a renamed row has a name the log does not contain. The
     * caller owns the refusal message: only it has the translator that knows
     * what this build calls 模型不可用.
     *
     * @param {string[]} ids
     * @param {Record<string, string>} titles
     * @param {"zh"|"en"} lang
     */
    async function summarizeSessions(ids, titles, lang) {
      return summaryStore.start(ids, titles, lang);
    }

    /**
     * One entry point for every surface that queues summaries: the context menu
     * (single session and multi-selection) and the detail pane.
     *
     * It dedupes by id, drops rows the store no longer knows, and turns a
     * refused request into a sentence through the caller's `onHint` — the host
     * answers with a code (`llm-unavailable`, `llm/RATE_LIMIT`, …) and only the
     * surface has the translator that knows what this build calls it.
     *
     * @param {{ id: string, title?: string }[]} rows
     * @param {(message: string) => void} [onHint]
     */
    async function startSummary(rows, onHint) {
      /** @type {string[]} */
      const ids = [];
      /** @type {Record<string, string>} */
      const titles = {};
      for (const row of Array.isArray(rows) ? rows : []) {
        const id = typeof row?.id === "string" ? row.id : "";
        if (id === "" || ids.includes(id)) continue;
        ids.push(id);
        titles[id] = typeof row.title === "string" && row.title !== "" ? row.title : id;
      }
      if (ids.length === 0) return;
      try {
        await summarizeSessions(ids, titles, aiLang());
        onHint?.(ids.length === 1 ? T("开始总结这个会话") : T("开始总结 {0} 个会话", [ids.length]));
      } catch (failure) {
        onHint?.(T("生成没成功：{0}", [failure?.message ?? String(failure)]));
      }
    }

    /**
     * Take one generated field over, with the caller's wording for the result.
     *
     * `done` is already translated by the caller because the three fields mean
     * different things ("renamed", "appended to the note", "tags added"), and
     * only the surface that drew the button knows which one it offered.
     *
     * `onApplied` runs after the host accepted the write: the rename lands in
     * DSH's own session record and the note/tags land in the annotations
     * document, so the list, the tag picker and the detail pane are all stale
     * until the manager re-reads the bootstrap payload.
     *
     * @param {string} sessionId
     * @param {"title"|"description"|"tags"} field
     * @param {string} done
     * @param {(message: string) => void} [onHint]
     * @param {{ tags?: string[], onApplied?: () => void }} [options]
     */
    async function applySummary(sessionId, field, done, onHint, options = {}) {
      try {
        await summaryStore.apply(sessionId, field, options.tags);
        onHint?.(done);
        options.onApplied?.();
      } catch (failure) {
        onHint?.(T("应用没成功：{0}", [failure?.message ?? String(failure)]));
      }
    }

    /** Re-read 默认打开方式; a failed read keeps 浮窗, which cannot fail. */
    async function refreshOpenMode() {
      try {
        const payload = await apiGet("/settings");
        const mode = payload?.settings?.shell?.open?.mode;
        openMode.mode = mode === "detached" ? "detached" : "panel";
        // The same document carries 会话界面按钮样式; reading it here means the
        // strip learns the current choice on its first launch and on every
        // panel launch, without a second round trip.
        headerStyle.set(payload?.settings?.shell?.header?.style);
        headerStyle.readAt = Date.now();
        openMode.readAt = Date.now();
      } catch {
        /* unreachable host: 浮窗 is the answer that always works */
      }
      return openMode.mode;
    }

    /**
     * Re-read 会话界面按钮样式 for the header strip.
     *
     * The strip mounts once per conversation, so without a short TTL every
     * conversation switch would cost a settings round trip. Five seconds is
     * short enough that a change made in the settings window is picked up the
     * next time the user looks at a header, and long enough that flicking
     * between sessions does not hammer the route.
     *
     * @returns {Promise<string>} the style the strip should draw
     */
    async function refreshHeaderStyle() {
      if (Date.now() - headerStyle.readAt < 5000) return headerStyle.snapshot();
      try {
        const payload = await apiGet("/settings");
        headerStyle.set(payload?.settings?.shell?.header?.style);
        headerStyle.readAt = Date.now();
      } catch {
        /* keep the last known choice: a failed read is not a reset */
      }
      return headerStyle.snapshot();
    }

    /**
     * A hint the launch left for the panel it is about to mount.
     *
     * The launch can fail *outside* the panel (there is no panel yet to put a
     * message in), so the message travels as module state. It is read once at
     * mount and cleared right after — it describes one launch, not a standing
     * condition — and read/clear are separate so a double-invoked state
     * initialiser cannot swallow it.
     */
    let launchHint = "";

    function peekLaunchHint() {
      return launchHint;
    }

    function clearLaunchHint() {
      launchHint = "";
    }

    /**
     * Launch the explorer where 默认打开方式 says.
     *
     * 独立弹窗 needs the Electron component. When it is missing or the window
     * refuses to open, fall back to 浮窗 and say why — an entry point that
     * swallows its own failure looks identical to a broken one.
     */
    async function launchExplorer() {
      const mode = await refreshOpenMode();
      if (mode === "detached") {
        try {
          await apiSend("POST", "/detached/open", { lang: uiLang() }, { ifMatch: false });
          panelStore.set(false);
          return;
        } catch (error) {
          // The one failure worth naming: the component is a download, not a
          // bug, and the settings page is where it comes from.
          launchHint =
            error?.code === "component-not-installed"
              ? T("独立弹窗需要先下载Electron 组件，已改用浮窗：设置 → 会话资源管理器 → Electron 组件")
              : T("独立弹窗打不开，已改用浮窗：") + String(error?.message ?? error ?? T("未知原因"));
        }
      }
      panelStore.set(true);
    }

