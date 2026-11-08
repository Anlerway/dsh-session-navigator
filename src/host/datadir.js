/**
 * dsh-session-navigator — data-directory inspection and migration.
 *
 * The plugin's own state lives outside `~/.dsh` (see src/paths.js), and a user
 * may want it on another disk. Moving it is the one operation that can lose
 * every folder, tag and trashed session at once, so it is written as an explicit
 * seven-step transaction (实现粗规划.md §5.5):
 *
 *   1. inspect   — absolute path, not a root, not the current directory, writable,
 *                  and not already holding another installation's tree
 *   2. plan      — same volume means `rename`, different volume means copy
 *   3. stop      — every other write route answers `migration-in-progress`
 *   4. carry     — tree, annotations, settings first (small), trash last (large)
 *   5. settle    — the new directory records `dataDir.current` in its own
 *                  settings document; the old one gets a `.location` pointer
 *   6. finish    — `move` deletes the old directory, `copy` keeps it
 *   7. roll back — any failure removes what was copied into the new directory
 *                  and leaves the old one untouched
 *
 * The rule that matters most: **the old directory is never deleted before the
 * new one is complete and recorded**. A crash at any point leaves a readable
 * data directory behind, at worst the old one.
 */

import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, parse, resolve } from "node:path";

import { LOCATION_FILE, defaultDataDir, samePath } from "../paths.js";
import { codedError } from "../store/sidecar.js";

/** Sidecars carried over first: they are small and describe everything else. */
const SMALL_FILES = ["tree.v1.json", "annotations.v1.json", "settings.v1.json"];

/** Large directory carried over last. */
const TRASH_DIR = "trash";

/** Files whose presence means "this directory is already in use". */
const OCCUPANCY_MARKERS = ["tree.v1.json", join("trash", "index.v1.json")];

/**
 * The environment whose home directory decides the default location.
 *
 * Production passes nothing and gets `process.env`; tests hand the api a fake
 * environment so a restore never consults the real home directory.
 *
 * @param {any} api
 * @returns {NodeJS.ProcessEnv}
 */
function envOf(api) {
  return api?.env ?? process.env;
}


/**
 * Is this path a filesystem root (`/` or `C:\\`)? A migration to a root would
 * make a later "clear the trash" catastrophic.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isRoot(path) {
  const parsed = parse(resolve(path));
  return parsed.root === resolve(path) || parsed.base === "";
}

/**
 * Whether the nearest existing ancestor of `path` is writable.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function writable(path) {
  let current = resolve(path);
  for (let hop = 0; hop < 64; hop += 1) {
    try {
      await access(current, fsConstants.W_OK);
      return true;
    } catch {
      const parent = parse(current).dir;
      if (!parent || parent === current) return false;
      current = parent;
    }
  }
  return false;
}

/**
 * Total bytes of a directory tree, ignoring anything unreadable.
 *
 * @param {string} dir
 * @returns {Promise<number>}
 */
async function sizeOf(dir) {
  let total = 0;
  /** @type {string[]} */
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sizeOf(child);
      continue;
    }
    try {
      total += (await stat(child)).size;
    } catch {
      /* a file that vanished mid-scan contributes nothing */
    }
  }
  return total;
}

/**
 * Inspect a candidate directory without touching it.
 *
 * @param {{ dataDir: string }} api
 * @param {any} target
 * @returns {Promise<any>}
 */
