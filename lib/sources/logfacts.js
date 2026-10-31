/**
 * dsh-session-navigator — the one fact a listing needs from a log that DSH does
 * not cache for sessions it never listed itself: has this conversation ever
 * held a turn?
 *
 *   空白会话  — a session that never received a prompt. DSH's projcache knows,
 *               but only for sessions it listed itself; a log found by walking
 *               the data dir has no such record, and painting it as an ordinary
 *               row puts an empty placeholder in the list.
 *
 * Liveness is deliberately *not* here. Whether a session runs is DSH's
 * in-memory answer (`agents.get(id)?.status === 'running'`,
 * `packages/api/session-controller/src/list.ts:120`), and the panel reports the
 * same states DSH reports. An earlier revision inferred a third state from the
 * log — 已中断, "the newest turn never closed" — and that inference is gone: the
 * log cannot tell a crashed turn from a title written after one, and DSH itself
 * never claims to know.
 *
 * The answer lives at the head of the file, and a log is a concatenation of zstd
 * frames (one per appended batch) — see `dsh/zstd.js`. A small log is decoded
 * whole; a large one is read from the start only, because a `turn/start` that
 * never appears in the first batches is reported as "unknown" rather than
 * "blank": hiding a real conversation is worse than showing a short one.
 *
 * Everything is cached by `path|size|mtime`, because a listing re-runs on every
 * keystroke while a log only changes while its turn is running.
 */

import { open, readFile, stat } from "node:fs/promises";

import { decompressFrame, scanZstdFrames } from "../dsh/zstd.js";

/** How much of the start of a large log is read to find its first turn. */
const HEAD_BYTES = 64 * 1024;

/** Logs at or below this size are read whole: one read beats two. */
const SMALL_BYTES = 256 * 1024;

/** Frames decompressed from the head of a large log to look for a first turn. */
const HEAD_FRAMES = 3;

/** How many logs' facts stay cached. */
const CACHE_LIMIT = 512;

/** `turn/start` in a JSONL event line, without parsing it. */
const TURN_START = /"type"\s*:\s*"turn\/start"/;

/** @type {Map<string, { turnStart: boolean | null }>} */
const cache = new Map();

/**
 * Drop every cached answer.
 *
 * Tests use it; production never needs to, because the key carries size and
 * mtime and a changed log therefore misses on its own.
 */
export function clearLogFacts() {
  cache.clear();
}

/**
 * The listing fact for one log, or `null` when it cannot be read.
 *
 * @param {string | null | undefined} logPath
 * @param {number | null} [sizeBytes] size from the header scan
 * @param {number | null} [mtimeMs] mtime from the header scan
 * @returns {Promise<{ turnStart: boolean | null } | null>}
 */
export async function readLogFacts(logPath, sizeBytes, mtimeMs) {
  if (typeof logPath !== "string" || logPath === "") return null;
  const key = `${logPath}\u0000${sizeBytes ?? ""}\u0000${mtimeMs ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let facts = null;
  try {
    facts = await scanLog(logPath, sizeBytes);
  } catch {
    // A log being rewritten, a permission problem, an exotic frame: a listing
    // must not fail because one row could not be classified.
    facts = null;
  }
  if (facts) remember(key, facts);
  return facts;
}

/**
 * @param {string} key
 * @param {{ turnStart: boolean | null }} value
 */
function remember(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Classify one log.
 *
 * @param {string} logPath
 * @param {number | null} sizeBytes
 * @returns {Promise<{ turnStart: boolean | null } | null>}
 */
async function scanLog(logPath, sizeBytes) {
  const size = Number.isFinite(sizeBytes) ? Number(sizeBytes) : (await stat(logPath)).size;
  if (size === 0) return { turnStart: false };

  if (size <= SMALL_BYTES) {
    const buf = await readFile(logPath);
    const scan = scanZstdFrames(buf);
    if (scan.frames.length === 0) return null;
    return { turnStart: TURN_START.test(framesText(buf, scan.frames)) };
  }

  // The first turn lives at the top of the file, so only the head is read. A
  // head without a turn is "unknown", never "blank".
  const head = await readHead(logPath, size);
  return { turnStart: head === null ? null : TURN_START.test(head) ? true : null };
}

/**
 * Decompressed text of the first few frames of a log.
 *
 * @param {string} logPath
 * @param {number} size
 * @returns {Promise<string | null>}
 */
async function readHead(logPath, size) {
  const want = Math.min(size, HEAD_BYTES);
  const handle = await open(logPath, "r");
  try {
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(buf, 0, want, 0);
    const scan = scanZstdFrames(buf.subarray(0, bytesRead));
    if (scan.frames.length === 0) return null;
    return framesText(buf.subarray(0, bytesRead), scan.frames.slice(0, HEAD_FRAMES));
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * @param {Buffer} buf
 * @param {Array<{ start: number, end: number }>} frames
 * @returns {string}
 */
function framesText(buf, frames) {
  const parts = [];
  for (const frame of frames) parts.push(decompressFrame(buf, frame));
  return Buffer.concat(parts).toString("utf8");
}
