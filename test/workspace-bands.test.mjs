/**
 * 所有会话, cut into one band per workspace.
 *
 * 所有会话 is the whole library at once, and the library is not one place: DSH
 * files every session under a workspace. One flat band made each row repeat its
 * workspace in the subtitle, so the list never answered "where does this live"
 * by itself — the bands do, and each caption is the workspace name the tree
 * draws for the same node.
 *
 * Three things are pinned here because they are the ones a caption can get
 * wrong: which workspace a row lands in, the order of the bands, and what a
 * band is called when the tree has never heard of its workspace.
 *
 *   node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildTree } from "../lib/domain/tree.js";
import { FIXED_NODES } from "../lib/constants.js";
import { loadClientBundle } from "./support/client-bundle.mjs";

const { test: api } = loadClientBundle({ expose: ["workspaceBands"] });

const registry = {
  workspaceIds: ["wa", "wb"],
  workspaces: new Map([
    ["wa", { id: "wa", title: "Alpha", path: "C:\\alpha" }],
    ["wb", { id: "wb", title: "Beta", path: "C:\\beta" }],
  ]),
};

const sessions = [
  { id: "s1", workspaceId: "wa" },
  { id: "s2", workspaceId: "wa" },
  { id: "s3", workspaceId: "wb" },
];

const tree = buildTree({ registry, sessions, userTree: { folders: {}, placement: {} } });

/** Rows as the client holds them: the view carries the workspace's own title. */
const row = (id, workspaceId, workspaceTitle, extra = {}) => ({ id, workspaceId, workspaceTitle, ...extra });

const titles = (bands) => bands.map((band) => band.title);
const ids = (band) => band.sessions.map((session) => session.id);

test("one band per workspace, in the tree's own order, 未分组 last", () => {
  const bands = api.workspaceBands(
    [row("s3", "wb", "Beta"), row("s1", "wa", "Alpha"), row("s0", null, null)],
    tree,
  );
  assert.deepEqual(titles(bands), ["Alpha", "Beta", "未分组"]);
  assert.deepEqual(bands.map((band) => band.count), [1, 1, 1]);
  // A workspace band borrows the workspace glyph; 未分组 borrows the one the tree
  // gives it, so the caption reads the same in both surfaces.
  assert.deepEqual(bands.map((band) => band.icon), ["monitor", "monitor", "chat"]);
});

test("a band keeps the order the toolbar asked for", () => {
  const bands = api.workspaceBands(
    [row("s2", "wa", "Alpha"), row("s1", "wa", "Alpha"), row("s3", "wb", "Beta")],
    tree,
  );
  assert.deepEqual(ids(bands[0]), ["s2", "s1"]);
});

test("the caption is the workspace name, never its id", () => {
  const bands = api.workspaceBands([row("s1", "wa", "Alpha")], tree);
  assert.equal(bands[0].title, "Alpha");
  // A view built before the registry caught up still has an id and no title: the
  // id is the only honest thing left to show, and it beats an empty caption.
  const stale = api.workspaceBands([row("s1", "wa", undefined)], tree);
  assert.equal(stale[0].title, "wa");
});

test("a workspace the tree does not know sorts after the ones it does", () => {
  const bands = api.workspaceBands(
    [row("s9", "wz", "Zulu"), row("s1", "wa", "Alpha"), row("s8", "wy", "Alpha too")],
    tree,
  );
  assert.deepEqual(titles(bands), ["Alpha", "Alpha too", "Zulu"]);
});

test("a workspace inside a user folder keeps its place in the tree's order", () => {
  // Drag a workspace into 项目 and the tree draws it there. Reading only 根目录's
  // children would have filed it under "unknown", i.e. after everything else and
  // re-ordered by name — a caption list that disagreed with the tree it mirrors.
  const nested = buildTree({
    registry,
    sessions,
    userTree: {
      folders: { "d-proj": { id: "d-proj", name: "项目", parent: FIXED_NODES.root, order: 9 } },
      placement: { wa: "d-proj" },
    },
  });
  const bands = api.workspaceBands([row("s1", "wa", "Alpha"), row("s3", "wb", "Beta")], nested);
  assert.deepEqual(titles(bands), ["Beta", "Alpha"]);
});

test("nothing to show is no bands at all", () => {
  assert.deepEqual(api.workspaceBands([], tree), []);
  // A tree that never arrived is not a crash: the rows are still split, by the
  // titles they carry.
  const bands = api.workspaceBands([row("s1", "wa", "Alpha"), row("s3", "wb", "Beta")], null);
  assert.deepEqual(titles(bands), ["Alpha", "Beta"]);
});
