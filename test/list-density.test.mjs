/**
 * A crowded list scrolls; it never squeezes its rows.
 *
 * The panel shows one workspace's sessions at a time, and a workspace can hold
 * hundreds of them. Two layouts answer that, and only one is honest about what
 * the user is looking at: shrink every row until the whole list fits (which
 * eventually hides the rows past the fold anyway, and changes the meaning of a
 * click), or keep the row a row and let the list scroll. This plugin does the
 * second, and these tests pin the three declarations that make it true, because
 * each one is a single edit away from silently stopping:
 *
 *   - `.listbody` is the only scroller: overflow auto, and no height of its own
 *     (a height would be a second, contradicting opinion about how tall the
 *     list is, and `max-height` would clip rows instead of scrolling them);
 *   - `.row`, `.trow` and `.grp` are `flex:0 0 auto`, so a flex parent under
 *     pressure takes space from the container, never from the row;
 *   - both `min-height:0` links stay in the chain, or the flex child refuses to
 *     shrink and the scrollbar never appears at all.
 *
 *   node --test test/
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const lines = source.split("\n");

/**
 * The declarations of one stylesheet rule, straight from the bundle.
 *
 * The stylesheet is one rule per line, which is what makes this query cheap and
 * exact: `selector + "{"` matches the rule and nothing that merely starts with
 * it (`.row` vs `.row .cell`).
 *
 * @param {string} selector
 * @returns {Set<string>} declarations, e.g. `"flex:0 0 auto"`
 */
function declarations(selector) {
  const line = lines.find((text) => text.startsWith(selector + "{"));
  assert.ok(line, `the stylesheet declares ${selector}`);
  assert.ok(line.endsWith("}"), `${selector} is one full rule on one line`);
  const body = line.slice(selector.length + 1, -1);
  return new Set(
    body
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

const has = (set, declaration) => assert.ok(set.has(declaration), `missing declaration: ${declaration}`);
const lacksPrefix = (set, prefix) => {
  const found = [...set].filter((declaration) => declaration.startsWith(prefix));
  assert.deepEqual(found, [], `no ${prefix} declaration belongs here`);
};

test("the list body is the scroller and nothing else", () => {
  const body = declarations(".se-shell .listbody");
  has(body, "overflow:auto");
  has(body, "min-height:0");
  // A nested scroller inside a page scroller stops the wheel from reaching the
  // page at the end of the list, which reads as a frozen panel.
  has(body, "overscroll-behavior:contain");
  // Height comes from the pane, never from the row count: that is what makes
  // the overflow a scrollbar instead of a clipped row.
  lacksPrefix(body, "height:");
  lacksPrefix(body, "max-height:");
});

test("the flex chain can shrink, so the scrollbar appears", () => {
  // Both links are load-bearing: without min-height:0 a flex child keeps its
  // content height and the .listbody above never overflows.
  has(declarations(".se-shell .body"), "min-height:0");
  // The list pane clips; the body inside it scrolls. Clipping here is what
  // keeps a long list from pushing the command bar off the panel.
  has(declarations(".se-shell .pane-list"), "overflow:hidden");
});

test("rows, tree rows and group headers keep their height under pressure", () => {
  for (const selector of [".se-shell .row", ".se-shell .trow", ".se-shell .grp"]) {
    has(declarations(selector), "flex:0 0 auto");
  }
});

test("row heights stay fixed literals", () => {
  // Not derived from the number of rows, not a calc() over the viewport: a
  // crowded list scrolls at 32px, it does not degrade to 20px.
  has(declarations(".se-shell .row"), "height:32px");
  has(declarations(".se-shell .trow"), "height:26px");
  has(declarations(".se-shell .grp"), "height:30px");
});
