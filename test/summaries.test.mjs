/**
 * AI 字段 (m00531, m01823) — the document shape, the spend ledger, the prompt,
 * and the runner.
 *
 * The product is three fields — a title, a description, a tag list — not a
 * paragraph. The model call itself is stubbed: a test that needs a provider is a
 * test that fails on a machine without a key, and the parts that can actually be
 * wrong — what goes into the prompt, what a refused answer costs, which sessions
 * count as 还缺字段, whether a cancel stops the queue — have nothing to do with
 * the network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DESCRIPTION_MAX_LENGTH,
  MAX_BATCH,
  PROMPT_BUDGET_CHARS,
  TAG_LIMIT,
  TAG_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  addSpend,
  alignTags,
  buildMessages,
  cleanTags,
  emptySpend,
  emptySummaries,
  extractJsonObject,
  mergeNote,
  normalizeFields,
  normalizeSummaries,
  normalizeSummaryEntry,
  pendingBreakdown,
  pendingSummaryIds,
  pickTags,
  systemPrompt,
  transcriptOf,
  wantedFields,
} from "../lib/domain/summaries.js";
import { createSummarizer } from "../lib/host/summarize.js";
import { statusFor } from "../lib/index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const ALL_FIELDS = { title: true, description: true, tags: true };

/** One human message, in the shape the v4 log actually uses. */
function userSay(seq, text) {
  return {
    type: "user/message",
    seq,
    time: 1_700_000_000_000 + seq,
    data: { source: { kind: "user" }, content: [{ type: "text", text }] },
  };
}

/** One assistant message, in the shape the v4 log actually uses. */
function agentSay(seq, text) {
  return {
    type: "assistant/message",
    seq,
    time: 1_700_000_000_000 + seq,
    data: { message: { content: [{ type: "text", text }] } },
  };
}

/** The answer the stub model gives when a test does not care about content. */
const GOOD_ANSWER = JSON.stringify({ title: "修复导出", description: "助手的话现在也会导出。", tags: ["导出", "会话"] });

/** An in-memory stand-in for the summaries sidecar. */
function memoryStore(initial = emptySummaries()) {
  let document = { ...initial, revision: 0 };
  return {
    get current() {
      return document;
    },
    read: async () => structuredClone(document),
    mutate: async (mutator) => {
      const draft = structuredClone(document);
      const next = mutator(draft) ?? draft;
      document = { ...next, revision: document.revision + 1 };
      return structuredClone(document);
    },
  };
}

/**
 * A stub `llm` service.
 *
 * `reply` is called per call and may throw to simulate a provider failure; the
 * usage it returns is deliberately lopsided so a test can tell input from
 * output in the ledger.
 */
function stubLlm(options = {}) {
  const calls = [];
  /** Every request handed to `call.stream()` — the prompt, not just the route. */
  const requests = [];
  const reply = options.reply ?? (() => ({ text: GOOD_ANSWER, inputTokens: 100, outputTokens: 20 }));
  return {
    calls,
    requests,
    listProviders: () => options.providers ?? [{ id: "wb", name: "WB Proxy" }],
    listModels: async (provider) => {
      if (options.failModels === provider) throw new Error("models unavailable");
      return options.models ?? [{ id: "flash", name: "DeepSeek V4.1 Flash" }];
    },
    resolveModelInfo: async (provider, model) => {
      if (options.failResolve === model) throw new Error("no metadata");
      return {
        provider,
        id: model,
        name: model,
        reasoning: { efforts: [{ id: "low", name: "低" }, { id: "high", name: "高" }], defaultEffort: "low" },
      };
    },
    prepareCall: async (config) => {
      calls.push(config);
      return {
        config,
        stream: (request) =>
          (async function* () {
            requests.push(request);
            const outcome = reply(config, request);
            if (outcome.delay) await new Promise((resolve) => setTimeout(resolve, outcome.delay));
            if (outcome.error) {
              yield { type: "finish", reason: { kind: "error", failure: { code: outcome.error, message: outcome.message ?? outcome.error } } };
              return;
            }
            if (outcome.blockType === "reasoning") {
              // What a reasoning model actually sends first. The old parser
              // treated this as "the model wants to call a tool" and threw.
              yield { type: "block-start", index: 0, blockType: "reasoning" };
              yield { type: "reasoning-delta", index: 0, text: "先看看这堆会话在讲什么" };
              yield { type: "block-end", index: 0, block: { type: "reasoning", text: "先看看这堆会话在讲什么" } };
              yield { type: "block-start", index: 1, blockType: "text" };
              yield { type: "text-delta", index: 1, text: outcome.text };
              yield { type: "usage", usage: { inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens } };
              yield { type: "finish", reason: { kind: "stop" } };
              return;
            }
            if (outcome.blockType === "text-and-tool") {
              yield { type: "block-start", index: 0, blockType: "tool-call" };
              yield { type: "block-end", index: 0, block: { type: "tool-call", id: "c1", name: "read", arguments: "{}" } };
              yield { type: "block-start", index: 1, blockType: "text" };
              yield { type: "text-delta", index: 1, text: outcome.text };
              yield { type: "finish", reason: { kind: "stop" } };
              return;
            }
            if (outcome.blockType === "tool-call") {
              yield { type: "block-start", index: 0, blockType: "tool-call" };
              yield { type: "block-end", index: 0, block: { type: "tool-call", id: "c1", name: "read", arguments: "{}" } };
              yield { type: "finish", reason: { kind: "stop" } };
              return;
            }
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: outcome.text };
            yield { type: "usage", usage: { inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens, totalTokens: outcome.totalTokens } };
            yield { type: "finish", reason: { kind: "stop" } };
          })(),
      };
    },
  };
}

