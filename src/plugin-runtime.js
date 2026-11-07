// plugin-runtime：从 src/index.js 原样切出
import { PLUGIN_ID } from "./constants.js";
import { normalizeSettings } from "./domain/settings.js";
import { MAX_HITS, MAX_NEEDLE } from "./sources/content.js";
import { liveSessions } from "./sources/live.js";

const name = PLUGIN_ID;

/**
 * @param {any} ctx
 * @param {"info" | "warn" | "error"} level
 * @param {string} message
 */
export function log(ctx, level, message) {
  try {
    const logger = typeof ctx.logger === "function" ? ctx.logger(name) : ctx.logger;
    const write = logger?.[level];
    if (typeof write === "function") write.call(logger, message);
  } catch {
    /* logging must never break a request */
  }
}

/**
 * One session as the summarizer sees it: the listing row plus the parts of the
 * annotation that go into the prompt.
 *
 * The row is the same object the panel draws, so 标题 means exactly what the
 * user reads on screen — the DSH title, or the user's rename of it. The note
 * and the tags come from the annotations sidecar because DSH does not know
 * them; both are optional and both can be switched out of the prompt.
 *
 * @param {any} api
 * @param {string} id
 * @returns {Promise<any|null>}
 */
export async function sessionForSummary(api, id) {
  const snapshot = await api.reader.snapshot({});
  const session = snapshot.sessions.find((entry) => entry.id === id) ?? null;
  if (!session) return null;
  const annotations = await api.documents.annotations.read();
  const annotation = annotations.sessions?.[id] ?? null;
  return {
    ...session,
    note: typeof annotation?.note === "string" ? annotation.note : "",
    tags: Array.isArray(annotation?.tags) ? annotation.tags : [],
  };
}

/**
 * The sidecar state the reader needs, in one round trip.
 *
 * `listSettings` rides along because the tree's counts depend on it: a session
 * the list hides is not a row, so it is not a number either. Reading it here
 * keeps that one decision (which sessions are hidden) on the host, where the
 * tree is built, instead of letting the client subtract from a finished badge.
 *
 * @param {ReturnType<typeof openDocuments>} documents
 * @returns {Promise<{ userTree: object, trashedIds: Set<string>, annotations: Record<string, any>, listSettings: object }>}
 */
export async function readOverlay(documents) {
  const [tree, annotations, trash, settings] = await Promise.all([
    documents.tree.read(),
    documents.annotations.read(),
    documents.trash.read(),
    documents.settings.read(),
  ]);
  return {
    userTree: {
      revision: tree.revision,
      folders: tree.folders ?? {},
      placement: tree.placement ?? {},
      workspaceOrder: tree.workspaceOrder ?? {},
      shortcuts: tree.shortcuts ?? {},
      pins: tree.pins ?? {},
      quickAccess: tree.quickAccess ?? {},
      sessionPlacement: tree.sessionPlacement ?? {},
    },
    trashedIds: new Set(Object.keys(trash.entries ?? {})),
    annotations: annotations.sessions ?? {},
    listSettings: normalizeSettings(settings).list,
  };
}

/**
 * Ids of the sessions whose agent is running right now.
 *
 * `ctx.sessions` is the *loaded* session registry: every session the process has
 * opened since launch, idle ones included. Taking that list as "running" paints
 * 进行中 on the whole sidebar after a restart, keeps it on conversations that
 * finished hours ago, and makes those rows refuse archive and delete, since
 * 进行中 means "a turn is in progress". The agent registry carries the real
 * status per session (`agent.status === "running"`); see src/sources/live.js for
 * the probe order.
 *
 * @param {any} ctx
 * @returns {Set<string>}
 */
export function runningSessionIds(ctx) {
  return liveSessions(ctx).running;
}

/**
 * The background build of the 会话内容 index.
 *
 * The index itself is lazy (`sources/content.js`): a search spends one slice and
 * asks again. That is the right shape for a user who is waiting, and the wrong
 * shape for a user who has not asked yet — the first 会话内容 search of a session
 * pays 6.5 s in 700 ms instalments. 允许空闲时自动建立 is the opt-in that pays it
 * earlier: after a request settles, one slice is spent, and the next is queued a
 * moment later, until the queue is empty.
 *
 * Three properties matter:
 *
 *   - **Idle, not eager.** The first slice waits `idleDelayMs` after the last
 *     request, so the panel's own listing never competes with a log read.
 *   - **Single flight.** `nudge` is called at the end of every request and does
 *     nothing while a slice runs or one is already queued; `token` invalidates
 *     work queued before a 删除缓存 or a second 重新建立.
 *   - **Stoppable.** 删除缓存 sets `paused`, and nudge stays quiet until something
 *     re-arms it (writing the setting, or asking for a content search) —
 *     otherwise the button would delete a file the idle loop rebuilds a second
 *     later, which is not what the user pressed.
 *   - **Convergent.** An empty queue is not the end: a
 *     conversation keeps growing after the index caught up, and a session the
 *     user moved or restored changes its `logPath`. So a finished pass queues a
 *     `recheckDelayMs` look instead of stopping; that look is a plain snapshot
 *     plus `sync()`, which queues **only** the sessions whose sig moved on, and
 *     those are the ones re-read. A request arriving in the meantime shortens
 *     the wait (nudge), so a used panel stays responsive.
 *
 * @param {{ idleDelayMs?: number, idleSliceMs?: number, rebuildSliceMs?: number, recheckDelayMs?: number }} [options]
 */
