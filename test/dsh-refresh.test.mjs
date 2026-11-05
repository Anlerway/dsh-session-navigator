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
