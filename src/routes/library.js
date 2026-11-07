// 路由组 library（10 条）
import { FIXED_NODES, PLUGIN_ID } from "../constants.js";
import { addLibraryTag, isAnnotationId, patchAnnotation, removeLibraryTag, tagIndex, tagVocabulary } from "../domain/annotations.js";
import { sessionStateOf } from "../domain/session-state.js";
import { normalizeSettings } from "../domain/settings.js";
import { sortedEntries, trashedSessionOf } from "../domain/trash.js";
import { WINDOWS_REVEAL_SCRIPT } from "../host/actions.js";
import { nativeRevealAvailable } from "../host/native-reveal.js";
import { warmRevealAgent } from "../host/reveal-agent.js";
import { searchSessionContent } from "../plugin-runtime.js";
import { assertStandalone, badRequest, expectedRevision, serializeWorkspaces, shortcutSessionTargets, withHome } from "../routes/shared.js";
import { codedError } from "../store/sidecar.js";
import { requireText } from "../validate.js";

export const libraryRoutes = {

  /**
   * Everything the panel needs, in one round trip.
   *
   * The header scan is TTL-cached, so opening the panel repeatedly is cheap;
   * `?refresh=1` (the refresh button, and the client after a mutation) forces a
   * full rescan instead of waiting out the TTL.
   */
  "GET /bootstrap": async (api, _req, _res, query) => {
    // Opening the panel is the moment a reveal becomes likely, so the resident
    // PowerShell starts now, in the background: the first click then costs
    // ~150ms instead of ~1.8s.
    if (process.platform === "win32" && !nativeRevealAvailable()) {
      warmRevealAgent(WINDOWS_REVEAL_SCRIPT);
    }
    const snapshot = await api.reader.snapshot({ refresh: query?.get("refresh") === "1" });
    const [annotations, settings, tree, trash] = await Promise.all([
      api.documents.annotations.read(),
      api.documents.settings.read(),
      api.documents.tree.read(),
      api.documents.trash.read(),
    ]);
    return {
      hello: { plugin: PLUGIN_ID, schema: 1 },
      capabilities: await api.capabilities(),
      workspaces: serializeWorkspaces(snapshot.registry),
      // Each session carries the container node it is shown in (R2) and whether
      // that home is a virtual placement rather than its DSH workspace. Both are
      // derived once, host-side, so the client never replays the rule.
      sessions: withHome(snapshot.sessions, snapshot.tree),
      // A trashed session's log has physically left DSH's sessions tree, so the
      // merged view cannot describe it. The index entry is the only
      // remaining description, which is exactly why it snapshots the title.
      trashed: sortedEntries(trash.entries).map(trashedSessionOf),
      tree: snapshot.tree,
      // tagLibrary is the picker's vocabulary (presets first, then tags that
      // only exist on sessions); tags stays the plain usage index the filter
      // list was built on.
      tags: tagIndex(annotations),
      tagLibrary: tagVocabulary(annotations),
      // 收藏 / 待办 hold shortcuts, so the membership is read off the tree: the
      // sidecar's annotation flags only feed a one-time migration into shortcuts
      // (see src/host/flags.js).
      favorites: shortcutSessionTargets(snapshot.tree, FIXED_NODES.favorites),
      todos: shortcutSessionTargets(snapshot.tree, FIXED_NODES.todos),
      settings: normalizeSettings(settings),
      revisions: {
        tree: tree.revision,
        annotations: annotations.revision,
        settings: settings.revision,
      },
      stats: snapshot.stats,
      scannedAt: snapshot.scannedAt,
    };
  },


  /**
   * The tag vocabulary: the shared library first (in creation order), then the
   * tags that are only in use on sessions. `tags` keeps the plain usage index
   * for callers that only want counts.
   */
  "GET /tags": async (api) => {
    const annotations = await api.documents.annotations.read();
    return { tags: tagIndex(annotations), library: tagVocabulary(annotations) };
  },


  /**
   * 会话内容 search. See {@link searchSessionContent}.
   */
  "GET /search/content": async (api, _req, _res, query) =>
    searchSessionContent(api, query?.get("q"), { limit: query?.get("limit") }),


  /**
   * Where the 会话内容 index stands — 设置 › 搜索索引 reads this to print
   * "已建立 12/63" and to follow a rebuild.
   *
   * Plans but does not build: opening the settings page must not start a six
   * second log scan behind it. `indexIdle` is what makes the build happen on its
   * own; this route only reports.
   */
  "GET /search/index": async (api) => {
    await api.content.open();
    const snapshot = await api.reader.snapshot({});
    api.content.sync(snapshot.sessions);
    return {
      ...api.content.state(),
      cache: await api.content.cacheInfo(),
      building: api.indexBuilder.busy(),
    };
  },


  /**
   * 重新建立索引缓存: drop the file, forget every entry, and read the logs again.
   *
   * Answers with the plan and lets the caller poll `GET /search/index` for
   * progress: a request that waited for 63 logs would hang the click that asked
   * for it, and the page has a progress line for exactly this.
   */
  "POST /search/index/rebuild": async (api) => {
    const snapshot = await api.reader.snapshot({});
    const plan = await api.content.rebuild(snapshot.sessions);
    api.indexBuilder.rebuild(api).catch(() => {});
    return { ...plan, cache: await api.content.cacheInfo(), building: true };
  },


  /**
   * 删除索引缓存: the file *and* the memory that mirrors it.
   *
   * The next 会话内容 search rebuilds from the logs, which is what the button
   * says it will do — and `stop` keeps 允许空闲时自动建立 from undoing the delete
   * a second later. Writing the setting, or searching content, arms it again.
   */
  "POST /search/index/clear": async (api) => {
    api.indexBuilder.stop();
    const result = await api.content.clear();
    return { ...result, cache: await api.content.cacheInfo(), building: false };
  },


  /** Add a tag to the shared library (the user's own vocabulary). */
  "POST /tags": async (api, req) => {
    const tag = requireText(req.body?.tag, "tag");
    const document = await api.documents.annotations.mutate(
      (draft) => {
        draft.tags = addLibraryTag(draft.tags, tag);
      },
      expectedRevision(req, api),
    );
    return { tag, library: tagVocabulary(document), revision: document.revision };
  },


  /** Remove a tag from the library. Sessions that carry it keep it. */
  "DELETE /tags/:tag": async (api, req) => {
    const tag = String(req.params.tag ?? "");
    if (!tag) throw badRequest("tag is required");
    const document = await api.documents.annotations.mutate(
      (draft) => {
        draft.tags = removeLibraryTag(draft.tags, tag);
      },
      expectedRevision(req, api),
    );
    return { tag, library: tagVocabulary(document), revision: document.revision };
  },


  /** Patch one session's annotation (tags / note / 收藏 / 待办). */
  "PATCH /annotations/:id": async (api, req) => {
    const id = String(req.params.id ?? "");
    if (!id) throw badRequest("session id is required");
    // The annotation document is keyed by session id; `__proto__` and friends
    // would write the object's prototype instead of an entry.
    if (!isAnnotationId(id)) throw badRequest("session id is not a valid id");
    // 收藏/待办/标签/备注 are the user's opinion of a *session*; a subagent is a
    // part of its parent's run, so the parent is what carries the opinion.
    await assertStandalone(api, id);
    const patch = req.body && typeof req.body === "object" ? req.body : {};
    // 收藏 / 待办 are stored as shortcuts — one source per fact. Accepting them
    // here wrote a second copy that no view reads, so a toggle could report
    // success while nothing changed.
    const misplaced = ["favorite", "todo"].filter((key) => key in patch);
    if (misplaced.length > 0) {
      throw badRequest(`${misplaced.join(" / ")} is a shortcut, not an annotation; use POST /shortcuts`);
    }
    // An annotation is keyed by session id, and a view can only show a row it
    // knows: an id no listing and no bin entry carries would sit here forever.
    const [snapshot, trash] = await Promise.all([api.reader.snapshot({}), api.documents.trash.read()]);
    const known = snapshot.sessions.some((session) => session.id === id) || Boolean(trash.entries?.[id]);
    if (!known) throw codedError("session-not-found", `unknown session ${id}`);
    const document = await api.documents.annotations.mutate(
      (draft) => {
        patchAnnotation(draft, id, patch, Date.now());
      },
      expectedRevision(req, api),
    );
    return {
      id,
      annotation: document.sessions[id] ?? null,
      revision: document.revision,
      tags: tagIndex(document),
      // Membership of 收藏 / 待办 is the tree's business: answering from the
      // annotation document would describe a copy nothing writes any more.
      favorites: shortcutSessionTargets(snapshot.tree, FIXED_NODES.favorites),
      todos: shortcutSessionTargets(snapshot.tree, FIXED_NODES.todos),
    };
  },


  /**
   * One session's explorer-side state, for the buttons DSH's own session
   * header and row menu render.
   *
   * Those surfaces live outside the panel, so they have no bootstrap snapshot
   * to read and cannot re-download the whole library for three booleans. This
   * route answers exactly what a toggle needs: the two annotation flags, the
   * archive membership DSH reports, and whether the log is in the bin. The
   * header re-reads it after every write, so a toggle the host refuses (a
   * trashed session has no payload left to annotate) shows as the state it
   * actually is rather than the one the click assumed.
   */
  "GET /session-state/:id": async (api, req) => {
    const id = String(req.params.id ?? "");
    if (!id) throw badRequest("session id is required");
    const [tree, trash, snapshot] = await Promise.all([
      api.documents.tree.read(),
      api.documents.trash.read(),
      api.reader.snapshot({}),
    ]);
    // 收藏 / 待办 are read off the shortcuts, exactly like the panel does.
    return sessionStateOf({ shortcuts: tree.shortcuts, trash, sessions: snapshot.sessions }, id);
  },
};
