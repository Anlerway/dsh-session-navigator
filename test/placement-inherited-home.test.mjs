/**
 * Unit tests for the `home` stamping shared by every list route.
 *
 *   node --test test/
 *
 * A delegation is drawn in the container its parent sits in, but the sidecar
 * only stores the row the user actually dragged. The client clears placements
 * and re-files rows when a workspace is re-targeted, so it has to know which
 * rows are inherited (write nothing) and which are stored (a real write).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { withHome } from "../src/routes/shared.js";
import { workspaceNodeId } from "../src/domain/tree.js";

const parent = { id: "p1", workspaceId: "wa", parentSession: null, isSubagent: false };
const child = { id: "c1", workspaceId: "wa", parentSession: "p1", isSubagent: true };

test("an inherited home is flagged, a stored one is not", () => {
  const rows = withHome([parent, child], {
    sessionHome: { p1: "d-area", c1: "d-area" },
    sessionPlacement: { p1: "d-area" },
  });
  assert.deepEqual(
    rows.map((row) => [row.id, row.home, row.homeOverride, row.homeInherited]),
    [
      ["p1", "d-area", true, false],
      ["c1", "d-area", false, true],
    ],
  );
});

test("a delegation filed by hand is a stored placement, not an inherited one", () => {
  const rows = withHome([parent, child], {
    sessionHome: { p1: "d-area", c1: "d-side" },
    sessionPlacement: { p1: "d-area", c1: "d-side" },
  });
  const row = rows.find((entry) => entry.id === "c1");
  assert.equal(row.homeOverride, true);
  assert.equal(row.homeInherited, false);
});

test("a delegation sitting beside its parent at the workspace root inherits nothing", () => {
  const rows = withHome([parent, child], {
    sessionHome: { p1: workspaceNodeId("wa"), c1: workspaceNodeId("wa") },
    sessionPlacement: {},
  });
  assert.deepEqual(rows.map((row) => row.homeInherited), [false, false]);
});

test("a fork is not a delegation even when it names a parent", () => {
  const fork = { id: "f1", workspaceId: "wa", parentSession: "p1", isSubagent: false };
  const rows = withHome([parent, fork], {
    sessionHome: { p1: "d-area", f1: "d-area" },
    sessionPlacement: { p1: "d-area" },
  });
  const row = rows.find((entry) => entry.id === "f1");
  assert.equal(row.homeInherited, false, "a fork keeps its own row where DSH puts it");
});
