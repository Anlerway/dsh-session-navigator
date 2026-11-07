    // ── Panel store ────────────────────────────────────────────────────────
    // A single boolean, but it lives outside React so both the sidebar button
    // and the panel itself can drive it, and so a second entry point added
    // later does not need a context provider threaded through the host tree.
    //
    // A close also carries *why* it happened. Inside DSH the panel is an
    // overlay, so closing it costs nothing and every close is the same close.
    // In 独立弹窗 mode the panel is the whole surface of a window, and closing
    // it means the window goes away — so the window has to be able to tell a
    // close the user asked for from one the code performed on its way
    // somewhere else. That distinction only exists if the caller states it, so
    // it defaults to "auto" and the user's own gestures say "user".
    const panelStore = (() => {
      let open = false;
      let reason = "user";
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener(reason);
      };
      const set = (next, why = "auto") => {
        if (open === next) return;
        open = next;
        // An open has no reason to give; a close does, and it is the only one
        // the window reads.
        reason = next ? "open" : why;
        emit();
      };
      return {
        getSnapshot: () => open,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set,
        // The footer button is a user gesture whichever way it flips.
        toggle() {
          set(!open, "user");
        },
      };
    })();

    // ── Bridge (panel ↔ detached window) ─────────────────────────────────
    /** How often the poll asks the Host for anything the stream did not deliver. */
    const BRIDGE_POLL_MS = 4000;

    /**
     * The burst flushers of every live bridge subscription.
     *
     * Nothing in the product reads this: the timer flushes a burst on its own.
     * A test delivers its frames and then asks for the burst directly, which is
     * the only way to assert on it without sleeping past BURST_MS.
     */
    const burstFlushers = new Set();

    /** Apply every bridge burst still being gathered. */
    function flushBridgeBursts() {
      for (const flush of [...burstFlushers]) {
        try {
          flush();
        } catch {
          /* one subscription's bad frame must not stop the others */
        }
      }
    }

    /**
     * A repeating beat that keeps running while the document is hidden.
     *
     * Chromium throttles `setInterval` in a document nobody is looking at — once
     * a second at first, then once a minute — and the detached window spends its
     * whole life in exactly that state. A worker's timers are not tied to the
     * page's visibility, so the beat lives there and posts to the page; where a
     * worker cannot be created (no `Worker`, a CSP that refuses `blob:`), the
     * plain timer is used and behaves the way it always did.
     *
     * @param {number} everyMs
     * @param {() => void} tick
     * @returns {() => void} stop
     */
    function startBeat(everyMs, tick) {
      let fromWorker = null;
      let fallback = null;
      try {
        if (typeof Worker === "function" && typeof Blob === "function" && typeof URL?.createObjectURL === "function") {
          const url = URL.createObjectURL(new Blob(["setInterval(function () { postMessage(0); }, " + Math.max(50, everyMs) + ");"], { type: "text/javascript" }));
          const worker = new Worker(url);
          worker.onmessage = () => tick();
          // A CSP refusal surfaces here, after the constructor already returned.
          worker.onerror = () => {
            if (fallback) return;
            try {
              worker.terminate();
            } catch {
              /* gone already */
            }
            fallback = setInterval(tick, everyMs);
          };
          fromWorker = () => {
            try {
              worker.terminate();
            } catch {
              /* gone already */
            }
            URL.revokeObjectURL(url);
          };
        }
      } catch {
        fromWorker = null;
      }
      if (!fromWorker) {
        const timer = setInterval(tick, everyMs);
        timer?.unref?.();
        fallback = timer;
      }
      return () => {
        if (fallback) clearInterval(fallback);
        fallback = null;
        fromWorker?.();
        fromWorker = null;
      };
    }


    /**
     * Subscribe to the Host's command bus, and hand each command to a handler.
     *
     * The panel is the only side that holds `uiWorkspace`, so it is the only
     * side that can actually open a session or start one; the detached window
     * asks for exactly that through the Host (see src/host/bridge.js).
     *
     * An EventSource is the right shape for the fast path: push-only, it
     * reconnects by itself, and a command that arrives while nothing is open is
     * simply not delivered. The `since` cursor stops a reconnect from re-running
     * a command this document already handled.
     *
     * A stream is also the half that can die without saying so — a document
     * hidden long enough to be throttled, a connection one side believes is
     * open, a Host that was restarted underneath it. When that happened, the two
     * windows kept their old lists until DSH itself was restarted, which is the
     * report this poll exists to answer: the same bus, asked for directly. Both
     * paths run at once and `seq` makes the overlap harmless.
     *
     * @param {(command: { kind: string, payload: any }) => void} onCommand
     * @returns {() => void} unsubscribe
     */
    function subscribeBridge(onCommand) {
      let source = null;
      /** Highest sequence number this document has acted on. */
      let cursor = 0;
      /** Whether the first `ready` frame has been folded in. */
      let settled = false;
      let closed = false;

      /**
       * How long a burst of commands is collected before it is acted on.
       *
       * One thing happening is announced more than once. A turn ending drops the
       * pending question, clears the running set and raises the completion flag,
       * and each of those leaves the Host as its own command — milliseconds
       * apart, but each in a task of its own. A task per command is a render per
       * command, so the badge walked 待回答 → 进行中 → 空闲 in less time than it
       * took to read, and every step of it was true. Collected into one task
       * they are still applied in the order they arrived, but React commits
       * once, at the end, and only the last of them is ever drawn.
       *
       * Fifty milliseconds is longer than a burst of frames off one socket and
       * shorter than anything a reader can notice.
       */
      const BURST_MS = 50;

      /** Commands collected in the burst still being gathered. */
      let queued = [];
      /** Null when no burst is being gathered. */
      let burstTimer = null;

      /** Apply the burst, oldest first. */
      const flushBurst = () => {
        if (burstTimer !== null) {
          clearTimeout(burstTimer);
          burstTimer = null;
        }
        const batch = queued;
        queued = [];
        for (const command of batch) dispatch(command);
      };
      burstFlushers.add(flushBurst);

      /**
       * Hold one command until the burst it arrived in is over.
       *
       * Nothing is lost or reordered: a burst is applied as a sequence, exactly
       * as the frames arrived. Only the drawing waits, and only until the last
       * frame of the burst is in.
       */
      const enqueue = (command) => {
        if (closed || !command || typeof command.kind !== "string") return;
        queued.push(command);
        if (burstTimer !== null) return;
        burstTimer = setTimeout(flushBurst, BURST_MS);
      };

      /** Hand one command on, unless it is one of the frames already seen. */
      const dispatch = (command) => {
        if (closed || !command || typeof command.kind !== "string") return;
        if (Number.isFinite(command.seq)) {
          if (command.seq <= cursor) return;
          cursor = command.seq;
        }
        try {
          onCommand(command);
        } catch {
          /* one bad command must not stop the stream */
        }
      };

      /**
       * The stream's opening frame.
       *
       * A first connection replays up to 30 s of live traffic — including an
       * "open session" the user clicked before this document existed. A panel
       * mounting must not act on that history: its own load is newer.
       */
      const onReady = (event) => {
        let payload = null;
        try {
          payload = JSON.parse(event.data);
        } catch {
          /* a malformed frame is not worth tearing the stream down for */
          return;
        }
        if (!Number.isFinite(payload?.cursor)) return;
        if (payload.cursor < cursor) {
          // The Host restarted: the bus starts over at zero, and everything that
          // moved while this document was not connected was never announced.
          // Reloading is the only honest answer — the alternative is a list that
          // stays wrong until DSH is restarted again.
          cursor = payload.cursor;
          settled = true;
          try {
            onCommand({ kind: "sessions-changed", payload: { reason: "host-restart", refresh: true, structural: true } });
          } catch {
            /* a handler that throws on a reload hint loses only the hint */
          }
          return;
        }
        if (!settled) {
          cursor = Math.max(cursor, payload.cursor);
          settled = true;
        }
      };

      /** One command frame from the bus. */
      const onFrame = (event) => {
        let command = null;
        try {
          command = JSON.parse(event.data);
        } catch {
          return;
        }
        enqueue(command);
      };

      /**
       * Open the stream where this document has got to.
       *
       * EventSource reconnects by itself after a dropped connection, but it can
       * also settle into CLOSED and stay there: a Host restart, a proxy that gave
       * up, a renderer that was away long enough for the retry to fail. From this
       * side a closed stream looks exactly like an idle one — no frames, and an
       * error event that says nothing — so it is reopened on the two signals that
       * do exist: an error that leaves `readyState` CLOSED, and the poll tick.
       */
      const openStream = () => {
        if (typeof EventSource !== "function") return;
        try {
          source = new EventSource(API + "/bridge/events?since=" + cursor);
        } catch {
          source = null;
          return;
        }
        source.addEventListener("ready", onReady);
        source.addEventListener("command", onFrame);
        source.onerror = (event) => {
          const target = event?.currentTarget;
          // 2 is EventSource.CLOSED; CONNECTING (0) is the browser retrying on
          // its own, which a second stream would only fight.
          if (target && target === source && target.readyState === 2) reopenStream();
        };
      };

      /** Replace a stream that will not come back, keeping the position. */
      const reopenStream = () => {
        if (closed) return;
        const dead = source;
        source = null;
        try {
          dead?.close();
        } catch {
          /* already closed */
        }
        openStream();
      };

      openStream();

      /**
       * @param {boolean} baseline take the bus’s position without replaying it
       */
      const poll = async (baseline) => {
        if (closed) return;
        try {
          const response = await fetch(API + "/bridge/poll?since=" + cursor, {
            credentials: "same-origin",
            headers: { accept: "application/json" },
          });
          const payload = await response.json();
          if (!payload || payload.ok !== true) return;
          const commands = payload.result?.commands ?? [];
          if (baseline && !settled) {
            // No ready frame has arrived, so this answer is entirely history —
            // the same 30 s of traffic the stream would have replayed. Mounting
            // is newer than all of it: take the position, do not act on it.
            settled = true;
            let at = Number(payload.result?.cursor);
            if (!Number.isFinite(at)) {
              at = 0;
              for (const command of commands) {
                if (Number.isFinite(command?.seq) && command.seq > at) at = command.seq;
              }
            }
            cursor = Math.max(cursor, at);
            return;
          }
          for (const command of commands) enqueue(command);
        } catch {
          /* a failed poll is retried on the next tick; the stream may still work */
        }
      };
      const stopPolling = typeof setInterval === "function" ? startBeat(BRIDGE_POLL_MS, () => {
          // The detached window is a monitor by design: the user is looking at
          // something else precisely while it runs, so it must keep asking. Only
          // a page in a browser tab has a reason to idle while hidden.
          if (!windowHost()) {
            try {
              if (document.visibilityState === "hidden") return;
            } catch {
              /* no document: nothing to be hidden */
            }
          }
          // A stream that died did not say so (see openStream): the tick is the
          // one place that can tell "quiet" from "closed".
          if (source && source.readyState === 2) reopenStream();
          void poll(!settled);
      }) : () => {};

      return () => {
        closed = true;
        stopPolling();
        burstFlushers.delete(flushBurst);
        if (burstTimer !== null) {
          clearTimeout(burstTimer);
          burstTimer = null;
        }
        queued = [];
        try {
          source?.close();
        } catch {
          /* already closed */
        }
      };
    }

