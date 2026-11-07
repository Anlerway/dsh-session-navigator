// 路由组 bridge（4 条）
import { WINDOW_COMMANDS, normalizeCommand } from "../host/bridge.js";

export const bridgeRoutes = {


  /**
   * The bridge's write end: a command from the detached window.
   *
   * Deliberately unauthenticated beyond the helper token the preload attaches:
   * the bus carries no data, only "the user clicked 打开" / "the user asked for a
   * new session", and every consumer still goes through the ordinary routes
   * (and so through the ordinary validation) when it acts on one.
   */
  "POST /bridge/commands": async (api, req) => {
    const command = normalizeCommand(req.body ?? {});
    // "my write landed, re-read": the sender is a document that cannot reach
    // DSH itself (the detached window runs in its own process), so the state the
    // DSH page is about to read has to be fresh on this side before the event
    // that asks it to read is even queued.
    if (command.kind === "refresh") {
      try {
        api.reader.invalidate();
      } catch {
        /* a cache that refuses to drop is not a reason to drop the command */
      }
    }
    // A snapshot is not an event: the newest one is the truth, and a window that
    // asks later needs it even though the bus has forgotten it (MAX_AGE_MS).
    const board = api.statusBoard;
    const at = board && command.kind === "session-status" ? board.set(command.payload.rows).at : 0;
    const published = api.bridge.publish(command.kind, at ? { ...command.payload, at } : command.payload);
    // An ask is answered from this cache alone, without waking the page: the
    // window asks at mount and on return to the front, and the bus may already
    // have forgotten the announcement that would have answered it (MAX_AGE_MS).
    if (board && command.kind === "status-request") {
      const last = board.snapshot();
      if (last.at > 0) api.bridge.publish("session-status", { rows: last.rows, at: last.at });
    }
    // How many documents were listening when it went out. The window counts
    // itself, so 1 means "nobody but me" — that is what lets it say 已经发出去
    // instead of 已在 DSH 主窗口打开 when DSH is not running at all.
    return { seq: published.seq, kind: published.kind, listeners: api.bridge.listeners };
  },


  /**
   * The bridge's second read end: polling, for documents that cannot hold a
   * stream open.
   *
   * A stream is the right default (push, one connection, no wake-ups), but it is
   * also the fragile half: a proxy that buffers, a renderer that throttles a
   * background document, or a connection the peer believes is alive and the
   * other end closed all leave a panel listening to nothing. A poll cannot be
   * silently dead — a failed request is visible as an error, and the next tick
   * asks again — so both documents run it alongside the stream and drop
   * duplicates by `seq`.
   *
   * @param {any} api
   * @param {any} req
   * @param {any} res
   * @param {URLSearchParams} query
   */
  /**
   * The cache's read end: the last session states the page announced.
   *
   * The window pulls this on a timer. A push can be late for reasons this side
   * cannot see — a background document is throttled by the browser, so the
   * announcement it *did* send arrives minutes later, and the badge looks stuck
   * until the user clicks back into DSH. Pulling a timestamped snapshot turns
   * "how late is late" into a comparison the reader can make for itself, and it
   * still works when the page is asleep.
   *
   * `at` is the announcement's own time, not this response's: a reader that has
   * already applied a newer snapshot must not go backwards.
   */
  "GET /bridge/status": async (api) => {
    const board = api.statusBoard;
    const last = board ? board.snapshot() : { rows: [], at: 0 };
    return { rows: last.rows, at: last.at, cursor: api.bridge.cursor };
  },


  "GET /bridge/poll": async (api, req, res, query) => {
    const cursor = Number(query?.get("since") ?? 0);
    return { cursor: api.bridge.cursor, commands: api.bridge.since(Number.isFinite(cursor) ? cursor : 0) };
  },


  /**
   * The bridge's read end, for the panel.
   *
   * Server-sent events, not polling: the panel is usually closed, and a command
   * is only useful if it lands while the user is looking. `since` lets a
   * reconnecting panel skip what it already ran.
   */
  "GET /bridge/events": async (api, req, res, query) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const write = (event, data, id) => {
      try {
        const frame = id === undefined ? `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` : `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        // A false return means the socket buffer is full. Rather than let it
        // grow without bound, end the stream: the panel reconnects with
        // `Last-Event-ID` and picks up from the last frame it actually got.
        return res.write(frame);
      } catch {
        /* the panel went away; the close handler cleans up */
        return false;
      }
    };

    // `Last-Event-ID` is what EventSource sends on its own reconnect; the query
    // parameter is the first connection's cursor. Preferring the header is what
    // keeps a reconnect from replaying the frames it already ran.
    const lastEventId = Number(req.headers?.["last-event-id"]);
    const since = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : Number(query?.get("since") ?? 0);
    write("ready", { cursor: api.bridge.cursor, kinds: WINDOW_COMMANDS });

    /** @type {{ closed: boolean }} */
    const state = { closed: false };
    /** @type {NodeJS.Timeout | null} */
    let keepAlive = null;
    const unsubscribe = api.bridge.subscribe((command) => {
      if (state.closed) return;
      if (write("command", command, command.seq) === false) close();
    });
    if (!unsubscribe) {
      // The bus is full: refuse before replaying, so a reconnect storm cannot
      // add another buffered response on top of the ones already stuck.
      res.statusCode = 503;
      res.end();
      return undefined;
    }

    for (const command of api.bridge.since(since)) {
      if (write("command", command, command.seq) === false) {
        close();
        return undefined;
      }
    }

    keepAlive = setInterval(() => {
      try {
        res.write(": keep-alive\n\n");
      } catch {
        /* handled by close */
      }
    }, 15_000);
    keepAlive.unref?.();

    function close() {
      if (state.closed) return;
      state.closed = true;
      if (keepAlive) clearInterval(keepAlive);
      unsubscribe();
      try {
        res.end();
      } catch {
        /* already ended */
      }
    }
    req.on("close", close);
    req.on("aborted", close);
    return undefined;
  },
};
