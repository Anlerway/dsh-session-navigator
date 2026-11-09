/**
 * The two entry points, exercised against stub host surfaces.
 *
 * Two things are pinned here, both of which broke in the field rather than in a
 * unit test:
 *
 *   1. 更多设置… must reach DSH's own settings window through a route that does
 *      not depend on the onboarding roster being mounted. The test drives the
 *      real `openNativeSettings` against a stub command registry and asserts the
 *      product command `settings.open` is what gets invoked, with the same
 *      context a native menu would pass.
 *   2. 默认打开方式 must decide where a launch lands, and a 独立弹窗 that cannot
 *      open must fall back to 浮窗 *and say so* instead of doing nothing.
 *   3. 更多设置… must work from the detached window too, where there is no
 *      settings shell to open: the press travels to the DSH page as a bridge
 *      command, and the window's copy of that command is ignored rather than
 *      acted on.
 *   4. 打开 from the window must open the session in DSH even though 独立弹窗 mode
 *      leaves the DSH page without a panel — the page navigates itself instead of
 *      asking a panel that is not there, and the window stays open afterwards
 *      (a window is not an overlay; only the user closes it).
 *
 * No DOM library: the stubs below answer exactly the selectors the bundle uses,
 * which also documents them.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle, recordingFetch } from "./support/client-bundle.mjs";

const EXPOSE = [
  "openNativeSettings",
  "openSettingsTarget",
  "openSettingsFromBridge",
  "windowHost",
  "productModal",
  "settingsModalElement",
  "launchExplorer",
  "refreshOpenMode",
  "peekLaunchHint",
  "clearLaunchHint",
  "openMode",
  "revealInExplorer",
  "publishReveal",
  "bridgeActions",
  "FooterAction",
  "entryMode",
  "entryPhysics",
  "entryStyle",
  "ballArt",
  "refreshEntryMode",
  "clampBall",
  "ballStep",
  "throwVelocity",
  "softClampSpeed",
  "glideBall",
  "getBallRoot",
  "flushBridgeBursts",
  "dialogStore",
];

/**
 * A DOM just wide enough for the launch path.
 *
 * `settingsOpen` is the whole state of the settings modal; `nav` are the cells
 * its rail would hold. Every fake records what was asked of it, so a test can
 * assert that a selector was *not* used as easily as that it was.
 */
function makeDom() {
  const nav = [
    { textContent: "通用", clicks: 0, click() { this.clicks += 1; } },
    { textContent: "  会话资源管理器  ", clicks: 0, click() { this.clicks += 1; } },
  ];
  const dom = {
    settingsOpen: false,
    nav,
    otherModals: [],
    element() {
      return {
        querySelectorAll(selector) {
          return selector === "nav button" ? nav : [];
        },
      };
    },
  };
  const document = {
    querySelector(selector) {
      if (selector === '[data-shortcut-modal="settings"]') return dom.settingsOpen ? dom.element() : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== "[data-shortcut-modal]") return [];
      const all = dom.otherModals.map((id) => ({ dataset: { shortcutModal: id } }));
      if (dom.settingsOpen) all.push({ dataset: { shortcutModal: "settings" } });
      return all;
    },
    createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, textContent: "" }),
    head: { appendChild() {} },
    // The overlay host asks for its own root node before creating one; a stub
    // that lacks the lookup would fail the 悬浮球's portal instead of the test.
    getElementById: () => null,
    body: { appendChild() {}, contains: () => true },
    documentElement: { getAttribute: () => null },
  };
  return { document, dom };
}

/** A `fetch` that answers a route table and keeps its calls. */
function routedFetch(routes) {
  return recordingFetch((call) => {
    const path = call.url.replace("/session-navigator/api", "");
    const route = routes.find((entry) => entry.method === call.method && entry.path === path);
    return route ? route.answer : { ok: true, result: {} };
  });
}

/**
 * The host context the entry points need: a `shortcuts` service, and — only when
 * a test is playing the detached window — a `hostBridge`. `uiWorkspace` is
 * DSH's own navigation service, and only the page inside DSH has it.
 *
 * `locale.bind` answers `navLabel` the way the real dictionaries do, because the
 * section is found by its label: a translator that echoed keys back would hide a
 * regression in the click-the-right-cell step.
 */
function makeHost({ invocations, onInvoke, hostBridge, uiWorkspace } = {}) {
  const service = {
    registry: {
      invoke(id, context) {
        invocations?.push({ id, context });
        onInvoke?.(id, context);
      },
    },
  };
  return {
    locale: {
      register: () => () => {},
      bind: () => (key) => (key === "navLabel" ? "会话资源管理器" : key),
    },
    slots: { inject: () => () => {}, register: () => () => {} },
    effect: () => () => {},
    get: (name) => {
      if (name === "shortcuts") return service;
      if (name === "hostBridge") return hostBridge;
      if (name === "uiWorkspace") return uiWorkspace;
      return undefined;
    },
    shortcuts: service,
  };
}

