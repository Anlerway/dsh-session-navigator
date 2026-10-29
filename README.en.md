<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/docs/assets/readme/header.png" alt="Session Navigator · dsh-session-navigator" width="720">
</p>

<p align="center">
  <a href="README.md">中文</a> | <strong>English</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-session-navigator"><img alt="npm" src="https://img.shields.io/npm/v/dsh-session-navigator?style=flat-square&color=6c5ce7"></a>
  <a href="https://www.npmjs.com/package/dsh-session-navigator"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-session-navigator?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/Anlerway/dsh-session-navigator/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Anlerway/dsh-session-navigator?style=flat-square&color=eab308"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/dsh-session-navigator?style=flat-square&color=22c55e"></a>
  <a href="https://dsh-plugin.org/plugins/anlerway/dsh-session-navigator"><img alt="listed on dsh-plugin.org" src="https://dsh-plugin.org/badges/listed.svg"></a>
</p>

# Session Navigator

Manage DSH sessions the way Windows Explorer manages files: a folder tree on the left, a session list on the right, with tags, notes and a recycle bin.

Session files stay where DSH keeps them. The plugin copies nothing; it only keeps an index under `~/.dsh-session-navigator/` recording which folder a session sits in, what you named it, which tags it carries and what note you wrote. Delete that directory and it is uninstalled.

**Status**: 1.0.4, usable day to day. Copied sessions do not open yet — use Cut instead.

**Who it is for**: DSH users with dozens or hundreds of sessions who look things up by project rather than by scrolling.

- The folder tree mirrors your workspaces; add your own folders, nest them, drag sessions between them
- Titles, tags and notes are your own words, shown in the list without opening anything
- Search covers titles, notes and tags, and can opt into conversation content: what the user and the agent said, not tool output (its own index, built on first use). The funnel next to the box opens the scope dialog: where (all locations by default, or the current folder) and which fields, plus a jump to the search index settings
- Favorites, todos, pins and archive; delete moves a whole session directory to the recycle bin, restorable and purgeable; subagents follow their parent
- Cut and paste across workspaces; export a session as Markdown or JSONL — what the user said, what the agent answered, every tool call and its output, with compacted history kept verbatim
- Zero runtime dependencies, no build step, `lib/` is the source; CI runs 561 tests on Windows

## What it looks like

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/split.png" width="900" alt="DSH chat on the left, Session Navigator docked on the right">
</p>
<p align="center"><em>Docked on the right of DSH: the chat keeps running on the left, the tree and list stay in view</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/window.png" width="900" alt="Detached window at full screen: tree, list, details">
</p>
<p align="center"><em>Or detach it into its own window: tree, list and details all expanded</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/tree.png" width="300" alt="Folder tree: workspaces become folders, nest as deep as you like">
</p>
<p align="center"><em>The tree: workspaces as folders, each showing how many sessions sit under it</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/overview.png" width="880" alt="Session list: name, tags, note, last activity, size, status">
</p>
<p align="center"><em>The list: name, tags, note, last activity, size, status — tags and notes are your own words</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/filter.png" width="600" alt="Filter dialog: scope, favorites, archive, todos, multi-select tags">
</p>
<p align="center"><em>Filter: pick a scope, then stack favorites, archive and todos; tags are multi-select</em></p>

## Install

### From the plugin page (recommended)

DSH's plugin page → "添加插件" (add plugin) → type `dsh-session-navigator` → install → restart DSH.

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/install.png" width="560" alt="DSH add-plugin dialog with the package name typed in">
</p>
<p align="center"><em>The package name is all it needs; if the npm registry is unreachable, switch the source picker to the mainland-China mirror</em></p>

After the restart a new button appears at the bottom of the sidebar (and a row of entries in the session header). Client CSS is injected at startup, so the panel is invisible until you restart.

### Command line · Web

```powershell
dsh plugin --profile web add dsh-session-navigator

# verify: the output should contain "# == dsh-session-navigator"
dsh --profile web --dump-config | Select-String -Context 0,3 "dsh-session-navigator"
```

### Command line · Desktop app

```powershell
dsh plugin --profile desktop add dsh-session-navigator

# verify: the output should contain "# == dsh-session-navigator"
dsh --profile desktop --dump-config | Select-String -Context 0,3 "dsh-session-navigator"
```

### From source

```powershell
# desktop app; use "web" for the web build
dsh plugin --profile desktop add github:Anlerway/dsh-session-navigator
```

No build step: the source runs as installed.

### Update

```powershell
# swap desktop for web on the web build
dsh plugin --profile desktop add dsh-session-navigator@latest
```

Reload the app after replacing loaded code. Pinning an exact version (`@1.0.4`) avoids pnpm 10's `minimumReleaseAge` resolving an older release.

### Uninstall

```powershell
dsh plugin --profile desktop remove dsh-session-navigator
```

Plugin data is not removed with it; delete `~/.dsh-session-navigator/` to clean up.

Requires Node.js `^22.15.0 || >=24.0.0`.

## What you can do

