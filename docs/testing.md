# 测试

没有构建步骤，没有打包器，没有任何东西对 `lib/client.js` 做类型检查。所以测试是唯一的安全网，
它的形状也就跟着这个事实长：**纯规则用断言钉死，UI 用真实渲染跑一遍**。

```bash
npm test                 # node --test test/*.test.mjs
npm run test:render      # node test/render-smoke.mjs
```

单个文件：`node --test test/tree.test.mjs`。

测试全部用 `node:test` + `node:assert`，没有第三方测试框架、没有 DOM 实现依赖——
`render-smoke` 自带一个极小的假 document。

## 1. 四十一个测试文件，各自钉住什么

| 文件 | 行数 | 钉住的东西 |
|---|---|---|
| `test/tree.test.mjs` | 580 | 树投影的规则 R1–R5：嵌套、计数、降级、环、`sessionHome` |
| `test/tree-mirror.test.mjs` | 178 | 客户端只持有**遍历**、不持有**规则**——同一问题在两处必须同答案 |
| `test/sessions.test.mjs` | 229 | 合并视图：一个会话"是什么"的唯一判定处 |
| `test/store.test.mjs` | 422 | 侧车存储、原子写、revision、损坏隔离，以及改它的两个规则模块 |
| `test/revision.test.mjs` | 183 | 乐观锁的两端：侧车拒绝过期写，HTTP 层把 409 送到客户端 |
| `test/shortcuts.test.mjs` | 159 | 快捷方式永不移动目标；主题 store 的往返 |
| `test/flags.test.mjs` | 183 | 收藏/待办标记 → 快捷方式的一次性迁移：幂等、写失败先留旧标记、过期标记不中断启动 |
| `test/theme.test.mjs` | 104 | 主题 store 只交出窗口用的 token，且拒绝注入 |
| `test/theme-report.test.mjs` | 132 | 面板**上报**的那一半：DSH 把调色板声明在 `body` 上、值是 `var()` 引用 |
| `test/bridge.test.mjs` | 143 | 总线的边界：容量、30 秒时效、游标、坏订阅者 |
| `test/settings.test.mjs` | 293 | 设置文档的默认值、合并、归一化；日期格式、大小单位、搜索索引的开关都是封闭词表。旧文档里的 `search.indexCache` 作为未知键被丢弃，不生效 |
| `test/settings-page.test.mjs` | 749 | 设置页真实渲染：打开方式、搜索索引组（**只剩「空闲时自动建立」一个开关**、进度、重建/删除、失败文案）、「关于」组、危险操作组（DELETE 才亮红按钮）、数据目录、显示格式、写请求的 body |
| `test/display-format.test.mjs` | 98 | 两种日期格式与两种大小单位真正打印出来的样子：距今时间只走分钟 / 小时 / 天三档（不出现月、年、「昨天」），固定 KB 不换单位 |
| `test/session-state.test.mjs` | 117 | DSH 自己的界面读的那一个布尔集合 |
| `test/subagents.test.mjs` | 80 | 子智能体绑定四问；fork 带 `parentSession` 但是独立会话 |
| `test/trash.test.mjs` | 425 | 回收站：删除、恢复阶梯、清空、对账 |
| `test/move.test.mjs` | 523 | 跨 workspace 移动/复制的三件事一个事务 |
| `test/datadir.test.mjs` | 405 | 数据目录迁移：预检、七步、回滚、`.location` |
| `test/component.test.mjs` | 369 | 组件状态机：单飞锁、复用、校验、pending 清扫 |
| `test/export.test.mjs` | 296 | 会话日志 → Markdown / JSONL：真实形状（`time`、`data.message.content`、独立 `tool/call` 事件、`source.kind`）才算数——助手回复与工具调用曾经因为读错字段整类消失；注入上下文与系统提示不进正文；压缩摘要与被替换片段**只报告、不丢弃** |
| `test/detached-window.test.mjs` | 561 | 独立窗口的页面、路由、冒充 DSH 的 shim，以及 `?lang=` 决定的那一半文案 |
| `test/client-launch.test.mjs` | 595 | 两个入口对着 stub 宿主跑；两条"线上才炸"的路径 |
| `test/row-rename.test.mjs` | 185 | 列表行必须打开自己的重命名编辑器，而不是别人的 |
| `test/row-rail.test.mjs` | 169 | 子会话引导线的几何：必须落在上面那个折叠箭头的中心（深度 0 与非 0 是两条式子） |
| `test/list-containers.test.mjs` | 211 | 列表里哪些容器行该出现：搜索放宽到整棵树，筛选变成「含命中」的结果视图；「会话名」关掉后文件夹只能靠装着命中进来；「当前目录」时放宽整棵树这件事也不做 |
| `test/content-index.test.mjs` | 483 | 会话内容索引：按 `path|size|activityAt` 失效、逐份让出事件循环、两个 `work()` 只读一份、异步读必须 await、命中数与片段；**只索引用户与助手的文字**（真实日志形状：工具输出、注入上下文都不该被搜到）；磁盘缓存**传了 store 就写**（没有开关）、写盘后重启不再读日志、坏版本与写不进去都不阻断搜索、没给 store 就只在内存里；空闲构建器只在开关打开时动手 |
| `test/search-scope.test.mjs` | 307 | 搜索范围的**位置**（所有位置 / 当前目录）与四个字段：默认三项且位置为所有位置、会话内容只看 host 命中、搜索缺省是整库范围、选了当前目录才收窄、弹窗把位置放在字段之上、「搜索索引设置」一键跳到设置页、面板确实把范围传给了列表 |
| `test/marquee.test.mjs` | 519 | 鼠标框选：矩形归一化（反向拖也成立）、任何重叠都算命中而仅相邻不算、零面积等于点击（什么都不选）、集合没变不重报、按在控件上不起框、**没选中的行是表面（起框）而已选中的行留给自己拖**（`rowDraggable`）、没有复选框的行不进集合、ctrl 是并集、靠近边缘自动滚动且到顶就停、右键不起框也不会被当成清空、被调用方中途停掉不算点击、**列表滚动后不靠 mousemove 也要重算命中**、**起始点钉在行上而不是屏幕上（滚一格框就跟着长高，滚两格不重复累加）**、**祖先把面板推走后框仍贴着指针**（每帧重读 pane 矩形） |
| `test/double-press.test.mjs` | 48 | 双击时限：同一行两次按下都在 `DOUBLE_CLICK_MS` 内才算、慢一拍就是两次单击（而且那次慢按成为新的一对的开始）、换一行不配对、一次双击用掉这一对所以第三下重新开始、没有名字的目标永远不算 |
| `test/drag-set.test.mjs` | 67 | 多选拖动的那一次拆分：容器与会话按树和索引分流而不是按 id 前缀、陌生 id 丢掉而不是猜、重复 id 只走一次、容器永远不会被当会话、没有索引时非容器都算会话、空集拆成空集 |
| `test/quick-access.test.mjs` | 81 | 快速访问是一条序列：只有真实容器能当书签、整条一起写、陌生 id 跳过、没动过的书签保留原位 |
| `test/filter-dialog.test.mjs` | 115 | 筛选对话框的两个出口：重置还要按应用，取消是一步；没东西可取消时它不存在 |
| `test/heads.test.mjs` | 109 | 会话 header 扫描：换过格式版本的日志仍找得到、同 id 只出一份、无日志目录跳过 |
| `test/logfacts.test.mjs` | 168 | 空白会话 / 已中断：读日志两端的两个事实，以及只读头尾时的窗口边界 |
| `test/annotations.test.mjs` | 32 | 注解 id 守卫：`__proto__` / `constructor` / `prototype` 不能变成幻影条目 |
| `test/reveal.test.mjs` | 237 | reveal 白名单：只开自己列出来的路径（UNC 路径是凭据泄漏，不是便利） |
| `test/update.test.mjs` | 135 | 更新检查：数字段比较、release 解析、5 分钟缓存、失败码而不是假"已是最新" |
| `test/about.test.mjs` | 236 | 链接白名单与降级链，以及缓存清理只清自己的（quarantine 与会话不动，组件在装就跳过） |
| `test/locale-parity.test.mjs` | 88 | 中英两份字典键集合一致、占位符一致、英文标签放得下；设置页的 token 块必须自带 `--sm-danger` |
| `test/panel-copy.test.mjs` | 189 | 面板每一句中文都有英文对照：字典覆盖全部 `T()`、没有裸中文残留（注释与样式表除外）、占位符不丢；固定目录与默认工作区也走字典；shim 同理（例外是 `L()`） |
| `test/reset.test.mjs` | 208 | 清除数据：一个字都没动之前先验 `DELETE`、四份侧车与回收站本体一起删、组件与数据目录本身留下、迁移路径写回 |
| `test/render-smoke.mjs` | 1274 | 每个组件真实渲染一次（不是 `node --test` 的一部分）；框选那窗 `.selrect` 必须在树里、空白处按下才起框；没选中的会话/文件夹/工作区行 `draggable` 必须是 false，选中或勾选后仍是 true；真起一次拖动后，勾选集（会话与容器两个半边）必须原样交到落点，浏览器读不到 `DataTransfer` 时仍从载荷里答；双击打开落在**第二次按下**上（一次按下只能选中） |