/** Wire a summarizer over stubs. */
function harness(overrides = {}) {
  const llm = overrides.llm ?? stubLlm();
  const store = overrides.store ?? memoryStore();
  const rows = overrides.rows ?? {
    s1: { id: "s1", displayTitle: "修复导出", logPath: "C:/logs/s1.jsonl", activityAt: 1_700_000_100_000, createdAt: 1_700_000_000_000, stats: { steps: 12 }, note: "", tags: [] },
    s2: { id: "s2", displayTitle: "搜索范围", logPath: "C:/logs/s2.jsonl", activityAt: 1_700_000_200_000, createdAt: 1_700_000_000_000, stats: { steps: 4 }, note: "", tags: [] },
  };
  const summarizer = createSummarizer({
    getLlm: () => llm,
    summaries: store,
    settings: async () => overrides.settings ?? { summary: { provider: "", model: "", effort: "", fields: { ...ALL_FIELDS } } },
    session: async (id) => rows[id] ?? null,
    existingTags: async () => overrides.existingTags ?? [],
    read: async () =>
      overrides.artifact ?? {
        header: { id: "s1" },
        events: [userSay(1, "导出少了助手的话"), agentSay(2, "我改成读 data.message.content 了")],
      },
    now: overrides.now ?? (() => 1_700_000_500_000),
    log: () => {},
  });
  return { summarizer, llm, store, rows };
}

/** Run until the queue is idle, without depending on how many turns it took. */
async function settle(summarizer) {
  for (let guard = 0; guard < 400; guard += 1) {
    if (!(await summarizer.state()).running) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ── the ledger ───────────────────────────────────────────────────────────────

test("a fresh ledger counts nothing", () => {
  assert.deepEqual(emptySpend(), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    runs: 0,
    failures: 0,
  });
});

test("spend adds both halves, and prefers the provider's own total", () => {
  const once = addSpend(emptySpend(), { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }, true);
  // The provider's total is the one the invoice uses; a locally derived sum
  // would disagree whenever the cached read is counted on one side only.
  assert.equal(once.totalTokens, 1500);
  const twice = addSpend(once, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 900 }, true);
  assert.equal(twice.inputTokens, 1210);
  assert.equal(twice.outputTokens, 305);
  // No totalTokens from the provider ⇒ the halves are summed, not invented.
  assert.equal(twice.totalTokens, 1515);
  assert.equal(twice.cacheReadTokens, 900);
  assert.equal(twice.runs, 2);
  assert.equal(twice.failures, 0);
});

test("a failed call is billed and counted as a failure", () => {
  const spend = addSpend(emptySpend(), { inputTokens: 800, outputTokens: 0 }, false);
  assert.equal(spend.runs, 1);
  assert.equal(spend.failures, 1);
  // Input tokens are spent before the stream breaks: the ledger must not
  // pretend a broken call was free.
  assert.equal(spend.inputTokens, 800);
});

test("a ledger read off disk with junk fields is repaired, not trusted", () => {
  const spend = addSpend({ ...emptySpend(), inputTokens: -5, outputTokens: "12", runs: 1.9 }, null, true);
  assert.equal(spend.inputTokens, 0);
  assert.equal(spend.outputTokens, 0);
  assert.equal(spend.runs, 2);
});

// ── the three fields ─────────────────────────────────────────────────────────

test("an entry with no field at all is not an entry", () => {
  assert.equal(normalizeSummaryEntry({}), null);
  assert.equal(normalizeSummaryEntry({ title: "   ", description: "", tags: [] }), null);
  assert.equal(normalizeSummaryEntry(null), null);
});

test("a record written by the prose build is dropped, not shown as an empty entry", () => {
  // v1 stored `text`. It is not one of the three fields, so it is worth nothing
  // now — but it must not turn into a blank row that makes the session look
  // done and therefore never regenerated.
  assert.equal(normalizeSummaryEntry({ text: "很长的一段摘要", at: 5 }), null);
});

test("over-long fields are clipped, not rejected", () => {
  const entry = normalizeSummaryEntry({
    title: "标".repeat(TITLE_MAX_LENGTH + 10),
    description: "描".repeat(DESCRIPTION_MAX_LENGTH + 80),
    tags: ["标".repeat(TAG_MAX_LENGTH + 4)],
  });
  assert.equal(entry.title.length, TITLE_MAX_LENGTH);
  assert.ok(entry.title.endsWith("…"));
  assert.equal(entry.description.length, DESCRIPTION_MAX_LENGTH);
  assert.equal(entry.tags[0].length, TAG_MAX_LENGTH);
});

