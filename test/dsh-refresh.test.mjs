/**
 * Which document is allowed to pull DSH's own session list.
 *
 * Deleting a session in the detached window left DSH's sidebar stale: the write
 * landed in this plugin, but nobody told DSH to re-read its store. The panel
 * does that by calling the `sessions` service DSH injects into it — and the
 * window looks like it has the same service, because the shim answers it with an
 * empty function. Asking "is there a refresh?" therefore says yes out there and
 * then does nothing, which is exactly the bug.
 *
 *   node --test test/dsh-refresh.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle } from "./support/client-bundle.mjs";

/**
 * A host with only what the question touches.
 *
 * `hostBridge` is the shim's one unmistakable member — inside DSH no such
 * service exists — so a window can be described here without a shim.
 */
function makeHost({ sessions, hostBridge, uiWorkspace } = {}) {
  return {
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: () => () => {}, register: () => () => {} },
    effect: () => () => {},
    get: (name) => {
      if (name === "sessions") return sessions;
      if (name === "uiWorkspace") return uiWorkspace;
      if (name === "hostBridge") return hostBridge;
      return undefined;
    },
  };
}

function load(host) {
  const { bundle, test: api } = loadClientBundle({ expose: ["canRefreshDsh", "windowHost"] });
  bundle.apply(host);
  return api;
}

const refresh = async () => {};

test("a host without a sessions service cannot pull DSH's list", () => {
  assert.equal(load(makeHost()).canRefreshDsh(), false);
});

test("the DSH page may pull: the service is there and nothing stands in for DSH", () => {
  const api = load(makeHost({ sessions: { refresh } }));
  assert.equal(api.windowHost(), null);
  assert.equal(api.canRefreshDsh(), true);
});

test("the window may not pull, even though its shim answers refresh", () => {
  // The shim's stub: a real function on a service DSH does not own here.
  const api = load(makeHost({ sessions: { refresh }, hostBridge: { request: async () => ({}) } }));
  assert.notEqual(api.windowHost(), null);
  assert.equal(api.canRefreshDsh(), false);
});

test("a malformed host is not mistaken for the window", () => {
  const api = load(makeHost({ sessions: { refresh }, hostBridge: { request: "no" } }));
  assert.equal(api.windowHost(), null);
  assert.equal(api.canRefreshDsh(), true);
});

/**
 * The delete path, which must not pull a baseline.
 *
 * `sessions.refresh()` installs the server's answer as the new baseline and
 * drops every identity that answer does not name — a row this client is still
 * creating included. DSH's own `handleSessionRemoved(id)` is the frame the Host
 * sends when it disposes a session, and it costs exactly one row.
 */
function loadRemovals(host) {
  const { bundle, test: api, fetch } = loadClientBundle({
    expose: ["requestDshRefresh", "removedIdsOf", "applyDshRemovals"],
  });
  bundle.apply(host);
  return { api, fetch };
}

test("a delete applies DSH's own removal frame and pulls no baseline", async () => {
  const calls = [];
  const host = makeHost({
    sessions: {
      refresh: async () => calls.push("refresh"),
      handleSessionRemoved: (id) => calls.push("remove:" + id),
    },
  });
  const { api } = loadRemovals(host);
  await api.requestDshRefresh({ removed: ["session-a"] });
  assert.deepEqual(calls, ["remove:session-a"]);
});

test("without DSH's removal frame a delete still converges through the pull", async () => {
  const calls = [];
  const api = loadRemovals(makeHost({ sessions: { refresh: async () => calls.push("refresh") } })).api;
  await api.requestDshRefresh({ removed: ["session-a"] });
  assert.deepEqual(calls, ["refresh"]);
});

test("a refusing frame leaves the row to the pull", async () => {
  const calls = [];
  const host = makeHost({
    sessions: {
      refresh: async () => calls.push("refresh"),
      handleSessionRemoved: () => {
        throw new Error("frame refused");
      },
    },
  });
  const api = loadRemovals(host).api;
  await api.requestDshRefresh({ removed: ["session-a"] });
  assert.deepEqual(calls, ["refresh"]);
});

