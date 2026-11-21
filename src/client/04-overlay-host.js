    // ── Live session updates (Host → this document) ──────────────────────
    /**
     * DSH's own changes, pushed by the Host.
     *
     * `sessions-changed` arrives on the same bus as the window's commands, with
     * `{ reason, reasons, refresh, structural, running }` (see
     * src/host/session-sync.js). Two documents need it — the panel and the
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
     * (src/host/move.js:408,413), so they emit that event themselves and a moved
     * session changes group without anyone asking for it.
     *
     * The pull is repeated because `session.list` answers from the projection
     * checkpoint, which a write publishes a moment after it returns: a baseline
     * taken in the same tick can still carry the pre-move directory.
     *
     * Module scope, not the panel's: a row menu and the header menu delete
     * sessions too, and they are not rendered by the panel.
     *
     * @param {{ removed?: string[] }} [options] sessions a trash write took out
     *   of DSH's tree; when DSH's own removal frame covers them, no baseline is
     *   pulled at all (see {@link applyDshRemovals})
     */
    async function refreshDshViews(options = {}) {
      const removed = Array.isArray(options.removed) ? options.removed : [];
      // A delete has an exact answer, and asking for the whole baseline to learn
      // it is what loses neighbouring rows.
      if (removed.length > 0 && applyDshRemovals(removed)) return;
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
     * Apply DSH's own per-session removal frames instead of pulling its list.
     *
     * `ClientSessions.handleSessionRemoved` is the frame DSH itself applies when
     * the Host disposes a session: it records `{ kind: "remove", sessionId }` on
     * the list snapshot (dropping that one row), ends the session's residency and
     * prunes its engagement. It is documented as the entry point for a
     * "remotely forwarded Session removal", which is exactly what a delete in
     * this plugin is — the Host never emits `session/disposed` for a session the
     * kernel did not dispose, and emits nothing at all for one that was cold.
     *
     * A delete must not become a baseline pull. `sessions.refresh()` merges the
     * server's answer as a **new baseline**, and that merge drops every identity
     * the answer does not name — including the placeholder row of a session this
     * client is in the middle of creating. One delete followed by a pull is
     * therefore enough to lose an unrelated conversation from the sidebar, which
     * then refuses to open at all (`sessions.retain: unknown session`) until the
     * app restarts: the "删了 A，切到 B 就没了" report.
     *
     * @param {string[]} ids sessions the Host actually took out of its tree
     * @returns {boolean} whether DSH's own frame existed and was applied
     */
    function applyDshRemovals(ids) {
      if (windowHost()) return false;
      const sessions = serviceOf("sessions");
      if (typeof sessions?.handleSessionRemoved !== "function") return false;
      const removed = new Set();
      let applied = false;
      for (const id of Array.isArray(ids) ? ids : []) {
        if (typeof id !== "string" || !id) continue;
        try {
          sessions.handleSessionRemoved(id);
          removed.add(id);
          applied = true;
        } catch {
          /* a refusing frame leaves the row to the next baseline pull */
        }
      }
      // The row is half the job: the main view can be standing on the session
      // that just left, and a view holding a dead id turns the next click into
      // "会话无效" (see {@link dropRemovedMainView}).
      if (applied) dropRemovedMainView(removed);
      return applied;
    }

    /**
     * Let go of the main view when the session it was showing has just left.
     *
     * `uiWorkspace.archiveSession` already does this after archiving
     * (`uiworkspace/lib/client.js:1544-1547`): `if (this.mainReference?.sessionId
     * === sessionId) this.clearMain()`. What `clearMain` does is the whole
     * requirement - drop the reference, empty the persisted selection
     * (`dsh.sessions.current`), release the view - so the next navigation does
     * not start from an id DSH can no longer retain: that is the "删完再切换，
     * 打开会话显示无效" half of the report.
     *
     * Only the *current* session needs it. Deleting some other row must leave
     * the open conversation exactly where it is, which is what
     * dsh-session-manager's `test/client-delete-navigation.test.mjs` pins down
     * for the same reason.
     *
     * @param {Set<string>} removed ids the removal frames accepted
     * @returns {boolean} whether the main view was released
     */
    function dropRemovedMainView(removed) {
      const uiWorkspace = serviceOf("uiWorkspace");
      if (typeof uiWorkspace?.clearMain !== "function") return false;
      let current;
      try {
        current = uiWorkspace.mainReference?.sessionId ?? uiWorkspace.selection?.getSnapshot?.()?.sessionId;
      } catch {
        current = undefined;
      }
      if (typeof current !== "string" || !removed.has(current)) return false;
      try {
        uiWorkspace.clearMain();
        return true;
      } catch {
        /* a refusing view belongs to DSH's own archive path, not here */
        return false;
      }
    }

    /**
     * The sessions a trash write actually took out of DSH's tree.
     *
     * `/trash` answers with the ids it moved (`trashed`) and the ones it refused
     * (`skipped`). Only the first list left DSH's store, so only it may be
     * dropped from DSH's sidebar; a write that threw never reaches here.
     *
     * @param {string} path the endpoint the write used
     * @param {any} body what the write asked for
     * @param {any} result what the Host answered with (`{ trashed, skipped, errors }`)
     * @returns {string[]} ids to remove from DSH's list
     */
    function removedIdsOf(path, body, result) {
      if (path !== "/trash") return [];
      if (Array.isArray(result?.trashed)) return result.trashed.filter((id) => typeof id === "string" && id);
      const skipped = new Set(Array.isArray(result?.skipped) ? result.skipped : []);
      return (Array.isArray(body?.ids) ? body.ids : []).filter((id) => typeof id === "string" && id && !skipped.has(id));
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
    function requestDshRefresh(options = {}) {
      const removed = Array.isArray(options.removed) ? options.removed.filter((id) => typeof id === "string" && id) : [];
      if (canRefreshDsh()) return refreshDshViews({ removed });
      void sendBridgeCommand("refresh", removed.length > 0 ? { removed } : {});
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
      await requestDshRefresh({ removed: removedIdsOf(path, body, result) });
      return result;
    }

    // ── Overlay host ──────────────────────────────────────────────────────
    // The sidebar has `overflow: hidden`, so a panel rendered inside the footer
    // slot would be clipped. Render into a fixed layer appended to <body>
    // instead.
    //
    // 900 sits *below* DSH's 1000 dialog tier on purpose. Dialogs are the app's
    // own Modal now (see dshPrimitives below), and that primitive portals to
    // <body> with a fixed 1000: a panel parked above it would paint its own
    // mask over the question it just asked. Everything the panel draws — the
    // scrim, the shell, the context menu — lives inside this one stacking
    // context, so they keep their order relative to each other either way.
    let overlayRootElement = null;
    function getOverlayRoot() {
      if (typeof document === "undefined" || !document.body) return null;
      const alive = overlayRootElement && document.body.contains?.(overlayRootElement);
      let element = alive ? overlayRootElement : document.getElementById("dsh-session-navigator-overlay-root");
      if (!element) {
        element = document.createElement("div");
        element.id = "dsh-session-navigator-overlay-root";
        Object.assign(element.style, {
          position: "fixed",
          inset: "0",
          zIndex: "900",
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

    let ballRootElement = null;
    /**
     * The ball cannot live in the panel's overlay root: that root is a
     * click-through layer (`pointer-events: none`) parked at 900 so the panel
     * never steals presses from DSH, and a child inherits the click-through
     * unless every part of it opts back in. It also cannot beat DSH's own
     * dialogs from inside a 900 context, no matter what z-index the button
     * carries.
     *
     * So the ball gets its own fixed layer with the tier dsh-pet uses for its
     * floating chrome (2147483000). The layer itself stays click-through; the
     * ball is the one element that sets pointer-events: auto.
     */
    function getBallRoot() {
      if (typeof document === "undefined" || !document.body) return null;
      const alive = ballRootElement && document.body.contains?.(ballRootElement);
      let element = alive ? ballRootElement : document.getElementById("dsh-session-navigator-ball-root");
      if (!element) {
        element = document.createElement("div");
        element.id = "dsh-session-navigator-ball-root";
        Object.assign(element.style, {
          position: "fixed",
          inset: "0",
          zIndex: "2147483000",
          pointerEvents: "none",
          overflow: "visible",
        });
        document.body.appendChild(element);
      }
      ballRootElement = element;
      return ballRootElement;
    }

    function portalBall(node) {
      const root = getBallRoot();
      const createPortal = getPortalFn();
      if (!root || typeof createPortal !== "function") return node;
      return createPortal(node, root);
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

    // ── DSH's own dialog primitives ───────────────────────────────────────
    /**
     * The app's dialog kit, when this host ships it.
     *
     * A question drawn by DSH — not by the plugin — brings what a lookalike
     * cannot: the app's mask, its focus trap, its Escape handling, its stacking
     * over every surface including this panel, and the app's own warning layout
     * for destructive actions. `require` is the module loader's resolver and
     * the primitives package is in its shim table
     * (`@deepseek-ai/dsh-client-ui-primitives`), so this resolves from inside a
     * plugin factory without a dependency of our own.
     *
     * Resolution happens once and the answer is cached either way. A host
     * without the package must fall back to the plugin's local layer on *every*
     * render rather than pay a throw per dialog, and a dialog is never allowed
     * to take the panel down with it — a missing kit is an answer, not an
     * error.
     *
     * @returns {any | null} the kit, or null when this host cannot lend one
     */
    let cachedPrimitives;
    function dshPrimitives() {
      if (cachedPrimitives !== undefined) return cachedPrimitives;
      cachedPrimitives = null;
      if (typeof require === "function") {
        try {
          const kit = require("@deepseek-ai/dsh-client-ui-primitives");
          if (kit && typeof kit.Modal === "function") cachedPrimitives = kit;
        } catch {
          /* no primitives for this plugin: the local layer draws the dialog */
        }
      }
      return cachedPrimitives;
    }

