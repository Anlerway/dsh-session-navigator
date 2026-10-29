/**
 * 快速访问 is one ordered sequence, so a drag is one write of the whole order.
 *
 * These tests pin the two rules the gesture depends on:
 *
 *   - a drop adds the container it names, without needing a separate "add" call;
 *   - an id that cannot be a bookmark (a view, a shortcut, a folder this sidecar
 *     does not know) is skipped, not rejected — a stale row must not void a drag.
 *
 * node --test test/quick-access.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyQuickAccessOrder, isBookmarkable } from "../lib/domain/quick-access.js";
import { FIXED_NODES } from "../lib/constants.js";

const draftOf = (...folders) => ({
  folders: Object.fromEntries(folders.map((id) => [id, { id, name: id, parent: FIXED_NODES.root, order: 0 }])),
  placement: {},
  workspaceOrder: {},
});

test("only a real container can be a bookmark", () => {
  const draft = draftOf("d-a");
  assert.equal(isBookmarkable(draft, "d-a"), true);
  assert.equal(isBookmarkable(draft, "w-3f6a1c"), true, "a workspace node id is w-<native id>");
  assert.equal(isBookmarkable(draft, "d-gone"), false, "a folder the sidecar does not know");
  assert.equal(isBookmarkable(draft, FIXED_NODES.root), false, "根目录 is a view, and it has a rail row");
  assert.equal(isBookmarkable(draft, FIXED_NODES.favorites), false);
  assert.equal(isBookmarkable(draft, FIXED_NODES.todos), false);
  assert.equal(isBookmarkable(draft, "s-abc"), false, "a shortcut is a pointer, not a place");
  assert.equal(isBookmarkable(draft, ""), false);
  assert.equal(isBookmarkable(draft, null), false);
});

test("the order is written as given, first row first", () => {
  const draft = draftOf("d-a", "d-b", "d-c");
  const { order, skipped } = applyQuickAccessOrder(draft, ["d-b", "d-c", "d-a"], 1000);
  assert.deepEqual(order, ["d-b", "d-c", "d-a"]);
  assert.deepEqual(skipped, []);
  // Descending, so the projection's "newest first" puts d-b on top.
  assert.equal(draft.quickAccess["d-b"], 1000);
  assert.equal(draft.quickAccess["d-c"], 999);
  assert.equal(draft.quickAccess["d-a"], 998);
});

test("a drop adds what it names: the strip is written, not just reordered", () => {
  const draft = draftOf("d-a", "d-b");
  draft.quickAccess = { "d-a": 10 };
  applyQuickAccessOrder(draft, ["d-b", "d-a"], 2000);
  assert.deepEqual(Object.keys(draft.quickAccess).sort(), ["d-a", "d-b"]);
  assert.ok(draft.quickAccess["d-b"] > draft.quickAccess["d-a"], "the dropped folder leads the strip");
});

test("unknown ids are skipped and the rest still lands", () => {
  const draft = draftOf("d-a", "d-b");
  const { order, skipped } = applyQuickAccessOrder(draft, ["s-x", FIXED_NODES.trash, "d-a", "d-nope", "d-b"], 3000);
  assert.deepEqual(order, ["d-a", "d-b"]);
  assert.deepEqual(skipped, ["s-x", FIXED_NODES.trash, "d-nope"]);
  assert.equal(draft.quickAccess["s-x"], undefined);
  assert.equal(draft.quickAccess[FIXED_NODES.trash], undefined);
});

test("a bookmark the drag never mentioned keeps its sequence and stays put", () => {
  const draft = draftOf("d-a", "d-b", "d-keep");
  draft.quickAccess = { "d-keep": 5 };
  applyQuickAccessOrder(draft, ["d-a", "d-b"], 4000);
  assert.equal(draft.quickAccess["d-keep"], 5, "untouched, not swallowed by the rewrite");
  assert.ok(draft.quickAccess["d-a"] > draft.quickAccess["d-keep"]);
});

test("a body that is not a list is refused by the caller, not silently emptied", () => {
  // The route checks the shape before it opens a transaction; this pins the
  // domain layer's side of that contract: non-arrays simply do nothing.
  const draft = draftOf("d-a");
  draft.quickAccess = { "d-a": 7 };
  assert.deepEqual(applyQuickAccessOrder(draft, null, 5000), { order: [], skipped: [] });
  assert.deepEqual(draft.quickAccess, { "d-a": 7 });
});