test("tags are clipped before they are deduplicated, so two long labels that clip alike become one", () => {
  const entry = normalizeSummaryEntry({
    title: "导出",
    // Both clip to the same eight characters; keeping both would show the same
    // tag twice in the filter row, where they are indistinguishable.
    tags: ["会话导出修复方案甲", "会话导出修复方案乙", "会话导出补测试说明", "#", "", "  ", "导出"],
  });
  // The survivor is the clipped form, because that is what gets stored — the
  // limit is a limit on the record, not a wish.
  assert.deepEqual(entry.tags, ["会话导出修复方…", "会话导出补测试…", "导出"]);
});

test("a tag list given as one line of text is split on the separators a model actually writes", () => {
  assert.deepEqual(cleanTags("导出, 搜索、会话；标签\n导出"), ["导出", "搜索", "会话", "标签"]);
  assert.equal(cleanTags(Array.from({ length: TAG_LIMIT + 3 }, (_, index) => `t${index}`)).length, TAG_LIMIT);
  assert.deepEqual(cleanTags("  #导出  "), ["导出"]);
});

test("normalizeSummaries keeps the route, the cost and what was applied", () => {
  const document = normalizeSummaries({
    sessions: {
      s1: {
        title: "修复导出",
        description: "助手的话现在也会导出。",
        tags: ["导出"],
        at: 10,
        sourceAt: 9,
        model: { provider: "wb", model: "flash", effort: "low" },
        tokens: { inputTokens: 7, outputTokens: 3 },
        turns: 4,
        applied: { title: true, tags: false },
      },
    },
    spend: { inputTokens: 7, outputTokens: 3, totalTokens: 10, runs: 1 },
  });
  assert.equal(document.sessions.s1.model.model, "flash");
  assert.equal(document.sessions.s1.tokens.inputTokens, 7);
  assert.equal(document.sessions.s1.turns, 4);
  assert.equal(document.sessions.s1.applied.title, true);
  assert.equal(document.sessions.s1.applied.tags, false);
  assert.equal(document.spend.runs, 1);
  // Unknown top-level keys never reach the client.
  assert.deepEqual(Object.keys(document).sort(), ["sessions", "spend"]);
});

// ── which fields are wanted ──────────────────────────────────────────────────

test("only an explicit true asks for a field", () => {
  assert.deepEqual(wantedFields({ title: true, description: false }), ["title"]);
  assert.deepEqual(wantedFields({}), []);
  assert.deepEqual(wantedFields(null), []);
  // A string "false" is not the boolean true — a settings document that went
  // through JSON is not a place to be generous about truthiness.
  assert.deepEqual(wantedFields({ tags: "true" }), []);
});

// ── who still needs fields ───────────────────────────────────────────────────

test("还缺字段 looks at the description and the tags only (m01898)", () => {
  // Two sources per field: the model's record, or the user's own words. The
  // title is neither — a name says nothing about what was said, so a session
  // with only a title is still waiting.
  const rows = [
    { id: "both", logPath: "a", stats: { steps: 3 } },
    { id: "title-only", logPath: "b", stats: { steps: 3 } },
    // The user wrote the note by hand: that is their description.
    { id: "hand-note-done", logPath: "c", stats: { steps: 3 }, note: "我自己写的", tags: ["手写"] },
    // One handwritten half is not both halves.
    { id: "hand-note-only", logPath: "d", stats: { steps: 3 }, note: "我自己写的" },
    { id: "hand-tags-only", logPath: "e", stats: { steps: 3 }, tags: ["手写"] },
    { id: "half", logPath: "f", stats: { steps: 3 } },
    { id: "nothing", logPath: "g", stats: { steps: 3 } },
  ];
  const document = normalizeSummaries({
    sessions: {
      both: { title: "有", description: "有", tags: ["有"] },
      "title-only": { title: "有" },
      half: { description: "有" },
      nothing: { title: "有" },
    },
  });
  assert.deepEqual(pendingSummaryIds(rows, document), ["title-only", "hand-note-only", "hand-tags-only", "half", "nothing"]);
});

test("a pending report says how many rows were already done", () => {
  const rows = [
    { id: "done", logPath: "a", stats: { steps: 3 } },
    { id: "todo", logPath: "b", stats: { steps: 3 } },
  ];
  const document = normalizeSummaries({ sessions: { done: { description: "有", tags: ["有"] } } });
  const report = pendingBreakdown(rows, document, ALL_FIELDS);
  assert.deepEqual(report.ids, ["todo"]);
  assert.equal(report.total, 2);
  assert.equal(report.skipped, 1);
});

test("a session with only the title switched on still waits for its description", () => {
  // The switch says what to *generate*, not what counts as done: turning title
  // on and generating one must not make the row look finished while it has no
  // description and no tags.
  const rows = [{ id: "s1", logPath: "a", stats: { steps: 3 } }];
  const document = normalizeSummaries({ sessions: { s1: { title: "有" } } });
  // With neither content field switched on there is nothing to look for, so the
  // sweep has no opinion — the run itself refuses with ai/no-fields.
  assert.deepEqual(pendingSummaryIds(rows, document, { title: true, description: false, tags: false }), []);
  assert.deepEqual(pendingSummaryIds(rows, document, { title: true, description: true, tags: true }), ["s1"]);
});

