/**
 * The settings page, rendered for real: one case per thing the page promises.
 *
 * The scaffolding lives in ./support/settings-harness.mjs; every case below
 * starts from renderSettings(), so a break in the page shows up as a failing
 * behaviour rather than a failing helper.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPOSE,
  makeReact,
  collect,
  textOf,
  byClass,
  settingsDocument,
  defaultCatalog,
  idleState,
  releaseNotes,
  page,
  interpolating,
  renderSettings,
} from "./support/settings-harness.mjs";
import { loadClientBundle, recordingFetch } from "./support/client-bundle.mjs";

test("打开方式 is the first group on the page, with 浮窗 selected", async () => {
  const { tree } = await renderSettings({ mode: "panel", component: "absent" });
  const groups = collect(tree, byClass("se-set-grp"));
  assert.ok(groups.length >= 3, "the page renders its groups");
  // The launch mode is the question the user has every time they press the
  // entry, so it sits above 列表 / 浮窗 / 浏览器组件.
  assert.match(textOf(groups[0]), /setGroupOpen/);

  const chips = collect(tree, byClass("se-set-chip"));
  const labels = chips.map(textOf);
  assert.deepEqual(labels.slice(0, 2), ["setOpenPanel", "setOpenDetached"]);
  assert.match(chips[0].props.className, /\bon\b/, "浮窗 is the selected chip");
  assert.doesNotMatch(chips[1].props.className, /\bon\b/);
  // Without the browser component the window cannot open, so the chip says so
  // instead of accepting a value the launch would have to walk back.
  assert.equal(chips[1].props.disabled, true);
  assert.equal(chips[1].props.title, "setOpenDetachedBlocked");
});

test("picking 独立弹窗 saves the mode and nothing else", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({ mode: "panel", component: "ready" });
  const chips = collect(tree, byClass("se-set-chip"));
  assert.equal(chips[1].props.disabled, false, "a ready component enables the window");

  chips[1].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const write = calls.find((call) => call.method === "PUT" && call.url.endsWith("/settings"));
  assert.ok(write, "the click writes immediately — there is no OK button");
  // A partial patch: the modal group must not be rewritten from the page's copy.
  assert.deepEqual(write.body, { shell: { open: { mode: "detached" } } });
  assert.equal(write.headers["if-match"], '"4"', "the write cites the revision it read");

  // The page then renders the saved value, so the chip is visibly the chosen one.
  const after = await driver.settle(() => page(driver, api, t));
  const chipsAfter = collect(after, byClass("se-set-chip"));
  assert.match(chipsAfter[1].props.className, /\bon\b/);
});

test("a document written before the setting existed shows 浮窗, not an empty group", async () => {
  const fetchImpl = recordingFetch(() => ({ ok: true, result: settingsDocument(undefined, "absent") }));
  const driver = makeReact();
  const { test: api } = loadClientBundle({ fetch: fetchImpl, expose: EXPOSE, react: driver.React });
  const t = (key) => key;
  const tree = await driver.settle(() => page(driver, api, t));
  const chips = collect(tree, byClass("se-set-chip"));
  assert.match(chips[0].props.className, /\bon\b/);
});

test("会话界面 offers 自动 and 仅显示图标, and saves the pick alone", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({ mode: "panel", component: "absent" });
  const groups = collect(tree, byClass("se-set-grp"));
  const header = groups.find((group) => textOf(group).includes("setGroupHeader"));
  assert.ok(header, "the group is on the page");

  const chips = collect(header, byClass("se-set-chip"));
  assert.deepEqual(chips.map(textOf), ["setHeaderAuto", "setHeaderIcon"]);
  assert.match(chips[0].props.className, /\bon\b/, "自动 is the default");

  chips[1].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const write = calls.find((call) => call.method === "PUT" && call.url.endsWith("/settings"));
  assert.ok(write, "the click writes immediately");
  // A patch of exactly this key: the launch mode and the modal group are not
  // echoed back from a page that may have been open for a while.
  assert.deepEqual(write.body, { shell: { header: { style: "icon" } } });

  const after = await driver.settle(() => page(driver, api, t));
  const afterHeader = collect(after, byClass("se-set-grp")).find((group) =>
    textOf(group).includes("setGroupHeader"),
  );
  const afterChips = collect(afterHeader, byClass("se-set-chip"));
  assert.match(afterChips[1].props.className, /\bon\b/, "仅显示图标 is now the chosen chip");
});

test("显示 offers 详细日期 / 距今时间 and 自动转换 / 固定 KB, each saved alone", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({ mode: "panel", component: "absent" });
  const groups = collect(tree, byClass("se-set-grp"));
  const display = groups.find((group) => textOf(group).includes("setGroupDisplay"));
  assert.ok(display, "the group is on the page");

  const chips = collect(display, byClass("se-set-chip"));
  assert.deepEqual(chips.map(textOf), ["setDateDetail", "setDateRelative", "setSizeAuto", "setSizeKb"]);
  assert.match(chips[0].props.className, /\bon\b/, "详细日期 is what the list always showed, so it stays the default");
  assert.match(chips[2].props.className, /\bon\b/, "自动转换 is the default too");

  chips[1].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const dateWrite = calls.find((call) => call.method === "PUT" && call.url.endsWith("/settings"));
  assert.ok(dateWrite, "the click writes immediately");
  // A patch of exactly this key: the page does not echo a document it read
  // minutes ago back over whatever the panel changed in the meantime.
  assert.deepEqual(dateWrite.body, { list: { dateFormat: "relative" } });

  const afterDate = await driver.settle(() => page(driver, api, t));
  const afterDateChips = collect(
    collect(afterDate, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupDisplay")),
    byClass("se-set-chip"),
  );
  assert.match(afterDateChips[1].props.className, /\bon\b/, "距今时间 is now the chosen chip");

  afterDateChips[3].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const sizeWrite = calls.filter((call) => call.method === "PUT").at(-1);
  assert.deepEqual(sizeWrite.body, { list: { sizeFormat: "kb" } });
});

/** The 关于 group. It is no longer the last one on the page — 危险操作 follows it,
 *  because the only irreversible control must not sit above anything — so find
 *  it by its heading instead of by position. */
