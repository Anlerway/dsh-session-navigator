/**
 * The contract layer, as a test: one table for the codes, one envelope for every
 * answer.
 *
 *   node --test test/routes-contract.test.mjs
 *
 * Three things used to drift apart in three places: the code a helper threw, the
 * status the dispatcher answered with, and the sentence the panel showed. The
 * first two now come from one table (lib/errors.js), and this file pins what
 * that table owes its callers:
 *
 *   1. every row is complete, and its status is the one the old 52-case switch
 *      answered — the table replaced the switch, it did not re-decide;
 *   2. both spellings of the same failure ("session/not-found" from DSH's own
 *      layer, "session-not-found" from this plugin's helpers) answer the same
 *      status, because a table that knew only one of them is what turned a 404
 *      into a 500;
 *   3. every code raised anywhere under lib/ has a row, so no raise site can
 *      answer a bare 500 for a failure a client already knows how to handle;
 *   4. every route answers in the envelope lib/http.js builds, whatever body it
 *      is handed — a write route that turns a body it cannot use into a server
 *      fault is the exact bug this file exists to catch.
 *
 * The sweep drives the real dispatcher (lib/index.js, handle()) with a probe
 * PluginApi on a throwaway data directory. Calling the route handler directly
 * would test the table against itself: the code-to-status mapping only runs in
 * handle()'s catch, which is where the 404-became-500 incident happened.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ERROR_CODES, messageFor, normalizeCode, statusFor } from "../lib/errors.js";
import { ROUTES, handle, statusFor as statusForFromIndex } from "../lib/index.js";
import { API_PREFIX } from "../lib/constants.js";
import { fail, ok, send } from "../lib/http.js";
import { dataPaths } from "../lib/paths.js";
import { codedError } from "../lib/store/sidecar.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib");

/** The whole file shares one data directory, and it is never the real one. */
const DATA_DIR = mkdtempSync(join(tmpdir(), "se-contract-"));
mkdirSync(join(DATA_DIR, ".tmp"), { recursive: true });

/**
 * The status the old 52-case switch in lib/index.js answered, code by code.
 *
 * Copied here on purpose rather than derived from the table: this is the
 * contract clients were already written against, so the table has to reproduce
 * it. A row whose status changes has to change this list too, and whoever does
 * that has to look at what a client does with that status.
 *
 * @type {Record<string, number>}
 */
const HISTORICAL_STATUS = {
  "bad-request": 400,
  "gateway/bad-request": 400,
  "session/title-invalid": 400,
  "workspace/name-conflict": 400,
  "subagent-unsupported": 400,
  "confirm-required": 400,
  "component-borrow-invalid": 400,
  "session/not-found": 404,
  "workspace/not-found": 404,
  "session-not-found": 404,
  "workspace-not-found": 404,
  "node-not-found": 404,
  "trash-not-found": 404,
  "component-not-installed": 404,
  "target-exists": 409,
  "session-active": 409,
  "session-corrupt": 409,
  "revision-conflict": 409,
  "tag-library-full": 409,
  "datadir-same": 409,
  "datadir-not-empty": 409,
  "migration-in-progress": 409,
  "reset-refused": 409,
  "component-busy": 409,
  "component-in-use": 409,
  "workspace/session-active": 409,
  "nothing-pending": 409,
  "ai/no-fields": 409,
  "nothing-to-apply": 409,
  "component-disk-full": 507,
  "disk-full": 507,
  "move-incomplete": 500,
  "move-rollback-failed": 500,
  "capability-missing": 501,
  "llm-unavailable": 501,
  "too-many": 413,
  "llm/MISSING_CREDENTIAL": 401,
  "llm/INVALID_CREDENTIAL": 401,
  "llm/AUTH": 401,
  "llm/RATE_LIMIT": 429,
  "llm/QUOTA": 429,
  "llm/ACCOUNT_QUOTA": 429,
  "llm/CONTEXT_WINDOW_EXCEEDED": 422,
  "llm/empty": 422,
  "llm/tool-only": 422,
  "llm/no-finish": 422,
  "nothing-to-summarize": 422,
  "ai/bad-answer": 422,
  "cross-site": 403,
  "unsupported-media-type": 415,
  "update-unreachable": 502,
  "open-failed": 502,
};

