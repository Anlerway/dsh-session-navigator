    // ── Panel hook: the live data feed ─────────────────────────────────────
    // The panel is never right by itself: DSH creates sessions while it is open,
    // the other window writes, and the row list has to catch up without the user
    // pressing anything. One hook owns that feed — the first load, the pushed
    // `sessions-changed` events, the peer's refresh, and the clock tick the
    // relative timestamps read from.

    /**
     * What one pushed `sessions-changed` payload costs this window.
     *
     * The Host grades its own news, and the grade is the whole point of the
     * split: a badge flip (`cosmetic`) is already applied in place from the
     * payload and must not reload anything; a finished turn or a new title
     * (`refresh: false`) reloads, but through the size+mtime caches rather than
     * walking the logs; a created or disposed session (`refresh: true`) buys the
     * walk. A Host from before the split sent no `cosmetic` field and used
     * `refresh: false` for exactly the badge flips, so it is read the same way.
     *
     * Pure and separate from the hook because the decision is the interface
     * between Host and Client — the part that has to stay pinned.
     *
     * @param {any} payload
     * @returns {{ reload: boolean, refresh: boolean }}
     */
    function liveAnswer(payload) {
      if (!payload) return { reload: false, refresh: false };
      const cosmetic = payload.cosmetic === true || (payload.cosmetic === undefined && payload.refresh === false);
      if (cosmetic) return { reload: false, refresh: false };
      return { reload: true, refresh: payload.refresh === true };
    }

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
          // And 入口位置: a settings write while the panel was closed still
          // has to reach the footer the moment the panel next loads.
          const entry = data?.settings?.shell?.entry?.mode;
          if (entry) entryMode.set(entry);
          entryStyle.set(data?.settings?.shell?.entry?.style);
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
      // and anything else costs exactly one reload — debounced, because one turn
      // arrives as several events.
      //
      // The reload carries the Host's own verdict on how expensive it may be. A
      // structural change (?refresh=1) walks the logs; a finished turn does not,
      // because headers, projection cache and log facts all invalidate by
      // size+mtime and the walk would answer the same numbers. The flag is sticky
      // in one direction: if any event inside the debounce window asked for the
      // walk, the one reload that answers them all takes it.
      const liveReload = useRef({ timer: 0, refresh: false });
      const reloadFromLive = useCallback(
        (refresh = true) => {
          const pending = liveReload.current;
          pending.refresh = pending.refresh || refresh === true;
          if (pending.timer) return;
          pending.timer = setTimeout(() => {
            const forced = pending.refresh;
            pending.timer = 0;
            pending.refresh = false;
            void load(forced);
          }, 300);
        },
        [load],
      );
      useEffect(() => {
        const unsubscribe = subscribeLiveUpdates((payload) => {
          if (!payload) return;
          if (Array.isArray(payload.running)) {
            const running = new Set(payload.running.map(String));
            setBoot((previous) => (previous?.data ? { ...previous, data: withRunning(previous.data, running) } : previous));
          }
          // `cosmetic` means the event only moved the running set, which the
          // lines above already applied — a reload would be spent on rows that
          // are otherwise unchanged.
          const answer = liveAnswer(payload);
          if (!answer.reload) return;
          reloadFromLive(answer.refresh);
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
          if (liveReload.current.timer) {
            clearTimeout(liveReload.current.timer);
            liveReload.current = { timer: 0, refresh: false };
          }
        };
      }, [reloadFromLive]);

      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
      }, []);
      return { load };
    }
