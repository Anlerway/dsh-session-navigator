/**
 * The two halves of the bridge that keep DSH's sidebar and the panel in step.
 *
 * Reported symptom: deleting a session in the detached window left DSH's list
 * stale, deleting one in DSH left the window stale, and even 刷新 did nothing —
 * only restarting DSH helped. Three separate reasons, five tests below:
 *
 *   - a window cannot pull DSH's list, so its refresh has to travel as a
 *     command through the Host to the document that can (requestDshRefresh);
 *   - the command bus used to publish only while an EventSource was attached,
 *     so a dead stream was also a silent bus;
 *   - a stream can die without telling anyone, so the same bus is polled — and
 *     the first poll of a document that never got a `ready` frame is history,
 *     not news.
 *
 *   node --test test/bridge-poll.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle, recordingFetch } from "./support/client-bundle.mjs";

/** The part of the host these functions touch. */
function makeHost({ sessions, hostBridge } = {}) {
  return {
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: () => () => {}, register: () => () => {} },
    effect: () => () => {},
    get: (name) => {
      if (name === "sessions") return sessions;
      if (name === "hostBridge") return hostBridge;
      return undefined;
    },
  };
}

function load(host, respond) {
  const fetchImpl = recordingFetch(respond);
  const { bundle, test: api } = loadClientBundle({
    fetch: fetchImpl,
    expose: ["subscribeBridge", "requestDshRefresh", "canRefreshDsh", "flushBridgeBursts"],
  });
  if (host) bundle.apply(host);
  return { api, calls: fetchImpl.calls };
}

/** The smallest EventSource that can be driven by hand. */
class FakeStream {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeStream.last = this;
  }

  addEventListener(name, handler) {
    const list = this.listeners.get(name) ?? [];
    list.push(handler);
    this.listeners.set(name, list);
  }

  emit(name, data) {
    for (const handler of this.listeners.get(name) ?? []) handler({ data: JSON.stringify(data) });
  }

  close() {
    this.closed = true;
  }
}

/** Replace the timer and EventSource globals for one test, and put them back. */
function stubGlobals(t, { stream = false } = {}) {
  const real = {
    EventSource: globalThis.EventSource,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const ticks = [];
  if (stream) globalThis.EventSource = FakeStream;
  else delete globalThis.EventSource;
  globalThis.setInterval = (fn, ms) => {
    ticks.push({ fn, ms });
    return { unref() {}, id: ticks.length };
  };
  globalThis.clearInterval = () => {};
  t.after(() => {
    globalThis.EventSource = real.EventSource;
    globalThis.setInterval = real.setInterval;
    globalThis.clearInterval = real.clearInterval;
  });
  return ticks;
}

const settle = () => new Promise((resolve) => globalThis.setTimeout(resolve, 5));

test("a window asks the Host to refresh DSH instead of pretending it can", async () => {
  let pulled = 0;
  const { api, calls } = load(makeHost({ sessions: { refresh: async () => { pulled += 1; } }, hostBridge: { request: async () => ({}) } }));
  assert.equal(api.canRefreshDsh(), false);
  await api.requestDshRefresh();
  assert.equal(pulled, 0, "the shim's refresh is not a pull");
  const handed = calls.filter((call) => call.url === "/session-navigator/api/bridge/commands");
  // Mounting a window spends two slots on purpose: the ask covers a state that
  // changed while it was closed, and the refresh is what it cannot do itself.
  // Both signs travel through the one POST, so this counts kinds.
  assert.deepEqual(handed.map((call) => call.body.kind), ["status-request", "refresh"]);
  const asked = handed.filter((call) => call.body.kind === "refresh");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].method, "POST");
  assert.deepEqual(asked[0].body, { kind: "refresh", payload: {} });
});

test("the panel pulls DSH itself and sends no command", async () => {
  let pulled = 0;
  const { api, calls } = load(makeHost({ sessions: { refresh: async () => { pulled += 1; } } }));
  assert.equal(api.canRefreshDsh(), true);
  await api.requestDshRefresh();
  assert.equal(pulled, 1);
  assert.equal(calls.length, 0, "nothing to ask for over the bus");
});

