/**
 * Filesystem primitives shared across layers.
 *
 * These sit at the root next to `paths.js` for a layering reason: the host
 * actions (copy, move, trash) and the component installer both need them, and
 * the two layers do not import each other. Keeping one copy here is what makes
 * "does this exist" and "what is in here" mean the same thing everywhere.
 */

import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Relative names of every regular file under `dir`, sorted.
 *
 * Symlinks are not followed and directories are not listed: the callers
 * compare two trees ("did the copy land?" / "did the trash keep everything?"),
 * and both only care about files.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function fileList(dir) {
  /** @type {string[]} */
  const found = [];
  /** @type {{ rel: string, abs: string }[]} */
  const pending = [{ rel: "", abs: dir }];
  while (pending.length > 0) {
    const current = /** @type {{ rel: string, abs: string }} */ (pending.pop());
    const entries = await readdir(current.abs, { withFileTypes: true });
    for (const entry of entries) {
      const rel = current.rel === "" ? entry.name : `${current.rel}/${entry.name}`;
      const abs = join(current.abs, entry.name);
      if (entry.isDirectory()) pending.push({ rel, abs });
      else found.push(rel);
    }
  }
  return found.sort();
}
