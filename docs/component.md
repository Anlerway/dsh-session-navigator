# Electron 组件

独立弹窗需要一份 DSH 不会给的运行时：DSH 的桌面主进程禁掉了 `window.open`，也不把
`BrowserWindow` 暴露给插件。所以本插件自带一份**可选**的 Electron 运行时，由用户显式获取。
两条路，都由用户按下按钮：

1. **下载**。装在自己的目录里，带自己的固定校验和。
2. **借用**。机器上别的插件（比如 dsh-orb）已经装过一份 Electron 时，扫描出来、借它的可执行文件。
   只读：**不往那棵树里写一个字节**，卸载也只是忘掉这条记录（§8）。

DSH 没有提供"借用运行时"的接口（`ctx.sidebarRight.openTab("browser")` 只是 tab 宿主，不给插件
注入 Electron 或 Node），所以扫描是本插件自己用 `readdir` 做的有界遍历，见 §8。

五条设计规则（`src/component/layout.js`），其余模块都靠它们成立：

1. **从不隐式下载。** 缺席是正常状态，主插件在没有组件时完全可用。
2. **`ready` 意味着"能启动的东西确实在"。** 自己装的看标记文件 + 可执行文件，借来的看那棵树上的
   可执行文件还在（有探测，见 §8）。别的任何东西都无权宣称就绪。
3. **所有变更（install/cancel/remove）共用一把 promise 锁。** 两次点击不能交错，留下半个解压目录。
4. **失败的安装绝不删掉上一次能用的安装。** 新字节落在 staging，靠 rename 发布。
5. **借来的运行时只读。** 应用跟着自己的数据目录走，由命令行参数交进去；卸载只忘掉路径。

## 1. 装在哪

全部在插件数据目录下，所以一次数据目录迁移会把它一起搬走：

```
<dataDir>/component/
├── state.v1.json              生命周期记录
├── manifest.v1.json           装了什么、什么时候、从哪来
├── pending-cleanup.v1.json    删不掉的路径（少见），下次启动再扫
├── download/<asset>.part      可续传的下载体
├── download/<asset>.part.json { url, etag, received, totalBytes }
└── runtime-<stamp>/           一次安装一个**不可变**的运行时
    └── .complete-44.0.0       ← 标记：存在即 "ready"

<dataDir>/detached/helper-app/ 本插件的两文件应用（§6）。借用别人的运行时时，应用写在这里，
                               由命令行参数交给 Electron——它不在任何人的运行时目录里
```

借来的运行时**不在**这棵树里：它在别人的目录下，state 里只记一条绝对路径（`borrowed`）。
所以迁移数据目录搬不走它，也不需要搬——搬家只丢那条指针，重新扫一次就找回来。

**为什么运行时目录带版本戳。** 安装发布到一个全新的 `runtime-<stamp>` 并把 state 指过去，
不去 rename 覆盖 `runtime/`。Windows 在目录里**任何**文件被打开时都会拒绝 rename（EPERM）
或删除（EBUSY）——Defender 的扫描器、搜索索引、还没退出的 helper 都算。覆盖固定路径因此会
随机失败且无法恢复，而换一个新名字总是成功，旧目录留给后面扫。**从不把东西 rename 走。**

staging 目录故意放在 `component/` **外面**（`<dataDir>/.component-staging`）：
半解压的树留在里面会让"删除组件"失败在那些残留文件上，而用户没法删掉一个被告知"就是一个目录"的东西。

## 2. 版本与校验

| 项 | 值 |
|---|---|
| `ELECTRON_VERSION` | `44.0.0` |
| 资产名 | `electron-v44.0.0-<platform>-<arch>.zip` |
| 校验 | `PINNED_SHA256`，六个平台/架构各一个，抄自 Electron 官方 `SHASUMS256.txt` |
| 下载体积 | 157 455 369 B（约 150 MB） |
| 磁盘占用 | 383 650 096 B（约 366 MB） |

哈希不匹配会在**解压之前**中止安装，所以被截断或被篡改的下载永远不会被执行。
没有固定哈希的平台直接 `component-download-failed`（`no pinned checksum for <asset>`），
不会"跳过校验"。

## 3. 镜像

`MIRRORS`（`src/component/layout.js`），按顺序尝试：

| id | 前缀 |
|---|---|
| `mirror` | `https://cdn.npmmirror.com/binaries/electron/v44.0.0/` |
| `backup` | `https://mirrors.huaweicloud.com/electron/44.0.0/` |
| `npmreg` | `https://registry.npmmirror.com/-/binary/electron/v44.0.0/` |
| `github` | `https://github.com/electron/electron/releases/download/v44.0.0/` |

