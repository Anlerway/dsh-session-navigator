/**
 * Tests for the projection-cache read, including the reuse key.
 *
 *   node --test test/projcache.test.mjs
 *
 * The listing reads one small JSON file per session on every request, and on a
 * large home that was measured at 140ms — nearly all of it re-reading and
 * re-projecting bytes that had not changed. The reuse is keyed on size + mtime,
 * so what has to be pinned here is exactly that: an untouched file is not read
 * again, and *any* change to it is noticed. "Noticed" is tested the hard way, by
 * making the second write the same length and putting the old mtime back: only a
 * reader that trusts the key would still answer with the first title.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROJCACHE_VERSION,
  clearProjcacheCache,
  readProjcache,
  readProjcacheFile,
} from "../lib/sources/projcache.js";

/** @returns {Promise<string>} */
async function tempDir() {
  return await mkdtemp(join(tmpdir(), "se-projcache-"));
}

/** A fixed stamp, so a restored mtime is byte-identical rather than "close". */
const STAMP = new Date(1_700_000_000_000);

/**
 * Write one cache file whose projected title is `title`.
 *
 * @param {string} path
 * @param {string} title
 * @param {Date} [stamp] mtime to put on the file, `STAMP` unless a test is
 *   pretending time has passed
 * @returns {Promise<number>} bytes written
 */
async function writeRecord(path, title, stamp = STAMP) {
  const text = JSON.stringify({
    version: PROJCACHE_VERSION,
    record: {
      identity: { createdAt: 1_000, cwd: "/work" },
      rows: { title: { seq: 1, val: title } },
    },
  });
  await writeFile(path, text);
  await utimes(path, stamp, stamp);
  return Buffer.byteLength(text);
}

/** The facts a plain read of one file would produce, used as the oracle. */
async function oracleFacts(path) {
  const entry = await readProjcacheFile(path);
  return entry?.facts ?? null;
}

test("reads every record in a directory, keyed by session id", async () => {
  const dir = await tempDir();
  try {
    clearProjcacheCache();
    await writeRecord(join(dir, "s-1.json"), "first");
    await writeRecord(join(dir, "s-2.json"), "second");
    // Not a cache record: a stray file must be skipped, not thrown over.
    await writeFile(join(dir, "notes.txt"), "ignore me");
    const listing = await readProjcache(dir);
    assert.deepEqual([...listing.keys()].sort(), ["s-1", "s-2"]);
    assert.equal(listing.get("s-1").version, PROJCACHE_VERSION);
    assert.equal(listing.get("s-1").facts.title, "first");
    assert.deepEqual(listing.get("s-2").facts, await oracleFacts(join(dir, "s-2.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a directory that does not exist is an empty listing", async () => {
  clearProjcacheCache();
  const listing = await readProjcache(join(tmpdir(), "se-projcache-absent", "nothing-here"));
  assert.equal(listing.size, 0);
});

test("a rewritten file is read again", async () => {
  const dir = await tempDir();
  try {
    clearProjcacheCache();
    const file = join(dir, "s-1.json");
    await writeRecord(file, "first");
    assert.equal((await readProjcache(dir)).get("s-1").facts.title, "first");
    // "first" and "other" are the same length: only the mtime can betray the
    // rewrite, and DSH bumps it on every write.
    const size = await writeRecord(file, "other", new Date(1_700_000_100_000));
    const info = await stat(file);
    assert.equal(info.size, size);
    assert.equal((await readProjcache(dir)).get("s-1").facts.title, "other");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unchanged file is served from memory, not read again", async () => {
  const dir = await tempDir();
  try {
    clearProjcacheCache();
    const file = join(dir, "s-1.json");
    const size = await writeRecord(file, "first");
    assert.equal((await readProjcache(dir)).get("s-1").facts.title, "first");
    await writeRecord(file, "other");
    // Same length and same mtime as the version already in memory: a reader that
    // stats first sees nothing to do, which is the whole point of the cache.
    assert.equal((await stat(file)).size, size);
    assert.equal((await readProjcache(dir)).get("s-1").facts.title, "first");
    // …while the file itself really did change, so the next process (or the next
    // clear) reads "other".
    assert.equal((await oracleFacts(file)).title, "other");
    clearProjcacheCache();
    assert.equal((await readProjcache(dir)).get("s-1").facts.title, "other");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a deleted record leaves the listing and the memory", async () => {
  const dir = await tempDir();
  try {
    clearProjcacheCache();
    const file = join(dir, "s-1.json");
    await writeRecord(file, "first");
    assert.equal((await readProjcache(dir)).size, 1);
    await unlink(file);
    assert.equal((await readProjcache(dir)).size, 0);
    // Recreated after being deleted: the entry has to come back, not stay pruned.
    await writeRecord(file, "again");
    assert.equal((await readProjcache(dir)).get("s-1").facts.title, "again");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a future-schema or broken file degrades to no facts", async () => {
  const dir = await tempDir();
  try {
    clearProjcacheCache();
    await writeFile(join(dir, "s-broken.json"), "{ not json");
    await writeFile(join(dir, "s-future.json"), JSON.stringify({ version: PROJCACHE_VERSION + 1, record: {} }));
    const listing = await readProjcache(dir);
    assert.equal(listing.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
