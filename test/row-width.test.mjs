// 行宽裁剪: a row stops where its last column stops, so the pane to its right
// is blank space — a press there clears the selection instead of landing on a
// row that only looked empty. The width is one hand-written calc, and the two
// ways it drifts from the column rules are exactly the ways this breaks: a
// column that is drawn but missing from the sum (the row ends mid-column), and
// a column a narrow mode hides but the sum still counts (the row ends in blank
// space inside itself). These tests read panel.css and compare the two.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Comments are stripped first: a comment above a rule may well mention
// data-cw="mid" while explaining it, and a rule must not be classified by what
// the prose around it says.
const CSS = (await readFile(join(here, "..", "assets", "panel.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `.col-x` that claims width through a `--w-x` variable, as class → var. */
function columnVars() {
  const map = new Map();
  for (const [, col, name] of CSS.matchAll(/\.se-shell \.col-([a-z]+)\{[^}]*?var\(--w-([a-z]+)\)/g)) map.set(col, name);
  return map;
}

/** The columns each pane width mode hides, straight from the display:none rule. */
function hiddenColumns() {
  const modes = new Map([["full", new Set()]]);
  for (const [, mode, col] of CSS.matchAll(/\.pane-list\[data-cw="([a-z]+)"\] \.col-([a-z]+)\{display:none\}/g)) {
    if (!modes.has(mode)) modes.set(mode, new Set());
    modes.get(mode).add(col);
  }
  return modes;
}

/** The `--list-w` each mode declares, as the set of columns its calc names. */
function listWidths() {
  const found = new Map();
  for (const [, selector, body] of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!body.includes("--list-w:calc(")) continue;
    const calc = /--list-w:calc\(([^}]*)\)/.exec(body)?.[1] ?? "";
    const mode = /data-cw="([a-z]+)"/.exec(selector)?.[1] ?? "full";
    // --w-name-used is the name column plus the 110px floor it enforces, so for
    // this comparison it is the name column under another name.
    const named = [...calc.matchAll(/--w-([a-z]+)/g)].map(([, name]) => (name === "name-used" ? "name" : name));
    found.set(mode, { calc, columns: new Set(named) });
  }
  return found;
}

test("every column the row draws is in the row width, and nothing else is", () => {
  const cols = columnVars();
  const hidden = hiddenColumns();
  const widths = listWidths();
  assert.ok(cols.has("name") && cols.has("status"), "column width variables stopped being readable");
  for (const [mode, gone] of hidden) {
    const width = widths.get(mode);
    assert.ok(width, `no --list-w for the ${mode} pane width`);
    const drawn = new Set([...cols.keys()].filter((col) => !gone.has(col)));
    // --w-check has no .col-check width rule of its own: the header cell sets it,
    // the row cell inherits it, and it is always drawn.
    drawn.add("check");
    assert.deepEqual([...width.columns].sort(), [...drawn].sort(), `--list-w (${mode}) does not name the drawn columns`);
  }
});

test("the row width ends with the padding the row actually carries", () => {
  const full = listWidths().get("full").calc;
  const rowPadding = /\.se-shell \.row\{[^}]*padding-right:(\d+)px/.exec(CSS)?.[1];
  assert.equal(rowPadding, "12", "the row's right padding moved; the width calc adds it");
  assert.match(full.trim(), /\+ 12px$/, "the width calc must add the row's right padding");
});

test("the name column's floor is inside the sum, not beside it", () => {
  // The drag clamp allows 64px, CSS enforces 110px: the sum follows what is
  // drawn, so a 64px stored width must not shorten the row by 46px.
  assert.match(CSS, /\.se-shell \.col-name\{[^}]*min-width:110px/);
  assert.match(CSS, /--w-name-used:max\(110px, var\(--w-name\)\)/);
});

test("rows and their placeholders share the width, and the icon view is untouched", () => {
  assert.match(CSS, /\.se-shell:not\(\[data-view="icons"\]\) \.pane-list \.row,\s*\n\.se-shell:not\(\[data-view="icons"\]\) \.pane-list \.rowph\{width:var\(--list-w\)\}/);
  // The icon view sizes its own cards; a trimmed list row there would collapse
  // the tile layout the .row[data-view="icons"] block builds.
  assert.match(CSS, /\.se-shell\[data-view="icons"\] \.row\{[\s\S]*?width:232px/);
});
