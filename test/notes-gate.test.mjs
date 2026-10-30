/**
 * When the explorer announces 更新说明, and when it stays quiet.
 *
 * The announcement fires at DSH startup, from the sidebar entry, and speaks
 * once per version. A machine that never recorded a version announces too: the
 * first launch is the only time *that* version will ever be new, and the notes
 * are the one place that says what it does.
 *
 * The record of "already delivered" lives on the host (lib/host/notes-seen.js).
 * It used to live in localStorage, which the DSH web GUI defeats by changing
 * port on every launch: a new origin is a new, empty storage, so the notice
 * came back at every start. The tests below cover both the decision (pure) and
 * the record (a real file in a temporary directory).
 *
 * @module test/notes-gate
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadClientBundle } from "./support/client-bundle.mjs";
import { readNotesSeen, writeNotesSeen } from "../lib/host/notes-seen.js";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

const { test: internals } = loadClientBundle({ expose: ["notesDecision"] });

/** A record path in a directory of its own, so tests never share state. */
const scratch = async () => join(await mkdtemp(join(tmpdir(), "notes-seen-")), "notes-seen.v1.json");

test("a version nobody has read yet is announced", () => {
  assert.equal(internals.notesDecision("1.1.0", ""), "announce");
});

test("the same version twice is not news", () => {
  assert.equal(internals.notesDecision("1.1.0", "1.1.0"), "idle");
});

test("a version change is the announcement", () => {
  assert.equal(internals.notesDecision("1.1.0", "1.0.4"), "announce");
});

test("no version to compare says nothing", () => {
  assert.equal(internals.notesDecision("", ""), "idle");
  assert.equal(internals.notesDecision("", "1.0.4"), "idle");
});

test("the record round-trips through one small file", async () => {
  const file = await scratch();
  assert.equal(await readNotesSeen(file), "", "a missing record means nothing delivered");
  assert.equal(await writeNotesSeen(file, "1.1.0"), "1.1.0");
  assert.equal(await readNotesSeen(file), "1.1.0");
  assert.equal(await writeNotesSeen(file, "1.2.0"), "1.2.0");
  assert.equal(await readNotesSeen(file), "1.2.0", "the newest answer wins");
});

test("an empty or non-string version is never written over the real one", async () => {
  const file = await scratch();
  await writeNotesSeen(file, "1.1.0");
  assert.equal(await writeNotesSeen(file, ""), "");
  assert.equal(await writeNotesSeen(file, undefined), "");
  assert.equal(await writeNotesSeen(file, 42), "");
  assert.equal(await readNotesSeen(file), "1.1.0");
});

test("a corrupt record reads as nothing delivered, and the next write repairs it", async () => {
  const file = await scratch();
  await writeFile(file, "{ this is not json", "utf8");
  assert.equal(await readNotesSeen(file), "");
  await writeNotesSeen(file, "1.3.0");
  assert.equal(await readNotesSeen(file), "1.3.0");
});

// The decision above is worth nothing unless both halves are wired to it, and
// neither wire has a runtime test that would notice the other one going away:
// calling the host route with a fake api here would spawn a PowerShell warm-up
// on Windows, and the gate needs a live page. Source-level guards, in the
// spirit of test/panel-copy.test.mjs.
test("the notes route answers which version it belongs to, and which was delivered", () => {
  const source = read("lib/index.js");
  const start = source.indexOf('"GET /release-notes"');
  assert.notEqual(start, -1, "the /release-notes route is gone");
  const body = source.slice(start, source.indexOf("\n  },", start));
  assert.match(body, /version:\s*pluginVersion\(\)/);
  assert.match(body, /seen:\s*await readNotesSeen\(api\.paths\.notesSeen\)/);
});

test("the gate is mounted with the sidebar entry, not with the panel", () => {
  const source = read("lib/client.js");
  const footer = source.slice(source.indexOf("function FooterAction"), source.indexOf("// ── Settings page"));
  assert.match(footer, /h\(NotesGate, \{ t \}\)/, "the announcement no longer mounts at startup");
  const gate = source.slice(source.indexOf("function NotesGate"), source.indexOf("// ── 关于"));
  assert.match(gate, /notesDecision\(data\?\.version, data\?\.seen\)/);
  assert.match(gate, /apiSend\("POST", "\/release-notes\/seen", \{ version: shown\.version \}/);
});

test("nothing about the record is kept in the page", () => {
  const source = read("lib/client.js");
  assert.doesNotMatch(source, /notesSeenVersion|rememberNotesVersion|NOTES_SEEN_KEY/);
});

// The layer is portaled into a click-through root, and a modal nobody can
// click reads as a frozen app. Both halves are one CSS declaration and one
// timer away from regressing silently, so they are pinned here.
test("the layer is not click-through, and does not land on the first frame", () => {
  const source = read("lib/client.js");
  const css = source.slice(source.indexOf(".se-notes{"), source.indexOf(".se-notes-card"));
  assert.match(css, /pointer-events:auto/);
  const gate = source.slice(source.indexOf("function NotesGate"), source.indexOf("// ── 关于"));
  assert.match(gate, /setTimeout\(/, "the announcement fires on the first frame again");
  assert.match(gate, /NOTES_DELAY_MS/);
});