/**
 * A sidecar document that really runs the caller's mutation.
 *
 * The revision guard is the point: mutate(fn, expected) is where a stale writer
 * is refused, and a stub that skipped fn would also skip the route's own
 * validation. structuredClone keeps a failed mutation from half-applying, the
 * way the real document does.
 *
 * @param {Record<string, any>} initial
 */
function makeDocument(initial) {
  let current = { ...initial, revision: 1 };
  return {
    async read() {
      return current;
    },
    async mutate(fn, expected) {
      if (Number.isFinite(expected) && expected !== current.revision) {
        throw codedError("revision-conflict", "revision " + expected + " does not match " + current.revision);
      }
      const draft = structuredClone(current);
      const next = await fn(draft);
      current = { ...(next && typeof next === "object" ? next : draft), revision: current.revision + 1 };
      return current;
    },
  };
}

/**
 * What lib/sources/reader.js answers with, emptied out.
 *
 * The shape matters more than the emptiness: sessions is the live list (what
 * lib/index.js reads), view is the untrashed-plus-trashed view (what
 * lib/host/trash.js reads), and a stub missing either half is how a probe ends
 * up "proving" a route is broken when the route is fine.
 */
function emptySnapshot() {
  return {
    sessions: [],
    trashed: [],
    view: { sessions: [], live: [], trashed: [] },
    tree: { nodes: {}, shortcuts: {}, folders: {}, sessionPlacement: {}, quickAccess: {}, workspaceOrder: [] },
    registry: null,
    annotations: { notes: {}, library: [] },
    stats: { sessions: 0, workspaces: 0, folders: 0, trashed: 0 },
    scannedAt: 0,
  };
}

/**
 * A PluginApi with an empty, throwaway data directory behind it.
 *
 * Every read answers "nothing here" and every command is accepted, because the
 * question is not what the data means but what the dispatcher does with a body
 * it cannot use. The few stubs that are not trivial answer with the shape their
 * real counterpart answers with, so a route that reads .rows or .view off the
 * result is not tripped by the probe.
 *
 * dshHome goes through the same seam the host layer uses (lib/host/fsutil.js,
 * dshHomeOf), so nothing here reads the developer's own DSH home.
 */
function probeApi() {
  return {
    dataDir: DATA_DIR,
    paths: dataPaths(DATA_DIR),
    dshHome: () => DATA_DIR,
    migration: null,
    ctx: undefined,
    capabilities: () => ({ nativeReveal: false, component: false, detached: false }),
    reader: { snapshot: async () => emptySnapshot(), invalidate: async () => {} },
    documents: {
      tree: makeDocument({ nodes: {}, shortcuts: {}, folders: {}, sessionPlacement: {}, quickAccess: {}, workspaceOrder: [] }),
      annotations: makeDocument({ notes: {}, library: [] }),
      settings: makeDocument({}),
      summaries: makeDocument({ sessions: {} }),
      trash: makeDocument({ entries: {} }),
    },
    content: {
      open: async () => null,
      sync: async () => ({}),
      work: async () => ({}),
      state: () => ({ phase: "idle", entries: 0, bytes: 0, builtAt: 0 }),
      search: async () => ({ hits: [], total: 0, truncated: false }),
      rebuild: async () => ({}),
      clear: async () => ({}),
      cacheInfo: async () => ({ bytes: 0, entries: 0, builtAt: 0 }),
      flush: async () => {},
    },
    summarizer: {
      state: () => ({ running: false, queue: [], done: 0 }),
      catalog: async () => ({ models: [] }),
      start: async () => ({ started: 0 }),
      cancel: async () => ({ cancelled: 0 }),
      refresh: async () => ({}),
    },
    component: {
      status: async () => ({ phase: "absent", borrowed: null }),
      scan: async ({ home }) => ({ home, candidates: [], current: { phase: "absent" } }),
      install: async () => ({ phase: "absent" }),
      cancel: async () => ({}),
      remove: async () => ({}),
    },
    detached: {
      running: () => false,
      open: async () => ({ open: false, reason: "probe" }),
      close: async () => ({}),
      stop: async () => {},
    },
    theme: { snapshot: () => ({}), record: async () => ({}) },
    bridge: {
      // A property, not a method: lib/index.js reads api.bridge.cursor bare in
      // three places, and a function here would be serialised into the answer.
      cursor: 0,
      publish: () => {},
      listeners: () => [],
      since: () => [],
      subscribe: () => () => {},
    },
    statusBoard: { snapshot: () => ({ rows: [], at: 0 }), set: async () => ({}) },
    indexBuilder: { nudge: () => {}, resume: () => {}, stop: () => {}, rebuild: async () => ({}), busy: () => false },
    pendingDrafts: { arm: async () => ({ armed: false }), dispose: () => {} },
  };
}

