/**
 * Tests for cross-workspace move / copy.
 *
 *   node --test test/move.test.mjs
 *
 * The interesting properties are filesystem and accounting properties:
 *
 *   - the artifact leaves the source project directory and lands in the target
 *     workspace's directory under DSH's own encoding;
 *   - its header cwd is rewritten, its events are byte-identical;
 *   - the registry accounting is swapped, and a failure during the swap puts
 *     both the bytes and the header index back.
 *
 * Path encoding is pinned against the directory names observed on a real DSH
 * home (see 交接文档.md §5.4), because getting it wrong writes a session to a
 * directory DSH will never look in.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import {
  encodeSegment,
  projectKey,
  readArtifact,
  inheritedCutOf,
  isContiguousLog,
} from "../src/sources/artifact.js";
import { moveSessions, reconcileMoves } from "../src/host/move.js";
import { recordMove, journalPath } from "../src/host/move-journal.js";
import { dataPaths } from "../src/paths.js";

const LOG = "session.v4.jsonl.zstd";

/**
 * Write a session log with a real header frame and one event frame.
 *
 * @param {string} home
 * @param {string} project
 * @param {string} sessionId
 * @param {{ cwd?: string, events?: object[], origin?: string, parentSession?: string, delegationDepth?: number }} [extra]
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
    ...(extra.origin ? { origin: extra.origin } : {}),
    ...(extra.parentSession ? { parentSession: extra.parentSession } : {}),
    ...(typeof extra.delegationDepth === "number" ? { delegationDepth: extra.delegationDepth } : {}),
  };
  const events = extra.events ?? [
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
 * A registry with the two methods the move path actually uses.
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
    // `attachSession` ends in this call (entity.ts:160-162), so a move that
    // bypasses the validation step still writes through the official path.
    async mutate(change) {
      const next = change(record);
      if (next !== record) Object.assign(record, next);
      return next;
    },
  }));
  return {
    entities,
    headers: new Map(),
    invalidSessionPaths: new Set(),
    missingSessionPaths: new Set(),
    host: {
      sessionPaths: new Map(),
      rememberSessionPath(id, path) { this.sessionPaths.set(id, path); },
    },
    failAttach: false,
    list: () => entities,
    async indexHeader(header) {
      this.headers.set(header.id, header);
    },
    async enqueueOperation(operation) {
      return operation();
    },
    find(id) {
      return entities.find((entity) => entity.id === id);
    },
  };
}

function fakeApi(home) {
  return {
    ctx: {
      get: (name) => (name === "workspaceRegistry" ? this.registry : undefined),
      sessions: { get: () => undefined },
    },
    dshHome: () => home,
    reader: { invalidated: 0, invalidate() { this.invalidated += 1; } },
  };
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "se-move-"));
  const home = join(root, "home");
  await mkdir(join(home, "sessions"), { recursive: true });
  return { root, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * An api whose ctx resolves a specific registry.
 *
 * @param {string} home
 * @param {any} registry
 */
function apiWith(home, registry) {
  return {
    ctx: { get: (name) => (name === "workspaceRegistry" ? registry : undefined) },
    dshHome: () => home,
    reader: { invalidated: 0, invalidate() { this.invalidated += 1; } },
  };
}

// ── path encoding ───────────────────────────────────────────────────────────

test("projectKey reproduces DSH's directory names", () => {
  assert.equal(projectKey("C:\\Users\\alice\\Desktop\\session-navigator"), "--C-Users-alice-Desktop-session-navigator--");
  assert.equal(projectKey("C:\\Users\\alice\\.dsh\\dsh_orb"), "--C-Users-alice-.dsh-dsh_orb--");
  // The observed escaped names: spaces become ~0020, parentheses ~0028/~0029.
  assert.equal(
    projectKey("C:\\Users\\alice\\Downloads\\新建文件夹 (2)"),
    "--C-Users-alice-Downloads-~65B0~5EFA~6587~4EF6~5939~0020~00282~0029--",
  );
  assert.equal(projectKey("C:\\Users\\alice\\Downloads\\新建文件夹"), "--C-Users-alice-Downloads-~65B0~5EFA~6587~4EF6~5939--");
});