export async function inspectDataDir(api, target) {
  if (typeof target !== "string" || target.trim() === "") {
    throw codedError("bad-request", "target must be a directory path");
  }
  const wanted = target.trim();
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(wanted)) {
    throw codedError("bad-request", "target must be an absolute path");
  }
  const resolved = resolve(wanted);
  const current = resolve(api.dataDir);
  const defaultDir = defaultDataDir(envOf(api));
  // A target that *is* the default location is a restore, and the default
  // location is allowed to hold the signpost a previous migration left there.
  const isDefault = samePath(resolved, defaultDir);

  if (isRoot(resolved)) {
    throw codedError("bad-request", "a filesystem root cannot be the data directory");
  }
  // The volume itself has to exist: `Z:/nope` is a typo, not a directory that
  // migration would create. A missing directory on a real volume is fine — the
  // carry step makes it.
  if (!existsSync(parse(resolved).root)) {
    throw codedError("bad-request", `${parse(resolved).root} does not exist`);
  }
  if (samePath(resolved, current)) {
    throw codedError("datadir-same", "the target is already the data directory");
  }

  const exists = existsSync(resolved);
  const occupied = OCCUPANCY_MARKERS.some((marker) => existsSync(join(resolved, marker)));
  if (exists && occupied) {
    throw codedError("datadir-not-empty", `${resolved} already holds a session-navigator data directory`);
  }
  // A migration copies *into* the target and rolls back by removing what it
  // wrote, so the target has to start empty: carrying into a directory that
  // already holds unrelated files would either merge two data sets or (before
  // this check) delete the user's files when the copy failed and rolled back.
  //
  // The default directory is the one exception, and only for its own signpost:
  // leaving for another disk keeps `.location` behind so the next start follows
  // it, and coming back must not be refused by the very file that made the
  // move possible. It is a pointer, not data, and the migration deletes it.
  const present = exists ? await readdir(resolved).catch(() => []) : [];
  const blocking = isDefault ? present.filter((name) => name !== LOCATION_FILE) : present;
  if (blocking.length > 0) {
    throw codedError(
      "datadir-not-empty",
      isDefault
        ? `${resolved} holds data from an earlier installation; clear it before restoring`
        : `${resolved} is not empty`,
    );
  }

  const writableNow = await writable(resolved);
  const sameVolume = parse(resolved).root.toLowerCase() === parse(current).root.toLowerCase();

  return {
    target: resolved,
    current,
    defaultDir,
    /** True when the target is the default location: this is a restore. */
    isDefault,
    exists,
    writable: writableNow,
    sameVolume,
    /** `move` is the only mode that deletes the old directory. */
    mode: sameVolume ? "move" : "copy",
    sizeBytes: exists ? await sizeOf(resolved) : 0,
    currentSizeBytes: await sizeOf(current),
  };
}

/**
 * Carry one directory into another.
 *
 * `cp` is used for both modes because it already recurses, preserves timestamps
 * and fails on a missing source; the difference between `move` and `copy` is
 * only whether the source is removed afterwards, and that happens after the new
 * location has been recorded.
 *
 * @param {string} from
 * @param {string} to
 * @returns {Promise<string[]>} the top-level names written, for rollback
 */
async function carry(from, to) {
  await mkdir(to, { recursive: true });
  const names = await readdir(from).catch(() => []);
  await cp(from, to, { recursive: true, force: true, errorOnExist: false });
  return names;
}

/**
 * Undo a partial migration.
 *
 * The target is empty when the migration starts, so whatever is in it was
 * written by `carry` — but only remove the entries that copy produced, and only
 * remove the directory itself when this migration created it. Rolling back must
 * never delete something the user put there.
 *
 * @param {string} destination
 * @param {string[]} copied
 * @param {boolean} existed
 */
