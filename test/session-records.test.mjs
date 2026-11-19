/**
 * Tests for the records this plugin keeps *about* a session.
 *
 *   node --test test/session-records.test.mjs
 *
 * DSH owns the log; this plugin owns a few opinions about it — tags, a note, the
 * AI summary the user paid for, a virtual placement, a 快捷方式, the cached
 * transcript. Those records are invisible until they are wrong, which is exactly
 * why they need tests:
 *
 *   - 永久删除 must take them with the payload, in the same call;
 *   - 清理缓存 must collect the ones whose session no longer exists at all,
 *     which no other code path would ever revisit.
 *
 * The fake api is the same thin one the trash tests use: a home, a data
 * directory and a scripted reader, because everything interesting is on disk.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { forgetSessionRecords, recordCount, sweepOrphanSessionRecords } from "../src/host/session-records.js";
import { clearCaches } from "../src/host/maintenance.js";
import { purgeSessions, trashSessions } from "../src/host/trash.js";
import { ensureDataDir, dataPaths } from "../src/paths.js";
import { openDocuments } from "../src/store/documents.js";
import { createShortcut } from "../src/domain/shortcuts.js";
import { FIXED_NODES } from "../src/constants.js";

const LOG = "session.v4.jsonl.zstd";

/** A deterministic id source, so a test can name the row it is looking for. */
function idFactory(seed) {
  let n = 0;
  return () => `${seed}${++n}`;
}

/**
 * Write a session log with a real header frame and one event frame.
 *
 * @param {string} home
 * @param {string} project
 * @param {string} sessionId
 * @returns {Promise<string>} the session directory
 */
async function writeSession(home, project, sessionId) {
  const dir = join(home, "sessions", project, sessionId);
  await mkdir(dir, { recursive: true });
  const header = { type: "session", version: 4, id: sessionId, createdAt: 1_700_000_000_000, cwd: "C:\\work" };
  const events = [
    { seq: 0, type: "turn/start", time: 1, data: { turn: 1 } },
    { seq: 1, type: "turn/end", time: 2, data: { turn: 1 } },
  ];
  const headerFrame = zstdCompressSync(Buffer.from(JSON.stringify(header) + "\n"));
  const bodyFrame = zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n"));
  await writeFile(join(dir, LOG), Buffer.concat([headerFrame, bodyFrame]));
  return dir;
}

/**
 * A content index that only remembers which ids it holds.
 *
 * The real one is tested in content-index.test.mjs; here the question is whether
 * purge asks it to forget, and whether the flush follows.
 */
function fakeContent(ids = []) {
  /** @type {Set<string>} */
  const held = new Set(ids);
  return {
    held,
    flushed: 0,
    forget(list) {
      let dropped = 0;
      for (const id of list) if (held.delete(id)) dropped += 1;
      return dropped;
    },
    async flush() {
      this.flushed += 1;
      return { written: true, bytes: 0 };
    },
  };
}

/**
 * @param {{ home: string, dataDir: string, sessions?: any[], contentIds?: string[] }} input
 */
