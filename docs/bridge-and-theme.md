# 桥与主题

面板跑在 DSH 的 document 里，独立窗口是**另一个进程里的另一个 document**。两者渲染的是同一份
`lib/client.js`，但它们彼此看不见：没有共享的 DOM、没有共享的 CSS、没有共享的事件总线。
这两件事——导航命令和配色——就靠下面这套很窄的通道传过去。

## 1. 命令总线

`lib/host/bridge.js:58` 的 `createBridge()` 是一个**进程内的环形缓冲**，不是消息队列：

| 参数 | 值 | 理由 |
|---|---|---|
| `capacity` | 64 条 | 面板关着时攒下的命令，重连时要能补发 |
| `MAX_AGE_MS` | 30 000 | 半分钟前的"打开这个会话"已经不是用户的意图了 |

每条命令是 `{ seq, kind, payload, createdAt }`，`seq` 单调递增，永不复用。
`since(cursor)` 返回 `seq > cursor` **且** 未过期的命令：游标太旧时返回的只是还留着的那些，
补发一部分总比什么都不补发好。

总线**故意是哑的**（`lib/host/bridge.js:67-72`）：它不校验 payload 的语义，只搬运。
认识某个 kind 的监听者自己处理，不认识的忽略。这样新面板可以对着旧窗口说话，不需要升 schema。

## 2. 允许的 kind，以及谁执行

`WINDOW_COMMANDS`（`lib/host/bridge.js:153`）是窗口唯一被允许发的八种命令，其余一律 `bad-request`。
另外两种由 **host 自己**发，用来通知页面窗口的生命周期。

| kind | 谁发 | 谁执行 | 作用 |
|---|---|---|---|
| `open-session` | 窗口 | DSH 页面 | 在 DSH 里打开某个会话 |
| `new-session` | 窗口 | DSH 页面 | 在某个 workspace（或默认位置）新建会话 |
| `open-settings` | 窗口 | DSH 页面 | 打开 DSH 的设置（窗口没有设置外壳） |
| `lang-changed` | DSH 页面 | **窗口** | DSH 换了界面语言，窗口要在另一种语言下重载 |
| `reveal` | DSH 页面 | **窗口** | 在资源管理器里定位会话文件 |
| `refresh` | 窗口 | DSH 页面 | 我的写入落地了，重读；顺带让 host 丢掉会话缓存 |
| `session-status` | DSH 页面 | **窗口** | 会话状态行（`running` / `pending` / `completed`），跨进程唯一的路 |
| `status-request` | 窗口（挂载 / 回到前台），页面也听 | host 的状态板缓存 | 现在的状态行是什么，用缓存直接答 |
| `changed` | host | 两边 | 有写入落地了（`{ path, method }`），不是我这半边发的也要重读 |
| `theme-changed` | host | **窗口** | 调色板变了，重读 `/theme` 并重画 |
| `window-open` | host | DSH 页面 | 窗口已打开 |
| `window-closed` | host | DSH 页面 | 窗口已关闭 |

`POST /bridge/commands` 的回包带一个 `listeners`（发布那一刻的订阅者数量，窗口自己也算一个）：

```jsonc
{ "ok": true, "result": { "seq": 43, "kind": "open-settings", "listeners": 1 } }
```

窗口用它判断「有没有人听」。`listeners <= 1` 就是「只有我自己」——DSH 页面没开着的时候，
窗口不再谎称「已在 DSH 主窗口打开设置」，而是直说请求发出去了但没人接收。

payload 只接受三个字符串字段，各自截到 200 字符（`session-status` 的 `rows` 是唯一的例外，见 §7）：

```jsonc
{ "kind": "open-session", "payload": { "sessionId": "01J…" } }
```

`sessionId` / `workspaceId` / `scope` 之外的键**直接丢掉**。桥是一根窄管子，不是插件的遥控器。

`session-status` 的 `rows` 由 `normalizeStatusRows()` 重新拼一遍，不是原样透传：只认
`{ id, running, pending, completed }`，`id` 截 200、`pending` 只认 `approval` / `plan-review` /
`question`、`running` 与 `completed` 只认布尔 `true`，最多 500 行；缺 id、或者三样都没有的行
会被丢掉。坏行**修不了就丢**——它决定另一侧画哪个徽章，把未知的等待类型猜成已知的，等于给一个
什么都没干的会话挂上「等待审批」。`status-request` 不携带任何东西，带了也丢。