const settingsRoute = (mode, revision = 3) => ({
  method: "GET",
  path: "/settings",
  answer: { ok: true, result: { settings: { shell: { open: { mode } } }, revision } },
});

/** One launch, with the mode the host would answer. */
async function launch(mode, { detachedAnswer } = {}) {
  const { document } = makeDom();
  const fetchImpl = routedFetch([
    settingsRoute(mode),
    { method: "POST", path: "/detached/open", answer: detachedAnswer ?? { ok: true, result: { open: true } } },
  ]);
  const { bundle, test: api } = loadClientBundle({ document, fetch: fetchImpl, expose: EXPOSE });
  bundle.apply(makeHost());
  await api.launchExplorer();
  return { bundle, api, calls: fetchImpl.calls };
}

test("默认打开方式 浮窗: the launch opens the panel and asks for no window", async () => {
  const { bundle, api, calls } = await launch("panel");
  assert.equal(bundle.panelStore.getSnapshot(), true);
  assert.equal(calls.some((call) => call.url.endsWith("/detached/open")), false);
  assert.equal(api.peekLaunchHint(), "");
});

test("默认打开方式 独立弹窗: the launch asks the host for the window and leaves the panel closed", async () => {
  const { bundle, api, calls } = await launch("detached");
  assert.equal(bundle.panelStore.getSnapshot(), false);
  assert.equal(calls.some((call) => call.method === "POST" && call.url.endsWith("/detached/open")), true);
  assert.equal(api.peekLaunchHint(), "");
});

test("a 独立弹窗 that cannot open falls back to 浮窗 with the installer", async () => {
  const { bundle, api } = await launch("detached", {
    detachedAnswer: {
      ok: false,
      error: "download the Electron component before opening a detached window",
      code: "component-not-installed",
    },
  });
  // Falling back is the point: the user pressed one button and one surface opened.
  assert.equal(bundle.panelStore.getSnapshot(), true);
  // A sentence used to send the user to 设置 → 会话资源管理器 → Electron 组件; the
  // panel can open that same installer itself, so the answer is the installer.
  assert.equal(api.dialogStore.getSnapshot()?.kind, "panel", "the launch opens the component installer");
  assert.equal(api.peekLaunchHint(), "", "the hint slot is no longer needed");
});

test("the launch re-reads 默认打开方式 instead of trusting the first answer", async () => {
  const { document } = makeDom();
  let mode = "panel";
  const fetchImpl = recordingFetch(() => ({
    ok: true,
    result: { settings: { shell: { open: { mode } } }, revision: 1 },
  }));
  const { bundle, test: api } = loadClientBundle({ document, fetch: fetchImpl, expose: EXPOSE });
  bundle.apply(makeHost());
  await api.refreshOpenMode();
  assert.equal(api.openMode.mode, "panel");
  mode = "detached";
  await api.refreshOpenMode();
  assert.equal(api.openMode.mode, "detached");
  // An unreadable document is not an error path that guesses: 浮窗 it is.
  mode = "nonsense";
  await api.refreshOpenMode();
  assert.equal(api.openMode.mode, "panel");
});

test("更多设置… drives the product command that the sidebar Settings button runs", async () => {
  const { document, dom } = makeDom();
  const invocations = [];
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(
    makeHost({
      invocations,
      // Opening the modal is DSH's job; the stub does what the real shell does.
      onInvoke: (id) => {
        if (id === "settings.open") dom.settingsOpen = true;
      },
    }),
  );

  const opened = await api.openNativeSettings("session-navigator", "会话资源管理器");
  assert.equal(opened, true);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].id, "settings.open");
  // The context is the one a native menu passes; `region: "page"` and a free
  // modal is what makes the command runnable at all.
  assert.equal(invocations[0].context.region, "page");
  assert.equal(invocations[0].context.modal, null);
  // And the window landed on our section, found by its label — the store's
  // active id is not reachable from outside.
  assert.equal(dom.nav[1].clicks, 1);
  assert.equal(dom.nav[0].clicks, 0);
});

test("更多设置… does not toggle an already-open settings window shut", async () => {
  const { document, dom } = makeDom();
  dom.settingsOpen = true;
  const invocations = [];
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(makeHost({ invocations }));

  const opened = await api.openNativeSettings("session-navigator", "会话资源管理器");
  assert.equal(opened, true);
  // `settings.open` closes when the modal is already up, so it must not be run.
  assert.equal(invocations.length, 0);
  assert.equal(dom.nav[1].clicks, 1);
});

