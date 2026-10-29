/**
 * 双击要有时限 (m01775).
 *
 * A double click used to be whatever the browser said it was, and the browser
 * asks the OS: with a slow double-click speed set, two leisurely presses on a
 * session row still counted and opened the session in DSH. Opening a session is
 * an expensive accident while the user was only picking rows, so the count is
 * the panel's own — same target, both presses inside DOUBLE_CLICK_MS.
 *
 * The clock is a parameter, so these assertions do not depend on how fast the
 * test machine runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadClientBundle } from "./support/client-bundle.mjs";

const { test: api } = loadClientBundle({ expose: ["countsAsDoublePress", "DOUBLE_CLICK_MS"] });

test("two presses on the same row inside the window are a double click", () => {
  assert.equal(api.countsAsDoublePress("session:a", 1000), false);
  assert.equal(api.countsAsDoublePress("session:a", 1000 + api.DOUBLE_CLICK_MS), true);
});

test("a slow pair is two single clicks", () => {
  assert.equal(api.countsAsDoublePress("session:a", 1000), false);
  assert.equal(api.countsAsDoublePress("session:a", 1000 + api.DOUBLE_CLICK_MS + 1), false);
  // …and the slow second press is not remembered as the start of a new pair by
  // accident: the pair begins where the last press landed.
  assert.equal(api.countsAsDoublePress("session:a", 1000 + api.DOUBLE_CLICK_MS + 60), true);
});

test("presses on two different rows never pair up", () => {
  assert.equal(api.countsAsDoublePress("session:a", 1000), false);
  assert.equal(api.countsAsDoublePress("session:b", 1010), false);
  assert.equal(api.countsAsDoublePress("session:b", 1020), true);
});

test("a double click spends the pair, so a third press starts over", () => {
  assert.equal(api.countsAsDoublePress("node:d-1", 1000), false);
  assert.equal(api.countsAsDoublePress("node:d-1", 1010), true);
  assert.equal(api.countsAsDoublePress("node:d-1", 1020), false, "a third press is a new single click");
  assert.equal(api.countsAsDoublePress("node:d-1", 1030), true, "and it can start a new pair");
});

test("an unnamed target never counts", () => {
  assert.equal(api.countsAsDoublePress("", 1000), false);
  assert.equal(api.countsAsDoublePress("", 1010), false);
});
