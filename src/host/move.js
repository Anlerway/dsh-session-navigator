/**
 * dsh-session-navigator — cross-workspace move and copy.
 *
 * DSH decides a session's workspace from the `cwd` in its artifact header, not
 * from the workspace registry alone: a session whose header cwd does not resolve
 * to the workspace's own path is filtered out of that workspace's membership.
 * A move therefore has to do two things together:
 *
 *   1. relocate the artifact into the target workspace's project directory and
 *      rewrite the header's `cwd`;
 *   2. swap the registry accounting (detach from every old workspace, attach to
 *      the target) through the registry's own write path.
 *
 * Doing only the second loses the session at the next start; doing only the
 * first leaves a file DSH cannot find from its workspace list. The transaction
 * below is ordered so that any failure leaves a readable artifact either where
 * it started or at the destination with its original header — never a
 * half-written log.
 *
 * A *running* session is refused for a *move*. A generating agent keeps a write
 * handle open on the old path and rebinding it is undocumented internal state;
 * moving the file under a writer that is mid-append corrupts the tail. A session
 * the user has merely opened writes nothing: it is flushed, moved, and then
 * detached from the host so no stale row points at the old path. A *copy* is a
 * different thing: it
 * never touches the source, it reads it. Refusing there made 复制 fail with
 * "close it before moving it" for every session the user had merely opened, and
 * the panel offers no way to close one — so the copy now reads the log as a
 * snapshot instead (dropping the frame the agent is still writing, the same way
 * export does). The trash route keeps refusing a running session, for the same
 * reason a move does.
 */

import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { getService } from "../capabilities.js";
import { exists, fileList } from "../fs.js";
import { dshHomeOf } from "./fsutil.js";
import { codedError } from "../store/sidecar.js";
import { detachSession, flushSession, isSessionRunning } from "./live-session.js";
import { enqueue, holdersOf as workspacesHolding, registryOrNull } from "./registry.js";
import { FIXED_NODES } from "../constants.js";
import { patchAnnotation } from "../domain/annotations.js";
import { shortcutTargetsIn } from "../domain/shortcuts.js";
import { readAllHeaders, sessionsDir } from "../sources/heads.js";
import { forgetMove, pendingMoves, recordMove } from "./move-journal.js";
import {
  encodeArtifact,
  encodeSegment,
  inheritedCutOf,
  isContiguousLog,
  projectKey,
  readArtifact,
  tempPathFor,
} from "../sources/artifact.js";


/**
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function inside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

/**
 * Make sure the target workspace's directory exists.
 *
 * The registry is the authority on which workspaces exist; the directory on
 * disk is only where their payload goes. A workspace whose folder was deleted
 * by hand (or whose drive was unmounted) is still a workspace — it still has a
 * row, a title and its other sessions — so refusing the move with "目标工作区
 * 不存在" answers a question nobody asked and leaves the user unable to file
 * anything there. Re-create the directory instead, and only report a missing
 * workspace when the directory cannot be made.
 *
 * @param {string} path absolute workspace path
 * @returns {Promise<void>}
 */
async function ensureWorkspaceDir(path) {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    throw codedError("workspace-not-found", `workspace directory ${path} cannot be created: ${messageOf(error)}`);
  }
}

/**
 * The workspace registry (native service), or a coded error.
 *
 * @param {any} ctx
 * @returns {any}
 */
function registryOf(ctx) {
  const registry = registryOrNull(ctx);
  if (!registry) {
    throw codedError("capability-missing", "this DSH build mounts no workspace registry, so sessions cannot be moved");
  }
  return registry;
}


/**
 * Resolve a target workspace entity and the canonical directory its sessions
 * must claim.
 *
 * @param {any} registry
 * @param {any} target
 * @returns {{ id: string, title: string, path: string }}
 */
