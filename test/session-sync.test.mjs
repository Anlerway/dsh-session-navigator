/**
 * Tests for pushing DSH's own changes to the panel.
 *
 *   node --test test/session-sync.test.mjs
 *
 * What matters is not that an event is heard but what it costs and what it
 * carries: one reply must not become four repaints, a badge flip must not become
 * a filesystem walk, and an event nobody is listening for must not be queued for
 * a panel that will read the whole state anyway.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createSessionSync } from "../lib/host/session-sync.js";

/** A context that records listeners so a test can emit at them by name. */
function fakeContext() {
  const handlers = new Map();
  const options = new Map();
  return {
    handlers,
    options,
    on(name, handler, settings) {
      if (settings !== undefined) options.set(name, settings);
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {
        const current = handlers.get(name) ?? [];
        const at = current.indexOf(handler);
        if (at >= 0) current.splice(at, 1);
      };
    },
    emit(name, ...args) {
      for (const handler of [...(handlers.get(name) ?? [])]) handler(...args);
    },
    count() {
      let total = 0;
      for (const list of handlers.values()) total += list.length;
      return total;
    },
  };
}

test("kernel listeners are registered globally, so no dispatch filter hides them", () => {
  // The kernel emits through a scope carrier, and a carrier filters listeners
  // (untagged contexts pass, scoped ones only for their own branch). A plugin
  // context is expected to be untagged, but a registration that was silently
  // filtered would look exactly like "the panel never updates" — the bug this
  // module exists to remove — so every listener asks to be admitted outright.
  const ctx = fakeContext();
  createSessionSync({
    ctx,
    bridge: fakeBridge(),
    reader: fakeReader(),
    runningIds: () => new Set(),
    debounceMs: 0,
  });
  for (const name of ["session/created", "session/disposed", "agent/created", "agent/disposed", "agent/status", "session/event"]) {
    assert.deepEqual(ctx.options.get(name), { global: true }, name);
  }
});

test("a context that refuses the options overload still gets its listeners", () => {
  // Older Cordis took two arguments; asking for a global registration must not
  // cost the subscription when the engine cannot honour it.
  const ctx = fakeContext();
  const plain = ctx.on.bind(ctx);
  ctx.on = (name, handler, settings) => {
    if (settings !== undefined) throw new TypeError("too many arguments");
    return plain(name, handler);
  };
  const sync = createSessionSync({
    ctx,
    bridge: fakeBridge(),
    reader: fakeReader(),
    runningIds: () => new Set(),
    debounceMs: 0,
  });
  assert.equal(ctx.count(), 6);
  ctx.emit("session/created", {});
  assert.equal(sync.pending?.reason, "created");
});

/** A bridge that records what the Host published. */
function fakeBridge(listeners = 1) {
  return {
    listeners,
    published: [],
    publish(kind, payload) {
      this.published.push({ kind, payload });
    },
  };
}

/** A reader that counts invalidations. */
function fakeReader() {
  return {
    invalidations: 0,
    invalidate() {
      this.invalidations += 1;
    },
  };
}

/** A sync with a debounce long enough that only `flush()` answers it. */
const start = (overrides = {}) => {
  const ctx = fakeContext();
  const bridge = fakeBridge();
  const reader = fakeReader();
  const sync = createSessionSync({
    ctx,
    bridge,
    reader,
    runningIds: () => new Set(["session-live"]),
    debounceMs: 1_000_000,
    ...overrides,
  });
  return { ctx, bridge, reader, sync };
};

test("all six kernel events are listened to, and disposing withdraws them", () => {
  const { ctx, sync } = start();
  assert.equal(ctx.count(), 6);
  assert.deepEqual([...ctx.handlers.keys()].sort(), [
    "agent/created",
    "agent/disposed",
    "agent/status",
    "session/created",
    "session/disposed",
    "session/event",
  ]);
  sync.dispose();
  assert.equal(ctx.count(), 0);
});

test("a new session is structural: the header cache is dropped and the panel reloads", () => {
  const { ctx, bridge, reader, sync } = start();
  ctx.emit("session/created", { id: "session-new" });
  const result = sync.flush();
  assert.equal(result.reason, "created");
  assert.equal(result.refresh, true);
  assert.equal(result.structural, true);
  assert.equal(result.published, true);
  assert.equal(reader.invalidations, 1, "a changed session set invalidates the walk");
  assert.deepEqual(bridge.published, [
    {
      kind: "sessions-changed",
      payload: {
        reason: "created",
        reasons: ["created"],
        refresh: true,
        structural: true,
        running: ["session-live"],
      },
    },
  ]);
});

