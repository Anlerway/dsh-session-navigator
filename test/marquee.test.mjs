/**
 * 框选 (m01168) — dragging a box over the list, and the click on blank that
 * clears the selection.
 *
 * The geometry is two pure functions, so most of it is answered without a DOM.
 * The rest drives the real drag through the fake elements it is handed, which is
 * where the "press that never moved is a click" rule lives.
 *
 *   node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle } from "./support/client-bundle.mjs";

const { test: api } = loadClientBundle({
  expose: ["marqueeRect", "marqueeIds", "marqueeDrag", "rowDraggable"],
});

/** A row as the drag sees it: an id, a checkbox (or none), and a box. */
function row(id, top, { height = 32, check = true, left = 0, right = 600 } = {}) {
  return {
    dataset: { id },
    querySelector: (selector) => (selector === ".chk" ? (check ? { className: "chk" } : null) : null),
    getBoundingClientRect: () => ({ left, top, right, bottom: top + height }),
  };
}

/**
 * The list pane, its scrolling body, and the div the box paints into.
 *
 * `rows` and `box` may be functions: a list that scrolls moves its rows and a
 * pane pushed by an ancestor moves both, and the box has to follow them (m01540).
 */
function pane(rows, box = { left: 0, top: 0, right: 600, bottom: 400 }) {
  const rowsNow = () => (typeof rows === "function" ? rows() : rows);
  const boxNow = () => (typeof box === "function" ? box() : box);
  const scrolls = new Set();
  // A real element clamps its scroll to the content: 0 at the top, and the
  // overflow past the viewport at the bottom.
  let scrolled = 0;
  const body = {
    get scrollTop() {
      return scrolled;
    },
    set scrollTop(value) {
      scrolled = Math.max(0, Math.min(240, value));
    },
    getBoundingClientRect: () => boxNow(),
    addEventListener: (type, fn) => {
      if (type === "scroll") scrolls.add(fn);
    },
    removeEventListener: (type, fn) => {
      scrolls.delete(fn);
    },
  };
  const attrs = {};
  return {
    body,
    scrolls,
    attrs,
    /** Scroll the list the way the wheel or the scrollbar would. */
    scroll() {
      for (const fn of [...scrolls]) fn({ type: "scroll" });
    },
    getBoundingClientRect: () => boxNow(),
    querySelector: (selector) => (selector === ".listbody" ? body : null),
    querySelectorAll: () => rowsNow(),
    setAttribute: (key, value) => {
      attrs[key] = value;
    },
    removeAttribute: (key) => {
      delete attrs[key];
    },
  };
}

function box() {
  return { style: { display: "none" } };
}

/**
 * Start a drag and hand back the surface to drive it: the window listeners it
 * registered, the rAF queue it asked for, and every id set it reported.
 */
function start({ target, x = 10, y = 10, ctrlKey = false } = {}) {
  const listeners = new Map();
  const frames = [];
  const picks = [];
  const saved = {
    add: globalThis.window.addEventListener,
    remove: globalThis.window.removeEventListener,
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
  };
  globalThis.window.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  };
  globalThis.window.removeEventListener = (type, fn) => {
    listeners.get(type)?.delete(fn);
  };
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  globalThis.cancelAnimationFrame = () => {};

  const fire = (type, event) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
  };
  /** Run every frame the drag has queued, the way a browser would. */
  const tick = () => {
    const queued = frames.splice(0, frames.length);
    for (const fn of queued) fn(0);
  };

  return { listeners, frames, picks, tick, fire, saved };
}

function stop(context) {
  globalThis.window.addEventListener = context.saved.add;
  globalThis.window.removeEventListener = context.saved.remove;
  globalThis.requestAnimationFrame = context.saved.raf;
  globalThis.cancelAnimationFrame = context.saved.caf;
}

