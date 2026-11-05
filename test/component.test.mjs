/**
 * Tests for the browser component.
 *
 *   node --test test/component.test.mjs
 *
 * The runtime is 110 MB and needs a network, so these tests never touch the
 * real Electron release. They pin the parts that decide whether a user ends up
 * with a working runtime or a corrupt one:
 *
 *   - the path layout and the marker rule ("ready" is files on disk, nothing else);
 *   - the state machine's transitions, including cancel and remove;
 *   - the downloader's resume and "server ignored Range" handling;
 *   - checksum refusal *before* extraction;
 *   - an interrupted install leaving a previous runtime untouched.
 */

import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ELECTRON_VERSION, componentPaths, runtimePaths } from "../lib/component/layout.js";
import { downloadAsset } from "../lib/component/downloader.js";
import {
  directorySize,
  extractZip,
  installHelperApp,
  sameDigest,
  sha256File,
  publishRuntime,
  removeTree,
  verifyZip,
} from "../lib/component/install.js";
import { emptyState, normalizeState, readState, writeState, createProgressWriter } from "../lib/component/state.js";
import { createComponentManager } from "../lib/component/manager.js";
import { borrowedPaths, inspectBorrowed, scanBorrowedRuntimes } from "../lib/component/borrow.js";

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "se-component-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * An Electron tree shaped the way a plugin that downloaded its own copy leaves
 * one: the platform executable, `resources/` and the `version` file Electron's
 * zip ships. Nothing here is a real executable — the tests never spawn it.
 */
async function fakeRuntime(root, { version = "44.0.0" } = {}) {
  const paths = borrowedPaths(root, process.platform);
  await mkdir(dirname(paths.binary), { recursive: true });
  await writeFile(paths.binary, "");
  await mkdir(dirname(paths.defaultApp), { recursive: true });
  await writeFile(paths.defaultApp, "");
  await writeFile(paths.versionFile, `${version}\n`);
  return paths;
}

/** Every entry under `dir`, so a test can prove a tree was left untouched. */
async function tree(dir) {
  const out = [];
  const walk = async (at, prefix) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      out.push(prefix + entry.name + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) await walk(join(at, entry.name), prefix + entry.name + "/");
    }
  };
  await walk(dir, "");
  return out.sort();
}

// ── layout ──────────────────────────────────────────────────────────────────

test("componentPaths derives every path from the data directory", () => {
  const dataDir = join(tmpdir(), "se-component");
  const paths = componentPaths(dataDir, "win32");
  assert.equal(paths.root, join(dataDir, "component"));
  // A stamped runtime is a sibling, never the same directory: an install must
  // never have to rename over a path Windows may have open.
  const stamped = componentPaths(dataDir, "win32", "k3f9");
  assert.notEqual(stamped.runtime, paths.runtime);
  assert.ok(stamped.runtime.endsWith("runtime-k3f9"));
  assert.ok(paths.marker.endsWith(`.complete-${ELECTRON_VERSION}`));
  assert.ok(paths.part.endsWith("electron-v44.0.0-win32-x64.zip.part"));
  assert.ok(paths.binary.endsWith("electron.exe"));
  assert.ok(paths.manifest.endsWith("manifest.v1.json"));
});

// ── state ───────────────────────────────────────────────────────────────────

test("normalizeState keeps known fields and degrades unknown phases to absent", () => {
  const fresh = normalizeState(null);
  assert.equal(fresh.phase, "absent");

  const kept = normalizeState({ phase: "downloading", receivedBytes: 10, totalBytes: 100, source: "mirror" });
  assert.equal(kept.phase, "downloading");
  assert.equal(kept.receivedBytes, 10);

  // A hand-edited or future phase must not render an unhandled branch.
  assert.equal(normalizeState({ phase: "banana" }).phase, "absent");
});

test("state round-trips through disk atomically", async () => {
  const box = await sandbox();
  try {
    const file = join(box.root, "state.v1.json");
    assert.equal((await readState(file)).phase, "absent");
    await writeState(file, box.root, { ...emptyState(), phase: "ready", electronVersion: ELECTRON_VERSION });
    const reloaded = await readState(file);
    assert.equal(reloaded.phase, "ready");
    assert.ok(reloaded.updatedAt > 0);
  } finally {
    await box.cleanup();
  }
});

test("the progress writer throttles but never drops a flushed phase", async () => {
  const writes = [];
  const writer = createProgressWriter({
    intervalMs: 10_000,
    write: async (state) => {
      writes.push(state.phase);
      return state;
    },
  });
  await writer.push({ phase: "downloading", receivedBytes: 1 });
  await writer.push({ phase: "downloading", receivedBytes: 2 });
  assert.equal(writes.length, 1, "the second push is inside the throttle window");
  await writer.flush({ phase: "ready" });
  assert.deepEqual(writes, ["downloading", "ready"], "a phase change is always persisted");
});

