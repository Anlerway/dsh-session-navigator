/**
 * Tests for the one-session state DSH's own surfaces read.
 *
 *   node --test test/session-state.test.mjs
 *
 * The interesting part is not the three booleans but where each comes from and
 * what "trashed" means: two layers can each say it, and only one of them holds
 * the payload.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { sessionStateOf } from "../lib/domain/session-state.js";

// The sidecar stores shortcuts as a plain map, keyed by node id.
const shortcuts = (entries) => entries;
const trash = (entries) => ({ entries });
/** One session shortcut in one container, the way the tree sidecar stores it. */
const pointer = (targetId, parent) => ({ kind: "session", targetId, parent });

test("a live session with no shortcuts reads as all-false", () => {
  const state = sessionStateOf(
    { shortcuts: shortcuts({}), trash: trash({}), sessions: [{ id: "session-1" }] },
    "session-1",
  );
  assert.deepEqual(state, {
    id: "session-1",
    favorite: false,
    todo: false,
    favoriteShortcut: null,
    todoShortcut: null,
    archived: false,
    trashed: false,
    subagent: false,
  });
});

test("membership is the shortcut: the container and the kind both have to match", () => {
  const documents = {
    shortcuts: shortcuts({
      "s-fav0001": pointer("session-1", "f-favorites"),
      "s-todo0001": pointer("session-2", "f-todos"),
      // A folder shortcut that happens to name this session is not membership.
      "s-fold": { kind: "folder", targetId: "session-1", parent: "f-favorites" },
      // A session shortcut living in an ordinary folder is a pointer, not a flag.
      "s-loose": { kind: "session", targetId: "session-1", parent: "d-1" },
    }),
    trash: trash({}),
    sessions: [{ id: "session-1" }, { id: "session-2" }],
  };
  const one = sessionStateOf(documents, "session-1");
  assert.equal(one.favorite, true, "a session shortcut in 收藏 is a favorite");
  assert.equal(one.favoriteShortcut, "s-fav0001", "the id travels so 取消收藏 can delete it");
  assert.equal(one.todo, false, "a 待办 shortcut is not a 收藏");
  assert.equal(one.todoShortcut, null);

  const two = sessionStateOf(documents, "session-2");
  assert.equal(two.todo, true);
  assert.equal(two.todoShortcut, "s-todo0001");
  assert.equal(two.favorite, false, "another session's 收藏 must not leak");
});

test("archived is what the reader says about the session", () => {
  const documents = { shortcuts: shortcuts({}), trash: trash({}), sessions: [{ id: "session-1", archived: true }] };
  assert.equal(sessionStateOf(documents, "session-1").archived, true);
  assert.equal(
    sessionStateOf({ ...documents, sessions: [{ id: "session-1", archived: "yes" }] }, "session-1").archived,
    false,
    "only a boolean true archives",
  );
});

test("either layer can say trashed, and neither one alone can be ignored", () => {
  // The bin holds the payload: a session whose reader row is already gone still
  // reads as trashed while a restore settles.
  const inBin = { shortcuts: shortcuts({}), trash: trash({ "session-1": { path: "x" } }), sessions: [] };
  assert.equal(sessionStateOf(inBin, "session-1").trashed, true);
  // And the reader can report it before the bin document is written.
  const reported = { shortcuts: shortcuts({}), trash: trash({}), sessions: [{ id: "session-1", trashed: true }] };
  assert.equal(sessionStateOf(reported, "session-1").trashed, true);
  // A bin entry for somebody else must not leak.
  const other = { shortcuts: shortcuts({}), trash: trash({ "session-2": {} }), sessions: [{ id: "session-1" }] };
  assert.equal(sessionStateOf(other, "session-1").trashed, false);
});

test("an unknown session answers all-false rather than throwing", () => {
  assert.deepEqual(sessionStateOf({ shortcuts: null, trash: null, sessions: null }, "nope"), {
    id: "nope",
    favorite: false,
    todo: false,
    favoriteShortcut: null,
    todoShortcut: null,
    archived: false,
    trashed: false,
    subagent: false,
  });
});

test("subagent is the reader's own flag, and a fork is not one", () => {
  // The header menu hides 收藏/待办/归档/删除 behind this one bit, so it has to
  // come from the reader (which knows origin/delegationDepth), never from
  // `parentSession` — a fork also carries a parent and is a session of its own.
  const documents = {
    shortcuts: shortcuts({}),
    trash: trash({}),
    sessions: [
      { id: "child", isSubagent: true },
      { id: "fork", isSubagent: false, isSeeded: true, parentSession: "session-1" },
    ],
  };
  assert.equal(sessionStateOf(documents, "child").subagent, true);
  assert.equal(sessionStateOf(documents, "fork").subagent, false);
  // A truthy non-boolean is not the flag.
  const loose = { ...documents, sessions: [{ id: "child", isSubagent: "yes" }] };
  assert.equal(sessionStateOf(loose, "child").subagent, false);
});
