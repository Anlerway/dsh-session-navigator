/**
 * The badge a row wears while a turn is winding down.
 *
 * Answering a question and the turn actually stopping are announced by two
 * different things — the page's status snapshot drops the pending question the
 * moment it is answered, the running flag clears when the agent is done — so
 * the row used to walk 等待回答 → 进行中 → 空闲 inside a single glance. The middle
 * step was true for a few hundred milliseconds and was never the answer.
 *
 * These tests pin the hold that skips it: a question that was just answered
 * keeps its badge until the turn has had time to report itself, and then gets
 * out of the way.
 *
 *   node --test test/status-linger.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle } from "./support/client-bundle.mjs";

function load() {
  const { test: api } = loadClientBundle({
    expose: ["applyPeerStatus", "statusOf", "PENDING_LINGER_MS"],
  });
  return api;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The row as `withDshStatus` would hand it to `statusOf`. */
const row = (pending, running) => ({ id: "s1", dsh: { pending, running } });

test("an answered question is not held over a row the page calls live", () => {
  const api = load();
  api.applyPeerStatus([{ id: "s1", pending: "question", running: true }], 1_000);
  assert.equal(api.statusOf(row("question", true)).cls, "warn", "the question is what is drawn while it is asked");

  // Answered, and the row still says it is working: the page has spoken, so
  // the old badge must not be drawn on top of it — that is the flash the hold
  // was added to remove, facing the other way.
  api.applyPeerStatus([{ id: "s1", running: true }], 1_010);
  assert.equal(api.statusOf(row(null, true)).cls, "run", "a row the page still calls live says so");
});

test("the hold covers a row that goes quiet without saying why", () => {
  const api = load();
  api.applyPeerStatus([{ id: "s1", pending: "question", running: true }], 1_100);
  // Answered and stopped in the same breath, which is the ordinary case: the
  // question is gone before the turn has had time to report that it ended.
  api.applyPeerStatus([{ id: "s1", running: false }], 1_110);
  assert.equal(api.statusOf(row(null, false)).cls, "warn", "answered-then-stopped keeps the question, not 进行中");
});

test("a row the page dropped altogether is held too", () => {
  const api = load();
  api.applyPeerStatus([{ id: "s1", pending: "approval" }], 2_000);
  // The page has nothing left to say about this session: its row is gone.
  api.applyPeerStatus([], 2_010);
  assert.equal(api.statusOf(row(null, false)).cls, "warn");
});

test("the hold ends when the turn has had time to speak", async () => {
  const api = load();
  api.applyPeerStatus([{ id: "s1", pending: "question", running: true }], 3_000);
  api.applyPeerStatus([{ id: "s1", running: true }], 3_010);
  await sleep(api.PENDING_LINGER_MS + 80);
  assert.equal(api.statusOf(row(null, true)).cls, "run", "a turn that is still going says so");
});

test("a turn that stopped during the hold lands on 空闲, not on 进行中", async () => {
  const api = load();
  api.applyPeerStatus([{ id: "s1", pending: "question", running: true }], 4_000);
  api.applyPeerStatus([{ id: "s1", running: false }], 4_010);
  await sleep(api.PENDING_LINGER_MS + 80);
  assert.equal(api.statusOf(row(null, false)).cls, "", "straight from the question to the end, with no 进行中 in between");
});

test("another session is not held by a neighbour's question", () => {
  const api = load();
  api.applyPeerStatus([{ id: "s1", pending: "question", running: true }], 5_000);
  api.applyPeerStatus([{ id: "s2", running: true }], 5_010);
  const other = api.statusOf({ id: "s2", dsh: { pending: null, running: true } });
  assert.equal(other.cls, "run");
});