test("the modal in front is reported to the command, exactly as a menu would", async () => {
  const { document, dom } = makeDom();
  dom.otherModals = ["confirm"];
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(makeHost());
  assert.equal(api.productModal(), "confirm");
  dom.otherModals = [];
  assert.equal(api.productModal(), null);
});

test("the sidebar button launches where the setting says, and closes what it opened", async () => {
  const { document } = makeDom();
  const fetchImpl = routedFetch([
    settingsRoute("detached"),
    { method: "POST", path: "/detached/open", answer: { ok: true, result: { open: true } } },
  ]);
  const { bundle, test: api } = loadClientBundle({ document, fetch: fetchImpl, expose: EXPOSE });
  bundle.apply(makeHost());
  const t = (key) => key;
  // The component returns a fragment; one child is the button.
  const buttonOf = (tree) => tree.children.find((child) => child && child.type === "button");

  // Closed button press: 默认打开方式 decides, and it says 独立弹窗.
  buttonOf(api.FooterAction({ t, wide: true })).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(bundle.panelStore.getSnapshot(), false);
  assert.equal(api.openMode.mode, "detached");

  // Open button press: it takes the panel back instead of toggling a second
  // surface the user did not ask for.
  bundle.panelStore.set(true);
  buttonOf(api.FooterAction({ t, wide: true })).props.onClick();
  assert.equal(bundle.panelStore.getSnapshot(), false);
});

/** Every button in a rendered fragment, portal or not. */
function buttonsIn(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "button") out.push(node);
  const kids = Array.isArray(node.children)
    ? node.children
    : Array.isArray(node.props?.children) ? node.props.children : [];
  for (const kid of kids) buttonsIn(kid, out);
  return out;
}

test("入口位置 decides which shapes the footer draws, and the ball stays on top", async () => {
  const { document } = makeDom();
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(makeHost());
  const t = (key) => key;
  const draw = () => buttonsIn(api.FooterAction({ t, wide: true }));
  // The panel brings its own buttons; these two class names are the entry
  // shapes, and nothing else in the fragment uses them.
  const shapes = () =>
    draw()
      .map((node) => node.props.className)
      .filter((name) => name === "se-ball" || name === "se-footerBtn");

  // 左下角: the shape every older install already has, and the default.
  api.entryMode.set("sidebar");
  assert.deepEqual(shapes(), ["se-footerBtn"], "one button, and no ball");

  // 悬浮球: the ball replaces the footer button rather than joining it.
  api.entryMode.set("ball");
  assert.deepEqual(shapes(), ["se-ball"], "the footer button is gone");
  assert.equal(draw()[0].props["aria-label"], "footerLabel");
  const face = (style) => { api.entryStyle.set(style); return draw()[0]; };
  assert.equal(face("folder").children[0].type, "img");
  assert.match(face("folder").children[0].props.src, /\/ui\/ball-folder\.png$/);
  assert.match(face("claude").children[0].props.src, /\/ui\/ball-claude\.png$/);
  assert.equal(api.ballArt("grok"), "/session-navigator/api/ui/ball-grok.png");
  assert.equal(face("nonsense").props["data-style"], "folder", "an unknown face is the folder");
  draw()[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(bundle.panelStore.getSnapshot(), true, "the ball opened the panel");
  assert.deepEqual(shapes(), ["se-ball"], "the ball keeps its place over the panel");
  draw()[0].props.onClick();
  assert.equal(bundle.panelStore.getSnapshot(), false, "and takes it back");
  api.entryMode.set("both");
  assert.deepEqual(shapes(), ["se-footerBtn", "se-ball"]);
  bundle.panelStore.set(true);
  assert.deepEqual(shapes(), ["se-footerBtn", "se-ball"], "open: still both");
  api.entryMode.set("nonsense");
  assert.equal(api.entryMode.mode, "sidebar");
  assert.deepEqual(shapes(), ["se-footerBtn"]);
});

/** A button node the drag handlers can talk to, without a DOM library. */
function ballNode(rect) {
  const listeners = new Map();
  const classes = new Set();
  const style = {};
  return {
    style,
    listeners,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    getBoundingClientRect: () => ({ left: rect.left, top: rect.top, width: 46, height: 46 }),
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    setPointerCapture() {},
  };
}

test("the ball is a ball you can throw, and a throw is not a click", async () => {
  const stored = new Map();
  const previous = globalThis.localStorage;
  const previousRaf = globalThis.requestAnimationFrame;
  const previousNow = globalThis.performance.now;
  const frames = [];
  let clock = 1000;
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, String(value)); },
  };
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  globalThis.performance.now = () => clock;
  try {
    const { document } = makeDom();
    const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
    bundle.apply(makeHost());
    api.entryMode.set("ball");
    const t = (key) => key;
    const ballOf = () => buttonsIn(api.FooterAction({ t, wide: true }))[0];
    assert.deepEqual(ballOf().props.style, { pointerEvents: "auto" }, "the click-through layer must not swallow the ball");
    const node = ballNode({ left: 700, top: 480 });
    const press = (event) => ballOf().props.onPointerDown({
      button: 0,
      pointerId: 1,
      currentTarget: node,
      preventDefault() {},
      ...event,
    });

    press({ clientX: 720, clientY: 500 });
    node.listeners.get("pointermove")({ clientX: 723, clientY: 502 });
    assert.equal(node.style.left, undefined, "a 3.6px wobble is still a click");
    clock += 400;
    node.listeners.get("pointermove")({ clientX: 650, clientY: 430 });
    assert.equal(node.style.left, "630px", "dragged left by 70px");
    assert.equal(node.style.top, "410px", "and up by 70px");
    assert.equal(node.style.right, "auto", "the default corner stops applying");
    assert.equal(node.classList.contains("dragging"), true);
    clock += 400;
    node.listeners.get("pointerup")({});
    assert.equal(node.classList.contains("dragging"), false);
    // Far but slow is a placement, not a throw: no gravity, no frame loop.
    assert.equal(frames.length, 0, "a placed ball hovers where the hand left it");
    api.glideBall(node, 0, 0);
    assert.equal(frames.length, 0, "zero speed is not a throw");
    assert.deepEqual(
      JSON.parse(stored.get("session-navigator.ball-spot")),
      { left: 630, top: 410 },
      "the spot is remembered by the browser, not by the settings document",
    );

    // The click that trails the pointerup belongs to the throw.
    ballOf().props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(bundle.panelStore.getSnapshot(), false, "landing does not open the panel");
    ballOf().props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(bundle.panelStore.getSnapshot(), true, "the next press is a press again");

    // A later mount reads the spot back: the ball starts where it was left.
    const second = loadClientBundle({ document: makeDom().document, expose: EXPOSE });
    second.bundle.apply(makeHost());
    second.test.entryMode.set("ball");
    const again = buttonsIn(second.test.FooterAction({ t, wide: true }))[0];
    assert.deepEqual(again.props.style, {
      pointerEvents: "auto",
      left: "630px",
      top: "410px",
      right: "auto",
      bottom: "auto",
    });
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
    globalThis.performance.now = previousNow;
  }
});

