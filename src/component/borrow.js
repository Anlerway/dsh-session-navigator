/**
 * dsh-session-navigator — borrow an Electron runtime another plugin already has.
 *
 * The detached window needs Electron, and DSH has no notion of a shared browser
 * runtime: every plugin that wants one ships its own copy of the same 150 MB
 * download. Two of them on one machine is 300 MB of identical bytes. This module
 * looks for the *other* copy so the user has the option of reusing it.
 *
 * Three rules make a borrow safe, and they are the whole design:
 *
 *   1. **Read-only.** Scanning lists directory entries and reads a version file.
 *      Nothing is created, renamed or deleted under the borrowed root — not even
 *      the app directory this plugin normally writes into `<runtime>/resources/app`.
 *      A tree another plugin owns must look exactly the same after a scan, a
 *      borrow, a window launch and an uninstall.
 *   2. **Bounded.** The walk is depth-limited from DSH's home and skips the bulky
 *      data directories (sessions, storages, caches, profiles). A user with
 *      10 000 session folders pays three `readdir` calls per plugin directory,
 *      not a full recursive scan.
 *   3. **Verifiable.** A candidate is an Electron runtime only if the platform's
 *      executable is there *and* a version file names a version. A stray
 *      `electron.exe` from an unrelated project is not offered.
 *
 * The one thing a borrow cannot promise is that the borrowed tree stays put. The
 * owning plugin can upgrade or uninstall it at any time; `inspectBorrowed` is
 * therefore re-run at launch, and a vanished runtime degrades to "absent" instead
 * of a window that never appears.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { binaryPath } from "./layout.js";

/**
 * How deep to walk under DSH's home.
 *
 * Both real layouts on disk sit within this: `~/.dsh/electron` (depth 1) and
 * `~/.dsh/<plugin>/electron-runtime` (depth 2). Depth 3 leaves room for one more
 * nesting level without turning the scan into a full walk of `~/.dsh`.
 *
 * @type {number}
 */
const BORROW_SCAN_DEPTH = 3;

/**
 * Directory names never worth walking.
 *
 * These are DSH's bulk data and dependency trees: megabytes to gigabytes of
 * files that are not runtime installs. `node_modules` is skipped because a
 * plugin's own dependencies are not a runtime this plugin may start.
 *
 * @type {ReadonlySet<string>}
 */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "sessions",
  "storages",
  "cache",
  "profiles",
  "attachments",
  "skills",
  "agents-anywhere",
  "channel-pack",
  "dsh-runtimes",
]);

/** Files Electron's official zip writes the release version into. */
const VERSION_FILES = ["version", "version.json"];

/**
 * Paths of a runtime this plugin did not install.
 *
 * Only `binary` is ever executed; the rest exist so the settings page can say
 * what was found without opening anything (an `.asar` is never stat-ed — see
 * `DEFAULT_APP_ENTRY`).
 *
 * @param {string} root the borrowed runtime directory
 * @param {string} [platform]
 */
export function borrowedPaths(root, platform = process.platform) {
  return {
    root,
    binary: binaryPath(root, platform),
    resources: join(root, "resources"),
    defaultApp: join(root, "resources", "default_app.asar"),
    versionFile: join(root, VERSION_FILES[0]),
  };
}

/**
 * The directory entry name of the platform's Electron executable.
 *
 * @param {string} platform
 * @returns {string}
 */
function executableEntryName(platform) {
  if (platform === "win32") return "electron.exe";
  if (platform === "darwin") return "Electron.app";
  return "electron";
}

/**
 * `readdir` that answers `null` instead of throwing.
 *
 * The scan runs over directories this plugin does not own: permission errors,
 * a path that vanished mid-walk and a symlink loop are all normal events, not
 * failures the user should see.
 *
 * @param {string} dir
 * @returns {Promise<import("node:fs").Dirent[] | null>}
 */
async function list(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * The Electron version recorded inside a runtime directory.
 *
 * Electron's zip carries a plain `version` file; some repackers write
 * `version.json` instead. Anything else (a truncated file, a directory's name)
 * is reported as `null` rather than guessed.
 *
 * @param {string} root
 * @returns {Promise<string | null>}
 */
async function readVersion(root) {
  for (const name of VERSION_FILES) {
    let text;
    try {
      text = await readFile(join(root, name), "utf8");
    } catch {
      continue;
    }
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed?.version === "string" && parsed.version.trim()) return parsed.version.trim();
      } catch {
        /* fall through to the loose match below */
      }
    }
    const match = trimmed.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
    if (match) return match[0];
  }
  return null;
}