**为什么方向是分开的**（`lib/client.js:14226-14281`）：

- `open-session` / `new-session` 只由 DSH 页面执行。窗口是发起方；窗口若也听自己的命令，
  就会把命令原样再发一次（shim 里的 `ECHO_MS` 回声守卫只是时间启发式，不是契约）。
- `reveal` 只由窗口执行。反过来会让页面在自己刚打开窗口之后，又把面板盖在那个窗口上面。
- 两边都先问 `windowHost()`：同一个 `client.js`，靠这一个判断决定自己现在是哪一端。

### 写入广播（`changed`）

写请求落地之后，host 自己往总线发一条 `changed`（`announceWrite()`，`lib/index.js`）：

```jsonc
{ "kind": "changed", "payload": { "path": "/folders", "method": "POST" } }
```

发的是**匹配到的路由**，不是原始 URL。这是一份省略名单（`QUIET_WRITE_PREFIXES`）之外的
一切非 GET/HEAD：`/bridge/`、`/component/`、`/detached/`、`/datadir/`、`/search/`、
`/summarize`、`/cache/`、`/theme`、`/update`、`/about/`、`/release-notes` 不发。

免掉的都是「喊了也白喊」的那几类：组件下载、索引重建、总结、缓存清理在跑的时候本来就被轮询；
数据目录迁移成功后会自己重载页面；`/bridge/` 是总线自己（一条命令的广播会回声成下一次重读）；
`/theme` 有自己的 `theme-changed`。剩下的才是另一份 document 真正看不见的写入——建文件夹、
改名、删进回收站、改设置、标签、备注。

两份 document 收到 `changed` 都只是重读一次 `/bootstrap`（`publishLiveUpdate({ refresh: true })`），
不区分是谁发的：写的一方本来就会重读，多读一次比漏读一次便宜。

## 3. SSE 协议

`GET /bridge/events?since=<cursor>`（`lib/index.js:1693`）。帧序列固定：

```
event: ready
data: {"cursor":42,"kinds":["open-session","new-session","reveal","refresh","open-settings","lang-changed"]}

id: 43
event: command
data: {"seq":43,"kind":"open-session","payload":{…},"createdAt":1730000000000}

: keep-alive
```

- `ready` 先发，带上当前游标和允许的 kind，客户端据此决定要补哪些；
- 紧接着补发 `since` 之后的命令（一次往返就能追上，不用第二次请求）；
- 之后是实时的 `command`，每帧带 `id: <seq>`；
- 每 **15 秒**一条注释帧 `: keep-alive`，防止中间层掐掉空闲连接（`keepAlive.unref()`，
  它不该阻止进程退出）；
- `req.on("close" | "aborted")` 时清定时器、退订、`end()`。

**重连不重放**：`EventSource` 断线后会自己重连同一个 URL，并带上 `Last-Event-ID`。服务端优先
读这个头，读不到才回落到查询参数 `since`（`lib/index.js:1716-1717`）。没有这一步，重连会从
首次连接的游标开始补发，`new-session` 就开两个窗口。

**背压与上限**：`res.write()` 返回 `false` 表示套接字缓冲已满，此时直接结束这条流——面板会带
`Last-Event-ID` 重连，从它真正收到的最后一帧继续，而不是让缓冲无限增长。同时订阅者上限 32
（`MAX_LISTENERS`，`lib/host/bridge.js:35`），满了回 `503`：重连风暴不能把卡住的响应再叠一层。

主路径是 SSE，因为它推而不问；但条流**可以静默死掉**：文档被隐藏久了会被节流、一端以为连接还在、
或者宿主在整个插件底下重启了一次。那时两边都停在旧列表上，只有重启 DSH 才能救——这正是「删了会话另一边
不更新，手动刷新也没用」的那份报告。

所以同一条总线还有第二个入口（`lib/client.js` 的 `subscribeBridge`）：

```
GET /bridge/poll?since=<cursor>
→ { "cursor": 45, "commands": [ { "seq": 44, … } ] }
```

- 每 `BRIDGE_POLL_MS`（4 秒）问一次，文档处于 `hidden` 时跳过（本来就要被节流，回到前台有自己的刷新）；
- 两条路径同时在跑，`seq` 去重：同一条命令只执行一次，游标始终是「已经执行过的最大 seq」；
- `ready` 帧带回的 `cursor` **小于**本地的 → 宿主重启过，编号从头来，这中间的增删从来没被播报过。
  此时直接当作一次 `sessions-changed`（`reason: "host-restart"`、`refresh: true`、`structural: true`，
  不带 `running`，避免把运行态清空），让它重读一遍，而不是继续等下一帧；
