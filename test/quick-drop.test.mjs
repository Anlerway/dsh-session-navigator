/**
 * A refused drop must say why.
 *
 * The strip and the rows used to answer a bad drag with nothing at all: 快速访问
 * returned 200 and quietly skipped what it could not hold, and a row that takes
 * no payload had no handlers, so the pointer got no grey-out and the status bar
 * got no sentence. These are the two predicates that fix that — the strip's own
 * projection rule and one reason per (row, drag) pair — checked against a tree
 * built by the real builder, so the client cannot drift from the host.
 *
 *   node --test test/quick-drop.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildAutoTree } from "../lib/domain/tree.js";
import { FIXED_NODES } from "../lib/constants.js";
import { loadClientBundle } from "./support/client-bundle.mjs";

const { test: client } = loadClientBundle({ expose: ["isBookmarkableNode", "dropRefusalFor", "dropEffectFor"] });
const { isBookmarkableNode, dropRefusalFor, dropEffectFor } = client;

// ── a tree with one of every shape a drop can meet ──────────────────────────
const registry = {
  workspaceIds: ["wa", "wb"],
  workspaces: new Map([
    ["wa", { id: "wa", title: "Alpha", path: "C:\\alpha" }],
    ["wb", { id: "wb", title: "Beta", path: "C:\\beta" }],
  ]),
};

const sessions = [
  { id: "s1", workspaceId: "wa", pinned: false, favorite: false, todo: false },
  { id: "s2", workspaceId: "wb", pinned: false, favorite: false, todo: false },
];

/**
 * 根目录 holds d-hold { w-wa { d-in } }, d-plain, w-wb and a shortcut row s-sc → w-wb.
 *
 * `d-in` sits inside a workspace, so no workspace may land in it (R1, asked
 * from the target side), while `d-plain` is outside every workspace and takes
 * one. Those two are the pair the reason has to tell apart.
 */
const tree = buildAutoTree({
  registry,
  sessions,
  userTree: {
    folders: {
      "d-hold": { id: "d-hold", name: "Hold", parent: FIXED_NODES.root, order: 0 },
      "d-plain": { id: "d-plain", name: "Plain", parent: FIXED_NODES.root, order: 1 },
      "d-in": { id: "d-in", name: "In", parent: "w-wa", order: 0 },
    },
    placement: { wa: "d-hold" },
    shortcuts: {
      "s-sc": { id: "s-sc", kind: "workspace", targetId: "wb", parent: FIXED_NODES.root, order: 2 },
    },
  },
});

const nodes = tree.nodes;
const children = tree.children;
const ctx = (sources) => ({ nodes, children, sources });

const reason = (targetId, kind, sources) => dropRefusalFor(targetId, kind, ctx(sources));
const isSentence = (value) => typeof value === "string" && value.trim().length > 0;

// ── the strip's projection rule ─────────────────────────────────────────────
test("only places are bookmarkable: user folders and workspaces", () => {
  assert.equal(isBookmarkableNode(nodes["d-plain"]), true, "user folder");
  assert.equal(isBookmarkableNode(nodes["w-wb"]), true, "workspace");
  for (const id of [FIXED_NODES.all, FIXED_NODES.trash, FIXED_NODES.ungrouped, "s-sc"]) {
    assert.ok(nodes[id], `fixture node ${id} exists`);
    assert.equal(isBookmarkableNode(nodes[id]), false, `${id} is not a place`);
  }
  assert.equal(isBookmarkableNode(undefined), false, "a payload the tree does not know");
});

