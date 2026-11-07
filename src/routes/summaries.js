// 路由组 summaries（8 条）
import { addLibraryTag, isAnnotationId, patchAnnotation, tagVocabulary } from "../domain/annotations.js";
import { normalizeSettings } from "../domain/settings.js";
import { mergeNote, normalizeSummaries, pendingBreakdown, pickTags } from "../domain/summaries.js";
import { renameSession } from "../host/actions.js";
import { assertStandalone, badRequest } from "../routes/shared.js";
import { codedError } from "../store/sidecar.js";
import { requireEnum } from "../validate.js";

export const summariesRoutes = {


  /**
   * AI 字段: what is stored, what it cost, and which rows still
   * need one.
   *
   * `pending` is computed here rather than in the client so 一键补齐 and the
   * settings page's count can never disagree: there is one definition of
   * "还缺字段" (domain/summaries.js › pendingBreakdown) and it runs on the rows
   * the panel is already showing. It only looks at the description and the tags
   * — a session that was renamed by hand is still pending, because a
   * name is not a summary.
   */
  "GET /summaries": async (api) => {
    const [document, snapshot, settings] = await Promise.all([
      api.documents.summaries.read(),
      api.reader.snapshot({}),
      api.documents.settings.read(),
    ]);
    const summaries = normalizeSummaries(document);
    const choice = normalizeSettings(settings).summary;
    return {
      sessions: summaries.sessions,
      spend: summaries.spend,
      pending: pendingBreakdown(snapshot.sessions, summaries, choice.fields).ids,
      revision: document.revision,
      // Echoed so the settings page can show the route that will actually be
      // used, which is not the stored one when that model has left the profile.
      choice,
    };
  },


  /**
   * The models this profile can summarize with, with their reasoning efforts.
   *
   * `?refresh=1` drops the minute-long cache — the settings page's 刷新 button,
   * for the case where the user just added a provider in another tab.
   */
  "GET /summarize/catalog": async (api, _req, _res, query) => {
    // The cache is only dropped when the caller says the world changed (a
    // provider added in another tab); a plain page load reuses it.
    if (query?.get("refresh") === "1") api.summarizer.refresh();
    return api.summarizer.catalog(query?.get("refresh") === "1");
  },


  /**
   * Progress, for the polling the settings page and the status bar do.
   *
   * A GET with no side effect: the panel polls it once a second while a batch
   * runs, and stops when `running` is false. The spend ledger rides along so the
   * running total climbs visibly during a batch instead of appearing at the end.
   */
  "GET /summarize/state": async (api) => api.summarizer.state(),


  /**
   * Queue one or more sessions for summarization.
   *
   * Body: `{ ids: string[], titles?: Record<string,string>, lang?: "zh"|"en" }`.
   * The titles are whatever the panel calls those rows today (a DSH title or a
   * user rename); they are used for the progress line and passed to the prompt
   * as the session title, so a summary names the session the way the list does.
   */
  "POST /summarize": async (api, req) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const ids = Array.isArray(body.ids) ? body.ids : [];
    return api.summarizer.start(ids, { titles: body.titles, lang: body.lang });
  },


  /**
   * 一键补齐还缺的字段: the pending set, then the same queue.
   *
   * Refused with `nothing-pending` when every session already has both halves
   * the sweep checks, so the button can say so instead of starting a run that
   * immediately finishes. `skipped` reports how many rows were already done, so
   * the settings page can say 还有 N 个会话没做 instead of just N.
   */
  "POST /summarize/pending": async (api, req) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const [document, snapshot, settings] = await Promise.all([
      api.documents.summaries.read(),
      api.reader.snapshot({}),
      api.documents.settings.read(),
    ]);
    const breakdown = pendingBreakdown(snapshot.sessions, normalizeSummaries(document), normalizeSettings(settings).summary.fields);
    if (breakdown.ids.length === 0) throw codedError("nothing-pending", "所有会话都已经有描述和标签了");
    const titles = {};
    for (const session of snapshot.sessions) {
      if (session && typeof session.id === "string") titles[session.id] = session.displayTitle ?? session.id;
    }
    const state = await api.summarizer.start(breakdown.ids, { titles, lang: body.lang });
    return { ...state, candidates: breakdown.total, skipped: breakdown.skipped };
  },


  /** Stop after the call in flight; what completed stays on disk. */
  "POST /summarize/cancel": async (api) => api.summarizer.cancel(),


  /** Forget one stored field set (the next run makes a new one). */
  "DELETE /summaries/:id": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    if (!isAnnotationId(sessionId)) throw badRequest("session id is not a valid id");
    const document = await api.documents.summaries.mutate((draft) => {
      const next = normalizeSummaries(draft);
      delete next.sessions[sessionId];
      return next;
    });
    return { sessionId, revision: document.revision };
  },


  /**
   * Take one generated field over.
   *
   * Nothing the model writes is applied on its own: a generated title becomes
   * the session's name only when this route is called, and generated tags land
   * in the user's own tag list only here. Writing them at generation time would
   * let a twenty-session batch rename a library nobody has read yet — and an
   * applied title is also DSH's own `session/title` event, which supersedes
   * automatic titling, so it has to be the user's decision.
   *
   * Body: `{ field: "title" | "tags" }`.
   */
  /**
   * Take one generated field over.
   *
   * Three fields, three meanings, all of them one click and none of them
   * automatic:
   *
   * - `title` renames the session through DSH's own rename event.
   * - `description` is appended to the note the user wrote, never replacing it:
   *   the note is their words, the description is an addition.
   * - `tags` merges only the tags the user ticked (`body.tags`), and adds those
   *   tags to the library so the next run recognises them as existing.
   */
  "POST /summaries/:id/apply": async (api, req) => {
    const sessionId = String(req.params.id ?? "");
    if (!isAnnotationId(sessionId)) throw badRequest("session id is not a valid id");
    // A name and a tag list belong to a session; a subagent is a part of its
    // parent's run, so the parent is the thing that carries them (the same rule
    // the rename and annotation routes follow).
    await assertStandalone(api, sessionId);
    const field = requireEnum(String(req.body?.field ?? ""), ["title", "description", "tags"], "field", {
      message: "field must be title, description or tags",
    });
    const stored = normalizeSummaries(await api.documents.summaries.read());
    const entry = stored.sessions[sessionId];
    if (!entry) throw codedError("session/not-found", `会话 ${sessionId} 还没有生成过字段`);
    if (field === "title") {
      if (entry.title === "") throw codedError("nothing-to-apply", "这段会话还没有生成标题");
      const renamed = await renameSession(api, sessionId, entry.title);
      const document = await api.documents.summaries.mutate((draft) => {
        const next = normalizeSummaries(draft);
        const row = next.sessions[sessionId];
        if (row) row.applied = { ...row.applied, title: true };
        return next;
      });
      return { sessionId, field, title: entry.title, renamed, applied: document.sessions[sessionId]?.applied ?? null };
    }
    if (field === "description") {
      if (entry.description === "") throw codedError("nothing-to-apply", "这段会话还没有生成描述");
      const annotations = await api.documents.annotations.mutate((draft) => {
        const current = typeof draft.sessions?.[sessionId]?.note === "string" ? draft.sessions[sessionId].note : "";
        patchAnnotation(draft, sessionId, { note: mergeNote(current, entry.description) }, Date.now());
      });
      const document = await api.documents.summaries.mutate((draft) => {
        const next = normalizeSummaries(draft);
        const row = next.sessions[sessionId];
        if (row) row.applied = { ...row.applied, description: true };
        return next;
      });
      return {
        sessionId,
        field,
        note: annotations.sessions[sessionId]?.note ?? "",
        applied: document.sessions[sessionId]?.applied ?? null,
      };
    }
    // A selection that names nothing stored is a refusal, not "everything": a
    // stale tick from a regenerated record must not silently merge all of it.
    const picked = pickTags(entry.tags, req.body?.tags);
    if (picked.length === 0) throw codedError("nothing-to-apply", "没有勾选要合并的标签");
    const annotations = await api.documents.annotations.mutate((draft) => {
      const current = Array.isArray(draft.sessions?.[sessionId]?.tags) ? draft.sessions[sessionId].tags : [];
      const tags = [];
      for (const tag of [...current, ...picked]) if (!tags.includes(tag)) tags.push(tag);
      patchAnnotation(draft, sessionId, { tags }, Date.now());
      // The library is the vocabulary the next run is shown: a tag the user just
      // accepted belongs in it, or the model will invent it again next time.
      for (const tag of picked) draft.tags = addLibraryTag(draft.tags, tag);
    });
    const document = await api.documents.summaries.mutate((draft) => {
      const next = normalizeSummaries(draft);
      const row = next.sessions[sessionId];
      if (row) row.applied = { ...row.applied, tags: true };
      return next;
    });
    return {
      sessionId,
      field,
      tags: annotations.sessions[sessionId]?.tags ?? [],
      library: tagVocabulary(annotations),
      applied: document.sessions[sessionId]?.applied ?? null,
    };
  },
};
