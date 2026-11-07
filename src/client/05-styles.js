    // ── Styles ─────────────────────────────────────────────────────────────
    // Ported from the standalone prototype, but every one of its --sm-* colours
    // is bridged onto a DSH alias token (see the bridge at the top of the
    // sheet), so no colour is ever hardcoded here and a theme plugin that
    // republishes the alias layer restyles the whole panel.
    //
    // The sheet itself lives in assets/panel.css. Keeping 78 KB of CSS inside
    // a template literal meant no editor highlighted it and no diff showed
    // which rule moved. The `@inline` marker asks
    // scripts/build-client.mjs to splice the file back in as a JSON string
    // literal, so the bundle still carries the sheet as one constant and the
    // client still never reads a file: it runs in the browser, which has no fs.
    const CSS = /* @inline assets/panel.css */ "";
