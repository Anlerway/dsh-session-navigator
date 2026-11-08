/**
 * Tests for POST /trash on subagents (a child may be binned on its own).
 *
 *   node --test test/trash-subagent.test.mjs
 *
 * A subagent is a delegation inside its parent's run, so the store-writing
 * operations refuse it. Deleting is the exception: the bin only moves the
 * child's own payload and restore puts it back, which leaves the parent's
 * transcript pointing at a directory that still exists. The cascade in the
 * other direction is unchanged — binning a parent takes the whole chain.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { projectKey } from "../src/sources/artifact.js";
import { ROUTES } from "../src/index.js";

const LOG = "session.v4.jsonl.zstd";
const trash = ROUTES["POST /trash"];

/**
 * Write a session log with a real header frame and one event frame.
 *
 * @param {string} home
 * @param {string} project
 * @param {string} sessionId
 * @param {{ cwd?: string, origin?: string }} [extra]
 * @returns {Promise<string>} the log path
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
  };
  const events = [{ seq: 0, type: "turn/start", time: 1, data: { turn: 1 } }];
  const log = join(dir, LOG);
  await writeFile(
    log,
    Buffer.concat([
      zstdCompressSync(Buffer.from(JSON.stringify(header) + "\n")),
      zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n")),
    ]),
  );
  return log;
}

/**
 * An api with the three things trashSessions reads: the merged session view,
 * the bin index document, and the payload directory.
 *
 * @param {{ home: string, trashDir: string, sessions: object[] }} options
 */
function fakeApi({ home, trashDir, sessions }) {
  const index = { entries: /** @type {Record<string, any>} */ ({}) };
  return {
    index,
    ctx: { get: () => undefined },
    dshHome: () => home,
    paths: { trashDir },
    documents: {
      trash: {
        async read() {
          return JSON.parse(JSON.stringify(index));
        },
        async mutate(fn) {
          const draft = JSON.parse(JSON.stringify(index));
          draft.entries ??= {};
          fn(draft);
          index.entries = draft.entries;
        },
      },
    },
    reader: {
      invalidated: 0,
      async snapshot() {
        return { sessions, view: { sessions } };
      },
      invalidate() {
        this.invalidated += 1;
      },
    },
  };
}

/**
 * One parent with a child, and a grandchild under the child.
 *
 * @param {{ running?: string[] }} [options]
 */
async function scene(options = {}) {
  const running = options.running ?? [];
  const root = await mkdtemp(join(tmpdir(), "se-trash-"));
  const home = join(root, "home");
  await mkdir(join(home, "sessions"), { recursive: true });
  const project = projectKey(join(root, "source"));
  const logs = {
    p: await writeSession(home, project, "p"),
    c: await writeSession(home, project, "c", { origin: "subagent" }),
    g: await writeSession(home, project, "g", { origin: "subagent" }),
  };
  const base = (id, extra) => ({
    id,
    title: id,
    displayTitle: id,
    workspaceId: "ws-1",
    running: running.includes(id),
    ...extra,
  });
  const sessions = [
    base("p", { isSubagent: false, parentSession: null }),
    base("c", { isSubagent: true, parentSession: "p" }),
    base("g", { isSubagent: true, parentSession: "c" }),
  ];
  const trashDir = join(root, "data", "trash");
  const api = fakeApi({ home, trashDir, sessions });
  return { root, home, logs, trashDir, api, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("a subagent can be binned on its own", async () => {
  const { api, logs, trashDir, cleanup } = await scene();
  try {
    const result = await trash(api, { body: { ids: ["c"] }, headers: {} });
    assert.deepEqual(result.trashed, ["c", "g"], "the child's own subagents come with it");
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.errors, []);
    const entry = api.index.entries.c;
    assert.ok(entry, "the bin index keeps the entry");
    assert.equal(entry.parentSession, "p", "the delegation chain is recorded for restore");
    assert.ok(!existsSync(logs.c), "the child's payload left DSH's sessions tree");
    assert.ok(existsSync(join(trashDir, entry.trashId, LOG)), "and arrived in the bin");
    assert.ok(existsSync(logs.p), "the parent is untouched");
    assert.equal(api.reader.invalidated, 1, "the listing is invalidated once");
  } finally {
    await cleanup();
  }
});

test("binning a parent still takes every subagent below it", async () => {
  const { api, logs, trashDir, cleanup } = await scene();
  try {
    const result = await trash(api, { body: { ids: ["p"] }, headers: {} });
    assert.deepEqual(result.trashed, ["p", "c", "g"], "parents before children, whole chain");
    for (const id of ["p", "c", "g"]) {
      const entry = api.index.entries[id];
      assert.ok(entry, `${id} has an entry`);
      assert.ok(existsSync(join(trashDir, entry.trashId, LOG)), `${id} sits in the bin`);
      assert.ok(!existsSync(logs[id]), `${id} left the sessions tree`);
    }
    assert.equal(api.index.entries.c.parentSession, "p");
    assert.equal(api.index.entries.g.parentSession, "c");
  } finally {
    await cleanup();
  }
});

test("a running subagent is reported instead of moved", async () => {
  const { api, logs, cleanup } = await scene({ running: ["c"] });
  try {
    // The reader's frame says "running"; the host also holds the agent, and this
    // one will not stop. A session that cannot be stopped is refused — the
    // delete may stop a live session, but it does not move one out from under
    // an agent that keeps writing.
    api.ctx = {
      get: (name) => (name === "agents"
        ? { get: (id) => (id === "c" ? { id, status: "running", cancel() {} } : null) }
        : undefined),
    };
    const result = await trash(api, { body: { ids: ["c"] }, headers: {} });
    assert.deepEqual(result.trashed, ["g"], "the idle grandchild still goes");
    assert.deepEqual(result.skipped, ["c"]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].sessionId, "c");
    assert.equal(result.errors[0].code, "session-active");
    assert.equal(api.index.entries.c, undefined, "nothing is written for a refusal");
    assert.ok(existsSync(logs.c));
  } finally {
    await cleanup();
  }
});
