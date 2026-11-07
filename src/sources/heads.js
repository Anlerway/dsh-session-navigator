/**
 * dsh-session-navigator — L2 data source: session headers on disk.
 *
 * `<dshHome>/sessions/<encodedProjectDir>/<encodedSessionId>/session.v4.jsonl.zstd`
 *
 * The log is a concatenation of zstd frames; frame #1 holds the session header
 * line:
 *
 *   { type:"session", version:4, id, createdAt, cwd, isSeeded,
 *     delegationDepth, agentPreset, parentSession?, origin? }
 *
 * We decode *only* that frame. This costs a few hundred microseconds per
 * session and gives three things the projection cache cannot guarantee:
 *
 *   1. the session physically exists,
 *   2. its id and cwd (the cache's `identity` is a claim; the header is truth),
 *   3. headers for sessions the cache has not seen yet.
 *
 * Discovery walks the directory tree instead of re-deriving DSH's path encoding
 * (`C:\Users\mi\x` → `--C-Users-mi-x--`), which is an implementation detail that
 * has already changed once. Directory names are therefore treated as opaque;
 * identity comes from the decoded header, never from the path.
 */

import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readFirstRecord } from "../dsh/zstd.js";
import { sameVersion } from "./manifest.js";
// The log name and format version are owned by sources/artifact.js (the writer);
// importing them keeps a version bump from having to touch two files.
import { SESSION_FORMAT_VERSION, SESSION_LOG_FILE } from "./artifact.js";

export { SESSION_FORMAT_VERSION, SESSION_LOG_FILE };

/**
 * @param {string} dshHome
 * @returns {string} the sessions root
 */
export function sessionsDir(dshHome) {
  return join(dshHome, "sessions");
}

/**
 * Normalize one decoded header line into the shape the domain layer expects.
 *
 * @param {any} raw
 * @param {{ logPath?: string, sizeBytes?: number, mtimeMs?: number }} [meta]
 * @returns {object | null} `null` for a non-header or unknown version
 */
function normalizeHeader(raw, meta = {}) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type !== "session") return null;
  if (!Number.isInteger(raw.version) || raw.version < 1) return null;
  return {
    id: String(raw.id ?? ""),
    formatVersion: raw.version,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : null,
    cwd: typeof raw.cwd === "string" ? raw.cwd : null,
    isSeeded: raw.isSeeded === true,
    delegationDepth: Number.isFinite(raw.delegationDepth) ? raw.delegationDepth : 0,
    agentPreset: typeof raw.agentPreset === "string" ? raw.agentPreset : null,
    parentSession: typeof raw.parentSession === "string" ? raw.parentSession : null,
    origin: typeof raw.origin === "string" ? raw.origin : null,
    logPath: meta.logPath ?? null,
    sizeBytes: Number.isFinite(meta.sizeBytes) ? meta.sizeBytes : null,
    // Together with the size this is the cache key for the tail facts
    // (`sources/logfacts.js`): a log only needs re-reading when it changed.
    mtimeMs: Number.isFinite(meta.mtimeMs) ? meta.mtimeMs : null,
  };
}

/**
 * Decoded headers, one entry per log path.
 *
 * A header changes only when DSH rewrites the log, and a rewrite moves the
 * file's size, mtime or ctime. Decoding the same bytes again produced the same
 * header at 95 µs per session — 444 ms of every refresh at 5 000 sessions —
 * for an answer that was already in memory.
 *
 * ctime rides along because a rewrite can land on the same size and, on a
 * coarse filesystem, the same mtime; the inode change time still moves.
 *
 * @type {Map<string, { key: string, header: object }>}
 */
const headerCache = new Map();

/** How many decoded headers stay cached. One entry is a small object. */
const HEADER_CACHE_LIMIT = 20000;

/**
 * @param {{ size: number, mtimeMs: number, ctimeMs: number }} info
 * @returns {string}
 */
function versionKeyOf(info) {
  return `${info.size}\u0000${info.mtimeMs}\u0000${info.ctimeMs}`;
}

/**
 * Store one header, keeping the map bounded and its order most-recent-last.
 *
 * @param {string} logPath
 * @param {string} key
 * @param {object} header
 */
function rememberHeader(logPath, key, header) {
  headerCache.delete(logPath);
  headerCache.set(logPath, { key, header });
  while (headerCache.size > HEADER_CACHE_LIMIT) {
    const oldest = headerCache.keys().next().value;
    if (oldest === undefined) break;
    headerCache.delete(oldest);
  }
}

