# 会话资源管理器 · 资源介绍

> 像 Windows 资源管理器那样管理 DSH 的会话，让会话管理像文件管理那样简单。
> 不改变会话文件的物理位置，只在 `~/.dsh-session-navigator/` 记一份索引——记录文件夹、名称、标签、备注。

| 项目 | 内容 |
| --- | --- |
| 包名 | `dsh-session-navigator`（npm） |
| 版本 | 1.2.0 |
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

## 本版更新（1.2.0）

- 悬浮球入口：侧栏按钮之外多一个可拖动的球，抛出会落下、弹跳；五种样式在设置 › 入口设置里切换
- 独立窗口默认开启 GPU 加速，显卡或驱动不支持时自动改用软件渲染
- 独立窗口可以跟随 dsh-plugin-wallpaper-engine 的壁纸，也能上传自己的图片或视频，模糊、磨砂、暗度可调
- 冷启动从 3.1 秒降到 0.12 秒（两千个会话）
- 界面新增八种语言，共十种：日、韩、德、法、西、俄、葡、繁體中文
- 弹窗统一改用 DSH 原生弹窗；缺运行环境时直接提示下载；数据目录可还原默认

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
so uninstalling means deleting one folder. Version 1.2.0 adds a throwable floating-ball entry, GPU-accelerated
rendering in the detached window, and wallpaper support that follows dsh-plugin-wallpaper-engine or your own
image. Zero runtime dependencies, no build step, MIT.

```bash
dsh plugin --profile web add dsh-session-navigator
```
