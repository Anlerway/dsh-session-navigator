/**
 * Picking rows: click, Ctrl+click, right-click, and the two ways to select
 * everything.
 *
 * The gestures live in one hook (13d), and the panel owns the state it moves, so
 * the hook is driven here with plain setters — no renderer, no DOM. That keeps
 * the rules that actually decide what a user gets testable:
 *
 *   - a plain click selects exactly the row under the pointer — a session and a
 *     container the same way;
 *   - Ctrl/⌘+click toggles one row in or out of that set, and the checkbox on
 *     the row is the third way into it;
 *   - a right-click never collapses a multi-selection, because the menu it
 *     opens acts on all of it;
 *   - 全选 means "the rows on screen", and doing it twice is not an undo.
 *
 * Each of them was wrong at some point. Ctrl+clicking a second row replaced the
 * first instead of adding to it; a plain click on a ticked row left the whole
 * set standing, so the tick the user had just made was invisible; a click on a
 * folder checked nothing; and the header box only toggled between "all" and
 * "none".
 *
 *   node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle } from "./support/client-bundle.mjs";

const { test: api } = loadClientBundle({ expose: ["useSessionSelection"] });

/** The panel's state, as the hook sees it: two setters and the values they hold. */
function selection({ checked = [], selected = null, visible = [] } = {}) {
  let checkSet = new Set(checked);
  let picked = selected;
  const hook = api.useSessionSelection({
    setSelected: (value) => {
      picked = value;
    },
    setChecked: (value) => {
      checkSet = typeof value === "function" ? value(checkSet) : new Set(value);
    },
    filteredInScope: visible.map((id) => ({ id })),
    checked: checkSet,
    selected: picked,
  });
  return {
    hook,
    /** The set after the gesture. */
    get checked() {
      return checkSet;
    },
    get selected() {
      return picked;
    },
    /** Ctrl on Windows/Linux, ⌘ on a Mac — the hook treats them the same. */
    ctrlClick(id) {
      hook.selectRow(id, { ctrlKey: true });
    },
    click(id) {
      hook.selectRow(id, {});
    },
    /** What a row's own right-click handler passes before the menu opens. */
    rightClick(id) {
      hook.selectRow(id, { preserve: true });
    },
  };
}

const ids = (set) => [...set].sort();

test("a plain click picks one row and drops the rest", () => {
  const list = selection({ checked: ["a", "b"], visible: ["a", "b", "c"] });
  list.click("c");
  assert.deepEqual(ids(list.checked), ["c"], "a plain click starts a new selection");
  assert.equal(list.selected, "c");
});

test("a plain click on a ticked row folds the set down to it", () => {
  // Explorer's rule, and the only one that makes the tick the user just made
  // visible: pressing a row in a five-row set means "this one", not "all six".
  // 拖动 a multi-selection still moves everything — dragstart reads the set on
  // mousedown, and a drag that moved never becomes a click.
  const list = selection({ checked: ["a", "b"], visible: ["a", "b", "c"] });
  list.click("a");
  assert.deepEqual(ids(list.checked), ["a"], "one row is what was picked");
  assert.equal(list.selected, "a", "the detail pane follows the row that was clicked");
});

test("a right-click keeps a multi-selection standing", () => {
  // The menu items are built from the set as the press found it, and they act on
  // all of it, so the press must not shrink the set underneath them.
  const list = selection({ checked: ["a", "b"], visible: ["a", "b"] });
  list.rightClick("a");
  assert.deepEqual(ids(list.checked), ["a", "b"], "the set the menu will act on survives");
  assert.equal(list.selected, "a");
});

test("a right-click outside the set still picks that row", () => {
  const list = selection({ checked: ["b"], visible: ["a", "b"] });
  list.rightClick("a");
  assert.deepEqual(ids(list.checked), ["a"], "there is no multi-selection to preserve");
  assert.equal(list.selected, "a");
});

test("Ctrl+click adds a second row instead of replacing the first", () => {
  const list = selection({ visible: ["a", "b", "c"] });
  list.click("a");
  list.ctrlClick("b");
  assert.deepEqual(ids(list.checked), ["a", "b"], "the first row must stay checked");
  assert.equal(list.selected, "b");
});