test("a status flip is cosmetic: the running set travels, the cache is kept", () => {
  const { ctx, bridge, reader, sync } = start();
  ctx.emit("agent/status", { status: "running" });
  const result = sync.flush();
  assert.equal(result.reason, "running");
  assert.equal(result.refresh, false, "a badge flip must not trigger a walk");
  assert.equal(result.structural, false);
  assert.equal(reader.invalidations, 0);
  assert.deepEqual(bridge.published[0].payload.running, ["session-live"]);
});

test("an agent going idle is named idle, and the settled log is re-read", () => {
  const { ctx, reader, sync } = start();
  ctx.emit("agent/status", { status: "idle" });
  const result = sync.flush();
  assert.equal(result.reason, "idle");
  // 最后活动时间 / 统计 come from the log, which only settles once the turn is
  // over — the badge patch alone cannot tell them apart.
  assert.equal(result.refresh, true);
  assert.equal(result.structural, false, "the session set did not change");
  assert.equal(reader.invalidations, 0);
});

test("one turn is one reply: several events collapse into a single batch", () => {
  const { ctx, bridge, sync } = start();
  ctx.emit("session/event", {}, { type: "user/message" });
  ctx.emit("session/event", {}, { type: "turn/start" });
  ctx.emit("agent/status", { status: "running" });
  ctx.emit("session/event", {}, { type: "turn/end" });
  const result = sync.flush();
  assert.equal(bridge.published.length, 1, "four events, one publish");
  assert.equal(result.reason, "message", "the batch is named by the event that started it");
  assert.deepEqual(result.reasons, ["message", "turn", "running"]);
  assert.equal(result.refresh, true, "turn/end is worth a reload");
  assert.equal(bridge.published.length, 1);
  assert.equal(sync.flush(), null, "nothing was recorded twice");
});

test("turn/start alone is not worth a reload, turn/end alone is", () => {
  const first = start();
  first.ctx.emit("session/event", {}, { type: "turn/start" });
  assert.equal(first.sync.flush().refresh, false);

  const second = start();
  second.ctx.emit("session/event", {}, { type: "turn/end" });
  assert.equal(second.sync.flush().refresh, true);
});

test("a title is refreshed but changes no session set", () => {
  const { ctx, reader, sync } = start();
  ctx.emit("session/event", {}, { type: "session/title" });
  const result = sync.flush();
  assert.equal(result.reason, "title");
  assert.equal(result.refresh, true);
  assert.equal(result.structural, false);
  assert.equal(reader.invalidations, 0);
});

test("an event outside the vocabulary is ignored instead of waking the panel", () => {
  const { ctx, sync } = start();
  ctx.emit("session/event", {}, { type: "assistant/message" });
  ctx.emit("session/event", {}, {});
  ctx.emit("session/event", {});
  assert.equal(sync.pending, null);
  assert.equal(sync.flush(), null);
});

test("nothing listening means nothing published", () => {
  const bridge = fakeBridge(0);
  const { ctx, sync } = start({ bridge });
  ctx.emit("session/created", { id: "session-new" });
  const result = sync.flush();
  assert.equal(result.published, false);
  assert.deepEqual(bridge.published, []);
  assert.equal(bridge.listeners, 0);
});

test("a bridge that throws is reported, not propagated into the event loop", () => {
  const bridge = {
    listeners: 1,
    publish() {
      throw new Error("stream closed");
    },
  };
  const lines = [];
  const { ctx, sync } = start({ bridge, log: (level, message) => lines.push([level, message]) });
  ctx.emit("session/created", { id: "session-new" });
  const result = sync.flush();
  assert.equal(result.published, false);
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], "warn");
});

test("a throwing runningIds degrades to an empty set instead of failing the batch", () => {
  const { ctx, sync } = start({
    runningIds: () => {
      throw new Error("registry gone");
    },
  });
  ctx.emit("agent/status", { status: "running" });
  assert.deepEqual(sync.flush().running, []);
});

test("after dispose no event is recorded and no timer survives", () => {
  const { ctx, sync } = start();
  sync.dispose();
  ctx.emit("session/created", { id: "session-new" });
  assert.equal(sync.pending, null);
  assert.equal(sync.flush(), null);
  assert.equal(sync.disposed, true);
  sync.dispose();
});

test("a context without the event bus still yields a working, inert sync", () => {
  const sync = createSessionSync({ ctx: {}, bridge: fakeBridge(), debounceMs: 1_000_000 });
  assert.equal(sync.flush(), null);
  sync.dispose();
});
