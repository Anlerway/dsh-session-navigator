/**
 * 会话内容 index — the host-side text search behind 搜索范围 › 会话内容.
 *
 * The index reads session logs, which is the most expensive thing this plugin
 * does: the point of these cases is the scheduling, not the matching. A request
 * must be able to advance the build by one slice and answer, an unchanged log
 * must not be read twice, and a log that cannot be read must cost one attempt.
 *
 * @module test/content-index
 */
import test from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createContentIndex } from "../lib/sources/content.js";
import { createIndexBuilder, searchSessionContent } from "../lib/index.js";

/** A session as the reader reports it: only these three fields matter. */
const session = (id, extra = {}) => ({
  id,
  logPath: "C:/logs/" + id + ".zstd",
  sizeBytes: 100,
  activityAt: 1_000,
  ...extra,
});

/**
 * An index over a scripted filesystem.
 *
 * `logs` maps path → array of turn texts, and `reads` records how often each
 * path was actually opened — the cache assertions are about that list.
 */
function fixture(logs, extra = {}) {
  const reads = [];
  const index = createContentIndex({
    budgetMs: 60_000,
    read: (path) => {
      reads.push(path);
      if (!(path in logs)) throw new Error("unreadable: " + path);
      return { events: logs[path] };
    },
    turns: (events) => events.map((text) => ({ text })),
    ...extra,
  });
  return { index, reads };
}

test("a session is planned, then built on demand", async () => {
  const { index } = fixture({ "C:/logs/a.zstd": ["alpha beta"] });
  assert.deepEqual(index.sync([session("a")]), { indexed: 0, total: 1, pending: 1 });
  assert.deepEqual(index.state(), { indexed: 0, total: 1, pending: 1 });
  // Nothing is searchable before the work is spent.
  assert.deepEqual(index.search("alpha"), []);
  await index.work();
  assert.deepEqual(index.state(), { indexed: 1, total: 1, pending: 0 });
  assert.equal(index.search("alpha")[0].id, "a");
});

test("work spends one slice at a time, so a request can answer early", async () => {
  const logs = {};
  for (const id of ["a", "b", "c"]) logs["C:/logs/" + id + ".zstd"] = [id + " text"];
  const { index } = fixture(logs);
  index.sync([session("a"), session("b"), session("c")]);
  await index.work(0);
  assert.deepEqual(index.state(), { indexed: 1, total: 3, pending: 2 }, "one slice, one session");
  await index.work(0);
  await index.work(0);
  assert.deepEqual(index.state(), { indexed: 3, total: 3, pending: 0 });
  // Asking again when the build is done is free.
  await index.work(0);
  assert.deepEqual(index.state(), { indexed: 3, total: 3, pending: 0 });
});

test("an unchanged log is never read twice; a changed one is read again", async () => {
  const { index, reads } = fixture({ "C:/logs/a.zstd": ["alpha"] });
  index.sync([session("a")]);
  await index.work();
  assert.equal(reads.length, 1);

  // Same size and timestamp: the log has not moved, so neither has the index.
  assert.deepEqual(index.sync([session("a")]), { indexed: 1, total: 1, pending: 0 });
  await index.work();
  assert.equal(reads.length, 1, "no second read");

  // A later write moves both, and the entry is rebuilt rather than trusted.
  index.sync([session("a", { sizeBytes: 200, activityAt: 2_000 })]);
  await index.work();
  assert.equal(reads.length, 2, "re-read after the log changed");
});

test("a vanished session leaves the index, not just the listing", async () => {
  const logs = { "C:/logs/a.zstd": ["alpha"], "C:/logs/b.zstd": ["beta"] };
  const { index } = fixture(logs);
  index.sync([session("a"), session("b")]);
  await index.work();
  assert.deepEqual(index.sync([session("b")]), { indexed: 1, total: 1, pending: 0 });
  assert.deepEqual(index.search("alpha"), [], "a trashed session stops matching");
  assert.equal(index.search("beta").length, 1);
});