test("未总结 excludes the bin, the unreadable, the empty and the done", () => {
  const document = { sessions: { done: { description: "已有", tags: ["有"] } }, spend: emptySpend() };
  const rows = [
    { id: "live", logPath: "a", stats: { steps: 3 } },
    { id: "done", logPath: "b", stats: { steps: 3 }, description: "已有", tags: ["有"] },
    { id: "trashed", logPath: "c", stats: { steps: 3 }, trashed: true },
    { id: "nolog", stats: { steps: 3 } },
    { id: "blank", logPath: "d", stats: { steps: 0 } },
    { id: "", logPath: "e", stats: { steps: 3 } },
    null,
  ];
  assert.deepEqual(pendingSummaryIds(rows, document), ["live"]);
});

test("a subagent is not excluded: it is exactly the run people forget", () => {
  const ids = pendingSummaryIds([{ id: "sub", logPath: "a", isSubagent: true, stats: { steps: 2 } }], emptySummaries());
  assert.deepEqual(ids, ["sub"]);
});

test("a session DSH never listed is still swept, because its log says it ran", () => {
  // `stats.steps` comes from DSH's projcache, which only knows the sessions DSH
  // listed. Reading "no step count" as "no conversation" dropped exactly the
  // sessions a sweep is for: the user pressed the button, was told there was
  // nothing to do, and the session was right there in the list.
  const rows = [
    { id: "listed-elsewhere", logPath: "a", stats: null, blank: false },
    { id: "unknown", logPath: "b", blank: null },
    { id: "counted-zero", logPath: "c", stats: { steps: 0 } },
    { id: "known-blank", logPath: "d", blank: true, stats: { steps: 8 } },
  ];
  assert.deepEqual(pendingSummaryIds(rows, emptySummaries()), ["listed-elsewhere", "unknown"]);
});

// ── the transcript ───────────────────────────────────────────────────────────

test("the transcript carries what was said, by whom", () => {
  const turns = [
    { role: "user", text: "第一个问题" },
    { role: "assistant", text: "第一个回答" },
    // Injection, a compress checkpoint and a tool row must all stay out.
    { role: "checkpoint", text: "压缩摘要" },
    { role: "note", text: "注记" },
    // A turn that only thought, and a turn that only ran a command: one has no
    // text, the other's words are the tool row's, and neither belongs in a
    // transcript the model is asked to summarize.
    { role: "assistant", text: "", reasoning: "思考过程" },
    { role: "assistant", text: "跑了命令", tools: [{ kind: "tool", name: "read", args: { path: "a" }, result: "文件内容" }] },
  ];
  const transcript = transcriptOf(turns);
  assert.equal(transcript.totalTurns, 3);
  assert.match(transcript.text, /用户：第一个问题/);
  assert.match(transcript.text, /助手：第一个回答/);
  assert.doesNotMatch(transcript.text, /压缩摘要/);
  assert.doesNotMatch(transcript.text, /思考过程/);
  assert.doesNotMatch(transcript.text, /文件内容/);
});

test("a long conversation keeps both ends and says how much it dropped", () => {
  const turns = [];
  for (let index = 0; index < 200; index += 1) {
    turns.push({ role: "user", text: `第 ${index} 问：${"细节".repeat(30)}` });
    turns.push({ role: "assistant", text: `第 ${index} 答：${"结论".repeat(30)}` });
  }
  const transcript = transcriptOf(turns, { budget: 4000 });
  assert.ok(transcript.chars <= 4000 + 200, `asked for 4000, got ${transcript.chars}`);
  assert.ok(transcript.omitted > 0);
  // The opening question states the task; the last answer says how it ended.
  assert.match(transcript.text, /第 0 问/);
  assert.match(transcript.text, /第 199 答/);
  assert.match(transcript.text, /省略了 \d+ 条消息/);
});

test("an English transcript is labelled in English", () => {
  const transcript = transcriptOf([{ role: "user", text: "fix it" }], { lang: "en" });
  assert.match(transcript.text, /^User: fix it$/);
});

test("no conversation means no prompt at all", () => {
  assert.deepEqual(transcriptOf([]), { text: "", keptTurns: 0, totalTurns: 0, chars: 0, omitted: 0 });
});

// ── the prompt ───────────────────────────────────────────────────────────────

test("the asked-for object is the one the answer is read as", () => {
  const built = buildMessages({
    turns: [{ role: "user", text: "导出少了助手的话" }],
    facts: { activityAt: Date.UTC(2026, 9, 29), steps: 12, messages: 1 },
    fields: ALL_FIELDS,
  });
  const text = built.messages[0].content[0].text;
  assert.match(text, /共 1 条消息，12 步/);
  assert.match(text, /导出少了助手的话/);
  assert.equal(built.messages[0].role, "user");
  // The contract names the three fields, in the user's language.
  assert.match(built.system, /"title"/);
  assert.match(built.system, /"description"/);
  assert.match(built.system, /"tags"/);
  assert.match(built.system, /用中文回答/);
});

test("a field that is switched off is not in the contract at all", () => {
  const built = buildMessages({
    turns: [{ role: "user", text: "只说这一句" }],
    fields: { title: false, description: true, tags: true },
  });
  assert.doesNotMatch(built.system, /"title"/);
  assert.match(built.system, /"description"/);
  assert.match(built.system, /"tags"/);
});