三个独立的国内镜像排在 GitHub 前面，因为 GitHub 的 release 下载在国内经常 302 到一个会卡住的 CDN。
它们提供的都是**同一份**官方 zip，固定 SHA-256 仍然会校验，所以镜像换不掉字节。
`install` 传 `source: "github"` 时顺序反转（`src/component/manager.js` 的 `install()` 里，`github` 把 `MIRRORS` 反过来遍历）。

**续传只能续同一个镜像**（`src/component/downloader.js`）：`.part.json` 里的 `url` 与当前
镜像不符时先删掉旧片段。另一个镜像的字节是另一条流，追加进去正是"续传出坏包"的成因。
镜像不支持 Range（对分段请求直接返回整个文件）时，清空重下一次。

下载用系统的 `curl` 子进程，`--progress` 由轮询 `.part` 的大小得到（`PROGRESS_INTERVAL_MS`），
不解析 curl 的输出。

**体积上限** 1 GiB（`MAX_ASSET_BYTES`，`src/component/downloader.js`）：`content-length`
超限在写第一个字节前就拒（`component-download-too-large`），实际落盘超限同样拒；curl 侧还有
`--max-filesize` 兜底。正常的 Electron 包约 110 MB，一个数量级的余量足够，同时把"被劫持的镜像
先写满磁盘再被摘要拒掉"变成"直接拒掉"。

## 4. 状态机

`PHASES`（`src/component/state.js`）：`absent` / `downloading` / `verifying` / `extracting` /
`ready` / `error`。未知 phase 降级成 `absent`，UI 不会去渲染一个不认识的状态。

一次 `install` 的顺序（`src/component/manager.js`）：

| # | 步骤 | 细节 |
|---|---|---|
| 0 | 单飞锁 | `run()` 里若已有操作在跑，直接 `component-busy`；不排队——点第二次的人想让第二下被忽略，不想让它稍后执行 |
| 1 | 复用检查 | 磁盘上已有带 marker + binary 的完整运行时就直接 `ready`，`source: "reuse"`。卸载被拒后字节还在，让用户为还在硬盘上的 150 MB 再下一次是说不过去的 |
| 2 | 磁盘检查 | 需要 `downloadBytes × 2.2 + 500 MB` 空闲，不够就 `component-disk-full`（507） |
| 3 | `downloading` | 依次试镜像，`AbortController` + 1 小时超时（`INSTALL_TIMEOUT_MS`） |
| 4 | `verifying` | `verifyZip()` 比对固定 SHA-256 |
| 5 | `extracting` | 先清空 staging（上次中断的残留），再解压——`tar` 用 `--exclude`、`unzip` 用 `-x` 跳过 `resources/default_app.asar`，`Expand-Archive` 没有排除开关，由 `dropExcluded` 用子进程事后删；最后写 helper 自己的 `resources/app`。之后必须能找到可执行文件，否则 `component-extract-failed`。解压子进程接同一个 `AbortSignal`，超时/取消会 `SIGKILL` 它，`tar` 不会在后台继续写 |
| 6 | 发布 | `publishRuntime()` 到 `runtime-<stamp>`，写 `manifest.v1.json`，删 `.part` 与 `.part.json` |
| 7 | 扫旧 | `sweepRuntimes()` 删旧运行时；删不掉的进 `pending-cleanup.v1.json` |
| 8 | `ready` | `receivedBytes: 0`，`source` 记录来源 |

取消（`component-cancelled`）回到 `absent` 且不留错误；其它失败进 `error` 并把消息写进 state。

`source` 因此有两种取值：`reuse` 是步骤 1 复用自己的残留安装，`borrowed` 是借用别人的运行时
（§8）。借用**不进上面任何一步**——不下载、不校验、不解压、不扫旧，只写一条记录。

**卸载前先关窗口，而且"关掉了"必须是真的**：`remove()` 调 `closeHelper()`（即
`api.detached.close()`），只有它返回 `true` 才继续（`src/component/manager.js`）。
`close()` 的返回值因此是"现在确实没有在跑的 helper"：先发 `close` 消息，1.5 秒后还在就 `SIGTERM`，
再 0.5 秒后还在就 `SIGKILL`，最后用 `exitCode !== null` 判断（`src/detached/launcher.js`）。
以前它无条件返回 `true`，于是一个不理会退出信号的窗口会让 `remove` 删掉它正在用的可执行文件。

## 5. 那个删不掉的 111 KB：已经不存在了

