/**
 * Tests for the sessions manifest.
 *
 *   node --test test/manifest.test.mjs
 *
 * The manifest exists to answer what the last process already worked out, so
 * every test here asks the same question in a different way: *did this start
 * open the file?* The strongest available answer is to make the stored answer
 * disagree with the file on disk — a header that claims another cwd, facts that
 * claim another title — and see which one the reader returns. Nothing else
 * distinguishes "reused" from "re-read and happened to agree".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { clearHeaderCache, scanHeaders } from "../src/sources/heads.js";
import { PROJCACHE_VERSION, clearProjcacheCache, projcacheDir, readProjcache } from "../src/sources/projcache.js";
import { readManifest, sameVersion, writeManifest } from "../src/sources/manifest.js";
import { createReader } from "../src/sources/reader.js";

/**
 * Write a session log whose first frame is a header line.
 *
 * @param {string} dshHome
 * @param {string} id
 * @param {{ cwd?: string }} [fields]
 */
async function writeSession(dshHome, id, fields = {}) {
  const dir = join(dshHome, "sessions", "proj", id);
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({
    type: "session",
    version: 4,
    id,
    createdAt: 1,
    cwd: fields.cwd ?? "/tmp/from-log",
  });
  const path = join(dir, "session.v4.jsonl.zstd");
  await writeFile(path, zstdCompressSync(Buffer.from(`${line}\n`, "utf8")));
  return path;
}

/** @param {string} path */
async function statOf(path) {
  return stat(path);
}

/**
 * Whether a path exists. The manifest tests ask "has anything been written
 * yet?", which a rejected stat answers without a flag.
 *
 * @param {string} path
 */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a stored version matches on size and mtime, and on ctime only when both sides have one", () => {
  const file = { size: 10, mtimeMs: 5 };
  assert.equal(sameVersion(file, { size: 10, mtimeMs: 5 }), true);
  assert.equal(sameVersion(file, { size: 11, mtimeMs: 5 }), false);
  assert.equal(sameVersion(file, { size: 10, mtimeMs: 6 }), false);
  // A projection cache entry carries no ctime, so a log-shaped comparison must
  // not invent one: the two readers share this function.
  assert.equal(sameVersion({ ...file, ctimeMs: 7 }, { size: 10, mtimeMs: 5 }), true);
  assert.equal(sameVersion({ ...file, ctimeMs: 7 }, { size: 10, mtimeMs: 5, ctimeMs: 8 }), false);
});