/** A document that remembers what got appended to <body>. */
function makeBallDocument() {
  const appended = [];
  const document = {
    createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { appendChild() {} },
    body: { appendChild: (node) => appended.push(node), contains: () => true },
    documentElement: { getAttribute: () => null },
  };
  return { document, appended };
}

/**
 * The panel's overlay root is click-through at z-index 900 on purpose. A ball
 * portaled into it inherited `pointer-events: none` — visible but deaf — and no
 * z-index on the button itself could raise it above DSH's dialogs, because the
 * whole layer sat in a 900 context. Hence a second layer at the dsh-pet tier,
 * with only the ball opting back into hit testing.
 */
test("the ball gets its own click-through layer above every app surface", () => {
  const { document, appended } = makeBallDocument();
  const { test: api } = loadClientBundle({ document, expose: EXPOSE });
  const root = api.getBallRoot();
  const roots = appended.filter((node) => node.id === "dsh-session-navigator-ball-root");
  assert.equal(root.id, "dsh-session-navigator-ball-root");
  assert.equal(root.style.position, "fixed");
  assert.equal(root.style.inset, "0");
  assert.equal(root.style.zIndex, "2147483000", "the tier dsh-pet floats its chrome at");
  assert.equal(root.style.pointerEvents, "none", "the layer itself must not eat DSH's presses");
  assert.equal(root.style.overflow, "visible", "the ball may lean past the edge while dragged");
  assert.equal(roots.length, 1);
  assert.equal(api.getBallRoot(), root, "one layer per page, not one per render");
  assert.equal(appended.length, 1, "and it is mounted once");
});

