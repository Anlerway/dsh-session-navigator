<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/docs/assets/readme/header.png" alt="会话资源管理器 · dsh-session-navigator" width="720">
</p>

<p align="center">
  <strong>中文</strong> | <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-session-navigator"><img alt="npm" src="https://img.shields.io/npm/v/dsh-session-navigator?style=flat-square&color=6c5ce7"></a>
  <a href="https://www.npmjs.com/package/dsh-session-navigator"><img alt="npm downloads" src="https://img.shields.io/npm/dm/dsh-session-navigator?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/Anlerway/dsh-session-navigator/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Anlerway/dsh-session-navigator?style=flat-square&color=eab308"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/dsh-session-navigator?style=flat-square&color=22c55e"></a>
  <a href="https://dsh-plugin.org/plugins/anlerway/dsh-session-navigator"><img alt="listed on dsh-plugin.org" src="https://dsh-plugin.org/badges/listed.svg"></a>
</p>

# 会话资源管理器

像 Windows 资源管理器那样管理 DSH 的会话，让会话管理像文件管理那样简单。

不改变会话文件的物理位置，在 `~/.dsh-session-navigator/` 记一份索引——记录文件夹、名称、标签、备注。

**适用**：多会话用户：得心应手的对您的会话和工作区分类，移动，删除，备注，重命名，也可以待办，收藏，置顶您的会话，让会话管理像文件管理那样简单。

- 目录树按工作区自动生成，自己可以新建文件夹无限嵌套，会话工作区支持拖进拖出
- 标题、标签、备注随心所欲的自定义
- 搜索支持标题、备注、标签，并可勾选「会话内容」检索对话正文；搜索始终是整库范围，不受当前所在目录限制
- 收藏、待办、置顶、归档；配备回收站，删除后有后悔药
- 跨工作区剪切粘贴；会话内容可自由导出 Markdown 或 JSONL，供其他会话使用

## 界面介绍

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/float.png" width="880" alt="浮窗模式">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/filter.png" width="600" alt="筛选">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/settings.png" width="560" alt="设置界面">
</p>

浮窗模式太小，不方便，不过瘾？别急，我们还有独立弹窗——真正像资源管理器那样

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/window.png" width="900" alt="独立窗口全屏">
</p>

当然，也可以进行分屏/多屏协作

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/split.png" width="900" alt="DSH 聊天在左，会话资源管理器停靠在右，两边各自独立">
</p>

<p align="center"><em>分屏模式</em></p>

## 安装

### 快速开始（推荐）

DSH 的插件页 → 「添加插件」→ 输入包名 `dsh-session-navigator` → 安装 → 重启 DSH。

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/install.png" width="560" alt="DSH 的「添加插件」对话框，输入 dsh-session-navigator 后点安装">
</p>

### 命令行安装

Web:

```powershell
dsh plugin --profile web add dsh-session-navigator
```

Desktop:

```powershell
dsh plugin --profile desktop add dsh-session-navigator
```

### 从 Github 源码安装

Web

```powershell
dsh plugin --profile web add github:Anlerway/dsh-session-navigator
```

Desktop

```powershell
dsh plugin --profile desktop add github:Anlerway/dsh-session-navigator
```

### 从本地安装