/**
 * The response object lib/http.js writes into.
 *
 * Only the members the dispatcher and the routes actually touch, and end()
 * records the payload the way ServerResponse would.
 */
function fakeRes() {
  const chunks = [];
  const headers = {};
  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    flushHeaders() {
      res.headersSent = true;
    },
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      res.writableEnded = true;
    },
    on() {
      return res;
    },
    once() {
      return res;
    },
    removeListener() {
      return res;
    },
    headers,
    bodyText() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
  return res;
}

/**
 * A request that lib/http.js (readJsonBody) can walk.
 *
 * body: null is an empty request: the iterator yields nothing, which is the
 * shape the GUI sends for a command with no arguments.
 */
function fakeReq(url, method, body) {
  return {
    url,
    method,
    headers: { "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      if (typeof body === "string" && body.length > 0) yield Buffer.from(body, "utf8");
    },
  };
}

/**
 * One request through the real dispatcher.
 *
 * @param {string} routeKey e.g. "PATCH /folders/:id"
 * @param {{ body?: string | null, query?: string }} [options]
 * @returns {Promise<{ status: number, json: any, text: string, headers: Record<string, any> }>}
 */
async function callRoute(routeKey, options = {}) {
  const [method, pattern] = routeKey.split(" ");
  const path = pattern.replace(/:([A-Za-z]+)/g, () => "probe");
  const res = fakeRes();
  await handle(probeApi(), fakeReq(API_PREFIX + path + (options.query ?? ""), method, options.body ?? null), res);
  const text = res.bodyText();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // /ui* answers bytes, not JSON; the caller decides what that means.
  }
  return { status: res.statusCode, json, text, headers: res.headers };
}

/**
 * Assert one answer is the envelope lib/http.js defines, and that its status is
 * the one the table gives its own code.
 *
 * The second half is the whole point of the table: an answer whose status and
 * code disagree is a client that cannot tell "gone" from "I broke".
 *
 * @param {string} where what was called, for the failure message
 * @param {{ status: number, json: any, text: string }} answer
 */
function assertEnvelope(where, answer) {
  const { status, json } = answer;
  assert.ok(json !== null, where + ": the answer is not JSON: " + answer.text.slice(0, 80));
  assert.ok(Number.isInteger(status) && status >= 200 && status <= 599, where + ": status " + status);
  if (json.ok === true) {
    assert.deepEqual(Object.keys(json), ["ok", "result"], where + ": a success envelope is { ok, result }");
    assert.equal(status, 200, where + ": a success is answered 200, not " + status);
    return;
  }
  assert.equal(json.ok, false, where + ": ok must be true or false");
  assert.deepEqual(Object.keys(json).sort(), ["code", "error", "ok"], where + ": a failure envelope is { ok, error, code }");
  assert.equal(typeof json.code, "string", where + ": code must be a string");
  assert.ok(json.code.length > 0, where + ": code must not be empty");
  assert.equal(typeof json.error, "string", where + ": error must be a string, not an object");
  assert.equal(statusFor(json.code), status, where + ": " + json.code + " is answered " + status + ", the table says " + statusFor(json.code));
}

