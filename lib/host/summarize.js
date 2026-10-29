/**
 * dsh-session-navigator — the AI 字段 runner (m00531).
 *
 * One queue, one worker, one session at a time. The alternative — a promise per
 * session — would fire twelve requests at a provider that bills per token and
 * rate-limits per minute, and the only thing parallelism would buy is a faster
 * way to hit RATE_LIMIT. Sequential has a second benefit: 进度 in the settings
 * page and in the status bar is a single honest fraction (`done / total`)
 * instead of an aggregate of racing counters.
 *
 * The queue lives in memory on purpose. A summary that was half-made when DSH
 * stopped is worth nothing (there is no partial answer to keep), and a job that
 * survived a restart would be a job whose model call is already gone. What must
 * survive is the result — that is in `summaries.v1.json` — and the ledger of
 * what it cost, which is in the same file.
 *
 * Everything the model sees comes from `domain/summaries.js`; everything this
 * module owns is transport: resolving a route, streaming, and counting. That
 * split is what lets the prompt be tested without a provider.
 *
 * @module lib/host/summarize
 */

import { readArtifact } from "../sources/artifact.js";
import { turnsOf } from "../domain/export.js";
import { isAnnotationId } from "../domain/annotations.js";
import {
  MAX_BATCH,
  addSpend,
  alignTags,
  buildMessages,
  extractJsonObject,
  normalizeFields,
  normalizeSummaries,
  retryNudge,
  wantedFields,
} from "../domain/summaries.js";
import { codedError } from "../store/sidecar.js";

/**
 * The identity this plugin calls the model under.
 *
 * A provider that routes by call identity rejects a request without one (the
 * bundled dsh-pet plugin passes its own name for the same reason), and it is
 * deliberately not a real session id: this call is not part of any
 * conversation, so nothing may be loaded into or appended to session history
 * on its behalf.
 */
const CALL_IDENTITY = "session-navigator";

/** How long a route catalogue is trusted before it is asked for again. */
const CATALOG_TTL_MS = 60_000;

/** One summary may not occupy the worker longer than this. */
const RUN_TIMEOUT_MS = 180_000;

/**
 * @param {{
 *   getLlm: () => any,
 *   getSessionController?: () => any,
 *   summaries: { read: () => Promise<any>, mutate: (mutator: (draft: any) => any, revision?: number) => Promise<any> },
 *   settings: () => Promise<any>,
 *   read?: typeof readArtifact,
 *   now?: () => number,
 *   log?: (level: string, message: string) => void,
 * }} options
 */
