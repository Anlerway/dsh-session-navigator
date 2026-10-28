/**
 * Tests for the 收藏 / 待办 flag migration (P13).
 *
 *   node --test test/flags.test.mjs
 *
 * 收藏 and 待办 stopped being annotation flags and became shortcut containers.
 * The migration is the one-way door between them, so the properties that matter
 * are the ones a half-finished run could break:
 *
 *   - every flagged session gains the shortcut it would have had;
 *   - the flag is cleared afterwards, or a shortcut the user removed would come
 *     back on the next start;
 *   - the shortcut is written *before* the flag is cleared, so an interrupted
 *     run leaves the flag to retry rather than losing the membership;
 *   - a stale flag (a session that no longer exists) must not fail the run.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { migrateFlagsToShortcuts } from "../lib/host/flags.js";

/**
 * A documents api with the two sidecars the migration touches.
 *
 * `tree.mutate` and `annotations.mutate` hand out a draft and commit it only if
 * the work function returns, which is how the real document layer behaves — the
 * ordering test depends on it.
 *
 * @param {{ shortcuts?: Record<string, any>, sessions?: Record<string, any> }} [start]
 */
function fakeApi(start = {}) {
  const state = {
    tree: { shortcuts: start.shortcuts ?? {} },
    annotations: { sessions: start.sessions ?? {} },
  };
  /** @param {any} target @param {(draft: any) => void} work */
  const mutate = async (target, work) => {
    const draft = structuredClone(target);
    work(draft);
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, draft);
    return { revision: 1 };
  };
  return {
    state,
    api: {
      documents: {
        tree: {
          read: async () => structuredClone(state.tree),
          mutate: (work) => mutate(state.tree, work),
        },
        annotations: {
          read: async () => structuredClone(state.annotations),
          mutate: (work) => mutate(state.annotations, work),
        },
      },
    },
  };
}

/** Ids the migration hands out, in order. */
function ids(prefix = "g") {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

/** @param {any} state */
function shortcutsOf(state) {
  return Object.values(state.tree.shortcuts ?? {});
}

test("a favorite flag becomes a shortcut and the flag is cleared", async () => {
  const { api, state } = fakeApi({
    sessions: {
      "session-a": { favorite: true, tags: ["release"], updatedAt: 5 },
      "session-b": { tags: ["draft"], updatedAt: 6 },
    },
  });
  const result = await migrateFlagsToShortcuts(api, ids());

  assert.deepEqual(result, { moved: 1, created: 1 });
  const [shortcut] = shortcutsOf(state);
  assert.equal(shortcut.kind, "session");
  assert.equal(shortcut.targetId, "session-a");
  assert.equal(shortcut.parent, "f-favorites");
  assert.equal(shortcut.id.startsWith("s-"), true);
  // The flag is gone, the note and tags it sat next to are not.
  const kept = state.annotations.sessions["session-a"];
  assert.deepEqual(kept.tags, ["release"]);
  assert.equal(kept.favorite, false);
  assert.equal(kept.todo, false);
  // The entry is still there because the tags are: only the flags were cleared.
  assert.equal(typeof kept.updatedAt, "number");
  // A session that was never flagged keeps its entry untouched: the migration
  // walks the flagged rows only, it does not rewrite the sidecar.
  assert.deepEqual(state.annotations.sessions["session-b"], { tags: ["draft"], updatedAt: 6 });
});

test("a session in both containers gets one shortcut in each", async () => {
  const { api, state } = fakeApi({ sessions: { "session-a": { favorite: true, todo: true } } });
  const result = await migrateFlagsToShortcuts(api, ids());

  // One session moved, two shortcuts created: the two counts mean different
  // things and a caller reporting them must not conflate them.
  assert.deepEqual(result, { moved: 1, created: 2 });
  assert.deepEqual(
    shortcutsOf(state).map((entry) => entry.parent).sort(),
    ["f-favorites", "f-todos"],
  );
});

test("a session that was only favorited loses its annotation entry entirely", async () => {
  const { api, state } = fakeApi({ sessions: { "session-a": { favorite: true } } });
  await migrateFlagsToShortcuts(api, ids());
  // An entry carrying nothing but a cleared flag is deleted, not left as a shell.
  assert.equal("session-a" in state.annotations.sessions, false);
});

test("running twice creates nothing the second time", async () => {
  const { api, state } = fakeApi({ sessions: { "session-a": { favorite: true } } });
  await migrateFlagsToShortcuts(api, ids());
  const second = await migrateFlagsToShortcuts(api, ids());

  assert.deepEqual(second, { moved: 0, created: 0 });
  assert.equal(shortcutsOf(state).length, 1);
});

test("a shortcut the user already made is reused, not duplicated", async () => {
  const { api, state } = fakeApi({
    shortcuts: {
      "s-existing": { id: "s-existing", kind: "session", targetId: "session-a", parent: "f-favorites", order: 0 },
    },
    sessions: { "session-a": { favorite: true } },
  });
  const result = await migrateFlagsToShortcuts(api, ids());

  assert.deepEqual(result, { moved: 1, created: 0 });
  assert.deepEqual(Object.keys(state.tree.shortcuts), ["s-existing"]);
  // The flag is still cleared: the membership already exists, so leaving the
  // flag behind would only make the next start re-read it forever.
  assert.equal("session-a" in state.annotations.sessions, false);
});

test("a stale flag for a session that is gone does not fail the run", async () => {
  const { api, state } = fakeApi({ sessions: { "session-gone": { favorite: true }, "session-b": { todo: true } } });
  const result = await migrateFlagsToShortcuts(api, ids());

  // The write is unvalidated on purpose: the tree projection drops a shortcut
  // whose target is missing, and a migration that threw here would strand every
  // later flag.
  assert.deepEqual(result, { moved: 2, created: 2 });
  assert.equal(shortcutsOf(state).length, 2);
  assert.equal("session-gone" in state.annotations.sessions, false);
});

test("the flag survives when the shortcut write fails", async () => {
  const { api, state } = fakeApi({ sessions: { "session-a": { favorite: true, tags: ["keep"] } } });
  api.documents.tree.mutate = async () => {
    throw new Error("disk full");
  };

  await assert.rejects(() => migrateFlagsToShortcuts(api, ids()), /disk full/);
  // Ordering is the safety property: nothing was cleared, so the next start
  // retries the whole migration instead of dropping the membership.
  assert.equal(state.annotations.sessions["session-a"].favorite, true);
  assert.equal(shortcutsOf(state).length, 0);
});

test("no flags at all is a no-op, and does not touch either sidecar", async () => {
  const { api, state } = fakeApi({ sessions: { "session-a": { tags: ["x"] } } });
  let writes = 0;
  const tree = api.documents.tree.mutate;
  api.documents.tree.mutate = (work) => {
    writes += 1;
    return tree(work);
  };
  const result = await migrateFlagsToShortcuts(api, ids());

  assert.deepEqual(result, { moved: 0, created: 0 });
  assert.equal(writes, 0);
  assert.deepEqual(Object.keys(state.tree.shortcuts), []);
});
