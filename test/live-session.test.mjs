/**
 * Tests for taking a session away from the running host.
 *
 *   node --test test/live-session.test.mjs
 *
 * Two contracts here are not obvious from the call sites, and both were the
 * difference between "deleted" and "deleted and now DSH is broken":
 *
 *   1. `stopSession` never disposes the agent's fiber. A dispose also closes the
 *      log handle, which is why it looks right — but it unloads the Cordis scope
 *      the host creates agents on, so the next createSession dies with
 *      `cannot create effect on inactive context`.
 *   2. `releaseWriters` closes the persistence write handle an idle agent leaves
 *      behind. Without it Windows refuses the directory rename forever, which is
 *      the "open it once and it can never be moved again" report.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  announceSessionRemoved,
  detachSession,
  isSessionRunning,
  releaseWriters,
  repointSession,
  stopSession,
} from "../src/host/live-session.js";

/**
 * A ctx whose services are the ones named here.
 *
 * @param {Record<string, any>} [services]
 */
function ctxOf(services = {}) {
  return { get: (name) => services[name] };
}

test("stopSession cancels, waits for idle and drops the row — without disposing", async () => {
  const calls = [];
  const agent = {
    id: "s1",
    status: "running",
    cancel(cause) { calls.push(`cancel:${JSON.stringify(cause)}`); agent.status = "idle"; },
    whenIdle() { calls.push("whenIdle"); return Promise.resolve(); },
    scope: { dispose() { calls.push("dispose"); } },
  };
  const entry = { id: "s1", agent };
  const agents = {
    get: (id) => (id === "s1" ? agent : undefined),
    store: new Map([["s1", entry]]),
    detachEntered(target) {
      calls.push("detachEntered");
      if (this.store.get(target.id) !== target) throw new Error("not the live row");
      this.store.delete(target.id);
      agent.status = "disposed";
    },
  };
  agents.get = (id) => (agents.store.get(id)?.agent ?? undefined);

  const result = await stopSession(ctxOf({ agents }), "s1");
  assert.deepEqual(calls, ['cancel:{"kind":"disposed"}', "whenIdle", "detachEntered"]);
  assert.equal(calls.includes("dispose"), false, "disposing the fiber breaks the next create");
  assert.equal(result.wasRunning, true);
  assert.equal(result.stillRunning, false);
  assert.equal(result.released, true);
  assert.equal(agents.store.has("s1"), false, "the registry row is what the panel renders");
});

test("stopSession is a no-op for a session the host never opened", async () => {
  const agents = { get: () => undefined, store: new Map() };
  const result = await stopSession(ctxOf({ agents }), "cold");
  assert.deepEqual(result, { wasRunning: false, stillRunning: false, released: true });
});

test("stopSession survives a host with no agent registry at all", async () => {
  const result = await stopSession(ctxOf(), "s1");
  assert.equal(result.stillRunning, false);
  assert.equal(isSessionRunning(ctxOf(), "s1"), false);
});

test("releaseWriters closes the write handle and waits for its retirement", async () => {
  const calls = [];
  const write = { id: "s1", access: "write", close() { calls.push("close:write"); } };
  const read = { id: "s1", access: "read", close() { calls.push("close:read"); } };
  const other = { id: "s2", access: "write", close() { calls.push("close:other"); } };
  let retired = false;
  const persistence = {
    tracker: { writers: new Map([["s1", write]]), openHandles: new Set([write, read, other]) },
    coordinator: {
      retirements: new Map([["s1", Promise.resolve().then(() => { retired = true; })]]),
      states: new Map(),
    },
  };

  const result = await releaseWriters(ctxOf({ sessionPersistence: persistence }), "s1");
  assert.deepEqual(calls, ["close:write"], "only the write handle of this session is closed");
  assert.equal(retired, true, "the close is not finished until the queued writes retire");
  assert.deepEqual(result, { closed: 1, stillOwned: false });
});

test("releaseWriters closes a handle once, however often it is asked", async () => {
  const calls = [];
  const write = { id: "s1", access: "write", close() { calls.push("close"); } };
  const persistence = { tracker: { writers: new Map([["s1", write]]), openHandles: new Set([write]) } };
  const ctx = ctxOf({ sessionPersistence: persistence });
  await releaseWriters(ctx, "s1");
  await releaseWriters(ctx, "s1");
  assert.deepEqual(calls, ["close"], "a move calls this twice on purpose; the second is free");
});

