Release notes: V1.2.0-Alpha-V2

Highlights

This is a preview release. Thanks to everyone who installs and uses the plugin, and for your patience between versions; bug reports and suggestions are always welcome.

- A floating ball entry: drag it, throw it, watch it bounce; five styles, chosen in Settings › Entry settings
- Ten interface languages, eight of them new
- The plugin was refactored, and cold start got much faster
- The detached window follows the theme and pairs with dsh-plugin-wallpaper-engine
- Deleting a session sometimes failed to refresh the list; fixed
- A missing runtime now offers the download right away
- The data folder can go back to its default location
- Every dialog now uses DSH's own dialogs

In detail

New

- A floating ball entry: a draggable ball in addition to the sidebar button; a throw falls, bounces and settles on the floor; five styles (Default, DeepSeek, ChatGPT, Claude, Grok) can be switched; chosen in Settings › Entry settings
- Eight new languages, ten in total (Japanese, Korean, German, French, Spanish, Russian, Portuguese, Traditional Chinese)
- A progress bar for AI summaries
- A missing Electron component now offers the download right away
- Settings › Data folder: move it, or restore the default location
- Release notes are translated too
- A beautify group for the detached window: mirror dsh-plugin-wallpaper-engine's wallpaper or upload your own picture; blur, frost and dim

Improved

- Cold start 3.1 s → 0.12 s (two thousand sessions); a restart answers from the session manifest
- Refreshing reads only changed files; one reply no longer triggers a full sweep
- Long lists build only the visible rows; the first screen skips fifty thousand elements
- Session header and stats cached per file version
- Indexing yields the main thread every 150 ms and caps the text of one session
- Hover highlight responds immediately
- Cache clearing now covers the session manifest, session content, Chromium cache and index
- Dialogs now use DSH's native dialogs
- Some wording was cleaned up
- The settings page's twelve groups are ordered by purpose

Fixed

- Deleting sessions: open ones go to the trash too, no longer land in "Ungrouped", and leave no empty folders
- The panel sometimes came up blank
- A deleted session stayed in its workspace
- The file manager window pinned the DSH process
- Row menu spacing did not match the host menu
- The runtime was labelled Electron
- Component download progress now starts on click instead of after the response
- A 100% panel no longer covers the titlebar
- The three buttons at the top right of the detached window are larger