test("Ctrl+click keeps adding past two rows", () => {
  const list = selection({ visible: ["a", "b", "c"] });
  list.click("a");
  list.ctrlClick("b");
  list.ctrlClick("c");
  assert.deepEqual(ids(list.checked), ["a", "b", "c"]);
});

test("Ctrl+click on a checked row takes it back out", () => {
  const list = selection({ checked: ["a", "b", "c"], visible: ["a", "b", "c"] });
  list.ctrlClick("b");
  assert.deepEqual(ids(list.checked), ["a", "c"], "the modifier toggles one row off");
});

test("Alt is not a modifier: only Ctrl or ⌘ adds", () => {
  const list = selection({ checked: ["a"], visible: ["a", "b"] });
  list.hook.selectRow("b", { altKey: true });
  assert.deepEqual(ids(list.checked), ["b"], "an Alt press is a plain click");
});

test("the header box fills the rows on screen, not the whole scope", () => {
  // 筛选 and 搜索 shrink what is listed; 全选 must follow the list, because a row
  // the user cannot see cannot be told apart from one that is not checked.
  const list = selection({ checked: ["a"], visible: ["a", "b"] });
  list.hook.checkRow("all");
  assert.deepEqual(ids(list.checked), ["a", "b"], "a partial selection is completed");
});

test("pressing the header box again clears the view", () => {
  const list = selection({ checked: ["a", "b"], visible: ["a", "b"] });
  list.hook.checkRow("all");
  assert.deepEqual(ids(list.checked), [], "everything checked toggles off");
});

test("Ctrl+A fills the view and stays idempotent", () => {
  // A shortcut that emptied the list on its second press would read like a bug
  // rather than an undo, so the keyboard path asks for "on" explicitly.
  const list = selection({ visible: ["a", "b"] });
  list.hook.checkRow("all", "on");
  const once = ids(list.checked);
  list.hook.checkRow("all", "on");
  assert.deepEqual(once, ["a", "b"]);
  assert.deepEqual(ids(list.checked), ["a", "b"], "the second Ctrl+A changes nothing");
});

test("Ctrl+A on an empty view leaves the set alone", () => {
  const list = selection({ checked: ["a"], visible: [] });
  list.hook.checkRow("all", "on");
  assert.deepEqual(ids(list.checked), [], "there is nothing on screen to select");
});

test("a click on a container row checks it like a session", () => {
  // A folder and a workspace are moved, cut and deleted, not only stood in — the
  // row already draws a checkbox for them, so a click has to fill it. Treated as
  // "selected but not checked" it looked broken: the box a click had just ticked
  // reported itself unchecked on the next render.
  const list = selection({ checked: ["a"], visible: ["a"] });
  list.click("d-1");
  assert.equal(list.selected, "d-1");
  assert.deepEqual(ids(list.checked), ["d-1"], "the box the click ticked is the only tick left");
});

test("Ctrl+click puts a container into the set beside the sessions", () => {
  const list = selection({ checked: ["a"], visible: ["a"] });
  list.ctrlClick("d-1");
  assert.deepEqual(ids(list.checked), ["a", "d-1"], "one set, two kinds, each drop target takes its half");
});

test("全选 takes the rows the pane drew, folders and workspaces included", () => {
  // The hook only knows sessions; the pane also draws a checkbox on every
  // workspace, folder and reference row. "Select all" that filled the sessions
  // alone left those rows untouched, so a later 拖动 or 删除 missed them.
  const list = selection({ visible: ["a"] });
  list.hook.checkRow("all", "on", ["w-ws-1", "d-1", "a"]);
  assert.deepEqual(ids(list.checked), ["a", "d-1", "w-ws-1"], "one set covers the whole list");
});

test("全选 over the drawn rows also toggles them all off", () => {
  const drawn = ["w-ws-1", "a"];
  const list = selection({ checked: drawn, visible: ["a"] });
  list.hook.checkRow("all", "toggle", drawn);
  assert.deepEqual(ids(list.checked), [], "the box reports full, so pressing it clears");
});

test("no drawn list falls back to the sessions in scope", () => {
  // A caller that does not paint container rows must not lose the gesture.
  const list = selection({ visible: ["a", "b"] });
  list.hook.checkRow("all", "on", null);
  assert.deepEqual(ids(list.checked), ["a", "b"]);
});
