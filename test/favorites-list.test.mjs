/**
 * Tests for the membership list `/bootstrap` and `PATCH /annotations/:id` report
 * for 收藏 / 待办.
 *
 * The list answers "which sessions are marked", not "which rows exist": a tree
 * that still carries two shortcuts to one session (an older duplicate the create
 * path now refuses) must not make that session show up twice.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { shortcutSessionTargets } from "../lib/index.js";

const tree = (nodes) => ({ nodes });

test("one shortcut is one member", () => {
  const ids = shortcutSessionTargets(
    tree({ "s-a": { kind: "shortcut", shortcutKind: "session", parent: "f-favorites", targetId: "sess-1" } }),
    "f-favorites",
  );
  assert.deepEqual(ids, ["sess-1"]);
});

test("two shortcuts to the same session are still one member", () => {
  const ids = shortcutSessionTargets(
    tree({
      "s-a": { kind: "shortcut", shortcutKind: "session", parent: "f-favorites", targetId: "sess-1" },
      "s-b": { kind: "shortcut", shortcutKind: "session", parent: "f-favorites", targetId: "sess-1" },
      "s-c": { kind: "shortcut", shortcutKind: "session", parent: "f-favorites", targetId: "sess-2" },
    }),
    "f-favorites",
  );
  assert.deepEqual(ids.sort(), ["sess-1", "sess-2"]);
});

test("other containers and other kinds are not members", () => {
  const ids = shortcutSessionTargets(
    tree({
      "s-a": { kind: "shortcut", shortcutKind: "session", parent: "f-todos", targetId: "sess-1" },
      "s-b": { kind: "shortcut", shortcutKind: "folder", parent: "f-favorites", targetId: "d-1" },
      "d-1": { kind: "folder", parent: "f-favorites" },
    }),
    "f-favorites",
  );
  assert.deepEqual(ids, []);
});

test("a tree with no nodes answers with an empty list", () => {
  assert.deepEqual(shortcutSessionTargets(undefined, "f-favorites"), []);
  assert.deepEqual(shortcutSessionTargets(tree({}), "f-todos"), []);
});