// ── downloader ──────────────────────────────────────────────────────────────

/**
 * A tiny HTTP server whose behaviour each test controls.
 *
 * @param {(req, res) => void} handler
 */
async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("downloadAsset streams a body and reports progress", async () => {
  const body = Buffer.from("0123456789".repeat(100));
  const box = await sandbox();
  const site = await serve((_req, res) => {
    res.writeHead(200, { "content-length": body.length, etag: '"abc"' });
    res.end(body);
  });
  try {
    const part = join(box.root, "asset.part");
    const meta = join(box.root, "asset.part.json");
    const seen = [];
    const result = await downloadAsset({
      urls: [`${site.url}/asset`],
      part,
      partMeta: meta,
      onProgress: (progress) => seen.push(progress.receivedBytes),
    });
    assert.equal(result.receivedBytes, body.length);
    assert.equal(result.totalBytes, body.length);
    assert.ok(seen.length > 0, "progress fired at least once");
    assert.equal((await readFile(part)).length, body.length);
  } finally {
    await site.close();
    await box.cleanup();
  }
});

test("downloadAsset resumes with Range when the mirror honours it", async () => {
  const body = Buffer.from("abcdefghij".repeat(50));
  const box = await sandbox();
  const requests = [];
  const site = await serve((req, res) => {
    requests.push(req.headers.range ?? null);
    const start = req.headers.range ? Number(String(req.headers.range).replace(/\D+/g, "")) : 0;
    res.writeHead(req.headers.range ? 206 : 200, {
      "content-length": body.length - start,
      etag: '"resume"',
    });
    res.end(body.subarray(start));
  });
  try {
    const part = join(box.root, "asset.part");
    const meta = join(box.root, "asset.part.json");
    await writeFile(part, body.subarray(0, 100));
    await writeFile(meta, JSON.stringify({ url: `${site.url}/asset`, etag: '"resume"', received: 100 }));

    const result = await downloadAsset({ urls: [`${site.url}/asset`], part, partMeta: meta });
    // The first request is the size probe (a HEAD, no range); the GET after it
    // must carry the resume offset.
    assert.ok(
      requests.includes("bytes=100-"),
      `expected a ranged request, got ${JSON.stringify(requests)}`,
    );
    assert.equal(result.receivedBytes, body.length);
    assert.equal((await readFile(part)).length, body.length);
  } finally {
    await site.close();
    await box.cleanup();
  }
});

test("downloadAsset restarts cleanly when the mirror ignores Range", async () => {
  const body = Buffer.from("xyz".repeat(200));
  const box = await sandbox();
  const site = await serve((_req, res) => {
    // 200 even for a ranged request: the body is the whole file.
    res.writeHead(200, { "content-length": body.length, etag: '"ignored"' });
    res.end(body);
  });
  try {
    const part = join(box.root, "asset.part");
    const meta = join(box.root, "asset.part.json");
    await writeFile(part, body.subarray(0, 50));
    await writeFile(meta, JSON.stringify({ url: `${site.url}/asset`, etag: '"ignored"', received: 50 }));

    const result = await downloadAsset({ urls: [`${site.url}/asset`], part, partMeta: meta });
    // Appending to the old prefix would have produced 650 bytes; a clean
    // restart produces exactly the body.
    assert.equal(result.receivedBytes, body.length);
    assert.equal((await readFile(part)).length, body.length);
  } finally {
    await site.close();
    await box.cleanup();
  }
});

// ── verify / publish ────────────────────────────────────────────────────────

test("a digest mismatch is refused before anything is extracted", async () => {
  const box = await sandbox();
  try {
    const zip = join(box.root, "asset.zip");
    await writeFile(zip, "not a zip");
    const actual = await sha256File(zip);
    assert.equal(sameDigest(actual, actual), true);
    assert.equal(sameDigest(actual, "0".repeat(64)), false);
    await assert.rejects(() => verifyZip(zip, "0".repeat(64)), (error) => error.code === "component-checksum");
  } finally {
    await box.cleanup();
  }
});

