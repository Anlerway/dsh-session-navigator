# 会话资源管理器 · 资源介绍

> 像 Windows 资源管理器那样管理 DSH 的会话，让会话管理像文件管理那样简单。
> 不改变会话文件的物理位置，只在 `~/.dsh-session-navigator/` 记一份索引——记录文件夹、名称、标签、备注。

| 项目 | 内容 |
| --- | --- |
| 包名 | `dsh-session-navigator`（npm） |
| 版本 | 1.2.1 |
| 仓库 | https://github.com/Anlerway/dsh-session-navigator |
| 发行包 | [Releases 最新版](https://github.com/Anlerway/dsh-session-navigator/releases/latest) |
| 许可 | MIT |
| 运行要求 | Node `^22.15.0 \|\| >=24.0.0`；DSH 版本不限 |

## 能做什么

- 目录树按工作区自动生成，自己可以新建文件夹无限嵌套，会话工作区支持拖进拖出
- 标题、标签、备注随心所欲的自定义
- 搜索支持标题、备注、标签，并可检索会话正文（用户说的与助手回复的）
- 所有会话 按工作区切成一段一段，标题就是工作区名字；点标题收起整段，折叠状态跟着布局记忆一起保存
- 收藏、待办、置顶、归档；配备回收站，删除后有后悔药
- 跨工作区剪切粘贴；会话可导出 Markdown 或 JSONL：用户的话、助手的回复、每次工具调用与输出，压缩过的历史按原文保留
- 侧栏按钮之外还有一个悬浮球入口，拖得动、抛得出，落下会弹跳；五种样式可选
- 独立窗口默认 GPU 加速，背景可跟随 dsh-plugin-wallpaper-engine，也能换成自己的图片或视频

## 界面

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/float.png" width="880" alt="浮窗模式">
</p>
<p align="center"><em>浮窗模式：面板浮在聊天之上，随时打开，随时收起</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/window.png" width="900" alt="独立窗口全屏">
</p>
<p align="center"><em>独立窗口：真正像资源管理器，树、列表、详情一起铺开</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/Anlerway/dsh-session-navigator/main/assets/screenshots/split.png" width="900" alt="DSH 聊天在左，会话资源管理器停靠在右，两边各自独立">
</p>
<p align="center"><em>分屏：聊天在左，资源管理器停靠在右，两边各自独立</em></p>

## 本版更新（1.2.1）

- 修复了移动母会话，子会话还停留在原地的bug
- 修复了悬浮球因窗口缩放导致的位置变动的问题
- 解锁了子会话可以拖动、勾选、剪切、复制的功能
- 修复了会话被打开的过于严格的判断
- 修复了工作区的（真实）文件夹被删掉，会被当成「工作区不存在」的问题
- 删除会话时一并清掉插件里属于它的索引及其缓存
- 新增清除缓存会检查并清理无目标指向的索引及其缓存

## 安装

**1）DSH 插件页**：插件页 → 「添加插件」→ 输入包名 `dsh-session-navigator` → 安装 → 重启 DSH。

**2）命令行**

```powershell
dsh plugin --profile web add dsh-session-navigator      # Web 版
dsh plugin --profile desktop add dsh-session-navigator  # 桌面版
```

**3）本地装**：从 [Releases 最新版](https://github.com/Anlerway/dsh-session-navigator/releases/latest) 下载 `.tgz`，再 `dsh plugin --profile web add '<绝对路径>'`。

## 数据

- 全部状态在 `~/.dsh-session-navigator/`——`~/.dsh` 的兄弟目录，不是子目录，卸载插件就是删一个目录。
- 不联网，没有遥测。
- 零运行时依赖，没有构建步骤，`src/` 直接跟着仓库走。

## English summary

Session Navigator manages DSH sessions the way Windows Explorer manages files: a folder tree
per workspace, tags, notes, favourites and a recycle bin on top of the native session store.
The "All sessions" view is cut into one band per workspace, each caption foldable.
Session files never move — all state lives in `~/.dsh-session-navigator/`, a sibling of `~/.dsh`,
so uninstalling means deleting one folder. Version 1.2.1 moves a parent's child sessions along with it,
keeps the floating ball where it was when the window is resized, lets child sessions be dragged, ticked,
cut and copied, moves open-but-idle sessions instead of refusing them, re-creates a workspace folder that
was deleted, and clears a session's index and cache — orphans included — when the session is deleted.
Zero runtime dependencies, no build step, MIT.

```bash
dsh plugin --profile web add dsh-session-navigator
```
