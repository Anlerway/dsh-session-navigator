# `src/client/`：`lib/client.js` 的源

`lib/client.js` 由这个目录拼出来，不再手改。构建只有这几条：

```bash
node scripts/build-client.mjs            # 写 lib/client.js
node scripts/build-client.mjs --check    # 只比对，漂移就退 1
node scripts/build-client.mjs --list     # 分片表：顺序、行数、字节
```

`manifest.json` 的数组顺序就是拼接顺序。构建脚本除此之外只做一件事：在产物最前面
加上一行 `// GENERATED FILE — …` 标记（它不长在任何分片里，免得有人顺手删掉）。没有包装、没有转换、没有 import，所以产物恒等于
分片之和，能改的地方只有一处。

## 为什么是分片，不是模块

模块加载器只给我们一个 `factory`（见 `docs/architecture.md` §7.3），没有模块系统可拆。
所以这里的分片是**同一份文件的字节区间**，不是模块：任何"让每个分片各自可解析"的做法都要
往产物里加东西，而产物的字节是第一约束。**唯一能被解析的单元是拼接后的 `lib/client.js`**；
单独打开一个分片看到的是半截函数体，那是正常的。

`docs/architecture.md` §7.3 写着"不要在整理代码时拆它"。那条规则针对的是为了好看而拆；这次拆分
一个字节都没动（见下面的逐字节政策），产物仍然是那一个单文件。

## 切点规则

只在整条语句之间切，两种深度：

- **深度 3**，工厂体的语句边界。所有 `    // ── 分区名 ────` banner 都在这一层，切点落在 banner 行之前。
- **深度 4**，`function Panel()` 的函数体内。`Panel` 是一个约 3 900 行的函数，不切它就没法满足
  单分片 ≤ 2 000 行；这样的切点有 4 处，都在函数体里的 `      // ── 小节 ────` banner 之前，也就是
  `15-panel-mutations-and-bin.js`、`16-panel-native-ops-and-clipboard.js`、
  `17-panel-shortcuts-pins-export.js`、`18-panel-mount-and-sidebar.js` 这四个文件的开头。

判据（一次性切分脚本执行时自证过；以后改分片不需要重跑）：切点行的起始嵌套深度是 3 或 4，
且上一行的最后一个有效字符是 `}`、`{` 或 `;`。这条判据排除掉"切在表达式中间 / 字符串里 /
模板字符串里 / 正则里"的所有情况。

## 改动的顺序

1. 改分片，**不要改 `lib/client.js`**（它头一行就写着这句话，改了下一次构建就没了）；
2. `node scripts/build-client.mjs`；
3. `node --test "test/*.test.mjs"` 与 `node test/render-smoke.mjs`；
4. 产物不进仓库，所以没有"提交前必须重建"这一步；但如果你要直接跑 `node --test`，
   先确认磁盘上的 `lib/client.js` 跟得上分片：`node scripts/build-client.mjs --check`。
   它失败时会打印第一个差异字节，那通常就是你漏掉的那次重建。

新增分片：文件放进本目录，再按位置写进 `manifest.json`。构建脚本会拒绝"目录里有、manifest 里
没有"的分片——这种漂移不会让任何测试变红，只能靠这道闸。

## 逐字节政策

第一次拆分（2026-11-06）的产物与拆分前的 `lib/client.js` **逐字节相同**：
`sha256 d3f97089ad47ef8ad06bc0ac18fdc2aa24b2461394e24ed034ee2732c38bb39e`，16 854 行 / 818 389 字节。
唯一允许的变化是构建脚本加的那行 `// GENERATED FILE`：加完是 16 855 行 / 818 495 字节，
`sha256 c68f45fef1b699638d0243a5c29055bebc5a38e840eabef2031c5f2e44a6b852`。功能一行没动，
所以"拆分是对的"这件事由两条硬证据一起担保：`cmp` 相同，以及 781 个测试全绿。
