// 路由组 sessions（13 条）
import { exportFileName, toJsonl, toMarkdown } from "../domain/export.js";
import { archiveSession, forkSession, pinSession, renameWorkspace, revealPath, revealSessionDir, revealSessionFile, sessionLogPath, unarchiveSession, unpinSession, workspaceDirPath } from "../host/actions.js";
import { log } from "../plugin-runtime.js";
import { assertStandalone, badRequest, knownDirectory } from "../routes/shared.js";
import { readArtifact } from "../sources/artifact.js";
import { codedError } from "../store/sidecar.js";
import { requireText } from "../validate.js";

export const sessionsRoutes = {


  /** Reveal an arbitrary verified path (a session's cwd) in the file manager. */
  "POST /reveal-path": async (api, req) => {
    const path = typeof req.body?.path === "string" ? req.body.path : "";
    if (!path) throw badRequest("path is required");
    // The client sends the cwd of a session it is showing, so the paths worth
    // opening are exactly the ones this plugin already lists. Without this check
    // the route is a general "open any path" primitive reachable from any page
    // in the app — and `\\host\share` handed to Explorer is a credential leak,
    // not a convenience.
    if (!(await knownDirectory(api, path))) {
      throw badRequest("path is not a directory this plugin knows about");
    }
    return revealPath(api, path);
  },


  /** Reveal a workspace's directory in the OS file manager. */
  "POST /workspaces/:id/reveal": async (api, req) => {
    const workspaceId = String(req.params.id ?? "");
    const snapshot = await api.reader.snapshot({});
    const workspace = snapshot.registry?.workspaces?.get(workspaceId) ?? null;
    if (!workspace) throw codedError("workspace/not-found", `unknown workspace ${workspaceId}`);
    if (!workspace.path) throw codedError("bad-request", "这个工作区没有记录路径");
    return revealPath(api, workspace.path);
  },


  /**
   * 跳转至文件位置: select one session's own log file in the OS file manager.
   *
   * The client sends an id and never a path — the host resolves it against the
   * snapshot (live) or the trash index (deleted), so this route can only open a
   * log the plugin already lists. That is why it is separate from
   * `POST /reveal-path`, whose allowlist is directories only.
   */
  "POST /sessions/:id/reveal-file": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    if (!sessionId) throw badRequest("id is required");
    return revealSessionFile(api, sessionId);
  },


  /**
   * 复制文件路径: hand the session's own log file path to the client.
   *
   * Read-only by design — no OS call, nothing opened. The path is resolved by
   * the host for the same reason the reveal route is: only the host knows where
   * a trashed session's log went, and the client must never be able to name a
   * path the plugin has not listed.
   */
  "POST /workspaces/:id/path": async (api, req) => {
    const workspaceId = String(req.params.id ?? "");
    if (!workspaceId) throw badRequest("id is required");
    return workspaceDirPath(api, workspaceId);
  },


  "POST /sessions/:id/log-path": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    if (!sessionId) throw badRequest("id is required");
    return sessionLogPath(api, sessionId);
  },


  /**
   * 在文件管理器中显示: open the directory a session belongs to.
   *
   * Separate from `POST /reveal-path` for the same reason as the log route: the
   * client sends an id, the host decides which directory that means (the
   * session's cwd, or its log folder when it never recorded one), so no caller
   * can turn this into "open any path I name".
   */
  "POST /sessions/:id/reveal-dir": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    if (!sessionId) throw badRequest("id is required");
    return revealSessionDir(api, sessionId);
  },


  /** Rename a workspace. Duplicate names are rejected by DSH itself. */
  "POST /workspaces/:id/rename": async (api, req) => {
    const workspaceId = String(req.params.id ?? "");
    // A workspace row and a folder row are renamed through the same dialog in
    // the panel, so the route accepts the field name either side sends.
    const title = requireText(req.body?.title ?? req.body?.name, "title");
    return renameWorkspace(api, workspaceId, title);
  },


  /**
   * Archive a session: it stays where it is and keeps its log, it is only
   * de-emphasised in the list (hard constraint 3). A session with running work
   * is refused unless `stopActivity` is passed.
   */
  "POST /sessions/:id/archive": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    // Archiving is a decision about a session the user owns. A child inherits
    // its ancestors' archived state (domain/sessions.js), so archiving one
    // directly would be a second source of truth.
    await assertStandalone(api, sessionId);
    return archiveSession(api, sessionId, { stopActivity: req.body?.stopActivity === true });
  },


  /** Un-archive; idempotent, as in DSH. */
  "POST /sessions/:id/unarchive": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    await assertStandalone(api, sessionId);
    return unarchiveSession(api, sessionId);
  },


  /** Pin to the top; DSH refuses to pin an archived session. */
  "POST /sessions/:id/pin": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    await assertStandalone(api, sessionId);
    return pinSession(api, sessionId);
  },


  /** Un-pin; idempotent, as in DSH. */
  "POST /sessions/:id/unpin": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    await assertStandalone(api, sessionId);
    return unpinSession(api, sessionId);
  },


  /**
   * Fork a session into a child that continues from `atSeq`, or from the latest
   * completed turn when it is omitted — the same default as the official fork.
   */
  "POST /sessions/:id/fork": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    // Forking a delegation would copy a piece of a run into a standalone
    // session: the parent's transcript would then have two branches that DSH
    // cannot tell apart.
    await assertStandalone(api, sessionId);
    const atSeq = Number(req.body?.atSeq);
    return forkSession(api, sessionId, Number.isSafeInteger(atSeq) ? atSeq : undefined);
  },


  /**
   * Export one session's conversation.
   *
   * `?format=md|jsonl` and an optional `&download=1`. The response is the file
   * itself with `Content-Disposition`, not a JSON envelope: the panel hands it
   * to the browser as a download, and a JSON wrapper would force it to rebuild
   * the bytes in the renderer.
   *
   * A trashed session is refused — its payload is no longer in DSH's tree, so
   * there is nothing to read (the bin keeps only a description).
   */
  "GET /export": async (api, req, res, query) => {
    const sessionId = String(query?.get("sessionId") ?? "");
    if (!sessionId) throw badRequest("sessionId is required");
    const wanted = query?.get("format");
    // An unknown format is a client bug, not a request for markdown: answering
    // with markdown let a broken link look like a successful export.
    const format = wanted === null || wanted === "" || wanted === "md" ? "md" : wanted === "jsonl" ? "jsonl" : null;
    if (!format) throw badRequest(`unknown export format: ${wanted}`);
    const snapshot = await api.reader.snapshot({});
    const session = snapshot.sessions.find((entry) => entry.id === sessionId) ?? null;
    if (!session) throw codedError("session/not-found", `unknown session ${sessionId}`);

    if (!session.logPath) throw codedError("session-not-found", `${sessionId} has no readable log`);
    const artifact = await readArtifact(session.logPath, { tolerateTail: true });
    const body = format === "jsonl" ? toJsonl(artifact) : toMarkdown(artifact, { title: session.displayTitle, includeTools: true });
    const fileName = exportFileName(artifact.header, session.displayTitle ?? session.id, format);
    res.statusCode = 200;
    res.setHeader("Content-Type", format === "jsonl" ? "application/jsonl; charset=utf-8" : "text/markdown; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (query?.get("download") === "1") {
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    }
    res.end(body);
    return undefined;
  },
};
