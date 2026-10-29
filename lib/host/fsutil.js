/**
 * Small helpers that only the host layer needs.
 *
 * `dshHomeOf` is a seam, not a duplicate of `paths.js homeOf(env)`: that one
 * answers "where is the operating system's home directory", this one answers
 * "where is DSH's own home" and lets a test inject it through `api.dshHome`.
 */

import { dshHome } from "../dsh/home.js";

/** Quote a value for a single-quoted PowerShell literal. */
export function psQuote(value) {
  return String(value ?? "").replace(/'/g, "''");
}

/**
 * @param {any} api
 * @returns {string}
 */
export function dshHomeOf(api) {
  return typeof api.dshHome === "function" ? api.dshHome() : dshHome();
}