/**
 * Decide whether `root` is a usable Electron runtime, reading nothing else.
 *
 * The executable must be a regular file (`Electron.app` a directory on macOS)
 * and a version file must name a version: the pair is what separates a runtime
 * from a folder that happens to be called `electron`. Whether the tree carries
 * `resources/default_app.asar` or `resources/app` is reported, not required —
 * this plugin passes its own app path on the command line, so a runtime whose
 * bundled app was stripped still starts the window.
 *
 * @param {string} root
 * @param {string} [platform]
 * @returns {Promise<{ root: string, binary: string, electronVersion: string, hasDefaultApp: boolean, hasApp: boolean } | null>}
 */
export async function inspectBorrowed(root, platform = process.platform) {
  if (typeof root !== "string" || root.trim() === "") return null;
  const dir = root.trim();
  const entries = await list(dir);
  if (!entries) return null;
  const named = executableEntryName(platform);
  const executable = entries.find((entry) => entry.name === named);
  if (!executable) return null;
  if (platform === "darwin" ? !executable.isDirectory() : !executable.isFile()) return null;

  const resources = entries.find((entry) => entry.name === "resources" && entry.isDirectory());
  if (!resources) return null;
  const inner = await list(join(dir, "resources"));
  const version = await readVersion(dir);
  if (!version) return null;

  return {
    root: dir,
    binary: borrowedPaths(dir, platform).binary,
    electronVersion: version,
    hasDefaultApp: Boolean(inner?.some((entry) => entry.name === "default_app.asar")),
    hasApp: Boolean(inner?.some((entry) => entry.name === "app" && entry.isDirectory())),
  };
}

/**
 * Case- and separator-insensitive key for "is this the same directory".
 *
 * Windows paths compare case-insensitively, and a scan must not descend into
 * this plugin's own tree (its runtime is handled by the installer, not borrowed).
 *
 * @param {string} dir
 * @returns {string}
 */
function keyOf(dir) {
  const unified = String(dir).replace(/\\/g, "/");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/**
 * Every Electron runtime under DSH's home that this plugin could borrow.
 *
 * The walk stops at the first directory that looks like a runtime: descending
 * into an extracted Electron tree would list tens of thousands of files for no
 * gain.
 *
 * @param {{ home?: string, platform?: string, depth?: number, skip?: string[] }} [options]
 * @returns {Promise<Array<{ root: string, binary: string, electronVersion: string, hasDefaultApp: boolean, hasApp: boolean }>>}
 */
export async function scanBorrowedRuntimes(options = {}) {
  const home = options.home;
  if (typeof home !== "string" || home.trim() === "") return [];
  const platform = options.platform ?? process.platform;
  const depth = Number.isInteger(options.depth) && options.depth >= 0 ? options.depth : BORROW_SCAN_DEPTH;
  const skip = new Set((options.skip ?? []).filter((dir) => typeof dir === "string" && dir).map(keyOf));

  /** @type {Array<{ root: string, binary: string, electronVersion: string, hasDefaultApp: boolean, hasApp: boolean }>} */
  const found = [];
  const seen = new Set();
  /** @type {Array<{ dir: string, level: number }>} */
  const queue = [{ dir: home, level: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    const key = keyOf(current.dir);
    if (seen.has(key) || skip.has(key)) continue;
    seen.add(key);

    const probe = await inspectBorrowed(current.dir, platform);
    if (probe) {
      found.push(probe);
      continue;
    }
    if (current.level >= depth) continue;

    const entries = await list(current.dir);
    if (!entries) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      queue.push({ dir: join(current.dir, entry.name), level: current.level + 1 });
    }
  }

  // Newest first: a runtime closer to the pinned version is the better borrow.
  return found.sort((a, b) => {
    if (a.electronVersion !== b.electronVersion) return a.electronVersion < b.electronVersion ? 1 : -1;
    return a.root.localeCompare(b.root);
  });
}