async function rollbackCopy(destination, copied, existed) {
  if (!existed) {
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    return;
  }
  for (const name of copied) {
    await rm(join(destination, name), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Migrate the data directory.
 *
 * @param {any} api
 * @param {{ target?: any, mode?: any }} body
 * @returns {Promise<any>}
 */
export async function migrateDataDir(api, body) {
  const plan = await inspectDataDir(api, body?.target);
  // The plan decides: `move` only when both directories share a volume, because
  // otherwise removing the source would be a delete, not a move. A caller that
  // asks for the other mode would silently lose (or keep) the old directory.
  const mode = plan.mode;
  if (!plan.writable) {
    throw codedError("bad-request", `${plan.target} is not writable`);
  }

  const source = resolve(api.dataDir);
  const destination = plan.target;
  const steps = [];
  /** @type {string[]} */
  let copied = [];

  // Step 3: from here on, every other write route is refused, so the copy below
  // cannot race a sidecar write and produce a half-updated document.
  api.migration = { target: destination, startedAt: Date.now() };

  try {
    // Step 4: small documents first, then the trash.
    copied = await carry(source, destination);
    steps.push("copied");
    const sourceSize = await sizeOf(source);
    const copiedSize = await sizeOf(destination);
    if (copiedSize < sourceSize) {
      throw codedError("bad-request", `copy is incomplete: ${copiedSize} of ${sourceSize} bytes`);
    }
    steps.push("verified");

    // Step 5: the new directory records itself, then the host switches over.
    api.reopen?.(destination);
    steps.push("reopened");

    await api.documents.settings.mutate((draft) => {
      draft.dataDir = { ...(draft.dataDir ?? {}), current: destination };
    });
    steps.push("recorded");

    // A restore lands on a directory that still carries the signpost the move
    // away wrote, pointing at a place that is about to stop existing. The
    // settings document is what a start reads first, so the file is only
    // misleading — delete it and the directory stands on its own again.
    if (plan.isDefault) {
      await rm(join(destination, LOCATION_FILE), { force: true }).catch(() => {});
      steps.push("signpost-cleared");
    }

    // Step 6: the old directory points at the new one, and `move` then deletes it.
    //
    // The pointer is written in **both** modes, because the default directory is
    // also where the next start looks for `settings.v1.json`; deleting it
    // outright would erase the only record of where the data went.
    writeFileSync(
      join(source, LOCATION_FILE),
      JSON.stringify({ movedTo: destination, mode, at: Date.now() }, null, 2),
      "utf8",
    );
    steps.push("pointer");

    if (mode === "move") {
      if (samePath(source, defaultDataDir(envOf(api)))) {
        // Keep the default directory as a signpost: everything but the pointer
        // goes, so the next start follows it instead of starting empty.
        await pruneExcept(source, LOCATION_FILE);
        steps.push("pruned");
      } else {
        await rm(source, { recursive: true, force: true });
        steps.push("removed");
      }
    }

    return { target: destination, mode, steps, revision: (await api.documents.settings.read()).revision };
  } catch (error) {
    // Step 7: roll back. The old directory is never touched, so a failed
    // migration costs the copy and nothing else.
    api.reopen?.(source);
    api.documents.settings.invalidate();
    await rollbackCopy(destination, copied, plan.exists);
    throw error;
  } finally {
    api.migration = null;
  }
}

/**
 * Remove every entry of `dir` except `keep`.
 *
 * @param {string} dir
 * @param {string} keep
 */
async function pruneExcept(dir, keep) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === keep) continue;
    await rm(join(dir, entry.name), { recursive: true, force: true });
  }
}

/**
 * The current location and what the settings document records, for the page.
 *
 * @param {{ dataDir: string, documents: any }} api
 * @returns {Promise<any>}
 */
export async function describeDataDir(api) {
  const document = await api.documents.settings.read();
  const recorded = document?.dataDir?.current ?? null;
  const env = envOf(api);
  const defaultDir = defaultDataDir(env);
  const atDefault = samePath(api.dataDir, defaultDir);
  const fromEnv = typeof env?.DSH_SE_DATA_DIR === "string" && env.DSH_SE_DATA_DIR.trim() !== "";
  return {
    current: api.dataDir,
    recorded,
    defaultDir,
    atDefault,
    /** No chip when already home, and none when an env override pins the path. */
    restorable: !atDefault && !fromEnv,
    fromEnv,
    exists: existsSync(api.dataDir),
    sizeBytes: await sizeOf(api.dataDir),
    contents: await listContents(api.dataDir),
  };
}

/**
 * Top-level entries of the data directory, for the settings page summary.
 *
 * @param {string} dir
 * @returns {Promise<{ name: string, bytes: number, directory: boolean }[]>}
 */
async function listContents(dir) {
  /** @type {{ name: string, bytes: number, directory: boolean }[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push({ name: entry.name, bytes: await sizeOf(child), directory: true });
      continue;
    }
    let bytes = 0;
    try {
      bytes = (await stat(child)).size;
    } catch {
      /* vanished */
    }
    out.push({ name: entry.name, bytes, directory: false });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Read the `.location` pointer of a directory, if it has one.
 *
 * @param {string} dir
 * @returns {{ movedTo: string, mode?: string } | null}
 */
export function readLocation(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, LOCATION_FILE), "utf8"));
    if (typeof parsed?.movedTo !== "string") return null;
    return { movedTo: parsed.movedTo, mode: parsed.mode };
  } catch {
    return null;
  }
}
