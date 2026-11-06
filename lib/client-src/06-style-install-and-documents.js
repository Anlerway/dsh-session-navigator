    // ── Style installation ─────────────────────────────────────────────────
    function installStyle() {
      if (typeof document === "undefined") return;
      let element = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`);
      if (!element) {
        element = document.createElement("style");
        element.setAttribute("data-plugin-css", CSS_ID);
        document.head.appendChild(element);
      }
      if (element.textContent !== CSS) element.textContent = CSS;
    }

    /**
     * Which sidecar a write touches, and therefore which revision it must cite.
     *
     * Three stores, three counters: a folder move says nothing about the tag
     * library, and sending the wrong number would either lose a real conflict or
     * invent a fake one.
     *
     * @param {string} path
     * @returns {"tree" | "annotations" | "settings" | null}
     */
    function storeOf(path) {
      if (typeof path !== "string") return null;
      if (path.startsWith("/settings")) return "settings";
      if (path.startsWith("/tags") || path.startsWith("/annotations")) return "annotations";
      if (path.startsWith("/datadir")) return null;
      // AI 字段 keeps its own sidecar and its own revision, so a
      // summarize request must not cite the tree's — the host would answer
      // `revision-conflict` for an edit to a document nobody touched.
      if (path.startsWith("/summar")) return null;
      return "tree";
    }

    /**
     * The revision this window is looking at, per store.
     *
     * The host keeps a monotonic counter per sidecar and rejects a write whose
     * `If-Match` is behind it (`revision-conflict`). Citing it is what makes two
     * open windows safe: the second write is *told to reload* instead of
     * silently overwriting a change it never saw. Refreshed on every bootstrap
     * and after every write, because an out-of-date citation from this very
     * panel would look like a concurrent edit to the user.
     */
    const revisions = { tree: null, annotations: null, settings: null };

    function revisionOf(path) {
      const store = storeOf(path);
      const value = store ? revisions[store] : null;
      return Number.isFinite(value) ? value : null;
    }

    // ── Other documents ────────────────────────────────────────────────────
    /**
     * Everything this plugin knows lives in one library on disk: the panel in
     * the main window and the detached window are two readers of the same
     * files. Neither DSH nor the host announces a write made through the
     * panel, so a delete in one document stayed on screen in the other until
     * that document happened to reload. A BroadcastChannel carries the two
     * facts the other side cannot derive:
     *
     *  - `refresh` — a write landed, re-read the snapshot;
     *  - `status` — the session states, which only the window with DSH's
     *    client services can see. The detached window has no `uiSession`, so
     *    without this it can never say 等待回答 / 等待审批.
     *
     * The channel is per-origin and never delivers a message to the document
     * that posted it, which is exactly the wanted scope: same-origin peers
     * hear it, the writer does not reload what it just wrote.
     */
    const peerChannel = (() => {
      try {
        if (typeof BroadcastChannel !== "function") return null;
        const channel = new BroadcastChannel("dsh-session-navigator");
        // Node hands back a channel with a live handle; a render smoke test that
        // imports this file would never exit while it is open.
        channel.unref?.();
        return channel;
      } catch {
        return null;
      }
    })();
    /** @type {Set<(message: any) => void>} */
    const peerListeners = new Set();
    /** Session states as another document last reported them. */
    const peerStatus = new Map();
    let peerStatusVersion = 0;
    /**
     * When the newest applied snapshot was announced (`at` from the Host).
     *
     * Two readers feed the same map — the push stream and the pull of the Host's
     * cache — and they can overtake each other. Comparing timestamps is what
     * keeps the older answer from replacing the newer one, which would make a
     * badge blink away again after it finally arrived.
     */
    let peerStatusAt = 0;
    const peerStatusListeners = new Set();

    function publishPeer(message) {
      try {
        peerChannel?.postMessage(message);
      } catch {
        /* a channel closed during teardown is not an error worth surfacing */
      }
    }

    function subscribePeer(listener) {
      peerListeners.add(listener);
      return () => peerListeners.delete(listener);
    }

    function subscribePeerStatus(listener) {
      peerStatusListeners.add(listener);
      return () => peerStatusListeners.delete(listener);
    }

    function readPeerStatus() {
      return peerStatusVersion;
    }

    /**
     * How long an answered question keeps its badge.
     *
     * Answering a question and the turn really ending are two pieces of news on
     * two channels: the page's snapshot drops the pending question the moment
     * it is answered, while the running flag only clears once the agent has
     * actually stopped. Drawn as they arrive, a row walked 等待回答 → 进行中 →
     * 空闲 inside one glance — three answers where the user asked for one, and
     * the middle one was never worth a frame.
     *
     * So a question that has just been answered is held for a moment. If the
     * turn is still going after that, 进行中 is drawn and it is true; if it is
     * not, the row goes from the question straight to where it ended.
     *
     * A fifth of a second, not half: the hold only has to outlast the gap
     * between two announcements of the same turn, and every millisecond of it
     * that the row is not waiting on anything is a millisecond the badge is
     * visibly behind. Anything slower than a blink starts to read as lag.
     */
    const PENDING_LINGER_MS = 200;

    /** id → { kind, until }: questions answered less than PENDING_LINGER_MS ago. */
    const pendingLinger = new Map();

    /**
     * Adopt the status rows another document published.
     *
     * The rows are shaped like DSH's own `sessionStatus` entries (
     * `running` / `pendingInteraction` / `completionUnread`), so the same
     * `withDshStatus` projection reads either source without knowing where the
     * entry came from.
     *
     * @param {Array<{id: string, running?: boolean, pending?: string, completed?: boolean}>} rows
     * @param {number} [at] when the announcing document took the snapshot; a
     *   snapshot older than the one already applied is dropped, because two
     *   carriers deliver the same rows in either order.
     * @returns {boolean} whether the rows were applied
     */
    function applyPeerStatus(rows, at) {
      const stamp = Number(at);
      if (Number.isFinite(stamp) && stamp > 0) {
        if (stamp < peerStatusAt) return false;
        peerStatusAt = stamp;
      }
      const now = Date.now();
      const next = new Map();
      for (const row of rows) {
        const id = typeof row?.id === "string" ? row.id : "";
        if (!id) continue;
        next.set(id, {
          running: row.running === true,
          pendingInteraction: typeof row.pending === "string" && row.pending ? row.pending : null,
          completionUnread: row.completed === true,
        });
      }
      // A question missing from the new snapshot was answered — either it
      // changed kind, or its row dropped out altogether because the page no
      // longer has anything to say about that session. Remember which one and
      // until when, so the badge can outlive the announcement.
      for (const [id, previous] of peerStatus) {
        if (!previous.pendingInteraction) continue;
        const fresh = next.get(id) ?? null;
        if (fresh && fresh.pendingInteraction === previous.pendingInteraction) continue;
        pendingLinger.set(id, { kind: previous.pendingInteraction, until: now + PENDING_LINGER_MS });
      }
      for (const [id, held] of pendingLinger) {
        if (held.until <= now) pendingLinger.delete(id);
      }
      peerStatus.clear();
      for (const [id, entry] of next) peerStatus.set(id, entry);
      peerStatusVersion += 1;
      for (const listener of peerStatusListeners) listener();
      return true;
    }

    /** How many session rows one status announcement may carry. */
    const STATUS_ROW_LIMIT = 500;

    /**
     * How often a document re-reads the states it already knows.
     *
     * Not a poll for news: `publishStatusSnapshot` compares the snapshot and
     * stays silent when nothing changed, so this costs one projection and one
     * string compare. It exists because the observable is not guaranteed to fire
     * for every transition the badge depends on, and a missed notification used
     * to mean a stuck 「空闲」 until something else happened to repaint.
     */
    const STATUS_TICK_MS = 1000;

    /**
     * How often the window pulls the Host's cached snapshot.
     *
     * Not gated on visibility: the window is meant to be read later, and a
     * background page is exactly where the push is late. One loopback GET per
     * second against a snapshot already in memory is cheaper than the half second
     * of staleness it removes — the pull is the floor under the badge, not the
     * usual path, so it should be well under the time it takes to notice.
     */
    const STATUS_PULL_MS = 1000;

    /**
     * The session states this document last announced, in the shape the bus
     * carries them.
     *
     * Kept so a document that arrives late can ask for them: the panel only
     * announces *changes*, and a window opened while a session is already
     * waiting for an answer has no way to learn that from a broadcast that
     * happened before it existed.
     *
     * @type {Array<{ id: string, running: boolean, pending: string | null, completed: boolean }> | null}
     */
    let latestStatusRows = null;

    /** The last announced snapshot, as JSON, so a repaint is not news. */
    let latestStatusKey = "";

    /**
     * Project DSH's status snapshot into the rows the bridge can carry.
     *
     * An idle session is left out: a row is only worth sending when it has
     * something to say (running, waiting for a person, or finished unread),
     * and the receiver rebuilds its map from the list — so a session that
     * stops waiting simply falls out of the next snapshot instead of needing
     * a tombstone.
     *
     * @param {Map<string, { running?: boolean, pendingInteraction?: unknown, completionUnread?: boolean }> | null | undefined} snapshot
     * @returns {Array<{ id: string, running: boolean, pending: string | null, completed: boolean }>}
     */
    function statusRowsOf(snapshot) {
      const rows = [];
      if (!(snapshot instanceof Map)) return rows;
      snapshot.forEach((entry, id) => {
        const key = typeof id === "string" ? id : String(id ?? "");
        if (!key) return;
        const pending = pendingKindOf(entry?.pendingInteraction);
        const running = entry?.running === true;
        const completed = entry?.completionUnread === true;
        if (!running && !pending && !completed) return;
        if (rows.length >= STATUS_ROW_LIMIT) return;
        rows.push({ id: key.slice(0, 200), running, pending, completed });
      });
      return rows;
    }

    /**
     * Announce this document's session states to the other documents.
     *
     * Two carriers, because the two surfaces do not share a process:
     *
     *  - BroadcastChannel — same-process peers (two tabs of the DSH page). It
     *    is cheap and immediate, and it never leaves the process, which is
     *    exactly why it cannot reach the detached window;
     *  - the Host bridge — `session-status` is fanned out over the same stream
     *    the commands use, so the window (its own Electron process, running the
     *    shim where `uiSession` is a stub) reads the states from there.
     *
     * Only the document that owns `uiSession` calls this. The window would
     * otherwise echo back what it was just told, and the two would take turns.
     *
     * @param {Array<object>} [rows] a newer snapshot, when the caller has one
     * @param {boolean} [force] answer even when the snapshot is the one last sent
     * @returns {boolean} whether anything was announced
     */
    function publishStatusSnapshot(rows, force = false) {
      if (Array.isArray(rows)) latestStatusRows = rows;
      if (!Array.isArray(latestStatusRows)) return false;
      // The bus holds 64 commands for 30 s: a repaint that changed nothing must
      // not push a real "open session" out of that window. A forced answer is
      // not a repaint: a window that just mounted has never seen these rows.
      const key = JSON.stringify(latestStatusRows);
      if (!force && key === latestStatusKey) return false;
      latestStatusKey = key;
      publishPeer({ kind: "status", rows: latestStatusRows });
      if (!windowHost()) void sendBridgeCommand("session-status", { rows: latestStatusRows });
      return true;
    }

    if (peerChannel) {
      peerChannel.onmessage = (event) => {
        const message = event?.data;
        if (!message || typeof message !== "object") return;
        if (message.kind === "status" && Array.isArray(message.rows)) applyPeerStatus(message.rows);
        // A write from a window that cannot reach DSH: the one that can does it.
        if (message.kind === "refresh" && message.needsDsh === true && canRefreshDsh()) void refreshDshViews();
        for (const listener of peerListeners) {
          try {
            listener(message);
          } catch {
            /* one listener failing must not starve the others */
          }
        }
      };
    }