| Task | How |
| --- | --- |
| Group sessions | Workspaces become folders automatically; drag into another folder or create nested ones |
| Rename | Double-click the row head and type a name you recognise |
| Tag / note | Right-hand detail pane; tags come from a shared tag library |
| Find it again | Search titles, notes, tags and optionally conversation content (user and agent text, not tool output); the funnel opens the scope dialog, where the place is all locations (default) or the current folder, and the footer links to the search index settings; Filter narrows by favorite, archive, todo and tags |
| Favorite / todo | Mark it and it also appears in Favorites / To-do; an entry naming a folder or workspace *is* that container, and double-click goes back to it |
| Shortcut | Create Shortcut in This Directory puts a session or a folder in the container you are standing in; removing it only drops the entry |
| Pin | Pin folders and workspaces to the front of where they already live; DSH's own pinned sessions share the same band, and the tree marks them with a pin glyph |
| Quick access | Drag a folder or workspace onto the Quick Access strip for a second entry point; a row there is that folder, so dropping on it goes inside |
| Multi-select | Check several rows and act on all of them at once: favorite, to-do, pin, archive, quick access, copy, delete. Or press on the empty space of the list — or on any row that is not picked — and drag a box: every row it crosses is checked, and a plain click on that space clears the checks. Only picked rows (clicked or checked) drag; an unpicked row drags a box |
| Archive | De-emphasised but still listed by default; hide them in settings |
| Delete | The whole session directory moves to the recycle bin; restorable, purgeable |
| Move | Cut and paste across workspaces; files, DSH's bookkeeping, tags and notes follow |
| Export | Detail pane and row menu; Markdown or JSONL — user messages, agent replies, every tool call and output, compacted spans kept verbatim; long tool output is truncated in Markdown (full text in JSONL) |
| AI fields | A model writes a **title, description and tags** for a session: one click in the detail pane, several sessions at once from the row menu, or a sweep over everything missing a description or tags. Each part is merged on its own: "Use this title" renames, "Add to my note" appends the description below the note you wrote, and tags are ticked — only the ones you leave ticked join your library, and the list refreshes as soon as you click. Generated tags **reuse the library you already have**; a new one is invented only when none of them fits, and a tag you merge becomes part of the library. Each record shows what that one cost in tokens, and the running total is on the settings page (this needs the `llm` service in DSH; a profile with no models greys the group out and says why) |

## Settings

Settings live in DSH → 会话资源管理器 (Session Navigator), stored in `~/.dsh-session-navigator/settings.v1.json`.

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/settings.png" width="560" alt="The Session Navigator page inside DSH settings">
</p>
<p align="center"><em>The settings page: open mode, list, display, session header — each row explains what it does</em></p>

| Setting | Default | Notes |
| --- | --- | --- |
| Open mode | Floating panel | Floating panel / detached window; the detached window needs a browser runtime download and is Windows-only |
| Header button style | Auto | Icon plus label when there is room, icon only when narrow |
| Auto collapse | Off | Collapse sibling folders after entering one |
| Show archived | On | Turn off to hide archived sessions at the bottom |
| Hide empty sessions | On | Sessions with no turns are not listed |
| Collapse subagents | On | Child sessions fold under the parent |
| Date format | Exact date | Or relative time such as "3 days ago" |
| Size unit | Auto | Picks B / KB / MB / GB, or fix it to KB |
| Search index cache | Always on | Keeps the conversation-content index on disk (`content-index.v1.json`) so a restart does not re-read every log. There is no switch: the file is derived, and deleting it only costs one rebuild |
| Build the index when idle | Off | Once turned on, it fills in slowly after startup and nothing waits on it |
| Rebuild / Delete index | — | Two buttons: rebuild from scratch (results fill in as it goes) or delete the cache file. The search-scope dialog links straight to this group |
| Fields model | Host default | Pick a model from the DSH catalogue (a dropdown), then a reasoning effort. Efforts are the adapter's own words (low / high), so the pick is cleared when the model changes: the previous model's word may not exist on the new one |
| What to generate | Title, description, tags all on | Which fields the model writes. This is about the **output**, not the input: the conversation itself is always sent, thinking and tool output never are |
| Fill in what is missing | — | Queues every session still missing a **description or tags** (a hand-renamed title does not count as done); progress shows on the settings page and at the bottom of the panel, and it can be stopped |
| Data directory | `~/.dsh-session-navigator` | Change it in settings to migrate |

`DSH_SE_DATA_DIR` overrides the data directory for tests or migrations; a path pointing at a filesystem root, `~/.dsh` or inside it is ignored with a warning.

## Docs

Architecture, HTTP API and data directory notes are in [docs/](docs/README.md) (Chinese).

## Development

```powershell
node --test "test/*.test.mjs"   # 535 cases
node test/render-smoke.mjs      # render smoke test
```

CI runs Windows only (`windows-latest`, Node 22 and 24) because the shipping target is the DSH desktop app. macOS and Linux are untested. Version numbers are bumped by the maintainer, not in pull requests.

## License

MIT, see [LICENSE](LICENSE).
