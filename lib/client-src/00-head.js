/**
 * dsh-session-navigator — client half (browser bundle, no build step).
 *
 * Loaded through `window.__ModuleLoader__.load({ id, factory })`, exactly like
 * every other out-of-tree DSH client plugin. `factory` receives a `require`
 * that resolves the host's shared modules (`react`, the UI primitives) — the
 * plugin ships no bundler output and no runtime dependency of its own.
 *
 * This one file is the whole UI: the panel's window chrome (tabs, breadcrumb
 * bar, command bar, three panes, status bar), the session detail pane, the
 * settings page, and the five slots DSH's own surfaces render us into. The
 * detached window loads this same file, so there is no second UI to keep in
 * sync.
 *
 * Two rules it obeys:
 *
 *   1. It re-derives nothing. Rows, badge counts, placement and the visible
 *      subtree all arrive computed from the host (`lib/domain/tree.js`); the
 *      client reads fields, it does not own a rule table. `test/tree-mirror.
 *      test.mjs` exists because this rule was broken once.
 *   2. Every write is a host request. Tags, notes, pins, archive, trash,
 *      placement and renames all go through `/session-navigator/api`; the client
 *      never touches `sessions/` or a sidecar file directly.
 */
window.__ModuleLoader__.load({
  id: "dsh-session-navigator",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

    const h = (type, props, ...children) => React.createElement(type, props, ...children);