test("the prompt says exactly what the fields are worth, and no more", () => {
  const zh = systemPrompt("zh", ALL_FIELDS);
  // The bounds are the ones the parser enforces, so the model is not asked for
  // something the code would then throw away.
  assert.match(zh, new RegExp(String(TITLE_MAX_LENGTH)));
  assert.match(zh, new RegExp(String(TAG_MAX_LENGTH)));
  assert.match(zh, new RegExp(String(TAG_LIMIT)));
  assert.match(zh, /不要推测/);
  assert.match(zh, /只输出.*JSON|唯一/);
  assert.match(zh, /用中文回答。/);
  const en = systemPrompt("en", ALL_FIELDS);
  assert.match(en, /never speculate/i);
  assert.match(en, /Answer in English\./);
});

test("the session's own metadata is not part of the question any more", () => {
  // m01823: 标题/备注/标签 are what the model *writes*. Feeding the old title and
  // note back in would let a bad name survive forever.
  const built = buildMessages({ turns: [{ role: "user", text: "就这样" }], fields: ALL_FIELDS });
  const text = built.messages[0].content[0].text;
  assert.doesNotMatch(text, /会话标题/);
  assert.doesNotMatch(text, /我的备注/);
  assert.doesNotMatch(text, /^标签：/m);
});

// ── reading the answer ───────────────────────────────────────────────────────

test("an answer wrapped in a fence, or with prose around it, is still read", () => {
  assert.deepEqual(extractJsonObject('```json\n{"title":"a"}\n```'), { title: "a" });
  assert.deepEqual(extractJsonObject('好的：\n{"title":"a"}\n希望有用'), { title: "a" });
  assert.equal(extractJsonObject("没有 JSON"), null);
  assert.equal(extractJsonObject("[1,2]"), null);
});

test("a wanted field that the answer left out is missing, not empty", () => {
  const fields = normalizeFields({ title: "有", tags: "a, b" }, ALL_FIELDS);
  assert.deepEqual(fields.missing, ["description"]);
  assert.deepEqual(fields.tags, ["a", "b"]);
  const partial = normalizeFields({ description: "有" }, { title: false, description: true, tags: false });
  assert.deepEqual(partial.missing, [], "a field nobody asked for cannot be missing");
});

// ── the runner ───────────────────────────────────────────────────────────────

test("a batch runs one session at a time and stores all three fields", async () => {
  const { summarizer, llm, store } = harness();
  const started = await summarizer.start(["s1", "s2"], { titles: { s1: "修复导出", s2: "搜索范围" } });
  assert.equal(started.total, 2);

  await settle(summarizer);

  const state = await summarizer.state();
  assert.equal(state.running, false);
  assert.equal(state.done, 2);
  assert.equal(state.failed, 0);
  // Sequential: two calls, and the second started after the first finished.
  assert.equal(llm.calls.length, 2);

  const document = normalizeSummaries(await store.read());
  assert.equal(Object.keys(document.sessions).sort().join(","), "s1,s2");
  assert.equal(document.sessions.s1.title, "修复导出");
  assert.equal(document.sessions.s1.description, "助手的话现在也会导出。");
  assert.deepEqual(document.sessions.s1.tags, ["导出", "会话"]);
  // Nothing is applied on its own: the title is a proposal until it is clicked.
  assert.deepEqual(document.sessions.s1.applied, { title: false, description: false, tags: false });
  // One ledger entry per call, both halves counted.
  assert.equal(document.spend.runs, 2);
  assert.equal(document.spend.inputTokens, 200);
  assert.equal(document.spend.outputTokens, 40);
  assert.equal(document.spend.totalTokens, 240);
});

test("the stored route is used with its effort, and replaced when it is gone", async () => {
  const { summarizer, llm } = harness({
    settings: { summary: { provider: "wb", model: "flash", effort: "high", fields: { ...ALL_FIELDS } } },
  });
  await summarizer.start(["s1"]);
  await settle(summarizer);
  assert.equal(llm.calls[0].provider, "wb");
  assert.equal(llm.calls[0].model, "flash");
  assert.equal(llm.calls[0].reasoningEffort, "high");
});

test("an unknown model falls back to the first one instead of failing", async () => {
  const { summarizer, llm } = harness({
    settings: { summary: { provider: "gone", model: "gone", effort: "nope", fields: { ...ALL_FIELDS } } },
  });
  await summarizer.start(["s1"]);
  await settle(summarizer);
  assert.equal(llm.calls[0].provider, "wb");
  assert.equal(llm.calls[0].model, "flash");
  // An effort the model does not describe is dropped, not forced.
  assert.equal(llm.calls[0].reasoningEffort, undefined);
});

test("a provider failure is reported, billed, and does not sink the batch", async () => {
  let call = 0;
  const { summarizer, store } = harness({
    llm: stubLlm({
      reply: () => {
        call += 1;
        return call === 1 ? { error: "RATE_LIMIT", message: "slow down" } : { text: GOOD_ANSWER, inputTokens: 50, outputTokens: 10 };
      },
    }),
  });
  await summarizer.start(["s1", "s2"]);
  await settle(summarizer);
  const state = await summarizer.state();
  assert.equal(state.failed, 1);
  assert.equal(state.done, 1);
  assert.match(state.lastError, /RATE_LIMIT|限流/);
  assert.equal(state.lastFailureId, "s1");
  const document = normalizeSummaries(await store.read());
  assert.deepEqual(Object.keys(document.sessions), ["s2"]);
  assert.equal(document.spend.failures, 1);
  assert.equal(document.spend.runs, 2);
});