const aboutGroup = (tree) => collect(tree, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupAbout"));

const chipLabelled = (tree, key) => collect(tree, byClass("se-set-chip")).find((chip) => textOf(chip) === key);

test("关于 prints the build it is running", async () => {
  const { tree } = await renderSettings();
  const about = aboutGroup(tree);
  assert.match(textOf(about), /setGroupAbout/);
  assert.equal(textOf(collect(about, byClass("se-set-ver"))[0]), "v1.0.0");
  // Five things to press, in the order the group explains them: the check, the
  // notes, the clear, and the two pages the project lives on.
  assert.deepEqual(
    collect(about, byClass("se-set-chip")).map(textOf),
    ["setCheckUpdate", "setNotesOpen", "setCacheGo", "setStarGo", "setIssueGo"],
  );
  // Nothing is asked of GitHub until the user presses the button: a settings
  // page that phones home on open is a settings page people remove.
  assert.equal(collect(about, byClass("se-set-err")).length, 0);
});

test("检查更新 asks the host once and reports the newer release", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    update: {
      current: "1.0.0",
      latest: "1.0.1",
      hasUpdate: true,
      url: "https://github.com/Anlerway/dsh-session-navigator/releases",
      name: "1.0.1",
      publishedAt: null,
      notes: "",
      checkedAt: 0,
    },
  });
  chipLabelled(tree, "setCheckUpdate").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const asked = calls.find((call) => call.method === "GET" && /\/update/.test(call.url));
  assert.ok(asked, "the check is a host request — api.github.com sends no CORS headers");
  // The first press uses the short-lived cache; only a second press forces.
  assert.doesNotMatch(asked.url, /force=1/);

  const after = await driver.settle(() => page(driver, api, t));
  assert.match(textOf(aboutGroup(after)), /setUpdateAvailable/);

  chipLabelled(after, "setDownload").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const opened = calls.find((call) => call.method === "POST" && call.url.endsWith("/about/open"));
  assert.ok(opened, "the browser is opened by the host, not by the page");
  // A named target, never a URL: the host owns the allowlist.
  assert.deepEqual(opened.body, { target: "releases" });
});

test("a second press of 检查更新 bypasses the cached answer", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    update: { current: "1.0.0", latest: "1.0.0", hasUpdate: false, url: "", name: "", publishedAt: null, notes: "", checkedAt: 0 },
  });
  chipLabelled(tree, "setCheckUpdate").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await driver.settle(() => page(driver, api, t));
  assert.match(textOf(aboutGroup(after)), /setUpdateLatest/);

  chipLabelled(after, "setCheckUpdate").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const checks = calls.filter((call) => call.method === "GET" && /\/update/.test(call.url));
  assert.equal(checks.length, 2);
  assert.match(checks[1].url, /force=1/);
});

test("a failed 检查更新 says so instead of claiming the build is current", async () => {
  const { tree, driver, api, t } = await renderSettings();
  chipLabelled(tree, "setCheckUpdate").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await driver.settle(() => page(driver, api, t));
  const text = textOf(aboutGroup(after));
  assert.match(text, /setUpdateFailed/);
  assert.doesNotMatch(text, /setUpdateLatest/);
});