/**
 * Drop cached headers for logs the walk did not find.
 *
 * Without this a DSH home the user moved away from keeps its headers for the
 * life of the process. The walk is the only moment the set of existing logs is
 * known, so it is also the moment to prune.
 *
 * @param {Set<string>} live
 */
function sweepHeaderCache(live) {
  for (const logPath of headerCache.keys()) {
    if (!live.has(logPath)) headerCache.delete(logPath);
  }
}

/**
 * Drop every cached header.
 *
 * Tests use it; production never needs to, because a rewritten log changes the
 * version key and therefore misses on its own.
 */
export function clearHeaderCache() {
  headerCache.clear();
}

/**
 * Read one session header, reusing the decode when the log has not changed.
 *
 * The answer carries the `stat` the header was decoded against: the caller
 * writes it into the manifest (sources/manifest.js), and a scan that already
 * stat'ed the file must not pay for a second one.
 *
 * @param {string} logPath absolute path to `session.v4.jsonl.zstd`
 * @param {import("node:fs").Stats | null} [knownInfo] a stat the walk already took
 * @returns {Promise<{ header: object, info: import("node:fs").Stats } | null>}
 */
async function readSessionHeader(logPath, knownInfo) {
  /** @type {import("node:fs").Stats | null} */
  let info = knownInfo ?? null;
  if (info === null) {
    try {
      // The log size is what the list shows in its 大小 column, and together with
      // mtime it is also the version key of the cached decode.
      info = await stat(logPath);
    } catch {
      // A log the walk found a moment ago is gone now: report it as absent
      // rather than as a broken read.
      headerCache.delete(logPath);
      return null;
    }
  }
  const key = versionKeyOf(info);
  const cached = headerCache.get(logPath);
  if (cached !== undefined && cached.key === key) {
    rememberHeader(logPath, key, cached.header);
    return { header: cached.header, info };
  }
  try {
    const raw = await readFirstRecord(logPath);
    const header = normalizeHeader(raw, { logPath, sizeBytes: info.size, mtimeMs: info.mtimeMs });
    if (header === null) {
      headerCache.delete(logPath);
      return null;
    }
    rememberHeader(logPath, key, header);
    return { header, info };
  } catch {
    headerCache.delete(logPath);
    return null;
  }
}

/** `session.v<N>.jsonl.zstd`: the format version is part of the file name. */
const LOG_NAME = /^session\.v(\d+)\.jsonl\.zstd$/;

/**
 * How many header decodes run at once.
 *
 * Every header costs one open file and a small buffer. A few hundred sessions
 * read at once is a few hundred fds and tens of megabytes of buffers, and the
 * plugin shares the process with DSH itself.
 */
const HEAD_CONCURRENCY = 8;

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The newest log in one session directory, or `null` when there is none.
 *
 * The name carries the format version, so building the path from the current
 * constant would make every session written by another DSH version invisible —
 * it would simply not appear in the list, with no error anywhere. Reading the
 * directory keeps old logs visible, and picking the highest version means a
 * session that was upgraded in place is read once.
 *
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
async function newestLog(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  let bestVersion = -1;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = LOG_NAME.exec(entry.name);
    if (!match) continue;
    const version = Number(match[1]);
    if (version > bestVersion) {
      bestVersion = version;
      best = entry.name;
    }
  }
  return best === null ? null : join(dir, best);
}

/**
 * Discover every session log under `<dshHome>/sessions`.
 *
 * Layout is two levels deep (`<project>/<session>/<file>`), but both levels are
 * walked defensively: a stray file or a nested directory is skipped rather than
 * throwing, because a plugin must never take the app down over a data-dir quirk.
 *
 * The expensive part is the innermost level: a session directory is read only to
 * learn which format version its log is named after, and at 5 000 sessions that
 * is 5 000 directory reads for names the last run already recorded. `known` — the
 * manifest's log map — answers for those: the recorded path is stat'ed instead,
 * and the directory is read only for a session directory that is new, renamed, or
 * whose recorded log has gone (an in-place format upgrade). The two outer levels
 * still have to be walked, because a new session appears there and nowhere else.
 *
 * The result is sorted by path, so "the same session id was found twice" always
 * resolves the same way (see `scanHeaders`).
 *
 * @param {string} dshHome
 * @param {{ known?: Map<string, { size: number, mtimeMs: number, ctimeMs?: number }> }} [options]
 * @returns {Promise<Array<{ logPath: string, projectDir: string, info: import("node:fs").Stats | null }>>}
 */