/** Every .js file under a directory, for the raise-site scan. */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("the table is complete, and index.js exports the table's own statusFor", () => {
  assert.equal(statusForFromIndex, statusFor, "lib/index.js must re-export the statusFor it imported, not wrap it");
  const codes = Object.keys(ERROR_CODES);
  assert.ok(codes.length >= 52, "the table has " + codes.length + " rows; the old switch named 52 codes, so rows went missing");
  for (const code of codes) {
    const row = ERROR_CODES[code];
    assert.equal(code, code.trim(), code + ": a row key must not be padded");
    assert.ok(Number.isInteger(row.status), code + ": status must be an integer");
    assert.ok(row.status >= 400 && row.status <= 599, code + ": " + row.status + " is not an error status");
    assert.equal(typeof row.zh, "string", code + ": zh must be a string");
    assert.ok(row.zh.trim().length > 0, code + ": a Chinese sentence is missing");
    assert.equal(typeof row.en, "string", code + ": en must be a string");
    assert.ok(row.en.trim().length > 0, code + ": an English sentence is missing");
    assert.notEqual(row.zh, row.en, code + ": the two languages must not be the same string");
    assert.equal(statusFor(code), row.status, code + ": statusFor does not read its own row");
  }
});

test("every status the old switch answered is still answered that way", () => {
  for (const [code, status] of Object.entries(HISTORICAL_STATUS)) {
    assert.equal(statusFor(code), status, code + ": the switch answered " + status + ", the table answers " + statusFor(code));
    assert.ok(ERROR_CODES[code], code + ": the code the dispatcher answers is missing from the table");
  }
});

test("a code nobody mapped is a server fault, never a guess", () => {
  for (const code of ["not-a-code", "llm/SOMETHING_NEW", "", "  ", "session/not-there"]) {
    assert.equal(statusFor(code), 500, JSON.stringify(code) + " must fall back to 500");
  }
  for (const nothing of [undefined, null, 42, {}, []]) {
    assert.equal(statusFor(nothing), 500, String(nothing) + " must fall back to 500");
  }
});

test("both spellings of one failure answer the same status", () => {
  const twins = [
    ["session/not-found", "session-not-found"],
    ["workspace/not-found", "workspace-not-found"],
  ];
  for (const [slashed, hyphenated] of twins) {
    assert.equal(statusFor(slashed), statusFor(hyphenated), slashed + " and " + hyphenated + " must agree");
    assert.equal(normalizeCode(slashed), normalizeCode(hyphenated), slashed + " and " + hyphenated + " must normalise together");
  }
  // The old switch knew the slashed spelling of a case a helper spells with a
  // hyphen; that gap is what answered 500 for a 404.
  assert.equal(statusFor("session/not-found"), 404);
  assert.equal(statusFor("session-not-found"), 404);
  // DSH's own layer upper-cases parts of its codes; a lookup must not care.
  assert.equal(statusFor("llm/MISSING_CREDENTIAL"), 401);
  assert.equal(statusFor("LLM/missing_credential"), 401);
  assert.equal(normalizeCode("Session/Not-Found"), "session-not-found");
  assert.equal(normalizeCode(""), "");
  assert.equal(normalizeCode(undefined), "");
});