function fakeApi({ home, dataDir, sessions = [], contentIds = [] }) {
  ensureDataDir(dataDir);
  const paths = dataPaths(dataDir);
  return {
    dshHome: () => home,
    dataDir,
    paths,
    ctx: undefined,
    documents: openDocuments(paths),
    content: fakeContent(contentIds),
    invalidated: 0,
    reader: {
      async snapshot() {
        return { view: { sessions } };
      },
      invalidate() {
        this.invalidated += 1;
      },
    },
  };
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "se-records-"));
  return {
    root,
    home: join(root, "home"),
    dataDir: join(root, "data"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Put one of everything on the two ids, so a sweep has something to keep and
 * something to drop.
 *
 * @param {any} api
 */
async function seedRecords(api) {
  await api.documents.annotations.mutate((draft) => {
    draft.sessions.s1 = { tags: ["release"], note: "the one to keep", favorite: true, todo: false };
    draft.sessions.s2 = { tags: [], note: "a second session" };
    draft.sessions.s3 = { tags: ["gone"], note: "this session does not exist anywhere" };
  });
  await api.documents.summaries.mutate((draft) => {
    draft.sessions.s1 = { title: "first", description: "generated", tags: ["release"] };
    draft.sessions.s3 = { title: "orphan", description: "generated", tags: [] };
  });
  await api.documents.tree.mutate((draft) => {
    draft.sessionPlacement.s1 = { parent: FIXED_NODES.favorites };
    draft.sessionPlacement.s3 = { parent: FIXED_NODES.favorites };
    createShortcut(draft, { kind: "session", targetId: "s1", parent: FIXED_NODES.favorites }, idFactory("keep-"));
    createShortcut(draft, { kind: "session", targetId: "s3", parent: FIXED_NODES.todos }, idFactory("drop-"));
  });
}

test("永久删除 takes the plugin's records with the payload", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({ home: box.home, dataDir: box.dataDir, sessions: [{ id: "s1" }, { id: "s2" }], contentIds: ["s1", "s2"] });
    await writeSession(box.home, "proj", "s1");
    await writeSession(box.home, "proj", "s2");
    await seedRecords(api);
    await trashSessions(api, ["s1"]);

    const result = await purgeSessions(api, ["s1"]);
    assert.deepEqual(result.purged, ["s1"]);
    assert.deepEqual(
      result.records,
      { annotations: ["s1"], summaries: ["s1"], placements: ["s1"], shortcuts: ["s-keep-1"], content: 1 },
      "every record about s1 is reported, and only s1",
    );
    assert.equal(result.recordsError, "");

    const annotations = await api.documents.annotations.read();
    assert.deepEqual(Object.keys(annotations.sessions).sort(), ["s2", "s3"], "s2 keeps its note: it still exists");
    const summaries = await api.documents.summaries.read();
    assert.deepEqual(Object.keys(summaries.sessions), ["s3"]);
    const tree = await api.documents.tree.read();
    assert.deepEqual(Object.keys(tree.sessionPlacement), ["s3"]);
    assert.deepEqual(
      Object.values(tree.shortcuts ?? {}).map((entry) => entry.targetId),
      ["s3"],
      "the surviving reference still points at the session that is still there",
    );
    assert.equal(api.content.held.has("s1"), false, "the cached transcript is not left behind");
    assert.equal(api.content.flushed, 1, "the index is rewritten without asking");
  } finally {
    await box.cleanup();
  }
});

test("清理缓存 sweeps records whose session is gone, and keeps the bin's own", async () => {
  const box = await sandbox();
  try {
    // s1 is live, s2 sits in the bin, s3 exists nowhere. A trashed session is not
    // gone: its annotation is what makes the bin row readable, so it stays.
    const api = fakeApi({ home: box.home, dataDir: box.dataDir, sessions: [{ id: "s1" }] });
    await writeSession(box.home, "proj", "s1");
    await writeSession(box.home, "proj", "s2");
    await seedRecords(api);
    await trashSessions(api, ["s2"]);
    await api.documents.annotations.mutate((draft) => {
      draft.sessions.s2 = { tags: ["binned"], note: "still restorable" };
    });

    const result = await clearCaches(api);
    assert.deepEqual(result.orphans, { annotations: ["s3"], summaries: ["s3"], placements: ["s3"], shortcuts: ["s-drop-1"] });
    assert.ok(result.caches.includes("orphan-records"), "the panel has a name for what happened: " + result.caches.join(","));
    assert.ok(!result.skipped.includes("orphan-records"));

    const annotations = await api.documents.annotations.read();
    assert.deepEqual(Object.keys(annotations.sessions).sort(), ["s1", "s2"]);
    const tree = await api.documents.tree.read();
    assert.deepEqual(Object.keys(tree.sessionPlacement), ["s1"]);
    assert.deepEqual(Object.values(tree.shortcuts ?? {}).map((entry) => entry.targetId), ["s1"]);
  } finally {
    await box.cleanup();
  }
});

test("a sweep with nothing to drop writes nothing", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({ home: box.home, dataDir: box.dataDir, sessions: [{ id: "s1" }, { id: "s2" }] });
    await writeSession(box.home, "proj", "s1");
    await writeSession(box.home, "proj", "s2");
    await api.documents.annotations.mutate((draft) => {
      draft.sessions.s1 = { tags: ["a"], note: "" };
      draft.sessions.s2 = { tags: ["b"], note: "" };
    });
    const before = (await api.documents.annotations.read()).revision;

    const removed = await sweepOrphanSessionRecords(api, ["s1", "s2"]);
    assert.equal(recordCount(removed), 0);
    // Every write bumps a revision and wakes the client's watcher; a clean sweep
    // must be invisible.
    assert.equal((await api.documents.annotations.read()).revision, before);
  } finally {
    await box.cleanup();
  }
});

test("forgetting an id nobody stored is a no-op", async () => {
  const box = await sandbox();
  try {
    const api = fakeApi({ home: box.home, dataDir: box.dataDir, sessions: [] });
    const removed = await forgetSessionRecords(api, ["never-existed"]);
    assert.deepEqual(removed, { annotations: [], summaries: [], placements: [], shortcuts: [], content: 0 });
  } finally {
    await box.cleanup();
  }
});