test("encodeSegment escapes exactly what DSH escapes", () => {
  assert.equal(encodeSegment("session-c312bb10-0f03-4d1c-a6f3-140f7725d4ab"), "session-c312bb10-0f03-4d1c-a6f3-140f7725d4ab");
  assert.equal(encodeSegment("."), "~002E");
  assert.equal(encodeSegment(".."), "~002E~002E");
  assert.equal(encodeSegment("a~b"), "a~007Eb");
  assert.equal(encodeSegment("a:b"), "a~003Ab");
});

// ── artifact I/O ────────────────────────────────────────────────────────────

test("readArtifact decodes every frame and keeps event order", async () => {
  const box = await sandbox();
  try {
    const { log } = await writeSession(box.home, "proj", "s1");
    const artifact = await readArtifact(log);
    assert.equal(artifact.header.id, "s1");
    assert.equal(artifact.events.length, 2);
    assert.deepEqual(artifact.events.map((event) => event.seq), [0, 1]);
  } finally {
    await box.cleanup();
  }
});

test("a log whose tail is still being written exports everything before it", async () => {
  const box = await sandbox();
  try {
    const { log } = await writeSession(box.home, "proj", "s1");
    // A writer halfway through appending an event: the frame is torn, so the
    // file no longer ends with a complete line.
    const torn = zstdCompressSync(Buffer.from(JSON.stringify({ seq: 2, type: "turn/start" })));
    await appendFile(log, torn.subarray(0, 8));

    await assert.rejects(
      () => readArtifact(log),
      (error) => error.code === "session-corrupt",
      "a rewrite must still refuse to guess what the torn frame held",
    );
    const artifact = await readArtifact(log, { tolerateTail: true });
    assert.deepEqual(artifact.events.map((event) => event.seq), [0, 1], "the complete frames are all exported");
  } finally {
    await box.cleanup();
  }
});

test("an export drops the half-written JSON line instead of failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "se-artifact-"));
  try {
    const log = join(dir, "session.v4.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 4, id: "s1", cwd: "C:/work" }),
      JSON.stringify({ seq: 0, type: "turn/start" }),
      '{"seq":1,"type":"tur',
    ];
    await writeFile(log, lines.join("\n"));

    await assert.rejects(() => readArtifact(log), (error) => error.code === "session-corrupt");
    const artifact = await readArtifact(log, { tolerateTail: true });
    assert.deepEqual(artifact.events.map((event) => event.seq), [0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inheritedCutOf finds the final inherited marker", () => {  assert.equal(inheritedCutOf([{ seq: 0 }, { seq: 1, type: "session/end-seed", data: { inherited: true } }]), 2);
  assert.equal(inheritedCutOf([{ seq: 0 }, { seq: 1, type: "session/end-seed", data: {} }]), null);
  assert.equal(isContiguousLog([{ seq: 0 }, { seq: 1 }]), true);
  assert.equal(isContiguousLog([{ seq: 0 }, { seq: 2 }]), false);
});

// ── move ────────────────────────────────────────────────────────────────────

test("moving a session rewrites cwd and swaps the registry accounting", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-source", title: "source", path: "C:\\work\\source", sessionIds: ["s1"] },
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    const { dir, log } = await writeSession(box.home, "proj", "s1");

    const result = await moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } });
    assert.equal(result.results[0].moved, true);
    assert.deepEqual(result.results[0].fromWorkspaceIds, ["w-source"]);

    assert.equal(existsSync(dir), false, "the source directory must be gone");
    const movedLog = result.results[0].artifactTo;
    const moved = await readArtifact(movedLog);
    assert.equal(moved.header.cwd, targetPath);
    assert.equal(moved.header.id, "s1");
    assert.equal(moved.header.createdAt, 1_700_000_000_000, "header fields other than cwd are preserved");
    assert.equal(moved.events.length, 2, "the events survive the move");

    assert.deepEqual(registry.find("w-source").record.sessionIds, []);
    assert.deepEqual(registry.find("w-target").record.sessionIds, ["s1"]);
    assert.equal(registry.headers.get("s1").cwd, targetPath);
  } finally {
    await box.cleanup();
  }
});

