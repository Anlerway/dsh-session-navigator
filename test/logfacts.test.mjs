/**
 * Tests for the one fact a listing reads off a log: has it ever held a turn?
 *
 *   node --test test/logfacts.test.mjs
 *
 * A session that never started a turn is 空白会话, and DSH only knows that for
 * the sessions it has listed itself. The interesting cases are therefore the
 * two window edges — a log small enough to read whole, and one big enough that
 * only its head is read — plus everything this module no longer claims: the
 * liveness inference (已中断) is gone, so no test here asks whether a turn is
 * still open.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { zstdCompressSync } from "node:zlib";

import { clearLogFacts, readLogFacts } from "../lib/sources/logfacts.js";

/** @returns {Promise<string>} */
async function tempDir() {
  return await mkdtemp(join(tmpdir(), "se-logfacts-"));
}

/**
 * Write a log made of one zstd frame per batch.
 *
 * @param {string} path
 * @param {string[][]} batches event lines per frame
 * @returns {Promise<number>} bytes written
 */
async function writeLog(path, batches) {
  const frames = batches.map((lines) => zstdCompressSync(Buffer.from(lines.map((line) => `${line}\n`).join(""), "utf8")));
  const buf = Buffer.concat(frames);
  await writeFile(path, buf);
  return buf.length;
}

/** A line that does not compress, so a fixture really is large on disk. */
const noisy = () => `{"type":"message/part","text":"${randomBytes(96).toString("base64")}"}`;

const header = '{"type":"session/header","id":"s-1","formatVersion":4}';
const turnStart = '{"type":"turn/start","turnId":"t-1"}';
const turnEnd = '{"type":"turn/end","turnId":"t-1","reason":"completed"}';
const message = '{"type":"message/part","text":"hi"}';

test("a log that holds a turn is not blank", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    const size = await writeLog(path, [[header, turnStart, message], [turnEnd]]);
    clearLogFacts();
    const facts = await readLogFacts(path, size, 1);
    assert.deepEqual(facts, { turnStart: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a log that never started a turn is blank", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    const size = await writeLog(path, [[header]]);
    clearLogFacts();
    const facts = await readLogFacts(path, size, 1);
    assert.deepEqual(facts, { turnStart: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a log cut off mid-turn reports the same thing as a finished one", async () => {
  // The 已中断 inference is gone: a turn that never closed is not this module's
  // question any more. It answers about the first turn and nothing else.
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    const size = await writeLog(path, [[header, message], [turnStart]]);
    clearLogFacts();
    const facts = await readLogFacts(path, size, 1);
    assert.deepEqual(facts, { turnStart: true });
    assert.equal("openTurn" in facts, false, "liveness is not inferred from the log");
    assert.equal("lastType" in facts, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a large log is read from its head, not read whole", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    const batches = [[header, turnStart]];
    for (let index = 0; index < 120; index += 1) {
      batches.push(Array.from({ length: 30 }, noisy));
    }
    batches.push([turnEnd]);
    const size = await writeLog(path, batches);
    assert.ok(size > 256 * 1024, `fixture must exceed the small-log bound, got ${size}`);
    clearLogFacts();
    const facts = await readLogFacts(path, size, 1);
    assert.deepEqual(facts, { turnStart: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a large log whose head holds no turn is unknown, never blank", async () => {
  // Blank hides a session from the list, so an unread head must not claim it:
  // the turn here sits past the head window, where this module never looks.
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    const batches = [[header]];
    for (let index = 0; index < 120; index += 1) {
      batches.push(Array.from({ length: 30 }, noisy));
    }
    batches.push([turnStart]);
    const size = await writeLog(path, batches);
    assert.ok(size > 256 * 1024, `fixture must exceed the small-log bound, got ${size}`);
    clearLogFacts();
    const facts = await readLogFacts(path, size, 1);
    assert.deepEqual(facts, { turnStart: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a torn tail changes nothing about the head", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    const size = await writeLog(path, [[header, turnStart], [turnEnd]]);
    // Half a frame appended by a write that was interrupted.
    await appendFile(path, zstdCompressSync(Buffer.from(`${message}\n`)).subarray(0, 6));
    clearLogFacts();
    const facts = await readLogFacts(path, size + 6, 1);
    assert.deepEqual(facts, { turnStart: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("facts are cached by path+size+mtime, so a listing does not re-read", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    const size = await writeLog(path, [[header, turnStart]]);
    clearLogFacts();
    const first = await readLogFacts(path, size, 1);
    assert.deepEqual(first, { turnStart: true });
    // Delete the file: a second read that went to disk would return null.
    await rm(path);
    const second = await readLogFacts(path, size, 1);
    assert.deepEqual(second, first);
    // A different mtime is a different key — the log may have grown.
    const third = await readLogFacts(path, size, 2);
    assert.equal(third, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("events DSH writes after a turn closes do not change the answer", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    const title = '{"type":"session/title","title":"简单问候"}';
    const endSeed = '{"type":"session/end-seed","inherited":true}';
    const size = await writeLog(path, [[header, turnStart, message], [turnEnd], [title, endSeed]]);
    clearLogFacts();
    const facts = await readLogFacts(path, size, 1);
    assert.deepEqual(facts, { turnStart: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a log with no readable frame yields null", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    await writeFile(path, Buffer.from("not a zstd frame at all\n", "utf8"));
    clearLogFacts();
    assert.equal(await readLogFacts(path, 24, 1), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an empty log is blank rather than unreadable", async () => {
  const dir = await tempDir();
  try {
    const path = join(dir, "session.v4.jsonl.zstd");
    await writeFile(path, Buffer.alloc(0));
    clearLogFacts();
    assert.deepEqual(await readLogFacts(path, 0, 1), { turnStart: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable log yields null instead of failing the listing", async () => {
  clearLogFacts();
  assert.equal(await readLogFacts(join(tmpdir(), "se-does-not-exist", "x.zstd"), 10, 1), null);
  assert.equal(await readLogFacts(null), null);
});
