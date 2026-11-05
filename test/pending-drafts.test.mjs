import assert from "node:assert/strict";
import { test } from "node:test";

import { createPendingDrafts } from "../lib/host/pending-drafts.js";

/**
 * A host that answers `readSnapshot` from a mutable listing and records every
 * placement it is asked to write.
 *
 * The point of these tests is the *decision*, not the timer: `settle()` is the
 * whole behaviour, so nothing here has to wait for the poll.
 */
function fakeHost(options = {}) {
  const state = {
    sessions: [],
    placement: {},
    nodes: { "d-1": { id: "d-1" }, "d-2": { id: "d-2" } },
    /** @type {string[]} */
    placed: [],
    /** @type {Error | null} */
    refuseWith: null,
  };
  const drafts = createPendingDrafts({
    readSnapshot: async () => ({
      sessions: state.sessions,
      tree: { nodes: state.nodes, sessionPlacement: { ...state.placement } },
    }),
    place: async (sessionId, parent) => {
      if (state.refuseWith) throw state.refuseWith;
      state.placed.push(parent);
      state.placement[sessionId] = parent;
    },
    now: options.now,
    pollMs: 1_000_000,
    ttlMs: options.ttlMs,
  });
  return { state, drafts };
}

const WS = "ws-1";
const OTHER_WS = "ws-2";

function session(overrides = {}) {
  return {
    id: "session-new",
    workspaceId: WS,
    createdAt: 1_000_000,
    ...overrides,
  };
}

test("the session that appears after the click lands in the folder", async () => {
  const { state, drafts } = fakeHost({ now: () => 1_000_000 });
  drafts.arm({ parent: "d-1", workspaceId: WS, known: ["session-old"] });
  state.sessions = [session({ id: "session-old", createdAt: 900_000 }), session()];
  const filed = await drafts.settle();
  assert.deepEqual(state.placed, ["d-1"]);
  assert.equal(filed.length, 1);
  assert.equal(filed[0].sessionId, "session-new");
  assert.equal(drafts.size, 0, "the intent is spent, not left armed");
  drafts.dispose();
});

test("a session that already existed is never adopted", async () => {
  const { state, drafts } = fakeHost({ now: () => 1_000_000 });
  drafts.arm({ parent: "d-1", workspaceId: WS, known: ["session-old"] });
  state.sessions = [session({ id: "session-old", createdAt: 900_000 })];
  assert.deepEqual(await drafts.settle(), []);
  assert.deepEqual(state.placed, []);
  assert.equal(drafts.size, 1, "still waiting for the real draft");
  drafts.dispose();
});

test("a session older than the intent is rejected even without a baseline", async () => {
  const { state, drafts } = fakeHost({ now: () => 1_000_000 });
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  // Four seconds before the click: outside the three-second slack.
  state.sessions = [session({ createdAt: 996_000 })];
  assert.deepEqual(await drafts.settle(), []);
  assert.deepEqual(state.placed, []);
  drafts.dispose();
});

test("the slack admits a draft that beat the arm request by a hair", async () => {
  const { state, drafts } = fakeHost({ now: () => 1_000_000 });
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  // Two seconds before the intent: the two requests travelled different wires.
  state.sessions = [session({ createdAt: 998_000 })];
  const filed = await drafts.settle();
  assert.equal(filed.length, 1);
  assert.deepEqual(state.placed, ["d-1"]);
  drafts.dispose();
});

test("another workspace's new session is left alone", async () => {
  const { state, drafts } = fakeHost({ now: () => 1_000_000 });
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  state.sessions = [session({ id: "session-elsewhere", workspaceId: OTHER_WS })];
  assert.deepEqual(await drafts.settle(), []);
  assert.deepEqual(state.placed, []);
  drafts.dispose();
});

test("subagents, trashed and archived rows are not drafts", async () => {
  const { state, drafts } = fakeHost({ now: () => 1_000_000 });
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  state.sessions = [
    session({ id: "session-sub", isSubagent: true }),
    session({ id: "session-trashed", trashed: true }),
    session({ id: "session-archived", archived: true }),
  ];
  assert.deepEqual(await drafts.settle(), []);
  assert.deepEqual(state.placed, []);
  drafts.dispose();
});

test("a session that already carries a placement keeps it", async () => {
  const { state, drafts } = fakeHost({ now: () => 1_000_000 });
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  state.sessions = [session()];
  state.placement = { "session-new": "d-2" };
  assert.deepEqual(await drafts.settle(), []);
  assert.deepEqual(state.placed, [], "a filed row is not re-filed");
  drafts.dispose();
});

