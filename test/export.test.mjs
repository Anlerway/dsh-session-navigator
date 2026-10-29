/**
 * Tests for lib/domain/export.js — turning a session log into Markdown/JSONL.
 *
 * Every fixture here is shaped the way a real v4 log is shaped, because that is
 * the bug these tests exist to prevent: the first version of this file invented
 * its own shapes (`at`, `data.content` on assistant messages, a `surfaceOp.kind`
 * mask), so it passed while the shipped export dropped *every* assistant
 * message and *every* tool call on real logs — a session of 18,700 calls
 * exported as 0. So: `time` not `at`, `data.message.content` for the model,
 * `source.kind` for who is speaking, `tool/call` as its own event, and the
 * checkpoint DSH writes when it compacts a long conversation.
 *
 * The other half is the contract: what was said is never dropped. Surface
 * operations and compaction are *reported* — a note, a labelled section, a count
 * in the header — never applied as a filter.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { blocksOf, collectTurns, exportFileName, maskedSeqs, toJsonl, toMarkdown, turnsOf } from "../lib/domain/export.js";

const T0 = 1_760_000_000_000;

/** One human message, tagged the way DSH tags it. */
const fromUser = (seq, text, extra = {}) => ({
  seq,
  time: T0 + seq * 1000,
  type: "user/message",
  data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text }], ...extra },
});

/** One assistant message: blocks live in `data.message.content`, not `data.content`. */
const fromModel = (seq, blocks, extra = {}) => ({
  seq,
  time: T0 + seq * 1000,
  type: "assistant/message",
  data: { turn: 1, step: seq, message: { role: "assistant", content: blocks }, ...extra },
});

/** A small but real-shaped session: question, answer, one tool call, its output. */
function log(extra = []) {
  return {
    header: { id: "sess-1", title: "重构插件", cwd: "C:/work", createdAt: T0, version: 4 },
    events: [
      { seq: 1, time: T0, type: "request/header", data: {} },
      fromUser(2, "先看排序"),
      fromModel(3, [
        { type: "reasoning", text: "先读代码" },
        { type: "text", text: "好的。" },
        { type: "tool-call", id: "call-1", name: "read", arguments: '{"path":"a.js"}' },
      ]),
      { seq: 4, time: T0 + 4000, type: "tool/call", data: { turn: 1, step: 1, callId: "call-1", name: "read", arguments: '{"path":"a.js"}' } },
      {
        seq: 5,
        time: T0 + 5000,
        type: "tool/result",
        data: { turn: 1, step: 1, message: { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "export function main() {}" }] } },
      },
      ...extra,
    ],
  };
}

test("the shapes a real log uses are the shapes that get read", () => {
  const turns = turnsOf(log().events);
  assert.deepEqual(turns.map((turn) => turn.role), ["user", "assistant"]);
  assert.equal(turns[0].text, "先看排序");
  // data.message.content, not data.content: reading the wrong level emptied
  // every assistant turn in the export.
  assert.equal(turns[1].text, "好的。");
  assert.equal(turns[1].reasoning, "先读代码");
  assert.equal(turns[1].tools.length, 1, "the block and the event are one call");
  assert.equal(turns[1].tools[0].name, "read");
  assert.deepEqual(turns[1].tools[0].args, { path: "a.js" }, "the JSON string is parsed");
  assert.equal(turns[1].tools[0].result, "export function main() {}", "the output is attached to its call");
});

test("a tool call that only exists as its own event still lands somewhere", () => {
  // A streamed build writes tool/call without repeating it as a block.
  const turns = turnsOf(log([{ seq: 6, time: T0 + 6000, type: "tool/call", data: { callId: "call-2", name: "grep", arguments: '{"pattern":"todo"}' } }]).events);
  assert.equal(turns[1].tools.length, 2);
  assert.equal(turns[1].tools[1].name, "grep");
});

