// shared：从 lib/index.js 原样切出
import { boundIds, withDescendants } from "../domain/subagents.js";
import { samePath } from "../paths.js";
import { codedError } from "../store/sidecar.js";
import { rejectUnknownKeys, requireEnum, requireObject, requireText } from "../validate.js";

/**
 * Stamp every session with the container node it is shown in.
 *
 * `home` is the resolved answer (a workspace node, a user folder, or 未分组;
 * null when the workspace it names is gone), and `homeOverride` says whether the
 * sidecar pulled it out of that workspace rather than DSH placing it there. The
 * client sorts, groups and drags with those two fields only.
 *
 * @param {object[]} sessions merged session view
 * @param {{ sessionHome?: Record<string, string>, sessionPlacement?: Record<string, string> }} tree
 * @returns {object[]}
 */
export function withHome(sessions, tree) {
  const home = tree?.sessionHome ?? {};
  const placement = tree?.sessionPlacement ?? {};
  return sessions.map((session) => ({
    ...session,
    home: home[session.id] ?? null,
    homeOverride: typeof placement[session.id] === "string",
  }));
}

/**
 * Refuse a standalone operation on a subagent session.
 *
 * A subagent is a delegation inside its parent's run, so the operations that
 * rewrite the store — delete, move, copy/cut, favourite, todo, rename, fork,
 * archive — are refused here rather than merely hidden in the UI. Hiding is a
 * courtesy; this is the rule. Reading, opening and the parent's own operations
 * stay available, and the parent reaches its children by cascade or derivation
 * (see domain/subagents.js).
 *
 * @param {PluginApi} api
 * @param {unknown} ids one id or a list of them
 * @param {any} [snapshot] a snapshot the caller already read, so a route that
 *   needs the tree anyway does not pay for the listing twice
 * @returns {Promise<string[]>} the ids that are *not* bound (for cascading)
 */
export async function assertStandalone(api, ids, snapshot) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === "string" && id !== "");
  if (list.length === 0) return [];
  const view = snapshot ?? (await api.reader.snapshot({}));
  const bound = boundIds(view.sessions, list);
  if (bound.length > 0) {
    const first = bound[0];
    throw codedError(
      "subagent-unsupported",
      bound.length === 1
        ? `${first} 是子智能体：它跟随父会话，不能单独操作。请打开父会话再处理。`
        : `其中 ${bound.length} 个是子智能体（如 ${first}）：它们跟随父会话，不能单独操作。`,
    );
  }
  return list;
}

/**
 * Expand a parent's ids to include every subagent below it, so one operation on
 * a parent reaches the whole delegation chain (the bin's cascade).
 *
 * @param {PluginApi} api
 * @param {unknown} ids
 * @returns {Promise<string[]>}
 */
export async function withBoundChildren(api, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === "string" && id !== "");
  if (list.length === 0) return [];
  const snapshot = await api.reader.snapshot({});
  return withDescendants(snapshot.sessions, list);
}

/**
 * Expand `ids` to include the subagents binned with them.
 *
 * Restore and purge used `withBoundChildren`, which expands through the live
 * snapshot — but a session in the bin is *not* in the snapshot, so every id was
 * dropped and the route failed with "ids must be non-empty array" no matter what
 * the user clicked. The bin index is the only place that still knows a binned
 * id, so the chain is walked there instead, and ids with no entry are kept: the
 * bin's own routines already treat an unknown id as "skip", and dropping it here
 * is what made 还原/永久删除 look broken.
 *
 * @param {PluginApi} api
 * @param {unknown} ids
 * @returns {Promise<string[]>}
 */
export async function trashClosure(api, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === "string" && id !== "");
  if (list.length === 0) return [];
  const index = await api.documents.trash.read().catch(() => ({ entries: {} }));
  const entries = index?.entries ?? {};
  /** @type {Map<string, string[]>} */
  const children = new Map();
  for (const [id, entry] of Object.entries(entries)) {
    const parent = typeof entry?.parentSession === "string" && entry.parentSession !== "" ? entry.parentSession : null;
    if (!parent) continue;
    const bucket = children.get(parent);
    if (bucket) bucket.push(id);
    else children.set(parent, [id]);
  }
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const queue = [...list];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return out;
}

/**
 * The revision a mutating request expects. `If-Match` is the header form;
 * `revision` in the body is the JSON form. Omitting both means "last writer
 * wins", which is what a single-window user expects.
 *
 * A header that is present but is not a revision is a `400`, not a silent
 * fallback: a client that cannot state its expectation must not be treated as
 * a client that expects nothing, or the guard it thought it had disappears.
 *
 * @param {any} req
 * @param {PluginApi} api
 * @returns {number | undefined}
 */