test("a thrown ball falls, bounces off the walls and comes to rest", () => {
  const { test: api } = loadClientBundle({ document: makeDom().document, expose: EXPOSE });
  const view = { width: 800, height: 600 };

  const wall = api.ballStep({ left: 10, top: 300, vx: -0.8, vy: 0 }, 16, view);
  assert.equal(wall.left, 8, "the wall stops the ball at its margin");
  assert.ok(wall.vx > 0, "and hands the motion back");
  assert.ok(wall.vx > 0.6 && wall.vx < 0.8, "78% of the speed comes back, like dsh-pet");
  assert.equal(wall.bounced, true);

  const floor = api.ballStep({ left: 300, top: 560, vx: 0, vy: 0.9 }, 16, view);
  assert.equal(floor.top, 528, "600 - 64 - 8");
  assert.ok(floor.vy < 0, "the floor bounces it upward");
  assert.equal(floor.bounced, true);

  // There is no air drag: gravity is the only thing that changes a free flight.
  const air = api.ballStep({ left: 300, top: 300, vx: 1, vy: 0.5 }, 16, view);
  assert.ok(air.left > 300 && air.top > 300);
  assert.equal(air.vx, 1, "a throw keeps its horizontal speed in the air");
  assert.ok(air.vy > 0.5, "and gravity keeps pulling it down");
  assert.equal(air.bounced, false);

  const resting = api.ballStep({ left: 8, top: 300, vx: -0.001, vy: 0 }, 16, view);
  assert.equal(resting.bounced, false, "a ball resting on the margin does not squash every frame");

  // It settles on the floor instead of hovering or sliding forever.
  let state = { left: 300, top: 300, vx: 0.05, vy: 0 };
  let steps = 0;
  while (!state.atRest && steps < 2000) {
    state = api.ballStep(state, 16, view);
    steps += 1;
  }
  assert.ok(steps < 2000, "the frame loop has a stop condition");
  assert.equal(state.top, 528);
  assert.equal(state.vy, 0);
  assert.ok(Math.abs(state.vx) < 0.015, "the floor has rubbed the last slide away");
});

test("a throw is measured over the gesture, not the last pixel", () => {
  const { test: api } = loadClientBundle({ expose: EXPOSE });
  const now = 1000;
  // A fast drag that ends with a one-pixel correction: the last segment alone
  // would read as a crawl and swallow the throw.
  const samples = [
    { x: 700, y: 500, at: 900 },
    { x: 640, y: 500, at: 980 },
    { x: 639, y: 500, at: 998 },
  ];
  const { vx } = api.throwVelocity(samples, now);
  assert.ok(vx < -0.5, "the whole gesture decides the throw");
  // A pause before release is a placement, not a throw.
  assert.deepEqual(
    api.throwVelocity([{ x: 700, y: 500, at: 800 }, { x: 650, y: 500, at: 850 }], now),
    { vx: 0, vy: 0 },
  );
});

test("a soft cap keeps every throw distinct without letting one leave the screen", () => {
  const { test: api } = loadClientBundle({ expose: EXPOSE });
  assert.equal(api.softClampSpeed(0), 0);
  assert.ok(api.softClampSpeed(1200) > 900 && api.softClampSpeed(1200) < 1200);
  assert.ok(api.softClampSpeed(3000) < api.softClampSpeed(3600));
  assert.ok(api.softClampSpeed(3600) < 3600, "the cap is approached, never reached");
});

test("physics off ignores a throw and leaves the ball where the hand released it", () => {
  const frames = [];
  const previousRaf = globalThis.requestAnimationFrame;
  const previousNow = globalThis.performance.now;
  let clock = 1000;
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  globalThis.performance.now = () => clock;
  try {
    const { document } = makeDom();
    const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
    bundle.apply(makeHost());
    api.entryMode.set("ball");
    api.entryPhysics.set(false);
    const t = (key) => key;
    const ballOf = () => buttonsIn(api.FooterAction({ t, wide: true }))[0];
    const node = ballNode({ left: 700, top: 480 });
    const press = (event) => ballOf().props.onPointerDown({
      button: 0,
      pointerId: 1,
      currentTarget: node,
      preventDefault() {},
      ...event,
    });
    press({ clientX: 720, clientY: 500 });
    clock += 10;
    node.listeners.get("pointermove")({ clientX: 650, clientY: 430 });
    clock += 10;
    node.listeners.get("pointerup")({});
    assert.equal(frames.length, 0, "a throw starts no frame loop while physics is off");
    assert.equal(node.style.left, "630px", "the ball stays where it was dropped");
    assert.equal(node.style.top, "410px");
  } finally {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
    globalThis.performance.now = previousNow;
  }
});
test("a throw still flies when the system asks for less motion", async () => {
  const frames = [];
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const previousNow = globalThis.performance.now;
  let clock = 1000;
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.performance.now = () => clock;
  try {
    const { document } = makeDom();
    const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
    bundle.apply(makeHost());
    // Windows can report reduced motion globally (MinAnimate = 0). The throw is
    // the control's own feedback, so it must survive that preference.
    globalThis.window.matchMedia = () => ({ matches: true, addEventListener() {} });
    api.entryMode.set("ball");
    const t = (key) => key;
    const ballOf = () => buttonsIn(api.FooterAction({ t, wide: true }))[0];
    const node = ballNode({ left: 700, top: 480 });
    const press = (event) => ballOf().props.onPointerDown({
      button: 0,
      pointerId: 1,
      currentTarget: node,
      preventDefault() {},
      ...event,
    });
    press({ clientX: 720, clientY: 500 });
    clock += 10;
    node.listeners.get("pointermove")({ clientX: 700, clientY: 500 });
    clock += 10;
    node.listeners.get("pointermove")({ clientX: 650, clientY: 500 });
    clock += 10;
    node.listeners.get("pointerup")({});
    assert.ok(frames.length > 0, "reduced motion must not cancel the throw");
    const before = node.style.left;
    frames.shift()(performance.now() + 16);
    assert.notEqual(node.style.left, before, "the ball keeps moving after the finger lifts");
  } finally {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
    if (previousCancel === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = previousCancel;
    globalThis.performance.now = previousNow;
    if (globalThis.window) globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {} });
  }
});
test("clampBall keeps the whole ball inside the viewport", () => {
  const { test: api } = loadClientBundle({ document: makeDom().document, expose: EXPOSE });
  assert.deepEqual(api.clampBall(300, 200, 1200, 800), { left: 300, top: 200 });
  assert.deepEqual(api.clampBall(-40, -10, 1200, 800), { left: 8, top: 8 });
  assert.deepEqual(api.clampBall(2000, 2000, 1200, 800), { left: 1128, top: 728 }, "64px ball, 8px margin");
  assert.deepEqual(api.clampBall(300, 200, 30, 30), { left: 8, top: 8 }, "a viewport smaller than the ball still wins over a negative spot");
  assert.deepEqual(api.clampBall(300, 200, 0, 0), { left: 300, top: 200 }, "no layout, no clamp");
});
test("the footer asks the host once for 入口位置, then trusts the store", async () => {
  const { document } = makeDom();
  const fetchImpl = routedFetch([
    {
      method: "GET",
      path: "/settings",
      answer: {
        ok: true,
        result: { settings: { shell: { open: { mode: "panel" }, entry: { mode: "ball" } } }, revision: 3 },
      },
    },
  ]);
  const { bundle, test: api } = loadClientBundle({ document, fetch: fetchImpl, expose: EXPOSE });
  bundle.apply(makeHost());

  assert.equal(await api.refreshEntryMode(), "ball", "the document says where the launcher lives");
  const read = () => fetchImpl.calls.filter((call) => call.url.endsWith("/settings")).length;
  const firstRead = read();
  // A remount inside the cache window is free: DSH rebuilds its sidebar footer
  // on layout switches, and each rebuild must not cost a request.
  assert.equal(await api.refreshEntryMode(), "ball");
  assert.equal(read(), firstRead);

  const t = (key) => key;
  const buttons = buttonsIn(api.FooterAction({ t, wide: true }));
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.className, "se-ball");
});

