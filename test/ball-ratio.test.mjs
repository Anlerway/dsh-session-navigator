/**
 * The floating ball's remembered spot, as a fraction rather than a pixel.
 *
 * A pixel spot pins the ball to a column that only exists on the screen it was
 * dragged on. The bundle stores (and re-applies) a ratio of the distance the
 * ball can travel, so a resized window keeps it in the same place in the layout
 * and a window too small for that fraction still keeps the whole ball on screen.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadClientBundle } from "./support/client-bundle.mjs";

test("a resized window keeps the ball at the same place in the layout", () => {
  const { test: api } = loadClientBundle({ expose: ["ratioOf", "spotOf", "clampBall"] });
  const previousWidth = globalThis.window.innerWidth;
  const previousHeight = globalThis.window.innerHeight;
  try {
    // Half way along both axes of a 1280×800 window: the travel is 1200 × 720.
    const ratio = api.ratioOf({ left: 608, top: 368 });
    assert.equal(Math.round(ratio.x * 1e6) / 1e6, 0.5, "half of 1200px of travel");
    assert.equal(Math.round(ratio.y * 1e6) / 1e6, 0.5, "half of 720px of travel");
    // The same fraction in a bigger window is half way there too, instead of
    // staying on the pixel column it was left on.
    globalThis.window.innerWidth = 1920;
    globalThis.window.innerHeight = 1080;
    assert.deepEqual(api.spotOf(ratio), { left: 928, top: 508 }, "half of 1840 × 1000");
    // A window too small for the fraction still keeps the whole ball on screen.
    globalThis.window.innerWidth = 200;
    globalThis.window.innerHeight = 140;
    assert.deepEqual(api.spotOf({ x: 1, y: 1, scalable: true }), { left: 128, top: 68 });
    // No layout at all (unit tests, SSR) leaves the spot in pixels rather than
    // dividing by a zero travel and snapping the ball to the corner.
    assert.equal(api.ratioOf({ left: 630, top: 410 }).scalable, true, "a real window scales");
    assert.equal(api.spotOf({ x: 0.5, y: 0.5, scalable: false }), null);
  } finally {
    globalThis.window.innerWidth = previousWidth;
    globalThis.window.innerHeight = previousHeight;
  }
});