// ── sessions land where the host accepts them ──────────────────────────────
test("a session may not go into a fixed view, and the view says so", () => {
  assert.ok(isSentence(reason(FIXED_NODES.all, "session")), "所有会话 refuses sessions");
  assert.ok(isSentence(reason(FIXED_NODES.trash, "session")), "回收站 refuses sessions");
  // A reference row is not a home either: it points at a place, it is not one.
  assert.ok(isSentence(reason("s-sc", "session")), "a shortcut row refuses a session too");
  assert.equal(reason(FIXED_NODES.ungrouped, "session"), null, "未分组 takes one");
  assert.equal(reason("w-wa", "session"), null, "a workspace takes one");
  assert.equal(reason("d-in", "session"), null, "a folder inside a workspace takes one");
  // A folder outside every workspace cannot *file* a session, but it can hold a
  // reference to one — the shortcut channel keeps the row a legal target.
  assert.equal(reason("d-plain", "session"), null, "a folder that only takes shortcuts");
  assert.equal(reason(FIXED_NODES.favorites, "session"), null, "收藏 takes a shortcut");
});

// ── folders go where the accepts table says ────────────────────────────────
test("a fixed view refuses a container with a reason that names the view", () => {
  const atTrash = reason(FIXED_NODES.trash, "node", ["d-plain"]);
  const atAll = reason(FIXED_NODES.all, "node", ["d-plain"]);
  assert.ok(isSentence(atTrash), "回收站 refuses a folder");
  assert.ok(isSentence(atAll), "所有会话 refuses a folder");
  assert.notEqual(atTrash, atAll, "the reason depends on the row, not on a generic string");
  // 收藏 / 待办 take a folder as a *reference*, so they are not dead ends — the
  // rail keeps a reference channel and a move channel apart.
  assert.equal(reason(FIXED_NODES.todos, "node", ["d-plain"]), null, "待办 takes a shortcut");
  assert.equal(reason(FIXED_NODES.favorites, "node", ["d-plain"]), null, "收藏 takes a shortcut");
});

test("a workspace may not land inside another workspace", () => {
  assert.ok(isSentence(reason("d-in", "node", ["w-wb"])), "a folder inside a workspace");
  assert.ok(isSentence(reason("w-wa", "node", ["w-wb"])), "the workspace itself");
  assert.equal(reason("d-plain", "node", ["w-wb"]), null, "a folder outside every workspace");
  // Siblings are fine: two workspaces in the same folder is a legal tree.
  assert.equal(reason("d-hold", "node", ["w-wb"]), null, "a folder holding one already");
});

test("a folder may not be dropped inside itself", () => {
  assert.ok(isSentence(reason("d-hold", "node", ["d-hold"])), "self");
  assert.ok(isSentence(reason("d-plain", "node", ["d-plain"])), "self, the other way");
});

test("a legal drop gets no excuse, and an unknown row gets no verdict", () => {
  assert.equal(reason(FIXED_NODES.root, "node", ["d-plain"]), null, "根目录 takes a folder");
  assert.equal(reason("d-nowhere", "node", ["d-plain"]), null, "a row that does not exist");
  assert.equal(reason(FIXED_NODES.trash, "node", []), null, "an empty drag has nothing to refuse");
});
// ── the effect a hover asks for ─────────────────────────────────────────────
// A source that offers only "move" cannot satisfy a "copy" request: the browser
// cancels the drop while still firing every dragover, so the band lit up and
// nothing was ever added. These are the values a real drag can advertise.
test("a copy request survives every source that allows a copy", () => {
  for (const allowed of ["", "all", "uninitialized", "copy", "copyLink", "copyMove"]) {
    assert.equal(dropEffectFor({ effectAllowed: allowed }, "copy"), "copy", allowed || "(empty)");
  }
});

test("a source that only allows a move is asked to move", () => {
  assert.equal(dropEffectFor({ effectAllowed: "move" }, "copy"), "move");
  assert.equal(dropEffectFor({ effectAllowed: "move" }, "move"), "move");
  assert.equal(dropEffectFor({ effectAllowed: "link" }, "move"), "move");
});

test("a drag with no dataTransfer still answers the preference", () => {
  assert.equal(dropEffectFor(undefined, "copy"), "copy");
  assert.equal(dropEffectFor({}, "move"), "move");
});