// ── 更多设置… from the detached window ──────────────────────────────────────
// The window is its own document: no settings shell, no command registry. The
// press therefore has to *travel* to the DSH page, and the panel has to say so
// rather than closing over a window it cannot open.

test("更多设置… inside DSH opens the settings window here and lets the panel step aside", async () => {
  const { document, dom } = makeDom();
  const invocations = [];
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(
    makeHost({
      invocations,
      onInvoke: (id) => {
        if (id === "settings.open") dom.settingsOpen = true;
      },
    }),
  );
  bundle.panelStore.set(true);

  // "" means "opened in this document": no hint, the caller closes the panel.
  assert.equal(await api.openSettingsTarget("会话资源管理器"), "");
  assert.equal(dom.settingsOpen, true);
  assert.equal(dom.nav[1].clicks, 1);

  // The bridge's own path does the same and closes the panel itself, because
  // there is no panel callback to do it (the window may ask while it is shut).
  assert.equal(await api.openSettingsFromBridge(), true);
  assert.equal(bundle.panelStore.getSnapshot(), false);
});

test("更多设置… in the detached window asks the DSH page and says where it went", async () => {
  const { document, dom } = makeDom();
  const invocations = [];
  const requests = [];
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(
    makeHost({
      invocations,
      hostBridge: {
        request(kind, payload) {
          requests.push({ kind, payload });
          return Promise.resolve(null);
        },
      },
    }),
  );

  assert.equal(await api.openSettingsTarget("会话资源管理器"), "setOpenedInHost");
  assert.deepEqual(requests, [{ kind: "open-settings", payload: {} }]);
  // Nothing was opened *here*: the window has no settings shell to open, and it
  // must not try the local doors (they would fail slowly and mislead the user).
  assert.equal(dom.settingsOpen, false);
  assert.equal(invocations.length, 0);

  // The command then arrives back on the window's own bus subscription. That is
  // the window's request echoing, not a second press: acting on it would open a
  // settings window the window does not have.
  assert.equal(await api.openSettingsFromBridge(), false);
  assert.equal(invocations.length, 0);
});

test("a window that cannot reach the DSH page reports it instead of pretending", async () => {
  const { document } = makeDom();
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(
    makeHost({ hostBridge: { request: () => Promise.reject(new Error("窗口无法访问 Host")) } }),
  );
  assert.equal(await api.openSettingsTarget("会话资源管理器"), "setOpenHostFailed");
});

