/**
 * 更新说明 — the document behind 设置 › 关于 › 更新说明.
 *
 * One file per language in `docs/changelog/`, named by the code this plugin
 * speaks (`src/lang.js`). The dialog asks for the language the interface is
 * drawn in; a language without its own file falls back to English and then to
 * Chinese, so adding a dictionary without its notes still opens something
 * readable instead of an error card.
 *
 * The directory is part of the package (`files` in package.json), which is why
 * an installed copy reads the same bytes the repository holds — there is no
 * second copy to keep in step, and no step that has to be remembered before a
 * release.
 *
 * Read per open, remembered by size + mtime: the file is a few kilobytes, and
 * "I rewrote the notes and the dialog still shows the old ones" is exactly the
 * bug this whole arrangement exists to avoid.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NOTES_MAX_BYTES, parseNotes } from "../domain/notes.js";
import { normalizeLang } from "../lang.js";
import { codedError } from "../store/sidecar.js";

/** The package this module lives in (src/host/ → ../..). */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where the notes live: one markdown file per language code. */
export const NOTES_DIR = join(PACKAGE_ROOT, "docs", "changelog");

/** The language used when a requested one has no file yet. */
const NOTES_FALLBACK = ["en", "zh"];

/**
 * The files tried for one language, best first.
 *
 * A code this plugin cannot draw (`tlh`, `xx-YY`) names no dictionary, so it
 * names no notes either: the fallbacks answer, and the dialog shows a real
 * document rather than a "no such language" card.
 *
 * @param {unknown} language
 * @returns {string[]} absolute paths, in the order they win
 */
export function noteFiles(language) {
  const first = normalizeLang(language);
  const codes = first ? [first, ...NOTES_FALLBACK.filter((code) => code !== first)] : NOTES_FALLBACK;
  return codes.map((code) => join(NOTES_DIR, `${code}.md`));
}

/** @type {{ key: string, notes: null | { title: string, blocks: any[], bytes: number, updatedAt: number } }} */
let memo = { key: "", notes: null };

/**
 * The release notes, parsed into blocks.
 *
 * @param {{ files?: string[], language?: string }} [options] `files` is how the
 *   tests point at fixtures; the route passes a language and lets the defaults
 *   decide which file answers.
 * @returns {Promise<{ title: string, blocks: any[], bytes: number, updatedAt: number }>}
 */
export async function readNotes({ files, language } = {}) {
  const candidates = Array.isArray(files) && files.length ? files : noteFiles(language);
  for (const file of candidates) {
    let info = null;
    try {
      info = await stat(file);
    } catch {
      continue; // absent is the normal case for the fallbacks
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
  throw codedError("not-found", `找不到更新说明文件（${candidates[0] ?? NOTES_DIR}）`);
}