下载资源：[最新版本安装包](https://github.com/Anlerway/dsh-session-navigator/releases/latest)

```powershell
dsh plugin --profile web add '<实际路径>'
```

### 更新

Web

```powershell
dsh plugin --profile web add dsh-session-navigator@latest
```

Desktop

```powershell
dsh plugin --profile desktop add dsh-session-navigator@latest
```

### 卸载

Web

```powershell
dsh plugin --profile web remove dsh-session-navigator
```

Desktop

```powershell
dsh plugin --profile desktop remove dsh-session-navigator
```

插件自己的数据不会跟着删，如果要清理干净，需要删掉 `~/.dsh-session-navigator/`

需要 Node.js `^22.15.0 || >=24.0.0`。

## 功能

| 目录 | 操作 |
| --- | --- |
| 给会话分组 | 工作区里新建文件夹，拖到文件夹内 |
| 改名字 | 点击编辑按钮或在右侧详情页编辑 |
| 加标签 / 写备注 | 右侧详情栏；标签可以预制 |
| 搜索查找 | 搜索框搜标题、备注、标签，点搜索框右侧的漏斗可以加搜「会话内容」；不管站在哪个目录，搜的都是整个库；「筛选」按收藏、归档、待办、标签 |
| 收藏 / 待办 | 选中后收藏 / 加入待办；两个页面里指向文件夹或工作区的条目就是那个容器，双击回到原位置（双击要两次按下都在 400ms 内，慢拍的两下只算两次单击） |
| 快捷方式 | 右键「在本目录生成快捷方式」，把会话或目录放进当前容器；删掉只去掉这条引用 |
| 置顶 | 文件夹和工作区可以置顶到本来的位置最前面，同步到 DSH 自己置顶的会话；树里带图钉标记 |
| 快速访问 | 把文件夹 / 工作区拖到「快速访问」带，作为第二个入口；带里的行就是那个文件夹，拖东西进去＝放进它 |
| 多选 | 勾选多行后右键，一次收藏 / 待办 / 置顶 / 归档 / 快速访问 / 复制 / 删除；也可以在列表空白处（或任何没选中的行上）按住鼠标拖出一个框，框住的行一起勾上，点一下空白处取消勾选。拖动只搬已经选中 / 勾选的行，没选中的行一拖就是框选；勾了几行就整批搬走（会话与文件夹可以混着勾，落到哪里就取那里收得下的那一半） |
| 归档 | 默认在列表底部；设置里可以关掉显示 |
| 删除 | 整个会话目录移进回收站，可还原、可清空 |
| 换工作区 | 跨工作区剪切 / 粘贴，标签备注跟着走 |
| 会话导出 | 详情栏和右键菜单，导出为Markdown 或 JSONL |

## 配置

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/settings.png" width="560" alt="设置界面">
</p>

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 打开方式 | 浮窗 | 浮窗 / 独立弹窗。独立弹窗需要额外下载浏览器组件，仅支持 Windows |
| 会话标题栏按钮样式 | 自动 | 也能固定只显示图标 |
| 自动折叠 | 关 | 进入一个文件夹后，收起它的同级目录 |
| 显示已归档 | 开 | 关掉后归档会话不再列在底部 |
| 过滤空会话 | 开 | 没开始过任何一轮的会话不列出来 |
| 折叠子智能体 | 开 | 可点箭头展开 |
| 日期格式 | 详细日期 | 或距今时间 |
| 大小单位 | 自动转换 | 在 B / KB / MB / GB 切换；也能固定 KB |
| 搜索索引缓存 | 开 | 建好的会话内容索引落盘（`content-index.v1.json`），重启后不必重读日志；关掉即不再读写这份文件 |
| 空闲时自动建立索引 | 关 | 打开后，启动完在后台一点点把索引建起来，不挡任何请求 |
| 重建 / 删除索引 | — | 两枚按钮：从头重建（答案逐步变全）或删掉缓存文件（省一百多 MB） |
| 数据目录 | `~/.dsh-session-navigator` | 迁移用，可在设置里改 |

## 文档

- [架构](docs/architecture.md) · [HTTP 接口](docs/api.md) · [数据目录](docs/data-directory.md)
- [树的规则](docs/tree-and-placement.md) · [独立窗口组件](docs/component.md) · [主题与桥接](docs/bridge-and-theme.md)
- [测试](docs/testing.md) · [文档索引](docs/README.md)

## 开发与测试

零运行时依赖，`lib/` 直接跟着仓库走，没有构建步骤。

```powershell
node --test "test/*.test.mjs"   # 471 个用例
node test/render-smoke.mjs      # 渲染冒烟
```

CI 只跑 Windows（`windows-latest`，Node 22 和 24），因为发布目标是 DSH 桌面版，独立窗口的资产名是 win32 的。macOS 和 Linux 没测。

## issue

如果您需要macOS和Linux下的适配，或遇到一些使用bug，或你需要新增的功能，请在issue提出

## 许可证

MIT，见 [LICENSE](LICENSE)。
