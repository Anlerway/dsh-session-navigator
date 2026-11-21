/**
 * Tests for the 默认工作区 label after the first-use Workspace is deleted.
 *
 *   node --test test/default-workspace.test.mjs
 *
 * DSH keeps `defaultWorkspaceId` in its private domain state and never clears it:
 * deleting the Workspace it names leaves a dangling id behind, and
 * `initializeDefault` then returns early forever, so the profile has no default
 * Workspace and will not create another one. The plugin used to answer
 * "whichever Workspace sorts first is the default", which painted a user's own
 * Workspace as 默认工作区 — a label that promises it will be re-created at the next
 * first-use. These tests pin the honest answer: no default, and no label.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReader } from "../src/sources/reader.js";
import { readWorkspaceService } from "../src/sources/workspaces.js";

/**
 * @param {string} dshHome
 * @param {any} service live `ctx.workspaceRegistry` stand-in, or null
 */
function makeReader(dshHome, service) {
  return createReader({
    dshHome: () => dshHome,
    workspaceService: () => service,
    overlay: async () => ({
      userTree: null,
      trashedIds: new Set(),
      annotations: {},
      listSettings: null,
    }),
  });
}

/**
 * Every workspace node in a built tree.
 *
 * @param {any} tree
 * @returns {any[]}
 */
function workspaceNodes(tree) {
  return Object.values(tree?.nodes ?? {}).filter((node) => /** @type {any} */ (node)?.type === "workspace");
}

test("the live service never promotes the first Workspace to default", () => {
  const registry = readWorkspaceService({
    list: () => [
      { id: "w1", path: "/tmp/one", title: "one", sessionIds: [] },
      { id: "w2", path: "/tmp/two", title: "two", sessionIds: [] },
    ],
    archivedSessionIds: [],
    pinnedSessionIds: [],
  });
  assert.equal(registry.defaultWorkspaceId, null, "position in the list is not evidence of a default");
});

test("a dangling default id is reported as no default, not as the first Workspace", async () => {
  const home = await mkdtemp(join(tmpdir(), "default-ws-"));
  try {
    // What DSH leaves behind after the first-use Workspace is deleted: the id is
    // still in `global`, and only the user's own Workspace is registered.
    await mkdir(join(home, "storages"), { recursive: true });
    await writeFile(
      join(home, "storages", "workspace.json"),
      JSON.stringify({
        unit: { name: "workspace", version: 2 },
        global: {
          initialized: true,
          workspaceIds: ["w-mine"],
          defaultWorkspaceId: "w-default-workspace",
        },
        tables: {
          workspaces: {
            "w-mine": { path: "/tmp/mine", title: "mine", sessionIds: [], createdAt: "1", updatedAt: "1" },
          },
        },
      }),
    );
    const service = {
      list: () => [{ id: "w-mine", path: "/tmp/mine", title: "mine", sessionIds: [] }],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    };

    const snapshot = await makeReader(home, service).snapshot({ refresh: true });
    assert.equal(snapshot.registry.defaultWorkspaceId, null, "a dangling id names nothing");
    const nodes = workspaceNodes(snapshot.tree);
    assert.equal(nodes.length, 1, "the surviving Workspace still shows");
    assert.notEqual(nodes[0].default, true, "no Workspace is labelled 默认工作区");
    assert.notEqual(nodes[0].name, "默认工作区");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a default that is still registered keeps its label", async () => {
  const home = await mkdtemp(join(tmpdir(), "default-ws-"));
  try {
    await mkdir(join(home, "storages"), { recursive: true });
    await writeFile(
      join(home, "storages", "workspace.json"),
      JSON.stringify({
        unit: { name: "workspace", version: 2 },
        global: { initialized: true, workspaceIds: ["w-a", "w-b"], defaultWorkspaceId: "w-b" },
        tables: {
          workspaces: {
            "w-a": { path: "/tmp/a", title: "a", sessionIds: [] },
            "w-b": { path: "/tmp/b", title: "b", sessionIds: [] },
          },
        },
      }),
    );
    const service = {
      list: () => [
        { id: "w-a", path: "/tmp/a", title: "a", sessionIds: [] },
        { id: "w-b", path: "/tmp/b", title: "b", sessionIds: [] },
      ],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    };

    const snapshot = await makeReader(home, service).snapshot({ refresh: true });
    assert.equal(snapshot.registry.defaultWorkspaceId, "w-b", "the file's live id is the truth");
    const nodes = workspaceNodes(snapshot.tree);
    assert.equal(nodes.filter((node) => node.default === true).length, 1, "exactly one default");
    const marked = nodes.filter((node) => node.default === true);
    assert.equal(marked[0]?.name, "b", "the file's id decides which Workspace is the default");
    assert.equal(nodes.find((node) => node.name === "a")?.default, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