- 首次连接把 `cursor` 抬到 `ready.cursor`：30 秒环形缓冲里可能还压着用户点过的 `open-session`，
  刚挂载的面板不该替那条历史命令开门。

**零订阅者也发布**。`session-sync` / `storage-watch` 曾经用 `bridge.listeners > 0` 当门，理由是
「没人听就别广播」；可轮询读的是同一根总线，门一关，兜底也就跟着聋了。现在无条件 `publish`：
环形缓冲 64 条、30 秒过期，没有订阅者时它的成本就是一次数组 push。

## 4. 主题

### 问题

面板在 DSH 的 document 里，`getComputedStyle` 能解出每个 `--dsw-alias-*` 的当前值。
独立窗口是另一个 document，DSH 的样式表不在那里，那些 token 会退回面板自己的默认值——
于是用户装了主题插件、或者切到浅色，窗口不跟着变。

### 解法

面板把**它看到的**报给 host，窗口来问 host 要。`lib/host/theme.js` 是个极小的共享 store。

只接受样式表真正用到的 14 个 token（`THEME_TOKENS`，`lib/host/theme.js:31`）：

```
--dsw-alias-bg-layer-1 / -2 / -3
--dsw-alias-label-primary / -secondary / -tertiary
--dsw-alias-border-l1 / -l2
--dsw-alias-state-business-primary / -error-primary / -success-primary / -warning-primary
--dsw-alias-brand-primary
--dsw-alias-interactive-bg-hover
```

**校验**（`isSafeTokenValue`，`lib/host/theme.js:57`）：值最终会进 CSS 自定义属性，所以无界的
map 就是一条样式注入通道。规则是：

- 必须是字符串，trim 后非空，长度 ≤ 160（`VALUE_MAX`，够放颜色和小的 color-mix 表达式）；
- 含 `;` `{` `}` → 拒；
- 含 `url(` / `expression(` / `@import` / `javascript:`（忽略大小写）→ 拒；
- 必须整体匹配 `^[#\w\s.,%()\-+/'"*]+$`。

不匹配的单个 token 被丢掉，不影响其它 token。

### 上报时机

`reportTheme()`（`lib/client.js:11130`）：读 `.se-shell`（没挂载就读 `body`，最后才退到
`documentElement`）的 computed style，取这 14 个 token 的值，`POST /theme` 带 `{ mode, tokens }`。
`mode` 来自 `documentElement` 的 `data-theme` 是否为 `light`。

读 `body` 而不是 `documentElement` 是有原因的：DSH 把调色板声明在 `body` 上
（`--dsw-alias-*` 定义在 `body` / `body[data-ds-dark-theme]`），自定义属性只向下继承，
所以从 `<html>` 读拿到的是**空**调色板。上一版正是在 `apply()` 里从 `documentElement`
读一次——那时面板还没挂载、`<html>` 又没有 token，于是 host 存下一份空的调色板，
窗口只好用样式表里硬编码的兜底色（工作区名字/图标因此是深蓝 `#4176e6`，而 DSH 里是主题色）。

**值必须解析成具体颜色**（`resolveThemeValue()`，`lib/client.js:11092`）：DSH 的 alias token
几乎都是指向自己调色板的引用，例如 `--dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50)`。
窗口没有 `--dsw-static-*` 这一层，原样搬过去会得到一个"引用了不存在变量"的值——这在 CSS 里是
*无效*而不是*未设置*，消费方 `var(--token, fallback)` 的 fallback 根本轮不到，文字会掉成
`unset`。所以在这里就地展开引用（深度上限 8 层，支持 `var(--x, #fallback)`），解不出来的
token 直接丢给 host 丢弃，让窗口保留自己的兜底。

触发点有三个：`apply()` 时一次；`Panel` 挂载后一次（`lib/client.js:6386`，此时 `.se-shell`
才存在，读到的就是面板真正看到的调色板）；以及一个 `MutationObserver`——监视
`documentElement` 的 `class` / `data-theme` / `style` 三个属性。这是 DSH 里所有主题插件切换
明暗的方式，所以监听它就等于监听"主题变了"。观察器挂在 `ctx.effect` 里，卸载时断开。

