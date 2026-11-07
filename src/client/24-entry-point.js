    // ── Entry point ────────────────────────────────────────────────────────
    function apply(ctx) {
      hostCtx = ctx;
      installStyle();

      /**
       * Commands from the detached window.
       *
       * Bound here, at apply time, not inside Panel: the window may ask for a
       * session while the panel is closed, and the *panel* is the thing that has
       * to open — so the handler has to outlive any one mount. The work itself
       * still happens inside the panel, through the refs it publishes below.
       */
      /**
       * Report the live palette so the detached window can follow the theme.
       *
       * The panel is the only surface that sees DSH's computed tokens; the
       * window is a `file://` page that cannot. This runs on mount and whenever
       * the theme flips (a `class`/attribute change on the document element is
       * how every theme plugin in DSH signals light/dark).
       */
      reportTheme();
      const observer = (() => {
        try {
          if (typeof MutationObserver !== "function" || typeof document === "undefined") return null;
          const target = document.documentElement;
          if (!target) return null;
          const mo = new MutationObserver(() => reportTheme());
          mo.observe(target, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
          return mo;
        } catch {
          return null;
        }
      })();
      ctx.effect?.(() => () => observer?.disconnect(), "session-navigator: theme observer");

      // Session states belong to the DSH page: `uiSession.sessionStatus` is a live
      // service there and a stub in the window. The panel publishes them from the
      // hook, but a page in 独立弹窗 mode has no panel mounted at all, so nothing
      // was ever announced. Subscribing here covers that page too; the two paths
      // dedupe on the snapshot itself, so the second one costs nothing.
      ctx.effect?.(
        () => {
          /** @type {{ subscribe?: Function, getSnapshot?: Function } | null} */
          let observable = null;
          let off = null;
          const announce = () => {
            if (!observable || typeof observable.getSnapshot !== "function") return;
            try {
              publishStatusSnapshot(statusRowsOf(observable.getSnapshot()));
            } catch {
              /* a broken snapshot must not break the subscription */
            }
          };
          const adopt = () => {
            if (observable) return true;
            const source = serviceOf("uiSession")?.sessionStatus ?? null;
            if (!source || typeof source.subscribe !== "function") return false;
            observable = source;
            try {
              const stop = source.subscribe(announce);
              off = typeof stop === "function" ? stop : null;
            } catch {
              off = null;
            }
            announce();
            return true;
          };
          /** @type {(() => void) | null} */
          let stopInject = null;
          if (!adopt()) {
            // The service can arrive after this plugin: ask for it rather than
            // poll, and stop asking as soon as it is there.
            try {
              stopInject = hostCtx.inject(["uiSession"], () => {
                if (!adopt()) return;
                try {
                  stopInject?.();
                } catch {
                  /* ignore */
                }
                stopInject = null;
              });
            } catch {
              stopInject = null;
            }
          }
          if (observable) {
            try {
              stopInject?.();
            } catch {
              /* ignore */
            }
            stopInject = null;
          }
          // The safety net for a state change nobody announced. `announce` is a
          // no-op when the snapshot is unchanged, so the cost of being wrong
          // about this is one projection every few seconds.
          // The same beat the window uses: a page nobody is looking at is
          // exactly when a state change still has to be announced — the panel is
          // the only side holding `uiSession`, so a throttled tick here freezes
          // the window's badges no matter how often the window asks.
          let stopTick = null;
          try {
            stopTick = startBeat(STATUS_TICK_MS, announce);
          } catch {
            stopTick = null;
          }
          return () => {
            try {
              stopTick?.();
            } catch {
              /* ignore */
            }
            try {
              stopInject?.();
            } catch {
              /* ignore */
            }
            try {
              off?.();
            } catch {
              /* ignore */
            }
          };
        },
        "session-navigator: session states",
      );

      // The window has no `uiSession` to read, so it asks the page for the rows
      // it may have missed — on arrival, and again whenever it comes back to the
      // front: a session that started waiting while the window sat in the
      // background is exactly the case this is for.
      //
      // Asking alone is not enough. The ask travels to a page that may itself be
      // in the background, where the browser throttles its timers, so the answer
      // can be late even though that page knows right away. The Host keeps the
      // newest snapshot (src/host/status-board.js) and answers out of it, and
      // reading that on a beat this window owns is the second path.
      if (windowHost()) {
        const pull = async () => {
          // No visibility gate here: this branch is the detached window (nothing
          // else has a `hostBridge`), and that window exists to be looked at
          // later — the user is elsewhere by design. One cached snapshot over
          // loopback once a second costs nothing, and it is also what notices a
          // stream that went quiet.
          try {
            const result = await apiGet("/bridge/status");
            const at = Number(result?.at ?? 0);
            if (!Number.isFinite(at) || at <= peerStatusAt) return;
            applyPeerStatus(Array.isArray(result?.rows) ? result.rows : [], at);
          } catch {
            /* the next tick asks again */
          }
        };
        // Both paths, because they fail differently: the beat still runs when
        // the page has nothing new to say, and the ask covers the first paint
        // and every return to the front without waiting a whole beat for it.
        const ask = () => {
          void sendBridgeCommand("status-request", {});
          void pull();
        };
        void ask();
        const onVisible = () => {
          try {
            if (document.visibilityState === "visible") ask();
          } catch {
            /* no document state to read */
          }
        };
        ctx.effect?.(
          () => {
            let stopPull = null;
            try {
              stopPull = startBeat(STATUS_PULL_MS, () => void pull());
            } catch {
              /* no timer is not a reason to fail a mount */
            }
            try {
              document?.addEventListener?.("visibilitychange", onVisible);
            } catch {
              /* ignore */
            }
            try {
              window.addEventListener("focus", ask);
            } catch {
              /* ignore */
            }
            return () => {
              try {
                stopPull?.();
              } catch {
                /* ignore */
              }
              try {
                document?.removeEventListener?.("visibilitychange", onVisible);
              } catch {
                /* ignore */
              }
              try {
                window.removeEventListener("focus", ask);
              } catch {
                /* ignore */
              }
            };
          },
          "session-navigator: status request",
        );
      }
      ctx.effect?.(
        () =>
          subscribeBridge((command) => {
            if (!command || typeof command.kind !== "string") return;
            // Not a command and not addressed to one document: DSH changed, and
            // both the panel and the detached window have to redraw.
            if (command.kind === "sessions-changed") {
              publishLiveUpdate(command.payload ?? null);
              return;
            }
            // Session states. The window's `uiSession` is the shim's stub, so
            // this is the only way 等待回答/等待审批 can reach it: the Host fans
            // the rows out over the same stream the commands use.
            if (command.kind === "session-status") {
              if (!windowHost()) return; // the sender hearing its own voice
              const rows = Array.isArray(command.payload?.rows) ? command.payload.rows : [];
              applyPeerStatus(rows, command.payload?.at);
              return;
            }
            // A window that just opened has never seen these rows, and the
            // broadcast that carried them may already have aged out of the bus —
            // so this answer is forced past the "nothing changed" guard.
            if (command.kind === "status-request") {
              // Only the document that owns `uiSession` can answer; the window
              // hearing its own ask would echo straight back.
              if (windowHost()) return;
              publishStatusSnapshot(undefined, true);
              return;
            }

            if (command.kind === "refresh") {
              // "my write landed, re-read". The sender is a document that cannot
              // pull DSH's baseline itself — the detached window runs in its own
              // process, so its BroadcastChannel never gets here — and the Host
              // has already dropped its header cache for this command.
              if (!windowHost()) void refreshDshViews();
              publishLiveUpdate({ reason: "bridge", refresh: true, structural: false });
              return;
            }
            if (command.kind === "open-session") {
              const id = command.payload?.sessionId;
              if (typeof id !== "string" || !id) return;
              // Only the DSH page acts on this: the window is where it comes
              // from, and the window hearing its own command would publish it
              // straight back (the shim's echo guard is a timing heuristic, not
              // a contract).
              if (windowHost()) return;
              // With the panel up, it is the one place that can both open the
              // session and explain a refusal, so it is asked first.
              if (panelStore.getSnapshot() && typeof bridgeActions.openSession === "function") {
                bridgeActions.openSession(id);
                return;
              }
              // 独立弹窗 mode: no panel is mounted here at all. Reaching for
              // `bridgeActions` in that case found null and the request simply
              // vanished — which is why double-clicking in the window opened
              // nothing in DSH.
              openSessionFromBridge(id);
              return;
            }
            if (command.kind === "new-session") {
              const workspaceId = command.payload?.workspaceId;
              const target = typeof workspaceId === "string" && workspaceId ? workspaceId : undefined;
              if (windowHost()) return;
              if (panelStore.getSnapshot() && typeof bridgeActions.newSession === "function") {
                bridgeActions.newSession(target);
                return;
              }
              newSessionFromBridge(target);
              return;
            }
            if (command.kind === "open-settings") {
              // The window cannot open DSH's settings — it has no shell — so the
              // press travels here. Nothing to open when the panel *is* the
              // window; `openSettingsFromBridge` answers false there.
              void openSettingsFromBridge();
              return;
            }
            if (command.kind === "reveal") {
              // Only the window follows this. The DSH page is where it comes
              // from when 默认打开方式 is 独立弹窗, and a page acting on its own
              // request would raise the panel over the window it just opened.
              if (!windowHost()) return;
              const id = command.payload?.sessionId;
              if (typeof id !== "string" || !id) return;
              if (typeof bridgeActions.reveal === "function") bridgeActions.reveal(id);
              else pendingReveal = id;
              return;
            }
            if (command.kind === "window-open") {
              // The Host saw the window's first `hello`. Nothing to do in the
              // window itself, but the panel's 独立窗口 button now says 聚焦.
              if (!windowHost()) bridgeActions.windowOpened?.();
              return;
            }
            if (command.kind === "changed") {
              // A write landed somewhere — this document or the other one. The
              // list, the tags and the bins are all drawn from the same
              // bootstrap payload, so both surfaces re-read it. The sender is
              // included: its own reload already happened, and the debounce
              // folds the second one into it.
              publishLiveUpdate({ reason: "write", refresh: true, structural: false });
              return;
            }
            if (command.kind === "theme-changed") {
              // The window loaded the palette once. A flip in DSH does not reach
              // it through the stylesheet, so the shim repaints from /theme.
              if (windowHost()) shimHooks()?.applyTheme?.();
              return;
            }
            if (command.kind === "lang-changed") {
              // Same shape: the window's dictionary is fixed at load, so the only
              // way to switch is a reload with the other ?lang=.
              const lang = normalizeLang(command.payload?.lang);
              if (windowHost() && lang) shimHooks()?.setLang?.(lang);
              return;
            }
            if (command.kind === "window-closed") bridgeActions.windowClosed?.();
          }),
        "session-navigator: bridge",
      );
      ctx.effect?.(() => ctx.locale.register(NS, LOCALE_TABLES), "session-navigator: dictionaries");

      // The panel entry lives in the sidebar footer.
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({
          name: "sidebar.footer.action",
          id: "session-navigator-footer",
          order: 40,
          locale: NS,
        }, FooterAction),
      );

      // The settings page lives in the settings window's own nav. `label` is a
      // thunk so the entry follows a language switch without re-registering the
      // slot, exactly as DSH's own sections do. `order: 510` puts it after the
      // built-in sections.
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({
          name: "settings.section",
          id: "session-navigator",
          order: 510,
          label: () => ctx.locale.bind(NS)("navLabel"),
          locale: NS,
        }, SettingsSection),
      );

      /**
       * Capture the shell's `openSection` without showing anything.
       *
       * The onboarding roster mounts one step at a time and waits for each to
       * either render or call `complete()`. This step does both — it takes the
       * function it was handed and completes on the spot — so it costs one
       * render and leaves no UI behind.
       */
      ctx.slots.inject("settings.onboarding", () =>
        ctx.slots.register({
          name: "settings.onboarding",
          id: "session-navigator-opener",
          // Late: any real onboarding step should paint first.
          order: 900,
          locale: NS,
        }, (props) => {
          if (typeof props?.openSection === "function") openSettingsSection = props.openSection;
          // The roster hands a fresh props object on every render, so an effect
          // keyed on `props` completed this step again and again. One call, once
          // mounted: completing during render would warn.
          const completeRef = React.useRef(props?.complete);
          completeRef.current = props?.complete;
          React.useEffect(() => { completeRef.current?.(); }, []);
          return null;
        }),
      );

      // DSH's own session surfaces reuse the panel's writes: five buttons above
      // the conversation area, two entries in the sidebar row's "…" menu. Both
      // register here, in the shell, not in the panel — they have to work while
      // the panel is closed.
      ctx.slots.inject("conversation.session.header.actions", () =>
        ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "session-navigator-header",
          // After DSH's own title-bar actions; the preset chip sits at -10.
          order: 60,
          locale: NS,
        }, SessionHeaderActions),
      );

      // One component carries both rows: the slot takes one component per
      // injection, and two rows in one element cannot be split by ordering.
      ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
        ctx.slots.register({
          name: "sidebar.workspaces.session.menu.item",
          id: "session-navigator-rows",
          // DSH's own entries run 100–450; these two follow them.
          order: 500,
          locale: NS,
        }, SessionMenuItems),
      );
    }