export async function discoverLogs(dshHome, options = {}) {
  const root = sessionsDir(dshHome);
  /** @type {Array<{ logPath: string, projectDir: string, info: import("node:fs").Stats | null }>} */
  const found = [];
  /** @type {Array<{ dir: string, projectDir: string, knownPath: string | null }>} */
  const sessionDirs = [];

  // Session directory → the log the last run found in it. A log path is
  // `<dir>/<name>`, so the directory is the join key.
  /** @type {Map<string, string>} */
  const knownByDir = new Map();
  for (const logPath of options.known?.keys() ?? []) knownByDir.set(dirname(logPath), logPath);

  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    let sessions;
    try {
      sessions = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const dir = join(projectDir, session.name);
      sessionDirs.push({ dir, projectDir: project.name, knownPath: knownByDir.get(dir) ?? null });
    }
  }

  await mapLimit(sessionDirs, HEAD_CONCURRENCY, async (entry) => {
    /** @type {import("node:fs").Stats | null} */
    let info = null;
    let logPath = null;
    if (entry.knownPath !== null) {
      try {
        info = await stat(entry.knownPath);
        logPath = entry.knownPath;
      } catch {
        // Written by a newer format version, renamed, or gone: ask the
        // directory. One extra read for a session that was upgraded in place.
        info = null;
      }
    }
    if (logPath === null) logPath = await newestLog(entry.dir);
    if (logPath !== null) found.push({ logPath, projectDir: entry.projectDir, info });
  });

  found.sort((a, b) => (a.logPath < b.logPath ? -1 : a.logPath > b.logPath ? 1 : 0));
  return found;
}

/**
 * Read every session header under the sessions root, and report the file
 * versions behind them.
 *
 * `known` is the manifest's log map (sources/manifest.js). A recorded path whose
 * size, mtime and ctime still match is answered without opening the log: at
 * 5 000 sessions that is the difference between ~440 ms of first-frame decoding
 * and none. Everything else — a rewritten log, a new session, a cache that was
 * never written — takes the ordinary decode.
 *
 * @param {string} dshHome
 * @param {{ known?: Map<string, { size: number, mtimeMs: number, ctimeMs?: number, header: object }> }} [options]
 * @returns {Promise<{ headers: Map<string, object>, logs: Map<string, { size: number, mtimeMs: number, ctimeMs: number, header: object }> }>}
 */
export async function scanHeaders(dshHome, options = {}) {
  const known = options.known ?? null;
  const logs = await discoverLogs(dshHome, { known });
  const results = await mapLimit(logs, HEAD_CONCURRENCY, async (found) => {
    const prior = known?.get(found.logPath);
    // The manifest answered for this exact file version: no open, no decode.
    if (prior && found.info && sameVersion(prior, found.info)) {
      // Keep the in-process cache in step — the log facts are keyed against it,
      // and a listing that reopened the log would undo the point of the manifest.
      rememberHeader(found.logPath, versionKeyOf(found.info), prior.header);
      return { logPath: found.logPath, header: prior.header, info: found.info };
    }
    const read = await readSessionHeader(found.logPath, found.info);
    return read === null ? null : { logPath: found.logPath, header: read.header, info: read.info };
  });

  /** @type {Map<string, object>} */
  const headers = new Map();
  /** @type {Map<string, { size: number, mtimeMs: number, ctimeMs: number, header: object }>} */
  const entries = new Map();
  for (const result of results) {
    if (!result?.header?.id) continue;
    entries.set(result.logPath, {
      size: result.info.size,
      mtimeMs: result.info.mtimeMs,
      ctimeMs: result.info.ctimeMs,
      header: result.header,
    });
    // `discoverLogs` sorted the paths, and a `Map` keeps the first write, so two
    // copies of one session id resolve to the same header on every scan instead
    // of depending on which parallel read finished first.
    if (!headers.has(result.header.id)) headers.set(result.header.id, result.header);
  }
  // This walk just enumerated every log under the home, so anything cached for
  // a path it did not see belongs to a home that is no longer being read.
  sweepHeaderCache(new Set(logs.map((entry) => entry.logPath)));
  return { headers, logs: entries };
}

/**
 * Read every session header under the sessions root.
 *
 * @param {string} dshHome
 * @param {{ known?: Map<string, any> }} [options] see `scanHeaders`
 * @returns {Promise<Map<string, object>>} sessionId → header
 */
export async function readAllHeaders(dshHome, options = {}) {
  return (await scanHeaders(dshHome, options)).headers;
}