### 窗口侧

`assets/detached/shim.js` 在窗口启动时 `GET /theme`，把每个 token `setProperty` 到
`documentElement`，并同步 `data-theme`。

**已经开着的窗口**不会自己再看一眼。所以 `POST /theme` 在调色板真的变了的时候（`mode` 变了，
或者 14 个 token 里有一个值变了）往总线发一条 `theme-changed { mode }`，窗口收到后调
`window.__seShimHooks.applyTheme()` 重读一次。同一份调色板重复上报是常态——面板每次挂载、以及
`documentElement` 每次 class 变化都会上报——所以「变了才发」是必需的，不是优化。

shim **会拦掉**窗口发出的 `POST /theme`（`assets/detached/shim.js:93`）。因为窗口里的
`client.js` 也在跑，它也会上报——但窗口的配色本来就是**从 host 拿来的**，回声会把一份空调色板
盖在真的上面（首帧还没拿到回复时尤其明显）。所以这条通道只允许单向：面板 → host → 窗口。

## 5. 独立窗口

`POST /detached/open` / `POST /detached/close`（`lib/index.js:2010-2026`）。窗口本体是 DSH 的
Electron 窗口，加载 `/session-navigator/api/ui`，需要浏览器组件就绪，否则 404 `component-not-installed`。

窗口打开/关闭时 host 往总线发 `window-open` / `window-closed`（`lib/index.js:191-192`），
页面据此更新"默认打开方式"的状态和按钮文案。面板自己记 `detachedOpen` 这个状态：
`window-open` 置真、`window-closed` 置假。它**不能**借 `componentReady`（「浏览器组件装好了」）
来表达这件事——两者曾经是同一个 state，于是关掉窗口之后按钮会改口说组件没装。

窗口的几何（`shell.window.bounds` / `alwaysOnTop`）存在设置里：`bounds` 为 `null` 表示"还没放过"，
客户端先居中一次再把落点记下来。

## 6. shim 到底做了什么

`assets/detached/shim.js:1-25` 写得很清楚：窗口和面板是同一个 UI，窗口**原样加载**
`lib/client.js`，shim 只是在那份模块 mount 之前假装自己是 DSH。client.js 向平台要四样东西，
shim 四样全给：

| 平台接口 | shim 给的 |
|---|---|
| `window.__ModuleLoader__.load({ id, factory })` | 直接调用 factory |
| `require("react")` | 仓库里自带的 UMD 构建 |
| `ctx.slots` / `ctx.locale` / `ctx.effect` / `ctx.get` | 一个"刚好够用"的 ctx |
| `document.body` + `createPortal` | 窗口自己的 document |

因为面板是通过 portal 渲染进 `document.body` 的（`getOverlayRoot`），这在任何 document 里都能工作，
所以窗口只需要渲染一次 footer-action 槽位、把 panel store 打开就行。

shim **故意不做**两件事：不上报主题（见上），不订阅命令桥（窗口只向 host 请求导航，
执行由 DSH 页面里的面板完成）。

但它留了两个钩子：`window.__seShimHooks = { applyTheme, setLang }`（`assets/detached/shim.js` 末尾）。
一条 SSE 连接是 HTTP/1.1 上稀缺的东西，已经有一条在 `client.js` 手里，shim 不再开第二条，所以
「重画一次」「换语言」这种动作是由 client.js 收到命令后调过去的。`setLang` 只能是整页
`location.replace`：窗口的字典在加载时就按 URL 的 `?lang=` 定死了，挂载好的树没法中途换字典。

## 7. 面板与独立窗口之间的对等总线

命令总线（§1）是纵向的：窗口 → host → 页面。两边的**数据一致性**先走横向通道——
浏览器自己的 `BroadcastChannel("dsh-session-navigator")`（`lib/client.js:2374`）。同源的两个
document 直接对话，host 不参与，也不需要知道有几个人在看着同一份树；但这条通道**不出进程**
（见下文 `refresh` 与 `status` 两段），跨进程的部分才回到纵向总线。

| 消息 | 谁发 | 谁收 | 作用 |
|---|---|---|---|
| `{ kind: "refresh", path, needsDsh }` | 任何刚写完数据的 document | 另一个 | 重读 `/bootstrap`；`needsDsh` 为真时，手上有 DSH 会话服务的一侧顺手再拉一次 DSH 自己的列表 |
| `{ kind: "status", rows }` | 拿得到 DSH 会话服务的一侧 | 同进程的另一个 document | 抄来 `running` / `pendingInteraction` / `completionUnread`（`lib/client.js:2471`）；跨进程那一路走 `session-status`，见下文 |

