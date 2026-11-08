/**
 * The 数据目录 group: where the folder lives, how big it is, and how the row
 * catches up after something else on the page moved bytes around.
 *
 * Its own file because the size row has to notice that something else changed
 * the directory — a clear pressed inside the group, or a component installed
 * from the group below.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { collect, textOf, byClass, page, renderSettings } from "./support/settings-harness.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const chipLabelled = (tree, key) => collect(tree, byClass("se-set-chip")).find((chip) => textOf(chip) === key);

const componentGroup = (tree) =>
  collect(tree, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupComponent"));

const CANDIDATE = { root: "C:/Users/me/.dsh/dsh-orb/electron-runtime", electronVersion: "44.0.0", hasDefaultApp: true };

/** The 数据目录 group, wherever it sits on the page. */
const dataGroup = (tree) => collect(tree, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupData"));

test("数据目录 offers 还原至默认位置 only when there is a default to go back to", async () => {
  const away = await renderSettings({
    dataDirInfo: {
      current: "D:/se",
      recorded: "D:/se",
      defaultDir: "C:/Users/me/.dsh-session-navigator",
      atDefault: false,
      restorable: true,
      fromEnv: false,
      exists: true,
      sizeBytes: 2048,
      contents: [],
    },
  });
  // Order matters: the restore sits in front of 更改位置, because it is the
  // cheaper action and the one a user who moved the directory wants most.
  assert.deepEqual(collect(dataGroup(away.tree), byClass("se-set-chip")).map(textOf), [
    "setDataDirRestore",
    "setDataDirChange",
    "setCacheGo",
  ]);

  // Already home: nothing to restore.
  const home = await renderSettings({
    dataDirInfo: {
      current: "C:/Users/me/.dsh-session-navigator",
      recorded: "C:/Users/me/.dsh-session-navigator",
      defaultDir: "C:/Users/me/.dsh-session-navigator",
      atDefault: true,
      restorable: false,
      fromEnv: false,
      exists: true,
      sizeBytes: 2048,
      contents: [],
    },
  });
  assert.deepEqual(collect(dataGroup(home.tree), byClass("se-set-chip")).map(textOf), [
    "setDataDirChange",
    "setCacheGo",
  ]);

  // Pinned by the environment: the button would be undone on the next start.
  const pinned = await renderSettings({
    dataDirInfo: {
      current: "D:/se",
      recorded: "D:/se",
      defaultDir: "C:/Users/me/.dsh-session-navigator",
      atDefault: false,
      restorable: false,
      fromEnv: true,
      exists: true,
      sizeBytes: 2048,
      contents: [],
    },
  });
  assert.deepEqual(collect(dataGroup(pinned.tree), byClass("se-set-chip")).map(textOf), [
    "setDataDirChange",
    "setCacheGo",
  ]);
});

test("还原至默认位置 inspects the default folder and confirms it as a restore", async () => {
  const info = {
    current: "D:/se",
    recorded: "D:/se",
    defaultDir: "C:/Users/me/.dsh-session-navigator",
    atDefault: false,
    restorable: true,
    fromEnv: false,
    exists: true,
    sizeBytes: 2048,
    contents: [],
  };
  const { tree, calls, driver, api, t } = await renderSettings({ dataDirInfo: info });

  chipLabelled(tree, "setDataDirRestore").props.onClick();
  await tick();
  // The client never builds a home path of its own; it asks the host to inspect
  // the one the host named.
  const inspect = calls.find((call) => call.method === "POST" && call.url.endsWith("/datadir/inspect"));
  assert.deepEqual(inspect.body, { target: info.defaultDir });

  const planned = await driver.settle(() => page(driver, api, t));
  const group = dataGroup(planned);
  assert.match(textOf(group), /setDataDirRestoreConfirm/, "coming home is a restore, not a migration");
  assert.ok(textOf(group).includes(info.defaultDir), "the confirmation names the folder");

  chipLabelled(group, "setDataDirRestoreGo").props.onClick();
  await tick();
  const migrate = calls.find((call) => call.method === "POST" && call.url.endsWith("/datadir/migrate"));
  assert.deepEqual(migrate.body, { target: info.defaultDir, mode: "move" });

  const done = await driver.settle(() => page(driver, api, t));
  assert.match(textOf(dataGroup(done)), /setDataDirRestored/, "the note says restored, not moved");
  // The row catches up with the host: the button is gone and the path is home.
  assert.equal(chipLabelled(dataGroup(done), "setDataDirRestore"), undefined);
});

/** How many times the page has asked the host for the directory's size. */
const sizeReads = (calls) => calls.filter((call) => call.method === "GET" && /\/datadir$/.test(call.url)).length;

/** The number the 占用大小 row is printing right now. */
const sizeText = (tree) => textOf(collect(dataGroup(tree), byClass("se-set-path"))[1] ?? { children: "" });

test("占用大小 follows 清理缓存 instead of keeping the number from mount", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    dataDirInfo: {
      current: "D:/se",
      recorded: "D:/se",
      defaultDir: "D:/se",
      atDefault: true,
      restorable: false,
      fromEnv: false,
      exists: true,
      sizeBytes: 9_000_000,
      contents: [],
    },
    clear: {
      freedBytes: 4_000_000,
      caches: ["sessions"],
      tmp: { removed: 1, bytes: 4_000_000 },
      downloads: { removed: 0, bytes: 0 },
      staging: { removed: 0, bytes: 0 },
      manifest: { removed: 1, bytes: 0 },
      skipped: [],
      tookMs: 3,
    },
  });
  // One read on mount. The clear below the size row is what makes it read again:
  // the button sits in this group, so the refresh is a plain call, not a token.
  assert.equal(sizeReads(calls), 1);
  const before = sizeText(tree);

  chipLabelled(tree, "setCacheGo").props.onClick();
  await tick();

  const after = await driver.settle(() => page(driver, api, t));
  assert.equal(sizeReads(calls), 2, "the clear is news to the size row, so it re-reads");
  assert.notEqual(sizeText(after), before, "and the row stops printing the pre-clear number");
});