test("a failed registry attach rolls both the bytes and the accounting back", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-source", title: "source", path: "C:\\work\\source", sessionIds: ["s1"] },
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const target = registry.find("w-target");
    target.attachSession = async () => {
      throw Object.assign(new Error("registry is read-only right now"), { code: "gateway/internal" });
    };
    const api = apiWith(box.home, registry);
    const { dir } = await writeSession(box.home, "proj", "s1");

    await assert.rejects(
      () => moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } }),
      /read-only/,
    );

    assert.equal(existsSync(join(dir, LOG)), true, "the artifact must be back where it started");
    const restored = await readArtifact(join(dir, LOG));
    assert.equal(restored.header.cwd, "C:\\work\\source", "the original header is restored");
    assert.equal(registry.headers.get("s1").cwd, "C:\\work\\source");
    assert.deepEqual(registry.find("w-source").record.sessionIds, ["s1"]);
  } finally {
    await box.cleanup();
  }
});

test("moving into the workspace that already owns the session is a no-op", async () => {
  const box = await sandbox();
  try {
    const registry = fakeRegistry([
      { id: "w-source", title: "source", path: "C:\\work\\source", sessionIds: ["s1"] },
    ]);
    const api = apiWith(box.home, registry);
    // The payload has to be where the registry says it is for the no-op to be a
    // no-op: a session the registry calls "home" while its log sits in another
    // project directory is exactly the state L5 refused to report as success.
    const project = projectKey("C:\\work\\source");
    const { dir } = await writeSession(box.home, project, "s1", { cwd: "C:\\work\\source" });

    const result = await moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-source" } });
    assert.equal(result.results[0].moved, false);
    assert.equal(existsSync(join(dir, LOG)), true);
  } finally {
    await box.cleanup();
  }
});

test("a session the registry calls home but the payload is not in is put where it belongs", async () => {
  const box = await sandbox();
  try {
    const workspacePath = join(box.root, "source");
    await mkdir(workspacePath, { recursive: true });
    const registry = fakeRegistry([{ id: "w-source", title: "source", path: workspacePath, sessionIds: ["s1"] }]);
    const api = apiWith(box.home, registry);
    const { dir } = await writeSession(box.home, "proj", "s1", { cwd: workspacePath });

    const result = await moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-source" } });
    assert.equal(result.results[0].moved, true);
    assert.equal(existsSync(join(dir, LOG)), false);
    assert.equal(existsSync(join(box.home, "sessions", projectKey(workspacePath), "s1", LOG)), true);
  } finally {
    await box.cleanup();
  }
});

test("a subagent moves on its own", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    // A delegation's log is a session directory like any other, so the row the
    // user picked is the row that moves. Its parent keeps pointing at the id,
    // which does not change.
    const { dir } = await writeSession(box.home, "proj", "s1", { origin: "subagent", delegationDepth: 1 });

    const result = await moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } });
    assert.equal(result.results[0].moved, true);
    assert.deepEqual(result.results[0].children, { moved: [], failed: [] });
    assert.equal(existsSync(join(dir, LOG)), false);
    assert.equal(existsSync(join(box.home, "sessions", projectKey(targetPath), "s1", LOG)), true);
  } finally {
    await box.cleanup();
  }
});