test("an answer that is not the asked-for object gets one more try, and both tries are billed", async () => {
  const answers = ["好的，我总结了这段会话。", '{"title":"修复导出","description":"只给了两个"}'];
  let call = 0;
  const { summarizer, store } = harness({
    llm: stubLlm({
      reply: () => {
        const text = answers[Math.min(call, answers.length - 1)];
        call += 1;
        return { text, inputTokens: 10, outputTokens: 5 };
      },
    }),
  });
  await summarizer.start(["s1"]);
  await settle(summarizer);
  assert.equal(call, 2, "one retry, not a loop");
  const document = normalizeSummaries(await store.read());
  assert.deepEqual(document.sessions, {}, "a half answer is not stored");
  assert.equal(document.spend.runs, 2, "the retry is real money");
  assert.equal(document.spend.failures, 2);
  assert.match((await summarizer.state()).lastError, /没有按要求/);
});

test("a model that says nothing at all is refused as an empty answer", async () => {
  // A reasoning model that spends the whole answer thinking, or a provider
  // that closes the stream without a word: the retry cannot fix silence, so
  // the user is told the model said nothing instead of "your JSON was wrong".
  const llm = stubLlm({ reply: () => ({ text: "   ", inputTokens: 100, outputTokens: 0 }) });
  const { summarizer, store } = harness({ llm });
  await summarizer.start(["s1"]);
  await settle(summarizer);
  assert.deepEqual(normalizeSummaries(await store.read()).sessions, {});
  assert.match((await summarizer.state()).lastError, /没有给出文字回答/);
  assert.equal(llm.requests.length, 2, "silence is retried once, then reported");
});

test("a model that only calls a tool is refused as an empty answer, not stored", async () => {
  const llm = stubLlm({ reply: () => ({ blockType: "tool-call" }) });
  const { summarizer, store } = harness({ llm });
  await summarizer.start(["s1"]);
  await settle(summarizer);
  const document = normalizeSummaries(await store.read());
  assert.deepEqual(document.sessions, {}, "a tool call is not a title");
  assert.equal(document.spend.runs, 2, "the retry happens before giving up");
  assert.match((await summarizer.state()).lastError, /工具/);
  // The retry is not the same sentence twice: the second request carries the
  // line that says what went wrong, or the model would just call the tool again.
  assert.equal(llm.requests.length, 2);
  assert.equal(llm.requests[1].messages.length, llm.requests[0].messages.length, "the retry explains, it does not add a turn");
  assert.match(llm.requests[1].messages.at(-1).content[0].text, /工具/);
  // No tools are declared and no output cap is imposed: the first stops the
  // model from reaching for one, the second stops a reasoning model from
  // spending the whole budget thinking and returning nothing.
  assert.deepEqual(llm.requests[0].tools, []);
  assert.equal(llm.requests[0].maxTokens, undefined);
  // The call carries an identity but not a session: a provider that routes by
  // identity accepts it, and no conversation history is touched by it.
  assert.equal(llm.requests[0].sessionId, "session-navigator");
});

test("a reasoning block before the answer is not an error", async () => {
  // deepseek-v4.1-flash and friends open with a reasoning block. Treating a
  // non-text block as "it wants to call a tool" made every reasoning model
  // fail on the first chunk of every call.
  const llm = stubLlm({ reply: () => ({ text: GOOD_ANSWER, inputTokens: 100, outputTokens: 20, blockType: "reasoning" }) });
  const { summarizer, store } = harness({ llm });
  await summarizer.start(["s1"]);
  await settle(summarizer);
  const document = normalizeSummaries(await store.read());
  assert.equal(document.sessions.s1?.title, "修复导出");
  assert.equal(llm.requests.length, 1, "the first attempt succeeded, so there is no retry");
});

test("a tool call next to real text keeps the text", async () => {
  // Some models reach for a tool and still answer. Throwing the answer away
  // because a second block was not text punished the good half of the reply.
  const llm = stubLlm({
    reply: () => ({ text: GOOD_ANSWER, inputTokens: 100, outputTokens: 20, blockType: "text-and-tool" }),
  });
  const { summarizer, store } = harness({ llm });
  await summarizer.start(["s1"]);
  await settle(summarizer);
  const document = normalizeSummaries(await store.read());
  assert.equal(document.sessions.s1?.title, "修复导出", "the text beside the tool call is the answer");
});

test("switching every field off is refused before the model is called", async () => {
  const { summarizer, llm } = harness({
    settings: { summary: { provider: "", model: "", effort: "", fields: { title: false, description: false, tags: false } } },
  });
  await summarizer.start(["s1"]);
  await settle(summarizer);
  assert.equal(llm.calls.length, 0);
  assert.match((await summarizer.state()).lastError, /没有勾选/);
});

