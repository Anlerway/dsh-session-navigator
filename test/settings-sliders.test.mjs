/**
 * 滑杆：一根滑杆一份草稿，松手才写，写的时候排队。
 *
 * 这三条规则各自都出过事。拖动途中按 300 ms 的停顿写一次中间值，松手那次就带着
 * 同一个 If-Match，宿主答 revision-conflict，页面重读之后滑杆跳回旧值；两次写同时在
 * 路上时，先发的那次回答晚到，同样把手指下的数字顶掉。轨道长度原先跟着行内容走，
 * 三根滑杆看起来像三种控件。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { readFile } from "node:fs/promises";

import { renderSettings, collect, textOf, byClass, page } from "./support/settings-harness.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
/** The 独立窗口美化 group, found by its heading. */
const wallpaperGroup = (tree) => collect(tree, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupWallpaper"));

/** The 弹窗 group, where 遮罩黑度 lives — the one slider whose number is a fraction. */
const modalGroup = (tree) => collect(tree, byClass("se-set-grp")).find((group) => textOf(group).includes("setGroupModal"));

/** 模糊度, 磨砂度 and 壁纸暗度, in the order the group draws them. */
const wallpaperSliders = (tree) => collect(wallpaperGroup(tree), byClass("se-set-range"));

const wallpaperSlider = (tree, index = 0) => wallpaperSliders(tree)[index];

/** The field beside each slider: the readout, and the way to name a value. */
const wallpaperNumbers = (tree) => collect(wallpaperGroup(tree), byClass("se-set-num"));

const wallpaperValues = (tree) => wallpaperNumbers(tree).map((node) => node.props.value);

const wallpaperValue = (tree, index = 0) => wallpaperValues(tree)[index];

test("the three sliders are percentages, and the number on screen is the one the window gets", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    wallpaper: { enabled: true, blur: 35, frost: 60, dim: 20, sync: true, custom: "", customName: "" },
  });
  const sliders = wallpaperSliders(tree);
  assert.equal(sliders.length, 3, "模糊度, 磨砂度 and 壁纸暗度 each get a slider");
  const [blur, frost, dim] = sliders;
  for (const slider of sliders) {
    assert.equal(slider.props.min, 0);
    assert.equal(slider.props.max, 100, "a real percentage, not a pixel radius");
    assert.equal(slider.props.step, 1);
  }
  assert.deepEqual(sliders.map((slider) => slider.props.value), [35, 60, 20], "each slider reads its own key");
  assert.deepEqual(sliders.map((slider) => slider.props["aria-label"]), [
    "setWallpaperBlur",
    "setWallpaperFrost",
    "setWallpaperDim",
  ]);
  assert.deepEqual(wallpaperValues(tree), ["35", "60", "20"], "and every readout is the number itself");
  assert.deepEqual(
    collect(wallpaperGroup(tree), byClass("se-set-unit")).map(textOf),
    [" %", " %", " %"],
    "with the unit outside the field, so what is typed is a bare number",
  );
  assert.equal(sliders[0].props.style["--se-fill"], "35%", "the accent segment says where the handle is");
  assert.equal(sliders[1].props.style["--se-fill"], "60%");

  frost.props.onChange({ target: { value: "80" } });
  let after = await driver.settle(() => page(driver, api, t));
  assert.equal(wallpaperValue(after, 1), "80", "dragging moves the readout before anything is sent");
  assert.equal(calls.filter((call) => call.method === "PUT").length, 0, "a drag in progress is not a write");

  wallpaperSlider(after, 1).props.onPointerUp();
  await tick();
  let wrote = calls.filter((call) => call.method === "PUT" && call.url.endsWith("/settings")).pop();
  assert.deepEqual(wrote.body.wallpaper, { frost: 80 }, "and letting go sends exactly that percentage, for that key only");

  after = await driver.settle(() => page(driver, api, t));
  assert.equal(wallpaperValue(after, 1), "80", "the answer from the host keeps it");

  dim.props.onChange({ target: { value: "5" } });
  after = await driver.settle(() => page(driver, api, t));
  wallpaperSlider(after, 2).props.onPointerUp();
  await tick();
  wrote = calls.filter((call) => call.method === "PUT" && call.url.endsWith("/settings")).pop();
  assert.deepEqual(wrote.body.wallpaper, { dim: 5 }, "壁纸暗度 writes its own key");

  assert.equal(wallpaperValue(after, 0), "35", "and 模糊度 is untouched by either");
});