test("the poll is a second path to the same bus, and a sequence runs once", async (t) => {
  const ticks = stubGlobals(t, { stream: true });
  const answers = [
    { ok: true, result: { cursor: 2, commands: [{ seq: 1, kind: "sessions-changed", payload: { reason: "a" } }, { seq: 2, kind: "sessions-changed", payload: { reason: "b" } }] } },
    { ok: true, result: { cursor: 3, commands: [{ seq: 2, kind: "sessions-changed", payload: { reason: "b" } }, { seq: 3, kind: "refresh", payload: {} }] } },
  ];
  let polled = 0;
  const { api, calls } = load(null, (call) => {
    if (!call.url.includes("/bridge/poll")) return { ok: true, result: {} };
    return answers[Math.min(polled++, answers.length - 1)];
  });

  const seen = [];
  const off = api.subscribeBridge((command) => seen.push(command.seq));
  assert.equal(ticks.length, 1, "one poll timer");
  assert.ok(ticks[0].ms <= 10_000, "often enough to be a fallback, rare enough to be background");

  const stream = FakeStream.last;
  stream.emit("ready", { cursor: 0, kinds: [] });
  stream.emit("command", { seq: 1, kind: "sessions-changed", payload: { reason: "turn" } });
  api.flushBridgeBursts();
  assert.deepEqual(seen, [1], "the stream still delivers first");

  // The stream went quiet without saying so; the poll carries the same command.
  for (let round = 0; round < 2; round += 1) {
    ticks[0].fn();
    await settle();
    api.flushBridgeBursts();
  }
  off();

  assert.deepEqual(seen, [1, 2, 3], "the stream's frame and the poll's copy run once");
  const pollCalls = calls.filter((call) => call.url.includes("/bridge/poll"));
  assert.equal(pollCalls.length, 2);
  assert.equal(pollCalls[0].url, "/session-navigator/api/bridge/poll?since=1", "the cursor follows what was acted on");
  assert.equal(pollCalls[1].url, "/session-navigator/api/bridge/poll?since=2");
});

test("a poll with no ready frame before it is history, not news", async (t) => {
  const ticks = stubGlobals(t);
  const answers = [
    { ok: true, result: { cursor: 7, commands: [{ seq: 5, kind: "open-session", payload: { sessionId: "session-old" } }, { seq: 7, kind: "open-session", payload: { sessionId: "session-old" } }] } },
    { ok: true, result: { cursor: 8, commands: [{ seq: 7, kind: "open-session", payload: { sessionId: "session-old" } }, { seq: 8, kind: "sessions-changed", payload: { reason: "turn" } }] } },
  ];
  let polled = 0;
  const { api } = load(null, () => answers[Math.min(polled++, answers.length - 1)]);

  const seen = [];
  const off = api.subscribeBridge((command) => seen.push(command));
  ticks[0].fn();
  await settle();
  api.flushBridgeBursts();
  assert.deepEqual(seen, [], "a panel mounting must not replay an older open-session");

  ticks[0].fn();
  await settle();
  api.flushBridgeBursts();
  off();
  assert.deepEqual(seen.map((command) => command.seq), [8], "only what came after the position it took");
});

test("a restarted Host is a reload, not silence", async (t) => {
  stubGlobals(t, { stream: true });
  const { api } = load(null);
  const seen = [];
  const off = api.subscribeBridge((command) => seen.push(command));
  const stream = FakeStream.last;

  // First frame of a fresh subscription: everything already queued is older
  // than this document, so a panel mounting now must not replay it.
  stream.emit("ready", { cursor: 12, kinds: [] });
  stream.emit("command", { seq: 11, kind: "open-session", payload: { sessionId: "session-old" } });
  api.flushBridgeBursts();
  assert.deepEqual(seen, [], "a replayed command from before the mount is ignored");

  stream.emit("command", { seq: 13, kind: "sessions-changed", payload: { reason: "turn" } });
  api.flushBridgeBursts();
  assert.equal(seen.length, 1);

  // The Host restarted: its bus is young again and its cursor went backwards.
  stream.emit("ready", { cursor: 0, kinds: [] });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].kind, "sessions-changed");
  assert.equal(seen[1].payload.reason, "host-restart");
  assert.equal(seen[1].payload.refresh, true);
  assert.equal("running" in seen[1].payload, false, "a restart says nothing about which sessions run");

  off();
  assert.equal(stream.closed, true);
});