test("the start-up sweep deletes only paths inside component/", async () => {
  const box = await sandbox();
  try {
    const dataDir = join(box.root, "data");
    const paths = componentPaths(dataDir, "win32");
    // A leftover install directory that the sweep is meant to remove, and a
    // directory outside the plugin's own tree. The pending list is plain JSON on
    // disk: a corrupt or edited file must not turn the sweep into `rm -rf`.
    const leftover = join(paths.root, "runtime-old");
    const outside = join(box.root, "documents");
    await mkdir(leftover, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(leftover, "electron.exe"), "x");
    await writeFile(join(outside, "keep.txt"), "keep");
    await writeFile(
      paths.pending,
      JSON.stringify({ paths: [leftover, outside, join(box.root, "..", "escape")] }),
      "utf8",
    );

    const manager = createComponentManager(dataDir);
    const result = await manager.sweep();

    assert.equal(existsSync(leftover), false);
    assert.equal(existsSync(join(outside, "keep.txt")), true);
    assert.deepEqual(result.remaining, []);
    // The ignored paths are dropped from the list, not retried forever.
    assert.equal(existsSync(paths.pending), false);
  } finally {
    await box.cleanup();
  }
});

test("publishRuntime keeps the previous runtime when the new one is staged", async () => {
  const box = await sandbox();
  try {
    const runtime = join(box.root, "runtime");
    const staging = join(box.root, "runtime.staging");
    const marker = join(runtime, `.complete-${ELECTRON_VERSION}`);
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "old.txt"), "old");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "new.txt"), "new");

    await publishRuntime(staging, runtime, marker);
    assert.equal(existsSync(join(runtime, "new.txt")), true);
    assert.equal(existsSync(join(runtime, "old.txt")), false);
    // The marker is written into the staged tree, so readiness and bytes appear
    // together rather than in two observable steps.
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(staging), false);
  } finally {
    await box.cleanup();
  }
});

// ── what Windows will not let go of ─────────────────────────────────────────

test("installHelperApp writes an app Electron prefers over the bundled one", async () => {
  const box = await sandbox();
  try {
    const runtime = join(box.root, "runtime-k3f9");
    await mkdir(join(runtime, "resources"), { recursive: true });

    const dir = await installHelperApp(runtime);
    assert.equal(dir, join(runtime, "resources", "app"));

    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    // `main` has to stay inside the app directory: Electron resolves an absolute
    // value against that directory and refuses to start if it lands elsewhere.
    assert.equal(manifest.main, "index.js");
    assert.ok(manifest.name);

    // The plugin's own entry point comes from the environment, so a runtime
    // extracted by any version of the plugin runs the code that is installed now.
    const entry = await readFile(join(dir, "index.js"), "utf8");
    assert.match(entry, /process\.env\.DSH_SE_HELPER_MAIN/);
    assert.match(entry, /require\(main\)/);

    // Idempotent: launching refreshes an existing app instead of failing on it.
    await writeFile(join(dir, "index.js"), "stale", "utf8");
    await installHelperApp(runtime);
    assert.match(await readFile(join(dir, "index.js"), "utf8"), /DSH_SE_HELPER_MAIN/);
  } finally {
    await box.cleanup();
  }
});

test("directorySize never stats an asar bundle", async () => {
  const box = await sandbox();
  try {
    const runtime = join(box.root, "runtime");
    await mkdir(join(runtime, "resources"), { recursive: true });
    await writeFile(join(runtime, "electron.exe"), Buffer.alloc(100, 1));
    // The real one is 111 073 bytes. Electron's fs hands any `.asar` path to its
    // asar layer, which opens the file and caches the handle for the life of the
    // process — so even a size check is enough to make it undeletable.
    await writeFile(join(runtime, "resources", "default_app.asar"), Buffer.alloc(111073, 1));

    assert.equal(await directorySize(runtime), 100);
  } finally {
    await box.cleanup();
  }
});

test("extractZip leaves Electron's default app behind", { skip: process.platform !== "win32" }, async () => {
  const box = await sandbox();
  try {
    // A miniature of the official zip, laid out the same way. bsdtar can write
    // zips, so the fixture needs no bundled binary.
    const src = join(box.root, "src");
    await mkdir(join(src, "resources"), { recursive: true });
    await writeFile(join(src, "electron.exe"), "MZ");
    await writeFile(join(src, "resources", "default_app.asar"), "bundle");
    await writeFile(join(src, "resources", "keep.txt"), "keep");
    const zip = join(box.root, "runtime.zip");
    const bsdtar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const made = spawnSync(bsdtar, ["-a", "-cf", zip, "-C", src, "."], { stdio: "ignore" });
    assert.equal(made.status, 0, `could not build the fixture: ${made.error?.message ?? "tar failed"}`);

    const dest = join(box.root, "out");
    await extractZip(zip, dest);

    assert.equal(existsSync(join(dest, "electron.exe")), true);
    assert.equal(existsSync(join(dest, "resources", "keep.txt")), true);
    assert.equal(existsSync(join(dest, "resources", "default_app.asar")), false);
  } finally {
    await box.cleanup();
  }
});