test("consecutive assistant messages are one turn, a user message starts the next", () => {
  const events = [
    fromUser(1, "问题"),
    fromModel(2, [{ type: "text", text: "第一段" }]),
    fromModel(3, [{ type: "text", text: "第二段" }]),
    fromUser(4, "追问"),
    fromModel(5, [{ type: "text", text: "回答" }]),
  ];
  const turns = turnsOf(events);
  assert.deepEqual(turns.map((turn) => turn.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(turns[1].text, "第一段\n\n第二段");
});

test("timestamps come from `time`, the field a log actually writes", () => {
  assert.equal(turnsOf(log().events)[0].at, T0 + 2000);
});

test("the context DSH injects is not the user talking", () => {
  const events = [
    { seq: 1, time: T0, type: "user/message", data: { source: { kind: "runtime-context" }, content: [{ type: "text", text: "工作目录是 C:/work" }] } },
    { seq: 2, time: T0, type: "user/message", data: { source: { kind: "time-context" }, content: [{ type: "text", text: "当前时间 18:21" }] } },
    { seq: 3, time: T0, type: "user/message", data: { source: { kind: "tool-jobs" }, content: [{ type: "text", text: "后台任务已结束" }] } },
    fromUser(4, "真正的话"),
  ];
  const { turns, omitted } = collectTurns(events);
  assert.deepEqual(turns.map((turn) => turn.text), ["真正的话"]);
  assert.equal(omitted.context, 3);
  assert.deepEqual(omitted.contextKinds, [["runtime-context", 1], ["time-context", 1], ["tool-jobs", 1]]);
  const markdown = toMarkdown({ header: { id: "s" }, events }, {});
  assert.ok(markdown.includes("已省略上下文注入：3 条"), "the count is stated, not implied");
  assert.ok(!markdown.includes("工作目录是 C:/work"));
});

test("a user message with no source at all is still the user", () => {
  // Older logs had no source field; treating "unknown" as machine text dropped
  // the human.
  const turns = turnsOf([{ seq: 1, time: T0, type: "user/message", data: { content: [{ type: "text", text: "老日志" }] } }]);
  assert.deepEqual(turns.map((turn) => turn.text), ["老日志"]);
});

test("a compaction is reported, never applied", () => {
  // What DSH does to a long session: replace seqs 2..5 with one checkpoint.
  const events = [
    ...log().events,
    {
      seq: 6,
      time: T0 + 6000,
      type: "user/message",
      data: {
        source: { kind: "compact-checkpoint" },
        content: [{ type: "text", text: "This is an automatically generated checkpoint…" }],
      },
      surfaceOp: { op: "replace", startSeq: 2, endSeq: 5 },
    },
  ];
  assert.deepEqual([...maskedSeqs(events)].sort((a, b) => a - b), [2, 3, 4, 5]);

  const { turns, replaced, checkpoints } = collectTurns(events);
  assert.deepEqual(turns.map((turn) => turn.role), ["note", "user", "assistant", "checkpoint"]);
  assert.equal(replaced, 4, "the count of replaced events is reported");
  assert.equal(checkpoints, 1);
  // The words that were condensed are still in the document…
  assert.equal(turns[1].text, "先看排序");
  assert.equal(turns[2].tools[0].result, "export function main() {}");
  // …and the summary that condenses them is labelled as machine text.
  assert.ok(turns[0].text.includes("压缩摘要"));

  const markdown = toMarkdown({ header: { id: "sess-1" }, events }, {});
  assert.ok(markdown.includes("## 上下文压缩摘要"), "the checkpoint has its own section");
  assert.ok(markdown.includes("由 DSH 自动生成，不是用户原话"));
  assert.ok(markdown.includes("⚠"), "the reader is told where the original record was replaced");
  assert.ok(markdown.includes("被压缩摘要替换的片段：4 个事件"));
});

test("a hide op names the seqs it masks, and the note is written once per span", () => {
  const events = [...log().events, { seq: 9, time: T0, type: "surface/hide", surfaceOp: { kind: "hide", seqs: [2, 3] } }];
  const { turns, replaced } = collectTurns(events);
  assert.equal(replaced, 2);
  assert.equal(turns.filter((turn) => turn.role === "note").length, 1, "one note, not one per event");
});

test("pruned events are counted but their words stay", () => {
  const events = [...log().events, { seq: 6, time: T0, type: "compaction/prune", data: { shadowedSeqs: [2, 3], shadowedTokenCount: 10 } }];
  const { compacted, turns } = collectTurns(events);
  assert.equal(compacted, 2);
  assert.equal(turns[0].text, "先看排序");
});

test("a tool result whose call is gone keeps its output on a turn of its own", () => {
  const events = [
    fromUser(1, "跑一下"),
    { seq: 2, time: T0, type: "tool/result", data: { message: { toolCallId: "call-x", content: [{ type: "text", text: "输出" }] } } },
  ];
  const { turns, omitted } = collectTurns(events);
  assert.equal(turns[1].tools[0].name, "(未知工具)");
  assert.equal(turns[1].tools[0].result, "输出");
  assert.equal(omitted.orphanResults, 1);
});

test("blocksOf tolerates a plain string and unknown block types", () => {
  assert.deepEqual(blocksOf("hello"), { text: "hello", reasoning: "", tools: [] });
  // An unknown type that carries words keeps them: dropping the block dropped
  // the whole message when it was the only one in the turn.
  assert.deepEqual(blocksOf([{ type: "mystery", text: "x" }]), { text: "x", reasoning: "", tools: [] });
  assert.deepEqual(blocksOf([{ type: "image", source: {} }]), { text: "![图片]", reasoning: "", tools: [] });
  assert.deepEqual(blocksOf(null), { text: "", reasoning: "", tools: [] });
});

test("Markdown renders a title, per-turn headings and tool details", () => {
  const markdown = toMarkdown(log(), { includeTools: true });
  assert.ok(markdown.startsWith("# 重构插件"), "title is the heading");
  assert.ok(markdown.includes("会话 id：`sess-1`"), "facts are listed");
  assert.ok(markdown.includes("## 用户"), "user turn heading");
  assert.ok(markdown.includes("## 助手"), "assistant turn heading");
  assert.ok(markdown.includes("用户消息：1 条 · 助手回合：1 段 · 工具调用：1 次"), "the arithmetic is in the header");
  assert.ok(markdown.includes("先看排序"));
  // The hint is what makes a list of 1400 details navigable.
  assert.ok(markdown.includes("<details><summary>工具调用 · read — a.js</summary>"), "tool call folded into the turn");
  assert.ok(markdown.includes("export function main() {}"), "the output is there");
  assert.ok(!markdown.includes("先读代码"), "reasoning is opt-in");
});

test("Markdown can include reasoning and omit tools", () => {
  const markdown = toMarkdown(log(), { includeTools: false, includeReasoning: true });
  assert.ok(markdown.includes("> 思考"), "reasoning rendered as a quote");
  assert.ok(markdown.includes("先读代码"));
  assert.ok(!markdown.includes("<details>"), "tools omitted");
  assert.ok(!markdown.includes("工具调用 · read"));
});

test("a long tool result is cut in Markdown and whole in JSONL", () => {
  const body = "x".repeat(100);
  const events = [
    fromUser(1, "跑"),
    fromModel(2, [{ type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"yes"}' }]),
    { seq: 3, time: T0, type: "tool/result", data: { message: { toolCallId: "c1", content: [{ type: "text", text: body }] } } },
  ];
  const markdown = toMarkdown({ header: { id: "s" }, events }, { toolResultLimit: 10 });
  assert.ok(markdown.includes("已截断：共 100 字符"));
  assert.ok(!markdown.includes(body), "the tail is not in the Markdown");
  const jsonl = toJsonl({ header: { id: "s" }, events });
  assert.ok(jsonl.includes(body), "JSONL is the complete one");
});

test("JSONL is one turn per line plus a session header", () => {
  const lines = toJsonl(log()).trim().split("\n");
  assert.equal(lines.length, 3, "header + two turns");
  const header = JSON.parse(lines[0]);
  assert.equal(header.type, "session");
  assert.equal(header.id, "sess-1");
  assert.equal(header.turns, 2);
  assert.equal(header.tools, 1);
  assert.equal(JSON.parse(lines[1]).role, "user");
  assert.equal(JSON.parse(lines[2]).role, "assistant");
  assert.equal(JSON.parse(lines[2]).tools[0].name, "read");
});

test("JSONL under a compaction keeps the messages and puts the counts in the header", () => {
  const events = [...log().events, { seq: 6, time: T0, type: "user/message", data: { source: { kind: "compact-checkpoint" }, content: [{ type: "text", text: "摘要" }] }, surfaceOp: { op: "replace", startSeq: 2, endSeq: 5 } }];
  const lines = toJsonl({ header: { id: "s" }, events }).trim().split("\n");
  const header = JSON.parse(lines[0]);
  assert.equal(header.omitted.replaced, 4);
  assert.equal(header.omitted.checkpoints, 1);
  assert.ok(!lines.some((line) => JSON.parse(line).role === "note"), "a reading aid is not a message");
  assert.ok(lines.some((line) => JSON.parse(line).role === "checkpoint"), "but the summary is");
});

test("an empty session still exports a valid document", () => {
  const empty = { header: { id: "x" }, events: [] };
  assert.ok(toMarkdown(empty, {}).includes("# x"));
  assert.equal(toJsonl(empty).trim().split("\n").length, 1, "header only");
});

test("exportFileName strips characters a filesystem refuses", () => {
  // The character run collapses to one dash, so the name stays readable.
  assert.equal(exportFileName({ id: "x" }, 'a/b:c*?"<>|d', "md"), "a-b-c-d.md");
  assert.equal(exportFileName({ id: "x" }, "", "jsonl"), "x.jsonl");
  assert.equal(exportFileName({ id: "x" }, "  spaced  name  ", "md"), "spaced name.md");
});

test("a title is truncated by code point, not by UTF-16 unit", () => {
  // 79 characters then an emoji: a naive `.slice(0, 80)` keeps half the pair and
  // the download route's encodeURIComponent then throws.
  const title = "a".repeat(79) + "🎉" + "b".repeat(10);
  const name = exportFileName({ id: "x" }, title, "md");
  assert.equal(Array.from(name.replace(/\.md$/, "")).length, 80, "80 code points survive");
  assert.equal(name, "a".repeat(79) + "🎉.md", "the emoji is whole");
});

test("maskedSeqs reads the real op and the legacy one", () => {
  // Real: an object with op/startSeq/endSeq, endpoints included.
  assert.deepEqual([...maskedSeqs([{ seq: 5, surfaceOp: { op: "replace", startSeq: 2, endSeq: 4 } }])], [2, 3, 4]);
  // Legacy: the invented shape, still read so an old file does not regress.
  assert.deepEqual([...maskedSeqs([{ seq: 9, surfaceOp: { kind: "replace", ranges: [{ from: 1, to: 2 }] } }])], [1, 2]);
  // A string surfaceOp is an append, not a mask: 18,000 of them say "append".
  assert.equal(maskedSeqs([{ seq: 3, surfaceOp: "append" }]).size, 0);
});

test("a mask range with one end hides what it names", () => {
  const events = [
    { seq: 1, type: "user/message", data: { content: "one" } },
    { seq: 2, type: "user/message", data: { content: "two" }, surfaceOp: { kind: "replace", ranges: [{ from: 2 }] } },
  ];
  assert.deepEqual([...maskedSeqs(events)], [2], "a start-only range hides its own seq");
});

test("an absurd mask range does not run away", () => {
  const events = [{ seq: 1, surfaceOp: { kind: "replace", ranges: [{ from: 1, to: 1_000_000_000 }] } }];
  const hidden = maskedSeqs(events);
  assert.equal(hidden.size, 100_000, "the range is capped, not iterated a billion times");
  assert.ok(hidden.has(1));
});