test("moving a parent takes its delegations along", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    const parent = await writeSession(box.home, "proj", "s1");
    const child = await writeSession(box.home, "proj", "s2", { origin: "subagent", parentSession: "s1", delegationDepth: 1 });
    const grandchild = await writeSession(box.home, "proj", "s3", { origin: "subagent", parentSession: "s2", delegationDepth: 2 });

    const result = await moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } });
    assert.equal(result.results[0].moved, true);
    assert.deepEqual(result.results[0].children, { moved: ["s2", "s3"], failed: [] });
    const targetProject = join(box.home, "sessions", projectKey(targetPath));
    for (const id of ["s1", "s2", "s3"]) {
      assert.equal(existsSync(join(targetProject, id, LOG)), true, `${id} followed the parent`);
    }
    assert.equal(existsSync(parent.dir), false);
    assert.equal(existsSync(child.dir), false, "the delegation does not stay behind in the old workspace");
    assert.equal(existsSync(grandchild.dir), false);
  } finally {
    await box.cleanup();
  }
});

test("a fork is not a delegation and does not follow anything", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    // A fork names a parent but declares no origin and depth 0: it is a copy the
    // user asked for, and moving the original must not drag it along.
    await writeSession(box.home, "proj", "s1");
    const fork = await writeSession(box.home, "proj", "s2", { parentSession: "s1" });

    const result = await moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } });
    assert.deepEqual(result.results[0].children, { moved: [], failed: [] });
    assert.equal(existsSync(join(fork.dir, LOG)), true);
  } finally {
    await box.cleanup();
  }
});

test("a generating session is refused instead of being moved under its writer", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    // Open *and* streaming: the agent holds a writer on the log.
    api.ctx.sessions = { get: (id) => (id === "s1" ? { id: "s1" } : undefined) };
    api.ctx.agents = { get: (id) => (id === "s1" ? { id: "s1", status: "running" } : undefined) };
    await writeSession(box.home, "proj", "s1");

    await assert.rejects(
      () => moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } }),
      (error) => error.code === "session-active",
      "a batch where nothing moved surfaces the failure instead of a 200 of refusals",
    );
  } finally {
    await box.cleanup();
  }
});

test("an open but idle session is flushed, closed and moved without being taken off screen", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    const calls = [];
    const row = { id: "s1", detach() { calls.push("detach"); } };
    // The persistence write handle the agent leaves behind. Closing it is what
    // makes the rename legal on Windows; a scope dispose also closes it, but at
    // the price of unloading the host's agent-creation scope.
    const handle = { id: "s1", access: "write", close() { calls.push("close-writer"); } };
    const services = {
      sessions: {
        get: (id) => (id === "s1" ? row : undefined),
        store: { get: (id) => (id === "s1" ? row : undefined) },
        async flush(session) { calls.push(`flush:${session?.id ?? "?"}`); },
      },
      agents: {
        get: (id) => (id === "s1" ? agent : undefined),
        store: { delete: (id) => calls.push(`agents.delete:${id}`) },
      },
      sessionPersistence: {
        tracker: { writers: new Map([["s1", handle]]), openHandles: new Set([handle]) },
        coordinator: { retirements: new Map(), states: new Map() },
      },
    };
    // An agent record that is open but not generating: no reason to refuse. The
    // move still has to *close* it — a live agent keeps the log writer open, and
    // Windows refuses the directory rename until that handle is gone.
    const agent = {
      id: "s1",
      status: "idle",
      cancel(cause) { calls.push(`cancel:${JSON.stringify(cause)}`); },
      whenIdle() { calls.push("whenIdle"); return Promise.resolve(); },
      // Never called: disposing the loop fiber unloads the Cordis scope the host
      // creates agents on, and the next "new session" then fails with
      // `cannot create effect on inactive context`.
      scope: { dispose() { calls.push("dispose"); } },
    };
    api.ctx.get = (name) => (name === "workspaceRegistry" ? registry : services[name]);
    const { dir } = await writeSession(box.home, "proj", "s1");

    const result = await moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } });
    assert.equal(result.results[0].moved, true, "an idle open session moves");
    assert.deepEqual(
      calls,
      ["flush:s1", "close-writer"],
      "flush, then close the writer: dropping the agent row would take the row off every client",
    );
    assert.equal(
      services.sessions.get("s1"),
      row,
      "the session the user has on screen is still the live row after the move",
    );
    assert.equal(
      calls.includes("dispose"),
      false,
      "the loop fiber is never disposed: that is what breaks the next createSession",
    );
    assert.equal(existsSync(join(dir, LOG)), false);
    assert.equal(existsSync(join(box.home, "sessions", projectKey(targetPath), "s1", LOG)), true);
  } finally {
    await box.cleanup();
  }
});