test("清理缓存 reports what came back, and skips a download in flight", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    clear: {
      freedBytes: 1_500_000,
      caches: ["sessions", "log-facts"],
      tmp: { removed: 2, bytes: 1_500_000 },
      downloads: { removed: 0, bytes: 0 },
      staging: { removed: 0, bytes: 0 },
      skipped: ["component-busy"],
      tookMs: 4,
    },
  });
  chipLabelled(tree, "setCacheGo").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const cleared = calls.find((call) => call.method === "POST" && call.url.endsWith("/cache/clear"));
  assert.ok(cleared);
  // No revision is cited: a clear must not 409 because another window toggled a
  // switch while this page was open.
  assert.equal(cleared.headers["if-match"], undefined);

  const after = await driver.settle(() => page(driver, api, t));
  const text = textOf(aboutGroup(after));
  assert.match(text, /setCacheFreed/);
  assert.match(text, /setCacheSkipped/, "a busy component's download directory is skipped, not deleted");
});

test("Star opens the repository through the host", async () => {
  const { tree, calls } = await renderSettings();
  chipLabelled(tree, "setStarGo").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const opened = calls.find((call) => call.method === "POST" && call.url.endsWith("/about/open"));
  assert.ok(opened);
  assert.deepEqual(opened.body, { target: "star" });
});

test("更新说明 is the document, read when it is opened", async () => {
  const { tree, calls, driver, api, t } = await renderSettings();
  assert.equal(collect(tree, byClass("se-notes")).length, 0, "nothing is drawn until the row is pressed");
  assert.ok(!calls.some((call) => /\/release-notes/.test(call.url)), "and nothing is read either");

  chipLabelled(tree, "setNotesOpen").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.filter((call) => /\/release-notes/.test(call.url)).length, 1);

  const after = await driver.settle(() => page(driver, api, t));
  const layer = collect(after, byClass("se-notes"))[0];
  assert.ok(layer, "the layer is up once the notes arrive");
  // The document's own first line, which already carries the version: the
  // dialog must not put a heading of its own above it.
  assert.equal(textOf(collect(layer, byClass("se-notes-title"))[0]), "更新说明：V1.1.0");
  assert.equal(collect(layer, byClass("se-notes-list")).length, 2, "one ordered list and one bulleted");
  assert.equal(collect(layer, byClass("se-notes-rule")).length, 1);
  assert.match(textOf(layer), /新增/);
  assert.match(textOf(layer), /更新说明弹窗/, "**bold** keeps its text");

  // Star and Issue ride at the bottom, and still name a target rather than a
  // URL — the host owns the allowlist.
  const footChip = (key) => collect(layer, byClass("se-set-chip")).find((chip) => textOf(chip) === key);
  footChip("setIssueGo").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const opened = calls.find((call) => call.method === "POST" && call.url.endsWith("/about/open"));
  assert.deepEqual(opened.body, { target: "issues" });
});

test("更新说明 closes on the backdrop but not on the card, and reads again next time", async () => {
  const { tree, calls, driver, api, t } = await renderSettings();
  const open = async () => {
    chipLabelled(await driver.settle(() => page(driver, api, t)), "setNotesOpen").props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    return driver.settle(() => page(driver, api, t));
  };

  let after = await open();
  const self = {};
  collect(after, byClass("se-notes"))[0].props.onClick({ target: self, currentTarget: self });
  after = await driver.settle(() => page(driver, api, t));
  assert.equal(collect(after, byClass("se-notes")).length, 0, "a press outside the card closes it");

  after = await open();
  const layer = collect(after, byClass("se-notes"))[0];
  layer.props.onClick({ target: {}, currentTarget: {} });
  after = await driver.settle(() => page(driver, api, t));
  assert.equal(collect(after, byClass("se-notes")).length, 1, "a press on the card itself keeps it open");

  // Each open asks again: the file is the source of truth, and remembering the
  // parse is the host's job (by size + mtime), not the page's.
  assert.equal(calls.filter((call) => /\/release-notes/.test(call.url)).length, 2);
});

test("更新说明 says the file could not be read instead of showing an empty card", async () => {
  const { tree, driver, api, t } = await renderSettings({
    interpolate: true,
    notes: { ok: false, code: "not-found", error: "找不到更新说明文件（更新说明.md / CHANGELOG.md）" },
  });
  chipLabelled(tree, "setNotesOpen").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await driver.settle(() => page(driver, api, t));
  const layer = collect(after, byClass("se-notes"))[0];
  assert.ok(layer, "the layer still opens, so the failure has somewhere to show");
  assert.match(textOf(layer), /setNotesFailed/);
  assert.match(textOf(layer), /找不到更新说明文件/);
});