`resources/default_app.asar` 是每个官方 Electron zip 都带的 111 KB 应用包，唯一作用是"把命令行上
那个脚本跑起来"——本插件从来不用它。它曾经是运行时里**唯一删不掉的字节**：Electron 的 `node:fs`
把任何以 `.asar` 结尾的路径交给 asar 层，**连一次 `stat` 都会**打开文件，并把句柄缓存在进程里直到
进程退出；Windows 上 `rm` 遇到这种文件还会先读出来复制再删原文件，于是稳定 `EBUSY`。也就是说，
只要 DSH 读过一次组件状态（`directorySize()` 会 stat 每个文件），那个句柄就再也不会松开。

现在两边都堵住了：

1. **不装它**。`extractZip()` 给 `tar` 传 `--exclude resources/default_app.asar`，给 `unzip` 传
   `-x`；PowerShell 的 `Expand-Archive` 没有排除开关，解压后再用子进程 `del` 兜一次
   （`dropExcluded`）。用子进程是刻意的：它没有 asar 层。
2. **不碰它**。安装时写自己的两文件应用 `resources/app`（`installHelperApp`），Electron 启动时
   优先用它；`directorySize()` 跳过 `.asar`；删整棵树也交给子进程 `rmdir /s /q`
   （`removeTreeWithRmdir`）。DSH 进程里从头到尾没有一次 fs 调用落到 `.asar` 上。

旧版本装下的运行时里还有这个文件——它还在，但**现在谁都不打开它**，所以卸载时能正常删掉；
`isKnownUnremovable` 只作为兜底留着。`pending-cleanup.v1.json` 因此只剩"扫描器/索引器临时占用"
这一种来源，下次启动再扫一遍即可（仍是纯磁盘 JSON，读取时只接受 `component/` 之内的路径——
`readPending` + `src/paths.js` 的 `isInside`，坏文件不能让启动清理变成删任意目录）。

## 6. 窗口怎么起来

`src/detached/` 三件：

| 文件 | 职责 |
|---|---|
| `launcher.js` | 在 DSH 主进程这一侧 spawn / 聚焦 / 关闭窗口，持有 profile 键 |
| `main.cjs` | Electron 侧的窗口本体（`.cjs` 后缀是刻意的：包里 `"type": "module"`，`.js` 会被当 ESM 加载，`require("electron")` 直接抛 `require is not defined in ES module scope`） |
| `preload.cjs` | 预加载：把窗口需要的最小 API 注入页面 |

`component.binary` 解析的是**已安装**那个带戳的目录；`component.paths.binary` 是没戳的默认值，
一次安装发布之后那个路径根本不存在。把默认值交给 launcher 会 spawn 一个不存在的路径，
而失败表现为"窗口永远打不开"——子进程在能报告任何东西之前就退出了。

**启动命令行里不再带脚本路径。** `electron.exe <script>` 这种模式是 `default_app.asar` 提供的，
而这个文件已经不装了（§5）。所以安装写的是一个两文件应用 `resources/app`：

| 文件 | 内容 |
|---|---|
| `resources/app/package.json` | `{"name": "dsh-session-navigator-helper", "main": "main.cjs"}` |
| `resources/app/main.cjs` | `require` 仓库里的 `src/detached/main.cjs`，**绝对路径** |

Electron 在没有命令行路径时去 `resources/app` 找应用，而且它**优先于** `default_app.asar`——
所以同一行命令既服务新运行时，也服务旧版本装下的（还带着 bundle 的）运行时。
staging 里就把 app 写好，跟着树一起 rename 发布；每次 `launch()` 会再刷一遍，于是升级前的
运行时也不用重下。入口路径走 `DSH_SE_HELPER_MAIN` 环境变量，不拼进 `package.json`。

绝对路径是必须的：shim 在 `resources/app/` 里，`require("./main.cjs")` 会解析到它自己。
同理不能把绝对 `main.cjs` 交给 `package.json`——`main` 会在 app 目录里解析
（`ERROR: File "…\\lib\\detached\\main.cjs" ("main.mjs") not found`），这也是那个 shim 存在的原因。

**借来的运行时不写 `resources/app`。** 那棵树属于别的插件，往里写等于替它升级。借用时同一个两文件
应用写在 `<dataDir>/detached/helper-app`，并作为**第一个命令行参数**交进去：

```
electron.exe <dataDir>\detached\helper-app --user-data-dir=<dataDir>\detached\chromium\<profile>
```

Electron 的第一个参数是目录时按应用加载，所以借来的树一个字节都不用变——它自己的
`resources/default_app.asar` 或 `resources/app` 都不被使用，也不被打开（拼参数的那段在 `src/detached/launcher.js`）。

还有一处必须显式清掉的环境变量：DSH 桌面版自己是带着 `ELECTRON_RUN_AS_NODE=1` 跑的，子进程会
继承它，于是"窗口"变成一个跑完就退的纯 Node 进程。`launch()` 里 `delete env.ELECTRON_RUN_AS_NODE`。

