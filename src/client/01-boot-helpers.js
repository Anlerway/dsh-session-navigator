    /**
     * Put text on the clipboard, and report whether it actually landed.
     *
     * `navigator.clipboard` needs a secure context and a granted permission, so
     * it is tried first and a hidden textarea is the fallback — the panel must
     * still be able to hand over a path when the async API is unavailable.
     * Returns false rather than throwing: the caller shows the path instead.
     *
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async function copyText(text) {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        // Fall through to the textarea path.
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand("copy");
        area.remove();
        return copied === true;
      } catch {
        return false;
      }
    }

    const API = "/session-navigator/api";
    const NS = "session-navigator";
    const CSS_ID = "dsh-session-navigator/panel";

    /**
     * Which build of this module is running.
     *
     * The host prepends it when it serves the file (see `serveClientModule`), so
     * a copy loaded before an update carries the old stamp. Comparing it with
     * `GET /version` is the only way a page can tell that it is running code
     * from before the plugin was changed — which otherwise looks like a broken
     * panel rather than a stale one.
     */
    const CLIENT_BUILD = typeof globalThis.__SE_BUILD__ === "string" ? globalThis.__SE_BUILD__ : "";

    /**
     * The tokens the detached window needs from the live theme.
     *
     * Kept in step with src/host/theme.js by construction: the host filters
     * against the same list, so a token added here without there is simply
     * dropped on the way through rather than silently half-applied.
     */
    const THEME_TOKENS = Object.freeze([
      "--dsw-alias-bg-layer-1",
      "--dsw-alias-bg-layer-2",
      "--dsw-alias-bg-layer-3",
      "--dsw-alias-label-primary",
      "--dsw-alias-label-secondary",
      "--dsw-alias-label-tertiary",
      "--dsw-alias-border-l1",
      "--dsw-alias-border-l2",
      "--dsw-alias-state-business-primary",
      "--dsw-alias-brand-primary",
      "--dsw-alias-state-error-primary",
      "--dsw-alias-interactive-bg-hover",
      "--dsw-alias-state-success-primary",
      "--dsw-alias-state-warning-primary",
    ]);
    const LAYOUT_KEY = "dsh-session-navigator/layout.v1";

    /**
     * Layout memory.
     *
     * The panel is a transient overlay: closing it unmounts every component, so
     * without persistence the next open would forget the pane widths, the
     * active scope and the collapsed branches. The prototype keeps that state in
     * memory only because it never unmounts; we keep it in localStorage so the
     * panel reopens exactly where it was left. Every read is defensive — a
     * corrupt or half-written entry must never stop the panel from opening.
     */
    function readLayout() {
      try {
        const raw = window.localStorage.getItem(LAYOUT_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    }

    function mergeLayout(patch) {
      try {
        const next = { ...readLayout(), ...patch };
        window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      } catch {
        /* storage disabled — the panel still works, it just forgets */
      }
    }

    /*
     * Which version's 更新说明 has already been shown lives on the host
     * (src/host/notes-seen.js) and arrives as `seen` on /release-notes — not in
     * localStorage, where it would be partitioned by origin. The DSH web GUI is
     * served from a fresh port on every launch, so a record written under one
     * port is invisible under the next: the notice showed up at every start.
     */

    /**
     * What to do about `version`'s notes, given what the browser already saw.
     *
     * `announce` covers a first install as well: a version whose notes were
     * never read is exactly the case the notes are for, and the very first
     * launch is the only time that version will ever be new.
     *
     *   - `announce` — nothing recorded, or a different version recorded.
     *   - `idle` — this version was already delivered, or there is no version.
     *
     * @param {string} version
     * @param {string} seen
     * @returns {"announce" | "idle"}
     */
    function notesDecision(version, seen) {
      const current = String(version ?? "");
      if (!current) return "idle";
      return String(seen ?? "") === current ? "idle" : "announce";
    }

    /**
     * The 更新说明 layer: whether it is on screen, and whether this page load has
     * already asked about it.
     *
     * Module scope rather than component state because the layer is mounted with
     * the sidebar entry, which DSH may remount at will — and a notice the user
     * closed must not come back on the next render. `open` is also what the
     * panel's keyboard guard reads.
     */
    const notesLayer = { open: false, asked: false };

    /**
     * How long after startup the notes appear.
     *
     * DSH's own first paint, the sidebar, and this plugin's entry all land in
     * the first second; a modal that covers the window before the user has
     * seen it reads as the app failing to start. A few seconds is long enough
     * for the shell to settle and short enough to still be "on startup".
     */
    const NOTES_DELAY_MS = 3000;

    // One frozen empty array for defaulted list props: a fresh `[]` on every
    // render would break the memo dependencies of every component that gets it.
    const EMPTY_LIST = Object.freeze([]);
    // The same for the folded-band set, which ListPane reads on every render.
    const EMPTY_BANDS = Object.freeze(new Set());
    /** Fallback translator for components rendered outside the panel's provider.
     *  Module scope on purpose: a fresh closure per render would change the `t`
     *  identity every render and defeat every `useCallback` that depends on it. */
    const identityT = (key) => key;


    // Frame presets for the native Modal (`frameSizeOf`). At module scope so a
    // render does not allocate two fresh tables, and named apart from FIXED so a
    // later `FIXED.root` inside that helper cannot silently read undefined.
    const MODAL_FIXED = { sm: [860, 560], md: [1100, 720], lg: [1320, 820], xl: [1600, 960] };
    const MODAL_SHARE = { p50: 50, p70: 70, p85: 85, p100: 100 };

    const FIXED = {
      root: "f-root",
      // 所有会话 — the flat list. 根目录 is the directory tree and holds no
      // session rows of its own, so this view is where they are all listed.
      all: "f-all",
      favorites: "f-favorites",
      todos: "f-todos",
      trash: "f-trash",
      ungrouped: "f-ungrouped",
    };

    /**
     * Open this plugin's section in DSH's own settings window.
     *
     * The settings shell owns its modal: it publishes slots for its *contents*
     * and for nothing else, so there is no `openSettings` on a service. Three
     * doors exist, they fail in different places, and the opener tries them in
     * order and reports whether one actually landed:
     *
     *   1. `settings.onboarding` props carry `openSection(id)` — the shell's own
     *      navigation action, and the only one that opens the modal *already on
     *      our section*. But the shell mounts that roster only while the
     *      onboarding flow is showing (a blank session) or while a step is asked
     *      for by id, so on an ordinary session it never arrives. This entry was
     *      built on it alone, which is why it stopped working.
     *   2. The product command `settings.open` — the exact command the sidebar
     *      Settings button and the Settings shortcut run. `ctx.shortcuts` does
     *      not publish `invoke`, but the registry it owns does, and invoking it
     *      is exactly what a native menu selection does: no keypress is faked
     *      and no DSH button is clicked.
     *   3. The modal's nav rail is a list of buttons carrying each section's
     *      label, so once (2) has opened the window on whatever section it was
     *      last left on, we click the cell whose label is ours. The store's
     *      active-section id is unreachable from outside, and this step is
     *      deliberately best-effort: the window is already open by then.
     *
     * Every step is verified against the DOM (`[data-shortcut-modal="settings"]`)
     * before the caller is told it worked, because a command that silently does
     * nothing must not close the panel and leave the screen empty.
     */
    let openSettingsSection = null;

    /** The settings modal, or null while it is not open. */
    function settingsModalElement() {
      try {
        return document.querySelector('[data-shortcut-modal="settings"]');
      } catch {
        return null;
      }
    }

    /**
     * Which modal owns the keyboard, in the shape DSH's command registry takes:
     * the topmost `[data-shortcut-modal]` element's id, `"other"` for an unnamed
     * dialog, `null` when the page is free.
     *
     * Mirrors the native menu adapter rather than inventing a second rule, so a
     * command invoked from here is blocked by the same modal it would be blocked
     * by from DSH's own menu.
     */
    function productModal() {
      try {
        const top = [...document.querySelectorAll("[data-shortcut-modal]")].at(-1);
        if (!top) return null;
        return top.dataset?.shortcutModal ?? "other";
      } catch {
        return null;
      }
    }

    /** React paints the modal a tick after the command runs, so poll briefly. */
    function waitForSettings(timeoutMs = 600) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
          if (settingsModalElement()) resolve(true);
          else if (Date.now() >= deadline) resolve(false);
          else setTimeout(tick, 40);
        };
        tick();
      });
    }

    /**
     * Click the nav cell whose label is `label`.
     *
     * Labels follow the UI language and the nav re-renders with the panel, so
     * this returns whether it found one instead of retrying by itself.
     */
    function selectSettingsSection(label) {
      if (!label) return false;
      let buttons;
      try {
        buttons = settingsModalElement()?.querySelectorAll("nav button") ?? [];
      } catch {
        return false;
      }
      for (const button of buttons) {
        if (button.textContent?.trim() === label) {
          button.click();
          return true;
        }
      }
      return false;
    }

    /**
     * @param {string} sectionId slot id registered on `settings.section`
     * @param {string} [label] our localized nav label, for the click step
     * @returns {Promise<boolean>} whether DSH's settings window is open now
     */
    async function openNativeSettings(sectionId, label) {
      // Already open: point it at our section instead of toggling it shut —
      // `settings.open` toggles, and the user asked to *see* the settings.
      if (settingsModalElement()) {
        selectSettingsSection(label);
        return true;
      }
      if (typeof openSettingsSection === "function") {
        try {
          openSettingsSection(sectionId);
        } catch {
          /* an older shell that throws here still gets the command below */
        }
        if (await waitForSettings()) return true;
      }
      const registry = serviceOf("shortcuts")?.registry;
      if (registry && typeof registry.invoke === "function") {
        try {
          registry.invoke("settings.open", {
            target: document.activeElement ?? null,
            region: "page",
            modal: productModal(),
          });
        } catch {
          /* a registry that rejects the context is a version we cannot drive */
        }
      }
      if (!(await waitForSettings())) return false;
      // The command opens the window where it was left; give the nav a couple
      // of ticks to mount before looking for our cell.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (selectSettingsSection(label)) break;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return true;
    }

    /**
     * The detached window's channel back to this plugin inside DSH.
     *
     * The window is its own document: it has no settings shell and no command
     * registry, so anything that belongs to DSH itself has to be *asked for*
     * rather than done. The shim that stands in for DSH out there provides this
     * one member and nothing else, which makes its presence the answer to "am I
     * the window?" — inside DSH there is no such service, and the question never
     * has to be asked the other way round.
     */
    function windowHost() {
      const bridge = serviceOf("hostBridge");
      return bridge && typeof bridge.request === "function" ? bridge : null;
    }

    /**
     * The two repaints only the window's page shell can perform.
     *
     * assets/detached/shim.js owns the palette (it is the only place that can
     * write the tokens onto the window's own `:root`) and the language (the
     * dictionary is chosen in the URL, once, at load). This module is the one
     * already holding the Host's command stream open, so it performs the
     * delivery instead of the shim opening a second EventSource.
     *
     * @returns {{ applyTheme?: () => Promise<boolean>, setLang?: (lang: string) => void } | null}
     */
    function shimHooks() {
      const hooks = serviceOf("shimHooks") ?? globalThis.__seShimHooks ?? null;
      return hooks && typeof hooks === "object" ? hooks : null;
    }

    /**
     * Where a 更多设置… press has to go, and what to tell the user.
     *
     * In DSH the panel opens the settings window itself. In the detached window
     * there is nothing to open — the settings shell lives in the DSH page — so
     * the press becomes a request *to* that page, and the hint says where it
     * went: a button that appears to do nothing is indistinguishable from a
     * broken one, and this is the one case the panel cannot show the result.
     *
     * @param {string} [label] our section's localized nav label
     * @returns {Promise<string>} a hint key to show, or "" when the panel should
     *   simply step aside because the settings window is up in this document
     */
    async function openSettingsTarget(label) {
      const bridge = windowHost();
      if (bridge) {
        try {
          const delivered = await bridge.request("open-settings", {});
          // The bus answers with the number of documents that heard the
          // command, and this window is one of them — so 1 means it went
          // nowhere. The window used to say 已在 DSH 主窗口打开 either way,
          // which reads as a success even on a machine where the DSH page was
          // closed a minute ago. Unknown (a repeated click inside the echo
          // window, an older Host) keeps the old wording.
          const heard = typeof delivered?.listeners === "number" ? delivered.listeners : null;
          return heard !== null && heard <= 1 ? "setOpenHostSilent" : "setOpenedInHost";
        } catch {
          return "setOpenHostFailed";
        }
      }
      return (await openNativeSettings("session-navigator", label)) ? "" : "setOpenFailed";
    }

    /**
     * Open our settings section on behalf of the detached window.
     *
     * Hung on the bridge rather than on Panel: the window may ask while the
     * floating panel is closed, and the settings window has to open anyway. The
     * panel, if it happens to be up, steps aside once the window is verified
     * open — the settings modal is drawn under the panel's own layer.
     *
     * @returns {Promise<boolean>} whether this document opened it
     */
    async function openSettingsFromBridge() {
      // In the window this command is our own request coming back on the bus;
      // the window has no settings shell, so there is nothing to do here.
      if (windowHost()) return false;
      const opened = await openNativeSettings("session-navigator", slotT(null)("navLabel"));
      if (opened) panelStore.set(false);
      return opened;
    }