`refresh` 在 `apiSend` 的非 GET/HEAD 成功分支里发出（`lib/client.js:2349`）。这是插件自己的写
路径——删进回收站、跨工作区搬会话、改树、改设置——唯一能让**另一个 document** 知道的信号：
这些写入不经过 DSH，宿主的 `sessions-changed` 与 workspace.json 监听都看不见它们。

独立窗口连「顺手把 DSH 列表也拉一次」都做不了：它跑在 shim 上，没有 hostCtx，`serviceOf("sessions")`
是 `null`，`refreshDshViews()` 静默无效。所以写的一方用 `needsDsh` 声明「我这半边拉不动 DSH」，
收到的一侧在 `canRefreshDsh()` 为真（也就是面板）时替它补上这一次刷新。

**但这根横向通道不出进程**。`BroadcastChannel` 只在同源、同一进程组里送达；独立窗口是另一个
Electron 进程，它发的 `refresh` 到不了 DSH 页面——于是「窗口里删一条会话，DSH 侧栏还挂着它，
怎么刷新都不动，只能重启」。补的是纵向那条路：窗口 `apiSend` 写成功后在 `windowHost()` 为真时
`POST /bridge/commands {kind:"refresh"}`（`requestDshRefresh()`，`lib/client.js:1170`），host 收到这个
kind 先 `reader.invalidate()`（否则重读还在 1.5 秒的 header 缓存里），再播给订阅者；页面那一端在
`apply()` 的桥回调里把它翻译成一次 `refreshDshViews()` + 一次面板重载。

反方向不用窗口做任何事：**面板**的写入由 host 在回包之后发 `changed`（§2），窗口在桥回调里
当成一次普通重读。所以横竖两条通道是互补的——同一个进程里 `BroadcastChannel` 更快（不经过 host），
跨进程只有 host 那条路能到。

「更多 → 刷新」也走同一个函数：`load(true)` 只重读这份列表，用户按下刷新时指的显然是两边都对齐。

`status` 的存在理由更直接：独立窗口跑在 shim 上，`uiSession` 是空实现，
`sessionStatus` 永远是 `null`，于是「等待回答 / 等待审批 / 计划待审 / 已完成（未读）」
这些只存在于 DSH 客户端服务里的状态**在窗口里结构上就取不到**。窗口不发自己的表，
只收面板的那一份。

**而且 `BroadcastChannel` 也到不了窗口**——它是另一个 Electron 进程，横向通道只在本进程内送达
（`lib/client.js` 里 `refresh` 那段注释说的就是这句话）。所以状态行有两根管子：

| 载体 | 谁 → 谁 | 何时 |
|---|---|---|
| `BroadcastChannel` `{ kind: "status", rows }` | 同进程的另一个 document | 每次快照变化 |
| 总线 `session-status` | 页面 → host → 窗口 | 每次快照变化 |

发布只有一个入口 `publishStatusSnapshot(rows)`：快照没变就不发（总线只有 64 个位置、30 秒
寿命，一次重绘不该把真正的命令挤出去），而跨进程那一条只在 `!windowHost()` 时发。订阅点有两处——
`useDshSessionStatus` 的 effect（面板挂着时）和 `apply()` 里的一个 effect（读
`serviceOf("uiSession")?.sessionStatus`，服务晚到就 `hostCtx.inject` 等它）。后者是**独立弹窗**
模式下唯一能发布的地方：那里根本没有面板组件挂载过。

窗口那一侧两条路一起走，因为它们的失效方式不一样。一条是节拍：它在 `apply()` 里起一个定时器，
每秒 `GET /bridge/status` 读一次 host 状态板（`STATUS_PULL_MS`），读回来交给
`applyPeerStatus(rows, at)`——不依赖谁记得去发。另一条是问话：挂载时、以及 `focus` / 转可见时发一次
`status-request`，host 用状态板缓存立刻作答；页面若也收到这条，就用
`publishStatusSnapshot(undefined, true)` 强制重播一遍（`force` 跳过去重），让刚打开的窗口不必等一个节拍。
节拍怕定时器被节流，问话怕页面的 document 在后台被节流、回答晚几分钟——两条先到哪条都不算错，
`at` 会挡住更旧的那份。

