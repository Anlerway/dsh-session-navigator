/**
 * 新建会话 has to land in the workspace the reader is standing in.
 *
 * A folder never stores the workspace it sits in — the host derives it as
 * `homeWorkspaceId` — so the panel reading `node.workspaceId` got `undefined`
 * for every folder and handed `startSession(undefined)` to DSH, which then
 * picked the default workspace. The draft appeared in the default workspace
 * while the reader was looking at a folder two levels deep inside another one.
 *
 * Three id spaces arrive at this one function, so each gets a case here:
 * the panel's node ids, the window's native ids, and "nothing asked" (toolbar).
 *
 *   node --test test/new-session-workspace.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle } from "./support/client-bundle.mjs";

const { test: client } = loadClientBundle({ expose: ["workspaceForDraft", "canStartDraft", "draftFolderOf"] });
const { workspaceForDraft, canStartDraft, draftFolderOf } = client;

/**
 * 根目录 { 未分组, w-wa { d-in { d-deep } }, w-wb, d-out }
 *
 * `homeWorkspaceId` is what the host ships on every node; `workspaceId` is only
 * on a workspace node, because there it means "this node *is* that workspace".
 */
const tree = {
  nodes: {
    "f-root": { id: "f-root", kind: "root", parent: null, homeWorkspaceId: null },
    "f-ungrouped": { id: "f-ungrouped", kind: "ungrouped", parent: "f-root", homeWorkspaceId: null },
    "w-wa": { id: "w-wa", kind: "workspace", parent: "f-root", workspaceId: "wa", homeWorkspaceId: "wa" },
    "w-wb": { id: "w-wb", kind: "workspace", parent: "f-root", workspaceId: "wb", homeWorkspaceId: "wb" },
    "d-out": { id: "d-out", kind: "folder", parent: "f-root", homeWorkspaceId: null },
    "d-in": { id: "d-in", kind: "folder", parent: "w-wa", homeWorkspaceId: "wa" },
    "d-deep": { id: "d-deep", kind: "folder", parent: "d-in", homeWorkspaceId: "wa" },
  },
};

test("a folder inside a workspace answers with that workspace, at any depth", () => {
  assert.equal(workspaceForDraft("d-in", "f-root", tree), "wa");
  assert.equal(workspaceForDraft("d-deep", "f-root", tree), "wa");
});

test("the workspace row answers with itself", () => {
  assert.equal(workspaceForDraft("w-wa", "d-out", tree), "wa");
});

test("the row asked from wins over the folder that happened to be open", () => {
  // 在此新建会话 on d-in while the panel stands in workspace B: the draft belongs
  // to A, and navigate() has not landed yet when the menu item runs.
  assert.equal(workspaceForDraft("d-in", "w-wb", tree), "wa");
});

test("nothing asked (toolbar): where the reader is standing answers", () => {
  assert.equal(workspaceForDraft(undefined, "d-deep", tree), "wa");
  assert.equal(workspaceForDraft(null, "w-wb", tree), "wb");
  assert.equal(workspaceForDraft("", "d-in", tree), "wa");
});

test("a known node with no workspace answers null instead of the last folder", () => {
  // 根目录 and 未分组 are not places DSH can file a draft: answering with the
  // scope's workspace would put the row in a folder the reader did not ask for.
  // `null` is what now turns 新建会话 off there (see `canStartDraft`).
  assert.equal(workspaceForDraft("f-root", "d-deep", tree), null);
  assert.equal(workspaceForDraft("f-ungrouped", "d-in", tree), null);
  assert.equal(workspaceForDraft("d-out", "d-in", tree), null);
});

test("a native workspace id from the detached window resolves to itself", () => {
  // The window learned a bare uuid over the bridge; the page holds `w-<uuid>`.
  assert.equal(workspaceForDraft("wa", "d-deep", tree), "wa");
  assert.equal(workspaceForDraft("wb", "d-in", tree), "wb");
});

test("an id the tree cannot place falls back to the scope", () => {
  assert.equal(workspaceForDraft("d-deleted-a-moment-ago", "d-in", tree), "wa");
  assert.equal(workspaceForDraft("nope", "d-out", tree), null);
});

test("no tree at all answers null", () => {
  assert.equal(workspaceForDraft("wa", "d-in", null), null);
  assert.equal(workspaceForDraft(undefined, undefined, undefined), null);
});
test("新建会话 is offered only where DSH can file a draft", () => {
  // A workspace, or a folder inside one: `homeWorkspaceId` answers for both.
  assert.equal(canStartDraft("w-wa", tree), true);
  assert.equal(canStartDraft("d-in", tree), true);
  assert.equal(canStartDraft("d-deep", tree), true);
  // 根目录, 未分组 and a folder outside every workspace have no home workspace.
  assert.equal(canStartDraft("f-root", tree), false);
  assert.equal(canStartDraft("f-ungrouped", tree), false);
  assert.equal(canStartDraft("d-out", tree), false);
  assert.equal(canStartDraft("", tree), false);
  assert.equal(canStartDraft(undefined, tree), false);
  assert.equal(canStartDraft("d-in", null), false);
});

test("a draft asked from a folder in this workspace is filed into that folder", () => {
  assert.equal(draftFolderOf("d-in", "f-root", tree, "wa"), "d-in");
  assert.equal(draftFolderOf("d-deep", "w-wa", tree, "wa"), "d-deep");
  // The toolbar names no row: the folder the reader stands in answers.
  assert.equal(draftFolderOf(undefined, "d-deep", tree, "wa"), "d-deep");
});

test("a workspace row needs no extra filing: DSH puts the draft there anyway", () => {
  assert.equal(draftFolderOf("w-wa", "d-in", tree, "wa"), null);
  assert.equal(draftFolderOf("w-wb", "d-in", tree, "wb"), null);
});

test("the folder has to belong to the workspace the draft opens in", () => {
  // d-in sits in wa. A draft opened in wb cannot be filed there, and the host
  // would refuse the placement anyway.
  assert.equal(draftFolderOf("d-in", "f-root", tree, "wb"), null);
  assert.equal(draftFolderOf("d-in", "f-root", tree, null), null);
  // A folder outside every workspace has nothing to file into either.
  assert.equal(draftFolderOf("d-out", "f-root", tree, "wa"), null);
});

test("a fixed view never stands in for a folder", () => {
  assert.equal(draftFolderOf("f-ungrouped", "d-in", tree, "wa"), null);
  assert.equal(draftFolderOf("f-root", "f-ungrouped", tree, "wa"), null);
});

test("an id the tree cannot place falls back to the standing folder", () => {
  assert.equal(draftFolderOf("d-deleted-a-moment-ago", "d-in", tree, "wa"), "d-in");
  assert.equal(draftFolderOf("d-deleted-a-moment-ago", "f-root", tree, "wa"), null);
});
