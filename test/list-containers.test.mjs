/**
 * The container rows a list shows.
 *
 * Two rules share one function, because they are one question — *which folders
 * belong in this list right now*: search widens the net to the whole tree (a
 * search box that cannot find a folder three levels down is a search box that
 * lies), and a filter turns the list into a result view whose rows are the
 * containers that hold a match (a folder answers a question about sessions by
 * containing one, not by being named after one).
 *
 *   node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildTree, workspaceNodeId } from "../lib/domain/tree.js";
import { FIXED_NODES } from "../lib/constants.js";
import { loadClientBundle } from "./support/client-bundle.mjs";

const { test: api } = loadClientBundle({ expose: ["listContainers"] });

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

/** A tree where wa lives inside the user folder 项目. */
const tree = buildTree({
  registry,
  sessions,
  userTree: {
    folders: { "d-proj": { id: "d-proj", name: "项目", parent: FIXED_NODES.root, order: 0 } },
    placement: { wa: "d-proj" },
  },
});

/** The rows as the client sees them: each one knows its home container. */
const rows = (home) => sessions.filter((session) => session.workspaceId === home).map((session) => ({ ...session, home: workspaceNodeId(home) }));

const ids = (containers) => containers.map((node) => node.id).sort();

test("standing in 根目录 lists the containers directly inside it", () => {
  const listed = api.listContainers({
    tree,
    scope: FIXED_NODES.root,
    needle: "",
    filterActive: false,
    filterAll: true,
    sessions: [...rows("wa"), ...rows("wb")],
  });
  // wa moved into 项目, so it is not a row at the root any more.
  assert.deepEqual(ids(listed), ["d-proj", "w-wb"]);
});

test("范围=当前容器 keeps the filter local", () => {
  const listed = api.listContainers({
    tree,
    scope: FIXED_NODES.root,
    needle: "",
    filterActive: true,
    filterAll: false,
    sessions: rows("wa"),
  });
  // The hit lives under 项目, which is a child of the root: 项目 answers, and
  // w-wb (no matching session) does not. wa itself is not a root-level row.
  assert.deepEqual(ids(listed), ["d-proj"]);
});

test("范围=全部 turns the filter into a question about the library", () => {
  const listed = api.listContainers({
    tree,
    scope: FIXED_NODES.root,
    needle: "",
    filterActive: true,
    filterAll: true,
    sessions: rows("wa"),
  });
  // Widened: both the folder holding the hit and the workspace holding it.
  assert.deepEqual(ids(listed), ["d-proj", "w-wa"]);
});

test("a filter with nothing matching lists no container at all", () => {
  const listed = api.listContainers({
    tree,
    scope: FIXED_NODES.root,
    needle: "",
    filterActive: true,
    filterAll: true,
    sessions: [],
  });
  assert.deepEqual(ids(listed), []);
});

test("a filter lists only containers that hold a match, not containers named like one", () => {
  const listed = api.listContainers({
    tree,
    scope: FIXED_NODES.root,
    needle: "",
    filterActive: true,
    filterAll: true,
    sessions: rows("wb"),
  });
  // Beta matches; its sibling folder 项目 holds nothing that did.
  assert.deepEqual(ids(listed), ["w-wb"]);
});

test("search widens to the whole tree and matches by name or path", () => {
  const byName = api.listContainers({
    tree,
    scope: FIXED_NODES.root,
    needle: "beta",
    filterActive: false,
    filterAll: true,
    sessions: [],
  });
  assert.deepEqual(ids(byName), ["w-wb"]);

  const byPath = api.listContainers({
    tree,
    scope: FIXED_NODES.root,
    needle: "c:\\alpha",
    filterActive: false,
    filterAll: true,
    sessions: [],
  });
  // wa is two levels down: a search that stopped at the root's children would
  // report "no results" for a workspace that is right there.
  assert.deepEqual(ids(byPath), ["w-wa"]);
});

test("with 会话名 out of range a folder answers by holding a hit, not by its name", () => {
  // 搜索范围 can leave 会话名 out (e.g. 仅搜会话内容). The name is then not a hit
  // even when the folder is called the word the user typed.
  const byNameOnly = api.listContainers({
    tree,
    scope: FIXED_NODES.root,
    needle: "beta",
    matchNames: false,
    filterActive: false,
    filterAll: true,
    sessions: [],
  });
  assert.deepEqual(ids(byNameOnly), []);

  // But the folders holding what the search did find have to stay: wa is two
  // levels down inside 项目, and a result view that loses its folder loses the
  // row's place in the library.
  const holding = api.listContainers({
    tree,
    scope: FIXED_NODES.root,
    needle: "beta",
    matchNames: false,
    filterActive: false,
    filterAll: true,
    sessions: rows("wa"),
  });
  assert.deepEqual(ids(holding), ["d-proj", "w-wa"]);
});

test("搜索位置=当前目录 keeps the folder list local too (m01916)", () => {
  // The whole-tree widening above is exactly what 当前目录 switches off: a search
  // that promises to stay here and then lists a folder from two levels down has
  // broken its promise. 范围=全部 is unaffected — it is the filter own switch.
  const local = (needle) =>
    api.listContainers({
      tree,
      scope: FIXED_NODES.root,
      needle,
      local: true,
      filterActive: false,
      filterAll: true,
      sessions: [],
    });
  assert.deepEqual(ids(local("beta")), ["w-wb"], "a root-level folder still answers");
  assert.deepEqual(ids(local("alpha")), [], "wa lives inside 项目, so it is not here");

  // …and with 会话名 out of range it falls back to holding a hit, still locally.
  const holding = api.listContainers({
    tree,
    scope: FIXED_NODES.root,
    needle: "beta",
    local: true,
    matchNames: false,
    filterActive: false,
    filterAll: true,
    sessions: rows("wa"),
  });
  assert.deepEqual(ids(holding), ["d-proj"], "项目 holds wa, so it stays; w-wb holds nothing");
});

test("the bin lists no container: there is nothing to navigate out of", () => {
  const listed = api.listContainers({
    tree,
    scope: FIXED_NODES.trash,
    needle: "",
    filterActive: false,
    filterAll: true,
    sessions: [],
  });
  assert.deepEqual(listed, []);
});