export function createIndexBuilder(options = {}) {
  const idleDelayMs = options.idleDelayMs ?? 1200;
  const idleSliceMs = options.idleSliceMs ?? 250;
  const rebuildSliceMs = options.rebuildSliceMs ?? 900;
  /**
   * How long a finished index waits before looking for changes again. The look
   * costs one header walk (the same one a panel refresh does, minus the work);
   * reading a log happens only for a session whose sig changed.
   */
  const recheckDelayMs = options.recheckDelayMs ?? 15000;

  /** The queued slice, or null. */
  let timer = null;
  /** What the queued timer is for: a real slice ("work") or a change look ("recheck"). */
  let timerKind = null;
  /** Bumped by stop()/rebuild(): a step queued by an older run returns early. */
  let token = 0;
  /** True while a slice is being spent. */
  let busy = false;
  /** Set by 删除缓存; cleared by resume(). */
  let paused = false;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
    timerKind = null;
  }

  function later(api, mine, forced, delay, kind = "work") {
    cancel();
    timerKind = kind;
    timer = setTimeout(() => {
      timer = null;
      timerKind = null;
      step(api, mine, forced).catch(() => {});
    }, delay);
    // A queued index must not keep the host process alive after DSH exits.
    if (typeof timer.unref === "function") timer.unref();
  }

  /** Spend one slice, then queue the next one if the queue is still full. */
  async function step(api, mine, forced) {
    if (mine !== token) return null;
    if (!forced) {
      const settings = normalizeSettings(await api.documents.settings.read());
      if (!settings.search.indexIdle) return null;
    }
    busy = true;
    try {
      const snapshot = await api.reader.snapshot({});
      await api.content.open();
      api.content.sync(snapshot.sessions);
      const before = api.content.state();
      if (before.pending === 0) {
        await api.content.flush();
        // Caught up, not done: queue a look so a session that grows while the
        // panel sits idle is re-indexed on its own. A 重新建立 (forced) pass has
        // no queue to come back to — the idle switch decides what happens next.
        if (!forced && mine === token) later(api, mine, forced, recheckDelayMs, "recheck");
        return before;
      }
      await api.content.work(forced ? rebuildSliceMs : idleSliceMs);
      const after = api.content.state();
      if (mine !== token) return after;
      if (after.pending > 0) later(api, mine, forced, forced ? 30 : 400);
      else if (!forced) later(api, mine, forced, recheckDelayMs, "recheck");
      return after;
    } finally {
      busy = false;
    }
  }

  /**
   * Called after a request: queue a slice for when nothing else is going on.
   *
   * A queued *recheck* is only the "look again in 15 s" timer, so a request that
   * just landed (a move, a restore, a turn that ended) shortens it instead of
   * being ignored: the point is to re-index what that request changed.
   */
  function nudge(api) {
    if (paused || busy) return;
    if (timer && timerKind !== "recheck") return;
    later(api, token, false, idleDelayMs);
  }

  /** 重新建立: the user pressed it, so the idle switch does not apply. */
  function rebuild(api) {
    token += 1;
    paused = false;
    cancel();
    return step(api, token, true);
  }

  /** 删除缓存: drop the queue, and stay quiet until something re-arms it. */
  function stop() {
    token += 1;
    paused = true;
    cancel();
  }

  /** Something the user did says "the index may exist again". */
  function resume(api) {
    paused = false;
    nudge(api);
  }

  return { nudge, rebuild, stop, resume, busy: () => busy };
}

/**
 * The answer behind `GET /search/content`.
 *
 * 搜索范围 › 会话内容 is the one search field the panel cannot answer from the
 * rows it holds: those words live in the session logs, so the host keeps an
 * index over them and this function speaks for it.
 *
 * The build is lazy and bounded on purpose — one call advances it by one slice
 * and answers `ready: false` with how far it got, and the caller asks again. The
 * alternative, one request that blocks while 63 logs are read, is a hang in the
 * middle of typing. An empty needle only plans: it reports the size of the index
 * and spends none of the budget.
 *
 * @param {PluginApi} api
 * @param {string | null | undefined} rawQuery the `q` parameter, before trimming
 * @param {{ limit?: unknown }} [options] `limit` caps the hits drawn
 */
export async function searchSessionContent(api, rawQuery, options = {}) {
  const text = String(rawQuery ?? "").trim();
  const snapshot = await api.reader.snapshot({});
  // Ask the cache first: syncing a cold process without it would queue every
  // session for reading, which is the work the cache exists to avoid.
  await api.content.open();
  api.content.sync(snapshot.sessions);
  // A content search is the clearest "I want this index" there is, so it also
  // lifts a 删除缓存 pause: the user is asking for the index again.
  api.indexBuilder?.resume?.(api);
  if (text) await api.content.work();
  const state = api.content.state();
  const wanted = Number(options.limit);
  const limit = Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.floor(wanted), MAX_HITS) : MAX_HITS;
  const found = text ? api.content.search(text) : [];
  return {
    query: text,
    ready: state.pending === 0,
    indexed: state.indexed,
    total: state.total,
    // The needle is echoed back so a late answer for a needle the user has
    // already replaced can be dropped instead of drawn.
    hits: found.slice(0, limit),
    matched: found.length,
    // Both caps are silent otherwise: a 5,000-character paragraph and a list cut
    // to 200 rows both looked like "that is everything there is".
    truncated: found.length > limit,
    needleTruncated: text.length > MAX_NEEDLE,
  };
}