export function createSummarizer(options) {
  const getLlm = options.getLlm;
  const getSessionController = options.getSessionController ?? (() => undefined);
  // The tag vocabulary, already in use by this user. Read per session rather
  // than cached for the run: a batch of twelve can outlive a tag the user adds
  // to the library in the middle of it, and the newer list is the better hint.
  const existingTags = options.existingTags ?? (async () => []);
  const summaries = options.summaries;
  const settingsOf = options.settings;
  const read = options.read ?? readArtifact;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});

  /** @type {{ at: number, value: any } | null} */
  let catalogCache = null;

  /**
   * The tag vocabulary to put in the prompt.
   *
   * Best effort on purpose: a library that cannot be read is a missing hint,
   * not a failed run. The answer is still checked and the tags that come out
   * are still snapped onto whatever the caller can tell us it already has.
   */
  async function tagsOf() {
    try {
      const list = await existingTags();
      return Array.isArray(list) ? list.filter((tag) => typeof tag === "string" && tag.trim() !== "") : [];
    } catch (failure) {
      log("warn", `summarize: could not read the tag library: ${failure?.message ?? failure}`);
      return [];
    }
  }

  const job = {
    /** @type {{ id: string, title: string }[]} */
    queue: [],
    /** @type {{ id: string, title: string, startedAt: number } | null} */
    current: null,
    total: 0,
    done: 0,
    failed: 0,
    lastError: "",
    lastFailureId: "",
    startedAt: null,
    finishedAt: null,
    running: false,
    cancelled: false,
  };

  /** @type {AbortController | null} */
  let abort = null;

  /**
   * The models this build may offer, grouped by provider.
   *
   * The catalogue comes from `sessionController.modelCatalog()` whenever the
   * deployment has that service. That is the same projection the host's own
   * model picker draws, so 设置页 offers exactly the routes the rest of DSH
   * offers — same provider names, same model names, same effort ids — instead
   * of a second opinion assembled here that could drift from it. (dsh-orb reads
   * the same service for the same reason.)
   *
   * Walking the llm registry directly is the fallback, for a profile that has
   * no session controller. It costs one `resolveModelInfo` call per model —
   * which may reach the network — so it is the slow path, not the default.
   *
   * Either way the answer is cached: the settings page asks for this every time
   * it opens, and a provider that is merely slow must not make the page slow.
   * Provider failures land in `failures` and are skipped; one broken route must
   * not hide the others.
   *
   * @param {boolean} [fresh]
   * @returns {Promise<any>}
   */
  async function catalog(fresh = false) {
    if (!fresh && catalogCache && now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value;
    const fromController = await catalogFromController();
    const value = fromController ?? await catalogFromLlm();
    catalogCache = { at: now(), value };
    return value;
  }

  /**
   * `{ providers, failures, at }` as the session controller describes it, or
   * null when this deployment has no such service.
   *
   * @returns {Promise<any | null>}
   */
  async function catalogFromController() {
    const controller = getSessionController();
    if (!controller || typeof controller.modelCatalog !== "function") return null;
    let answer;
    try {
      answer = await controller.modelCatalog();
    } catch (failure) {
      // A controller that cannot answer is not a fatal condition: the registry
      // is still there, so fall through to it rather than refusing to work.
      log("warn", `summarize: modelCatalog failed: ${messageOf(failure)}`);
      return null;
    }

    /** @type {any[]} */
    const providers = [];
    for (const group of Array.isArray(answer?.groups) ? answer.groups : []) {
      const id = typeof group?.id === "string" ? group.id : "";
      if (id === "") continue;
      /** @type {any[]} */
      const models = [];
      for (const model of Array.isArray(group?.models) ? group.models : []) {
        const modelId = typeof model?.id === "string" ? model.id : "";
        if (modelId === "") continue;
        /** @type {{ id: string, name: string }[]} */
        const efforts = [];
        const reasoning = model?.reasoning;
        if (reasoning && Array.isArray(reasoning.efforts)) {
          for (const effort of reasoning.efforts) {
            if (typeof effort?.id !== "string" || effort.id === "") continue;
            efforts.push({ id: effort.id, name: typeof effort.name === "string" && effort.name !== "" ? effort.name : effort.id });
          }
        }
        models.push({
          id: modelId,
          name: typeof model?.name === "string" && model.name !== "" ? model.name : modelId,
          description: typeof model?.description === "string" ? model.description : "",
          efforts,
          defaultEffort: typeof reasoning?.defaultEffort === "string" ? reasoning.defaultEffort : "",
        });
      }
      if (models.length === 0) continue;
      providers.push({ id, name: typeof group?.name === "string" && group.name !== "" ? group.name : id, models });
    }

    /** @type {string[]} */
    const failures = [];
    for (const failure of Array.isArray(answer?.failures) ? answer.failures : []) {
      const id = typeof failure?.id === "string" ? failure.id : "";
      const message = typeof failure?.message === "string" ? failure.message : "";
      failures.push(id === "" ? message : `${id}: ${message}`);
    }
    return { providers, failures, at: now() };
  }

  /**
   * `{ providers, failures, at }` assembled from the llm registry itself.
   *
   * @returns {Promise<any>}
   */
  async function catalogFromLlm() {
    const llm = getLlm();
    if (!llm || typeof llm.listProviders !== "function") {
      throw codedError("llm-unavailable", "模型服务不可用：当前 DSH 没有加载 llm 服务");
    }

    const providers = await llm.listProviders();
    /** @type {any[]} */
    const groups = [];
    /** @type {string[]} */
    const failures = [];

    for (const provider of Array.isArray(providers) ? providers : []) {
      const id = typeof provider?.id === "string" ? provider.id : "";
      if (id === "") continue;
      let models = [];
      try {
        models = await llm.listModels(id);
      } catch (failure) {
        failures.push(`${id}: ${messageOf(failure)}`);
        continue;
      }
      /** @type {any[]} */
      const entries = [];
      for (const model of Array.isArray(models) ? models : []) {
        const modelId = typeof model?.id === "string" ? model.id : "";
        if (modelId === "") continue;
        /** @type {{ id: string, name?: string }[]} */
        let efforts = [];
        let defaultEffort = "";
        try {
          const resolved = await llm.resolveModelInfo(id, modelId);
          const reasoning = resolved?.reasoning;
          if (reasoning && Array.isArray(reasoning.efforts)) {
            efforts = reasoning.efforts
              .filter((effort) => typeof effort?.id === "string" && effort.id !== "")
              .map((effort) => ({ id: effort.id, name: typeof effort.name === "string" && effort.name !== "" ? effort.name : effort.id }));
          }
          if (typeof reasoning?.defaultEffort === "string") defaultEffort = reasoning.defaultEffort;
        } catch (failure) {
          // A model that cannot describe itself can still be called, so it is
          // offered without the effort picker rather than dropped.
          failures.push(`${id}/${modelId}: ${messageOf(failure)}`);
        }
        entries.push({
          id: modelId,
          name: typeof model?.name === "string" && model.name !== "" ? model.name : modelId,
          description: typeof model?.description === "string" ? model.description : "",
          efforts,
          defaultEffort,
        });
      }
      if (entries.length === 0) continue;
      groups.push({
        id,
        name: typeof provider?.name === "string" && provider.name !== "" ? provider.name : id,
        models: entries,
      });
    }

    return { providers: groups, failures, at: now() };
  }

  /**
   * Which route one summary is made on.
   *
   * The stored choice is honoured when it still exists, and silently replaced
   * when it does not: a model can disappear from a profile between two runs,
   * and answering "the model you picked is gone" is a worse answer than using
   * the next one and saying so in the result.
   *
   * @param {any} catalogue
   * @param {any} choice `settings.summary`
   * @returns {{ provider: string, model: string, effort: string, replaced: boolean }}
   */
  function pickRoute(catalogue, choice) {
    const providers = catalogue?.providers ?? [];
    const wantedProvider = typeof choice?.provider === "string" ? choice.provider : "";
    const group = providers.find((entry) => entry.id === wantedProvider) ?? providers[0] ?? null;
    if (!group) throw codedError("llm-unavailable", "没有可用的模型：当前 DSH 尚未配置任何提供方或凭据");
    const wantedModel = typeof choice?.model === "string" ? choice.model : "";
    const model = group.models.find((entry) => entry.id === wantedModel) ?? group.models[0];
    const wantedEffort = typeof choice?.effort === "string" ? choice.effort : "";
    const efforts = model.efforts ?? [];
    const effort = efforts.some((entry) => entry.id === wantedEffort) ? wantedEffort : "";
    return {
      provider: group.id,
      model: model.id,
      effort,
      replaced: group.id !== wantedProvider || model.id !== wantedModel,
    };
  }

  /**
   * A poll-able snapshot. `spend` rides along so the settings page can show the
   * running total climbing while a batch runs, without a second request.
   *
   * @returns {Promise<any>}
   */
  async function state() {
    const document = normalizeSummaries(await summaries.read());
    return {
      running: job.running,
      cancelled: job.cancelled,
      total: job.total,
      done: job.done,
      failed: job.failed,
      pending: job.queue.length,
      current: job.current ? { id: job.current.id, title: job.current.title, startedAt: job.current.startedAt } : null,
      lastError: job.lastError,
      lastFailureId: job.lastFailureId,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      spend: document.spend,
      summarized: Object.keys(document.sessions).length,
    };
  }

  /**
   * Add sessions to the queue and start the worker if it is idle.
   *
   * Re-queueing a session that is already waiting is dropped instead of
   * duplicated: pressing 总结 twice on the same row is a user being impatient,
   * not a request for two summaries and two bills.
   *
   * @param {readonly string[]} ids
   * @param {{ titles?: Record<string, string>, lang?: string }} [meta]
   * @returns {Promise<any>}
   */
  async function start(ids, meta = {}) {
    // `isAnnotationId` is the session-id grammar this plugin already uses for
    // annotation keys, and the summaries document is keyed the same way: an id
    // of `__proto__` would be written as a key that answers every lookup.
    const wanted = Array.isArray(ids)
      ? ids.filter((id) => typeof id === "string" && id !== "" && isAnnotationId(id))
      : [];
    if (wanted.length === 0) throw codedError("bad-request", "没有要总结的会话");
    if (wanted.length > MAX_BATCH) throw codedError("too-many", `一次最多总结 ${MAX_BATCH} 个会话`);
    // Fail before queueing anything when there is no model to call: a batch
    // that fails on its first item for a reason known upfront is a worse
    // experience than a refusal that says what to fix.
    pickRoute(await catalog(), await choiceOf());

    const titles = meta?.titles && typeof meta.titles === "object" ? meta.titles : {};
    if (!job.running) {
      job.queue.length = 0;
      job.total = 0;
      job.done = 0;
      job.failed = 0;
      job.lastError = "";
      job.lastFailureId = "";
      job.startedAt = now();
      job.finishedAt = null;
      job.cancelled = false;
    }
    const known = new Set(job.queue.map((entry) => entry.id));
    if (job.current) known.add(job.current.id);
    let added = 0;
    for (const id of wanted) {
      if (known.has(id)) continue;
      known.add(id);
      job.queue.push({ id, title: typeof titles[id] === "string" ? titles[id] : "" });
      added += 1;
    }
    job.total += added;
    if (added > 0 && !job.running) void pump(meta?.lang === "en" ? "en" : "zh");
    return state();
  }

  /**
   * Stop after the call in flight. The abort reaches the provider as a real
   * cancellation, so the tokens are not spent and no half-answer is stored.
   *
   * @returns {Promise<any>}
   */
  async function cancel() {
    job.cancelled = true;
    job.queue.length = 0;
    job.total = Math.max(job.total, job.done + job.failed + (job.current ? 1 : 0));
    abort?.abort();
    return state();
  }

  /**
   * @param {string} lang
   */
  async function pump(lang) {
    if (job.running) return;
    job.running = true;
    try {
      while (job.queue.length > 0 && !job.cancelled) {
        const entry = job.queue.shift();
        job.current = { id: entry.id, title: entry.title, startedAt: now() };
        try {
          await runOne(entry, lang);
          job.done += 1;
        } catch (failure) {
          if (job.cancelled) break;
          job.failed += 1;
          job.lastFailureId = entry.id;
          job.lastError = `${entry.title || entry.id}：${messageOf(failure)}`;
          log("warn", `summarize ${entry.id} failed: ${messageOf(failure)}`);
        } finally {
          job.current = null;
        }
      }
    } finally {
      job.running = false;
      job.finishedAt = now();
      abort = null;
    }
  }

  /**
   * Read one session, ask for the three fields, check the answer, store it.
   *
   * A model that answers in prose, or forgets a field it was asked for, gets one
   * more attempt (user instruction: 重试一次). Both attempts are billed, so both
   * land in the ledger — the second call is real money, not a free re-roll.
   * Nothing is written until every requested field is present: a record with a
   * title and no description would look finished to the panel while leaving the
   * sweep with nothing to retry.
   *
   * @param {{ id: string, title: string }} entry
   * @param {"zh"|"en"} lang
   */
  async function runOne(entry, lang) {
    const llm = getLlm();
    if (!llm || typeof llm.prepareCall !== "function") {
      throw codedError("llm-unavailable", "模型服务不可用：当前 DSH 没有加载 llm 服务");
    }
    const choice = await choiceOf();
    const route = pickRoute(await catalog(), choice);
    const fields = choice.fields ?? { title: true, description: true, tags: true };
    // Nothing switched on is a configuration mistake, not a call to make.
    if (wantedFields(fields).length === 0) {
      throw codedError("ai/no-fields", "没有勾选任何要生成的字段");
    }

    const session = await metaOf(entry.id);
    if (!session) throw codedError("session/not-found", `找不到会话 ${entry.id}`);
    if (!session.logPath) throw codedError("session-not-found", `会话 ${entry.id} 没有可读的日志`);
    const artifact = await read(session.logPath, { tolerateTail: true });
    const turns = turnsOf(artifact?.events ?? []);
    // The library first: the model is told what this user already files things
    // under, so it reuses "导出" instead of inventing "会话导出功能".
    const vocabulary = await tagsOf();
    const built = buildMessages({
      turns,
      facts: { createdAt: session.createdAt ?? null, activityAt: session.activityAt ?? null, steps: session.stats?.steps ?? 0 },
      lang,
      fields,
      vocabulary,
    });
    if (built.transcript.totalTurns === 0) {
      throw codedError("nothing-to-summarize", "这段会话里没有可读的对话");
    }

    /** @type {string[]} */
    let missing = [];
    // Whether the model reached for a tool on the last attempt: the difference
    // between "it answered nonsense" and "it would rather call a tool".
    let lastSawTool = false;
    // Whether the last attempt produced no words at all.
    let lastEmpty = false;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      // Fresh controller per attempt: an aborted one cannot be reused, and a
      // cancelled batch must be able to stop the retry too.
      abort = new AbortController();
      const signal = deadline(abort.signal, RUN_TIMEOUT_MS);
      /** @type {{ usage: any }} */
      const holder = { usage: null };
      let answer = { text: "", sawTool: false };
      try {
        // A retry repeats the request *and says what was wrong with the last
        // answer*. Asking the same question again in the same words tends to
        // get the same shape back, which is how "it wanted to call a tool"
        // turns into two identical failures. The line goes onto the existing
        // user message rather than a second one: some providers insist on
        // alternating roles and would reject two user turns in a row.
        const ask = attempt === 1 ? built : withNudge(built, retryNudge(lang));
        answer = await streamOnce(llm, route, ask, signal, holder);
      } catch (failure) {
        // Billed-but-failed is a real state: the input tokens were consumed
        // before the stream broke. Recording them keeps 累计花费 honest.
        await recordSpend(holder.usage, false);
        abort = null;
        throw failure;
      }
      abort = null;

      const parsed = extractJsonObject(answer.text);
      const checked = normalizeFields(parsed, fields);
      // Same words, different spelling: "导出" already exists, so the answer
      // says "导出" and the library does not grow a twin.
      checked.tags = alignTags(checked.tags, vocabulary);
      if (checked.missing.length === 0) {
        await store(entry.id, {
          title: checked.title,
          description: checked.description,
          tags: checked.tags,
          at: now(),
          sourceAt: Number.isFinite(session.activityAt) ? session.activityAt : null,
          model: { provider: route.provider, model: route.model, effort: route.effort },
          tokens: holder.usage ? { inputTokens: count(holder.usage.inputTokens), outputTokens: count(holder.usage.outputTokens) } : null,
          turns: built.transcript.totalTurns,
          // Applying is always a click: a generated title never renames a
          // session on its own, and generated tags are not pushed into the
          // user's own tag list until asked for.
          applied: { title: false, description: false, tags: false },
        }, holder.usage, true);
        return;
      }
      missing = checked.missing;
      lastSawTool = answer.sawTool;
      lastEmpty = answer.text.trim() === "";
      await recordSpend(holder.usage, false);
      log("warn", `summarize ${entry.id} attempt ${attempt}: missing ${missing.join(", ")}${answer.sawTool ? " (the model tried to call a tool)" : ""}`);
    }

    // No words at all is a different failure from "it answered, but not with
    // the object it was told to answer with": the first is the model (or the
    // provider) refusing to talk, the second is a wording problem the retry
    // addresses. Telling the user which one happened is the difference between
    // "pick another model" and "try again". `llm/tool-only` names the case
    // where what it produced instead was a tool call it has no tool for.
    if (lastEmpty) {
      throw codedError(
        lastSawTool ? "llm/tool-only" : "llm/empty",
        lastSawTool ? "模型只想调用工具，没有给出文字回答" : "模型没有给出文字回答",
      );
    }
    throw codedError("ai/bad-answer", `模型没有按要求给出${fieldNames(missing, lang)}，回答已丢弃`);
  }

  /**
   * One model call, text only.
   *
   * Two things here are deliberate and were learned the hard way:
   *
   * - No `maxTokens`. A reasoning model spends its thinking out of that same
   *   budget, so a tight cap buys an empty body, not a short answer — the
   *   bundled dsh-pet plugin documents the same failure ("推理模型会把思考计入
   *   预算，显式小上限只会截断正文报模型未返回文本"). The prompt already asks
   *   for three short fields and `RUN_TIMEOUT_MS` bounds the call.
   * - A tool-call block is not an error. Some models answer a filing request
   *   by reaching for a tool they were never given; the text may still be
   *   there, and when it is not, the retry says "do not call a tool" instead
   *   of us throwing away a usable answer. Only "no text at all" fails, and it
   *   fails as an empty answer so `runOne` can retry once.
   */
  async function streamOnce(llm, route, built, signal, holder) {
    // `prepareCall` freezes the route, and the stream options must spread that
    // exact config or the runtime rejects the call as INVALID_PREPARED_CALL.
    // `tools` is not part of that config, so declaring none here is legal and
    // is the whole point: no tools means the model has nothing to reach for.
    const call = await llm.prepareCall(
      {
        provider: route.provider,
        model: route.model,
        ...(route.effort === "" ? {} : { reasoningEffort: route.effort }),
      },
      signal,
    );
    let text = "";
    let sawTool = false;
    let terminal = null;
    const options = {
      ...call.config,
      sessionId: CALL_IDENTITY,
      tools: [],
      messages: built.messages,
      system: built.system,
      signal,
    };
    for await (const chunk of call.stream(options)) {
      if (chunk?.type === "block-start" && chunk.blockType !== "text") sawTool = true;
      else if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
      // Some adapters only report the finished block; take its text when no
      // delta ever arrived for it.
      else if (chunk?.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string" && text === "") {
        text = chunk.block.text;
      } else if (chunk?.type === "usage") holder.usage = chunk.usage ?? null;
      else if (chunk?.type === "finish") {
        terminal = chunk.reason;
        if (chunk.reason?.kind !== "stop") {
          const failure = chunk.reason?.failure;
          const code = typeof failure?.code === "string" ? failure.code : "unknown";
          throw codedError(`llm/${code}`, chunk.reason?.kind === "aborted" ? "模型调用被取消" : describeFailure(failure));
        }
      }
    }
    // Every stream ends in a finish chunk; a missing one means the adapter
    // closed the iterator early, which is not an answer either.
    if (terminal?.kind !== "stop") throw codedError("llm/no-finish", "模型调用没有正常结束");
    return { text, sawTool };
  }

  /**
   * The same request with one more line on the last user message.
   *
   * Not a second message: the providers behind these adapters differ on whether
   * two user turns in a row are legal, and every one of them accepts a longer
   * turn. The conversation itself is untouched — only the instruction grows.
   *
   * @param {ReturnType<typeof buildMessages>} built
   * @param {string} nudge
   * @returns {ReturnType<typeof buildMessages>}
   */
  function withNudge(built, nudge) {
    const last = built.messages.length - 1;
    const messages = built.messages.map((message, index) => {
      if (index !== last) return message;
      return {
        ...message,
        content: message.content.map((block) => (block?.type === "text" ? { ...block, text: `${block.text}\n\n${nudge}` } : block)),
      };
    });
    return { ...built, messages };
  }

  /**
   * `标题和标签` — the field names, for an error the user reads.
   *
   * @param {string[]} missing
   * @param {"zh"|"en"} lang
   * @returns {string}
   */
  function fieldNames(missing, lang) {
    const names = missing.map((field) => (lang === "en"
      ? (field === "title" ? "a title" : field === "description" ? "a description" : "tags")
      : (field === "title" ? "标题" : field === "description" ? "描述" : "标签")));
    if (names.length === 1) return names[0];
    return lang === "en" ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : `${names.slice(0, -1).join("、")}或${names[names.length - 1]}`;
  }

  /**
   * @param {string} sessionId
   * @param {any} entry
   * @param {any} usage
   * @param {boolean} ok
   */
  async function store(sessionId, entry, usage, ok) {
    await summaries.mutate((draft) => {
      const document = normalizeSummaries(draft);
      document.sessions[sessionId] = entry;
      document.spend = addSpend(document.spend, usage, ok);
      return document;
    });
  }

  /**
   * Add one attempt to the ledger, whether or not it produced anything.
   *
   * An attempt with no `usage` still counts: it is a run the user asked for and
   * a call the provider may well have billed. Counting only what came back
   * would make 累计花费 a floor dressed as a total.
   *
   * @param {any} usage
   * @param {boolean} ok
   */
  async function recordSpend(usage, ok) {
    try {
      await summaries.mutate((draft) => {
        const document = normalizeSummaries(draft);
        document.spend = addSpend(document.spend, usage, ok);
        return document;
      });
    } catch (failure) {
      // A ledger write that fails must not turn a good summary into a failed
      // one; the next run adds its own usage on top of what is on disk.
      log("warn", `summarize spend not recorded: ${messageOf(failure)}`);
    }
  }

  /**
   * @returns {Promise<any>}
   */
  async function choiceOf() {
    const settings = await settingsOf();
    return settings?.summary ?? {};
  }

  /**
   * The reader snapshot row for one session, with its annotation folded in.
   *
   * @param {string} id
   * @returns {Promise<any|null>}
   */
  async function metaOf(id) {
    const lookup = options.session;
    if (typeof lookup !== "function") throw codedError("internal", "summarizer has no session lookup");
    return lookup(id);
  }

  return {
    catalog,
    state,
    start,
    cancel,
    /** Drop the cached routes; the settings page's 刷新 calls this. */
    refresh() {
      catalogCache = null;
    },
  };
}

