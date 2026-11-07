/**
 * Tests for POST /sessions/placement/pending — the intent the panel arms before
 * it asks DSH to open a draft inside a folder.
 *
 *   node --test test/placement-pending.test.mjs
 *
 * The route writes nothing: it validates the container the draft is meant for
 * and answers with what the host remembered. The filing itself is
 * src/host/pending-drafts.js, tested on its own.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ROUTES } from "../src/index.js";

const pending = ROUTES["POST /sessions/placement/pending"];

/**
 * 根目录 { 未分组, w-ws { d-in }, d-out }
 *
 * `d-in` sits inside the workspace, so it can hold a session; `d-out` sits
 * outside every workspace and cannot.
 */
const tree = {
  nodes: {
    "f-root": { id: "f-root", kind: "root", fixed: true, parent: null },
    "f-ungrouped": { id: "f-ungrouped", kind: "ungrouped", fixed: true, parent: "f-root" },
    "w-ws1": { id: "w-ws1", kind: "workspace", fixed: false, parent: "f-root", workspaceId: "ws1" },
    "d-in": { id: "d-in", kind: "folder", fixed: false, parent: "w-ws1" },
    "d-out": { id: "d-out", kind: "folder", fixed: false, parent: "f-root" },
  },
  sessionPlacement: {},
};

/** An api that answers the snapshot and records what the route armed. */
function fakeApi(options = {}) {
  const armed = [];
  return {
    armed,
    reader: {
      async snapshot() {
        return { sessions: options.sessions ?? [{ id: "session-old" }], tree };
      },
    },
    pendingDrafts: {
      arm(request) {
        armed.push(request);
        return { parent: request.parent, workspaceId: request.workspaceId, since: 1, expiresAt: 2 };
      },
    },
  };
}

const badRequest = (error) => error.code === "bad-request";

test("a folder inside a workspace arms an intent for that folder", async () => {
  const api = fakeApi();
  const answer = await pending(api, { body: { parent: "d-in" } });
  assert.deepEqual(api.armed, [{ parent: "d-in", workspaceId: "ws1", known: ["session-old"] }]);
  assert.equal(answer.parent, "d-in");
  assert.equal(answer.workspaceId, "ws1");
});

test("a workspace row is accepted too: the draft lands at its root anyway", async () => {
  const api = fakeApi();
  await pending(api, { body: { parent: "w-ws1" } });
  assert.deepEqual(api.armed, [{ parent: "w-ws1", workspaceId: "ws1", known: ["session-old"] }]);
});

test("the baseline is the sessions that exist right now", async () => {
  const api = fakeApi({ sessions: [{ id: "a" }, { id: "b" }] });
  await pending(api, { body: { parent: "d-in" } });
  assert.deepEqual(api.armed[0].known, ["a", "b"]);
});

test("no parent at all", async () => {
  await assert.rejects(
    () => pending(fakeApi(), { body: {} }),
    (error) => badRequest(error) && error.message === "parent is required",
  );
});

test("a parent the tree does not draw", async () => {
  await assert.rejects(
    () => pending(fakeApi(), { body: { parent: "d-deleted" } }),
    (error) => badRequest(error) && error.message === "parent node does not exist",
  );
});

test("a container that cannot hold sessions refuses before anything is armed", async () => {
  const api = fakeApi();
  for (const parent of ["f-root", "d-out"]) {
    await assert.rejects(
      () => pending(api, { body: { parent } }),
      (error) => badRequest(error) && error.message === "this container cannot hold sessions",
    );
  }
  assert.deepEqual(api.armed, []);
});

test("未分组 holds sessions but has no workspace to open a draft in", async () => {
  const api = fakeApi();
  await assert.rejects(
    () => pending(api, { body: { parent: "f-ungrouped" } }),
    (error) => badRequest(error) && error.message.includes("工作区"),
  );
  assert.deepEqual(api.armed, []);
});