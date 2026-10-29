/**
 * 多选拖动 (m01540) — one drag carries the whole check-set.
 *
 * A check-set is a flat list of ids, and the ids of a session, a folder and a
 * workspace look alike: no prefix tells them apart. What a drop target can take
 * differs per kind — a workspace takes sessions, 未分组 takes both, 收藏 takes
 * anything as a reference — so the set is split once, before it is handed over.
 * That split is a pure function, which is what this file pins.
 *
 *   node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle } from "./support/client-bundle.mjs";

const { test: api } = loadClientBundle({ expose: ["splitDragIds"] });

const nodes = {
  "f-1": { id: "f-1", type: "folder", name: "文件夹" },
  "w-1": { id: "w-1", type: "workspace", name: "project" },
};
// A session id is opaque — never a prefix — so the index has to answer.
const sessionsById = new Map([["s-1", { id: "s-1" }], ["s-2", { id: "s-2" }]]);

test("the set is split by what the tree and the index say, not by the id", () => {
  const split = api.splitDragIds(["s-1", "f-1", "s-2", "w-1"], { nodes, sessionsById });
  assert.deepEqual(split.sessions, ["s-1", "s-2"]);
  assert.deepEqual(split.nodes, ["f-1", "w-1"]);
  // Containers first: the caller hands `ids` to paths that never care, but a
  // stable order is what makes a toast or a log readable.
  assert.deepEqual(split.ids, ["f-1", "w-1", "s-1", "s-2"]);
});

test("an id that nothing knows is dropped instead of being guessed at", () => {
  const split = api.splitDragIds(["s-1", "gone", "", null, undefined], { nodes, sessionsById });
  assert.deepEqual(split.ids, ["s-1"]);
  assert.deepEqual(split.nodes, []);
});

test("a duplicate id rides once", () => {
  const split = api.splitDragIds(["s-1", "f-1", "s-1", "f-1"], { nodes, sessionsById });
  assert.deepEqual(split.sessions, ["s-1"]);
  assert.deepEqual(split.nodes, ["f-1"]);
});

test("an id of a container never counts as a session, even when the index has it", () => {
  // A misplaced index is not a reason to move a folder as a session: the tree
  // is the authority on containers.
  const both = new Map([["f-1", { id: "f-1" }], ["s-1", { id: "s-1" }]]);
  const split = api.splitDragIds(["f-1", "s-1"], { nodes, sessionsById: both });
  assert.deepEqual(split.nodes, ["f-1"]);
  assert.deepEqual(split.sessions, ["s-1"]);
});

test("without a session index every non-container id is a session", () => {
  // The pane always has both, but a container-only list (a list of folders) can
  // drop the index, and the split must still be usable.
  const split = api.splitDragIds(["s-1", "f-1"], { nodes });
  assert.deepEqual(split.sessions, ["s-1"]);
  assert.deepEqual(split.nodes, ["f-1"]);
});

test("an empty set splits into an empty set", () => {
  assert.deepEqual(api.splitDragIds([], { nodes, sessionsById }), { ids: [], sessions: [], nodes: [] });
});
