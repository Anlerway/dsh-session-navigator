/**
 * Session states across two processes.
 *
 * The panel knows which session is running, which one waits for an approval and
 * which finished unread — it reads `uiSession.sessionStatus`. The detached window
 * does not: it is a second Electron process, its `uiSession` is the shim's stub,
 * and a BroadcastChannel never leaves the process it was created in. The badges
 * therefore only ever appeared in the panel.
 *
 * What both surfaces do share is the Host, so the rows travel there: the page
 * announces them (`session-status`), a window that opens late asks for them
 * (`status-request`), and the route rebuilds the array before fanning it out.
 *
 *   node --test test/session-status.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeStatusRows } from "../lib/host/bridge.js";
import { loadClientBundle } from "./support/client-bundle.mjs";

/** The slice of a DSH page the bundle needs at definition time. */
function load() {
  const { bundle, test: api, fetch } = loadClientBundle({
    expose: ["statusRowsOf", "publishStatusSnapshot", "applyPeerStatus", "readPeerStatus", "peerStatus"],
  });
  bundle.apply({
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: () => () => {}, register: () => () => {} },
    effect: () => () => {},
    get: () => undefined,
  });
  return { api, fetch };
}

/** DSH's own entry shape: an interaction object, not a bare string. */
const waitingForApproval = { running: true, pendingInteraction: { kind: "approval" }, completionUnread: false };
const waitingForAnswer = { running: true, pendingInteraction: "question", completionUnread: false };
const finishedUnread = { running: false, pendingInteraction: null, completionUnread: true };
const idle = { running: false, pendingInteraction: null, completionUnread: false };

test("the projection keeps the states a badge can be drawn from, and nothing else", () => {
  const { api } = load();
  const rows = api.statusRowsOf(
    new Map([
      ["session-approval", waitingForApproval],
      ["session-question", waitingForAnswer],
      ["session-done", finishedUnread],
      ["session-idle", idle],
    ]),
  );
  assert.deepEqual(rows, [
    { id: "session-approval", running: true, pending: "approval", completed: false },
    { id: "session-question", running: true, pending: "question", completed: false },
    { id: "session-done", running: false, pending: null, completed: true },
  ]);
});

test("a document without the service projects nothing", () => {
  const { api } = load();
  assert.deepEqual(api.statusRowsOf(null), []);
  assert.deepEqual(api.statusRowsOf(undefined), []);
  assert.deepEqual(api.statusRowsOf(new Map()), []);
});

test("an announcement goes out on the bus the window can hear", async () => {
  const { api, fetch } = load();
  const rows = api.statusRowsOf(new Map([["session-approval", waitingForApproval]]));
  assert.equal(api.publishStatusSnapshot(rows), true);

  // sendBridgeCommand is fire-and-forget; give its promise a turn.
  await new Promise((resolve) => setImmediate(resolve));
  const handed = fetch.calls.filter((call) => call.url.endsWith("/bridge/commands"));
  assert.equal(handed.length, 1, "one command, not one per listener");
  assert.equal(handed[0].method, "POST");
  assert.equal(handed[0].body.kind, "session-status");
  assert.deepEqual(handed[0].body.payload.rows, rows);
});

test("nothing is announced before the first snapshot", () => {
  const { api, fetch } = load();
  // A window asks for the rows; this document has never had them (the service
  // was injected after it loaded), so it answers nothing instead of 「全部空闲」.
  assert.equal(api.publishStatusSnapshot(), false);
  assert.deepEqual(fetch.calls, []);
});

test("a repaint that changed nothing is not announced twice", async () => {
  const { api, fetch } = load();
  const rows = api.statusRowsOf(new Map([["session-approval", waitingForApproval]]));
  assert.equal(api.publishStatusSnapshot(rows), true);
  // The same snapshot arrives again from the other publishing path — the hook
  // and the apply-level subscription both fire. The bus holds only 64 commands.
  assert.equal(api.publishStatusSnapshot(api.statusRowsOf(new Map([["session-approval", waitingForApproval]]))), false);
  assert.equal(api.publishStatusSnapshot(), false, "a later request is answered from the stored rows, not re-sent as news");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetch.calls.filter((call) => call.url.endsWith("/bridge/commands")).length, 1);

  // A real change does go out.
  assert.equal(api.publishStatusSnapshot(api.statusRowsOf(new Map([["session-approval", waitingForAnswer]]))), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetch.calls.filter((call) => call.url.endsWith("/bridge/commands")).length, 2);
});

test("an ask is answered even when the answer has not changed", async () => {
  const { api, fetch } = load();
  api.publishStatusSnapshot(api.statusRowsOf(new Map([["session-approval", waitingForApproval]])));
  // A window opened half a minute later: the earlier command has aged out of the
  // bus and the page has had no reason to publish since. The ask is the only
  // thing that makes the rows arrive there, so it cannot be deduped away.
  assert.equal(api.publishStatusSnapshot(undefined, true), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetch.calls.filter((call) => call.url.endsWith("/bridge/commands")).length, 2);
});

test("the window applies what the route lets through, end to end", () => {
  const { api } = load();
  // The route's shape, not the sender's: sanitised rows are what arrives.
  const rows = normalizeStatusRows([
    { id: "session-approval", running: true, pending: "approval", completed: false },
    { id: "session-answer", running: true, pending: "question", completed: false },
    { id: "session-done", running: false, pending: null, completed: true },
  ]);
  const before = api.readPeerStatus();
  api.applyPeerStatus(rows);
  assert.ok(api.readPeerStatus() > before, "the version bump is what re-renders the list");

  const applied = api.peerStatus;
  assert.equal(applied.get("session-approval").pendingInteraction, "approval");
  assert.equal(applied.get("session-answer").pendingInteraction, "question");
  assert.equal(applied.get("session-done").completionUnread, true);
});

test("a state that ends clears itself out of the window", () => {
  const { api } = load();
  api.applyPeerStatus([{ id: "session-approval", running: true, pending: "approval", completed: false }]);
  assert.equal(api.peerStatus.get("session-approval").pendingInteraction, "approval");
  // The next snapshot simply does not contain it — that is how the badge goes
  // away again, with no tombstone to misunderstand.
  api.applyPeerStatus([]);
  assert.equal(api.peerStatus.size, 0);
});