test("a pause in the middle of a drag is not a release", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    wallpaper: { enabled: true, blur: 35, frost: 60, dim: 0, sync: true, custom: "", customName: "" },
  });
  const wrote = () => calls.filter((call) => call.method === "PUT" && call.url.endsWith("/settings"));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  wallpaperSlider(tree, 1).props.onPointerDown();
  wallpaperSlider(tree, 1).props.onChange({ target: { value: "70" } });
  // Longer than the deferred write. A finger still on the handle means the
  // number is not final: writing here would put a value on the wire that the
  // release then has to race with the same If-Match.
  await wait(360);
  let after = await driver.settle(() => page(driver, api, t));
  assert.equal(wrote().length, 0, "nothing is written while the handle is held");
  assert.equal(wallpaperValue(after, 1), "70", "but the readout already follows the finger");

  wallpaperSlider(after, 1).props.onChange({ target: { value: "40" } });
  wallpaperSlider(after, 1).props.onPointerUp();
  await wait(30);
  assert.deepEqual(wrote().map((call) => call.body.wallpaper), [{ frost: 40 }], "the release writes once, with the number under the finger");
  after = await driver.settle(() => page(driver, api, t));
  assert.equal(wallpaperValue(after, 1), "40");
});

test("a release during an unanswered write waits for it instead of racing it", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    putDelay: 60,
    wallpaper: { enabled: true, blur: 35, frost: 60, dim: 0, sync: true, custom: "", customName: "" },
  });
  const wrote = () => calls.filter((call) => call.method === "PUT" && call.url.endsWith("/settings"));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  wallpaperSlider(tree, 1).props.onPointerDown();
  wallpaperSlider(tree, 1).props.onChange({ target: { value: "70" } });
  wallpaperSlider(tree, 1).props.onPointerUp();
  await tick();
  assert.equal(wrote().length, 1, "the first write is on the wire");

  let after = await driver.settle(() => page(driver, api, t));
  wallpaperSlider(after, 1).props.onPointerDown();
  wallpaperSlider(after, 1).props.onChange({ target: { value: "30" } });
  wallpaperSlider(after, 1).props.onPointerUp();
  await tick();
  assert.equal(wrote().length, 1, "the second waits its turn, because two writes in flight cite one If-Match");
  // Rendered while the first answer is landing: the handle must stay where the
  // finger left it instead of adopting the number that answer carries.
  after = await driver.settle(() => page(driver, api, t));
  assert.equal(wallpaperValue(after, 1), "30", "and the held number does not jump back to the answer that arrived mid-drag");

  await wait(90);
  await tick();
  assert.equal(wrote().length, 2);
  assert.deepEqual(wrote()[1].body.wallpaper, { frost: 30 }, "what goes last on the wire is what the finger chose");
  assert.equal(wrote()[0].headers["if-match"], '"4"');
  assert.equal(wrote()[1].headers["if-match"], '"5"', "the second write cites the counter the first one wrote");

  after = await driver.settle(() => page(driver, api, t));
  assert.equal(wallpaperValue(after, 1), "30", "and that is the number left on screen");
});

