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
  <a href="https://awesome-dsh-plugin.com"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

# Session Navigator

Manage DSH sessions the way Windows Explorer manages files, so that managing a session is as simple as managing a file.

An index lives in `~/.dsh-session-navigator/` — folders, names, tags, notes.

**Who it is for**: people who keep a lot of sessions. Sort, move, delete, annotate and rename your sessions and workspaces as you please; put sessions on a to-do list, favorite them, pin them to the top — session management turns into file management.

- The folder tree grows out of your workspaces; make folders of your own, nest them as deep as you like, and drag workspaces and sessions in and out
- All sessions sit under their workspace, and folders group them any way you like
- Titles, tags and notes are yours to set
- Search covers titles, notes and tags; tick "conversation content" and it searches the dialogue itself
- Favorites, to-dos, pins and archive, with a recycle bin on top, so a delete can be taken back
- Cut and paste across workspaces; export a session as Markdown or JSONL
- AI summary in one click: a model renames a session, tags it and writes its note
- A floating ball entry: besides the sidebar button you can drag out a ball and throw it — it falls, bounces and stays on the floor; five styles, switched in settings › Entry settings
- The detached window renders with GPU acceleration by default and drops to software rendering when the graphics card or driver cannot do it; the backdrop can follow dsh-plugin-wallpaper-engine or be your own picture or video, with blur, frost and dim
- The interface speaks ten languages — 中文, English, 日本語, 한국어, Deutsch, Français, Español, Русский, Português, 繁體中文 — following DSH by default, or pinned to one in settings (the eight DSH ships are all covered; Korean and Traditional Chinese come from the plugin's own picker)

## What it looks like

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/float.png" width="880" alt="Floating panel">
</p>

<p align="center"><em>Floating panel</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/filter.png" width="600" alt="Filter">
</p>

<p align="center"><em>Filter</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/settings.png" width="560" alt="Settings">
</p>

<p align="center"><em>Settings</em></p>

Floating panel too small, too cramped, not enough? There is also the detached window — a real Explorer.

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/window.png" width="900" alt="Detached window, full screen">
</p>

<p align="center"><em>Detached window, full screen</em></p>

It also works split across one screen, or spread over several.

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/split.png" width="900" alt="DSH chat on the left, Session Navigator docked on the right, each independent">
</p>

<p align="center"><em>Split view</em></p>

## Install

### Quick start (recommended)

DSH plugin page → "添加插件" (add plugin) → type `dsh-session-navigator` → install → restart DSH.

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/install.png" width="560" alt="The DSH add-plugin dialog with dsh-session-navigator typed in, ready to install">
</p>

### From the command line

Web:

```powershell
dsh plugin --profile web add dsh-session-navigator
```

Desktop:

```powershell
dsh plugin --profile desktop add dsh-session-navigator
```

### From the GitHub source

Web

```powershell
dsh plugin --profile web add github:Anlerway/dsh-session-navigator
```

Desktop

```powershell
dsh plugin --profile desktop add github:Anlerway/dsh-session-navigator
```

### From a local file

Download the package: [latest release](https://github.com/Anlerway/dsh-session-navigator/releases/latest)

```powershell
dsh plugin --profile web add '<path to the .tgz>'
```

### Update

Web

```powershell
dsh plugin --profile web add dsh-session-navigator@latest
```

Desktop

```powershell
dsh plugin --profile desktop add dsh-session-navigator@latest
```

### Uninstall

Web

```powershell
dsh plugin --profile web remove dsh-session-navigator
```

Desktop

```powershell
dsh plugin --profile desktop remove dsh-session-navigator
```

The plugin's own data stays behind; delete `~/.dsh-session-navigator/` to clean up completely.

Requires Node.js `^22.15.0 || >=24.0.0`.

## What you can do

| Task | How |
| --- | --- |
| Group sessions | Make a folder inside a workspace and drag sessions into it |
| Box select | Drag a box with the mouse, Explorer style; a click on empty space clears the selection |
| Rename | The edit button, or the detail pane on the right |
| Tag / note | The detail pane; tags can be prepared in advance, and AI can generate them in one click |
| Search | The box searches titles, notes, tags and conversation content |
| Favorite / to-do | Select rows, then favorite them or add them to the to-do list |
| Shortcut | Right-click → "Create a shortcut in this directory"; a shortcut can live anywhere |
| Pin | Folders and workspaces pin to the front, in step with the sessions DSH itself pins |
| Quick access | Add entries on the left to reach your usual folders in one click |
| Archive | At the bottom of the list by default; hide it in settings |
| Delete | The whole session directory moves to the recycle bin; restorable, purgeable |
| Change workspace | Cut / paste across workspaces; the session moves as it is |
| Export | Detail pane and row menu; Markdown or JSONL |
| AI summary | A model writes a **title, description and tags** for a session: one click in the "AI fields" section of the detail pane, several sessions at once from the row menu, or one sweep over every session still missing a description or tags in settings |

## Settings

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/settings.png" width="560" alt="The Session Navigator page inside DSH settings">
</p>

| Setting | Default | Notes |
| --- | --- | --- |
| Open mode | Floating panel | Floating panel / detached window; the detached window needs the Electron component and is Windows-only |
| Entry position | Bottom left | Bottom left / floating ball / both; the ball can be dragged, and thrown |
| Ball style | Default | Default / DeepSeek / ChatGPT / Claude / Grok |
| GPU acceleration | On | How the detached window renders; software rendering takes over when the GPU cannot do it, and the change applies the next time the window opens |
| Wallpaper | On | Follow dsh-plugin-wallpaper-engine, or upload your own picture / video; blur, frost and dim are adjustable |
| Session header button style | Auto | It can also be fixed to icon only |
| Auto collapse | Off | Collapse sibling folders after entering one |
| Show archived | On | Turned off, archived sessions are no longer listed at the bottom |
| Hide empty sessions | On | Sessions that never had a turn are not listed |
| Collapse subagents | On | Click the arrow to expand |
| Date format | Exact date | Or time since then |
| Size unit | Auto | Switch between B / KB / MB / GB, or fix it to KB |
| Build the index when idle | On | The index fills in slowly in the background after startup and holds up no request; when a session's content changes, only that session is rebuilt on the next pass |
| Rebuild / delete index | — | Rebuild from scratch, or delete the cache file |
| Fields model | Host default | Pick a model and a reasoning effort from the DSH model catalogue |
| Fill in what is missing | — | Queues every session missing a **description or tags**; progress shows on the settings page and at the bottom of the panel, and it can be stopped at any time |
| Data directory | `~/.dsh-session-navigator` | For migration; change it in settings, or send it back to the default location |
| Clear data | — | Deletes the virtual tree, tags, notes, settings and the recycle bin; session files and the Electron component stay untouched |

## Docs

- [Architecture](docs/architecture.md) · [HTTP API](docs/api.md) · [Data directory](docs/data-directory.md)
- [The rules of the tree](docs/tree-and-placement.md) · [Detached window component](docs/component.md) · [Theme and bridge](docs/bridge-and-theme.md)
- [Testing](docs/testing.md) · [Documentation index](docs/README.md)

## Development and testing

```powershell
node --test "test/*.test.mjs"   # all cases; the run prints the count
node test/render-smoke.mjs      # render smoke test
```
## Issues

If you need macOS or Linux support, run into a bug, or want a feature that is missing, please open an issue.

## License

MIT, see [LICENSE](LICENSE).
