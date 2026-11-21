/**
 * A fresh temporary directory spelled the way DSH spells directories.
 *
 * Windows reaches one folder by two names: GitHub's runner sees %TEMP% as
 * `C:\Users\RUNNER~1\AppData\Local\Temp` and realpath reports the same folder
 * as `C:\Users\runneradmin\AppData\Local\Temp`. Every workspace path DSH stores
 * went through realpath when the workspace was created
 * (packages/workspace/workspace/src/paths.ts:52-57), so a fixture that kept the
 * short spelling would assert against a path no registry holds and would read
 * a spelling difference as a failed move. Resolving the root once, here, keeps
 * every path derived from it in the form DSH actually stores.
 */

import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * @param {string} prefix
 * @returns {Promise<string>} the realpath of a newly made directory
 */
export async function canonicalRoot(prefix) {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}