窗口通过 `onEvent` 把 `hello` / `closed` 报告给 host，host 再转成总线上的 `window-open` /
`window-closed`（`src/index.js`）。窗口的 OS 层面知识只有那个进程有，走同一条总线意味着
面板不需要第二条通道。

## 7. 相关文件

| 文件 | 职责 |
|---|---|
| `src/component/layout.js` | 版本、固定哈希、镜像、路径表、体积常量 |
| `src/component/state.js` | phase 集合、state 的读写与归一化、进度写入节流 |
| `src/component/downloader.js` | curl 下载、续传、镜像切换、进度轮询 |
| `src/component/install.js` | `verifyZip` / `extractZip` / `writeHelperApp` / `installHelperApp` / `publishRuntime` / `removeTree` / `freeBytes` |
| `src/component/borrow.js` | 借用：`borrowedPaths` / `inspectBorrowed` / `scanBorrowedRuntimes`（只 `readdir`，不碰 `.asar`） |
| `src/component/manager.js` | 单飞状态机、`status()`、`scan()`、`install` / `cancel` / `remove` / `retry`、pending 清扫 |
| `src/detached/launcher.js` | spawn / 聚焦 / 关闭；spawn 前刷 `resources/app`（借来的刷 `helper-app`） |
| `src/detached/main.cjs` | Electron 窗口 |
| `src/detached/preload.cjs` | 预加载注入 |
## 8. 借来的运行时

机器上常常已经有 Electron 了：dsh-orb 之类的插件自己就装了一份。为同一个窗口再下 150 MB 说不过去，
所以设置页有个 **扫描其它插件** 按钮（`GET /component/scan`），把候选列出来，用户挑一个 **借用**。

**扫描是只读的，而且很小。** `scanBorrowedRuntimes()`（`src/component/borrow.js`）从 DSH 的主目录
（`dshHome()`：`$DSH_HOME` 或 `~/.dsh`）开始做**宽度优先、最多 3 层**的 `readdir` 遍历：

| 规则 | 理由 |
|---|---|
| 命中就停止下钻 | 一棵运行时下面还有几万个文件，进去只会让扫描变慢 |
| 跳过 `sessions` / `storages` / `cache` / `profiles` / `node_modules` / `attachments` / `skills` 等 | 这些目录与运行时无关，且可能极大 |
| 跳过以 `.` 开头的目录 | 半成品与临时目录 |
| 只 `readdir`，不 `stat` 任何 `.asar` | §5 的 EBUSY 就是这么来的：`stat` 一个 `.asar` 会在 DSH 进程里缓存句柄直到退出 |

一个目录要同时满足三条才算候选项（`inspectBorrowed`）：

1. 平台对应的可执行文件在（win32 `electron.exe`、darwin `Electron.app` 目录、其它 `electron`）；
2. `resources/` 目录在；
3. 能从 `version` / `version.json` 里解析出一个版本号——列表里要显示"哪一份更新"，猜是没意义的。

**借用本身**是 `POST /component/install` 带 `{ borrowed: "<绝对路径>" }`（不是新路由：状态机只有一台）。
它先复验（目录可能在这几秒里被删掉）、拒绝数据目录内部的路径，然后只做两件事：把两文件应用写到
`<dataDir>/detached/helper-app`，把 state 写成 `{ phase: "ready", source: "borrowed", borrowed: <绝对路径> }`。
失败一律 `component-borrow-invalid`（400），不是 500——路径不对是用户的选择带来的，不是服务器坏了。

**状态不靠标记文件。** 借来的树上没有 `.complete-44.0.0`，所以 `reconcile()` 每次都用
`inspectBorrowed()` 探一次那条记录里的路径：还在就 `ready`（版本号就地更新，别的插件升级了我们也跟着升），
不在了就降级成 `absent` 并**清掉记录**：`borrowed` 与 `source` 一起归 `null`，落盘结果和 `remove()` 走
`emptyState()` 一模一样——那棵树被别人删了，我们没有任何理由继续声称就绪，也不该留着"它从哪来"的旧答案。
`status()` 对借来的运行时**不统计体积**（`sizeBytes: 0`）：为了一个数字去遍历别人 400 MB 的树不值得。

**卸载 = 断开借用。** `remove()` 遇到 `state.borrowed` 只删自己的 `helper-app` 和那条记录，一个
`rm` 都不会落到被借的树上；按钮文案也换成了"断开借用"。这也是借用与 `reuse` 的分界：`reuse` 复用的是
**我们自己的**残留，可以删；借来的永远是别人的。