test("the number beside the slider is a field, because a hundred steps is not a gesture", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    wallpaper: { enabled: true, blur: 35, frost: 60, dim: 10, sync: true, custom: "", customName: "" },
  });
  let after = tree;
  const wrote = () => calls.filter((call) => call.method === "PUT" && call.url.endsWith("/settings"));

  wallpaperNumbers(after)[1].props.onChange({ target: { value: "72" } });
  after = await driver.settle(() => page(driver, api, t));
  assert.equal(wallpaperValue(after, 1), "72", "typing shows the number as typed");
  assert.equal(wrote().length, 0, "and typing alone is not a write");

  wallpaperNumbers(after)[1].props.onKeyDown({ key: "Enter" });
  await tick();
  assert.deepEqual(wrote().pop().body.wallpaper, { frost: 72 }, "Enter sends exactly the number in the field");

  after = await driver.settle(() => page(driver, api, t));
  wallpaperNumbers(after)[1].props.onChange({ target: { value: "91" } });
  after = await driver.settle(() => page(driver, api, t));
  wallpaperNumbers(after)[1].props.onKeyDown({ key: "Escape" });
  after = await driver.settle(() => page(driver, api, t));
  assert.equal(wallpaperValue(after, 1), "72", "Escape puts the stored number back");
  assert.equal(wrote().length, 1, "and writes nothing");

  wallpaperNumbers(after)[1].props.onChange({ target: { value: "150" } });
  after = await driver.settle(() => page(driver, api, t));
  wallpaperNumbers(after)[1].props.onKeyDown({ key: "Enter" });
  await tick();
  assert.deepEqual(wrote().pop().body.wallpaper, { frost: 100 }, "a number past the ceiling is the ceiling");

  wallpaperNumbers(after)[1].props.onChange({ target: { value: "" } });
  after = await driver.settle(() => page(driver, api, t));
  wallpaperNumbers(after)[1].props.onKeyDown({ key: "Enter" });
  after = await driver.settle(() => page(driver, api, t));
  assert.equal(wallpaperValue(after, 1), "100", "an empty field is not zero — it goes back to the slider");
  assert.equal(wrote().length, 2, "and writes nothing either");
});

test("every slider carries the same way back to its default", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({
    wallpaper: { enabled: true, blur: 35, frost: 60, dim: 10, sync: true, custom: "", customName: "" },
  });
  // 回退 is on every row, default or not: a chip that appears and disappears
  // changes the row's width under the hand, and the track beside it is the one
  // thing that must not move.
  let chips = collect(wallpaperGroup(tree), byClass("se-set-revert"));
  assert.equal(chips.length, 3, "one for each slider");
  assert.deepEqual(chips.map((chip) => chip.props.title), ["setRevertDefault", "setRevertDefault", "setRevertDefault"]);
  assert.equal(chips[0].props.disabled, false, "35 is not 模糊度's default, so it can go back");
  assert.equal(chips[1].props.disabled, true, "frost already is 60");
  assert.equal(chips[2].props.disabled, true, "and 壁纸暗度 already is 10");

  chips[0].props.onClick();
  await tick();
  const wrote = calls.filter((call) => call.method === "PUT" && call.url.endsWith("/settings")).pop();
  assert.deepEqual(wrote.body.wallpaper, { blur: 0 }, "the chip writes the default, not a decrement");
  const after = await driver.settle(() => page(driver, api, t));
  assert.equal(wallpaperValue(after, 0), "0", "and the number lands on it");
  chips = collect(wallpaperGroup(after), byClass("se-set-revert"));
  assert.equal(chips.length, 3, "the chip stays");
  assert.equal(chips[0].props.disabled, true, "it is just inert now");
});

test("遮罩黑度 is the same control on a fraction, read as a percentage", async () => {
  const { tree, calls, driver, api, t } = await renderSettings({ modal: { dim: 0.2 } });
  const dim = (node) => collect(modalGroup(node), byClass("se-set-range"))[0];
  const field = (node) => collect(modalGroup(node), byClass("se-set-num"))[0];

  assert.equal(dim(tree).props.min, 0, "no mask at all");
  assert.equal(dim(tree).props.max, 0.8, "eight tenths is as dark as the mask goes");
  assert.equal(dim(tree).props.step, 0.05, "sixteen steps of five percent");
  assert.equal(field(tree).props.value, "20", "0.2 reads as 20 %");

  field(tree).props.onChange({ target: { value: "25" } });
  let after = await driver.settle(() => page(driver, api, t));
  field(after).props.onKeyDown({ key: "Enter" });
  await tick();
  const wrote = calls.filter((call) => call.method === "PUT" && call.url.endsWith("/settings")).pop();
  assert.deepEqual(wrote.body.shell.modal, { dim: 0.25 }, "25 % goes back as a quarter, not as 25");

  after = await driver.settle(() => page(driver, api, t));
  assert.equal(field(after).props.value, "25", "and comes back reading 25");
});

