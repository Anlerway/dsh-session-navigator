import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStorageWatch } from "../lib/host/storage-watch.js";

/** A fake bridge that records what the watch publishes. */
function fakeBridge(listeners) {
  const published = [];
  return {
    listeners,
    published,
    publish(kind, payload) {
      published.push({ kind, payload });
    },
  };
}

async function home(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "snap-watch-"));
  const storages = join(dir, "storages");
  await mkdir(storages, { recursive: true });
  if (options.file !== false) await writeFile(join(storages, "workspace.json"), "{\"version\":2}\n");
  return dir;
}

/** The module reads its baseline asynchronously; give that one microtask turn. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("the first read is a baseline, never a notification", async () => {
  const dshHome = await home();
  const bridge = fakeBridge(1);
  const watch = createStorageWatch({ dshHome, bridge, intervalMs: 1_000_000 });
  await settle();
  watch.dispose();
  const result = await watch.check();
  assert.equal(result.changed, false);
  assert.equal(bridge.published.length, 0);
  await rm(dshHome, { recursive: true, force: true });
});

test("a rewritten workspace file is reported once", async () => {
  const dshHome = await home();
  const bridge = fakeBridge(1);
  const watch = createStorageWatch({
    dshHome,
    bridge,
    intervalMs: 1_000_000,
    runningIds: () => new Set(["s1", "s2"]),
  });
  await settle();
  const first = await watch.check();
  assert.equal(first.changed, false, "nothing moved yet");

  await writeFile(join(dshHome, "storages", "workspace.json"), "{\"version\":2,\"archived\":[]}\n");
  const second = await watch.check();
  watch.dispose();

  assert.equal(second.changed, true);
  assert.equal(second.published, true);
  assert.equal(second.reason, "workspace");
  assert.equal(bridge.published.length, 1);
  assert.equal(bridge.published[0].kind, "sessions-changed");
  assert.deepEqual(bridge.published[0].payload.reason, "workspace");
  assert.equal(bridge.published[0].payload.refresh, true);
  assert.equal(bridge.published[0].payload.structural, false);
  assert.deepEqual(bridge.published[0].payload.running, ["s1", "s2"]);

  const third = await watch.check();
  assert.equal(third.changed, false, "an unchanged file stays quiet");
  assert.equal(bridge.published.length, 1);
  await rm(dshHome, { recursive: true, force: true });
});

test("no listener means no queued event", async () => {
  const dshHome = await home();
  const bridge = fakeBridge(0);
  const watch = createStorageWatch({ dshHome, bridge, intervalMs: 1_000_000 });
  await settle();
  await watch.check();
  await writeFile(join(dshHome, "storages", "workspace.json"), "{\"version\":2,\"moved\":1}\n");
  const result = await watch.check();
  watch.dispose();
  assert.equal(result.changed, true, "the change is still detected");
  assert.equal(result.published, false, "but nothing is pushed at a closed panel");
  assert.equal(bridge.published.length, 0);
  await rm(dshHome, { recursive: true, force: true });
});

test("a missing workspace file is a stable state", async () => {
  const dshHome = await home({ file: false });
  const bridge = fakeBridge(1);
  const watch = createStorageWatch({ dshHome, bridge, intervalMs: 1_000_000 });
  await settle();
  const first = await watch.check();
  const second = await watch.check();
  watch.dispose();
  assert.equal(first.changed, false);
  assert.equal(second.changed, false);
  assert.equal(bridge.published.length, 0);
  await rm(dshHome, { recursive: true, force: true });
});

test("creating the file later counts as a change", async () => {
  const dshHome = await home({ file: false });
  const bridge = fakeBridge(1);
  const watch = createStorageWatch({ dshHome, bridge, intervalMs: 1_000_000 });
  await settle();
  await watch.check();
  await writeFile(join(dshHome, "storages", "workspace.json"), "{\"version\":2}\n");
  const result = await watch.check();
  watch.dispose();
  assert.equal(result.changed, true);
  assert.equal(bridge.published.length, 1);
  await rm(dshHome, { recursive: true, force: true });
});

test("a throwing running set still publishes, with an empty set", async () => {
  const dshHome = await home();
  const bridge = fakeBridge(1);
  const watch = createStorageWatch({
    dshHome,
    bridge,
    intervalMs: 1_000_000,
    runningIds: () => {
      throw new Error("registry gone");
    },
  });
  await settle();
  await watch.check();
  await writeFile(join(dshHome, "storages", "workspace.json"), "{\"version\":2,\"x\":2}\n");
  const result = await watch.check();
  watch.dispose();
  assert.equal(result.published, true);
  assert.deepEqual(bridge.published[0].payload.running, []);
  await rm(dshHome, { recursive: true, force: true });
});

test("dispose stops the ticks", async () => {
  const dshHome = await home();
  const bridge = fakeBridge(1);
  const watch = createStorageWatch({ dshHome, bridge, intervalMs: 5 });
  await settle();
  watch.dispose();
  assert.equal(watch.disposed, true);
  await writeFile(join(dshHome, "storages", "workspace.json"), "{\"version\":2,\"y\":3}\n");
  const result = await watch.check();
  assert.equal(result.changed, false);
  assert.equal(bridge.published.length, 0);
  await rm(dshHome, { recursive: true, force: true });
});
