/**
 * Copy the checkout's 更新说明.md over the packaged CHANGELOG.md.
 *
 *   node scripts/sync-notes.mjs      (and: pnpm pack runs it as `prepack`)
 *
 * The dialog reads a document, and a package can only ship files inside itself —
 * so the notes a published version carries have to be a copy. Doing the copy in
 * `prepack` is what keeps that copy honest: the tarball is built from the same
 * bytes the maintainer just edited, with no remembered step in between.
 *
 * A checkout without 更新说明.md (a fresh clone of a released tarball) is not an
 * error: the packaged copy is then the only notes, and it is already in place.
 */
import { copyFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "..", "更新说明.md");
const TARGET = join(ROOT, "CHANGELOG.md");

try {
  const info = await stat(SOURCE);
  if (!info.isFile() || info.size === 0) throw new Error("empty");
  await copyFile(SOURCE, TARGET);
  console.log(`CHANGELOG.md ← 更新说明.md (${info.size} bytes)`);
} catch {
  console.log("CHANGELOG.md left as is (no 更新说明.md next to the package)");
}
