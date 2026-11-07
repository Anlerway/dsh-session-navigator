/**
 * A click that needs the Electron component answers with the installer.
 *
 * 独立窗口 used to answer with a sentence — "go to 设置 → 会话资源管理器 →
 * Electron 组件" — for a component the panel can download itself. The fix is a
 * dialog that draws the same ComponentPanel the settings page draws, against the
 * same /component/* routes, so there is one installer and one set of words.
 *
 * What these tests pin:
 *
 *   1. 默认打开方式 = 独立弹窗, component missing: launchExplorer opens the panel
 *      dialog instead of leaving only a hint string behind. The dialog is a real
 *      body (a settings group with a 下载组件 chip), not a message.
 *   2. The dialog's body is the settings page's own ComponentPanel — the same
 *      component type, so a change to the installer cannot make the two drift.
 *   3. 打开独立窗口 inside the dialog closes it before the caller steps the
 *      panel aside; a finished question must not stay on top of the answer.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle, recordingFetch } from "./support/client-bundle.mjs";

const EXPOSE = ["launchExplorer", "dialogStore", "openComponentDialog", "ComponentPanel", "ComponentGroup", "ST"];

/** Walk a rendered tree, compiling nothing: only elements and text. */
function texts(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (typeof node.children !== "undefined") texts(node.children, out);
  return out;
}

/** The first element whose type is `tag` and whose children read `label`. */
function findButton(node, label) {
  if (node === null || node === undefined) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, label);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  if (node.type === "button" && texts(node.children).join("") === label) return node;
  return findButton(node.children, label);
}

/** A fetch that answers 独立弹窗 mode and refuses /detached/open as missing. */
function missingComponentFetch() {
  return recordingFetch((call) => {
    const path = call.url.replace("/session-navigator/api", "");
    if (call.method === "GET" && path === "/settings") {
      return { ok: true, result: { settings: { shell: { open: { mode: "detached" } } } } };
    }
    if (call.method === "POST" && path === "/detached/open") {
      return { ok: false, code: "component-not-installed", error: "Electron component is not installed" };
    }
    return { ok: true, result: {} };
  });
}

test("a missing component opens the installer, not a hint", async () => {
  const { test: api } = loadClientBundle({ expose: EXPOSE, fetch: missingComponentFetch() });
  await api.launchExplorer();

  const dialog = api.dialogStore.getSnapshot();
  assert.equal(dialog?.kind, "panel", "the launch must answer with a panel dialog");
  assert.equal(dialog.wide, true, "the installer needs the width of a settings card");
  assert.equal(dialog.title, api.ST("setGroupComponent"));

  const body = dialog.render();
  assert.equal(body?.type, "div");
  assert.match(String(body.props.className), /se-set-grp/);
  const panel = body.children.find((child) => child && child.type === api.ComponentPanel);
  assert.ok(panel, "the body is the settings page's ComponentPanel");
  assert.equal(typeof panel.type, "function");

  // Render the panel with the harness' hook stubs: no status loaded yet, so it
  // must offer 下载组件 (the same chip the settings page offers) and a scan.
  const tree = api.ComponentPanel(panel.props);
  assert.ok(findButton(tree, api.ST("setCompDownload")), "the dialog offers the download");
  assert.ok(findButton(tree, api.ST("setCompScan")), "the dialog offers the borrow-a-runtime scan");
  // No status has loaded (the harness stubs effects), so the panel must say so
  // in the settings page's own words rather than in panel-only copy.
  assert.ok(texts(tree).join(" ").includes(api.ST("setCompStatus")), "the status row speaks the settings words");

  // The launch still falls back to 浮窗 underneath the dialog, and it does not
  // leave the old sentence in the panel's hint slot.
  assert.equal(api.peekLaunchHint?.() ?? "", "");
});

test("opening the window settles the dialog before the caller hides the panel", async () => {
  const order = [];
  const { test: api } = loadClientBundle({ expose: EXPOSE });
  const original = api.dialogStore.settle;
  api.dialogStore.settle = (value) => {
    order.push("settle");
    return original(value);
  };
  api.openComponentDialog({ onOpened: () => order.push("opened") });

  const dialog = api.dialogStore.getSnapshot();
  const panel = dialog.render().children.find((child) => child && child.type === api.ComponentPanel);
  await panel.props.onOpened();

  assert.deepEqual(order, ["settle", "opened"]);
  assert.equal(api.dialogStore.getSnapshot(), null);
});

test("the settings page still draws the installer under its own caption", () => {
  const { test: api } = loadClientBundle({ expose: EXPOSE });
  const group = api.ComponentGroup({ t: api.ST });
  assert.equal(group.type, "div");
  assert.match(String(group.props.className), /se-set-grp/);
  assert.ok(group.children.some((child) => child && child.type === api.ComponentPanel));
  assert.equal(group.children[0].props.className, "se-set-h");
});