/** The 危险操作 group, found by its heading. */
const dangerGroup = (tree) => collect(tree, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupDanger"));

const dangerChip = (tree, key) => collect(dangerGroup(tree), byClass("se-set-chip")).find((chip) => textOf(chip) === key);

/** Open the group and type into its box, settling after each step the way a user
 *  would: the page re-renders between keystrokes. */
async function typeConfirmation({ driver, api, t }, text) {
  const after = await driver.settle(() => page(driver, api, t));
  const input = collect(dangerGroup(after), byClass("se-set-input"))[0];
  assert.ok(input, "the confirmation box is open");
  input.props.onChange({ target: { value: text } });
  return driver.settle(() => page(driver, api, t));
}

test("清除数据 sits last, behind its own heading, and asks nothing until pressed", async () => {
  const { tree } = await renderSettings();
  const groups = collect(tree, byClass("se-set-grp"));
  assert.equal(groups[groups.length - 1], dangerGroup(tree), "the irreversible group is the last one on the page");
  // Closed by default: one row, one button, and no text box to type into.
  assert.equal(collect(dangerGroup(tree), byClass("se-set-input")).length, 0);
  assert.deepEqual(collect(dangerGroup(tree), byClass("se-set-chip")).map(textOf), ["setResetGo"]);
  assert.match(collect(dangerGroup(tree), byClass("se-set-hint"))[0] ? textOf(collect(dangerGroup(tree), byClass("se-set-hint"))[0]) : "", /setResetHint/);
});

test("the red button stays asleep until DELETE is typed exactly", async () => {
  const ctx = await renderSettings();
  const { tree, driver, api, t } = ctx;
  dangerChip(tree, "setResetGo").props.onClick();

  let after = await driver.settle(() => page(driver, api, t));
  const input = collect(dangerGroup(after), byClass("se-set-input"))[0];
  assert.ok(input, "pressing 清除数据… opens the box");
  assert.equal(input.props.placeholder, "setResetPlaceholder");

  const asleep = () => dangerChip(after, "setResetConfirm");
  assert.equal(asleep().props.disabled, true, "an empty box cannot delete anything");

  // A near miss is not a confirmation: the host compares the same string, so the
  // page must not light up for anything it would then have to refuse.
  after = await typeConfirmation(ctx, "delete");
  assert.equal(dangerChip(after, "setResetConfirm").props.disabled, true, "lower case is a near miss");

  after = await typeConfirmation(ctx, "DELETE please");
  assert.equal(dangerChip(after, "setResetConfirm").props.disabled, true, "extra words are a near miss");

  after = await typeConfirmation(ctx, "  DELETE  ");
  const ready = dangerChip(after, "setResetConfirm");
  assert.equal(ready.props.disabled, false, "surrounding spaces are trimmed on both sides");
  assert.match(ready.props.className, /\bdanger\b/);
  assert.match(ready.props.className, /\bon\b/, "the armed button is visibly the red one");

  // Nothing was sent while the box was being typed into.
  assert.equal(ctx.calls.filter((call) => call.url.endsWith("/data/reset")).length, 0);
});

test("确认清除 posts the typed word and reports what it freed", async () => {
  const ctx = await renderSettings({ interpolate: true });
  const { tree, driver, api, t } = ctx;
  dangerChip(tree, "setResetGo").props.onClick();
  await driver.settle(() => page(driver, api, t));
  let after = await typeConfirmation(ctx, "DELETE");

  dangerChip(after, "setResetConfirm").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const sent = ctx.calls.find((call) => call.method === "POST" && call.url.endsWith("/data/reset"));
  assert.ok(sent, "the reset goes to the host");
  assert.deepEqual(sent.body, { confirm: "DELETE" });
  // No revision is cited: the document the page read is the one being deleted,
  // so an If-Match would turn the last step into a 409.
  assert.equal(sent.headers["if-match"], undefined);

  after = await driver.settle(() => page(driver, api, t));
  const done = collect(dangerGroup(after), byClass("se-set-note")).map(textOf).join("");
  assert.match(done, /setResetDone/);
  assert.match(done, /2\.0 KB|2 KB|2048/, "the freed size is printed, not just 'done'");
  // The page re-read the document it just deleted, so the controls above are the
  // defaults on disk rather than the values it had been showing.
  assert.ok(ctx.calls.filter((call) => call.method === "GET" && call.url.endsWith("/settings")).length >= 2);
  // And the box is closed again, so a second press takes the same two steps.
  assert.equal(collect(dangerGroup(after), byClass("se-set-input")).length, 0);
});

test("取消 closes the box without asking the host anything", async () => {
  const ctx = await renderSettings();
  const { tree, driver, api, t } = ctx;
  dangerChip(tree, "setResetGo").props.onClick();
  let after = await driver.settle(() => page(driver, api, t));
  after = await typeConfirmation(ctx, "DELETE");

  dangerChip(after, "setResetCancel").props.onClick();
  after = await driver.settle(() => page(driver, api, t));

  assert.equal(collect(dangerGroup(after), byClass("se-set-input")).length, 0);
  assert.equal(ctx.calls.filter((call) => call.url.endsWith("/data/reset")).length, 0);
  // Re-opening starts from an empty box: the word is not remembered between tries.
  dangerChip(after, "setResetGo").props.onClick();
  after = await driver.settle(() => page(driver, api, t));
  assert.equal(collect(dangerGroup(after), byClass("se-set-input"))[0].props.value, "");
});

test("a refused reset shows the host's reason and keeps the box open", async () => {
  const fetchImpl = recordingFetch((call) => {
    const path = call.url.replace(/^.*?\/api/, "");
    if (path === "/settings" && call.method === "GET") return { ok: true, result: settingsDocument("panel", "absent") };
    if (path === "/data/reset") return { ok: false, code: "confirm-required", error: "type DELETE to confirm; nothing was deleted" };
    return { ok: true, result: {} };
  });
  const driver = makeReact();
  const { test: api } = loadClientBundle({ fetch: fetchImpl, expose: EXPOSE, react: driver.React });
  const t = (key, vars) => interpolating(key, vars);
  const ctx = { driver, api, t };
  const tree = await driver.settle(() => page(driver, api, t));

  dangerChip(tree, "setResetGo").props.onClick();
  await driver.settle(() => page(driver, api, t));
  let after = await typeConfirmation(ctx, "DELETE");
  dangerChip(after, "setResetConfirm").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));

  after = await driver.settle(() => page(driver, api, t));
  const failure = collect(dangerGroup(after), byClass("se-set-err")).map(textOf).join("");
  assert.match(failure, /setResetFailed/);
  assert.match(failure, /type DELETE to confirm/, "the host's sentence is shown, not swallowed");
  assert.equal(collect(dangerGroup(after), byClass("se-set-input")).length, 1, "the box stays open so the user can fix the word");
});




