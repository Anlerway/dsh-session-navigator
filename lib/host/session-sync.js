/**
 * dsh-session-navigator — keeping the panel in step with DSH.
 *
 * The panel is a second view over state that two other actors change:
 *
 *   DSH itself   a new conversation, a rename, an archive, a turn starting and
 *                finishing — all of it happens in the GUI, none of it through
 *                this plugin;
 *   the kernel   which agents are live, which is the only truthful answer to
 *                "进行中" (see lib/sources/live.js).
 *
 * Until now the panel only refreshed when the user made it refresh: a session
 * created in DSH's own sidebar was missing from the list, a finished turn stayed
 * 进行中, and a renamed conversation kept its old name until the popover was
 * closed and reopened (m00001 会话刷新同步).
 *
 * Polling would fix the symptom and cost a filesystem walk every second. These
 * are Cordis events instead: `session/created`, `session/disposed`,
 * `agent/created`, `agent/disposed`, `agent/status` and `session/event`
 * (`packages/core/session/src/index.ts:54-74`,
 * `packages/core/agent/src/runtime-types.ts:261-280`). A plugin context shares
 * the one hook table with the rest of the app (`vendor/cordis/src/events.ts:165-196`),
 * so `ctx.on` here hears kernel events without a dependency on the emitting
 * package, and the listeners are withdrawn with the fiber.
 *
 * One wrinkle: the kernel dispatches these events through a scope *carrier*
 * (`packages/core/scope/src/index.ts:170-185`), and a carrier does filter
 * listeners — untagged contexts are admitted, scoped ones only for their own
 * branch. This plugin's context is app-level and should be untagged; it asks for
 * `{ global: true }` anyway, because a registration that is silently filtered
 * would reproduce exactly the staleness this module exists to remove.
 *
 * What each event costs matters, so the reaction is split in two:
 *
 *   structural  the set of sessions changed → drop the header cache and repaint
 *               from a fresh walk;
 *   cosmetic    a row's state changed → hand the caller the live running set;
 *               the panel patches the badge in place, without a walk.
 *
 * A turn emits several events in a row (`user/message` → `turn/start` →
 * `assistant/message` → `turn/end`), so batches are coalesced over a short
 * window: one reply, one snapshot, not four.
 */

/** How long events are collected before the Host answers them once. */
const DEBOUNCE_MS = 300;

/**
 * The session events this module listens to, and what each one implies.
 *
 * `turn/start` is deliberately cosmetic: the running set already says the agent
 * is busy, and the log tail has not settled yet — a walk there would be spent on
 * a row that is about to change again.
 *
 * @type {Readonly<Record<string, { reason: string, refresh: boolean }>>}
 */
const SESSION_EVENT_RULES = Object.freeze({
  "session/title": { reason: "title", refresh: true },
  "turn/start": { reason: "turn", refresh: false },
  "turn/end": { reason: "turn", refresh: true },
  "user/message": { reason: "message", refresh: true },
});

/**
 * Start watching. Returns a controller; `dispose()` unsubscribes everything.
 *
 * @param {object} options
 * @param {any} options.ctx the plugin context (needs `on`)
 * @param {any} [options.bridge] the panel ↔ window bus
 * @param {any} [options.reader] the snapshot reader, for `invalidate()`
 * @param {() => Set<string>} [options.runningIds] the live running set
 * @param {number} [options.debounceMs]
 * @param {(level: string, message: string) => void} [options.log]
 */