test("two callers do not build the same logs twice", async () => {
  const logs = { "C:/logs/a.zstd": ["alpha"], "C:/logs/b.zstd": ["beta"] };
  const { index, reads } = fixture(logs);
  index.sync([session("a"), session("b")]);
  // The panel asks again on every poll; both calls join the same slice.
  await Promise.all([index.work(0), index.work(0)]);
  assert.deepEqual(index.state(), { indexed: 1, total: 2, pending: 1 });
  assert.equal(reads.length, 1, "one log, one read");
  await index.work();
  assert.deepEqual(index.state(), { indexed: 2, total: 2, pending: 0 });
  assert.equal(reads.length, 2);
});

test("an async read is awaited, not mistaken for an empty log", async () => {
  // The real reader is async. A promise used as a value still yields a valid
  // entry with no text, which looks exactly like "nothing matches" — so this
  // case exists to fail loudly if the await is ever dropped again.
  const index = createContentIndex({
    budgetMs: 60_000,
    read: async () => ({ events: ["a promise is not a log"] }),
    turns: (events) => events.map((text) => ({ text })),
  });
  index.sync([session("a")]);
  await index.work();
  assert.deepEqual(index.state(), { indexed: 1, total: 1, pending: 0 });
  assert.equal(index.search("promise").length, 1);
});

test("a log that cannot be read costs one attempt, not one per search", async () => {
  const { index, reads } = fixture({});
  index.sync([session("gone")]);
  await index.work();
  assert.deepEqual(index.state(), { indexed: 1, total: 1, pending: 0 });
  assert.deepEqual(index.search("anything"), [], "no text, no match");
  index.sync([session("gone")]);
  await index.work();
  assert.equal(reads.length, 1, "the failure is cached under the same signal");
});

test("search is case-insensitive and counts every occurrence", async () => {
  const { index } = fixture({ "C:/logs/a.zstd": ["Alpha and ALPHA and alpha"] });
  index.sync([session("a")]);
  await index.work();
  const [hit] = index.search("alpha");
  assert.equal(hit.count, 3);
  assert.match(hit.snippet, /alpha/i);
});

test("hits come back most-mentioned first, and an empty needle matches nothing", async () => {
  const logs = {
    "C:/logs/a.zstd": ["zstd once"],
    "C:/logs/b.zstd": ["zstd", "zstd", "zstd"],
  };
  const { index } = fixture(logs);
  index.sync([session("a"), session("b")]);
  await index.work();
  assert.deepEqual(index.search("zstd").map((hit) => hit.id), ["b", "a"]);
  assert.deepEqual(index.search("   "), [], "whitespace is not a search");
  assert.deepEqual(index.search(""), []);
});

test("the snippet is one flat line, with the match inside it", async () => {
  const long = "x".repeat(200) + " needle " + "y".repeat(200);
  const { index } = fixture({ "C:/logs/a.zstd": ["first line\n" + long] });
  index.sync([session("a")]);
  await index.work();
  const [hit] = index.search("needle");
  assert.match(hit.snippet, /needle/);
  assert.ok(!hit.snippet.includes("\n"), "a newline would break the row");
  assert.ok(hit.snippet.startsWith("…"), "cut at the front");
  assert.ok(hit.snippet.endsWith("…"), "and at the back");
  assert.ok(hit.snippet.length < long.length, "the snippet is shorter than the text");
});

/** The same scripted filesystem, as the options an index takes. */
function scripted(logs) {
  return {
    read: (path) => {
      if (!(path in logs)) throw new Error("unreadable: " + path);
      return { events: logs[path] };
    },
    turns: (events) => events.map((text) => ({ text })),
  };
}

/** A plugin api over a fixed session list: what the route is handed. */
function routeFixture(logs) {
  const { index, reads } = fixture(logs);
  const sessions = Object.keys(logs).map((path) => session(path.split("/").pop().replace(".zstd", "")));
  return { api: { reader: { snapshot: async () => ({ sessions }) }, content: index }, reads };
}

test("the route trims the needle and echoes it back", async () => {
  const { api } = routeFixture({ "C:/logs/a.zstd": ["alpha beta"] });
  const answer = await searchSessionContent(api, "  alpha  ");
  assert.equal(answer.query, "alpha");
  assert.deepEqual(answer.hits.map((hit) => hit.id), ["a"]);
  assert.equal(answer.ready, true);
  assert.deepEqual({ indexed: answer.indexed, total: answer.total }, { indexed: 1, total: 1 });
});