test("marqueeRect normalises the two corners, whichever way the drag goes", () => {
  assert.deepEqual(api.marqueeRect(10, 20, 50, 60), { left: 10, top: 20, right: 50, bottom: 60 });
  assert.deepEqual(api.marqueeRect(50, 60, 10, 20), { left: 10, top: 20, right: 50, bottom: 60 });
  assert.deepEqual(api.marqueeRect(10, 20, 10, 20), { left: 10, top: 20, right: 10, bottom: 20 });
});

test("a box takes every row it overlaps, and nothing it only stands next to", () => {
  const boxes = [
    { id: "a", left: 0, right: 600, top: 0, bottom: 32 },
    { id: "b", left: 0, right: 600, top: 32, bottom: 64 },
    { id: "c", left: 0, right: 600, top: 64, bottom: 96 },
  ];
  // Clipping the middle row is enough: a box that starts inside a row and ends
  // inside the next one takes both.
  assert.deepEqual(api.marqueeIds({ left: 0, top: 40, right: 600, bottom: 50 }, boxes), ["b"]);
  assert.deepEqual(api.marqueeIds({ left: 0, top: 10, right: 600, bottom: 70 }, boxes), ["a", "b", "c"]);
  // A box beside the rows (past the right edge, or below the last one) is empty.
  assert.deepEqual(api.marqueeIds({ left: 700, top: 0, right: 800, bottom: 96 }, boxes), []);
  assert.deepEqual(api.marqueeIds({ left: 0, top: 96, right: 600, bottom: 200 }, boxes), []);
  // A click is a zero-area box, and touches nothing — otherwise the row under
  // the corner would be picked by a gesture the user meant as "deselect".
  assert.deepEqual(api.marqueeIds({ left: 5, top: 5, right: 5, bottom: 5 }, boxes), []);
});

test("dragging a box reports every row it crosses, and only when the set changes", () => {
  const rows = [row("a", 0), row("b", 32), row("c", 64)];
  const list = pane(rows);
  const rect = box();
  const context = start();
  try {
    api.marqueeDrag({
      event: { target: { closest: () => null }, clientX: 10, clientY: 10, button: 0, preventDefault() {} },
      pane: list,
      rect,
      onPick: (ids) => context.picks.push(ids),
    });
    assert.equal(list.attrs["data-marquee"], "1", "the pane knows a box is being dragged");
    assert.equal(rect.style.display, "none", "no box painted before the pointer moves");

    // First move: rows a and b are under the box.
    context.fire("mousemove", { clientX: 300, clientY: 50 });
    context.tick();
    assert.deepEqual(context.picks, [["a", "b"]]);
    assert.equal(rect.style.display, "block");
    assert.equal(rect.style.width, "290px", "the box is drawn from the press to the pointer");
    assert.equal(rect.style.height, "40px");

    // The same box a second time is the same answer: React is not told again.
    context.tick();
    assert.deepEqual(context.picks, [["a", "b"]]);

    // Further down: c joins.
    context.fire("mousemove", { clientX: 300, clientY: 80 });
    context.tick();
    assert.deepEqual(context.picks.at(-1), ["a", "b", "c"]);

    // Up and back: the rows that leave the box leave the set.
    context.fire("mousemove", { clientX: 300, clientY: 20 });
    context.tick();
    assert.deepEqual(context.picks.at(-1), ["a"]);

    context.fire("mouseup", {});
    assert.equal(rect.style.display, "none");
    assert.equal(list.attrs["data-marquee"], undefined, "the drag forgets the pane it was on");
    assert.equal(context.listeners.get("mousemove")?.size, 0, "the listeners are gone after the drag");
    assert.deepEqual(context.picks.at(-1), ["a"], "letting go keeps the set it found");
  } finally {
    stop(context);
  }
});

test("a press on the blank that never moves clears the selection", () => {
  const list = pane([row("a", 0), row("b", 32)]);
  const rect = box();
  const context = start();
  try {
    api.marqueeDrag({
      event: { target: { closest: () => null }, clientX: 10, clientY: 200, button: 0, preventDefault() {} },
      pane: list,
      rect,
      onPick: (ids) => context.picks.push(ids),
    });
    // A wobble under the 3px threshold is still a click, not a box.
    context.fire("mousemove", { clientX: 11, clientY: 201 });
    context.tick();
    assert.deepEqual(context.picks, [], "a wobble selects nothing");
    context.fire("mouseup", {});
    assert.deepEqual(context.picks, [null], "the click reports itself as a clear");
    assert.equal(rect.style.display, "none");
  } finally {
    stop(context);
  }
});

