    // ── Panel hook: the live data feed ─────────────────────────────────────
    // The panel is never right by itself: DSH creates sessions while it is open,
    // the other window writes, and the row list has to catch up without the user
    // pressing anything. One hook owns that feed — the first load, the pushed
    // `sessions-changed` events, the peer's refresh, and the clock tick the
    // relative timestamps read from.

    /**
     * The panel's data feed.
     *
     * `revisions`, `openMode` and the update streams are factory-scope, so the
     * hook only needs the three setters Panel owns. `load` goes back out because
     * every write in the panel reloads through the same callback: one path, one
     * place where the revision numbers are folded in.
     */
    function useLiveRefresh({ setBoot, setComponentReady, setNow }) {
      const load = useCallback(async (refresh) => {
        setBoot((previous) => ({ ...previous, phase: previous.data ? "refreshing" : "loading", error: null }));
        try {
          const data = await apiGet("/bootstrap" + (refresh ? "?refresh=1" : ""));
          // Every write cites the revision of the store it touches, so the
          // numbers this window last saw have to travel with the payload.
          revisions.tree = data?.revisions?.tree ?? null;
          revisions.annotations = data?.revisions?.annotations ?? null;
          revisions.settings = data?.revisions?.settings ?? null;
          // The component phase is what enables 独立窗口, and it can change while
          // the panel is open (the settings page installs it), so every reload
          // folds the host's answer in instead of trusting the remembered one.
          setComponentReady((data?.capabilities?.component ?? "absent") === "ready");
          // Same for 默认打开方式: the settings page can change it while the
          // panel is open, and the next launch must read the new answer.
          const mode = data?.settings?.shell?.open?.mode;
          if (mode === "panel" || mode === "detached") openMode.mode = mode;
          setBoot({ phase: "ready", data, error: null });
        } catch (error) {
          setBoot({ phase: "error", data: null, error: String(error?.message ?? error) });
        }
      }, []);

      useEffect(() => {
        load(false);
      }, [load]);

      // DSH keeps changing under the panel: a conversation
      // created in DSH's own sidebar, a title the model wrote a moment later, a
      // turn that started and then ended. The Host turns those into
      // `sessions-changed`; a badge flip is patched in place from the payload,
      // and anything that moves the derived list costs exactly one reload —
      // debounced, because one turn arrives as several events and every reload
      // is a walk over the session logs.
      const liveReload = useRef(0);
      const reloadFromLive = useCallback(() => {
        if (liveReload.current) return;
        liveReload.current = setTimeout(() => {
          liveReload.current = 0;
          void load(true);
        }, 300);
      }, [load]);
      useEffect(() => {
        const unsubscribe = subscribeLiveUpdates((payload) => {
          if (!payload) return;
          if (Array.isArray(payload.running)) {
            const running = new Set(payload.running.map(String));
            setBoot((previous) => (previous?.data ? { ...previous, data: withRunning(previous.data, running) } : previous));
          }
          // `refresh: false` means the event only moved the running set, which
          // the lines above already applied — a walk would be spent on rows that
          // are otherwise unchanged.
          if (payload.refresh !== false) reloadFromLive();
        });
        // A panel that was hidden while DSH changed (a second window, a
        // minimised app) has to be right the moment it is looked at again, not
        // four seconds later: the stream kept running, but the reader's answer
        // may be older than the state the user is about to act on.
        // A write made in the other window (a delete, a move, a rename) never
        // reaches DSH, so nothing above fires for it: the peer says so itself.
        const unsubscribePeer = subscribePeer((message) => {
          if (message?.kind === "refresh") reloadFromLive();
        });
        const onVisible = () => {
          if (typeof document === "undefined" || document.visibilityState === "visible") reloadFromLive();
        };
        try {
          document?.addEventListener?.("visibilitychange", onVisible);
          window?.addEventListener?.("focus", onVisible);
        } catch {
          /* a document without events still gets the bridge's updates */
        }
        return () => {
          unsubscribe();
          unsubscribePeer();
          try {
            document?.removeEventListener?.("visibilitychange", onVisible);
            window?.removeEventListener?.("focus", onVisible);
          } catch {
            /* nothing was added */
          }
          if (liveReload.current) {
            clearTimeout(liveReload.current);
            liveReload.current = 0;
          }
        };
      }, [reloadFromLive]);

      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
      }, []);
      return { load };
    }
