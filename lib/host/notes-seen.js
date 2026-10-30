/**
 * dsh-session-navigator — which version's 更新说明 has been delivered.
 *
 * One line of JSON in the data directory, and the reason it is not in
 * localStorage: the DSH web GUI is served from a fresh port on every launch,
 * and browser storage is partitioned by origin, so a record written under one
 * port is invisible under the next — the announcement would fire at every
 * start, which is exactly what "once per version" is not.
 *
 * Machine-wide, not per window, on purpose: "this install has been told what
 * changed" is a fact about the install. A second browser on the same machine
 * missing the notice is the cheaper mistake.
 *
 * Deliberately not a sidecar document (lib/store/sidecar.js): there is nothing
 * to merge and nothing to revise — the newest answer wins, and a lost write
 * costs one extra announcement, so it is written the cheap way.
 */

import { readFile, rename, writeFile } from "node:fs/promises";

/** Long enough for any semver, short enough that the file stays a record. */
const MAX_VERSION = 64;

/**
 * The version whose notes were last delivered.
 *
 * Every failure — missing file, unreadable file, hand-edited garbage — means
 * "nothing delivered yet": one announcement more, never a failed start.
 *
 * @param {string} file absolute path
 * @returns {Promise<string>} `""` when nothing is recorded
 */
export async function readNotesSeen(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const version = typeof parsed?.version === "string" ? parsed.version.trim() : "";
    return version.slice(0, MAX_VERSION);
  } catch {
    return "";
  }
}

/**
 * Record that `version`'s notes have been delivered.
 *
 * Renamed into place, so a crash mid-write leaves the previous record rather
 * than half a file. Returns what was stored; an empty version is a no-op (the
 * caller had nothing to deliver, and recording `""` would make the next launch
 * announce a version it never showed).
 *
 * @param {string} file absolute path
 * @param {unknown} version
 * @returns {Promise<string>}
 */
export async function writeNotesSeen(file, version) {
  const value = typeof version === "string" ? version.trim().slice(0, MAX_VERSION) : "";
  if (value === "") return "";
  const staging = `${file}.tmp`;
  await writeFile(staging, `${JSON.stringify({ version: value, at: new Date().toISOString() })}\n`, "utf8");
  await rename(staging, file);
  return value;
}
