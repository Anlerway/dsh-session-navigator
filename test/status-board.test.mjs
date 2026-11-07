/**
 * Session states that are still there when the window finally looks.
 *
 * The rows themselves only exist in DSH's renderer, so the page announces them
 * and the Host fans them out. That was enough while the window was opened right
 * after the announcement and nothing else got in the way; two things did:
 *
 *   - the bus drops a command after 30 s and the page stays quiet while nothing
 *     changes, so a window opened later asked into an empty bus and drew no
 *     badges until the next change;
 *   - a background document is throttled by the browser, so an announcement the
 *     page *did* send can arrive minutes late — the badge looked stuck until the
 *     user clicked back into DSH.
 *
 * One cache answers both: the Host keeps the newest snapshot and serves it over
 * `GET /bridge/status`, so the window pulls on a beat instead of only waiting to
 * be pushed, and `status-request` gets the same answer on demand. Ordering is by
 * the snapshot's own timestamp, because push and pull can overtake each other.
 *
 *   node --test test/status-board.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ROUTES } from "../src/index.js";
import { createBridge } from "../src/host/bridge.js";
import { createStatusBoard } from "../src/host/status-board.js";
import { loadClientBundle } from "./support/client-bundle.mjs";

/** A host slice with a controllable clock, so "30 seconds later" is free. */
function makeHost() {
  let clock = 1_000;
  const now = () => clock;
  const bridge = createBridge({ now });
  const statusBoard = createStatusBoard({ now });
  return {
    bridge,
    statusBoard,
    api: { bridge, statusBoard },
    advance: (ms) => {
      clock += ms;
    },
  };
}

const waiting = [{ id: "session-question", running: true, pending: "question", completed: false }];

/** The window's side of the same module. */
function loadWindow() {
  const { test: api } = loadClientBundle({
    expose: ["applyPeerStatus", "readPeerStatus", "peerStatus"],
  });
  return api;
}

// ── the cache ─────────────────────────────────────────────────────────────

test("the board keeps one snapshot, not a history", () => {
  const board = createStatusBoard({ now: () => 42 });
  assert.deepEqual(board.snapshot(), { rows: [], at: 0 }, "nothing announced yet");
  board.set(waiting);
  assert.deepEqual(board.snapshot(), { rows: waiting, at: 42 });
  board.set([]);
  assert.deepEqual(board.snapshot(), { rows: [], at: 42 }, "a state that ends replaces the list");
  board.clear();
  assert.deepEqual(board.snapshot(), { rows: [], at: 0 });
});

test("an announcement is cached and stamped on its way out", async () => {
  const { api, bridge } = makeHost();
  await ROUTES["POST /bridge/commands"](api, { body: { kind: "session-status", payload: { rows: waiting } } });
  const [command] = bridge.since(0);
  assert.equal(command.kind, "session-status");
  assert.deepEqual(command.payload.rows, waiting);
  assert.equal(command.payload.at, 1_000, "the sender's clock, so both carriers agree on order");
  assert.deepEqual(api.statusBoard.snapshot(), { rows: waiting, at: 1_000 });
});

test("a window that asks after the bus forgot the announcement still gets the rows", async () => {
  const { api, bridge, advance } = makeHost();
  await ROUTES["POST /bridge/commands"](api, { body: { kind: "session-status", payload: { rows: waiting } } });
  // The bus keeps commands for 30 s: by the time the user opens 独立窗口 the
  // announcement is gone, and the page has had no reason to repeat itself.
  advance(60_000);
  assert.deepEqual(bridge.since(0), [], "the bus is empty, which is what used to leave the window blank");

  const before = bridge.cursor;
  await ROUTES["POST /bridge/commands"](api, { body: { kind: "status-request", payload: {} } });
  const answers = bridge.since(before).filter((command) => command.kind === "session-status");
  assert.equal(answers.length, 1, "the Host answers the ask itself");
  assert.deepEqual(answers[0].payload.rows, waiting);
  assert.equal(answers[0].payload.at, 1_000);
});

test("a host that never heard an announcement answers nothing", async () => {
  const { api, bridge } = makeHost();
  const before = bridge.cursor;
  await ROUTES["POST /bridge/commands"](api, { body: { kind: "status-request", payload: {} } });
  assert.equal(bridge.since(before).filter((command) => command.kind === "session-status").length, 0);
});

test("the pull route serves the same snapshot the ask would have", async () => {
  const { api } = makeHost();
  assert.deepEqual(await ROUTES["GET /bridge/status"](api), { rows: [], at: 0, cursor: 0 });
  await ROUTES["POST /bridge/commands"](api, { body: { kind: "session-status", payload: { rows: waiting } } });
  const pulled = await ROUTES["GET /bridge/status"](api);
  assert.deepEqual(pulled.rows, waiting);
  assert.equal(pulled.at, 1_000);
  assert.equal(pulled.cursor, 1, "the reader can tell how far the bus has moved");
});

// ── the window ────────────────────────────────────────────────────────────

test("a snapshot that arrives late cannot overwrite a newer one", () => {
  const api = loadWindow();
  const newer = [{ id: "session-question", running: true, pending: "approval", completed: false }];
  assert.equal(api.applyPeerStatus(newer, 2_000), true);
  // The same rows over the slower carrier, from before: waiting is over.
  assert.equal(api.applyPeerStatus(waiting, 1_500), false);
  assert.equal(api.peerStatus.get("session-question").pendingInteraction, "approval");

  // And an equal timestamp is the same announcement, not newer news.
  assert.equal(api.applyPeerStatus(waiting, 2_000), true);
  assert.equal(api.peerStatus.get("session-question").pendingInteraction, "question");
});

test("a same-process announcement carries no timestamp and still applies", () => {
  const api = loadWindow();
  assert.equal(api.applyPeerStatus(waiting), true);
  assert.equal(api.peerStatus.get("session-question").pendingInteraction, "question");
});