export function createSessionSync(options = {}) {
  const { ctx, bridge, reader, runningIds, log } = options;
  const debounceMs = Number.isFinite(options.debounceMs) && options.debounceMs >= 0 ? options.debounceMs : DEBOUNCE_MS;

  /** @type {Set<() => void>} */
  const disposers = [];
  /** @type {NodeJS.Timeout | number | null} */
  let timer = null;
  /** @type {{ reason: string, reasons: Set<string>, refresh: boolean, structural: boolean } | null} */
  let pending = null;
  let disposed = false;

  /**
   * Record one event. The first reason in a batch names it, because that is the
   * event the user actually caused.
   *
   * @param {string} reason
   * @param {{ refresh?: boolean, structural?: boolean }} [effect]
   */
  function mark(reason, effect = {}) {
    if (disposed) return;
    if (!pending) pending = { reason, reasons: new Set(), refresh: false, structural: false };
    pending.reasons.add(reason);
    pending.refresh = pending.refresh || effect.refresh === true;
    pending.structural = pending.structural || effect.structural === true;
    if (timer) return;
    try {
      timer = setTimeout(flush, debounceMs);
      timer?.unref?.();
    } catch {
      // A host without timers (a unit test) still gets the batch on `flush()`.
      timer = null;
    }
  }

  /**
   * Answer everything recorded so far, once.
   *
   * @returns {{ reason: string, reasons: string[], refresh: boolean, structural: boolean, running: string[], published: boolean } | null}
   */
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const batch = pending;
    pending = null;
    if (!batch || disposed) return null;

    // Only a changed session set invalidates the header walk: a title or a
    // finished turn lives in the log and in the projection cache, both of which
    // are keyed by size+mtime and re-read on their own.
    if (batch.structural) {
      try {
        reader?.invalidate?.();
      } catch (error) {
        log?.("warn", "session sync: invalidate failed: " + (error?.message ?? error));
      }
    }

    const running = liveRunningIds();
    const payload = {
      reason: batch.reason,
      reasons: [...batch.reasons],
      refresh: batch.refresh,
      structural: batch.structural,
      running,
    };

    // Nothing is listening: the panel's next /bootstrap reads the same Host
    // state, so an event queued for a closed panel would only be replayed at
    // someone who is about to ask for the whole thing anyway.
    let published = false;
    const listeners = typeof bridge?.listeners === "number" ? bridge.listeners : 1;
    if (listeners > 0 && typeof bridge?.publish === "function") {
      try {
        bridge.publish("sessions-changed", payload);
        published = true;
      } catch (error) {
        log?.("warn", "session sync: publish failed: " + (error?.message ?? error));
      }
    }
    return { ...payload, published };
  }

  /** @returns {string[]} */
  function liveRunningIds() {
    try {
      const ids = runningIds?.();
      return ids instanceof Set ? [...ids] : [];
    } catch {
      return [];
    }
  }

  /**
   * @param {string} name
   * @param {(...args: any[]) => void} handler
   */
  function on(name, handler) {
    if (!ctx || typeof ctx.on !== "function") return;
    // `global: true` first: it admits this listener whatever scope the dispatch
    // carrier filters on (`vendor/cordis/src/events.ts:173`). An engine that does
    // not take the option is answered by the plain overload.
    for (const options of [{ global: true }, null]) {
      try {
        const off = options === null ? ctx.on(name, handler) : ctx.on(name, handler, options);
        if (typeof off === "function") disposers.push(off);
        return;
      } catch {
        /* try the next registration shape */
      }
    }
    log?.("warn", "session sync: cannot listen to " + name);
  }

  on("session/created", () => mark("created", { refresh: true, structural: true }));
  on("session/disposed", () => mark("disposed", { refresh: true, structural: true }));
  // An agent appearing or going away moves the session in or out of the running
  // set only; the row itself is already in the listing.
  on("agent/created", () => mark("agent", { refresh: false }));
  on("agent/disposed", () => mark("agent", { refresh: false }));
  on("agent/status", (payload) => {
    const status = payload?.status;
    // Starting is cosmetic: the payload already carries the running set, so the
    // badge flips without a walk. Finishing is not: the log has just settled,
    // and 空白会话 / 最后活动时间 / 统计 are read from it. A turn emits both this
    // and `turn/end`, and the debounce folds them into one walk.
    mark(status === "running" ? "running" : "idle", { refresh: status !== "running" });
  });
  on("session/event", (session, event) => {
    const rule = SESSION_EVENT_RULES[event?.type];
    if (!rule) return;
    mark(rule.reason, { refresh: rule.refresh });
  });

  return {
    /** Answer the pending batch now (tests, and the API's own writes). */
    flush,
    /** What is waiting, without answering it. */
    get pending() {
      return pending ? { ...pending, reasons: [...pending.reasons] } : null;
    },
    get disposed() {
      return disposed;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
      for (const off of disposers.splice(0)) {
        try {
          off();
        } catch {
          /* one failing disposer must not leak the others */
        }
      }
    },
  };
}
