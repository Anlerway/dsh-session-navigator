/**
 * dsh-session-navigator — the sessions manifest: the answers the last run already
 * paid for, kept where a cold start can read them back without opening a log.
 *
 * A start has to answer two questions about every session:
 *
 *   what is this session?  — its header, one zstd frame per log (sources/heads.js)
 *   what happened in it?   — DSH's projection cache, one small JSON per session
 *                            (sources/projcache.js)
 *
 * Both are cheap per item and ruinous in bulk. On a 5 000-session home a start
 * spent ~120 ms reading 5 000 session directories, ~440 ms decoding first frames
 * and seconds parsing 5 000 cache files, and the rest of the day re-answering
 * from memory what the previous process had already worked out. This file is the
 * mirror those two readers consult instead: an entry is reused only when the file
 * it describes still has the same size and times, so a rewritten log or a
 * rewritten cache file misses and is read exactly as before.
 *
 * Three rules:
 *
 *   1. It is derived, never authoritative. Deleting the file costs one full scan
 *      and never data. A manifest this build cannot parse is treated as empty
 *      and overwritten in place — a cache must never be the reason a listing
 *      fails, and there is no migration path to maintain.
 *   2. One entry per file version, keyed by the file's own version numbers. The
 *      log key carries ctime as well as size and mtime, because a rewrite can land
 *      on the same two (see sources/heads.js); a projection cache file is keyed
 *      by size and mtime, exactly like that module's in-process cache.
 *   3. Nothing here is written while nothing changed, and a change waits for the
 *      home to go quiet before it is written at all: the running process answers
 *      from memory, so the file only has to be current for the next start.
 *
 * The `.v1` in the file name (see src/paths.js) is a slot, not the schema
 * version: the payload carries `version` (MANIFEST_VERSION) and a payload from
 * another version is ignored. That is what lets the name stay stable across
 * schema changes instead of orphaning the old file.
 *
 * @module src/sources/manifest
 */

import { readFile } from "node:fs/promises";

import { writeAtomic } from "../store/sidecar.js";

/**
 * Schema version of the payload written below.
 *
 * Bump it whenever the shape of a stored header (sources/heads.js
 * `normalizeHeader`) or of stored facts (sources/projcache.js `factsOf`)
 * changes. Entries are plain objects, so nothing else would notice, and a stale
 * shape would reach the domain layer as a session with silently missing fields.
 */
const MANIFEST_VERSION = 1;

/**
 * @typedef {object} LogEntry
 * @property {number} size bytes of the log this header was decoded from
 * @property {number} mtimeMs
 * @property {number} ctimeMs
 * @property {object} header the decoded header, exactly as normalizeHeader built it
 * @property {boolean | null} [turnStart] absent when the log could not be read
 */

/**
 * @typedef {object} FactEntry
 * @property {number} size bytes of the projection cache file
 * @property {number} mtimeMs
 * @property {number} version the PROJCACHE_VERSION those facts were read under
 * @property {object} facts
 */

/**
 * Does this entry still describe the file it was built from?
 *
 * `ctimeMs` is optional and only log entries carry it: a projection cache file is
 * keyed by size and mtime alone, the same pair sources/projcache.js uses in
 * memory, so the two caches always agree about what counts as "changed".
 *
 * @param {{ size: number, mtimeMs: number, ctimeMs?: number }} entry
 * @param {{ size: number, mtimeMs: number, ctimeMs?: number }} info
 * @returns {boolean}
 */
export function sameVersion(entry, info) {
  if (entry.size !== info.size) return false;
  if (entry.mtimeMs !== info.mtimeMs) return false;
  if (entry.ctimeMs === undefined || info.ctimeMs === undefined) return true;
  return entry.ctimeMs === info.ctimeMs;
}

/**
 * @param {any} value
 * @returns {value is number}
 */
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate one stored header entry, or reject it.
 *
 * The manifest is a file a user can edit, truncate or leave half-written, and it
 * feeds the domain layer, so every field it claims is checked here rather than
 * three modules later. A rejected entry is simply a miss.
 *
 * @param {any} entry
 * @param {string} logPath the key it was stored under
 * @returns {LogEntry | null}
 */
function logEntryOf(entry, logPath) {
  if (!entry || typeof entry !== "object") return null;
  if (!finiteNumber(entry.size) || !finiteNumber(entry.mtimeMs) || !finiteNumber(entry.ctimeMs)) return null;
  const header = entry.header;
  if (!header || typeof header !== "object") return null;
  if (typeof header.id !== "string" || header.id === "") return null;
  if (entry.turnStart !== undefined && entry.turnStart !== null && typeof entry.turnStart !== "boolean") return null;
  const clean = {
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
    // The path is the key, so it is also the truth about where this header came
    // from: a hand-edited copy cannot point the row at another log.
    header: { ...header, logPath },
  };
  if (entry.turnStart !== undefined) clean.turnStart = entry.turnStart;
  return clean;
}

/**
 * @param {any} entry
 * @returns {FactEntry | null}
 */
function factEntryOf(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (!finiteNumber(entry.size) || !finiteNumber(entry.mtimeMs)) return null;
  if (!Number.isInteger(entry.version)) return null;
  if (!entry.facts || typeof entry.facts !== "object") return null;
  return { size: entry.size, mtimeMs: entry.mtimeMs, version: entry.version, facts: entry.facts };
}

/**
 * Read the manifest, treating every kind of damage as "nothing learned yet".
 *
 * A missing file, a file being replaced while it is read, invalid JSON, a payload
 * from another schema version, one bad entry: all of them answer with the entries
 * that survived, so the caller's fallback is the ordinary read path it had before
 * this module existed.
 *
 * @param {string} filePath absolute path of the manifest
 * @returns {Promise<{ logs: Map<string, LogEntry>, facts: Map<string, FactEntry> }>}
 */
export async function readManifest(filePath) {
  /** @type {Map<string, LogEntry>} */
  const logs = new Map();
  /** @type {Map<string, FactEntry>} */
  const facts = new Map();
  if (typeof filePath !== "string" || filePath === "") return { logs, facts };
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return { logs, facts };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { logs, facts };
  }
  if (parsed?.version !== MANIFEST_VERSION) return { logs, facts };
  for (const [logPath, entry] of Object.entries(parsed?.logs ?? {})) {
    const clean = logEntryOf(entry, logPath);
    if (clean !== null) logs.set(logPath, clean);
  }
  for (const [sessionId, entry] of Object.entries(parsed?.facts ?? {})) {
    const clean = factEntryOf(entry);
    if (clean !== null) facts.set(sessionId, clean);
  }
  return { logs, facts };
}

/**
 * Write the manifest over the previous one, atomically.
 *
 * The whole payload is rebuilt: a mirror with an entry the scan did not find is
 * a mirror of a home that is no longer being read, and the caller has just
 * enumerated what is actually there.
 *
 * @param {string} filePath absolute path of the manifest
 * @param {string} tmpDir same-volume scratch directory for the atomic swap
 * @param {Map<string, LogEntry>} logs
 * @param {Map<string, FactEntry>} facts
 * @returns {Promise<void>}
 */
export async function writeManifest(filePath, tmpDir, logs, facts) {
  const payload = {
    version: MANIFEST_VERSION,
    writtenAt: Date.now(),
    logs: Object.fromEntries(logs),
    facts: Object.fromEntries(facts),
  };
  await writeAtomic(filePath, tmpDir, JSON.stringify(payload));
}