/**
 * An abort signal that also fires on its own after `ms`.
 *
 * `AbortSignal.any` is not available on every Node the plugin may run under, so
 * the fallback keeps the timeout without the composition.
 *
 * @param {AbortSignal} signal
 * @param {number} ms
 * @returns {AbortSignal}
 */
function deadline(signal, ms) {
  const timer = AbortSignal.timeout(ms);
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timer]);
  return signal.aborted ? signal : timer;
}

/**
 * The human sentence for a provider failure.
 *
 * The codes are the vocabulary the model layer documents; every one of them
 * names something the user can act on, and "模型调用失败" alone would not.
 *
 * @param {any} failure
 * @returns {string}
 */
function describeFailure(failure) {
  const code = typeof failure?.code === "string" ? failure.code : "";
  const detail = typeof failure?.message === "string" && failure.message !== "" ? failure.message : "";
  switch (code) {
    case "NO_ADAPTER":
      return `没有可用于该模型的提供方${detail ? `（${detail}）` : ""}`;
    case "MISSING_CREDENTIAL":
      return "缺少该提供方的凭据，请先在 DSH 里配置 API Key";
    case "INVALID_CREDENTIAL":
      return "凭据无效，请检查 DSH 里该提供方的 API Key";
    case "AUTH":
      return "提供方拒绝了这次请求的凭据";
    case "RATE_LIMIT":
      return "提供方限流，请稍后再试";
    case "QUOTA":
    case "ACCOUNT_QUOTA":
      return "额度不足，请检查提供方账户";
    case "CONTEXT_WINDOW_EXCEEDED":
      return "会话超出模型的上下文窗口";
    default:
      return detail !== "" ? detail : "模型调用失败";
  }
}

/**
 * @param {any} value
 * @returns {number}
 */
function count(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * @param {any} failure
 * @returns {string}
 */
function messageOf(failure) {
  if (!failure) return "未知错误";
  if (typeof failure === "string") return failure;
  return String(failure.message ?? failure);
}
