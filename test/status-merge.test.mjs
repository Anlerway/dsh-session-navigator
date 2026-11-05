/**
 * The rows the list is handed after an announcement arrives.
 *
 * The detached window has no status service of its own, so the peer's rows are
 * all it has. They used to be handed back as the live map itself, and every
 * consumer memoises on that identity — `withDshStatus` folds the status into the
 * list, and the list only rebuilds when the folded input changes. Same map,
 * same identity, no rebuild: the badge on screen stayed a beat behind the data
 * the window had already received.
 *
 *   node --test test/status-merge.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle } from "./support/client-bundle.mjs";

function store() {
  return loadClientBundle({
    expose: ["applyPeerStatus", "useDshSessionStatus"],
  }).test;
}

test("每次宣告都交出一张新的表", () => {
  const api = store();
  assert.equal(api.useDshSessionStatus(), null, "nothing announced yet, nothing to hand over");

  api.applyPeerStatus([{ id: "s1", running: true }], 1_000);
  const live = api.useDshSessionStatus();
  api.applyPeerStatus([{ id: "s1", running: false }], 1_010);
  const idle = api.useDshSessionStatus();

  assert.notEqual(live, idle, "the new announcement must not reuse the previous map");
  assert.equal(live.get("s1").running, true, "the older answer stays a snapshot, not a live view");
  assert.equal(idle.get("s1").running, false);
});

test("表里带着徽章要的三个字段", () => {
  const api = store();
  api.applyPeerStatus([{ id: "s1", running: true, pending: "question", completed: true }], 2_000);
  const rows = api.useDshSessionStatus();
  assert.deepEqual(rows.get("s1"), { running: true, pendingInteraction: "question", completionUnread: true });
});

test("同一个状态重播两次，行内容不变", () => {
  const api = store();
  api.applyPeerStatus([{ id: "s1", pending: "approval" }], 3_000);
  const first = api.useDshSessionStatus();
  api.applyPeerStatus([{ id: "s1", pending: "approval" }], 3_010);
  const second = api.useDshSessionStatus();
  assert.deepEqual([...second.entries()], [...first.entries()]);
  assert.notEqual(second, first, "a fresh map per announcement, even when the content repeats");
});
