/**
 * check-docs — the count check has to be able to fail.
 *
 * A gate that silently matches nothing is worse than no gate: it prints its
 * clean line and everybody stops looking. So these cases feed the probe one
 * sentence that is stale and one that is true, and expect the first to be
 * reported and the second to pass. The counts come from the repository, so the
 * true sentence stays true as the suite grows.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { counts, fixQuantities, numeralText, numeralValue, quantityHits } from "../scripts/check-docs.mjs";

/** What the repository reports right now. */
const now = counts();

test("汉字 and digits are the same claim", () => {
  assert.equal(numeralValue("七十二"), 72);
  assert.equal(numeralValue("十"), 10);
  assert.equal(numeralValue("一百零三"), 103);
  assert.equal(numeralValue("83"), 83);
  assert.ok(Number.isNaN(numeralValue("许多")));
});

test("a stale count is caught in either spelling", () => {
  // 72 is what the index claimed for two releases; whatever the true count is
  // now, a sentence that says 72 has to be reported.
  const han = [];
  quantityHits("| [testing.md](testing.md) | 七十二个测试文件各钉住什么 |", han);
  assert.equal(han.length, 1);
  assert.equal(han[0].name, "test files");
  assert.equal(han[0].actual, now.testFiles);

  const digits = [];
  quantityHits("test/                 72 个测试文件 + render-smoke", digits);
  assert.equal(digits.length, 1);

  // Each shape has to be able to fire on its own: a rule that never matches
  // is the failure this file exists for, so every pattern gets a stale line.
  const shapes = ["99 条 HTTP 路由", "99 条路由的键", "99 个分片", "99 个错误码"];
  for (const shape of shapes) {
    const found = [];
    quantityHits(shape, found);
    assert.equal(found.length, 1, shape + " has to be reported");
  }
});

test("a sentence that matches the repository passes", () => {
  const line = `| ${numeralText(now.testFiles, "1")} 个测试文件 | ${now.fragments} 个分片 |`;
  const rest = `${now.routes} 条 HTTP 路由，${now.codes} 个错误码`;
  const found = [];
  quantityHits(line, found);
  quantityHits(rest, found);
  assert.deepEqual(found, []);
});

test("a subset count is not a total and stays alone", () => {
  const found = [];
  quantityHits("**九条路由不写信封**，它们自己接管响应。", found);
  assert.deepEqual(found, []);
});

test("--fix keeps the style the sentence was written in", () => {
  const han = fixQuantities("| 七十二个测试文件 |");
  assert.ok(han.includes(numeralText(now.testFiles, "七十二") + "个测试文件"));
  assert.equal(fixQuantities("72 个测试文件"), String(now.testFiles) + " 个测试文件");
});
