/**
 * Tests for POST /component/install — the two shapes of "get me a runtime".
 *
 *   node --test test/component-install.test.mjs
 *
 * A download names a mirror (or asks for the default one); borrowing names a
 * runtime another plugin already installed, which /component/scan found. Both
 * end in the same state machine, so the route is one door: it has to pass both
 * through unharmed, and it has to refuse everything else instead of quietly
 * starting a 150 MB download for a body it did not understand.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ROUTES } from "../lib/index.js";

const install = ROUTES["POST /component/install"];
const retry = ROUTES["POST /component/retry"];

/** An api whose component manager records what the route handed it. */
function fakeApi() {
  const calls = [];
  return {
    calls,
    api: {
      component: {
        install: async (input) => {
          calls.push(input);
          return { phase: "downloading" };
        },
      },
    },
  };
}

async function rejects(route, body, pattern) {
  const { api, calls } = fakeApi();
  await assert.rejects(
    () => route(api, { body }),
    (error) => {
      assert.equal(error.code, "bad-request");
      assert.match(error.message, pattern);
      return true;
    },
  );
  assert.equal(calls.length, 0, "a refused body never reaches the manager");
}

test("a download passes its source through to the manager", async () => {
  for (const source of ["mirror", "github"]) {
    const { api, calls } = fakeApi();
    await install(api, { body: { source } });
    assert.deepEqual(calls, [{ source }]);
  }
  const { api, calls } = fakeApi();
  await install(api, { body: {} });
  assert.deepEqual(calls, [{}], "an empty body asks for the default mirror");
  await install(api, {});
  assert.deepEqual(calls, [{}, {}], "no body at all is the same request");
});

test("borrowing passes the runtime path through to the manager", async () => {
  const { api, calls } = fakeApi();
  const borrowed = "C:\\Users\\me\\.dsh\\profiles\\web\\node_modules\\electron";
  await install(api, { body: { borrowed } });
  assert.deepEqual(calls, [{ borrowed }]);
});

test("a key the route does not know is refused, not ignored", async () => {
  // A mirror override was never part of this contract: the list lives in
  // lib/component/layout.js. Sending one used to start the default download.
  await rejects(install, { mirror: "http://127.0.0.1:9/electron/" }, /unknown install option: mirror/);
  await rejects(install, { source: "mirror", borrowed: "C:/x", extra: 1 }, /unknown install option: extra/);
});

test("a value the route cannot use is refused with the reason", async () => {
  await rejects(install, { source: "ftp" }, /unknown install source: ftp/);
  await rejects(install, { borrowed: "" }, /borrowed must be a runtime path/);
  await rejects(install, { borrowed: 42 }, /borrowed must be a runtime path/);
});

test("retry takes the same body as install", async () => {
  const { api, calls } = fakeApi();
  await retry(api, { body: { source: "github" } });
  assert.deepEqual(calls, [{ source: "github" }]);
});