test("the track is one fixed length, the one settings rows always had", async () => {
  const css = await readFile(new URL("../assets/panel.css", import.meta.url), "utf8");
  const start = css.indexOf(".se-set-range{");
  const rule = css.slice(start, css.indexOf("}", start));
  assert.match(rule, /width:150px/, "a 150 px track — the length the rows had before the redesign");
  assert.doesNotMatch(rule, /vw\b/, "no viewport units: a track that grows with the window makes one percent a different distance");
  assert.doesNotMatch(rule, /flex:(?!0 0 auto)/, "and it never stretches with the row");
});

test("the ball starts halfway down the right edge and crops its face to a circle", async () => {
  const css = await readFile(new URL("../assets/panel.css", import.meta.url), "utf8");
  const start = css.indexOf("\n.se-ball{");
  assert.ok(start > 0, "the ball rule is gone");
  const rule = css.slice(start, css.indexOf("\n}", start));
  for (const part of ["right:22px", "bottom:auto", "top:max(8px,calc(50% - 32px))", "border-radius:50%;corner-shape:round"]) assert.ok(rule.includes(part), part);
  assert.match(css, /\.se-ball-face\{[^}]*border-radius:50%;corner-shape:round/);
});

// DSH paints corner-shape:superellipse(1.5) onto every element, which turns a
// border-radius:50% control into a rounded square. These are the surfaces that
// must stay circles or pills; cards keep the host's shape on purpose.
test("the host's squircle never squares off a round control", async () => {
  const css = await readFile(new URL("../assets/panel.css", import.meta.url), "utf8");
  const rules = [
    ".se-shell .dot",
    ".se-shell .status .s-progress .s-progress-track",
    ".se-shell .status .s-progress .s-progress-fill",
    ".se-shell .taglib-del",
    ".se-shell .tagnew-go",
    ".se-hdrNote",
    ".se-ball",
    ".se-ball-face",
    ".se-set-ball img",
    ".se-set-progress",
    ".se-set-progress-fill",
    ".se-set-range::-webkit-slider-runnable-track",
    ".se-set-range::-webkit-slider-thumb",
    ".se-set-range::-moz-range-track",
    ".se-set-range::-moz-range-progress",
    ".se-set-range::-moz-range-thumb",
    ".se-set-switch",
    ".se-set-switch::after",
  ];
  for (const selector of rules) {
    const start = css.indexOf(selector + "{");
    assert.notEqual(start, -1, selector + " must still exist");
    const body = css.slice(start, css.indexOf("}", start));
    assert.match(body, /corner-shape:round/, selector + " must opt out of the host's superellipse");
  }
});

test("GPU 加速 is on by default, and the switch writes only its own key", async () => {
  const rowFor = (tree) => collect(wallpaperGroup(tree), byClass("se-set-row")).find((row) => textOf(row).includes("setWindowGpu"));
  const switchOf = (tree) => collect(rowFor(tree), byClass("se-set-switch"))[0];

  const { tree, calls, driver, api, t } = await renderSettings({ component: "ready" });
  assert.ok(rowFor(tree), "the GPU row lives in the group that owns the detached window");
  assert.equal(switchOf(tree).props["aria-pressed"], true, "on by default");

  switchOf(tree).props.onClick();
  await tick();
  const write = calls.filter((call) => call.method === "PUT" && call.url.endsWith("/settings")).pop();
  assert.deepEqual(write.body, { shell: { window: { gpu: false } } }, "a partial patch: the wallpaper rows are untouched");

  const after = await driver.settle(() => page(driver, api, t));
  assert.equal(switchOf(after).props["aria-pressed"], false, "the answer from the host turns the switch off");

  const off = await renderSettings({ component: "ready", gpu: false });
  assert.equal(switchOf(off.tree).props["aria-pressed"], false, "a document that already recorded the fallback renders off");
});