/** A press whose target sits inside the row `id` — or on one of its controls. */
function pressOnRow(id, control = null) {
  const element = { dataset: { id }, getAttribute: () => id };
  return {
    target: {
      closest: (selector) => {
        if (control && selector.includes(control)) return {};
        return selector.includes("[data-id]") ? element : null;
      },
    },
    clientX: 10,
    clientY: 10,
    button: 0,
    preventDefault() {},
  };
}

test("rowDraggable only lets a picked row start a drag", () => {
  // 拖动要先选中 (m01385): the row's `draggable` and the box's predicate both
  // read this, so the rule lives here rather than twice.
  assert.equal(api.rowDraggable({ selected: false, checked: false }), false);
  assert.equal(api.rowDraggable({ selected: true, checked: false }), true);
  assert.equal(api.rowDraggable({ selected: false, checked: true }), true);
});

test("a press on a control inside a row is not a box", () => {
  const list = pane([row("a", 0)]);
  const context = start();
  try {
    for (const control of [".chk", "button", ".colrsz"]) {
      api.marqueeDrag({
        event: pressOnRow("a", control),
        pane: list,
        rect: box(),
        canDragRow: () => false,
        onPick: () => context.picks.push("nope"),
      });
      assert.equal(list.attrs["data-marquee"], undefined, `a press on ${control} starts nothing`);
    }
    assert.equal(context.listeners.size, 0, "no listeners were left behind");
    assert.deepEqual(context.picks, []);
  } finally {
    stop(context);
  }
});

test("a picked row keeps the press for its own drag", () => {
  const list = pane([row("a", 0)]);
  const context = start();
  try {
    api.marqueeDrag({
      event: pressOnRow("a"),
      pane: list,
      rect: box(),
      // Picked means `draggable`, so the browser is already starting a native
      // drag: a box underneath it would fight for the same pointer.
      canDragRow: (id) => id === "a",
      onPick: () => context.picks.push("nope"),
    });
    assert.equal(list.attrs["data-marquee"], undefined, "a dragged row is not a box");
    assert.deepEqual(context.picks, []);
  } finally {
    stop(context);
  }
});

test("an unpicked row is surface, so the press draws a box over it (m01385)", () => {
  const list = pane([row("a", 0), row("b", 32)]);
  const context = start();
  try {
    api.marqueeDrag({
      event: pressOnRow("b"),
      pane: list,
      rect: box(),
      canDragRow: () => false,
      onPick: (ids) => context.picks.push(ids),
    });
    assert.equal(list.attrs["data-marquee"], "1", "the box starts on the row itself");
    context.fire("mousemove", { clientX: 300, clientY: 40 });
    context.tick();
    assert.deepEqual(context.picks.at(-1), ["a", "b"], "the row under the press joins the box");
    context.fire("mouseup", {});
    assert.equal(list.attrs["data-marquee"], undefined, "mouseup clears the marker");
  } finally {
    stop(context);
  }
});

test("with no predicate no row can drag, so every press is a box", () => {
  const list = pane([row("a", 0)]);
  const context = start();
  try {
    api.marqueeDrag({
      event: pressOnRow("a"),
      pane: list,
      rect: box(),
      onPick: () => context.picks.push("nope"),
    });
    assert.equal(list.attrs["data-marquee"], "1");
  } finally {
    stop(context);
  }
});