## 2. 为什么是这些

**规则和 IO 分开测。** `lib/domain/*` 全是纯函数，可以脱离内核和文件系统断言；
`lib/host/*` 才碰磁盘，用临时目录。`test/tree.test.mjs` 的头注释说得很直接：
树投影是 P1 里唯一"编码规则而不是 IO"的部分，所以它是唯一值得用断言钉死的部分。

**"三份规则"是被测试记住的教训。** `test/tree-mirror.test.mjs` 存在的原因是曾经有三份
"节点能去哪"的规则（`lib/domain/tree.js`、`lib/client.js`、已删除的静态壳），它们会漂移。
现在客户端只允许持有遍历（子树、父链），任何决策表都必须来自 host 算好的字段。

**线上才炸的东西单独钉。** `test/client-launch.test.mjs` 的头注释写明：这里钉的两件事
都是"在现场炸的，不是在测试里炸的"。比如独立弹窗模式下双击窗口里的会话——`bridgeActions`
为 `null` 时请求会静默消失，因为面板根本没挂载。这类 bug 只有对着 stub 宿主跑一遍入口才会露出来。

**UI 也要真渲染。** `render-smoke.mjs` 对每个组件渲染一次，用假的 hooks 返回值。
`test/row-rename.test.mjs` 补的正是它漏掉的一类：渲染一次看不出"点第二行却打开了第一行的
编辑器"这种交互错误。

## 3. 测试怎么隔离真实数据

- 一律用临时目录，通过 `DSH_SE_DATA_DIR` 或直接把 `paths` 传进 `openDocuments()`；
- 组件的测试用 `mirrorOverride` / `pinnedOverride` 之类注入，不会真的去下 150 MB；
- `render-smoke.mjs` 自带假 document，不依赖 jsdom。

## 4. 提交前

```bash
npm test && npm run test:render
```

两条都过才算过。`render-smoke` 不在 `npm test` 里，因为它比断言慢得多，而它检查的是
"渲染不抛异常"这一件事。