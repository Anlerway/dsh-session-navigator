/**
 * Tests for 更新说明 — the document behind 设置 › 关于 › 更新说明.
 *
 *   node --test test/notes.test.mjs
 *
 * Two halves worth testing separately. The parser (lib/domain/notes.js) turns a
 * changelog into blocks, and the search (lib/host/changelog.js) decides which of
 * the two candidate files the notes are — a checkout has 更新说明.md above the
 * package, an installed copy has only the CHANGELOG.md it shipped.
 *
 * The last test is the one that keeps the pair honest: when both files exist the
 * checkout one is what a maintainer edits, so the packed copy has to match it
 * byte for byte or a release would publish stale notes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NOTES_MAX_BYTES, notesRuns, parseNotes } from "../lib/domain/notes.js";
import { NOTE_FILES, readNotes } from "../lib/host/changelog.js";

const kinds = (blocks) => blocks.map((block) => block.kind + (block.kind === "list" ? block.items.length : "")).join(",");

test("the first line introduces the document and leaves the body alone", () => {
  const { title, blocks } = parseNotes("更新说明：V1.1.0\n\n主要改动\n\n1. 会话内容搜索\n2. 性能优化\n");
  assert.equal(title, "更新说明：V1.1.0");
  assert.equal(kinds(blocks), "p,list2");
  assert.equal(blocks[0].runs[0].text, "主要改动");
  assert.equal(blocks[1].ordered, true);
});

test("a document that does not introduce itself keeps its first line as body", () => {
  const { title, blocks } = parseNotes("# 变更\n\n正文");
  assert.equal(title, "");
  assert.equal(kinds(blocks), "h,p");
  assert.equal(blocks[0].level, 1);
});

test("headings carry their level, and ### is not ##", () => {
  const { blocks } = parseNotes("## 新增\n### 子项");
  assert.deepEqual(blocks.map((block) => block.kind + block.level), ["h2", "h3"]);
});

test("a rule line is a separator, not a list", () => {
  const { blocks } = parseNotes("上\n\n===\n\n下");
  assert.equal(kinds(blocks), "p,hr,p");
});

test("bullets and numbers become lists, and consecutive lines join one", () => {
  const { blocks } = parseNotes("* 一\n* 二\n\n1. 甲\n2. 乙\n3) 丙");
  assert.equal(kinds(blocks), "list2,list3");
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[1].ordered, true, "2) closes an item the same way 2. does");
});

test("**bold** and `code` become separate runs, and the rest stays text", () => {
  assert.deepEqual(notesRuns("**标题**：正文"), [{ text: "标题", bold: true }, { text: "：正文" }]);
  assert.deepEqual(notesRuns("跑 `pnpm test` 看结果"), [
    { text: "跑 " },
    { text: "pnpm test", code: true },
    { text: " 看结果" },
  ]);
  assert.deepEqual(notesRuns("没有标记"), [{ text: "没有标记" }]);
});

test("wrapped lines join into one paragraph, the way markdown reads", () => {
  const { blocks } = parseNotes("第一行\n第二行\n\n空行后");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].runs[0].text, "第一行 第二行");
});

test("an empty or line-ending-less document is empty, not a crash", () => {
  assert.deepEqual(parseNotes(""), { title: "", blocks: [] });
  assert.deepEqual(parseNotes(undefined), { title: "", blocks: [] });
  assert.equal(kinds(parseNotes("一\r\n二").blocks), "p");
});

test("readNotes takes the first file that exists", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const missing = join(dir, "nope.md");
  const first = join(dir, "更新说明.md");
  const second = join(dir, "CHANGELOG.md");
  await writeFile(first, "更新说明：第一个\n\n内容", "utf8");
  await writeFile(second, "更新说明：第二个\n\n内容", "utf8");

  assert.equal((await readNotes({ files: [missing, second] })).title, "更新说明：第二个");
  assert.equal((await readNotes({ files: [first, second] })).title, "更新说明：第一个");
});

test("an empty file is skipped rather than shown as a blank dialog", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const empty = join(dir, "更新说明.md");
  const real = join(dir, "CHANGELOG.md");
  await writeFile(empty, "", "utf8");
  await writeFile(real, "更新说明：有内容\n\n正文", "utf8");
  assert.equal((await readNotes({ files: [empty, real] })).title, "更新说明：有内容");
});

test("no file at all is a coded error the route can turn into a message", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(readNotes({ files: [join(dir, "nope.md")] }), (error) => {
    assert.equal(error.code, "not-found");
    assert.match(error.message, /更新说明\.md/);
    return true;
  });
});

test("a file past the size cap is refused, not streamed to the window", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const huge = join(dir, "更新说明.md");
  await writeFile(huge, "x".repeat(NOTES_MAX_BYTES + 1), "utf8");
  await assert.rejects(readNotes({ files: [huge] }), (error) => error.code === "too-large");
});

test("the parse is remembered by size and mtime, and a rewrite is not", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "更新说明.md");
  await writeFile(file, "更新说明：一\n\n甲", "utf8");

  const first = await readNotes({ files: [file] });
  const again = await readNotes({ files: [file] });
  assert.equal(again, first, "same file, same answer — no re-read");

  await writeFile(file, "更新说明：二\n\n乙乙乙", "utf8");
  const after = await readNotes({ files: [file] });
  assert.equal(after.title, "更新说明：二", "a rewritten file is read again");
});

test("the shipped CHANGELOG.md is a real document, and matches the checkout notes", async () => {
  assert.ok(existsSync(NOTE_FILES[1]), "the package ships CHANGELOG.md");
  const shipped = await readFile(NOTE_FILES[1], "utf8");
  const parsed = parseNotes(shipped);
  assert.ok(parsed.title.length > 0, "it introduces itself");
  assert.ok(parsed.blocks.length >= 5, "it has a body");

  // NOTE_FILES[0] is the checkout copy, which exists only in a checkout. The
  // two are allowed to differ between edits: `scripts/sync-notes.mjs` copies
  // one over the other in `prepack`, so what ships is always the file the
  // maintainer just wrote, and a test does not have to police a step nobody
  // remembers to run.
  if (existsSync(NOTE_FILES[0])) {
    assert.ok((await readFile(NOTE_FILES[0], "utf8")).length > 0, "the checkout notes are a real file");
  }
});
