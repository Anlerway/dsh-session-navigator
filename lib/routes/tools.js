// 路由组 tools（8 条）
import { describeDataDir, inspectDataDir, migrateDataDir } from "../host/datadir.js";
import { installInput } from "../routes/shared.js";

export const toolsRoutes = {


  /**
   * Where the data lives right now, and what is in it.
   *
   * The settings page shows this before offering a migration, so a user can see
   * how large a move would be and whether the environment overrides the
   * location (a `DSH_SE_DATA_DIR` override makes a migration pointless).
   */
  "GET /datadir": async (api) => describeDataDir(api),


  /**
   * Pre-flight for a migration: validate the target and report the plan
   * without touching anything.
   */
  "POST /datadir/inspect": async (api, req) => inspectDataDir(api, req.body?.target),


  /**
   * Move the data directory. Blocks other writes for the duration (step 3 of
   * the seven-step flow in 实现粗规划.md §5.5).
   */
  "POST /datadir/migrate": async (api, req) => migrateDataDir(api, req.body ?? {}),


  /**
   * Component status: what the settings page polls.
   *
   * Polling, not SSE: the only live number is a download percentage, and the one
   * page that shows it is open for seconds at a time. A push stream nothing ever
   * subscribed to was pure surface.
   */
  "GET /component/status": async (api) => api.component.status(),


  /** Start (or resume) the component install. */
  "POST /component/install": async (api, req) => api.component.install(installInput(req.body)),


  /** Cancel an in-flight install, keeping the partial download for a resume. */
  "POST /component/cancel": async (api) => api.component.cancel(),


  /** Delete the component. Refuses while the detached window is running. */
  "POST /component/remove": async (api) =>
    api.component.remove({
      closeHelper: async () => {
        if (!api.detached.running) return true;
        return api.detached.close();
      },
    }),


  /** Retry after an error; an existing .part resumes instead of restarting. */
  "POST /component/retry": async (api, req) => api.component.install(installInput(req.body)),
};
