/**
 * Tests for POST /sessions/placement (a folder inside a workspace re-homes the
 * session for real when `move: true` is passed).
 *
 *   node --test test/placement-move.test.mjs
 *
 * The route has two jobs that must not blur: a drop on 未分组 or on a workspace
 * is still virtual (the payload stays where DSH put it), while a drop on a
 * folder that lives *inside* another workspace has to move the payload — the
 * workspace's own count and the row in the list must agree afterwards.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { projectKey, readArtifact } from "../src/sources/artifact.js";
import { ROUTES } from "../src/index.js";

const LOG = "session.v4.jsonl.zstd";
const placement = ROUTES["POST /sessions/placement"];

/**
 * Write a session log with a real header frame and one event frame.
 *
 * @param {string} home
 * @param {string} project
 * @param {string} sessionId
 * @param {{ cwd?: string }} [extra]
 * @returns {Promise<{ dir: string, log: string }>}
 */
async function writeSession(home, project, sessionId, extra = {}) {
  const dir = join(home, "sessions", project, sessionId);
  await mkdir(dir, { recursive: true });
  const header = {
    type: "session",
    version: 4,
    id: sessionId,
    createdAt: 1_700_000_000_000,
    cwd: extra.cwd ?? "C:\\work\\source",
  };
  const events = [
    { seq: 0, type: "turn/start", time: 1, data: { turn: 1 } },
    { seq: 1, type: "turn/end", time: 2, data: { turn: 1 } },
  ];
  const headerFrame = zstdCompressSync(Buffer.from(JSON.stringify(header) + "\n"));
  const bodyFrame = zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n"));
  const log = join(dir, LOG);
  await writeFile(log, Buffer.concat([headerFrame, bodyFrame]));
  return { dir, log };
}

/**
 * The two shapes the route asks the tree about: a folder inside a workspace,
 * and the fixed containers around it.
 *
 * @param {{ folderParent: string }} options
 */
function fixtureTree({ folderParent }) {
  return {
    nodes: {
      "f-root": { id: "f-root", kind: "root", fixed: true, parent: null, name: "根目录" },
      "f-ungrouped": { id: "f-ungrouped", kind: "ungrouped", fixed: true, parent: "f-root", name: "未分组" },
      "w-ws-source": { id: "w-ws-source", kind: "workspace", fixed: false, workspaceId: "ws-source", parent: "f-root", name: "source" },
      "w-ws-target": { id: "w-ws-target", kind: "workspace", fixed: false, workspaceId: "ws-target", parent: "f-root", name: "target" },
      "d-group": { id: "d-group", kind: "folder", fixed: false, parent: folderParent, name: "分组" },
    },
    sessionPlacement: {},
  };
}

/**
 * A registry with the methods the move path actually uses.
 *
 * @param {Array<{ id: string, title: string, path: string, sessionIds: string[] }>} workspaces
 */
function fakeRegistry(workspaces) {
  const entities = workspaces.map((record) => ({
    id: record.id,
    title: record.title,
    path: record.path,
    record,
    async attachSession(sessionId) {
      if (!record.sessionIds.includes(sessionId)) record.sessionIds.unshift(sessionId);
    },
    async detachSession(sessionId) {
      record.sessionIds = record.sessionIds.filter((id) => id !== sessionId);
    },
  }));
  return {
    entities,
    list: () => entities,
    async indexHeader() {},
    async enqueueOperation(operation) {
      return operation();
    },
    find(id) {
      return entities.find((entity) => entity.id === id);
    },
  };
}

/**
 * An api with exactly what the route touches: the snapshot it validates
 * against, the tree document it writes, and the registry the move needs.
 */
function fakeApi({ home, registry, tree, sessions, running = [] }) {
  const state = { revision: 7, sessionPlacement: { ...(tree.sessionPlacement ?? {}) } };
  const treeDocument = {
    async mutate(fn, revision) {
      if (typeof revision === "number" && revision !== state.revision) {
        const error = new Error("the document changed while you were editing it");
        error.code = "revision-conflict";
        throw error;
      }
      const draft = { sessionPlacement: { ...state.sessionPlacement } };
      fn(draft);
      state.sessionPlacement = draft.sessionPlacement;
      state.revision += 1;
      return { revision: state.revision, sessionPlacement: state.sessionPlacement };
    },
  };
  return {
    state,
    ctx: {
      get: (name) => (name === "workspaceRegistry" ? registry : undefined),
      sessions: { get: (id) => (running.includes(id) ? { id } : undefined) },
    },
    dshHome: () => home,
    documents: { tree: treeDocument },
    reader: { async snapshot() { return { sessions, tree }; }, invalidate() {} },
  };
}

/**
 * Two workspaces on disk, one or two logs in the source one.
 *
 * @param {{ folderParent?: string, ids?: string[], running?: string[] }} [options]
 */