async function resolveTarget(registry, target) {
  const workspaceId = typeof target?.workspaceId === "string" ? target.workspaceId : "";
  if (!workspaceId) throw codedError("bad-request", "a target workspace id is required");
  const entity = registry.list().find((candidate) => candidate?.id === workspaceId);
  if (!entity) throw codedError("workspace-not-found", `workspace ${workspaceId} does not exist`);
  const path = typeof entity.path === "string" ? entity.path : "";
  if (!path) throw codedError("workspace-not-found", `workspace ${workspaceId} has no directory`);
  return { id: workspaceId, title: entity.title || workspaceId, path };
}


/**
 * Bring the registry's header index up to date for one session.
 *
 * `attachSession` validates the stored cwd against the workspace path and reads
 * it from that index, which is otherwise cached until a restart. Without this
 * refresh a move would fail its own validation with the *old* cwd.
 *
 * @param {any} registry
 * @param {any} header
 */
async function reindex(registry, header) {
  if (typeof registry.indexHeader === "function") {
    await registry.indexHeader(header);
    return;
  }
  if (typeof registry.replaceHeaderIndex === "function" && typeof registry.listStoredHeaders === "function") {
    const headers = await registry.listStoredHeaders();
    await registry.replaceHeaderIndex([...headers.filter((entry) => entry?.id !== header.id), header]);
  }
}

/**
 * Refold the projection cache for a relocated artifact.
 *
 * The cache record is bound to `{formatVersion, createdAt, cwd, isSeeded}`; a
 * move changes `cwd`, so the old record stops matching and the listing would
 * silently fall back to the cwd folder name. Best effort: a cache that cannot be
 * refolded costs a title, never the session.
 *
 * @param {any} ctx
 * @param {any} header
 * @param {any[]} events
 */
async function refoldProjection(ctx, header, events) {
  try {
    const cache = getService(ctx, "sessionProjectionCache");
    if (!cache || typeof cache.coldSnapshot !== "function") return;
    if (!Array.isArray(events) || !isContiguousLog(events)) return;
    const inherited = header?.isSeeded === true ? inheritedCutOf(events) : 0;
    if (inherited === null) return;
    await cache.coldSnapshot(header, inherited, events);
  } catch {
    /* a stale projection is cosmetic; the move already succeeded */
  }
}

/**
 * Write a new header over an existing artifact without touching its events.
 *
 * The bytes are written beside the target and renamed over it, so a crash
 * cannot leave a clipped log. The original `version` is preserved: a v3
 * artifact must not start claiming v4 without a migration.
 *
 * @param {string} filePath
 * @param {any} header
 * @param {string} rest text after the header line, including the final newline
 * @param {boolean} compressed
 */