test("only rows that own a checkbox can be boxed", () => {
  // A subagent row and a 特殊文件夹 draw no box, so they cannot join a set that
  // commands would then act on.
  const rows = [row("a", 0), row("sub", 32, { check: false }), row("c", 64)];
  const list = pane(rows);
  const context = start();
  try {
    api.marqueeDrag({
      event: { target: { closest: () => null }, clientX: 10, clientY: 10, button: 0, preventDefault() {} },
      pane: list,
      rect: box(),
      onPick: (ids) => context.picks.push(ids),
    });
    context.fire("mousemove", { clientX: 300, clientY: 90 });
    context.tick();
    assert.deepEqual(context.picks.at(-1), ["a", "c"]);
  } finally {
    stop(context);
  }
});

test("ctrl adds the box to what was already checked", () => {
  const list = pane([row("a", 0), row("b", 32), row("c", 64)]);
  const context = start();
  try {
    api.marqueeDrag({
      // The press lands on the boundary row c starts at, so the box covers c
      // and leaves b — with ctrl, a keeps its check from before the drag.
      event: { target: { closest: () => null }, clientX: 10, clientY: 64, ctrlKey: true, button: 0, preventDefault() {} },
      pane: list,
      rect: box(),
      checked: new Set(["a"]),
      onPick: (ids) => context.picks.push(ids),
    });
    context.fire("mousemove", { clientX: 300, clientY: 90 });
    context.tick();
    assert.deepEqual(context.picks.at(-1), ["a", "c"], "the rows outside the box keep their check");
  } finally {
    stop(context);
  }
});

test("the box scrolls the list when the pointer passes its edge", () => {
  const rows = [row("a", 0), row("b", 32)];
  const list = pane(rows);
  const context = start();
  try {
    api.marqueeDrag({
      event: { target: { closest: () => null }, clientX: 10, clientY: 10, button: 0, preventDefault() {} },
      pane: list,
      rect: box(),
      onPick: () => {},
    });
    // 390 is inside the 24px band above the body's bottom edge (400).
    context.fire("mousemove", { clientX: 300, clientY: 390 });
    context.tick();
    assert.ok(list.body.scrollTop > 0, "the list followed the pointer");
    // Above the top edge it scrolls back the other way.
    context.fire("mousemove", { clientX: 300, clientY: 2 });
    context.tick();
    context.tick();
    assert.equal(list.body.scrollTop, 0, "and it stops at the top");
  } finally {
    stop(context);
  }
});

test("the box keeps the row it started on when the list scrolls (m01775)", () => {
  // The wheel, the scrollbar and the edge scroll all move the rows without a
  // single mousemove. Two things follow, and the second one is what m01775 is
  // about: the box has to repaint on scroll (m01540), and its *start* has to
  // stay on the row it was pressed on. Left at its screen position the start
  // point slid down the list with every wheel notch, so the selection range
  // travelled with the scroll instead of staying anchored.
  // The gesture sits in the middle of the list on purpose: near an edge the box
  // scrolls the list by itself and the numbers below would measure that instead.
  const shift = { y: 0 };
  const rows = () => [row("a", 100 - shift.y), row("b", 132 - shift.y), row("c", 164 - shift.y)];
  const list = pane(rows);
  const rect = box();
  const context = start();
  try {
    api.marqueeDrag({
      event: { target: { closest: () => null }, clientX: 10, clientY: 110, button: 0, preventDefault() {} },
      pane: list,
      rect,
      onPick: (ids) => context.picks.push(ids),
    });
    context.fire("mousemove", { clientX: 300, clientY: 120 });
    context.tick();
    assert.deepEqual(context.picks.at(-1), ["a"], "the box starts on the first row");
    assert.equal(rect.style.top, "110px");

    // Scrolled by 40: the rows slide up under a pointer that has not moved. The
    // press was inside row a, so row a is still the anchor — the box now reaches
    // up to where that row went, and covers b on the way down to the pointer.
    shift.y = 40;
    list.body.scrollTop = 40;
    list.scroll();
    context.tick();
    assert.deepEqual(context.picks.at(-1), ["a", "b"], "the anchor row stays in the box");
    assert.equal(rect.style.top, "70px", "the start moved up with the rows, not with the screen");
    assert.equal(rect.style.height, "50px", "and the box still ends at the pointer");
    assert.equal(context.listeners.get("mousemove")?.size ?? 0, 1);

    // A second notch does not double-count: the anchor is measured from where the
    // press landed, not from the previous scroll event.
    shift.y = 80;
    list.body.scrollTop = 80;
    list.scroll();
    context.tick();
    assert.equal(rect.style.top, "30px", "one anchor, however many notches");
    assert.deepEqual(context.picks.at(-1), ["a", "b", "c"]);

    context.fire("mouseup", {});
    assert.equal(list.scrolls.size, 0, "the scroll listener leaves with the gesture");
  } finally {
    stop(context);
  }
});