test("releaseWriters reports a writer it could not close instead of throwing", async () => {
  const stubborn = {
    id: "s1",
    access: "write",
    close() {
      throw new Error("handle is wedged");
    },
  };
  const persistence = {
    tracker: { writers: new Map([["s1", stubborn]]), openHandles: new Set([stubborn]) },
    coordinator: { retirements: new Map(), states: new Map([["s1", { owner: {} }]]) },
  };
  const result = await releaseWriters(ctxOf({ sessionPersistence: persistence }), "s1");
  assert.deepEqual(result, { closed: 0, stillOwned: true });
});

test("releaseWriters tolerates a backend that exposes no tracker", async () => {
  const result = await releaseWriters(ctxOf({ sessionPersistence: {} }), "s1");
  assert.deepEqual(result, { closed: 0, stillOwned: false });
  assert.deepEqual(await releaseWriters(undefined, "s1"), { closed: 0, stillOwned: false });
});

test("detachSession prefers the carrier entry and reports whether it detached", async () => {
  const calls = [];
  const entry = { id: "s1", detach() { calls.push("detach:entry"); } };
  const sessions = {
    get: () => ({ id: "s1", detach() { calls.push("detach:session"); } }),
    store: new Map([["s1", entry]]),
  };
  assert.equal(await detachSession(ctxOf({ sessions }), "s1", { settleMs: 0 }), true);
  assert.deepEqual(calls, ["detach:entry"]);
  assert.equal(await detachSession(ctxOf({ sessions: { store: new Map() } }), "s1", { settleMs: 0 }), false);
});

test("announceSessionRemoved emits the event DSH only relays for live sessions", () => {
  const calls = [];
  const ctx = { emit: (...args) => calls.push(args) };
  assert.equal(announceSessionRemoved(ctx, "s1"), true);
  assert.deepEqual(calls, [["api-session/removed", "s1"]]);
  assert.equal(announceSessionRemoved({}, "s1"), false, "no event bus, nothing to announce");
  assert.equal(announceSessionRemoved({ emit() { throw new Error("closed"); } }, "s1"), false);
});

test("repointSession gives the writer and the live session the new cwd", () => {
  const handle = { id: "s1", access: "write", header: { id: "s1", cwd: "C:/old", title: "kept" } };
  const persistence = { tracker: { writers: new Map([["s1", handle]]) } };
  const live = { header: Object.freeze({ id: "s1", cwd: "C:/old" }) };
  const sessions = { get: (id) => (id === "s1" ? live : undefined) };
  const moved = { id: "s1", cwd: "C:/new" };

  const outcome = repointSession(ctxOf({ sessionPersistence: persistence, sessions }), "s1", moved);

  assert.deepEqual(outcome, { writer: true, live: true });
  assert.equal(handle.header.cwd, "C:/new", "the next append reopens under the new cwd");
  assert.equal(handle.header.title, "kept", "fields the header already had survive the replace");
  assert.equal(live.header.cwd, "C:/new", "the live copy is replaced, never mutated: DSH freezes it");
  assert.equal(Object.isFrozen(live.header), false, "the frozen object itself is left alone");
});

test("repointSession survives a carrier that refuses the write", () => {
  const sealed = Object.freeze({ header: Object.freeze({ id: "s1", cwd: "C:/old" }) });
  const persistence = { tracker: { writers: new Map([["s1", { id: "s1", access: "write" }]]) } };
  const sessions = { get: (id) => (id === "s1" ? sealed : undefined) };

  const outcome = repointSession(ctxOf({ sessionPersistence: persistence, sessions }), "s1", { id: "s1", cwd: "C:/new" });

  assert.equal(outcome.live, false, "a frozen session is reported, not thrown at the caller");
  assert.equal(sealed.header.cwd, "C:/old", "nothing forced its way through");
});

test("repointSession is a no-op without a header or a host", () => {
  assert.deepEqual(repointSession(ctxOf({}), "s1", undefined), { writer: false, live: false });
  assert.deepEqual(repointSession(undefined, "s1", { id: "s1", cwd: "C:/new" }), { writer: false, live: false });
});
