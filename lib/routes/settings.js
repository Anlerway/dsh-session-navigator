// 路由组 settings（2 条）
import { mergeSettings, normalizeSettings } from "../domain/settings.js";
import { pluginVersion } from "../host/update.js";
import { expectedRevision } from "../routes/shared.js";
import { optionalObject } from "../validate.js";

export const settingsRoutes = {


  /**
   * The settings document on its own, for the settings page.
   *
   * `/bootstrap` carries the same object, but the settings page mounts outside
   * the panel and must not pay for a full session scan just to render.
   */
  "GET /settings": async (api) => {
    const document = await api.documents.settings.read();
    return {
      settings: normalizeSettings(document),
      revision: document.revision,
      capabilities: await api.capabilities(),
      dataDir: api.dataDir,
      // Rides along so the 关于 group can print the version without a second
      // request, and without a second copy of the number in the client.
      version: pluginVersion(),
    };
  },


  /**
   * Panel settings that must follow the user across browsers.
   *
   * The body is a partial document — nested groups may be sent alone, e.g.
   * `{ shell: { modal: { dim: 0.2 } } }` — and unknown keys are dropped by
   * `mergeSettings` instead of being persisted.
   */
  "PUT /settings": async (api, req) => {
    const body = optionalObject(req.body);
    const document = await api.documents.settings.mutate(
      (draft) => {
        Object.assign(draft, mergeSettings(draft, body));
      },
      expectedRevision(req, api),
    );
    const settings = normalizeSettings(document);
    // 允许空闲时自动建立, turned on, is the user saying "the index may exist":
    // lift a 删除缓存 pause and queue the build. There is no 缓存 switch to fold
    // into this — the file is always kept, and 删除索引缓存 is a one-off request
    // rather than a mode. nudge → step re-reads the switch, so
    // turning it on and off again inside the delay costs nothing.
    if (settings.search.indexIdle) api.indexBuilder.resume(api);
    return { settings, revision: document.revision };
  },
};