export function expectedRevision(req, _api) {
  const header = req.headers?.["if-match"];
  if (typeof header === "string") {
    const raw = header.trim();
    // `*` means "any current representation", which is the one thing a
    // revision check cannot express — treat it as no expectation.
    if (raw !== "" && raw !== "*") {
      // A weak tag (`W/"3"`) is what an HTTP client echoes back after caching a
      // response; the `W/` prefix qualifies comparison, not identity, so it is
      // stripped. Left in place it makes `Number()` return NaN and turns a
      // conditional write into an unconditional one.
      const tag = raw.replace(/^W\//i, "").replace(/"/g, "").trim();
      // An empty entity tag (`""`) states nothing; only an empty *string* means
      // "no expectation", which is different from the legitimate revision 0 of a
      // sidecar that has never been written.
      if (tag !== "") {
        if (!/^\d+$/.test(tag)) throw badRequest(`unparseable If-Match: ${raw}`);
        return Number(tag);
      }
    }
  }
  const body = req.body?.revision;
  if (Number.isFinite(body)) return body;
  return undefined;
}

/**
 * Sessions referenced by one shortcut container, as a plain id list.
 *
 * `/bootstrap` reports the membership for callers that only want the ids; each
 * row carries its own `favorite` / `todo` too, derived by the reader from the
 * same shortcuts.
 *
 * Membership, not rows: two shortcuts pointing at the same session are one
 * member, so the list is deduped even when the tree still carries an older
 * duplicate the create path would refuse today.
 *
 * @param {any} tree derived tree
 * @param {string} container container node id (f-favorites / f-todos)
 * @returns {string[]} session ids referenced there
 */
export function shortcutSessionTargets(tree, container) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const node of Object.values(tree?.nodes ?? {})) {
    if (!node || node.kind !== "shortcut" || node.shortcutKind !== "session") continue;
    if (node.parent !== container) continue;
    if (typeof node.targetId === "string" && node.targetId) ids.add(node.targetId);
  }
  return [...ids];
}

/**
 * A short, collision-resistant id for a new folder.
 *
 * @returns {string}
 */
export function newId() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/**
 * @param {any} registry normalized registry (service or file)
 * @returns {{ workspaces: object[] }}
 */
export function serializeWorkspaces(registry) {
  if (!registry) return { workspaces: [] };
  return {
    workspaces: registry.workspaceIds
      .map((id) => registry.workspaces.get(id))
      .filter(Boolean)
      .map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        sessionIds: workspace.sessionIds,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })),
  };
}

/**
 * @param {string} message
 * @returns {Error & { code: string }}
 */
export function badRequest(message) {
  return codedError("bad-request", message);
}

/**
 * Narrow the body of 下载组件 / 重试 to what the installer reads.
 *
 * `source` is the only option ("mirror" or "github"). Silently ignoring the
 * rest let a caller believe a choice was honoured when nothing was even read,
 * and re-running an install for an already-ready component restarts it.
 *
 * @param {any} body
 * @returns {{ source?: "mirror" | "github" }}
 */
export function installInput(body) {
  if (body === undefined || body === null) return {};
  requireObject(body, "body");
  // Two shapes arrive here: a download (`source`) and a borrow, which names a
  // runtime another plugin already installed (`borrowed`, from /component/scan).
  // Everything else is a typo, and a typo would otherwise start a 150 MB
  // download instead of saying so.
  rejectUnknownKeys(body, ["source", "borrowed"], "install option");
  const input = {};
  if (body.source !== undefined) {
    input.source = requireEnum(body.source, ["mirror", "github"], "source", { unknown: "install source" });
  }
  if (body.borrowed !== undefined) {
    input.borrowed = requireText(body.borrowed, "borrowed", { message: "borrowed must be a runtime path" });
  }
  return input;
}

/**
 * Whether `path` is a directory this plugin already shows.
 *
 * A session's cwd or a workspace's own directory — nothing else. The snapshot is
 * the same one the tree is built from, so a path the UI can display is a path
 * that can be revealed, and a path it cannot display is refused.
 *
 * @param {any} api
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function knownDirectory(api, path) {
  const snapshot = await api.reader.snapshot({});
  /** @type {string[]} */
  const known = [];
  for (const session of snapshot.sessions ?? []) {
    if (typeof session?.cwd === "string" && session.cwd) known.push(session.cwd);
  }
  for (const session of snapshot.trashed ?? []) {
    if (typeof session?.cwd === "string" && session.cwd) known.push(session.cwd);
  }
  for (const node of Object.values(snapshot.tree?.nodes ?? {})) {
    const candidate = /** @type {any} */ (node);
    if (candidate?.type === "workspace" && typeof candidate.path === "string" && candidate.path) {
      known.push(candidate.path);
    }
  }
  return known.some((candidate) => {
    try {
      return samePath(candidate, path);
    } catch {
      return false;
    }
  });
}

/**
 * Whether two palettes carry the same tokens, key by key.
 *
 * @param {Record<string, string>} [a]
 * @param {Record<string, string>} [b]
 * @returns {boolean}
 */
export function sameTokens(a, b) {
  const left = a ?? {};
  const right = b ?? {};
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => left[key] === right[key]);
}