test("a session DSH still has open moves out of the cwd it was opened from", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    const sourcePath = join(box.root, "source-workspace");
    await mkdir(targetPath, { recursive: true });
    await mkdir(sourcePath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    // The registry asks the live session for its cwd before it asks its own
    // index (workspace/src/index.ts:892-897), and that header is deep-frozen
    // (core/session/src/index.ts:566-574) — a move cannot rewrite it. An attach
    // issued while the session is still open is therefore compared against the
    // workspace it was opened from: the `its cwd resolves to …` a user saw on a
    // session that had already been moved. The fix is not to close the session
    // (that drops the row from every client) but to teach the index the new
    // path and write the membership ledger through the entity when the attach
    // still refuses. This fixture keeps the row in `rows` to prove it.
    const rows = new Map();
    const services = {
      sessions: {
        get: (id) => rows.get(id),
        store: { get: (id) => rows.get(id) },
      },
    };
    rows.set("s1", {
      id: "s1",
      header: { id: "s1", cwd: sourcePath },
      detach() { rows.delete("s1"); },
    });
    const target = registry.find("w-target");
    const plainAttach = target.attachSession.bind(target);
    target.attachSession = async (sessionId) => {
      const open = services.sessions.get(sessionId);
      if (open && open.header.cwd !== target.path) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace 'w-target': its cwd resolves to '${open.header.cwd}'`,
        );
      }
      await plainAttach(sessionId);
    };
    const api = apiWith(box.home, registry);
    api.ctx.get = (name) => (name === "workspaceRegistry" ? registry : services[name]);
    const { dir } = await writeSession(box.home, "proj", "s1", { cwd: sourcePath });

    const result = await moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } });
    assert.equal(result.results[0].moved, true, JSON.stringify(result.results[0]));
    assert.equal(existsSync(dir), false, "the log left the source project directory");
    assert.deepEqual(registry.find("w-target").record.sessionIds, ["s1"]);
    const moved = await readArtifact(join(box.home, "sessions", projectKey(targetPath), "s1", LOG));
    assert.equal(moved.header.cwd, targetPath);
    assert.equal(
      registry.host.sessionPaths.get("s1"),
      targetPath,
      "the registry index is taught the new path, so the workspace keeps listing the session",
    );
    assert.notEqual(
      services.sessions.get("s1"),
      undefined,
      "the open session is left open: detaching it would drop the row from every client",
    );
  } finally {
    await box.cleanup();
  }
});

test("a log marked read-only is replaced instead of reported as EPERM", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    const { log } = await writeSession(box.home, "proj", "s1");
    // A read-only attribute survives a directory rename, and Windows refuses to
    // replace such a file — the byte-for-byte shape of the `io-error: EPERM` a
    // user hit on a log nobody was holding.
    await chmod(log, 0o444);

    const result = await moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } });
    assert.equal(result.results[0].moved, true, JSON.stringify(result.results[0]));
    const movedLog = result.results[0].artifactTo;
    assert.equal((await readArtifact(movedLog)).header.cwd, targetPath);
    // The retry must leave a log the host can still append to.
    await appendFile(movedLog, Buffer.alloc(0));
  } finally {
    await box.cleanup();
  }
});

test("one refused id does not cancel the ids that could move", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    api.ctx.sessions = { get: (id) => (id === "s1" ? { id: "s1" } : undefined) };
    api.ctx.agents = { get: (id) => (id === "s1" ? { id: "s1", status: "running" } : undefined) };
    const live = await writeSession(box.home, "proj", "s1");
    const idle = await writeSession(box.home, "proj", "s2");

    const result = await moveSessions(api, { ids: ["s1", "s2"], target: { workspaceId: "w-target" } });
    assert.equal(result.results.length, 2, "every id gets an entry, in the order it was asked for");
    assert.deepEqual(
      result.results.map((row) => [row.sessionId, row.ok, row.code]),
      [
        ["s1", false, "session-active"],
        ["s2", true, undefined],
      ],
      "the live session is reported, and the idle one still moves",
    );
    assert.equal(existsSync(join(live.dir, LOG)), true, "the refused session keeps its log where it was");
    assert.equal(existsSync(idle.dir), false);
  } finally {
    await box.cleanup();
  }
});

test("a workspace whose directory was deleted is re-created instead of refused", async () => {
  const box = await sandbox();
  try {
    // The registry row is the workspace; the folder named by its path is just
    // where the logs go, and the user is free to delete it from Explorer.
    const targetPath = join(box.root, "deleted-workspace");
    const registry = fakeRegistry([
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    const { dir } = await writeSession(box.home, "proj", "s1");
    assert.equal(existsSync(targetPath), false, "the folder really is gone");

    const result = await moveSessions(api, { ids: ["s1"], target: { workspaceId: "w-target" } });
    assert.equal(result.results[0].moved, true, "a missing folder is not a missing workspace");
    assert.equal(existsSync(targetPath), true, "the folder is re-created for the move");
    assert.equal(existsSync(join(box.home, "sessions", projectKey(targetPath), "s1", LOG)), true);
    assert.equal(existsSync(join(dir, LOG)), false);
  } finally {
    await box.cleanup();
  }
});

test("copying into a workspace whose directory was deleted re-creates it too", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "deleted-workspace");
    const registry = fakeRegistry([
      { id: "w-source", title: "source", path: "C:\\work\\source", sessionIds: ["s1"] },
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    await writeSession(box.home, "proj", "s1");

    const result = await moveSessions(api, { ids: ["s1"], copy: true, target: { workspaceId: "w-target" } });
    const copy = result.results[0];
    assert.equal(copy.copied, true);
    assert.equal(existsSync(targetPath), true);
    const duplicated = await readArtifact(copy.artifactTo);
    assert.equal(duplicated.header.cwd, targetPath, "the copy is filed under the re-created folder");
  } finally {
    await box.cleanup();
  }
});

test("an unknown target workspace is refused before anything moves", async () => {
  const box = await sandbox();
  try {
    const registry = fakeRegistry([
      { id: "w-source", title: "source", path: "C:\\work\\source", sessionIds: ["s1"] },
    ]);
    const api = apiWith(box.home, registry);
    const { dir } = await writeSession(box.home, "proj", "s1");

    await assert.rejects(
      () => moveSessions(api, { ids: ["s1"], target: { workspaceId: "nope" } }),
      (error) => error.code === "workspace-not-found",
    );
    assert.equal(existsSync(join(dir, LOG)), true);
  } finally {
    await box.cleanup();
  }
});

// ── copy ────────────────────────────────────────────────────────────────────

// ── intent journal ──────────────────────────────────────────────────────────

test("the paths a boot hands over carry the data directory the journal lives in", () => {
  // The journal is written beside the sidecars, so the paths object has to name
  // the directory: without this key every journal write is skipped and reconcile
  // becomes a no-op that reports nothing.
  const dir = join(tmpdir(), "se-paths-data");
  assert.equal(dataPaths(dir).dataDir, dir);
});

test("a move interrupted after the payload arrived is finished at the next start", async () => {
  const box = await sandbox();
  try {
    const workspacePath = join(box.root, "target");
    await mkdir(workspacePath, { recursive: true });
    const registry = fakeRegistry([{ id: "w-target", title: "target", path: workspacePath, sessionIds: [] }]);
    const api = apiWith(box.home, registry);
    api.paths = dataPaths(join(box.root, "data"));
    await mkdir(api.paths.dataDir, { recursive: true });

    // The state a crash leaves behind: the payload is at the destination, the
    // registry has not heard about it, and the journal still names the move.
    const project = projectKey(workspacePath);
    const { dir } = await writeSession(box.home, project, "s1", { cwd: workspacePath });
    await recordMove(api.paths, {
      sessionId: "s1",
      from: join(box.home, "sessions", "elsewhere"),
      to: dir,
      logName: LOG,
      workspaceId: "w-target",
      header: { id: "s1", cwd: workspacePath },
      startedAt: Date.now(),
    });

    const result = await reconcileMoves(api);
    assert.deepEqual(result.finished, ["s1"]);
    assert.deepEqual(result.dropped, []);
    assert.deepEqual(registry.entities[0].record.sessionIds, ["s1"]);
    assert.equal(registry.headers.get("s1").cwd, workspacePath);
    assert.equal(existsSync(journalPath(api.paths)), false);
  } finally {
    await box.cleanup();
  }
});

test("a journal entry whose payload never left is dropped, not repaired", async () => {
  const box = await sandbox();
  try {
    const registry = fakeRegistry([{ id: "w-target", title: "target", path: join(box.root, "t"), sessionIds: [] }]);
    const api = apiWith(box.home, registry);
    api.paths = dataPaths(join(box.root, "data"));
    await mkdir(api.paths.dataDir, { recursive: true });
    await recordMove(api.paths, {
      sessionId: "s1",
      from: join(box.home, "sessions", "proj", "s1"),
      to: join(box.home, "sessions", "other", "s1"),
      logName: LOG,
      workspaceId: "w-target",
      header: { id: "s1", cwd: "C:\\work\\source" },
      startedAt: Date.now(),
    });

    const result = await reconcileMoves(api);
    assert.deepEqual(result.finished, []);
    assert.deepEqual(result.dropped, ["s1"]);
    assert.deepEqual(registry.entities[0].record.sessionIds, []);
    assert.equal(existsSync(journalPath(api.paths)), false);
  } finally {
    await box.cleanup();
  }
});

test("copying writes a second session with a fresh id and the same events", async () => {
  const box = await sandbox();
  try {
    const targetPath = join(box.root, "target-workspace");
    await mkdir(targetPath, { recursive: true });
    const registry = fakeRegistry([
      { id: "w-source", title: "source", path: "C:\\work\\source", sessionIds: ["s1"] },
      { id: "w-target", title: "target", path: targetPath, sessionIds: [] },
    ]);
    const api = apiWith(box.home, registry);
    const { log } = await writeSession(box.home, "proj", "s1");

    const result = await moveSessions(api, { ids: ["s1"], copy: true, target: { workspaceId: "w-target" } });
    const copy = result.results[0];
    assert.equal(copy.copied, true);
    assert.notEqual(copy.sessionId, "s1");

    const original = await readArtifact(log);
    assert.equal(original.header.id, "s1", "the source session is untouched");
    assert.equal(original.header.cwd, "C:\\work\\source");

    const duplicated = await readArtifact(copy.artifactTo);
    assert.equal(duplicated.header.id, copy.sessionId);
    assert.equal(duplicated.header.cwd, targetPath);
    // The copy is named, so the two rows can be told apart in the list without
    // opening either: the source's history verbatim, then one session/title.
    assert.deepEqual(
      duplicated.events.slice(0, original.events.length),
      original.events,
      "the source's event stream is copied verbatim",
    );
    assert.equal(duplicated.events.length, original.events.length + 1, "plus a single title event");
    const titled = duplicated.events.at(-1);
    assert.equal(titled.type, "session/title");
    assert.equal(titled.seq, original.events.at(-1).seq + 1, "the title continues the sequence");
    // This stub has no snapshot, so there is no source title to build on and the
    // fallback name is used; with a real snapshot it becomes "<title>（副本）".
    assert.equal(titled.data.title, "副本", "the copy gets a name of its own");
    assert.deepEqual(registry.find("w-target").record.sessionIds, [copy.sessionId]);
    assert.deepEqual(registry.find("w-source").record.sessionIds, ["s1"]);
  } finally {
    await box.cleanup();
  }
});