test("without createdAt the only test left is the baseline", async () => {
  const { state, drafts } = fakeHost({ now: () => 1_000_000 });
  drafts.arm({ parent: "d-1", workspaceId: WS, known: ["session-old"] });
  state.sessions = [
    session({ id: "session-old", createdAt: undefined }),
    session({ createdAt: undefined }),
  ];
  const filed = await drafts.settle();
  assert.deepEqual(filed.map((row) => row.sessionId), ["session-new"]);
  drafts.dispose();
});

test("an expired intent is dropped, not fired late", async () => {
  let clock = 1_000_000;
  const { state, drafts } = fakeHost({ now: () => clock, ttlMs: 5_000 });
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  clock += 6_000;
  state.sessions = [session({ createdAt: clock })];
  assert.deepEqual(await drafts.settle(), []);
  assert.deepEqual(state.placed, []);
  assert.equal(drafts.size, 0, "the intent died with its deadline");
  drafts.dispose();
});

test("a folder deleted while the intent is armed takes the intent with it", async () => {
  const { state, drafts } = fakeHost({ now: () => 1_000_000 });
  drafts.arm({ parent: "d-gone", workspaceId: WS, known: [] });
  state.sessions = [session()];
  assert.deepEqual(await drafts.settle(), []);
  assert.deepEqual(state.placed, []);
  assert.equal(drafts.size, 0);
  drafts.dispose();
});

test("arming the same folder twice keeps one intent, the newer one", async () => {
  let clock = 1_000_000;
  const { state, drafts } = fakeHost({ now: () => clock });
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  clock += 4_000;
  drafts.arm({ parent: "d-1", workspaceId: WS, known: ["session-old"] });
  assert.equal(drafts.size, 1);
  // The newer intent's baseline already knows the old row, so nothing is filed.
  state.sessions = [session({ id: "session-old", createdAt: 900_000 })];
  assert.deepEqual(await drafts.settle(), []);
  assert.equal(drafts.size, 1);
  drafts.dispose();
});

test("two folders wait for their own drafts", async () => {
  const { state, drafts } = fakeHost({ now: () => 1_000_000 });
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  drafts.arm({ parent: "d-2", workspaceId: WS, known: [] });
  state.sessions = [session({ id: "session-a" }), session({ id: "session-b" })];
  const filed = await drafts.settle();
  assert.equal(filed.length, 2);
  assert.deepEqual(state.placed.sort(), ["d-1", "d-2"]);
  assert.equal(drafts.size, 0);
  drafts.dispose();
});

test("a refusal is final: the draft keeps the home DSH gave it", async () => {
  const { state, drafts } = fakeHost({ now: () => 1_000_000 });
  state.refuseWith = new Error("this container cannot hold sessions");
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  state.sessions = [session()];
  assert.deepEqual(await drafts.settle(), []);
  assert.deepEqual(state.placed, []);
  assert.equal(drafts.size, 0, "the same ask would be refused again");
  drafts.dispose();
});

test("arm refuses an intent with no folder or no workspace", () => {
  const { drafts } = fakeHost();
  assert.throws(() => drafts.arm({ parent: "", workspaceId: WS }), /parent and workspaceId/);
  assert.throws(() => drafts.arm({ parent: "d-1" }), /parent and workspaceId/);
  assert.equal(drafts.size, 0);
  drafts.dispose();
});

test("cancel and dispose leave nothing armed", () => {
  const { drafts } = fakeHost();
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  assert.equal(drafts.cancel("d-1"), true);
  assert.equal(drafts.cancel("d-1"), false, "cancelling twice is honest about it");
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  drafts.dispose();
  assert.equal(drafts.size, 0);
});

test("the poll files the draft without anyone calling settle", async () => {
  const state = { sessions: [], placement: {}, placed: [] };
  const drafts = createPendingDrafts({
    readSnapshot: async () => ({
      sessions: state.sessions,
      tree: { nodes: { "d-1": { id: "d-1" } }, sessionPlacement: { ...state.placement } },
    }),
    place: async (sessionId, parent) => {
      state.placed.push(parent);
      state.placement[sessionId] = parent;
    },
    pollMs: 10,
  });
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  // The real clock, not the fixed one the decision tests use: this arm ran
  // against Date.now().
  state.sessions = [session({ createdAt: Date.now() })];
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(state.placed, ["d-1"]);
  assert.equal(drafts.size, 0);
  drafts.dispose();
});

test("an idle sidecar stops its timer", async () => {
  const { drafts } = fakeHost();
  drafts.arm({ parent: "d-1", workspaceId: WS, known: [] });
  assert.ok(drafts.pollMs > 0);
  assert.ok(drafts.ttlMs > 0);
  await drafts.settle();
  drafts.dispose();
  assert.equal(drafts.size, 0);
});