test("a box re-anchors when its pane is pushed by an ancestor (m01540)", () => {
  // The pane's rectangle used to be read once, at the press. Anything that moved
  // it afterwards — a resized panel, a taller header, a scroll of an ancestor —
  // drew and hit-tested the box offset from the pointer by exactly that movement.
  const layout = { dy: 0 };
  const rows = () => [row("a", layout.dy), row("b", layout.dy + 32), row("c", layout.dy + 64)];
  const list = pane(rows, () => ({ left: 0, top: layout.dy, right: 600, bottom: layout.dy + 400 }));
  const rect = box();
  const context = start();
  try {
    api.marqueeDrag({
      event: { target: { closest: () => null }, clientX: 10, clientY: 10, button: 0, preventDefault() {} },
      pane: list,
      rect,
      onPick: (ids) => context.picks.push(ids),
    });
    context.fire("mousemove", { clientX: 300, clientY: 60 });
    context.tick();
    assert.deepEqual(context.picks.at(-1), ["a", "b"]);

    // The pane slides down 40 with its rows, and the pointer stays where it was:
    // in the pane's own frame the press is now 40 further up, so the box starts
    // above row a instead of inside it. Read from the press-time rectangle the
    // box would still be painted at 10px — 50px below the pointer — and would
    // miss every row in the list.
    layout.dy = 40;
    context.fire("mousemove", { clientX: 300, clientY: 60 });
    context.tick();
    assert.equal(rect.style.top, "-30px", "the box is measured in the pane's frame, which moved");
    assert.equal(rect.style.height, "50px", "and it still spans press to pointer");
    assert.deepEqual(context.picks.at(-1), ["a"], "the rows are measured in the same frame, so the box clips only the top row");
  } finally {
    stop(context);
  }
});

test("the secondary button starts no box, so its release is not a click either", () => {
  const list = pane([row("a", 0)]);
  const context = start();
  try {
    api.marqueeDrag({
      event: { target: { closest: () => null }, clientX: 10, clientY: 200, button: 2, preventDefault() {} },
      pane: list,
      rect: box(),
      onPick: (ids) => context.picks.push(ids),
    });
    assert.equal(list.attrs["data-marquee"], undefined, "the context menu is not a box");
    assert.equal(context.listeners.size, 0, "and it listens for nothing");
    assert.deepEqual(context.picks, [], "a right-click on blank must not clear the selection");
  } finally {
    stop(context);
  }
});

test("stopping a drag early tears it down without reporting a click", () => {
  const list = pane([row("a", 0)]);
  const rect = box();
  const context = start();
  try {
    const cancel = api.marqueeDrag({
      event: { target: { closest: () => null }, clientX: 10, clientY: 10, button: 0, preventDefault() {} },
      pane: list,
      rect,
      onPick: (ids) => context.picks.push(ids),
    });
    cancel();
    assert.equal(list.attrs["data-marquee"], undefined, "the pane is released");
    assert.equal(rect.style.display, "none", "and the box is gone");
    assert.equal(context.listeners.get("mousemove")?.size ?? 0, 0, "no listener outlives the caller");
    assert.equal(context.listeners.get("mouseup")?.size ?? 0, 0, "and the release handler is gone too");
    assert.deepEqual(context.picks, [], "an unmount mid-gesture is not a click on blank");
  } finally {
    stop(context);
  }
});
