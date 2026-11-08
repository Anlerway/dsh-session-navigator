# 开发文档

这套文档是**照代码写的**，不是照设计稿写的。每一条规则都指到具体的文件与符号（函数名、常量名、
路由键）。行号一次插入就会错，所以不写行号；计数会随代码漂，所以「八十二个测试文件」「83 条路由」
这类数字也由 `scripts/check-docs.mjs` 现算现比，对不上就红。

## 读的顺序

| 文档 | 讲什么 | 什么时候读 |
|---|---|---|
| [architecture.md](architecture.md) | 两半结构、一次请求怎么走完、读管道与缓存、硬约束 | 第一次进这个仓库 |
| [api.md](api.md) | 83 条 HTTP 路由、信封、错误码表、乐观锁 | 改 host 或写客户端调用 |
| [data-directory.md](data-directory.md) | 数据目录布局、四份侧车、原子写、回收站、迁移 | 改存储、调试"数据不见了" |
| [tree-and-placement.md](tree-and-placement.md) | 节点种类、R1–R5、计数、虚拟放置、快捷方式、置顶与快速访问、批量动作 | 改左侧树或拖拽 |
| [bridge-and-theme.md](bridge-and-theme.md) | 面板 ↔ 窗口的命令总线、SSE、主题同步 | 改独立窗口或配色 |
| [component.md](component.md) | Electron 组件：状态机、镜像、校验、发布、清扫 | 改安装流程 |
| [i18n.md](i18n.md) | 十种语言的词典、清单的几份副本、`uiLang()` 与 `aiLang()`、插件自己的界面语言（`ui.lang`）、加一门语言的步骤 | 改界面文案或加语言 |
| [testing.md](testing.md) | 八十二个测试文件各钉住什么、怎么跑 | 提交之前 |

## 三条最容易被违反的约定

1. **不重构 `sessions/` 的物理布局。** 移动会话是唯一改文件的操作，走
   `src/host/move.js` 的三件事一个事务；"换个分组"用侧车覆盖（`sessionPlacement`），不动字节。
2. **规则只有一份。** `src/domain/tree-rules.js` 拥有全部树规则；`lib/client.js` 只读 host 算好的
   字段，不持有任何决策表。历史上三份规则漂移过一次，`test/tree-mirror.test.mjs` 就是为那次写的。
3. **侧车只存 DSH 不知道的东西。** 标题、cwd、归档集、置顶集每次从 DSH 读；侧车删掉也不会丢会话。

## 源码地图

```
src/
  index.js            83 条路由的键、分发、错误映射、apply() 装配（668 行）
  routes/             路由表按域拆开：library / folders / layout / settings /
                      summaries / release / maintenance / sessions / tools /
                      bridge / detached / assets，外加 shared（助手）、
                      dispatch-support（鉴权与写信封）
  plugin-runtime.js   apply() 用到的运行期工具：log、sessionForSummary、readOverlay、
                      runningSessionIds、createIndexBuilder、searchSessionContent
  errors.js           错误码表：statusFor 查表、normalizeCode 兼容两种拼写
  validate.js         请求体校验：requireText / requireEnum / requireIdArray / …
  lang.js             界面语言的唯一清单 LANGS 与 normalizeLang
  http.js             信封与请求体解析
  constants.js        API 前缀、插件 id、固定节点 id
  capabilities.js     对宿主服务的防御式探测
  paths.js            数据目录解析（env → settings → .location）
  fs.js               存在与列举：宿主与组件安装共用的两个文件判断
  domain/             纯规则：tree-rules / tree / folders / shortcuts / sessions /
                      annotations / settings / trash / export / session-state
  sources/            读管道：heads（zstd 扫描）、projcache、reader、artifact、workspaces、
                      content（会话内容索引，落盘复用）
  store/              sidecar（原子写 + revision）、documents（四份文档）
  host/               actions、trash、move、datadir、bridge、theme、
                      update（更新检查）、open-link（链接白名单）、maintenance（缓存清理）、
                      reset（清除数据，唯一不可逆的操作）
  component/          Electron 组件：layout、state、downloader、install、manager
  detached/           Electron helper：launcher、main.cjs、preload.cjs
  client/             面板源码：33 个分片与 manifest.json（构建输入）
lib/
  client.js           面板与设置页的产物，由那 33 个分片拼成（gitignore，不入库）
scripts/              零依赖闸门：build-client（拼接与 --check）、lint、check-docs、
                      check-prose、check-file-size、check-i18n
assets/detached/      独立窗口的页面：index.html、window.css、shim.js（不自带 UI）
assets/panel.css      面板样式（构建期内联）
assets/i18n/          每种语言一份词典（构建期内联）
assets/vendor/        自带 React 18.3.1 UMD 构建（无构建步骤的前提）
test/                 82 个测试文件 + render-smoke
```

`client.js` 是**刻意的**单文件产物：DSH 只给一个 `window.__ModuleLoader__.load({ id, factory })` 入口，
它必须自带全部代码。源在 `src/client/` 的 33 个分片里，由 `scripts/build-client.mjs` 顺序拼接
（零依赖，没有打包器）。产物**不进仓库**：CI 跑测试前构建，`npm test` 走 `pretest`，`prepack`
构建进 tarball；本地想确认磁盘上的产物是否还跟得上分片，用 `--check`。

`src/` 是源，`lib/` 只剩那一个产物；源还有两处在别的地方：样式在 `assets/panel.css`、词典在
`assets/i18n/<code>.json`，都在构建期内联进 `client.js`。