async function scene(options = {}) {
  const ids = options.ids ?? ["s1"];
  const running = options.running ?? [];
  const folderParent = options.folderParent ?? "w-ws-target";
  const root = await mkdtemp(join(tmpdir(), "se-placement-"));
  const home = join(root, "home");
  await mkdir(join(home, "sessions"), { recursive: true });
  const sourcePath = join(root, "source");
  const targetPath = join(root, "target");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(targetPath, { recursive: true });
  const registry = fakeRegistry([
    { id: "ws-source", title: "source", path: sourcePath, sessionIds: [...ids] },
    { id: "ws-target", title: "target", path: targetPath, sessionIds: [] },
  ]);
  /** @type {Record<string, string>} */
  const logs = {};
  for (const id of ids) {
    logs[id] = (await writeSession(home, projectKey(sourcePath), id, { cwd: sourcePath })).log;
  }
  const sessions = ids.map((id) => ({ id, workspaceId: "ws-source", title: id }));
  const tree = fixtureTree({ folderParent });
  const api = fakeApi({ home, registry, tree, sessions, running });
  return {
    root,
    home,
    sourcePath,
    targetPath,
    registry,
    logs,
    api,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** @param {string} home @param {string} workspacePath @param {string} sessionId */
function logIn(home, workspacePath, sessionId) {
  return join(home, "sessions", projectKey(workspacePath), sessionId, LOG);
}

test("a drop on a folder in another workspace is still refused without `move`", async () => {
  const { api, logs, cleanup, home, targetPath } = await scene();
  try {
    await assert.rejects(
      () => placement(api, { body: { ids: ["s1"], parent: "d-group" }, headers: {} }),
      (error) => error.code === "bad-request" && error.message === "这个文件夹只接受它所在工作区里的会话",
    );
    assert.ok(existsSync(logs.s1), "the payload stays where DSH put it");
    assert.ok(!existsSync(logIn(home, targetPath, "s1")), "nothing was copied into the other workspace");
    assert.equal(api.state.sessionPlacement.s1, undefined, "no placement is written for a refused drop");
    assert.equal(api.state.revision, 7, "a refused drop does not touch the tree document");
  } finally {
    await cleanup();
  }
});

test("`move: true` re-homes the payload and then files it inside the folder", async () => {
  const { api, logs, cleanup, home, targetPath } = await scene();
  try {
    const result = await placement(api, { body: { ids: ["s1"], parent: "d-group", move: true }, headers: {} });
    assert.deepEqual(result.moved, ["s1"]);
    assert.deepEqual(result.failed, []);
    assert.equal(result.parent, "d-group");
    assert.equal(result.sessionPlacement.s1, "d-group");
    const movedLog = logIn(home, targetPath, "s1");
    assert.ok(existsSync(movedLog), "the log now sits under the target workspace's project key");
    assert.ok(!existsSync(logs.s1), "and it is gone from the source workspace");
    const artifact = await readArtifact(movedLog);
    assert.equal(artifact.header.cwd, targetPath, "the header cwd follows the payload");
    assert.deepEqual(artifact.events.map((event) => event.seq), [0, 1], "the events are carried over unchanged");
  } finally {
    await cleanup();
  }
});

test("a folder in the session's own workspace stays a virtual placement", async () => {
  const { api, logs, cleanup, home, targetPath } = await scene({ folderParent: "w-ws-source" });
  try {
    const result = await placement(api, { body: { ids: ["s1"], parent: "d-group", move: true }, headers: {} });
    assert.deepEqual(result.moved, [], "no move is needed when the workspace already matches");
    assert.deepEqual(result.failed, []);
    assert.equal(result.sessionPlacement.s1, "d-group");
    assert.ok(existsSync(logs.s1), "the payload is untouched");
    assert.ok(!existsSync(logIn(home, targetPath, "s1")));
    assert.equal(api.state.revision, 8, "the placement itself is a tree write");
  } finally {
    await cleanup();
  }
});

test("a session that cannot be re-homed is reported and left unfiled", async () => {
  const { api, logs, cleanup, home, targetPath } = await scene({ ids: ["s1", "s2"], running: ["s1"] });
  try {
    const result = await placement(api, { body: { ids: ["s1", "s2"], parent: "d-group", move: true }, headers: {} });
    assert.deepEqual(result.moved, ["s2"]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].sessionId, "s1");
    assert.equal(result.failed[0].code, "session-active");
    assert.equal(result.sessionPlacement.s2, "d-group", "the one that moved is filed");
    assert.equal(result.sessionPlacement.s1, undefined, "the one that did not move keeps its old home");
    assert.ok(existsSync(logs.s1));
    assert.ok(existsSync(logIn(home, targetPath, "s2")));
  } finally {
    await cleanup();
  }
});

test("a batch where nothing can move throws instead of returning empty rows", async () => {
  const { api, logs, cleanup } = await scene({ running: ["s1"] });
  try {
    await assert.rejects(
      () => placement(api, { body: { ids: ["s1"], parent: "d-group", move: true }, headers: {} }),
      (error) => error.code === "session-active",
    );
    assert.equal(api.state.revision, 7);
    assert.equal(api.state.sessionPlacement.s1, undefined);
    assert.ok(existsSync(logs.s1));
  } finally {
    await cleanup();
  }
});