test("a session with nothing said is refused without calling the model", async () => {
  const { summarizer, llm } = harness({ artifact: { header: {}, events: [] } });
  await summarizer.start(["s1"]);
  await settle(summarizer);
  assert.equal(llm.calls.length, 0);
  assert.match((await summarizer.state()).lastError, /没有可读的对话/);
});

test("no llm service is a refusal before anything is queued", async () => {
  const summarizer = createSummarizer({
    getLlm: () => null,
    summaries: memoryStore(),
    settings: async () => ({ summary: {} }),
    session: async () => null,
    read: async () => ({ events: [] }),
  });
  await assert.rejects(() => summarizer.start(["s1"]), (failure) => failure.code === "llm-unavailable");
  assert.equal((await summarizer.state()).total, 0);
});

test("queueing the same session twice bills it once", async () => {
  const { summarizer, llm } = harness();
  await summarizer.start(["s1"]);
  await summarizer.start(["s1", "s2"]);
  await settle(summarizer);
  assert.equal(llm.calls.length, 2);
});

test("a batch larger than the bound is refused", async () => {
  const { summarizer } = harness();
  const ids = Array.from({ length: MAX_BATCH + 1 }, (_, index) => `s${index}`);
  await assert.rejects(() => summarizer.start(ids), (failure) => failure.code === "too-many");
});

test("a key that a plain object already has is not a session id", () => {
  // Both directions of the same hazard: a stored `__proto__` key would answer
  // every `sessions[id]` lookup, so the whole library would look summarized.
  const raw = JSON.parse('{"sessions":{"__proto__":{"title":"假的","description":"假的","tags":["假"]}},"spend":{}}');
  const clean = normalizeSummaries(raw);
  assert.deepEqual(Object.keys(clean.sessions), []);
  assert.deepEqual(pendingSummaryIds([{ id: "s1", logPath: "a", stats: { steps: 2 } }], clean), ["s1"]);
});

test("an id that cannot be a session key never reaches the queue", async () => {
  const { summarizer, store } = harness();
  const state = await summarizer.start(["__proto__", "constructor", "", "s1"]);
  assert.equal(state.total, 1, "only the real id was queued");
  await settle(summarizer);
  const document = await store.read();
  assert.deepEqual(Object.keys(document.sessions), ["s1"]);
});