async function publishHeader(filePath, header, rest, compressed) {
  const bytes = encodeArtifact(header, rest, compressed);
  const temp = tempPathFor(filePath);
  await writeFile(temp, bytes);
  try {
    await rename(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Run a compensating step, returning a description of the failure instead of
 * throwing: the caller is already handling one error and needs to report all of
 * them together.
 *
 * @param {string} label
 * @param {() => Promise<unknown>} run
 * @returns {Promise<string | null>}
 */
async function bestEffort(label, run) {
  try {
    await run();
    return null;
  } catch (error) {
    return `${label} failed (${messageOf(error)})`;
  }
}

/**
 * @param {any} error
 * @returns {string}
 */
function messageOf(error) {
  return String(error?.message ?? error);
}

/**
 * Move one session directory. Same volume is one rename; across volumes it is a
 * copy followed by a delete, which is all the filesystem allows.
 *
 * @param {string} from
 * @param {string} to
 */
async function relocate(from, to) {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    // Only "different volume" is worth retrying as a copy. EPERM/EACCES mean the
    // move is not permitted at all — retrying it as a copy would either fail the
    // same way or, worse, half-succeed and leave the payload duplicated.
    if (code !== "EXDEV") throw error;
  }
  await cp(from, to, { recursive: true, force: false, errorOnExist: true });
  try {
    await assertCopied(from, to);
  } catch (error) {
    // The copy is incomplete, so the original is still the only good copy: undo
    // the partial destination and keep it. Deleting `from` here would destroy
    // the session (a mid-copy ENOSPC is the realistic case).
    await rm(to, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await rm(from, { recursive: true, force: true });
}

/**
 * Refuse to delete the source of a copy that did not fully arrive.
 *
 * A directory-level `cp` resolves when every entry has been written, so a
 * complete copy is the normal case; this compares the two trees anyway, because
 * the cost of being wrong here is a deleted session and the cost of checking is
 * two small directory walks. A file that appeared in the source *after* the copy
 * started is not a failure — it is simply not part of the move.
 *
 * @param {string} from
 * @param {string} to
 */
async function assertCopied(from, to) {
  const [source, target] = await Promise.all([fileList(from), fileList(to)]);
  const missing = source.filter((name) => !target.includes(name));
  if (missing.length > 0) {
    throw codedError("move-incomplete", `${to} is missing ${missing.length} file(s) after copying`);
  }
}


/**
 * Shared preamble: locate the artifact, refuse what must not move.
 *
 * A subagent's log is a session directory like any other, so a delegation may be
 * moved or copied on its own; it is also moved along with its parent (see
 * {@link followChildren}), which is what keeps a delegated run in one workspace.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {string} action what the caller is about to do, for messages
 * @param {{ allowLive?: boolean }} [options] `allowLive` is for a copy: the
 *   source is only read, so a session DSH has open is a snapshot, not a
 *   conflict.
 * @returns {Promise<{ home: string, root: string, stored: any, artifact: any, live: boolean }>}
 */
async function prepare(api, sessionId, action, options = {}) {
  const home = dshHomeOf(api);
  const root = sessionsDir(home);
  const headers = await readAllHeaders(home);
  const stored = headers.get(sessionId);
  if (!stored?.logPath) {
    throw codedError("session-not-found", `${sessionId} has no session log on disk`);
  }
  const live = getService(api.ctx, "sessions")?.get?.(sessionId) ?? null;
  if (live && options.allowLive !== true) {
    // Only a *running* agent is a real conflict: it holds the log writer and
    // would keep appending to the path this move is about to take away. A
    // session merely open on screen writes nothing, so it is moved like any
    // other — after its buffered events are pushed to the file, so the move
    // takes them along (the host view is detached at the end of the move).
    if (isSessionRunning(api.ctx, sessionId)) {
      throw codedError(
        "session-active",
        `${sessionId} 正在生成回复，无法移动；等这次运行结束（或先停止它）后再移动`,
      );
    }
    await flushSession(api.ctx, sessionId);
  }
  // A live log is still being appended to. Copying it is a snapshot, so the
  // frame or line that is half written is skipped instead of refused — the same
  // tolerance export uses, and for the same reason.
  const artifact = await readArtifact(stored.logPath, { tolerateTail: live !== null });
  return { home, root, stored, artifact, live: live !== null };
}

/**
 * Is this header a delegation (a subagent), rather than a session of its own?
 *
 * The same rule the listing uses (see domain/sessions.js): a child names its
 * parent and either declares `origin: "subagent"` or carries a delegation
 * depth. A fork also names a parent but keeps depth 0 and no origin — a fork is
 * a copy the user asked for and never follows anything.
 *
 * @param {any} header
 * @returns {boolean}
 */
function isDelegation(header) {
  const parent = typeof header?.parentSession === "string" ? header.parentSession : "";
  if (!parent) return false;
  return header.origin === "subagent" || (!header.origin && (header.delegationDepth ?? 0) > 0);
}

/**
 * Every delegation below `id`, at any depth.
 *
 * The registry knows nothing about this: DSH creates a child itself, outside
 * `workspace.sessionIds`, so the child's own header is the only record of the
 * relation. Cycle-guarded — a hand-edited header must not hang a move.
 *
 * @param {Map<string, any>} headers
 * @param {string} id
 * @returns {string[]}
 */
function descendantIdsOf(headers, id) {
  /** @type {Map<string, string[]>} */
  const children = new Map();
  for (const header of headers.values()) {
    if (!isDelegation(header)) continue;
    const list = children.get(header.parentSession) ?? [];
    list.push(header.id);
    children.set(header.parentSession, list);
  }
  /** @type {string[]} */
  const out = [];
  const seen = new Set([id]);
  const queue = [...(children.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return out;
}

/**
 * Move the delegations of a session after the session itself.
 *
 * A child lives in its own directory, so moving the parent alone leaves the
 * delegation behind in the workspace it was created in: the moved session then
 * lists children that belong somewhere else, and the target workspace shows a
 * run without the delegations it made. Each child goes through the same
 * transaction as its parent (journal, rollback, registry swap), one at a time,
 * and a child that cannot move is reported instead of undoing the rest — a
 * locked child log must not cost the parent its move.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {any} target
 * @returns {Promise<{ moved: string[], failed: { sessionId: string, code: string, message: string }[] }>}
 */
async function followChildren(api, sessionId, target) {
  let headers = new Map();
  try {
    headers = await readAllHeaders(dshHomeOf(api));
  } catch {
    // No header listing means no way to name the children. The parent has
    // already moved, so the honest answer is "no children followed".
    return { moved: [], failed: [] };
  }
  const ids = descendantIdsOf(headers, sessionId);
  /** @type {string[]} */
  const moved = [];
  /** @type {{ sessionId: string, code: string, message: string }[]} */
  const failed = [];
  for (const id of ids) {
    try {
      const result = await moveOneOnly(api, id, target);
      if (result?.moved !== false) moved.push(id);
    } catch (error) {
      failed.push({
        sessionId: id,
        code: String(/** @type {any} */ (error)?.code ?? "io-error"),
        message: messageOf(error),
      });
    }
  }
  return { moved, failed };
}

/**
 * Move one session to a target workspace, taking its delegations along.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {any} target
 * @param {{ followChildren?: boolean }} [options] `followChildren: false` is for
 *   the recursion below: a child's own children are already in the list the
 *   first call walked.
 * @returns {Promise<object>}
 */
async function moveOne(api, sessionId, target, options = {}) {
  const result = await moveOneOnly(api, sessionId, target);
  if (options.followChildren === false) return result;
  const children = await followChildren(api, sessionId, target);
  return { ...result, children };
}

/**
 * Move one session directory — and nothing else — to a target workspace.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {any} target
 * @returns {Promise<object>}
 */
async function moveOneOnly(api, sessionId, target) {
  const registry = registryOf(api.ctx);
  const resolved = await resolveTarget(registry, target);
  const { root, stored, artifact, live } = await prepare(api, sessionId, "moved");

  const fromWorkspaces = workspacesHolding(registry, sessionId);
  // "Already there" is a claim about two things: the registry and the payload.
  // The registry alone can say the session belongs to this workspace while its
  // log sits in another project directory (an earlier move that never finished,
  // or a workspace path that changed underneath it); returning here would
  // report success and leave the file where DSH cannot find it.
  const alreadyHome = inside(join(root, projectKey(resolved.path)), stored.logPath);
  if (fromWorkspaces.length === 1 && fromWorkspaces[0] === resolved.id && alreadyHome) {
    return {
      sessionId,
      moved: false,
      fromWorkspaceIds: fromWorkspaces,
      toWorkspaceId: resolved.id,
      artifactFrom: stored.logPath,
      artifactTo: stored.logPath,
      message: "会话已属于目标工作区",
    };
  }

  // A workspace folder deleted from the disk does not delete the workspace:
  // the registry still lists it and attachSession still accepts it. Put the
  // directory back, so the payload has somewhere to land.
  await ensureWorkspaceDir(resolved.path);

  const sourceDir = dirname(stored.logPath);
  const directoryName = sourceDir.split(/[\\/]/).pop();
  const targetDir = join(root, projectKey(resolved.path), directoryName);
  if (!inside(root, targetDir)) {
    throw codedError("bad-request", `refusing to move ${sessionId} outside the sessions root`);
  }
  if (targetDir === sourceDir) {
    throw codedError("target-exists", `${targetDir} already holds this session`);
  }
  await mkdir(dirname(targetDir), { recursive: true });
  if (await exists(targetDir)) {
    throw codedError("target-exists", `${targetDir} already exists`);
  }

  // From here the payload and the registry disagree until the end of this
  // function. The journal entry is what a crash in between is read against at
  // the next start: destination present means "finish the accounting", source
  // present means "nothing happened".
  const header = { ...artifact.header, cwd: resolved.path };
  const targetLog = join(targetDir, artifact.fileName);
  if (api.paths?.dataDir) await recordMove(api.paths, {
    sessionId,
    from: sourceDir,
    to: targetDir,
    logName: artifact.fileName,
    workspaceId: resolved.id,
    header,
    startedAt: Date.now(),
  });

  await relocate(sourceDir, targetDir);

  const newline = artifact.text.indexOf("\n");
  const rest = artifact.text.slice(newline + 1);
  try {
    await publishHeader(targetLog, header, rest, artifact.compressed);
  } catch (error) {
    // The directory moved but its header still names the old cwd: put the
    // directory back, where the old header is still truthful.
    const problem = await bestEffort("move the directory back", () => relocate(targetDir, sourceDir));
    if (problem) throw codedError("move-rollback-failed", `${messageOf(error)}; rollback also failed: ${problem}`);
    // Everything is back where it started, so there is nothing for the next
    // start to repair. A failed rollback keeps its entry on purpose.
    if (api.paths?.dataDir) await forgetMove(api.paths, sessionId).catch(() => {});
    throw error;
  }

  try {
    await reindex(registry, header);
    await enqueue(registry, async () => {
      // Attach first, detach second. The two orderings differ only while the
      // write is in flight: this one can leave the session accounted twice for
      // a moment, the other leaves it accounted nowhere if the attach fails.
      const targetEntity = registry.list().find((entity) => entity.id === resolved.id);
      if (!targetEntity) throw codedError("workspace-not-found", `workspace ${resolved.id} disappeared during the move`);
      await targetEntity.attachSession(sessionId);
      try {
        for (const entity of registry.list()) {
          if (entity.id === resolved.id) continue;
          const raw = Array.isArray(entity?.record?.sessionIds) ? entity.record.sessionIds : [];
          if (raw.includes(sessionId)) await entity.detachSession(sessionId);
        }
      } catch (error) {
        // Undo the attach so the rollback below starts from "accounted nowhere"
        // instead of "accounted twice".
        await targetEntity.detachSession(sessionId).catch(() => {});
        throw error;
      }
    });
  } catch (error) {
    // Accounting failed. The directory goes back first, then its header, so the
    // restored log describes exactly the workspace that still accounts for it.
    // Each step is reported if it fails: a silent rollback that half-worked is
    // how a session ends up at a path no workspace claims.
    const problems = [
      await bestEffort("move the directory back", () => relocate(targetDir, sourceDir)),
      await bestEffort("restore the header", () =>
        publishHeader(stored.logPath, artifact.header, rest, artifact.compressed),
      ),
      await bestEffort("restore the registry index", () => reindex(registry, stored)),
      // The attach/detach pair may have got as far as detaching this session
      // from the workspaces that held it. Put those back, or the restored
      // payload sits at a path no workspace claims.
      await bestEffort("restore the workspaces that held it", async () => {
        const live = registry.list();
        for (const id of fromWorkspaces) {
          const entity = live.find((each) => each.id === id);
          if (entity) await entity.attachSession(sessionId);
        }
      }),
    ].filter(Boolean);
    if (problems.length > 0) {
      throw codedError("move-rollback-failed", `${messageOf(error)}; rollback incomplete (${problems.join("; ")})`);
    }
    if (api.paths?.dataDir) await forgetMove(api.paths, sessionId).catch(() => {});
    throw error;
  }

  await refoldProjection(api.ctx, header, artifact.events).catch(() => {
    /* the session moved; its title projection is cosmetic and rebuilt on read */
  });
  api.reader.invalidate();
  // The host may still hold this session open (it was moved while idle). Its
  // writer already points at the old path, so let go of it the way a delete
  // does: `session/disposed` makes every client drop the stale row, and the
  // next open reads the log where it now lives. Best effort — a profile with
  // no session store has nothing to detach.
  if (live) await detachSession(api.ctx, sessionId);
  // The registry now describes the payload, so the journal entry has done its
  // job. Failure to remove it costs one no-op repair at the next start.
  if (api.paths?.dataDir) await forgetMove(api.paths, sessionId).catch(() => {});
  return {
    sessionId,
    moved: true,
    fromWorkspaceIds: fromWorkspaces,
    toWorkspaceId: resolved.id,
    toWorkspaceTitle: resolved.title,
    artifactFrom: stored.logPath,
    artifactTo: targetLog,
  };
}

/**
 * Copy one session into a target workspace under a fresh id.
 *
 * A copy is a second, independent session: a new id in the header and in the
 * directory name, the same events, and the target cwd. DSH's own fork is the
 * "continue from here" tool; this is the file manager's "duplicate".
 *
 * The copied header keeps `isSeeded`/`parentSession` verbatim: rewriting them
 * would make the log claim a lineage its event stream does not describe.
 *
 * @param {any} api
 * @param {string} sessionId
 * @param {any} target
 * @returns {Promise<object>}
 */
async function copyOne(api, sessionId, target) {
  const registry = registryOf(api.ctx);
  const resolved = await resolveTarget(registry, target);
  const { root, stored, artifact } = await prepare(api, sessionId, "copied", { allowLive: true });

  await ensureWorkspaceDir(resolved.path);

  const newId = `session-${randomId()}`;
  const header = { ...artifact.header, id: newId, cwd: resolved.path };
  const newline = artifact.text.indexOf("\n");
  // A copy that shares its source's title is indistinguishable in the list, so
  // the duplicate gets a name of its own. The name has to live in the log: a
  // session title is DSH's own `session/title` event and the plugin never
  // mirrors it into a sidecar (see src/domain/annotations.js).
  const title = await copyTitleFor(api, sessionId);
  const titleEvent = {
    type: "session/title",
    seq: nextSeqOf(artifact.events),
    time: Date.now(),
    data: { title, messageSeqs: [], source: { kind: "user" } },
  };
  const rest = artifact.text.slice(newline + 1) + JSON.stringify(titleEvent) + "\n";
  const events = [...artifact.events, titleEvent];
  const targetDir = join(root, projectKey(resolved.path), encodeSegment(newId));
  if (!inside(root, targetDir)) throw codedError("bad-request", "refusing to write outside the sessions root");
  if (await exists(targetDir)) throw codedError("target-exists", `${targetDir} already exists`);

  await mkdir(targetDir, { recursive: true });
  const targetLog = join(targetDir, artifact.fileName);
  try {
    await publishHeader(targetLog, header, rest, artifact.compressed);
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  try {
    await reindex(registry, header);
    await enqueue(registry, async () => {
      const targetEntity = registry.list().find((entity) => entity.id === resolved.id);
      if (!targetEntity) throw codedError("workspace-not-found", `workspace ${resolved.id} disappeared during the copy`);
      await targetEntity.attachSession(newId);
    });
  } catch (error) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  await refoldProjection(api.ctx, header, events).catch(() => {
    /* the copy exists; its title projection is cosmetic and rebuilt on read */
  });
  await cloneAnnotations(api, sessionId, newId);
  api.reader.invalidate();
  return {
    sessionId: newId,
    sourceSessionId: sessionId,
    copied: true,
    title,
    toWorkspaceId: resolved.id,
    toWorkspaceTitle: resolved.title,
    artifactFrom: stored.logPath,
    artifactTo: targetLog,
  };
}

/**
 * The title a duplicate gets: the source's displayed name plus a 副本 suffix,
 * numbered when that name is already taken in this profile.
 *
 * Two copies of the same session would otherwise arrive with the same title, the
 * same timestamp and the same size — the list shows rows nobody can tell apart.
 * apart. Numbering is done against the titles already in the snapshot, so it
 * stays stable in the common case (the first copy is just 副本).
 *
 * @param {any} api
 * @param {string} sessionId
 * @returns {Promise<string>}
 */
async function copyTitleFor(api, sessionId) {
  const SUFFIX = /（副本(?: \d+)?）$/u;
  let base = null;
  /** @type {Set<string>} */
  const taken = new Set();
  try {
    const snapshot = await api.reader.snapshot({});
    for (const session of snapshot.sessions ?? []) {
      const name = typeof session.displayTitle === "string" ? session.displayTitle : "";
      if (!name) continue;
      if (session.id === sessionId) base = name;
      taken.add(name);
    }
  } catch {
    /* a missing snapshot only costs the numbering, never the copy */
  }
  const stem = (base ?? "").replace(SUFFIX, "");
  if (!stem) return "副本";
  let candidate = stem + "（副本）";
  if (!taken.has(candidate)) return candidate;
  for (let index = 2; index < 1000; index += 1) {
    candidate = stem + "（副本 " + index + "）";
    if (!taken.has(candidate)) return candidate;
  }
  return stem + "（副本 " + Date.now() + "）";
}

/**
 * The seq the next appended event must carry: one past the highest in the log.
 *
 * @param {any[]} events
 * @returns {number}
 */
function nextSeqOf(events) {
  let max = -1;
  for (const event of events ?? []) {
    const seq = Number(event?.seq);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max + 1;
}

/**
 * Give the duplicate the source's tags, note and 收藏.
 *
 * A copy is the same conversation: the user tagged it, wrote a note about it and
 * starred it, and losing that on duplicate is data loss with no way to recover
 * it. 收藏 is a shortcut, not a flag, so the star is carried over by adding a
 * shortcut to the *copy* in 收藏 — the copy is a session of its own, and the
 * source's pointer must keep pointing at the source.
 *
 * 待办 is deliberately *not* copied — it is a work item about one session, and
 * duplicating it would invent work the user never asked for.
 *
 * @param {any} api
 * @param {string} sourceId
 * @param {string} targetId
 * @returns {Promise<void>}
 */
async function cloneAnnotations(api, sourceId, targetId) {
  try {
    const [document, tree] = await Promise.all([api.documents.annotations.read(), api.documents.tree.read()]);
    const source = document?.sessions?.[sourceId];
    if (source) {
      const patch = {
        tags: source.tags ?? [],
        note: source.note ?? "",
      };
      await api.documents.annotations.mutate((draft) => {
        patchAnnotation(draft, targetId, patch, Date.now());
      });
    }
    if (!shortcutTargetsIn(tree?.shortcuts, FIXED_NODES.favorites).has(sourceId)) return;
    await api.documents.tree.mutate((draft) => {
      const shortcuts = (draft.shortcuts ??= {});
      const id = `s-${randomId()}`;
      shortcuts[id] = {
        id,
        kind: "session",
        targetId,
        parent: FIXED_NODES.favorites,
        order: Object.keys(shortcuts).length,
        label: null,
        createdAt: Date.now(),
      };
    });
  } catch {
    /* the copy exists; its annotations are a convenience, not the payload */
  }
}

/**
 * A random RFC 4122-shaped id body, so a copied session reads like DSH's own.
 *
 * @returns {string}
 */
function randomId() {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Move or copy a batch of sessions.
 *
 * Sessions are processed one at a time: their workspaces are independent, and
 * stopping at the first failure keeps the reported result truthful instead of
 * implying an all-or-nothing batch.
 *
 * @param {any} api
 * @param {{ ids?: string[], target?: any, copy?: boolean }} body
 * @returns {Promise<{ results: object[] }>}
 */
export async function moveSessions(api, body) {
  const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
  if (ids.length === 0) throw codedError("bad-request", "ids must be a non-empty array");
  const copy = body?.copy === true;
  const target = body?.target ?? { workspaceId: body?.targetWorkspaceId };
  /** @type {object[]} */
  const results = [];
  // A destination that does not resolve is a bad request, not a per-session
  // failure: nothing should move when the target itself is unknown.
  await resolveTarget(registryOf(api.ctx), target);
  // One session that cannot move (a locked log, a target directory that already
  // exists) must not discard the ones that did: the caller sent them in one
  // click and needs to know which half landed. A failed entry reports its code
  // and message in place of the result.
  for (const id of ids) {
    try {
      const result = copy ? await copyOne(api, id, target) : await moveOne(api, id, target);
      results.push({ sessionId: id, ok: true, ...result });
    } catch (error) {
      results.push({
        sessionId: id,
        ok: false,
        code: String(/** @type {any} */ (error)?.code ?? "io-error"),
        message: String(/** @type {any} */ (error)?.message ?? error),
      });
    }
  }
  // A batch where nothing moved has no partial result to report: throw the
  // first failure so the caller sees an error instead of a 200 full of
  // `ok: false`. A mixed batch keeps its rows, because the caller needs to know
  // which half landed.
  const first = results.find((row) => !row.ok);
  if (first && results.every((row) => !row.ok)) {
    throw codedError(String(/** @type {any} */ (first).code ?? "io-error"), String(/** @type {any} */ (first).message ?? "move failed"));
  }
  return { results };
}

/**
 * Finish or forget every move that a crash interrupted.
 *
 * Called once at startup. The journal is written before the payload leaves its
 * directory, so an entry that survives a restart describes one of two states:
 *
 *   - the destination directory exists: the payload moved but the registry may
 *     not have heard about it. Index the header and move the membership, which
 *     is the second half of `moveOne` repeated idempotently.
 *   - the destination does not exist: the payload never left. Nothing to repair.
 *
 * A repair that throws is left in the journal rather than dropped: the next
 * start retries it, and the entry is the only record that the session is
 * between homes.
 *
 * @param {any} api
 * @returns {Promise<{ finished: string[], dropped: string[] }>}
 */
export async function reconcileMoves(api) {
  if (!api.paths?.dataDir) return { finished: [], dropped: [] };
  const moves = await pendingMoves(api.paths);
  /** @type {string[]} */
  const finished = [];
  /** @type {string[]} */
  const dropped = [];
  for (const move of moves) {
    const sessionId = String(move?.sessionId ?? "");
    if (!sessionId || typeof move?.to !== "string" || typeof move?.from !== "string") {
      if (sessionId) await forgetMove(api.paths, sessionId).catch(() => {});
      continue;
    }
    if (!(await exists(move.to))) {
      // The payload is still at the source (or nowhere, which no journal entry
      // can fix). Forget the entry; the session is discoverable as it was.
      if (api.paths?.dataDir) await forgetMove(api.paths, sessionId).catch(() => {});
      dropped.push(sessionId);
      continue;
    }
    const registry = registryOf(api.ctx);
    const header = move.header && typeof move.header === "object" ? move.header : null;
    if (header) await reindex(registry, header);
    const workspaceId = String(move.workspaceId ?? "");
    if (workspaceId) {
      await enqueue(registry, async () => {
        const targetEntity = registry.list().find((entity) => entity.id === workspaceId);
        if (!targetEntity) return;
        await targetEntity.attachSession(sessionId);
        for (const entity of registry.list()) {
          if (entity.id === workspaceId) continue;
          const raw = Array.isArray(entity?.record?.sessionIds) ? entity.record.sessionIds : [];
          if (raw.includes(sessionId)) await entity.detachSession(sessionId);
        }
      });
    }
    if (api.paths?.dataDir) await forgetMove(api.paths, sessionId).catch(() => {});
    finished.push(sessionId);
  }
  return { finished, dropped };
}
