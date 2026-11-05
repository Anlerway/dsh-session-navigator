/**
 * Tests for `POST /nodes/:id/reorder`.
 *
 * The domain function ranks siblings inside the document; the route is what
 * decides whether the id names anything at all. A workspace is not stored in the
 * document, so an unchecked id would write a rank for a row nobody draws.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ROUTES } from "../lib/index.js";

const reorder = ROUTES["POST /nodes/:id/reorder"];

function fakeApi(overrides = {}) {
  const state = {
    revision: 3,
    tree: {
      nodes: { "w-ws-1": { id: "w-ws-1", type: "workspace" }, "s-abc": { id: "s-abc", type: "shortcut" } },
      shortcuts: { "s-abc": { id: "s-abc", kind: "session", targetId: "sess-1", order: 1 } },
      folders: {},
      workspaceOrder: {},
      sessionPlacement: {},
    },
  };
  return {
    state,
    reader: {
      async snapshot() {
        return { tree: structuredClone(state.tree), sessions: [], view: { sessions: [] } };
      },
    },
    documents: {
      tree: {
        async mutate(fn, expected) {
          if (Number.isFinite(expected) && expected !== state.revision) {
            throw Object.assign(new Error("revision conflict"), { code: "revision-conflict" });
          }
          const draft = structuredClone(state.tree);
          fn(draft);
          state.tree = draft;
          state.revision += 1;
          return { revision: state.revision, document: draft };
        },
      },
    },
    ...overrides,
  };
}

const call = (api, id, body) => reorder(api, { params: { id }, body, headers: {} });

test("a workspace with a real id is ranked in workspaceOrder", async () => {
  const api = fakeApi();
  const result = await call(api, "w-ws-1", { order: 4 });
  assert.equal(result.order, 4);
  assert.equal(result.revision, 4);
  assert.equal(api.state.tree.workspaceOrder["ws-1"], 4);
});

test("a rank parked under the node id is cleared when the workspace is reordered", async () => {
  const api = fakeApi();
  api.state.tree.workspaceOrder["w-ws-1"] = 0;
  const result = await call(api, "w-ws-1", { order: 7 });
  assert.equal(result.order, 7);
  assert.deepEqual(api.state.tree.workspaceOrder, { "ws-1": 7 });
});

test("a workspace id that names nothing is refused instead of ranked", async () => {
  const api = fakeApi();
  await assert.rejects(() => call(api, "w-w-ws-1", { order: 2 }), (error) => {
    assert.equal(error.code, "node-not-found");
    return true;
  });
  assert.deepEqual(api.state.tree.workspaceOrder, {});
  assert.equal(api.state.revision, 3);
});

test("a shortcut keeps its own order", async () => {
  const api = fakeApi();
  const result = await call(api, "s-abc", { order: 9 });
  assert.equal(result.order, 9);
  assert.equal(api.state.tree.shortcuts["s-abc"].order, 9);
});

test("an order that is not a number never reaches the document", async () => {
  const api = fakeApi();
  await assert.rejects(() => call(api, "w-ws-1", { order: "abc" }), (error) => {
    assert.equal(error.code, "bad-request");
    assert.match(error.message, /order must be a number/);
    return true;
  });
  assert.equal(api.state.revision, 3);
});

test("a stale revision is refused by the sidecar", async () => {
  const api = fakeApi();
  await assert.rejects(() => call(api, "w-ws-1", { order: 1, revision: 99 }), (error) => {
    assert.equal(error.code, "revision-conflict");
    return true;
  });
});