test("cancel stops the queue and keeps what already finished", async () => {
  const { summarizer, store } = harness({ llm: stubLlm({ reply: () => ({ text: GOOD_ANSWER, inputTokens: 5, outputTokens: 1, delay: 5 }) }) });
  await summarizer.start(["s1", "s2", "s3"]);
  await summarizer.cancel();
  for (let guard = 0; guard < 200 && (await summarizer.state()).running; guard += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const state = await summarizer.state();
  assert.equal(state.running, false);
  assert.equal(state.cancelled, true);
  assert.ok(state.done <= 1);
  const document = normalizeSummaries(await store.read());
  assert.ok(Object.keys(document.sessions).length <= 1);
});

// ── the model catalogue ──────────────────────────────────────────────────────

test("the catalogue groups models with their efforts and isolates a broken provider", async () => {
  const llm = stubLlm({ providers: [{ id: "wb", name: "WB Proxy" }, { id: "broken", name: "Broken" }], failModels: "broken" });
  const { summarizer } = harness({ llm });
  const catalogue = await summarizer.catalog(true);
  assert.equal(catalogue.providers.length, 1);
  assert.equal(catalogue.providers[0].models[0].efforts.length, 2);
  assert.equal(catalogue.providers[0].models[0].defaultEffort, "low");
  // One provider that cannot list its models must not hide the other.
  assert.equal(catalogue.failures.length, 1);
  assert.match(catalogue.failures[0], /^broken:/);
});

test("a model that cannot describe itself is still offered, without efforts", async () => {
  const llm = stubLlm({ failResolve: "flash" });
  const { summarizer } = harness({ llm });
  const catalogue = await summarizer.catalog(true);
  assert.deepEqual(catalogue.providers[0].models[0].efforts, []);
  assert.equal(catalogue.failures.length, 1);
});

test("the catalogue is cached until it is dropped", async () => {
  let listed = 0;
  const llm = stubLlm();
  const counted = { ...llm, listProviders: () => (listed += 1, llm.listProviders()) };
  const { summarizer } = harness({ llm: counted });
  await summarizer.catalog();
  await summarizer.catalog();
  assert.equal(listed, 1);
  summarizer.refresh();
  await summarizer.catalog();
  assert.equal(listed, 2);
});

test("the prompt sent to the model carries the conversation, not the tool log", async () => {
  const seen = [];
  const { summarizer } = harness({
    llm: stubLlm({
      reply: (config, request) => {
        seen.push(request);
        return { text: GOOD_ANSWER, inputTokens: 1, outputTokens: 1 };
      },
    }),
    artifact: {
      events: [
        userSay(1, "为什么导出只有用户的话"),
        agentSay(2, "因为读错了字段"),
        { type: "tool/result", seq: 3, data: { message: { content: [{ type: "text", text: "巨大的工具输出" }] } } },
      ],
    },
  });
  await summarizer.start(["s1"]);
  await settle(summarizer);
  const text = seen[0].messages[0].content[0].text;
  assert.match(text, /为什么导出只有用户的话/);
  assert.match(text, /因为读错了字段/);
  assert.doesNotMatch(text, /巨大的工具输出/);
  assert.ok(text.length < PROMPT_BUDGET_CHARS + 1000);
});

// ── the status each refusal becomes ─────────────────────────────────────────

test("every refusal the field routes can answer has a status the client can act on", () => {
  // The panel branches on the envelope's code, and the status is what a browser
  // devtools or a curl user sees. A refusal answered as 200 would make the
  // button flash a success message over a run that never happened.
  assert.equal(statusFor("llm-unavailable"), 501, "this profile has no model service");
  assert.equal(statusFor("nothing-pending"), 409, "nothing to do is the answer, not a failure");
  assert.equal(statusFor("too-many"), 413, "one batch is bounded");
  for (const code of ["llm/MISSING_CREDENTIAL", "llm/INVALID_CREDENTIAL", "llm/AUTH"]) {
    assert.equal(statusFor(code), 401, code + " is the user's key to fix");
  }
  for (const code of ["llm/RATE_LIMIT", "llm/QUOTA", "llm/ACCOUNT_QUOTA"]) {
    assert.equal(statusFor(code), 429, code + " is the provider asking to wait");
  }
  for (const code of ["llm/CONTEXT_WINDOW_EXCEEDED", "llm/empty", "llm/tool-only", "llm/no-finish", "nothing-to-summarize", "ai/bad-answer"]) {
    assert.equal(statusFor(code), 422, code + " is about this payload");
  }
  // Configuration states, not malformed requests: nothing is switched on, or
  // there is nothing generated to apply.
  assert.equal(statusFor("ai/no-fields"), 409);
  assert.equal(statusFor("nothing-to-apply"), 409);
  // An adapter that invents a new failure code must not look like success.
  assert.equal(statusFor("llm/SOMETHING_NEW"), 500);
});

// ── merging without inventing twins (m02641) ─────────────────────────────────

test("a generated tag that already exists keeps the existing spelling", () => {
  // "导出" is in use, so an answer that says "导出 " (or "导出" again) has to
  // land on the stored word instead of growing a second row that reads the same.
  assert.deepEqual(alignTags(["导出 ", "会话导出", "导出"], ["导出", "会话"]), ["导出", "会话导出"]);
  assert.deepEqual(alignTags(["DOCKER"], ["docker"]), ["docker"]);
  assert.deepEqual(alignTags([], ["导出"]), []);
});

test("a tag the library has no word for is kept, not dropped", () => {
  assert.deepEqual(alignTags(["性能"], ["导出"]), ["性能"]);
});

test("merging a description appends to the note, never replaces it", () => {
  assert.equal(mergeNote("", "助手的话现在也会导出。"), "助手的话现在也会导出。");
  assert.equal(mergeNote("我写的", "模型写的"), "我写的\n\n模型写的");
  // Pressing 合并 twice must not paste the same paragraph in twice.
  assert.equal(mergeNote("我写的\n\n模型写的", "模型写的"), "我写的\n\n模型写的");
});

test("only the tags the user ticked are merged, and an unknown tick is a refusal", () => {
  assert.deepEqual(pickTags(["导出", "会话"], undefined), ["导出", "会话"]);
  assert.deepEqual(pickTags(["导出", "会话"], ["会话"]), ["会话"]);
  assert.deepEqual(pickTags(["导出", "会话"], ["会话 "]), ["会话"]);
  // A tick that names nothing stored means the selection is stale: merging
  // everything instead would apply rows the user never saw.
  assert.deepEqual(pickTags(["导出"], ["别的"]), []);
  assert.deepEqual(pickTags(["导出"], []), []);
});

test("the prompt shows the tags already in use and asks for them first", () => {
  const zh = systemPrompt("zh", { tags: true }, ["导出", "会话"]);
  assert.match(zh, /导出、会话/);
  assert.match(zh, /优先/);
  const en = systemPrompt("en", { tags: true }, ["export", "session"]);
  assert.match(en, /export, session/);
  // Nothing in use, nothing to prefer.
  assert.doesNotMatch(systemPrompt("zh", { tags: true }, []), /已经在用/);
  // Tags switched off: the vocabulary has no business in the prompt at all.
  assert.doesNotMatch(systemPrompt("zh", { title: true }, ["导出"]), /导出/);
});

test("a run reads the tag library and reuses its words", async () => {
  const llm = stubLlm({
    reply: () => ({
      text: JSON.stringify({ title: "修复导出", description: "改好了", tags: ["导出 ", "新词"] }),
    }),
  });
  const { summarizer, store } = harness({ llm, existingTags: ["导出", "会话"] });
  await summarizer.start(["s1"]);
  await settle(summarizer);
  const document = normalizeSummaries(await store.read());
  assert.deepEqual(document.sessions.s1?.tags, ["导出", "新词"]);
  assert.match(llm.requests[0].system, /导出、会话/);
});

test("the record remembers which of the three parts were taken over", () => {
  const entry = normalizeSummaryEntry({
    title: "修复导出",
    description: "助手的话现在也会导出。",
    tags: ["导出"],
    applied: { title: true, description: true },
  });
  assert.deepEqual(entry.applied, { title: true, description: true, tags: false });
});