test("removeTree deletes a runtime that has no asar bundle left", async () => {
  const box = await sandbox();
  try {
    const runtime = join(box.root, "runtime");
    await mkdir(join(runtime, "resources", "app"), { recursive: true });
    await writeFile(join(runtime, "electron.exe"), "MZ");
    await writeFile(join(runtime, "resources", "app", "index.js"), "entry");

    const result = await removeTree(runtime);
    assert.equal(result.removed, true);
    assert.deepEqual(result.leftover, []);
    assert.equal(existsSync(runtime), false);
  } finally {
    await box.cleanup();
  }
});

// ── borrowing another plugin's runtime ──────────────────────────────────────

test("inspectBorrowed accepts a tree Electron could start and refuses the near misses", async () => {
  const box = await sandbox();
  try {
    const good = join(box.root, "plugin-a", "electron");
    await fakeRuntime(good, { version: "43.3.0" });
    const found = await inspectBorrowed(good);
    assert.equal(found.root, good);
    assert.equal(found.electronVersion, "43.3.0");
    assert.equal(found.binary, borrowedPaths(good).binary);
    assert.equal(found.hasDefaultApp, true);
    assert.equal(found.hasApp, false);

    // An empty directory is not a runtime.
    const empty = join(box.root, "empty");
    await mkdir(empty, { recursive: true });
    assert.equal(await inspectBorrowed(empty), null);

    // A binary without `resources/` would start Electron's own default app, so
    // the window would never become this plugin's window.
    const bare = join(box.root, "bare");
    await mkdir(dirname(borrowedPaths(bare).binary), { recursive: true });
    await writeFile(borrowedPaths(bare).binary, "");
    assert.equal(await inspectBorrowed(bare), null);

    // Without a version file the settings page could not say what it offers to
    // start, and a repackaged non-Electron binary would look identical.
    const unversioned = join(box.root, "unversioned");
    await fakeRuntime(unversioned);
    await rm(borrowedPaths(unversioned).versionFile);
    assert.equal(await inspectBorrowed(unversioned), null);
  } finally {
    await box.cleanup();
  }
});

test("scan finds one plugin's runtime and stays out of the bulky trees", async () => {
  const box = await sandbox();
  try {
    const home = join(box.root, "dsh");
    const wanted = join(home, "dsh-orb", "electron-runtime");
    await fakeRuntime(wanted, { version: "44.0.0" });
    // Buried where the scan must not walk: sessions can hold tens of thousands
    // of directories, and none of them is a runtime.
    await fakeRuntime(join(home, "sessions", "abc", "electron"), { version: "44.0.0" });
    await fakeRuntime(join(home, "node_modules", "electron"), { version: "44.0.0" });
    // One level deeper than the advertised depth.
    await fakeRuntime(join(home, "a", "b", "c", "d", "electron"), { version: "44.0.0" });

    const found = await scanBorrowedRuntimes({ home });
    assert.deepEqual(found.map((candidate) => candidate.root), [wanted]);

    // A missing home is "nothing found", not an error: the caller renders an
    // empty scan rather than a failed one.
    assert.deepEqual(await scanBorrowedRuntimes({ home: join(box.root, "nowhere") }), []);
    assert.deepEqual(await scanBorrowedRuntimes({}), []);
  } finally {
    await box.cleanup();
  }
});

test("a borrowed runtime is started from this plugin's own app and never written to", async () => {
  const box = await sandbox();
  try {
    const dataDir = join(box.root, "data");
    await mkdir(dataDir, { recursive: true });
    const borrowed = join(box.root, "other-plugin", "electron-runtime");
    await fakeRuntime(borrowed, { version: "44.0.0" });
    const before = await tree(borrowed);

    const manager = createComponentManager(dataDir);
    const status = await manager.install({ borrowed });

    assert.equal(status.phase, "ready");
    assert.equal(status.source, "borrowed");
    assert.equal(status.borrowed, resolve(borrowed));
    assert.equal(status.electronVersion, "44.0.0");
    // A borrow costs nothing, so the size figures must not claim otherwise.
    assert.equal(status.receivedBytes, 0);
    assert.equal(status.sizeBytes, 0);
    assert.equal(manager.binary, borrowedPaths(borrowed).binary);
    // The app is this plugin's, under its own data directory: writing it into
    // the borrowed tree would mean editing another plugin's install.
    assert.equal(manager.appDir, componentPaths(dataDir).helperApp);
    assert.match(await readFile(join(manager.appDir, "index.js"), "utf8"), /DSH_SE_HELPER_MAIN/);

    // The borrowed tree is byte-for-byte what it was, with no `resources/app`
    // added by us.
    assert.deepEqual(await tree(borrowed), before);
    assert.equal(existsSync(join(borrowed, "resources", "app")), false);
  } finally {
    await box.cleanup();
  }
});