test("the window hands the ids to the page instead of asking for a baseline", async () => {
  const calls = [];
  const host = makeHost({
    sessions: { refresh: async () => calls.push("refresh") },
    hostBridge: { request: async () => ({}) },
  });
  const { api, fetch } = loadRemovals(host);
  await api.requestDshRefresh({ removed: ["session-a"] });
  assert.deepEqual(calls, []);
  // Boot asks the bridge for its status; only the delete's own hop is the ask.
  const posted = fetch.calls.filter((call) => call.body?.kind === "refresh");
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, { kind: "refresh", payload: { removed: ["session-a"] } });
});

test("only the ids the Host trashed become removals", () => {
  const api = loadRemovals(makeHost({ sessions: { refresh } })).api;
  assert.deepEqual(api.removedIdsOf("/trash", { ids: ["a", "b"] }, { trashed: ["a"], skipped: ["b"], errors: [] }), ["a"]);
  assert.deepEqual(api.removedIdsOf("/trash", { ids: ["a", "b"] }, { skipped: ["b"] }), ["a"]);
  assert.deepEqual(api.removedIdsOf("/trash", { ids: ["a"] }, undefined), ["a"]);
  assert.deepEqual(api.removedIdsOf("/restore", { ids: ["a"] }, { restored: ["a"] }), []);
});
/**
 * The other half of a delete: the main view.
 *
 * `handleSessionRemoved` takes the row out of the sidebar but leaves
 * `uiWorkspace.mainReference` pointing at it. DSH's own archive path clears the
 * main view in exactly that case (`uiworkspace/lib/client.js:1544-1547`), and a
 * view still holding a removed id is what makes the next switch land on
 * "会话无效" until the app restarts.
 */
function mainView({ current, clearThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    service: {
      get mainReference() {
        return current === undefined ? undefined : { sessionId: current };
      },
      clearMain() {
        if (clearThrows) throw new Error("view refused");
        calls.push("clearMain");
        current = undefined;
      },
    },
  };
}

test("deleting the session DSH has open releases the main view", async () => {
  const calls = [];
  const view = mainView({ current: "session-a" });
  const host = makeHost({
    sessions: { refresh: async () => calls.push("refresh"), handleSessionRemoved: (id) => calls.push("remove:" + id) },
    uiWorkspace: view.service,
  });
  await loadRemovals(host).api.requestDshRefresh({ removed: ["session-a"] });
  assert.deepEqual(calls, ["remove:session-a"]);
  assert.deepEqual(view.calls, ["clearMain"]);
});

test("deleting some other session leaves the open conversation alone", async () => {
  const view = mainView({ current: "session-b" });
  const host = makeHost({
    sessions: { refresh: async () => {}, handleSessionRemoved: () => {} },
    uiWorkspace: view.service,
  });
  await loadRemovals(host).api.requestDshRefresh({ removed: ["session-a"] });
  assert.deepEqual(view.calls, []);
});

test("the persisted selection answers when no main reference is held", async () => {
  const calls = [];
  const host = makeHost({
    sessions: { refresh: async () => {}, handleSessionRemoved: () => {} },
    uiWorkspace: {
      selection: { getSnapshot: () => ({ sessionId: "session-a" }) },
      clearMain: () => calls.push("clearMain"),
    },
  });
  await loadRemovals(host).api.requestDshRefresh({ removed: ["session-a"] });
  assert.deepEqual(calls, ["clearMain"]);
});

test("a host without uiWorkspace still applies the removal frames", async () => {
  const calls = [];
  const host = makeHost({
    sessions: { refresh: async () => calls.push("refresh"), handleSessionRemoved: (id) => calls.push("remove:" + id) },
  });
  await loadRemovals(host).api.requestDshRefresh({ removed: ["session-a"] });
  assert.deepEqual(calls, ["remove:session-a"]);
});

test("a main view that refuses to clear does not undo the removal", async () => {
  const calls = [];
  const view = mainView({ current: "session-a", clearThrows: true });
  const host = makeHost({
    sessions: { refresh: async () => calls.push("refresh"), handleSessionRemoved: (id) => calls.push("remove:" + id) },
    uiWorkspace: view.service,
  });
  await loadRemovals(host).api.requestDshRefresh({ removed: ["session-a"] });
  assert.deepEqual(calls, ["remove:session-a"]);
  assert.deepEqual(view.calls, []);
});

