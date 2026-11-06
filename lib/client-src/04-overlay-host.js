    // ── Live session updates (Host → this document) ──────────────────────
    /**
     * DSH's own changes, pushed by the Host.
     *
     * `sessions-changed` arrives on the same bus as the window's commands, with
     * `{ reason, reasons, refresh, structural, running }` (see
     * lib/host/session-sync.js). Two documents need it — the panel and the
     * detached window — and both mount the same Panel component, so the channel
     * lives at module scope: one bridge subscription, any number of panels.
     */
    const liveSubscribers = new Set();

    /** @param {any} payload */
    function publishLiveUpdate(payload) {
      for (const listener of [...liveSubscribers]) {
        try {
          listener(payload);
        } catch {
          /* one broken panel must not stop the others */
        }
      }
    }

    /**
     * @param {(payload: any) => void} listener
     * @returns {() => void} unsubscribe
     */
    function subscribeLiveUpdates(listener) {
      liveSubscribers.add(listener);
      return () => {
        liveSubscribers.delete(listener);
      };
    }

    /**
     * Re-stamp `running` on a bootstrap payload, keeping every other field.
     *
     * A badge flip is the one change that must not cost a filesystem walk: the
     * Host sends the live set with the event, so the rows it names are patched in
     * place. Rows are replaced rather than mutated because the list renders from
     * their identity, and `view.live` / `view.trashed` share those very objects
     * — all three are re-stamped together so no surface keeps the old answer.
     *
     * @param {any} data the bootstrap payload
     * @param {Set<string>} running
     * @returns {any}
     */
    function withRunning(data, running) {
      if (!data || !(running instanceof Set)) return data;
      const patch = (session) =>
        session && session.running !== running.has(session.id) ? { ...session, running: running.has(session.id) } : session;
      // Identity is preserved when nothing flipped, so a status event that does
      // not touch this listing costs no render at all.
      const patchList = (list) => {
        if (!Array.isArray(list)) return list;
        let changed = false;
        const mapped = list.map((session) => {
          const patched = patch(session);
          if (patched !== session) changed = true;
          return patched;
        });
        return changed ? mapped : list;
      };
      const sessions = patchList(data.sessions);
      const trashed = patchList(data.trashed);
      let view = data.view;
      if (view) {
        const patched = { ...view };
        for (const key of ["sessions", "live", "trashed"]) patched[key] = patchList(view[key]);
        const changed = patched.sessions !== view.sessions || patched.live !== view.live || patched.trashed !== view.trashed;
        if (changed) view = patched;
      }
      if (sessions === data.sessions && trashed === data.trashed && view === data.view) return data;
      return { ...data, sessions, trashed, view };
    }

    /**
     * Make DSH's own sidebar converge after a write DSH did not perform.
     *
     * The plugin relocates payloads and edits the durable stores behind DSH's
     * back, so DSH emits nothing: no `session/disposed`, no `api-session/*`.
     * The sidebar therefore keeps listing a conversation whose log went to 回收站,
     * keeps missing one that was restored, and keeps a moved row on its old
     * directory — the "移动后会话在 DSH 不显示" report — until the app restarts
     *.
     *
     * `sessions.refresh()` is DSH's own baseline pull
     * (`ClientSessions.refresh` → `refreshList`, documented as "Refresh the
     * real Session baseline, reusing an in-flight pull"), and it is the only
     * official one available to a client plugin. `workspaces.refresh()` was
     * called here too and never existed: `WorkspaceController` has no such
     * method (`@deepseek-ai/dsh-api-workspace-controller`, client service),
     * because **grouping is pushed, not pulled** — the
     * Host's `WorkspaceFeed` listens for `domain/changed` and forwards an
     * upsert frame carrying `sessionIds` to every connected client. Our moves
     * write through `attachSession` / `detachSession`
     * (lib/host/move.js:408,413), so they emit that event themselves and a moved
     * session changes group without anyone asking for it.
     *
     * The pull is repeated because `session.list` answers from the projection
     * checkpoint, which a write publishes a moment after it returns: a baseline
     * taken in the same tick can still carry the pre-move directory.
     *
     * Module scope, not the panel's: a row menu and the header menu delete
     * sessions too, and they are not rendered by the panel.
     */
    async function refreshDshViews() {
      const pull = async () => {
        const sessions = serviceOf("sessions");
        // A rejected pull is DSH's own business (offline transport, superseded
        // generation); the write the caller asked for already landed.
        await Promise.resolve(typeof sessions?.refresh === "function" ? sessions.refresh() : undefined).catch(() => {});
      };
      await pull();
      setTimeout(() => {
        void pull();
      }, 250);
      setTimeout(() => {
        void pull();
      }, 900);
    }

    /**
     * Whether this document is able to ask DSH for a fresh session list.
     *
     * Only the document DSH rendered owns a `sessions` service worth calling.
     * The window's shim answers `refresh` with an empty function — it has no
     * baseline of its own to re-pull — so asking "is there a refresh?" is not
     * enough out there: it would say yes and then do nothing. That asymmetry is
     * why deleting in the detached window left DSH's own sidebar stale while the
     * same delete in the panel refreshed it.
     *
     * @returns {boolean}
     */
    function canRefreshDsh() {
      if (windowHost()) return false;
      const sessions = serviceOf("sessions");
      return typeof sessions?.refresh === "function";
    }

    /**
     * Ask the Host to hand a command to the DSH page.
     *
     * Fire-and-forget, like every bridge command: the write that prompted it has
     * already landed, and a refused or lost command costs a stale sidebar until
     * the next one.
     *
     * @param {string} kind
     * @param {any} [payload]
     */
    function sendBridgeCommand(kind, payload) {
      try {
        return fetch(API + "/bridge/commands", {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ kind, payload: payload ?? {} }),
        }).catch(() => null);
      } catch {
        return Promise.resolve(null);
      }
    }

    /**
     * Make DSH's own session list catch up after a write this document made.
     *
     * The panel can pull the baseline itself. A detached window cannot — its
     * `sessions` service is the shim's empty stub — and a BroadcastChannel does
     * not leave the process, so the ask has to travel through the Host bridge to
     * the document that can. Without this hop, deleting in the window left DSH's
     * sidebar listing a conversation whose log was already gone.
     *
     * @returns {Promise<void>} resolves once the pull this document could do is
     *   done; the bridge hop is fire-and-forget, so a window resolves at once
     */
    function requestDshRefresh() {
      if (canRefreshDsh()) return refreshDshViews();
      void sendBridgeCommand("refresh", {});
      return Promise.resolve();
    }

    /**
     * A trash / restore write, followed by DSH's own pull.
     *
     * The bin moves payloads between this plugin and the session store; DSH
     * never hears about it (nothing emits `session/disposed`, because the kernel
     * did not do it), so without the pull its sidebar keeps a conversation whose
     * log went to 回收站, or keeps missing one that came back.
     *
     * @param {"POST" | "DELETE"} method
     * @param {string} path
     * @param {any} [body]
     * @param {{ ifMatch?: boolean }} [options]
     */
    async function binWrite(method, path, body, options) {
      const result = await apiSend(method, path, body, options);
      await requestDshRefresh();
      return result;
    }

    // ── Overlay host ──────────────────────────────────────────────────────
    // The sidebar has `overflow: hidden`, so a panel rendered inside the footer
    // slot would be clipped. Render into a fixed layer appended to <body>
    // instead. 1050 sits above DSH's 1000 backdrop tier and below its 1100
    // tooltip tier.
    let overlayRootElement = null;
    function getOverlayRoot() {
      if (typeof document === "undefined" || !document.body) return null;
      const alive = overlayRootElement && document.body.contains(overlayRootElement);
      let element = alive ? overlayRootElement : document.getElementById("dsh-session-navigator-overlay-root");
      if (!element) {
        element = document.createElement("div");
        element.id = "dsh-session-navigator-overlay-root";
        Object.assign(element.style, {
          position: "fixed",
          inset: "0",
          zIndex: "1050",
          pointerEvents: "none",
          overflow: "visible",
        });
        document.body.appendChild(element);
      }
      overlayRootElement = element;
      return overlayRootElement;
    }

    /**
     * Resolve `createPortal` defensively.
     *
     * The shared `react` the module loader hands out is a thin re-export: it
     * carries the hooks but not always the DOM renderer, and `react-dom` is not
     * guaranteed to be listed as a resolvable module for a plugin. Every source
     * the reference plugin uses is tried in turn; if none resolves we fall back
     * to rendering in place, which still works (the panel is fixed-position) but
     * would be clipped by the sidebar's `overflow: hidden`.
     */
    let cachedCreatePortal;
    function getPortalFn() {
      if (cachedCreatePortal !== undefined) return cachedCreatePortal;
      const candidates = [];
      if (typeof React.createPortal === "function") candidates.push(React.createPortal);
      if (typeof window !== "undefined") {
        if (typeof window.__smReactDOM?.createPortal === "function") candidates.push(window.__smReactDOM.createPortal);
        if (typeof window.ReactDOM?.createPortal === "function") candidates.push(window.ReactDOM.createPortal);
        if (typeof window.React?.createPortal === "function") candidates.push(window.React.createPortal);
      }
      if (typeof require === "function") {
        for (const id of ["react-dom", "react-dom/client"]) {
          try {
            const dom = require(id);
            if (typeof dom?.createPortal === "function") {
              candidates.push(dom.createPortal);
              break;
            }
          } catch {
            /* not resolvable for this plugin — try the next source */
          }
        }
      }
      cachedCreatePortal = candidates[0] ?? null;
      return cachedCreatePortal;
    }

    function portal(node) {
      const root = getOverlayRoot();
      const createPortal = getPortalFn();
      if (!root || typeof createPortal !== "function") return node;
      return createPortal(node, root);
    }

    /**
     * Portal a fragment into the overlay root.
     *
     * The panel is two siblings — the scrim and the shell — and the scrim has to
     * paint *behind* the shell without being inside it. Wrapping both in a
     * fragment keeps that relationship while still using a single portal.
     *
     * @param {any[]} children
     * @returns {any}
     */
    function portalFragment(children) {
      const root = getOverlayRoot();
      const createPortal = getPortalFn();
      if (!root || typeof createPortal !== "function") {
        return h(React.Fragment, null, ...children);
      }
      return createPortal(h(React.Fragment, null, ...children), root);
    }