test("an empty needle reports the index without spending it", async () => {
  const { api, reads } = routeFixture({ "C:/logs/a.zstd": ["alpha"] });
  const answer = await searchSessionContent(api, "");
  assert.deepEqual(answer.hits, []);
  assert.equal(answer.ready, false, "nothing is built yet");
  assert.deepEqual({ indexed: answer.indexed, total: answer.total }, { indexed: 0, total: 1 });
  assert.equal(reads.length, 0, "planning does not read a log");
});

test("a cold index answers partially and finishes on the next request", async () => {
  const logs = { "C:/logs/a.zstd": ["alpha"], "C:/logs/b.zstd": ["alpha too"] };
  // budgetMs: 0 — every call spends exactly one log, which is what a 700 ms
  // slice looks like from the outside when the logs are large.
  const api = {
    reader: { snapshot: async () => ({ sessions: [session("a"), session("b")] }) },
    content: createContentIndex({ ...scripted(logs), budgetMs: 0 }),
  };
  const first = await searchSessionContent(api, "alpha");
  assert.equal(first.ready, false, "one slice per request");
  assert.deepEqual({ indexed: first.indexed, total: first.total }, { indexed: 1, total: 2 });
  assert.deepEqual(first.hits.map((hit) => hit.id), ["a"], "the built half already answers");
  const second = await searchSessionContent(api, "alpha");
  assert.equal(second.ready, true);
  assert.deepEqual(second.hits.map((hit) => hit.id).sort(), ["a", "b"]);
});

test("a missing parameter is not a search", async () => {
  const { api, reads } = routeFixture({ "C:/logs/a.zstd": ["alpha"] });
  const answer = await searchSessionContent(api, undefined);
  assert.equal(answer.query, "");
  assert.deepEqual(answer.hits, []);
  assert.equal(reads.length, 0);
});

/** A real directory for the cache file: writeAtomic renames into tmpDir. */
async function cacheStore() {
  const root = await mkdtemp(join(tmpdir(), "se-content-"));
  return { root, store: { path: join(root, "content-index.v1.json"), tmpDir: join(root, ".tmp") } };
}

/** One log, one turn: enough to tell "restored" from "read". */
const cachedLogs = { "C:/logs/a.zstd": ["alpha beta"] };

