/**
 * Tests for "which sessions are live", as the kernel answers it.
 *
 *   node --test test/live-state.test.mjs
 *
 * The answer decides two things at once: the 进行中 badge and whether archive and
 * delete are refused. A false 进行中 is therefore worse than a missing one — it
 * locks a row that nobody is holding — which is the whole reason `ctx.sessions`
 * is no longer trusted here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { liveSessions } from "../lib/sources/live.js";

/** A context whose only service is the one under test. */
const contextWith = (services) => ({
  get: (name) => services[name],
});

const registryOf = (agents) => ({ list: () => agents });

test("the agent registry answers, running and idle split apart", () => {
  const ctx = contextWith({
    agents: registryOf([
      { id: "session-1", status: "running" },
      { id: "session-2", status: "idle" },
    ]),
  });
  const live = liveSessions(ctx);
  assert.equal(live.source, "agents");
  assert.deepEqual([...live.running], ["session-1"]);
  assert.deepEqual([...live.idle], ["session-2"]);
});

test("a session id is read off the agent, and off a nested session too", () => {
  const ctx = contextWith({
    agents: registryOf([
      // AgentRegistry hands out Agent instances, whose id *is* the session id.
      { id: "session-1", status: "running" },
      // Older shapes nested the session one level down; both are accepted.
      { session: { id: "session-2" }, status: "running" },
    ]),
  });
  const live = liveSessions(ctx);
  assert.equal(live.running.size, 2);
  assert.ok(live.running.has("session-2"));
});

test("a replaced agent keeps the session id, and the newest entry wins", () => {
  const ctx = contextWith({
    agents: registryOf([
      { id: "session-1", status: "running" },
      { id: "session-1", status: "idle" },
    ]),
  });
  const live = liveSessions(ctx);
  assert.equal(live.running.has("session-1"), false, "a finished turn is not running");
  assert.ok(live.idle.has("session-1"));
});

test("an agent without a readable status counts as idle, never as running", () => {
  const ctx = contextWith({ agents: registryOf([{ id: "session-1" }, { id: "session-2", status: "starting" }]) });
  const live = liveSessions(ctx);
  assert.equal(live.running.size, 0);
  assert.equal(live.idle.size, 2);
});

test("an agent with no id is skipped instead of being reported as an empty id", () => {
  const ctx = contextWith({ agents: registryOf([{ status: "running" }, { id: "", status: "running" }, { id: "session-1", status: "running" }]) });
  const live = liveSessions(ctx);
  assert.deepEqual([...live.running], ["session-1"]);
});

test("without the agent row, the session registry lists sessions but marks none running", () => {
  const ctx = contextWith({ sessions: { ids: ["session-1", "session-2"] } });
  const live = liveSessions(ctx);
  assert.equal(live.source, "sessions");
  assert.equal(live.running.size, 0, "a loaded session is not a running one");
  assert.deepEqual([...live.idle], ["session-1", "session-2"]);
});

test("the session registry is read in whichever shape it exposes", () => {
  const listed = contextWith({ sessions: { list: () => ["session-1", { id: "session-2" }] } });
  assert.deepEqual([...liveSessions(listed).idle], ["session-1", "session-2"]);
  const keyed = contextWith({ sessions: { ids: ["session-3"] } });
  assert.deepEqual([...liveSessions(keyed).idle], ["session-3"]);
});

test("no registry at all is answered, not thrown", () => {
  const live = liveSessions(contextWith({}));
  assert.equal(live.source, "none");
  assert.equal(live.running.size, 0);
  assert.equal(live.idle.size, 0);
});

test("a registry that throws degrades to nothing running", () => {
  const ctx = {
    get: (name) => {
      if (name === "agents") {
        return {
          list: () => {
            throw new Error("service disposed mid-read");
          },
        };
      }
      return undefined;
    },
  };
  const live = liveSessions(ctx);
  assert.equal(live.running.size, 0);
});

test("an accessor that throws everywhere is answered with an empty set", () => {
  const ctx = {
    get: () => {
      throw new Error("fiber torn down");
    },
  };
  const live = liveSessions(ctx);
  assert.equal(live.running.size, 0);
  assert.equal(live.source, "none");
});
