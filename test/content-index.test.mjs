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

import { createContentIndex } from "../lib/sources/content.js";
import { searchSessionContent } from "../lib/index.js";

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
function fixture(logs) {
  const reads = [];
  const index = createContentIndex({
    budgetMs: 60_000,
    read: (path) => {
      reads.push(path);
      if (!(path in logs)) throw new Error("unreadable: " + path);
      return { events: logs[path] };
    },
    turns: (events) => events.map((text) => ({ text })),
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
