/**
 * What the window actually asked for, and what it drew.
 *
 * A badge that flickers is a sequence spread over three carriers — the Host's
 * push, the status board pull, and the page's answer to `status-request` — and
 * which one arrived last is not visible from the code. The window also has no
 * devtools anyone will open. So the Host keeps two rings: one entry per bridge
 * request, and whatever trace the window ships back on its own beat, served
 * together by `GET /bridge/diag`.
 *
 *   node --test test/status-trace.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ROUTES } from "../lib/index.js";
import { createBridge } from "../lib/host/bridge.js";
import { createStatusBoard } from "../lib/host/status-board.js";

function makeApi() {
  return { bridge: createBridge({}), statusBoard: createStatusBoard({}) };
}

/** Enough of a response for the routes that write one. */
const res = { setHeader() {}, write() {}, end() {}, flushHeaders() {} };

test("每次读取都留一条记录，diag 读得回来", async () => {
  const api = makeApi();
  const before = await ROUTES["GET /bridge/diag"](api);
  // The rings are handed over by reference, so the counts are taken as numbers
  // now: reading `before.probe.status.length` after the calls would read the
  // same array the calls appended to.
  const statusCalls = before.probe.status.length;
  const pollCalls = before.probe.poll.length;

  await ROUTES["GET /bridge/status"](api, { headers: {} }, res);
  await ROUTES["GET /bridge/poll"](api, { headers: {} }, res, new URLSearchParams("since=0"));

  const after = await ROUTES["GET /bridge/diag"](api);
  assert.equal(after.probe.status.length, statusCalls + 1, "the window's pull is counted");
  assert.equal(after.probe.poll.length, pollCalls + 1, "the fallback poll is counted");
  assert.equal(typeof after.now, "number");
  assert.equal(typeof after.listeners, "number");
  assert.equal(typeof after.cursor, "number");
  assert.deepEqual(Object.keys(after.board).sort(), ["at", "rows"]);
});

test("窗口上报的 trace 被保留，垃圾丢掉", async () => {
  const api = makeApi();
  const before = (await ROUTES["GET /bridge/diag"](api)).trace.length;

  const written = await ROUTES["POST /bridge/trace"](api, {
    body: { entries: [{ n: 1, event: "peer" }, null, "x", { n: 2, event: "draw" }] },
  });
  assert.deepEqual(written, { kept: before + 2 }, "two entries survive, two are not entries");

  const diag = await ROUTES["GET /bridge/diag"](api);
  assert.deepEqual(
    diag.trace.slice(before).map((entry) => entry.n),
    [1, 2],
    "the ring keeps the order the window drew in",
  );
});

test("上报可以不带 body，不抛错", async () => {
  const api = makeApi();
  const before = (await ROUTES["GET /bridge/diag"](api)).trace.length;
  const written = await ROUTES["POST /bridge/trace"](api, {});
  assert.deepEqual(written, { kept: before });
});
