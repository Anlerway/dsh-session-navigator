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

## 1. 六十六个测试文件，各自钉住什么

| 文件 | 行数 | 钉住的东西 |
|---|---|---|
| `test/tree.test.mjs` | 680 | 树投影的规则 R1–R5：嵌套、计数、降级、环、`sessionHome`、每个节点都带 `homeWorkspaceId`（它属于哪个工作区，与 `workspaceId` 不是一回事） |
| `test/new-session-workspace.test.mjs` | 130 | 新建会话的工作区解析：树节点 id、窗口传来的裸 uuid、当前目录三个 id 空间落到同一个答案；已知但没有归属的节点回 `null`，不回退当前目录——这个 `null` 就是入口的开关。`canStartDraft` 只认有 `homeWorkspaceId` 的地方（工作区、工作区里的文件夹），根目录 / 未分组 / 工作区外的文件夹全关；`draftFolderOf` 只在「要求的那一行确实是这个工作区里的文件夹」时才给落点：工作区行、固定视图、别的工作区里的文件夹、树里没有的 id 都不给 |
| `test/tree-mirror.test.mjs` | 178 | 客户端只持有**遍历**、不持有**规则**——同一问题在两处必须同答案 |
| `test/sessions.test.mjs` | 229 | 合并视图：一个会话"是什么"的唯一判定处 |
| `test/store.test.mjs` | 432 | 侧车存储、原子写、revision、损坏隔离，以及改它的两个规则模块 |
| `test/revision.test.mjs` | 183 | 乐观锁的两端：侧车拒绝过期写，HTTP 层把 409 送到客户端 |
| `test/shortcuts.test.mjs` | 159 | 快捷方式永不移动目标；主题 store 的往返 |
| `test/flags.test.mjs` | 184 | 收藏/待办标记 → 快捷方式的一次性迁移：幂等、写失败先留旧标记、过期标记不中断启动 |
| `test/favorites-list.test.mjs` | 71 | `favorites` / `todos` 是成员表而不是行表：两条快捷方式指同一个会话只算一次；别的容器、别的 kind、空树都答空表 |
| `test/theme.test.mjs` | 104 | 主题 store 只交出窗口用的 token，且拒绝注入 |
| `test/theme-report.test.mjs` | 132 | 面板**上报**的那一半：DSH 把调色板声明在 `body` 上、值是 `var()` 引用 |
| `test/bridge.test.mjs` | 143 | 总线的边界：容量、30 秒时效、游标、坏订阅者 |
| `test/settings.test.mjs` | 295 | 设置文档的默认值、合并、归一化；日期格式、大小单位、搜索索引的开关都是封闭词表。旧文档里的 `search.indexCache` 作为未知键被丢弃，不生效 |
| `test/settings-page.test.mjs` | 1277 | 设置页真实渲染：打开方式、搜索索引组（**只剩「空闲时自动建立」一个开关**、进度、重建/删除、失败文案）、AI 字段组（模型与强度都是从宿主目录画出来的 `<select>`、换模型要清掉强度、三个「生成哪几项」开关各自保存、一键补齐的三种答案：入队 / 没活干 / 被拒、累计花费是 token 不是钱）、「关于」组、危险操作组（DELETE 才亮红按钮）、数据目录、显示格式、写请求的 body；浏览器组件的借用：扫描 chip 排在 install 后面、扫出来的候选行、借用走 POST 而不是 PUT（借用不是设置）、借用态显示路径而不是体积、点「断开借用」只发一次 remove |
| `test/display-format.test.mjs` | 98 | 两种日期格式与两种大小单位真正打印出来的样子：距今时间只走分钟 / 小时 / 天三档（不出现月、年、「昨天」），固定 KB 不换单位 |
| `test/session-state.test.mjs` | 117 | DSH 自己的界面读的那一个布尔集合 |
| `test/live-state.test.mjs` | 124 | 「进行中」只在核说自己拿着的时候才亮：假「进行中」比漏标更糟（它锁住一行、挡住归档与删除），所以出处不是 `ctx.sessions` 而是核给的持有序 |
| `test/session-sync.test.mjs` | 282 | DSH 自己的变更推给面板的代价：一次回复不许变成四次重绘、翻个徽标不许变成一次文件系统遍历；**没有订阅者也照发**（轮询读同一根总线，静默等于让兜底也聋掉） |
| `test/storage-watch.test.mjs` | 214 | 存储目录的轮询：第一次读只是基线不是通知、`storages/workspace.json` 被改写只报一次（带 `refresh`、`structural`、在跑的会话 id）、没变就继续安静、**没有订阅者也照样发布**（否则 `/bridge/poll` 永远问不到东西）；`sessions/` 下多一个或少一个会话目录也算结构变化（`reason: "sessions"`、`structural: true`），而在会话目录里追加日志不算 |
| `test/subagents.test.mjs` | 80 | 子智能体绑定四问；fork 带 `parentSession` 但是独立会话 |
| `test/trash.test.mjs` | 425 | 回收站：删除、恢复阶梯、清空、对账 |
| `test/trash-subagent.test.mjs` | 182 | 子智能体自己进回收站：只搬它自己的 payload、父会话的日志留着、`parentSession` 记在条目上；删父会话时整条链（父 + 子 + 孙）一起走；正在跑的那一条被跳进 `skipped` 而不是让整批失败 |
| `test/move.test.mjs` | 532 | 跨 workspace 移动/复制的三件事一个事务 |
| `test/placement-move.test.mjs` | 264 | 往工作区里的文件夹放会话：同工作区只写 placement、日志不动；跨工作区不带 `move:true` 直接 400「这个文件夹只接受它所在工作区里的会话」且一个字没写；带了就先按 /move 把 payload 搬过去再写 placement（header 的 cwd 跟着改）；一批里有一条正在跑，那条进 `failed`、其余照摆；整批都搬不动就抛 `session-active`，revision 不动 |
| `test/placement-pending.test.mjs` | 108 | 文件夹里新建会话的**意图**路由：工作区里的文件夹与工作区行都能 arm，带上此刻已有的会话 id 当基线；没给 parent、树里没有的节点、装不下会话的容器（根目录、工作区外的文件夹）都在 arm 之前就 400，未分组能装会话但装不进草稿，单独一句 400 |
| `test/pending-drafts.test.mjs` | 247 | 意图落地的判据（全部是"不是它"的理由）：点击之后出现的那一条才进文件夹；已在基线里、早于意图 3 秒以上、别的工作区、子智能体、回收站、已归档、已经带 placement 的都不碰；没有 `createdAt` 时只靠基线；过了 120 秒作废、父节点在此期间消失就丢弃、同一文件夹只留最新一条、两个文件夹各等各的、host 拒绝一次就放弃（同一个请求会被同样拒绝）、arm 缺参数抛错、cancel / dispose 之后什么都不剩、轮询真的会在没人调 `settle()` 时把会话摆进去 |
| `test/datadir.test.mjs` | 410 | 数据目录迁移：预检、七步、回滚、`.location` |
| `test/component.test.mjs` | 607 | 组件状态机：单飞锁、复用、校验、pending 清扫；以及借用——`inspectBorrowed` 的三种否决（空目录、只有二进制、没有版本号）、有界扫描（命中即停、跳过 `node_modules` 与超深目录）、借用后 `phase` / `source` / `borrowed`、被借的树逐字未变、树被删后自动降级 `absent`、卸载只删自己的 `helper-app`、数据目录内路径一律 `component-borrow-invalid` |
| `test/component-install.test.mjs` | 87 | 安装入参的守卫：只认 `source`（mirror / github）与 `borrowed`，别的键一律 400 `unknown install option`；设置页「扫描其它插件 → 借用」发的那一份 body 有回归用例（它一度被这道校验挡掉）；`retry` 走同一套校验 |
| `test/export.test.mjs` | 296 | 会话日志 → Markdown / JSONL：真实形状（`time`、`data.message.content`、独立 `tool/call` 事件、`source.kind`）才算数——助手回复与工具调用曾经因为读错字段整类消失；注入上下文与系统提示不进正文；压缩摘要与被替换片段**只报告、不丢弃** |
| `test/summary-apply.test.mjs` | 103 | 直接驱动 `POST /summaries/:id/apply` 这个真实路由（用内存侧车代替磁盘）：描述是**追加**在用户备注后面而不是覆盖、重复点两次不会贴两遍、标签只并勾选的那几个并写进标签库、不勾等于全并、过期勾选回 `nothing-to-apply`、字段名不认识回 `bad-request`、记录里没有的字段不能应用 |
| `test/summaries.test.mjs` | 921 | AI 字段而不联网：stub 掉 `llm` 服务，断言送进模型的**正文**（只有双方发言，思考过程与工具输出从不出现，超长时头 55% 尾 45%）、提示词只列被要的字段（关掉的字段不在契约里）、回答的解析与校验（围栏与前后废话都读得出来、缺字段算缺失、`reasoning` 块不影响正文、工具调用块旁边的文字照收、只有工具调用则重试后报 `llm/tool-only`）、“乱答重试一次且两次都记账、两次都败不落盘”、待补清单只看**描述与标签**（备注抵描述、手写标签抵标签、手改标题不算）、标签先裁到 8 字再去重、生成时先看已有标签库并把它写进提示词、`alignTags()` 把同义词归到库里已有的写法、`mergeNote()` 追加而不是覆盖、`pickTags()` 只并勾选的且过期勾选算拒绝、队列单飞与取消（已写好的保留、一条失败不拖垮整批）、重复入队只算一次、token 账本（失败的尝试也记 `runs`）、模型目录 TTL 与单 provider 失败隔离、`effort` 是适配器自己的词所以换模型就丢；每个拒绝码映射到的 HTTP 状态（401 / 409 / 413 / 422 / 429 / 501 / 未知 500） |
| `test/detached-window.test.mjs` | 612 | 独立窗口的页面、路由、冒充 DSH 的 shim，以及 `?lang=` 决定的那一半文案；借用那条路的三个接口：launcher 把 `appDir` 当第一个参数、Host 的 runtime thunk 带上 `appDir`、`GET /component/scan` 与 `component-borrow-invalid` → 400 |
| `test/client-launch.test.mjs` | 595 | 两个入口对着 stub 宿主跑；两条"线上才炸"的路径 |
| `test/row-rename.test.mjs` | 185 | 列表行必须打开自己的重命名编辑器，而不是别人的 |
| `test/row-rail.test.mjs` | 169 | 子会话引导线的几何：必须落在上面那个折叠箭头的中心（深度 0 与非 0 是两条式子） |
| `test/list-containers.test.mjs` | 211 | 列表里哪些容器行该出现：搜索放宽到整棵树，筛选变成「含命中」的结果视图；「会话名」关掉后文件夹只能靠装着命中进来；「当前目录」时放宽整棵树这件事也不做 |
| `test/list-density.test.mjs` | 93 | 拥挤的列表滚动而不压行：`.listbody` 是唯一滚动面（`overflow:auto`、没有自己的 `height`/`max-height`、`overscroll-behavior:contain`）、`.row` / `.trow` / `.grp` 都是 `flex:0 0 auto`（压力落在容器上，不落在行上）、链上两处 `min-height:0` 都不能掉——少一处滚动条就永远不出现 |
| `test/content-index.test.mjs` | 517 | 会话内容索引：按 `path|size|activityAt` 失效、逐份让出事件循环、两个 `work()` 只读一份、异步读必须 await、命中数与片段；**只索引用户与助手的文字**（真实日志形状：工具输出、注入上下文都不该被搜到）；磁盘缓存**传了 store 就写**（没有开关）、写盘后重启不再读日志、坏版本与写不进去都不阻断搜索、没给 store 就只在内存里；空闲构建器只在开关打开时动手 |
| `test/search-scope.test.mjs` | 307 | 搜索范围的**位置**（所有位置 / 当前目录）与四个字段：默认三项且位置为所有位置、会话内容只看 host 命中、搜索缺省是整库范围、选了当前目录才收窄、弹窗把位置放在字段之上、「搜索索引设置」一键跳到设置页、面板确实把范围传给了列表 |
| `test/marquee.test.mjs` | 519 | 鼠标框选：矩形归一化（反向拖也成立）、任何重叠都算命中而仅相邻不算、零面积等于点击（什么都不选）、集合没变不重报、按在控件上不起框、**没选中的行是表面（起框）而已选中的行留给自己拖**（`rowDraggable`）、没有复选框的行不进集合、ctrl 是并集、靠近边缘自动滚动且到顶就停、右键不起框也不会被当成清空、被调用方中途停掉不算点击、**列表滚动后不靠 mousemove 也要重算命中**、**起始点钉在行上而不是屏幕上（滚一格框就跟着长高，滚两格不重复累加）**、**祖先把面板推走后框仍贴着指针**（每帧重读 pane 矩形） |
| `test/reorder.test.mjs` | 94 | 名次那条路由：workspace 的名次落在 `workspaceOrder`、快捷方式落在自己的 `order`；一个名字对不上任何节点的 id（例如多打一层 `w-`）回 `404 node-not-found` 而不是给没人画的行写名次；`order` 不是数字不进文档；过期 revision 仍由侧车挡 |
| `test/bridge-poll.test.mjs` | 201 | 桥的两条路径：独立窗口的刷新只能作为 `refresh` 命令走出进程（面板自己拉、窗口只发命令），而窗口挂载时先发一条 `status-request`、再发 `refresh`（两条命令走同一个 `POST /bridge/commands`，所以断言按 kind 数而不是按条数）、轮询按游标追问且同一条 `seq` 不执行两次、**没收到 `ready` 时的第一次轮询只是取位置而不是放历史**、`ready` 的游标比本地小就是宿主重启（当作一次 `host-restart` 重载，且不声称谁知道哪些会话在跑）、首次连接吸收游标（不重放挂载前的 `open-session`）；断开时流被关掉 |
| `test/bridge-events.test.mjs` | 203 | 两份 document 的对等通知：写请求落地后 host 自己发一条 `changed`（读请求不发，`/bridge/`、`/component/`、`/search/`、`/summarize` 这些自己会刷新或自己会重载页面的前缀也不发），发的是匹配到的路由而不是原始 URL；调色板**真的变了**才发 `theme-changed`（同一份重复上报不算，只换了 token 值也算变了）；`POST /bridge/commands` 回包带 `listeners`（窗口自己算一个，用它判断有没有人在听）；`lang-changed` 只认 `zh` / `en`；`session-status` 的 `rows` 由路由重建——未知的 `pending` 猜成已知就等于凭坏数据挂上「等待审批」，所以那种值单独出现时整行丢掉、带着 `running` 时留下但 `pending` 归 `null`，`id` 截 200、最多 500 行 |
| `test/status-board.test.mjs` | 131 | 状态的"迟到"：总线只留 30 秒、页面不变就不重播，所以晚开的窗口问到的是一根空总线——host 状态板记住最新一格，`status-request` 立刻用缓存答，`GET /bridge/status` 交出同一份；窗口按 `at` 比较，晚到的旧快照不许把新的顶回去；等待类型变了算新快照 |
| `test/session-status.test.mjs` | 143 | 会话状态怎么跨进程：只投影有信号的三样（在跑 / 在等 / 未读完成），空投影是一条消息而不是沉默（窗口要靠它擦掉上一份徽章）；同一份快照不重复发（总线只留 30 秒、64 个槽，重绘会把握手挤掉），但**被问就重播**：`publishStatusSnapshot(rows, true)` 跳过去重，给刚打开的窗口一份现成快照；发出的是 `POST /bridge/commands` 上的 `session-status`，窗口侧收到就走 `applyPeerStatus` |
| `test/dsh-refresh.test.mjs` | 67 | 谁有资格替 DSH 重读会话列表：面板拿得到 `sessions` 服务，独立窗口的 shim 也答应同一个 `refresh`（空函数），所以「有 refresh 就算」在窗口里会误判成能刷；判据改成 shim 那个 `hostBridge` 成员在就不算，写的一方据此才敢发 `needsDsh` |
| `test/double-press.test.mjs` | 48 | 双击时限：同一行两次按下都在 `DOUBLE_CLICK_MS` 内才算、慢一拍就是两次单击（而且那次慢按成为新的一对的开始）、换一行不配对、一次双击用掉这一对所以第三下重新开始、没有名字的目标永远不算 |
| `test/drag-set.test.mjs` | 67 | 多选拖动的那一次拆分：容器与会话按树和索引分流而不是按 id 前缀、陌生 id 丢掉而不是猜、重复 id 只走一次、容器永远不会被当会话、没有索引时非容器都算会话、空集拆成空集 |
| `test/quick-access.test.mjs` | 93 | 快速访问是一条序列：只有真实容器能当书签、整份快照语义：没列出的书签会被删掉、陌生 id 进 `skipped`、不是容器的行一律清掉 |
| `test/filter-dialog.test.mjs` | 115 | 筛选对话框的两个出口：重置还要按应用，取消是一步；没东西可取消时它不存在 |
| `test/heads.test.mjs` | 109 | 会话 header 扫描：换过格式版本的日志仍找得到、同 id 只出一份、无日志目录跳过 |
| `test/logfacts.test.mjs` | 212 | 日志只答一个问题：有没有过一轮对话，只读头时的窗口边界，以及「一轮没关」不再被当成状态 |
| `test/annotations.test.mjs` | 32 | 注解 id 守卫：`__proto__` / `constructor` / `prototype` 不能变成幻影条目 |
| `test/reveal.test.mjs` | 237 | reveal 白名单：只开自己列出来的路径（UNC 路径是凭据泄漏，不是便利） |
| `test/update.test.mjs` | 135 | 更新检查：数字段比较、release 解析、5 分钟缓存、失败码而不是假"已是最新" |
| `test/about.test.mjs` | 236 | 链接白名单与降级链，以及缓存清理只清自己的（quarantine 与会话不动，组件在装就跳过） |
| `test/notes-gate.test.mjs` | 115 | 更新说明什么时候说、什么时候闭嘴：每个版本一次，没记过版本的机器首次也播；「已经说过」记在 host 的文件里，不是 localStorage（web GUI 每次启动换端口就是一个新的 origin，空存储会把公告变成每次开机都弹） |
| `test/notes.test.mjs` | 156 | 更新说明本身：changelog 解析成块、checkout 与安装副本两份候选文件谁说了算，以及两者必须逐字一致——不一致说明发版会带上旧说明 |
| `test/locale-parity.test.mjs` | 88 | 中英两份字典键集合一致、占位符一致、英文标签放得下；设置页的 token 块必须自带 `--sm-danger` |
| `test/panel-copy.test.mjs` | 189 | 面板每一句中文都有英文对照：字典覆盖全部 `T()`、没有裸中文残留（注释与样式表除外）、占位符不丢；固定目录与默认工作区也走字典；shim 同理（例外是 `L()`） |
| `test/reset.test.mjs` | 213 | 清除数据：一个字都没动之前先验 `DELETE`、五份侧车与回收站本体一起删、组件与数据目录本身留下、迁移路径写回 |
| `test/projcache.test.mjs` | 156 | 投影缓存的复用键（size + mtime）：没动过的文件不读第二遍，而**任何**改动都得被发现——最硬的一条是第二次写入等长内容并把旧 mtime 放回去，只信键的读取器仍会答出旧标题；另有 reader 单飞与清缓存 |
| `test/workspace-bands.test.mjs` | 107 | 「所有会话」按工作区切带：行落到哪个工作区（子会话跟父会话）、带序按树 DFS（含拖进用户文件夹的工作区仍留在文件夹位置）、树不认识的工作区排在已知之后、没有工作区的沉底、标题取工作区名字而视图过期时回落到 id |
| `test/render-smoke.mjs` | 1556 | 每个组件真实渲染一次（不是 `node --test` 的一部分）；详情栏的「AI 字段」段必须紧跟在「备注」之后并带着那一枚按钮，存了字段之后要画出标题/描述/标签三行、每个标签都是**已勾选**的开关并写着「合并所选（2）」；框选那窗 `.selrect` 必须在树里、空白处按下才起框；没选中的会话/文件夹/工作区行 `draggable` 必须是 false，选中或勾选后仍是 true；真起一次拖动后，勾选集（会话与容器两个半边）必须原样交到落点，浏览器读不到 `DataTransfer` 时仍从载荷里答；双击打开落在**第二次按下**上（一次按下只能选中）；状态点与 DSH 同一阶梯（空闲 / 进行中 / 等待审批 / 计划待审 / 等待回答 / 已完成 / 子智能体运行中），「已中断」「异常」两个自造档位不许回来 |

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