test("a stored header for an unchanged log is answered without opening it", async () => {
  const home = await mkdtemp(join(tmpdir(), "manifest-"));
  try {
    const logPath = await writeSession(home, "s-1", { cwd: "/tmp/from-log" });
    const info = await statOf(logPath);
    const known = new Map([
      [
        logPath,
        {
          size: info.size,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          // Disagrees with the log on purpose: if this comes back, the log was
          // not read.
          header: { id: "s-1", cwd: "/tmp/from-manifest", logPath, sizeBytes: info.size, mtimeMs: info.mtimeMs },
          turnStart: true,
        },
      ],
    ]);

    const scan = await scanHeaders(home, { known });
    assert.equal(scan.headers.get("s-1").cwd, "/tmp/from-manifest");
    assert.equal(scan.logs.size, 1);
    // The manifest is not allowed to hide a rewrite: without it the same scan
    // reports what the file actually says.
    clearHeaderCache();
    const fresh = await scanHeaders(home);
    assert.equal(fresh.headers.get("s-1").cwd, "/tmp/from-log");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a rewritten log misses the manifest and is decoded again", async () => {
  const home = await mkdtemp(join(tmpdir(), "manifest-"));
  try {
    const logPath = await writeSession(home, "s-1");
    const before = await statOf(logPath);
    const known = new Map([
      [
        logPath,
        {
          size: before.size,
          mtimeMs: before.mtimeMs,
          ctimeMs: before.ctimeMs,
          header: { id: "s-1", cwd: "/tmp/from-manifest", logPath },
        },
      ],
    ]);
    // The rewrite moves the file version, so the entry is a miss. The clock is
    // set by hand for the same reason test/heads.test.mjs does it: Windows can
    // report the same mtime and ctime for two writes in one tick.
    await writeSession(home, "s-1", { cwd: "/tmp/after-rewrite" });
    const moved = new Date(Date.now() + 2000);
    await utimes(logPath, moved, moved);
    clearHeaderCache();
    const scan = await scanHeaders(home, { known });
    assert.equal(scan.headers.get("s-1").cwd, "/tmp/after-rewrite");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a cache file answered by the manifest is not read", async () => {
  const home = await mkdtemp(join(tmpdir(), "manifest-"));
  try {
    const dir = projcacheDir(home);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "s-1.json");
    // Equal length, so a rewrite keeps the size half of the version key.
    await writeFile(filePath, '{"v":1}');
    const rewritten = '{"w":2}';
    await writeFile(filePath, rewritten);
    // Restore the mtime the entry will quote; ctime is not part of a cache key.
    await utimes(filePath, new Date(), new Date(Date.now() - 60_000));
    const info = await statOf(filePath);
    const known = new Map([
      [
        "s-1",
        {
          size: info.size,
          mtimeMs: info.mtimeMs,
          version: PROJCACHE_VERSION,
          facts: { title: "来自清单", turns: 3 },
        },
      ],
    ]);

    clearProjcacheCache();
    const read = await readProjcache(dir, { known });
    assert.equal(read.get("s-1").facts.title, "来自清单");
    // The record carries the version it was read against, so the caller can
    // hand a fresh mirror back without stat'ing again.
    assert.equal(read.get("s-1").size, info.size);
    assert.equal(read.get("s-1").mtimeMs, info.mtimeMs);

    clearProjcacheCache();
    const plain = await readProjcache(dir);
    assert.equal(plain.get("s-1"), undefined, "the file itself is not a valid record");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a dirtied mirror waits for the home to go quiet instead of writing at once", async () => {
  const home = await mkdtemp(join(tmpdir(), "manifest-"));
  const dataDir = await mkdtemp(join(tmpdir(), "manifest-data-"));
  try {
    const tmpDir = join(dataDir, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    const manifestPath = join(dataDir, "sessions-manifest.v1.json");
    await writeSession(home, "s-1");

    const reader = createReader({
      dshHome: () => home,
      manifestPath: () => manifestPath,
      manifestTmpDir: () => tmpDir,
      manifestQuietMs: 60_000,
      manifestMaxDelayMs: 600_000,
    });
    await reader.snapshot();
    assert.equal(await exists(manifestPath), false, "a scan is not a reason to touch the disk");

    // The in-memory mirror already answers; only the next start needs the file.
    assert.equal(await reader.flushManifest(), true);
    assert.equal(await exists(manifestPath), true);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a change that never meets quiet is written once the cap runs out", async () => {
  const home = await mkdtemp(join(tmpdir(), "manifest-"));
  const dataDir = await mkdtemp(join(tmpdir(), "manifest-data-"));
  try {
    const tmpDir = join(dataDir, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    const manifestPath = join(dataDir, "sessions-manifest.v1.json");
    await writeSession(home, "s-1");

    const reader = createReader({
      dshHome: () => home,
      manifestPath: () => manifestPath,
      manifestTmpDir: () => tmpDir,
      // A minute of quiet nobody will ever reach, over a 150 ms cap.
      manifestQuietMs: 60_000,
      manifestMaxDelayMs: 150,
    });
    await reader.snapshot();
    await delay(600);
    assert.equal(await exists(manifestPath), true, "the cap must write without anyone asking");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a new change restarts the quiet window", async () => {
  const home = await mkdtemp(join(tmpdir(), "manifest-"));
  const dataDir = await mkdtemp(join(tmpdir(), "manifest-data-"));
  try {
    const tmpDir = join(dataDir, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    const manifestPath = join(dataDir, "sessions-manifest.v1.json");
    await writeSession(home, "s-1");

    const reader = createReader({
      dshHome: () => home,
      manifestPath: () => manifestPath,
      manifestTmpDir: () => tmpDir,
      manifestQuietMs: 400,
      manifestMaxDelayMs: 60_000,
    });
    await reader.snapshot();
    await delay(280);
    // A second session lands before the first window closes. If the timer were
    // left alone it would fire 120 ms from now, mid-work.
    await writeSession(home, "s-2");
    await reader.snapshot({ refresh: true });
    await delay(300);
    assert.equal(await exists(manifestPath), false, "the first change must not drag the second one out");
    await delay(600);
    assert.equal(await exists(manifestPath), true, "the write lands once the new window closes");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a start writes what it learned, and the next start reads it instead of the log", async () => {
  const home = await mkdtemp(join(tmpdir(), "manifest-"));
  const dataDir = await mkdtemp(join(tmpdir(), "manifest-data-"));
  try {
    const tmpDir = join(dataDir, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    const manifestPath = join(dataDir, "sessions-manifest.v1.json");
    const logPath = await writeSession(home, "s-1");

    const first = createReader({ dshHome: () => home, manifestPath: () => manifestPath, manifestTmpDir: () => tmpDir });
    const snapshot = await first.snapshot();
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(await first.flushManifest(), true);

    const stored = await readManifest(manifestPath);
    assert.deepEqual([...stored.logs.keys()], [logPath]);
    assert.equal(stored.logs.get(logPath).header.id, "s-1");
    // The facts could not be read from a log the manifest had not seen yet, but
    // they were read once and stored for the next start.
    assert.equal(stored.logs.get(logPath).turnStart, false);

    // Edit the stored answer, then start again. A reader that re-opened the log
    // would return the log's cwd and quietly fail this.
    const payload = JSON.parse(await readFile(manifestPath, "utf8"));
    payload.logs[logPath].header.cwd = "/tmp/from-manifest";
    await writeFile(manifestPath, JSON.stringify(payload));
    clearHeaderCache();

    const second = createReader({ dshHome: () => home, manifestPath: () => manifestPath, manifestTmpDir: () => tmpDir });
    const again = await second.snapshot();
    assert.equal(again.sessions[0].cwd, "/tmp/from-manifest");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the mirror forgets a session the walk no longer finds", async () => {
  const home = await mkdtemp(join(tmpdir(), "manifest-"));
  const dataDir = await mkdtemp(join(tmpdir(), "manifest-data-"));
  try {
    const tmpDir = join(dataDir, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    const manifestPath = join(dataDir, "sessions-manifest.v1.json");
    await writeSession(home, "s-1");
    await writeSession(home, "s-2");

    const reader = createReader({ dshHome: () => home, manifestPath: () => manifestPath, manifestTmpDir: () => tmpDir });
    await reader.snapshot();
    await reader.flushManifest();
    assert.equal((await readManifest(manifestPath)).logs.size, 2);

    await rm(join(home, "sessions", "proj", "s-1"), { recursive: true, force: true });
    await reader.snapshot({ refresh: true });
    assert.equal(await reader.flushManifest(), true);
    const stored = await readManifest(manifestPath);
    assert.deepEqual(
      [...stored.logs.values()].map((entry) => entry.header.id),
      ["s-2"],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a damaged manifest is an empty one, never an error", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "manifest-data-"));
  try {
    const manifestPath = join(dataDir, "sessions-manifest.v1.json");
    const empty = await readManifest(manifestPath);
    assert.equal(empty.logs.size, 0);
    assert.equal(empty.facts.size, 0);

    await writeFile(manifestPath, "{ not json");
    assert.equal((await readManifest(manifestPath)).logs.size, 0);

    // Another schema version, and a payload with one broken entry among good
    // ones: the good entry survives, the broken one is a miss.
    await writeFile(manifestPath, JSON.stringify({ version: 99, logs: { "/x": { size: 1 } } }));
    assert.equal((await readManifest(manifestPath)).logs.size, 0);

    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        logs: {
          "/a": { size: 1, mtimeMs: 2, ctimeMs: 3, header: { id: "a" } },
          "/b": { size: 1, mtimeMs: "nope", ctimeMs: 3, header: { id: "b" } },
          "/c": { size: 1, mtimeMs: 2, ctimeMs: 3, header: { id: "" } },
        },
        facts: { s: { size: 1, mtimeMs: 2, version: PROJCACHE_VERSION, facts: {} }, t: { size: 1 } },
      }),
    );
    const mixed = await readManifest(manifestPath);
    assert.deepEqual([...mixed.logs.keys()], ["/a"]);
    assert.deepEqual([...mixed.facts.keys()], ["s"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a mirror written by another schema version is ignored, not migrated", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "manifest-data-"));
  try {
    const tmpDir = join(dataDir, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    const manifestPath = join(dataDir, "sessions-manifest.v1.json");
    await writeFile(manifestPath, JSON.stringify({ version: 2, logs: { "/a": { size: 1 } }, facts: {} }));
    const read = await readManifest(manifestPath);
    assert.equal(read.logs.size, 0);
    assert.equal(read.facts.size, 0);
    // ...and the next write replaces it in place instead of orphaning the name.
    await writeManifest(manifestPath, tmpDir, new Map([["/a", { size: 1, mtimeMs: 2, ctimeMs: 3, header: { id: "a" } }]]), new Map());
    assert.equal((await readManifest(manifestPath)).logs.size, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