test("messageFor speaks the language it was asked for, and falls back to the reason", () => {
  assert.equal(messageFor("disk-full"), ERROR_CODES["disk-full"].zh);
  assert.equal(messageFor("disk-full", "ignored", "en"), ERROR_CODES["disk-full"].en);
  // A known code wins over the host's own sentence: the table is the reviewed
  // wording, the fallback is whatever the throw site happened to say.
  assert.equal(messageFor("session-not-found", "no such session"), ERROR_CODES["session-not-found"].zh);
  // An unknown code still shows the specific reason instead of a generic line.
  assert.equal(messageFor("not-a-code", "session abc has no log"), "session abc has no log");
  assert.ok(messageFor("not-a-code").length > 0);
  assert.ok(messageFor("not-a-code", "", "en").length > 0);
});

test("every code a helper raises has a row", () => {
  const files = jsFiles(LIB);
  assert.ok(files.length >= 50, "the scan found " + files.length + " files; it is probably not reading lib/");
  /** @type {Map<string, string>} */
  const raised = new Map();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/codedError\(\s*"([^"]+)"/g)) raised.set(match[1], file);
    // The component manager marks some failures by assigning error.code instead
    // of throwing through codedError; those reach the dispatcher the same way
    // and need a row for the same reason.
    for (const match of text.matchAll(/\.code\s*=\s*"([a-z][a-z0-9-]*(?:\/[A-Za-z0-9_-]+)?)"/g)) raised.set(match[1], file);
  }
  assert.ok(raised.size >= 40, "the scan found " + raised.size + " codes; it is probably not matching anything");
  for (const [code, file] of raised) {
    assert.ok(ERROR_CODES[code], file.slice(LIB.length + 1) + " raises " + code + ", which has no row in lib/errors.js");
  }
});