/** The 搜索索引 group: the only place the index can be kept, built
 *  early, rebuilt or dropped. Found by its heading, like 关于, so the group order
 *  can change without rewriting the test. */
const indexGroup = (tree) =>
  collect(tree, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupSearch"));

test("搜索索引 has one switch left: building while idle", async () => {
  const { tree, calls } = await renderSettings();
  const group = indexGroup(tree);
  assert.ok(group, "the group is on the page");
  const switches = collect(group, byClass("se-set-switch"));
  // 会话内容索引缓存 is gone: the file is always kept, so the only thing
  // left to choose is when the reading happens — and that is off by default,
  // because it is a 6.5 s read of the logs.
  assert.equal(switches.length, 1);
  assert.doesNotMatch(switches[0].props.className, /\bon\b/, "the idle build is off by default");
  assert.match(textOf(group), /setIndexIdle/);
  assert.doesNotMatch(textOf(group), /setIndexCache|setIndexOff/, "the cache switch is gone");

  switches[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  // 只写这一个键：一个开了很久的设置页不该把整份文档盖回去。
  assert.deepEqual(calls.filter((call) => call.method === "PUT").at(-1).body, { search: { indexIdle: true } });
});

test("搜索索引 reports where the index stands", async () => {
  const { tree } = await renderSettings({ interpolate: true });
  // 已建立 63/63 · 4 KB —— 数字来自宿主，不是页面猜的。
  assert.match(textOf(indexGroup(tree)), /setIndexProgress\(63, 63, /);
});

test("重新建立索引缓存 asks the host, then says it is building", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    interpolate: true,
    rebuildIndex: {
      indexed: 0,
      total: 63,
      pending: 63,
      cache: { enabled: true, bytes: 0, exists: false, sessions: 0 },
      building: true,
    },
  });
  chipLabelled(tree, "setIndexRebuildGo").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const call = calls.find((entry) => entry.method === "POST" && entry.url.endsWith("/search/index/rebuild"));
  assert.ok(call, "the rebuild is a host action, not a settings write");
  // 不带 settings 的 revision：重建和设置文档的版本无关，别让它因别人的编辑失败。
  assert.equal(call.headers["if-match"], undefined);

  const after = await driver.settle(() => page(driver, api, t));
  const group = indexGroup(after);
  assert.match(textOf(group), /setIndexRebuilding/);
  assert.match(textOf(group), /setIndexProgress\(0, 63, /);
});

test("删除索引缓存 drops it and reports the bytes it freed", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({ interpolate: true });
  chipLabelled(tree, "setIndexClearGo").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(calls.find((entry) => entry.method === "POST" && entry.url.endsWith("/search/index/clear")));

  const after = await driver.settle(() => page(driver, api, t));
  const text = textOf(indexGroup(after));
  assert.match(text, /setIndexCleared\(/);
  assert.doesNotMatch(text, /setIndexClearedNone/);
  // 缓存没了，计划里的总数还在：重建时要知道有多少份会话。
  assert.match(text, /setIndexProgress\(0, 63, /);
});

test("a failed 删除索引缓存 reports the reason, not a freed size", async () => {
  const { tree, driver, api, t } = await renderSettings({
    interpolate: true,
    clearIndex: { ok: false, code: "index-clear-failed", error: "EBUSY: the index file is locked" },
  });
  chipLabelled(tree, "setIndexClearGo").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await driver.settle(() => page(driver, api, t));
  const text = textOf(indexGroup(after));
  assert.match(text, /setIndexFailed/);
  assert.match(text, /EBUSY: the index file is locked/);
  assert.doesNotMatch(text, /setIndexCleared/);
});

// ── AI 摘要 ───────────────────────────────────────────────────────

/** The AI group, found by its heading so the group order stays free to move. */
const aiGroup = (tree) =>
  collect(tree, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupAi"));

/** A `<select>` by the label the group gave it (its aria-label). */
const selectLabelled = (tree, label) =>
  collect(tree, (node) => node.props?.className === "se-set-select" && node.props?.["aria-label"] === label)[0];

/** The visible options of a select, with their values. */
const optionsOf = (select) => collect(select, (node) => node.type === "option" || node.props?.value !== undefined)
  .filter((node) => node.type === "option")
  .map((node) => ({ label: textOf(node), value: node.props.value }));

test("AI 摘要 lists the host's models and saves the pick alone", async () => {
  const { tree, calls } = await renderSettings();
  const group = aiGroup(tree);
  assert.ok(group, "the group is on the page");
  // The names come from the catalogue, not from a list baked into the build: a
  // provider the user added this morning has to appear without an upgrade.
  const text = textOf(group);
  assert.match(text, /DeepSeek V4\.1 Flash/);
  assert.match(text, /hy3/);
  assert.match(text, /aiModelHint|1M window/);

  const select = selectLabelled(group, "aiModel");
  assert.ok(select, "the model list is a dropdown");
  const options = optionsOf(select);
  assert.deepEqual(options.map((option) => option.label), ["DeepSeek V4.1 Flash", "hy3"]);
  assert.equal(select.props.value, "wb-proxy\u001fdeepseek-v4.1-flash", "the first model is the empty-choice default");

  select.props.onChange({ target: { value: "wb-proxy\u001fhy3" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const write = calls.find((call) => call.method === "PUT" && call.url.endsWith("/settings"));
  assert.ok(write, "the pick writes immediately");
  // Choosing a model clears the effort: the word "high" belongs to the old
  // model's adapter and may not exist on the new one.
  assert.deepEqual(write.body, { summary: { provider: "wb-proxy", model: "hy3", effort: "" } });
});

test("强度 offers 默认 plus the model's own efforts, and saves the pick alone", async () => {
  const { tree, calls } = await renderSettings();
  const group = aiGroup(tree);
  const select = selectLabelled(group, "aiEffort");
  assert.ok(select, "the effort list is a dropdown too");
  assert.deepEqual(optionsOf(select).map((option) => option.label), ["aiEffortDefault", "Low", "High"], "默认 first, then the adapter's list");
  assert.equal(select.props.value, "", "the default is the empty choice");

  select.props.onChange({ target: { value: "high" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const write = calls.find((call) => call.method === "PUT" && call.url.endsWith("/settings"));
  assert.deepEqual(write.body, { summary: { effort: "high" } });
});

test("a model with no effort list hides 强度 instead of offering a word it cannot use", async () => {
  const { tree } = await renderSettings({
    catalog: {
      providers: [
        { id: "wb-proxy", name: "WB Proxy", models: [{ id: "hy3", name: "hy3", description: "", efforts: [], defaultEffort: null }] },
      ],
      failures: [],
      at: 1_700_000_000_000,
    },
  });
  const group = aiGroup(tree);
  assert.equal(selectLabelled(group, "aiEffort"), undefined, "no effort list, no 强度 row");
});

test("生成哪几项 starts with all three and each chip saves alone", async () => {
  const { tree, calls } = await renderSettings();
  const group = aiGroup(tree);
  for (const key of ["aiFieldTitle", "aiFieldDescription", "aiFieldTag"]) {
    const chip = chipLabelled(group, key);
    assert.ok(chip, key + " is on the page");
    assert.match(chip.props.className, /\bon\b/, key + " starts on");
    assert.equal(chip.props["aria-pressed"], true);
  }

  chipLabelled(group, "aiFieldDescription").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const write = calls.find((call) => call.method === "PUT" && call.url.endsWith("/settings"));
  // One key, so the other two keep whatever the stored document says.
  assert.deepEqual(write.body, { summary: { fields: { description: false } } });
});

test("一键总结未总结的会话 is off, with a reason, when everything has a summary", async () => {
  const { tree } = await renderSettings({ pendingIds: [] });
  const run = chipLabelled(aiGroup(tree), "aiRunNow");
  assert.equal(run.props.disabled, true);
  assert.equal(run.props.title, "aiNothingPending");
});

test("一键总结未总结的会话 hands the host the sweep and reports how many were queued", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({ pendingIds: ["session-1", "session-2"] });
  const run = chipLabelled(aiGroup(tree), "aiRunNow");
  assert.equal(run.props.disabled, false);

  run.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const post = calls.find((call) => call.method === "POST" && call.url.endsWith("/summarize/pending"));
  assert.ok(post, "the button asks the host to work out the set");
  // The page does not decide who is uns summarized: the host owns the ledger,
  // and a page that computed the set could summarize a session twice.
  assert.equal(post.body.lang, "zh");

  const after = await driver.settle(() => page(driver, api, t));
  assert.match(textOf(after), /aiQueued/);
});

test("a host that answers 所有会话都已经有描述和标签了 is a note, not an error", async () => {
  const { tree, driver, api, t } = await renderSettings({
    // The page's own copy says there is work; the host says otherwise. The
    // host owns the ledger, so its answer wins and it is not a failure.
    pendingIds: ["session-1"],
    pendingReply: { ok: false, code: "nothing-pending", error: "所有会话都已经有描述和标签了" },
  });
  chipLabelled(aiGroup(tree), "aiRunNow").props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await driver.settle(() => page(driver, api, t));
  const text = textOf(aiGroup(after));
  assert.match(text, /aiNothingPending/);
  assert.doesNotMatch(text, /aiFailed/);
});

test("a refused sweep reports the host's reason", async () => {
  const { tree, driver, api, t } = await renderSettings({
    interpolate: true,
    pendingIds: ["session-1"],
    pendingReply: { ok: false, code: "llm-unavailable", error: "这个 profile 没有可用的模型服务" },
  });
  const runChip = collect(aiGroup(tree), byClass("se-set-chip")).find((chip) => textOf(chip).startsWith("aiRunNow"));
  assert.ok(runChip, "the sweep button is on the page");
  runChip.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = await driver.settle(() => page(driver, api, t));
  const text = textOf(aiGroup(after));
  assert.match(text, /aiFailed/);
  assert.match(text, /没有可用的模型服务/);
});

test("累计花费 prints the lifetime ledger in tokens, never in money", async () => {
  const { tree } = await renderSettings({
    interpolate: true,
    summaries: {
      sessions: {},
      spend: { inputTokens: 12000, outputTokens: 4000, totalTokens: 16000, cacheReadTokens: 0, cacheWriteTokens: 0, runs: 20, failures: 2 },
      pending: [],
      revision: 2,
      choice: { provider: "", model: "", effort: "" },
    },
  });
  const text = textOf(aiGroup(tree));
  assert.match(text, /16k/, "the total is the number on the label");
  assert.match(text, /12k/, "input is broken out");
  assert.match(text, /4\.0k/, "output is broken out");
  assert.match(text, /20, 2/, "runs and failures ride along, so a failure is not free");
  assert.doesNotMatch(text, /\$|¥/, "no price: this plugin does not know one");
});

test("the queue's progress is on the page while it runs, with a way to stop it", async () => {
  const { tree, calls } = await renderSettings({
    interpolate: true,
    summarizeState: {
      ...idleState(),
      running: true,
      total: 12,
      done: 3,
      failed: 0,
      current: { id: "session-7", title: "重构导出", startedAt: 1_700_000_000_000 },
    },
  });
  const text = textOf(aiGroup(tree));
  assert.match(text, /aiRunning\(3, 12\)/);
  assert.match(text, /aiRunningCurrent\(重构导出\)/);
  const stop = chipLabelled(aiGroup(tree), "aiStop");
  assert.ok(stop, "a running batch offers 停下");
  stop.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(calls.find((call) => call.method === "POST" && call.url.endsWith("/summarize/cancel")));
});

test("a document written before AI 摘要 existed still renders the group", async () => {
  const fetchImpl = recordingFetch((call) => {
    const path = call.url.replace(/^.*?\/api/, "");
    if (path === "/settings") {
      const doc = settingsDocument("panel", "absent");
      delete doc.settings.summary;
      return { ok: true, result: doc };
    }
    return { ok: true, result: {} };
  });
  const driver = makeReact();
  const { test: api } = loadClientBundle({ fetch: fetchImpl, expose: EXPOSE, react: driver.React });
  const t = (key) => key;
  const tree = await driver.settle(() => page(driver, api, t));
  const group = aiGroup(tree);
  assert.ok(group, "the group renders with the defaults");
  const on = collect(group, byClass("se-set-chip")).filter((chip) => chip.props["aria-pressed"] === true);
  assert.equal(on.length, 3, "all three pieces of metadata start on");
});

test("a host with no model configured says so instead of drawing an empty row", async () => {
  const { tree } = await renderSettings({ catalog: { providers: [], failures: [], at: 1_700_000_000_000 } });
  const group = aiGroup(tree);
  assert.match(textOf(group), /aiModelNone/);
  // With no pending work and no model, the sweep cannot run either.
  assert.equal(chipLabelled(group, "aiRunNow").props.disabled, true);
});

// ── 浏览器组件：借用别的插件已经装好的 Electron ────────────────────
// 150 MB is a lot to ask for twice on one machine. When another plugin already
// has an Electron, this group can borrow it — read-only, nothing written into
// that tree — so these cases check both halves of that promise: the page asks
// the host for a scan and shows what it found, and the borrow it sends carries a
// path instead of starting a download.

const componentGroup = (tree) =>
  collect(tree, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupComponent"));

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const CANDIDATE = { root: "C:/Users/me/.dsh/dsh-orb/electron-runtime", electronVersion: "44.0.0", hasDefaultApp: true };

test("扫描其它插件 lists what DSH already has, and 借用 only writes the choice", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    component: "absent",
    scan: { candidates: [CANDIDATE] },
  });
  // Nothing is scanned on open — the host would walk someone's plugin tree every
  // time the settings page is drawn. Two chips: download, or look around first.
  const chips = collect(componentGroup(tree), byClass("se-set-chip"));
  assert.deepEqual(chips.map(textOf), ["setCompDownload", "setCompScan"]);

  chips[1].props.onClick();
  await tick();
  const scanCall = calls.find((call) => call.url.endsWith("/component/scan"));
  assert.ok(scanCall, "the button asks the host, which is where the files are");

  const afterScan = await driver.settle(() => page(driver, api, t));
  const group = componentGroup(afterScan);
  // The version tells a user which install is newer; the path tells them whose
  // plugin it came from, which is the whole reason to look before borrowing.
  assert.match(textOf(group), /Electron 44\.0\.0/);
  assert.ok(textOf(group).includes(CANDIDATE.root), "the borrowed tree is named on the page");
  const borrowChip = collect(group, byClass("se-set-chip")).find((chip) => textOf(chip) === "setCompBorrow");
  assert.ok(borrowChip, "each hit offers 借用");

  borrowChip.props.onClick();
  await tick();
  // A borrow is an install that names a path — the same route, so the host has
  // one place to validate and one state machine to move.
  const install = calls.find((call) => call.method === "POST" && call.url.endsWith("/component/install"));
  assert.ok(install, "borrowing posts an install");
  assert.deepEqual(install.body, { borrowed: CANDIDATE.root });
  assert.equal(
    calls.filter((call) => call.method === "PUT").length,
    0,
    "no settings are written: the runtime is state, not a preference",
  );

  const afterBorrow = await driver.settle(() => page(driver, api, t));
  const ready = componentGroup(afterBorrow);
  assert.deepEqual(collect(ready, byClass("se-set-chip")).map(textOf), ["setCompOpen", "setCompForget"]);
  // 断开借用, not 卸载: the files belong to someone else and must survive it.
  assert.match(textOf(ready), /setCompBorrowedFrom/);
});

test("a borrowed runtime is described by whose tree it is, not by a size", async () => {
  const { tree } = await renderSettings({
    componentInfo: { phase: "ready", version: "1.0.0", installed: true, source: "borrowed", sizeBytes: 0, borrowed: CANDIDATE.root },
    interpolate: true,
  });
  const group = componentGroup(tree);
  // 0 bytes is what a borrow reports (walking someone else's 400 MB tree on every
  // status poll is not worth a number), so the line has to be absent rather than
  // claim the install is empty.
  assert.doesNotMatch(textOf(group), /setCompInstalledSize/);
  assert.match(textOf(group), /setCompBorrowedFrom\(C:\/Users\/me\/\.dsh\/dsh-orb\/electron-runtime\)/);
});

test("a scan that finds nothing says so instead of showing an empty list", async () => {
  const { tree, driver, api, t } = await renderSettings({ component: "absent", scan: { candidates: [] } });
  const chips = collect(componentGroup(tree), byClass("se-set-chip"));
  chips[1].props.onClick();
  await tick();
  const after = await driver.settle(() => page(driver, api, t));
  assert.match(textOf(componentGroup(after)), /setCompScanNone/);
  assert.equal(
    collect(after, byClass("se-set-chip")).filter((chip) => textOf(chip) === "setCompBorrow").length,
    0,
    "no hits, no borrow buttons",
  );
});

test("sending a borrowed runtime back offers the download again", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    componentInfo: { phase: "ready", version: "1.0.0", installed: true, source: "borrowed", sizeBytes: 0, borrowed: CANDIDATE.root },
  });
  const forget = chipLabelled(componentGroup(tree), "setCompForget");
  assert.ok(forget, "a borrowed runtime can be let go");

  forget.props.onClick();
  await tick();
  assert.ok(
    calls.some((call) => call.method === "POST" && call.url.endsWith("/component/remove")),
    "the same route as an uninstall, because the state machine is the same",
  );
  const after = await driver.settle(() => page(driver, api, t));
  assert.deepEqual(collect(componentGroup(after), byClass("se-set-chip")).map(textOf), ["setCompDownload", "setCompScan"]);
});