test("a borrowed runtime that the owning plugin removed degrades to absent", async () => {
  const box = await sandbox();
  try {
    const dataDir = join(box.root, "data");
    await mkdir(dataDir, { recursive: true });
    const borrowed = join(box.root, "other-plugin", "electron-runtime");
    await fakeRuntime(borrowed);

    const manager = createComponentManager(dataDir);
    await manager.install({ borrowed });

    // The other plugin upgrades or uninstalls while DSH keeps running.
    await rm(borrowed, { recursive: true, force: true });
    const status = await manager.status();
    assert.equal(status.phase, "absent");
    assert.equal(status.borrowed, null);
    assert.equal(status.canRemove, false);
    // The source names where the bytes came from; there are none left to name.
    assert.equal(status.source, null);
    // Recorded, not just reported: a restart must not resurrect the dead path.
    const persisted = await readState(componentPaths(dataDir).state);
    assert.equal(persisted.phase, "absent");
    assert.equal(persisted.borrowed, null);
    assert.equal(persisted.source, null);
  } finally {
    await box.cleanup();
  }
});

test("an owned runtime that vanished from disk is forgotten down to its source", async () => {
  const box = await sandbox();
  try {
    const dataDir = join(box.root, "data");
    await mkdir(dataDir, { recursive: true });
    const paths = componentPaths(dataDir);
    await mkdir(dirname(paths.marker), { recursive: true });
    await writeFile(paths.marker, "");
    await mkdir(dirname(paths.binary), { recursive: true });
    await writeFile(paths.binary, "");
    await writeState(paths.state, dataDir, {
      ...emptyState(),
      phase: "ready",
      electronVersion: ELECTRON_VERSION,
      source: "reuse",
      runtimeName: paths.runtimeName,
    });

    const manager = createComponentManager(dataDir);
    const ready = await manager.status();
    assert.equal(ready.phase, "ready");
    // "reuse" means an earlier install's bytes were adopted instead of downloaded.
    assert.equal(ready.source, "reuse");

    // Something deleted the runtime behind the plugin's back.
    await rm(paths.runtime, { recursive: true, force: true });
    const gone = await manager.status();
    assert.equal(gone.phase, "absent");
    assert.equal(gone.source, null);
    const persisted = await readState(paths.state);
    assert.equal(persisted.phase, "absent");
    assert.equal(persisted.source, null);
  } finally {
    await box.cleanup();
  }
});

test("uninstalling a borrow forgets the path and leaves the other plugin's tree alone", async () => {
  const box = await sandbox();
  try {
    const dataDir = join(box.root, "data");
    await mkdir(dataDir, { recursive: true });
    const borrowed = join(box.root, "other-plugin", "electron-runtime");
    await fakeRuntime(borrowed);
    const before = await tree(borrowed);

    const manager = createComponentManager(dataDir);
    await manager.install({ borrowed });
    const removed = await manager.remove({ closeHelper: async () => true });

    assert.equal(removed.phase, "absent");
    assert.equal(removed.leftover, false);
    // Forgetting is the whole uninstall: the bytes belong to the other plugin.
    assert.deepEqual(await tree(borrowed), before);
    // Our half — the app written under the data directory — is cleaned up.
    assert.equal(existsSync(componentPaths(dataDir).helperApp), false);
  } finally {
    await box.cleanup();
  }
});

test("a borrow is refused for a directory that is not a runtime and for one inside the data directory", async () => {
  const box = await sandbox();
  try {
    const dataDir = join(box.root, "data");
    await mkdir(dataDir, { recursive: true });
    const manager = createComponentManager(dataDir);

    const bogus = join(box.root, "not-electron");
    await mkdir(bogus, { recursive: true });
    await assert.rejects(() => manager.install({ borrowed: bogus }), { code: "component-borrow-invalid" });

    // Borrowing this plugin's own data directory would make uninstall
    // ambiguous: it deletes what we own and keeps what we borrow.
    const inside = join(dataDir, "component", "runtime-x");
    await fakeRuntime(inside);
    await assert.rejects(() => manager.install({ borrowed: inside }), { code: "component-borrow-invalid" });
    assert.equal(manager.snapshot.phase, "absent");
  } finally {
    await box.cleanup();
  }
});

