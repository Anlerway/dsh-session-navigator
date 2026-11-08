/**
 * Tests for 更新说明 — the document behind 设置 › 关于 › 更新说明.
 *
 *   node --test test/notes.test.mjs
 *
 * Two halves worth testing separately. The parser (src/domain/notes.js) turns a
 * changelog into blocks, and the search (src/host/changelog.js) decides which of
 * the candidate files the notes are — docs/changelog/<language>.md, falling back
 * to English and then Chinese when a language has no file yet.
 *
 * The last two tests keep the ten files honest: each one introduces itself with
 * the version being shipped, and the ten say the same amount, so a translation
 * that lost a bullet is caught here instead of by a reader of that language.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NOTES_MAX_BYTES, notesRuns, parseNotes } from "../src/domain/notes.js";
import { NOTES_DIR, noteFiles, notesLanguage, readNotes } from "../src/host/changelog.js";
import { LANGS } from "../src/lang.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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
  const first = join(dir, "zh.md");
  const second = join(dir, "en.md");
  await writeFile(first, "更新说明：第一个\n\n内容", "utf8");
  await writeFile(second, "更新说明：第二个\n\n内容", "utf8");

  assert.equal((await readNotes({ files: [missing, second] })).title, "更新说明：第二个");
  assert.equal((await readNotes({ files: [first, second] })).title, "更新说明：第一个");
});

test("an empty file is skipped rather than shown as a blank dialog", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const empty = join(dir, "zh.md");
  const real = join(dir, "en.md");
  await writeFile(empty, "", "utf8");
  await writeFile(real, "更新说明：有内容\n\n正文", "utf8");
  assert.equal((await readNotes({ files: [empty, real] })).title, "更新说明：有内容");
});

test("no file at all is a coded error the route can turn into a message", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(readNotes({ files: [join(dir, "nope.md")] }), (error) => {
    assert.equal(error.code, "not-found");
    assert.match(error.message, /nope\.md/);
    return true;
  });
});

test("a file past the size cap is refused, not streamed to the window", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const huge = join(dir, "zh.md");
  await writeFile(huge, "x".repeat(NOTES_MAX_BYTES + 1), "utf8");
  await assert.rejects(readNotes({ files: [huge] }), (error) => error.code === "too-large");
});

test("the parse is remembered by size and mtime, and a rewrite is not", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "zh.md");
  await writeFile(file, "更新说明：一\n\n甲", "utf8");

  const first = await readNotes({ files: [file] });
  const again = await readNotes({ files: [file] });
  assert.equal(again, first, "same file, same answer — no re-read");

  await writeFile(file, "更新说明：二\n\n乙乙乙", "utf8");
  const after = await readNotes({ files: [file] });
  assert.equal(after.title, "更新说明：二", "a rewritten file is read again");
});

test("a language without a file falls back to English, then Chinese", () => {
  const at = (name) => join(NOTES_DIR, `${name}.md`);
  assert.deepEqual(noteFiles("fr"), [at("fr"), at("en"), at("zh")]);
  assert.deepEqual(noteFiles("fr-CA"), [at("fr"), at("en"), at("zh")], "a region code belongs to its base");
  assert.deepEqual(noteFiles("en"), [at("en"), at("zh")], "the fallbacks are not repeated");
  assert.deepEqual(noteFiles("zh"), [at("zh"), at("en")]);
  assert.deepEqual(noteFiles("tlh"), [at("en"), at("zh")], "a language this plugin cannot draw names no file");
});

test("the page names the language; the settings document only answers when it does not", () => {
  assert.equal(notesLanguage("ja", { ui: { lang: "auto" } }), "ja", "the language the page is drawing in wins");
  assert.equal(notesLanguage("tlh", { ui: { lang: "ru" } }), "ru", "an unknown code falls back to the saved choice");
  assert.equal(notesLanguage(undefined, { ui: { lang: "zh-TW" } }), "zh-hant", "and a region code folds into its table");
  assert.equal(notesLanguage("", { ui: { lang: "auto" } }), "", "auto names no file: readNotes tries English next");
  assert.equal(notesLanguage("ja"), "ja", "a request without a settings document is still answered");
});

test("readNotes answers in the language it was asked for", async () => {
  assert.match((await readNotes({ language: "ja" })).title, /^更新情報/);
  assert.match((await readNotes({ language: "ru" })).title, /^Примечания/);
  assert.match((await readNotes({ language: "tlh" })).title, /^Release notes/, "and falls back when it has none");
});

test("every language has notes, and they cover the same ground", async () => {
  const version = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
  const shapes = new Map();
  for (const lang of LANGS) {
    const file = join(NOTES_DIR, `${lang}.md`);
    assert.ok(existsSync(file), `${lang}.md exists`);
    const parsed = parseNotes(await readFile(file, "utf8"));
    assert.ok(parsed.title.length > 0, `${lang} introduces itself`);
    assert.ok(parsed.title.endsWith(version), `${lang} names the version being shipped`);
    // The document opens with paragraphs, not a list: the 主要改动 heading and
    // the sentence saying what kind of release this is, before anybody has to
    // read a bullet.
    assert.equal(parsed.blocks[0]?.kind, "p", `${lang} opens with the highlights heading`);
    assert.equal(parsed.blocks[1]?.kind, "p", `${lang} says what kind of release this is`);
    // Four lists: the highlights, then what is new, what got better, what was
    // fixed. The numbers are the contract between the ten files; a translation
    // that drops a bullet fails here rather than silently telling less.
    shapes.set(lang, parsed.blocks.filter((block) => block.kind === "list").map((list) => list.items.length).join("/"));
  }
  assert.deepEqual([...new Set(shapes.values())], ["7/6/10/9"], "every language says the same amount");
});