**问话救不了的就是时间上的这两个洞。** 问话要送到页面，而页面的 document 在后台时被浏览器节流，
回答可能晚几分钟——窗口分不出「晚」和「没发」，徽章就停在旧档；反过来，总线里那条广播 30 秒后过期，
而页面在快照没变时不会重播，于是更晚打开的窗口问到的是一根空总线。所以 host 记一格
（`lib/host/status-board.js`），窗口不问也读得到：

| 载体 | 谁 → 谁 | 何时 |
|---|---|---|
| `session-status` 的缓存 | host 存最后一格，谁问都答同一份 | 每次发布 |
| `GET /bridge/status` | 窗口拉 host | 每秒（`STATUS_PULL_MS`） |

发布出去的那一帧带 `at`（快照自己的时间，不是响应时间），缓存里也是同一个值：窗口按它比较，晚到的旧快照不许把新的顶回去——推送与拉取本来就会互相超车。页面那一侧另加一个 1 秒的自查定时器（`STATUS_TICK_MS`）：投影一遍、和上次的 JSON 比一次，变了才发，兜住「观察源没通知」这种静默漏报。

四条约束值得记下来，改这段代码时最容易踩的也是它们：

- **回声必须防住。** 只有拿得到 `uiSession` 的一侧发布（`if (!local) return;`），跨进程那条还要
  `if (!windowHost()) return;`（窗口自己不发）；收 `session-status` 的一侧 `if (!windowHost()) return;`
  不听自己。`useMemo` 的依赖写 `[local, version]` 而不是
  `[local, version, peerStatus]`，否则两个窗口会互相触发、来回广播。
- **空快照也是一条消息。** 接收侧清空重建，某个会话不在下一份里就等于它不再等待——不需要墓碑，
  也不会留下一个永远转圈的「等待回答」。
- **本地优先。** 同一个 id 两边都有时用本地那份（`lib/client.js:3149-3157`）：本地读的是活的
  服务，peer 的行只是它最后一次广播的快照。
- **写入方不刷新自己。** BroadcastChannel 不把消息回送给发送它的 document，所以写窗口照旧走
  自己的 `load()`，不需要额外的「这是我发的」标记。

没有 `BroadcastChannel` 的环境拿到 `null`，两条通道静默退化成「各画各的」，别的功能不受影响。
`channel.unref?.()` 只是为了让导入 `lib/client.js` 的 Node 测试能够退出——否则那个 handle 会
一直挂着。

## 8. 相关文件

| 文件 | 职责 |
|---|---|
| `lib/host/bridge.js` | 总线、`WINDOW_COMMANDS`、`normalizeCommand`、`normalizeStatusRows`（:188） |
| `lib/host/status-board.js` | 会话状态的最后一格缓存：`set` / `snapshot` / `clear`，带快照自己的时间戳 |
| `lib/host/theme.js` | `THEME_TOKENS`、`isSafeTokenValue`、theme store |
| `lib/index.js:1914` | `POST /bridge/commands` |
| `lib/index.js:1927` | `GET /bridge/events`（SSE 主路径，见 §3） |
| `lib/index.js:1963` | `GET /bridge/poll`（轮询兜底，同一根总线） |
| `lib/client.js:11988` | `reportTheme()` + `resolveThemeValue()` + MutationObserver |
| `lib/client.js:886` | `subscribeBridge()`：SSE + `/bridge/poll`、`seq` 去重、宿主重启检测 |
| `lib/client.js:1170` | `requestDshRefresh()`：能拉就拉，拉不动就走桥 |
| `lib/client.js:2374` | 对等总线的 `BroadcastChannel`、`publishPeer()` / `subscribePeer()` / `subscribePeerStatus()` |
| `lib/client.js:2782` | `publishStatusSnapshot()`：两根管子一起发、去重、跨进程那条只在非窗口时发 |
| `lib/client.js:16080` | `apply()` 里对 `uiSession.sessionStatus` 的那次订阅（独立弹窗模式下唯一的发布点） |
| `lib/client.js:2823` | `useDshSessionStatus()`：本地表与 peer 表的合并（见 §7） |
| `lib/client.js:15814` | `apply()` 里装配桥与主题监听 |
| `assets/detached/shim.js` | 窗口的假 DSH 外壳、主题拉取、回声守卫 |
