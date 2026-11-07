// 路由组 release（5 条）
import { clearCaches } from "../host/maintenance.js";
import { writeNotesSeen } from "../host/notes-seen.js";
import { openLink } from "../host/open-link.js";
import { resetData } from "../host/reset.js";
import { checkUpdate } from "../host/update.js";

export const releaseRoutes = {


  /**
   * Is there a newer release than this build?
   *
   * Server-side because `api.github.com` sends no CORS headers: the same
   * request from the page fails in a way that is indistinguishable from "no
   * update". `?force=1` skips the short-lived cache, for the second press of
   * the button.
   */
  "GET /update": async (api, req, res, query) => checkUpdate({ force: query?.get("force") === "1" }),


  /**
   * Open one of the project's pages (repo / star / issues / releases).
   *
   * The body names a target, not a URL — see `LINK_TARGETS`. A route that opens
   * an arbitrary address would be an open-an-app primitive for anything else on
   * this origin.
   */
  "POST /about/open": async (api, req) => openLink(req.body?.target),


  /**
   * Mark this version's notes as delivered.
   *
   * Written by the panel when the layer closes with something in it, so a
   * document that failed to parse never burns the announcement. No revision:
   * the newest answer wins, and losing a write costs one announcement.
   */
  "POST /release-notes/seen": async (api, req) => ({
    version: await writeNotesSeen(api.paths.notesSeen, req.body?.version),
  }),


  /**
   * Free what this plugin accumulated: in-memory answers, `.tmp` leftovers,
   * half-finished component downloads.
   *
   * Never the quarantine, never DSH's own projection cache — see
   * lib/host/maintenance.js for what is excluded and why.
   */
  "POST /cache/clear": async (api) => clearCaches(api),


  /**
   * 清除数据 — delete every folder, tag, note, bin payload and setting this
   * plugin owns. Irreversible, so the body has to carry the word `DELETE`; the
   * gate is enforced here as well as in the panel (lib/host/reset.js).
   *
   * The Electron component is not user data and is not touched: an install stays
   * installed across a reset, exactly as it survives 清理缓存.
   */
  "POST /data/reset": async (api, req) => resetData(api, { confirm: req.body?.confirm }),
};
