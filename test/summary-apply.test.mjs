// The apply route is the only place the plugin writes into somebody else's
// document, and it has three different meanings (rename, append to the note,
// merge some tags). These tests drive the real route handler against in-memory
// sidecars, which is the only way to catch a wiring mistake that `node --check`
// cannot see (m02641).

import test from "node:test";
import assert from "node:assert/strict";

import { ROUTES } from "../lib/index.js";
import { normalizeSummaries } from "../lib/domain/summaries.js";

const apply = ROUTES["POST /summaries/:id/apply"];

/** A sidecar with the same mutate/read contract as lib/store/sidecar.js. */
function sidecar(initial) {
  let document = { revision: 1, ...initial };
  return {
    async read() {
      return structuredClone(document);
    },
    async mutate(mutator) {
      const draft = structuredClone(document);
      const next = await mutator(draft);
      const body = next && typeof next === "object" ? next : draft;
      document = { ...body, revision: (document.revision ?? 0) + 1 };
      return structuredClone(document);
    },
  };
}

/** An `api` just wide enough for this route. */
function makeApi(entry, initial = { sessions: {}, tags: [] }) {
  const summaries = sidecar({ sessions: entry ? { s1: entry } : {} });
  const annotations = sidecar(initial);
  return {
    api: {
      reader: { snapshot: async () => ({ sessions: [] }) },
      documents: { summaries, annotations },
    },
    summaries,
    annotations,
  };
}

const ENTRY = {
  title: "修复导出",
  description: "助手的话现在也会导出。",
  tags: ["导出", "会话"],
  at: 1,
  applied: { title: false, description: false, tags: false },
};

const call = (api, body) => apply(api, { params: { id: "s1" }, body });

test("a description is appended to the note the user wrote, never over it", async () => {
  const { api, annotations } = makeApi(ENTRY, { sessions: { s1: { tags: [], note: "我自己的备注", favorite: false, todo: false, updatedAt: null } }, tags: [] });
  const result = await call(api, { field: "description" });
  assert.equal(result.note, "我自己的备注\n\n助手的话现在也会导出。");
  const document = await annotations.read();
  assert.equal(document.sessions.s1.note, "我自己的备注\n\n助手的话现在也会导出。");
  const stored = normalizeSummaries(await api.documents.summaries.read());
  assert.equal(stored.sessions.s1.applied.description, true);
});

test("pressing 合并 twice does not paste the same paragraph in twice", async () => {
  const { api } = makeApi(ENTRY);
  await call(api, { field: "description" });
  const again = await call(api, { field: "description" });
  assert.equal(again.note, "助手的话现在也会导出。");
});

test("only the tags the user ticked are merged, and they join the library", async () => {
  const { api, annotations } = makeApi(ENTRY);
  const result = await call(api, { field: "tags", tags: ["会话"] });
  assert.deepEqual(result.tags, ["会话"]);
  const document = await annotations.read();
  assert.deepEqual(document.sessions.s1.tags, ["会话"]);
  // The library is what the next run is shown: a tag the user accepted has to
  // be in it, otherwise the model invents it again next time.
  assert.deepEqual(document.tags, ["会话"]);
  const stored = normalizeSummaries(await api.documents.summaries.read());
  assert.equal(stored.sessions.s1.applied.tags, true);
});

test("no selection means all of it, and a stale selection is refused", async () => {
  const { api } = makeApi(ENTRY);
  const all = await call(api, { field: "tags" });
  assert.deepEqual(all.tags, ["导出", "会话"]);

  const other = makeApi(ENTRY).api;
  await assert.rejects(() => call(other, { field: "tags", tags: ["别的"] }), (error) => error.code === "nothing-to-apply");
  await assert.rejects(() => call(other, { field: "tags", tags: [] }), (error) => error.code === "nothing-to-apply");
});

test("a field name the record does not carry is a bad request, not a silent apply", async () => {
  const { api } = makeApi(ENTRY);
  await assert.rejects(() => call(api, { field: "note" }), (error) => error.code === "bad-request");
  // A record with no description cannot have one applied.
  const bare = makeApi({ ...ENTRY, description: "", tags: [] }).api;
  await assert.rejects(() => call(bare, { field: "description" }), (error) => error.code === "nothing-to-apply");
  await assert.rejects(() => call(bare, { field: "tags" }), (error) => error.code === "nothing-to-apply");
});
