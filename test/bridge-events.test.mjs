/**
 * What the two documents hear from each other.
 *
 * The panel and the detached window draw the same tree from one payload, but
 * they run in two processes and neither sees the other's requests. The Host's
 * bus is the only thing both can hear, so these tests pin its two additions:
 * a write announces itself to the *other* document (`changed`), and a palette
 * change reaches a window that is already open (`theme-changed`).
 *
 * The negative half matters as much as the positive one: a broadcast on every
 * read, or on every palette report, is a reload loop, and the panel reports on
 * each class mutation of the document element.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ROUTES, announceWrite } from "../lib/index.js";
import { createBridge, normalizeCommand, normalizeStatusRows, WINDOW_COMMANDS } from "../lib/host/bridge.js";
import { createThemeStore } from "../lib/host/theme.js";

/** A bus that records what was published instead of keeping a ring buffer. */
function recordingBridge() {
  /** @type {{ kind: string, payload: unknown }[]} */
  const published = [];
  return {
    published,
    listeners: 0,
    publish(kind, payload) {
      published.push({ kind, payload });
      return { seq: published.length, kind, payload };
    },
  };
}

/** The slice of the plugin api `POST /theme` touches. */
function themeApi() {
  const bridge = recordingBridge();
  const theme = createThemeStore();
  return { bridge, theme, api: { bridge, theme } };
}

// ── the write announcement ────────────────────────────────────────────────

test("a write announces itself with the route that matched", () => {
  const bridge = recordingBridge();
  assert.equal(announceWrite({ bridge }, "/folders", "POST"), true);
  assert.deepEqual(bridge.published, [{ kind: "changed", payload: { path: "/folders", method: "POST" } }]);
});

test("a read announces nothing", () => {
  const bridge = recordingBridge();
  assert.equal(announceWrite({ bridge }, "/bootstrap", "GET"), false);
  assert.equal(announceWrite({ bridge }, "/bootstrap", "HEAD"), false);
  assert.deepEqual(bridge.published, []);
});

test("the polled and the self-reloading routes stay quiet", () => {
  const bridge = recordingBridge();
  // Each of these is either polled while it runs (the downloader, the indexer,
  // the summariser), reloads the page itself (migration), or is the bus: a
  // broadcast from them would have every listener reload for nothing.
  for (const path of [
    "/theme",
    "/bridge/commands",
    "/component/install",
    "/component/remove",
    "/detached/open",
    "/detached/close",
    "/datadir/migrate",
    "/search/index/rebuild",
    "/search/index/clear",
    "/summarize",
    "/summarize/cancel",
    "/cache/clear",
    "/update",
    "/about/open",
    "/release-notes/seen",
  ]) {
    assert.equal(announceWrite({ bridge }, path, "POST"), false, path + " stays off the bus");
  }
  assert.deepEqual(bridge.published, []);
});

test("a write that already succeeded is not failed by a dead bus", () => {
  const bridge = {
    publish() {
      throw new Error("listener blew up");
    },
  };
  assert.equal(announceWrite({ bridge }, "/tags", "POST"), false);
});

test("the theme route announces a palette that moved, and only then", async () => {
  const { api, bridge } = themeApi();

  const first = await ROUTES["POST /theme"](api, { body: { mode: "dark", tokens: { "--dsw-alias-label-primary": "#f5f6f7" } } });
  assert.equal(first.mode, "dark");
  assert.deepEqual(bridge.published, [{ kind: "theme-changed", payload: { mode: "dark" } }], "the window has to hear about the first palette");

  // The panel re-reports whenever the document element's classes change — the
  // same palette, over and over. That must not repaint the window.
  bridge.published.length = 0;
  const again = await ROUTES["POST /theme"](api, { body: { mode: "dark", tokens: { "--dsw-alias-label-primary": "#f5f6f7" } } });
  assert.equal(again.mode, "dark");
  assert.deepEqual(bridge.published, [], "an unchanged palette is not news");

  // A value that moves inside the same mode is news: a theme can change colour
  // without switching between light and dark.
  await ROUTES["POST /theme"](api, { body: { mode: "dark", tokens: { "--dsw-alias-label-primary": "#ffffff" } } });
  assert.deepEqual(bridge.published, [{ kind: "theme-changed", payload: { mode: "dark" } }]);
});

// ── the command bus ───────────────────────────────────────────────────────