test("the cache is written, and a restart answers from it without reading a log", async () => {
  const { root, store } = await cacheStore();
  try {
    const first = fixture(cachedLogs, { store });
    await first.index.open();
    first.index.sync([session("a")]);
    await first.index.work();
    assert.equal(first.reads.length, 1);
    const written = JSON.parse(await readFile(store.path, "utf8"));
    assert.equal(written.version, 1);
    assert.match(written.sessions.a.text, /beta/);

    const second = fixture(cachedLogs, { store });
    await second.index.open();
    assert.deepEqual(second.index.sync([session("a")]), { indexed: 1, total: 1, pending: 0 });
    await second.index.work();
    assert.equal(second.reads.length, 0, "the cache answered, the log was not read");
    assert.equal(second.index.search("beta")[0].id, "a");
    assert.equal(second.index.state().indexed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed log invalidates its cached entry instead of trusting it", async () => {
  const { root, store } = await cacheStore();
  try {
    const first = fixture(cachedLogs, { store });
    await first.index.open();
    first.index.sync([session("a")]);
    await first.index.work();

    const second = fixture(cachedLogs, { store });
    await second.index.open();
    second.index.sync([session("a", { sizeBytes: 200, activityAt: 2_000 })]);
    assert.equal(second.index.state().pending, 1, "the entry is queued again");
    await second.index.work();
    assert.equal(second.reads.length, 1, "re-read, not trusted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with the cache switched off nothing is written, and nothing is restored", async () => {
  const { root, store } = await cacheStore();
  try {
    const off = fixture(cachedLogs, { store, cacheEnabled: () => false });
    await off.index.open();
    off.index.sync([session("a")]);
    await off.index.work();
    const info = await off.index.cacheInfo();
    assert.equal(info.enabled, false);
    assert.equal(info.exists, false, "no file on disk");
    assert.deepEqual(off.index.search("beta").map((hit) => hit.id), ["a"], "search still works");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clear() deletes the file and reports the bytes it freed", async () => {
  const { root, store } = await cacheStore();
  try {
    const { index } = fixture(cachedLogs, { store });
    await index.open();
    index.sync([session("a")]);
    await index.work();
    const before = await index.cacheInfo();
    assert.equal(before.exists, true);
    assert.ok(before.bytes > 0);
    assert.equal(before.sessions, 1);

    const cleared = await index.clear();
    assert.ok(cleared.freedBytes > 0);
    assert.deepEqual(index.state(), { indexed: 0, total: 0, pending: 0 });
    assert.equal((await index.cacheInfo()).exists, false);
    // And the deleted index is not resurrected by the next build's flush.
    await index.work();
    assert.equal((await index.cacheInfo()).exists, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cache file from another build is ignored, not migrated", async () => {
  const { root, store } = await cacheStore();
  try {
    await writeFile(
      store.path,
      JSON.stringify({ version: 99, sessions: { a: { sig: "x", text: "old" } } }),
      "utf8",
    );
    const { index, reads } = fixture(cachedLogs, { store });
    await index.open();
    assert.equal(index.sync([session("a")]).pending, 1, "nothing was restored");
    assert.deepEqual(index.search("old"), []);
    await index.work();
    assert.equal(reads.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cache that cannot be written still answers from memory", async () => {
  const { root } = await cacheStore();
  try {
    // tmpDir under a regular file: mkdir throws ENOTDIR, and the flush reports.
    const blocker = join(root, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const store = { path: join(root, "index.json"), tmpDir: join(blocker, ".tmp") };
    const { index } = fixture(cachedLogs, { store });
    await index.open();
    index.sync([session("a")]);
    const after = await index.work();
    assert.equal(after.pending, 0);
    assert.equal(index.search("beta")[0].id, "a", "the search is unaffected");
    const failed = await index.flush();
    assert.equal(failed.written, false);
    assert.ok(failed.error, "the failure is reported, not thrown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A builder over two logs, with the idle switch under the test's control. */
function builderFixture(idle) {
  const logs = { "C:/logs/a.zstd": ["alpha"], "C:/logs/b.zstd": ["alpha too"] };
  const { index, reads } = fixture(logs);
  let idleFlag = idle;
  const api = {
    documents: { settings: { read: async () => ({ search: { indexIdle: idleFlag } }) } },
    reader: { snapshot: async () => ({ sessions: [session("a"), session("b")] }) },
    content: index,
  };
  return { api, reads, allow: (value) => { idleFlag = value; } };
}

const settleFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the idle build stays quiet while the setting is off", async () => {
  const { api, reads } = builderFixture(false);
  const builder = createIndexBuilder({ idleDelayMs: 1, idleSliceMs: 1_000 });
  try {
    builder.nudge(api);
    await settleFor(40);
    assert.equal(reads.length, 0, "no log was opened");
  } finally {
    builder.stop();
  }
});

test("the idle build drains the queue in slices once it is allowed", async () => {
  const { api, reads } = builderFixture(true);
  const builder = createIndexBuilder({ idleDelayMs: 1, idleSliceMs: 1_000 });
  try {
    builder.nudge(api);
    // The queue starts empty and fills when the first slice runs, so wait on the
    // reads rather than on pending.
    for (let i = 0; i < 60 && reads.length < 2; i += 1) await settleFor(10);
    assert.equal(reads.length, 2);
    assert.equal(api.content.state().pending, 0);
  } finally {
    builder.stop();
  }
});

test("删除缓存 stops the build, and resume starts it again", async () => {
  const { api, reads } = builderFixture(true);
  const builder = createIndexBuilder({ idleDelayMs: 1, idleSliceMs: 1_000 });
  try {
    builder.stop();
    builder.nudge(api);
    await settleFor(30);
    assert.equal(reads.length, 0, "a stopped builder stays quiet");

    builder.resume(api);
    for (let i = 0; i < 60 && reads.length < 2; i += 1) await settleFor(10);
    assert.equal(reads.length, 2);
    assert.equal(api.content.state().pending, 0);
  } finally {
    builder.stop();
  }
});