test("send, ok and fail build one envelope shape", () => {
  const success = fakeRes();
  ok(success, { id: "x" });
  assert.equal(success.statusCode, 200);
  assert.equal(success.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(success.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(success.bodyText()), { ok: true, result: { id: "x" } });

  const failure = fakeRes();
  fail(failure, 409, "revision-conflict", "stale");
  assert.equal(failure.statusCode, 409);
  assert.equal(failure.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(failure.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(failure.bodyText()), { ok: false, error: "stale", code: "revision-conflict" });

  // send is the shape both of them are built from, and it must not invent keys.
  const raw = fakeRes();
  send(raw, 418, { ok: false, error: "tea", code: "bad-request" });
  assert.equal(raw.statusCode, 418);
  assert.deepEqual(JSON.parse(raw.bodyText()), { ok: false, error: "tea", code: "bad-request" });
});

/**
 * Routes the sweep does not call at all.
 *
 * @type {Map<string, string>}
 */
const NO_PROBE = new Map([
  ["GET /update", "checks GitHub for the latest release; test/update.test.mjs covers it without the network"],
  ["GET /bridge/events", "server-sent events: the answer stays open until the panel leaves, so a fake response would hang"],
]);

/**
 * Write routes that answer 2xx to a body they cannot use, and why that is right.
 *
 * Each of these treats "no arguments" as a complete request — a command, a
 * partial merge, or a batch whose empty tail is a no-op. Naming them here is the
 * contract: a route that answers 2xx to an empty body without a line in this
 * map is a route that guessed, and the sweep fails so its author has to say
 * which of the two it is.
 *
 * @type {Map<string, string>}
 */
const EMPTY_BODY_IS_A_REQUEST = new Map([
  ["PUT /settings", "a partial merge: an empty body changes nothing"],
  ["POST /summarize", "no ids means every session still missing a field"],
  ["POST /summarize/cancel", "a command: cancel whatever is running"],
  ["POST /search/index/rebuild", "a command: rebuild the whole index"],
  ["POST /search/index/clear", "a command: drop the whole index"],
  ["POST /cache/clear", "a command: clear the derived caches"],
  ["POST /trash/empty", "a command: empty the bin"],
  ["POST /release-notes/seen", "a command: record that this version's notes were shown"],
  ["POST /theme", "a record: nothing to change is nothing to write"],
  ["POST /restore", "an empty batch is a no-op on purpose: an id that vanished mid-click must not become a 400"],
  ["POST /purge", "an empty batch is a no-op, for the same reason as /restore"],
  ["POST /component/install", "no options means the default mirror"],
  ["POST /component/retry", "no options means retry with the options already recorded"],
  ["POST /component/cancel", "a command: cancel the download in flight"],
  ["POST /component/remove", "a command: remove the installed runtime"],
  ["POST /detached/close", "a command: close the window if one is open"],
  ["DELETE /tags/:tag", "the tag is in the path; removing one nobody uses is a no-op"],
  ["DELETE /summaries/:id", "the id is in the path; dropping a record that is gone is a no-op"],
]);

/** The three bodies every write route is asked to cope with. */
const BAD_BODIES = [
  { label: "empty body", text: null },
  { label: "unknown key", text: JSON.stringify({ __contract__: true }) },
  { label: "not even an object", text: JSON.stringify("nope") },
];

test("every write route answers a body it cannot use in the envelope", async () => {
  const keys = Object.keys(ROUTES).filter((key) => !key.startsWith("GET ") && !NO_PROBE.has(key));
  assert.ok(keys.length >= 50, "only " + keys.length + " write routes were found; the sweep is not seeing the table");
  for (const key of keys) {
    for (const body of BAD_BODIES) {
      const where = key + " [" + body.label + "]";
      const answer = await callRoute(key, { body: body.text });
      assertEnvelope(where, answer);
      if (answer.json.ok === true) {
        assert.ok(
          EMPTY_BODY_IS_A_REQUEST.has(key),
          where + ": answered 200 without being told what to do; either refuse it, or add it to EMPTY_BODY_IS_A_REQUEST with a reason",
        );
        continue;
      }
      // 501 capability-missing is the honest answer for a probe that mounts no
      // workspace or session controller: the route ran, looked for the feature
      // and reported that this build has none. Any other 5xx is a server fault.
      if (answer.json.code === "capability-missing") continue;
      assert.ok(answer.status < 500, where + ": a body the route cannot use is the client's mistake, answered " + answer.status + " (" + answer.json.code + ": " + answer.json.error + ")");
    }
  }
});

// Every route named in the map must still exist: a renamed route would otherwise
// leave a stale excuse behind that excuses nothing.
test("every exception names a route that is still in the table", () => {
  for (const key of EMPTY_BODY_IS_A_REQUEST.keys()) {
    assert.ok(ROUTES[key], key + " is excused in EMPTY_BODY_IS_A_REQUEST but is not a route any more");
  }
  for (const key of NO_PROBE.keys()) {
    assert.ok(ROUTES[key], key + " is skipped in NO_PROBE but is not a route any more");
  }
});

test("every read route answers a placeholder id without a server fault", async () => {
  const keys = Object.keys(ROUTES).filter((key) => key.startsWith("GET ") && !NO_PROBE.has(key));
  assert.ok(keys.length >= 20, "only " + keys.length + " read routes were found; the sweep is not seeing the table");
  for (const key of keys) {
    const answer = await callRoute(key);
    if (key.startsWith("GET /ui")) {
      // The panel's own assets are served as bytes, not through the envelope; a
      // JSON body here would mean the route fell back to send().
      assert.equal(answer.status, 200, key + ": an asset must be served");
      assert.ok(answer.headers["content-type"], key + ": an asset needs a content type");
      assert.equal(answer.headers["cache-control"], "no-store", key + ": an asset must not be cached");
      continue;
    }
    assertEnvelope(key, answer);
    assert.ok(answer.status < 500, key + ": status " + answer.status + " for a placeholder id");
  }
});

test("the route table is still the table clients were written against", () => {
  const keys = Object.keys(ROUTES);
  assert.ok(keys.length >= 83, "the table has " + keys.length + " routes; it had 83 when the contract was written");
  for (const key of keys) {
    const match = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(key);
    assert.ok(match, key + ": a route key is METHOD, a space, then /path");
  }
});
