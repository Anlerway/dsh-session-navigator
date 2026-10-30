/**
 * 更新说明 — the document behind 设置 › 关于 › 更新说明.
 *
 * Two files, one answer. In a checkout the notes are edited in 更新说明.md, one
 * level above the package; an installed copy has only the CHANGELOG.md that was
 * packed with it, because a package cannot ship its own parent. The checkout is
 * tried first so an edit is visible on the next open instead of at the next
 * release, and the packaged copy is what a user of the published plugin reads.
 * (test/notes.test.mjs holds the two against each other when both exist, so they
 * cannot drift apart silently.)
 *
 * Read per open, remembered by size + mtime: the file is a few kilobytes, and
 * "I rewrote the notes and the dialog still shows the old ones" is exactly the
 * bug this whole arrangement exists to avoid.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NOTES_MAX_BYTES, parseNotes } from "../domain/notes.js";
import { codedError } from "../store/sidecar.js";

/** The package this module lives in (lib/host/ → ../..). */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where the notes may live, in the order they are preferred. */
export const NOTE_FILES = [join(PACKAGE_ROOT, "..", "更新说明.md"), join(PACKAGE_ROOT, "CHANGELOG.md")];

/** @type {{ key: string, notes: null | { title: string, blocks: any[], bytes: number, updatedAt: number } }} */
let memo = { key: "", notes: null };

/**
 * The release notes, parsed into blocks.
 *
 * @param {{ files?: string[] }} [options] Overridden by tests to point at
 *   fixtures; the route always uses the defaults.
 * @returns {Promise<{ title: string, blocks: any[], bytes: number, updatedAt: number }>}
 */
export async function readNotes({ files = NOTE_FILES } = {}) {
  for (const file of files) {
    let info = null;
    try {
      info = await stat(file);
    } catch {
      continue; // absent is the normal case for the other candidate
    }
    if (!info.isFile() || info.size === 0) continue;
    if (info.size > NOTES_MAX_BYTES) {
      throw codedError("too-large", `更新说明 超过 ${NOTES_MAX_BYTES} 字节：${file}`);
    }
    const key = `${file}:${info.size}:${info.mtimeMs}`;
    if (memo.key === key) return memo.notes;
    const text = await readFile(file, "utf8");
    const parsed = parseNotes(text);
    const notes = { ...parsed, bytes: Buffer.byteLength(text, "utf8"), updatedAt: Math.round(info.mtimeMs) };
    memo = { key, notes };
    return notes;
  }
  throw codedError("not-found", "找不到更新说明文件（更新说明.md / CHANGELOG.md）");
}