test("a command reports how many documents were listening", async () => {
  const bridge = createBridge();
  const stop = bridge.subscribe(() => {});
  assert.deepEqual(await ROUTES["POST /bridge/commands"]({ bridge }, { body: { kind: "open-settings" } }), {
    seq: 1,
    kind: "open-settings",
    listeners: 1,
  });
  stop();
  // Nobody left: the window counts itself, so the answer tells it the request
  // went nowhere and it can say so instead of 已在 DSH 主窗口打开.
  const silent = await ROUTES["POST /bridge/commands"]({ bridge }, { body: { kind: "open-settings" } });
  assert.equal(silent.listeners, 0);
});

test("the language travels as a code, never as a sentence", () => {
  assert.ok(WINDOW_COMMANDS.includes("lang-changed"), "the panel may tell the window about a switch");
  assert.deepEqual(normalizeCommand({ kind: "lang-changed", payload: { lang: "en" } }), {
    kind: "lang-changed",
    payload: { lang: "en" },
  });
  assert.deepEqual(normalizeCommand({ kind: "lang-changed", payload: { lang: "fr" } }), { kind: "lang-changed", payload: {} });
  assert.deepEqual(normalizeCommand({ kind: "lang-changed", payload: { lang: "zh", html: "<b>" } }), {
    kind: "lang-changed",
    payload: { lang: "zh" },
  });
});

// ── session states ────────────────────────────────────────────────────────

test("session states travel as rows, and the route rebuilds them", async () => {
  const bridge = createBridge();
  const heard = [];
  bridge.subscribe((command) => heard.push(command));

  assert.ok(WINDOW_COMMANDS.includes("session-status"), "the page may announce states");
  assert.ok(WINDOW_COMMANDS.includes("status-request"), "kept as the cache's on-demand entry");

  const sent = await ROUTES["POST /bridge/commands"]({ bridge }, {
    body: {
      kind: "session-status",
      payload: {
        rows: [
          { id: "session-a", running: true, pending: "approval", completed: false, title: "not part of the row" },
          { id: "session-b", running: false, pending: "question", completed: true },
        ],
      },
    },
  });
  assert.equal(sent.kind, "session-status");
  assert.deepEqual(heard[0].payload.rows, [
    { id: "session-a", running: true, pending: "approval", completed: false },
    { id: "session-b", running: false, pending: "question", completed: true },
  ]);

  // The ask carries nothing to say.
  assert.deepEqual(normalizeCommand({ kind: "status-request" }), { kind: "status-request", payload: {} });
  assert.deepEqual(normalizeCommand({ kind: "status-request", payload: { rows: [{ id: "x", running: true }] } }), {
    kind: "status-request",
    payload: {},
  });
});

test("a status row that would draw a wrong badge is dropped, not repaired", () => {
  // An unknown kind of waiting is not translated into a known one: guessing is
  // how a session that is doing nothing ends up labelled 等待审批.
  assert.deepEqual(normalizeStatusRows([{ id: "session-a", running: false, pending: "approval-ish", completed: false }]), []);
  // Running is a fact of its own, so the row survives with no pending kind.
  assert.deepEqual(normalizeStatusRows([{ id: "session-a", running: true, pending: "approval-ish" }]), [
    { id: "session-a", running: true, pending: null, completed: false },
  ]);
  // No id: nothing to apply the row to.
  assert.deepEqual(normalizeStatusRows([{ running: true, pending: "approval" }]), []);
  // Not even an object.
  assert.deepEqual(normalizeStatusRows([null, "session-a", 42]), []);
  // Not an array at all.
  assert.deepEqual(normalizeStatusRows({ id: "session-a", running: true }), []);
  assert.deepEqual(normalizeStatusRows(undefined), []);
  // A truthy non-boolean is not a boolean: only `true` means running.
  assert.deepEqual(normalizeStatusRows([{ id: "session-a", running: "yes" }]), []);
});

test("the rows are bounded in size as well as in number", () => {
  const long = normalizeStatusRows([{ id: "s".repeat(400), running: true }]);
  assert.equal(long[0].id.length, 200);

  const many = Array.from({ length: 600 }, (_unused, index) => ({ id: "session-" + index, running: true }));
  assert.equal(normalizeStatusRows(many).length, 500, "the cap is the same one the page applies");
});
