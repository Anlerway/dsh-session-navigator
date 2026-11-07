/**
 * Tests for the snapshot pipeline: what callers share and what they must not.
 *
 *   node --test test/reader.test.mjs
 *
 * Two properties are pinned here. The sidecar overlay is read on every call —
 * it can change without a reader epoch bump, because a document write is not a
 * session event, and a snapshot reused across calls would then answer with the
 * tree from before that write. And the tree is derived on first read: the
 * summary poll and the per-session lookups only want the session list, and the
 * tree is the expensive half of a large one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { createReader } from "../src/sources/reader.js";

/**
 * Write a session log whose first frame is a header.
 *
 * @param {string} dshHome
 * @param {string} id
 * @returns {Promise<string>} the log path
 */
async function writeSession(dshHome, id) {
  const dir = join(dshHome, "sessions", "proj", id);
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({ type: "session", version: 4, id, createdAt: 1, cwd: "/tmp/x" });
  const path = join(dir, "session.v4.jsonl.zstd");
  await writeFile(path, zstdCompressSync(Buffer.from(`${line}\n`, "utf8")));
  return path;
}

/**
 * @param {string} dshHome
 * @param {{ trashed: Set<string> }} state read at overlay time, so a test can
 *   change it between two snapshots
 */
function makeReader(dshHome, state) {
  return createReader({
    dshHome: () => dshHome,
    overlay: async () => ({
      userTree: null,
      trashedIds: state.trashed,
      annotations: {},
      listSettings: null,
    }),
  });
}

test("a snapshot reads the overlay as it is at call time", async () => {
  const home = await mkdtemp(join(tmpdir(), "reader-"));
  try {
    await writeSession(home, "s-1");
    const state = { trashed: new Set() };
    const reader = makeReader(home, state);

    const first = await reader.snapshot();
    assert.deepEqual(
      first.sessions.map((session) => session.id),
      ["s-1"],
    );

    // Trashing writes a document, not a session: no epoch bump and no header
    // change, so a snapshot cached across calls would still show the row.
    state.trashed = new Set(["s-1"]);
    const second = await reader.snapshot();
    assert.deepEqual(second.sessions, []);
    assert.deepEqual(
      second.trashed.map((session) => session.id),
      ["s-1"],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the tree is derived on first read, and derived once", async () => {
  const home = await mkdtemp(join(tmpdir(), "reader-"));
  try {
    await writeSession(home, "s-1");
    const reader = makeReader(home, { trashed: new Set() });
    const snapshot = await reader.snapshot();

    const tree = snapshot.tree;
    assert.equal(snapshot.tree, tree);
    assert.ok(JSON.stringify(tree).includes('"s-1"'));

    // Every route answers with JSON, so the getter has to survive encoding: the
    // payload carries the tree as a plain object.
    const encoded = JSON.parse(JSON.stringify(snapshot));
    assert.deepEqual(encoded.tree, tree);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