test("inside DSH there is no hostBridge, which is how the panel knows it is not the window", async () => {
  const { document } = makeDom();
  const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
  bundle.apply(makeHost());
  assert.equal(api.windowHost(), null);
});

// ── The bus, in the direction a surface cannot do itself ────────────────────

/**
 * Run `body` with a stub `EventSource`, so a test can deliver the bus frames the
 * real host would stream. Returns nothing the body gave; the frames are handed
 * to it instead.
 */
async function withBus(body) {
  const sources = [];
  const previous = globalThis.EventSource;
  globalThis.EventSource = class {
    constructor(url) {
      this.url = String(url);
      this.listeners = new Map();
      sources.push(this);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    emit(type, data) {
      this.listeners.get(type)?.({ data: JSON.stringify(data) });
    }
  };
  try {
    await body(sources);
  } finally {
    globalThis.EventSource = previous;
  }
}

test("the detached window follows a reveal command that names a session", async () => {
  await withBus(async (sources) => {
    const { document } = makeDom();
    const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
    const host = makeHost({ hostBridge: { request: async () => null } });
    // The real host runs the effect at apply time and keeps the disposer.
    host.effect = (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    };
    bundle.apply(host);
    const revealed = [];
    api.bridgeActions.reveal = (id) => revealed.push(id);

    const source = sources.at(-1);
    assert.match(source.url, /\/bridge\/events\?since=0$/);
    source.emit("command", { seq: 4, kind: "reveal", payload: { sessionId: "s1" } });
    api.flushBridgeBursts();
    assert.deepEqual(revealed, ["s1"]);
  });
});

test("the DSH page ignores a reveal it published itself", async () => {
  await withBus(async (sources) => {
    const { document } = makeDom();
    const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
    const host = makeHost();
    host.effect = (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    };
    bundle.apply(host);
    const revealed = [];
    api.bridgeActions.reveal = (id) => revealed.push(id);

    // This is the command 独立弹窗 publishes from `revealInExplorer`; acting on
    // it here would raise the panel over the window it just opened.
    sources.at(-1).emit("command", { seq: 5, kind: "reveal", payload: { sessionId: "s1" } });
    api.flushBridgeBursts();
    assert.deepEqual(revealed, []);
  });
});

// These menus are the other way into the explorer, so they answer to the same
// setting: 浮窗 opens the panel, 独立弹窗 gets the window, and the panel is only
// the fallback when the window cannot open.

// ── 在会话资源管理器查看, from DSH's header strip and row menu ───────────────
// These menus are the other way into the explorer, so they answer to the same
// setting: 浮窗 opens the panel, 独立弹窗 gets the window, and the panel is only
// the fallback when the window cannot open.

/** One reveal, with the mode the host would answer. */
async function reveal(mode, { detachedAnswer, panelOpen = false, bridge } = {}) {
  const { document } = makeDom();
  const fetchImpl = routedFetch([
    settingsRoute(mode),
    { method: "POST", path: "/detached/open", answer: detachedAnswer ?? { ok: true, result: { open: true } } },
    { method: "POST", path: "/bridge/commands", answer: bridge ?? { ok: true, result: { seq: 1 } } },
  ]);
  const { bundle, test: api } = loadClientBundle({ document, fetch: fetchImpl, expose: EXPOSE });
  bundle.apply(makeHost());
  bundle.panelStore.set(panelOpen);
  const revealed = [];
  api.bridgeActions.reveal = (id) => revealed.push(id);
  await api.revealInExplorer("s1");
  const paths = fetchImpl.calls.map((call) => call.url.replace("/session-navigator/api", ""));
  return { bundle, api, calls: fetchImpl.calls, paths, revealed };
}

test("在会话资源管理器查看 浮窗: the session lands in the panel and no window is asked for", async () => {
  const { bundle, paths } = await reveal("panel");
  assert.equal(bundle.panelStore.getSnapshot(), true);
  assert.equal(paths.some((path) => path === "/detached/open"), false);
  assert.equal(paths.some((path) => path === "/bridge/commands"), false);
});

test("在会话资源管理器查看 独立弹窗: the window is opened and told which session", async () => {
  const { bundle, paths, calls } = await reveal("detached");
  assert.equal(bundle.panelStore.getSnapshot(), false);
  const published = calls.filter((call) => call.url.endsWith("/bridge/commands"));
  assert.deepEqual(published.map((call) => call.body), [{ kind: "reveal", payload: { sessionId: "s1" } }]);
  // Published first: a window already on screen acts at once, and one that is
  // still starting reads the command back out of the ring buffer.
  assert.deepEqual(paths.slice(-2), ["/bridge/commands", "/detached/open"]);
});

test("在会话资源管理器查看 falls back to the panel when the window cannot open", async () => {
  const { bundle, paths, revealed } = await reveal("detached", {
    detachedAnswer: { ok: false, error: "no component", code: "component-not-installed" },
  });
  // The user asked to see one session; one surface has to show it.
  assert.equal(bundle.panelStore.getSnapshot(), true);
  assert.equal(revealed.length, 0); // the panel was closed, so it has to mount first
  assert.equal(paths.filter((path) => path === "/bridge/commands").length, 1);
});

test("revealing a session in a panel that is already up never spawns a window", async () => {
  const { bundle, paths, revealed } = await reveal("detached", { panelOpen: true });
  assert.equal(revealed.at(-1), "s1");
  // Not even the setting is read: the surface the user is looking at wins, and
  // an extra round trip would only delay a navigation that is already possible.
  assert.deepEqual(paths, []);
  assert.equal(bundle.panelStore.getSnapshot(), true);
});

// ── 打开, from the detached window ──────────────────────────────────────────
// In 独立弹窗 mode the panel is never mounted on the DSH page — the window *is*
// the explorer — so the bridge handler cannot reach the panel's callback. It
// used to, found nothing, and the request vanished: double-clicking a session in
// the window opened nothing in DSH.

/** Boot the bundle with a bus, a host, and no panel ever mounted. */
async function withPage({ hostBridge, uiWorkspace } = {}) {
  const page = {};
  await withBus(async (sources) => {
    const { document } = makeDom();
    const { bundle, test: api } = loadClientBundle({ document, expose: EXPOSE });
    const host = makeHost({ hostBridge, uiWorkspace });
    host.effect = (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    };
    bundle.apply(host);
    page.bundle = bundle;
    page.api = api;
    page.emit = (command) => {
      sources.at(-1).emit("command", command);
      api.flushBridgeBursts();
    };
  });
  return page;
}

test("a session the window opens is opened in DSH with no panel on the page", async () => {
  const opened = [];
  const page = await withPage({
    uiWorkspace: {
      openSession: (id) => opened.push(id),
      startSession: () => {},
    },
  });
  assert.equal(page.bundle.panelStore.getSnapshot(), false, "no panel is mounted on this page");

  page.emit({ seq: 11, kind: "open-session", payload: { sessionId: "s1" } });

  assert.deepEqual(opened, ["s1"], "DSH was asked to open it");
  // The window is the surface the user is looking at; raising a panel here would
  // cover the main view *and* leave two explorers on screen.
  assert.equal(page.bundle.panelStore.getSnapshot(), false);
});

test("a new session the window starts is started in DSH with no panel on the page", async () => {
  const started = [];
  const page = await withPage({
    uiWorkspace: {
      openSession: () => {},
      startSession: (workspaceId) => started.push(workspaceId),
    },
  });

  page.emit({ seq: 12, kind: "new-session", payload: { workspaceId: "w1" } });

  assert.deepEqual(started, ["w1"]);
  assert.equal(page.bundle.panelStore.getSnapshot(), false);
});

test("the window ignores the open-session it published itself", async () => {
  const opened = [];
  const page = await withPage({
    // `hostBridge` is what makes this document the window.
    hostBridge: { request: async () => null },
    // The window's `uiWorkspace` is the shim's: asking it again would publish
    // the same command back at the page.
    uiWorkspace: { openSession: (id) => opened.push(id), startSession: () => {} },
  });
  assert.ok(page.api.windowHost(), "this document is the window");

  page.emit({ seq: 13, kind: "open-session", payload: { sessionId: "s1" } });

  assert.deepEqual(opened, [], "the window is where the command came from");
});

test("an open this page cannot serve raises the panel that can explain it", async () => {
  // No `uiWorkspace`: an older DSH. Nothing here can navigate, and the panel is
  // the one surface that can say so — so the request is queued for it instead of
  // disappearing.
  const page = await withPage();
  page.emit({ seq: 14, kind: "open-session", payload: { sessionId: "s1" } });
  assert.equal(page.bundle.panelStore.getSnapshot(), true);
});

// ── The store's close reason ───────────────────────────────────────────────
// The window has to tell "the user dismissed this" from "the code stepped
// aside". It cannot infer that from call sites, so the store states it.

test("a panel close states whether the user asked for it", () => {
  const { document } = makeDom();
  const { bundle } = loadClientBundle({ document, expose: EXPOSE });
  const reasons = [];
  bundle.panelStore.subscribe((reason) => reasons.push(reason));

  bundle.panelStore.set(true);
  bundle.panelStore.set(false); // 在 DSH 中打开, a new draft, moving out to the window
  bundle.panelStore.set(true);
  bundle.panelStore.set(false, "user"); // the × button, Escape
  bundle.panelStore.set(true);
  bundle.panelStore.toggle(); // the sidebar entry

  assert.deepEqual(reasons, ["open", "auto", "open", "user", "open", "user"]);
});