test("安装 and 卸载组件 both refresh 占用大小", async () => {
  const info = {
    current: "D:/se",
    recorded: "D:/se",
    defaultDir: "D:/se",
    atDefault: true,
    restorable: false,
    fromEnv: false,
    exists: true,
    sizeBytes: 2048,
    contents: [],
  };
  const borrowed = await renderSettings({ component: "absent", dataDirInfo: info, scan: { candidates: [CANDIDATE] } });
  assert.equal(sizeReads(borrowed.calls), 1);
  // A runtime arriving (~150 MB inside the data directory) and one leaving are
  // both news to the size row. 借用 is used for the arrival because the stub
  // leaves a plain install forever in `downloading`, and a poll that never ends
  // keeps this test file alive.
  collect(componentGroup(borrowed.tree), byClass("se-set-chip"))
    .find((chip) => textOf(chip) === "setCompScan")
    .props.onClick();
  await tick();
  const scanned = await borrowed.driver.settle(() => page(borrowed.driver, borrowed.api, borrowed.t));
  collect(componentGroup(scanned), byClass("se-set-chip"))
    .find((chip) => textOf(chip) === "setCompBorrow")
    .props.onClick();
  await tick();
  await borrowed.driver.settle(() => page(borrowed.driver, borrowed.api, borrowed.t));
  assert.equal(sizeReads(borrowed.calls), 2, "install");

  const ready = await renderSettings({
    componentInfo: { phase: "ready", version: "1.0.0", installed: true, sizeBytes: 150_000_000 },
    dataDirInfo: info,
  });
  collect(componentGroup(ready.tree), byClass("se-set-chip"))
    .find((chip) => textOf(chip) === "setCompRemove")
    .props.onClick();
  await tick();
  await ready.driver.settle(() => page(ready.driver, ready.api, ready.t));
  assert.equal(sizeReads(ready.calls), 2, "remove");
});
