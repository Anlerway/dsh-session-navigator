# 树与放置

左侧那棵树不是 DSH 的树。DSH 只认识 **workspace** 和 **session** 两种东西；这棵树是它们加上
用户自己造的节点（文件夹、快捷方式）的一个投影，**由 host 每次请求重建**，只有用户造的部分落盘。

规则集中在 `lib/domain/tree-rules.js`，`lib/client.js` 里**没有任何决策表**——它只读节点上算好的
字段（`accepts` / `scope` / `hasWorkspace`）和两条形状（子树、父链）。三处各写一份规则是 bug
生成器，所以规则只有一份。

## 1. 节点种类

`NODE_KINDS`（`lib/domain/tree-rules.js:36`）：

| kind | id | 能装目录 | 能装会话 | 说明 |
|---|---|---|---|---|
| `root` | `f-root` | ✅ | ❌ | 只装目录；徽章是活跃会话总数 |
| `all` | `f-all` | ❌ | 视图 | 所有活跃会话的平铺视图 |
| `ungrouped` | `f-ungrouped` | ✅ | ✅ | 真容器：没有 workspace 的会话的家 |
| `todos` | `f-todos` | ❌ | 快捷方式 | 引用容器 |
| `favorites` | `f-favorites` | ❌ | 快捷方式 | 引用容器 |
| `trash` | `f-trash` | ❌ | 回收站 | 根节点之外唯一的分支 |
| `folder` | `d-…` | ✅ | ❌ | 用户建的目录 |
| `workspace` | `w-…` | ✅ | ✅ | DSH workspace 的投影 |
| `shortcut` | `s-…` | ❌ | 视 target 而定 | 引用，永不移动目标 |

`roots` 是 `["f-root", "f-trash"]`——回收站故意不在根下面，它是另一个分支。

## 2. 五条承重规则

每条都在 `test/tree.test.mjs` 里有覆盖。

| 规则 | 内容 | 代码 |
|---|---|---|
| **R1** | workspace 永不嵌进另一个 workspace；文件夹可以夹在根与 workspace 之间，但夹不到两个 workspace 之间 | `canMove()` 用祖先链判断"里面"，因为经过文件夹仍然算嵌套 |
| **R2** | 会话的容器是它的 workspace 节点；没有 workspace 就是 `f-ungrouped` | `placementOfNode()` |
| **R3** | 会话只在它的绝对位置出现，也只在那里被列为一行 | `placementOfNode()` 是唯一的家；`sessionsOfNode()` 画这一层，`sessionsUnderNode()` 数子树 |
| **R4** | 收藏/待办装的是快捷方式（引用）而不是会话；引用不改变总数，根目录自己也不装会话 | `counts[...]` 的赋值 |
| **R5** | 父节点消失的**目录**降级到根，而不是让子树变孤儿；环永远构造不出来 | `folderParent()` |

R5 的降级是**纯函数**：`folderParent()` 只依赖 `folders` 表，与迭代顺序无关。
父节点缺失、父节点不是文件夹、父链成环，三种情况一律回落到 `f-root`。

降级只适用于文件夹和 workspace。**引用不降级**：`f-root` 装的是目录（`canHoldShortcuts(f-root)`
为假），所以把一条父节点已消失的快捷方式挂到根上，只会得到一行没有任何分支渲染、也没有任何手势
能删掉的行（`lib/domain/tree.js:278-296`）。这种情况直接不建这一行；容器消失时 host 会先把里面的
引用上提（删文件夹 → 父节点，父节点是根则进 `f-收藏`；删 workspace → `f-收藏`）。

## 3. 徽章数的是子树，列表画的是这一层

这两个问题不一样，于是有两个函数：

```js
// 这一层的行：只算"家在它自己身上"的会话
const holder = node.kind === NODE_KINDS.shortcut ? node.ref ?? nodeId : nodeId;
return live.filter((session) => placementOfNode(session, tree) === holder);

// 徽章：它下面（含自己）一共有多少会话
return live.filter((session) => ids.has(placementOfNode(session, tree)));
```

`buildTree()` 的计数用后者，再加上子树里的引用行：

```js
counts[id] = sessionsUnderNode(id, view, treeLike, { trashedIds: trashed }).length + shortcutRowsWithin(id);
```

**会话只在它的绝对位置出现一次。** 站在一个文件夹里，看到的是这个文件夹*装的东西*——子文件夹、
workspace、引用行——而不是把里面 workspace 的会话翻上来跟 workspace 并排：那样文件夹看起来像自己
持有这些会话，而且两层看起来一模一样（m03586/m03587）。会话在自己的 workspace 页里出现，那里的
面包屑和详情卡给出它的绝对路径；`sessionPlacement` 指向文件夹的会话显示在那个文件夹里。

数字仍然说"这里下面有多少会话"，像目录旁边的文件计数——`f-root` 一直是这样（列表是目录，数字是
活跃会话总数），文件夹只是把同一个问题往下一层问。所以数字可以大于这一层的行数，绝不会小于：
一个只装着 workspace 的文件夹写 4，那 4 条会话在那个 workspace 页里。四个例外各自有意义：

- `f-root` 的列表是目录（空），但数字是活跃会话总数——那正是它旁边那个数的意思；
- `f-favorites` / `f-todos` = 带标记的会话数 + 指向会话的快捷方式行数；
- `f-trash` = 回收站条目数；
- 快捷方式：指向会话的是 1 行；指向文件夹/workspace 的显示目标的大小，否则那个数字会看起来像 0。

在这之前还有一道前置：**看不见的会话不计数**。`buildTree()` 先把 `sessions` 按 `listSettings.hideBlank`
过一遍，计数用的是"列表真正会画"的那个集合（`lib/domain/tree.js:149`）：

```js
const shown = listSettings?.hideBlank === false ? live : live.filter((session) => session.blank !== true);
```

过滤空会话是视图设置，不是删除——关掉它，数字立刻回来。之所以修在 host 而不是 client：徽章比行多，
就是 R2/R3 禁止的那种"两处各算一次"，只不过差了一步。

## 4. 会话放置（`sessionPlacement`）

**核心矛盾**：DSH 从 header 的 `cwd` 推导会话属于哪个 workspace。要改变这个归属，唯一物理手段
是搬目录——而"不重构 `sessions/`"是本插件的第一条硬约束。

于是有了这层覆盖：`sessionPlacement[sessionId] = 节点 id`，只影响**分组**，不动一个字节。

```
解析顺序（placementOfNode）
  sessionPlacement[id] 存在且节点还在  → 用它
  会话有 workspaceId                    → w-<workspaceId>
  会话没有 workspaceId                  → f-ungrouped
  有 workspaceId 但那个 workspace 没了   → null（只出现在"所有会话"里）
```

`buildTree()` 把结果一次性算进 `sessionHome`，随每个会话下发，客户端不重放这个判断（R2）。
`homeOverride` 标记"这是虚拟放置而不是 DSH 自己的归属"。

**跨 workspace 拖会话**因此有两条路：真的搬（`POST /move`，改文件）或只改分组
（`POST /sessions/placement`，改侧车）。前者是移动，后者是重命名一个视图。

## 5. 快捷方式

`lib/domain/shortcuts.js`。一条快捷方式是**自己的节点**，`targetId` 永远在目标自己的 id 空间里：
文件夹 `d-…`、workspace 去掉 `w-` 前缀、会话原样。

三条约束：

1. 快捷方式加在真容器**之后**，所以它永远不会遮蔽一个真 id；
2. 它不给父节点贡献会话数（R4）——同一个会话在它家出现一次，在每个引用处各出现一次；
3. 引用不能活得比目标久。指向会话的引用在会话进回收站时**保留**（会话还能回来），
   一旦 payload 真的没了（清空回收站，或用户手工删了目录），这条引用就消失——
   否则用户会得到一行点了没反应、又不允许删的行。host 在 purge 时顺手清侧车，
   保证下次重建不会把它带回来。同样地，指向文件夹/workspace 的引用在目标不存在时也不建行
   （`lib/domain/tree.js:289-291`）；而引用的**容器**不存在时也不建行，见 §2 的 R5 说明。

标签不在快捷方式上：`name` 留空，客户端从目标解析，所以目标改名后引用自动跟上。

### 5.1 收藏 / 待办 里的成员显示成它引用的东西

收藏或待办里一条指向**文件夹 / workspace** 的成员，在页面上画成那个容器本身：目标的图标与名字、
`工作区` / `文件夹` 标签，行 id 仍然是快捷方式的 `s-…`。所以移出、清空只删成员关系，永远不动原容器；
双击进它的原位置，右键只有 `跳转到原位置` / `移出`。

指向**会话**的成员不再多画一行：会话自己的 `favorite` / `todo` 就是这条成员关系——`lib/sources/reader.js`
用 `shortcutTargetsIn(...)` 推导，注解里的旧标记由 `lib/host/flags.js` 在启动时迁移成快捷方式（写树在前、
清标记在后，写失败就留着旧标记）。于是同一个会话可以同时在收藏和待办里，而回收站里那一份文件一个字节都没变。

`转到会话原位置` 只在这两个页面里、且只在会话行上出现：它把列表切到会话的 `home` 再选中它。
`在本目录生成快捷方式` 是原来那个「发送到」子菜单的替代，只做一件事——把当前这条会话 / 目录放进**当前所在的
容器**。收藏 / 待办里没有这一项（那里的行是成员关系，不是容器），根目录与所有会话也没有（它们不装引用），
放不下的位置会直接说清楚，而不是悄悄回落到收藏。

## 6. 置顶

DSH 置顶的是**会话**；这里还有容器置顶（文件夹、workspace），存在树的侧车里
（`pins[id] = 时间戳`），按时间倒序。两块合起来是视觉上的同一条置顶带，但它们来自两套存储，
所以 `/bootstrap` 里 `pinnedSessionIds` 和 `tree.pinnedNodes` 是分开的两个字段。

树里的已置顶行在名字后面带一个小图钉（`.tpin`，10px，accent 色）：行**留在原地**、只是排到兄弟最前，
别的什么都不变，所以图钉就是全部的可见差别。列表行本来就有同样的标记，两边从此一致。

## 7. 移动的合法目标

`acceptsOf(nodeId, tree)` 返回四个布尔，客户端直接照它涂色：

| 字段 | 含义 |
|---|---|
| `accepts.folder` | 目录（文件夹/workspace）能不能落在这里 |
| `accepts.workspace` | 带着 workspace 的目录能不能落在这里（R1 从目标侧问） |
| `accepts.session` | 会话能不能放在这里（只有 workspace 和 `f-ungrouped`） |
| `accepts.shortcut` | 引用能不能丢进来（`canHoldShortcuts`） |

`canMove()` 只用两条规则：不能进自己的子树（会整支掉出树）、workspace 不能套 workspace。
其余组合全部自由：文件夹进文件夹、文件夹进 workspace、workspace 进文件夹、workspace 在根下。

两条规则问的都是**结构**（`subtreeOf(id, tree, { followReferences: false })`）：引用不是父边，
所以"装了一条指向 workspace W 的引用的文件夹"不算"带着 W"，把这条引用拖进 W 也不是环。
列表那一侧仍然跟随引用（默认 `followReferences: true`），因为引用的意义就是显示目标的行。

固定节点不可移动；客户端会先把非法目标变灰，但 host 一定会**再校验一次**——一个过期的客户端
不应该能写出非法的树。

### 7.1 写进 draft 之前的第二次校验

`canMove()` 看的是请求到达时读到的树。两个移动**同时**到达时，它们看到的是同一棵"之前"的树：
A 进 B 通过，B 进 A 也通过，写下去就是一个环（渲染时整支降级到根）。所以 `moveNode()`
（`lib/domain/folders.js`）在 mutate 回调里再问一次 `isInsideDraft(draft, nodeId, parentId)`，
看到的是"第二次移动即将扩展的那份 draft"，于是第二次被拒（`cannot move … inside itself`）。
`sidecar.mutate` 的串行锁让这次检查是原子的。

### 7.2 名字与顺序

同一父节点下不允许重名（`assertUniqueName`，比较前 `trim` + 小写；不同父节点可以同名），
新建、重命名、移动三条路径都会查。`order` 也不再取 `siblings.length`——删掉中间一个之后，
`length` 会把最后一个兄弟的编号再发一次，两行同号，用户排好的次序变成平局。
现在取"当前最大 `order` + 1"（`nextOrder`），编号单调。

## 8. 快速访问（书签带）

`tree.quickAccess`（规则在 `lib/domain/quick-access.js`）是「目录」上面那条按钮带：`{ 节点 id: 序号 }`，
投影按序号**从新到旧**排进 `quickAccessNodes`。它和置顶是两件事，这是刻意的（m03020）：

| | 存哪 | 是什么 | 行为 |
|---|---|---|---|
| 置顶 | `tree.pins` | 在本来的带子里排名 | 行留在原地，排到兄弟最前 |
| 快速访问 | `tree.quickAccess` | 同一容器的第二个入口 | 目录上面多一个按钮 |

共用一张表时「置顶一个文件夹」会把它从 目录 里挪走，两个功能看起来是同一个功能写了两遍。

- **只有真实容器能当书签**（`isBookmarkable`）：文件夹还在的 `d-…`，或 `w-…`。视图（根目录 / 所有会话 /
  回收站）、收藏 / 待办、快捷方式都不是「地方」，在左栏已经是一行。
- **带子是一条序列，不是每个容器的一个字段**：`POST /quick-access` 一次写整条（`applyQuickAccessOrder`）。
  往带上拖一个文件夹（加）和把一个书签拖到另一个上（重排）因此是同一句话——「现在就是这个顺序」。
  写的时候陌生 id 被跳过而不是拒绝（手势来自一棵活的树），已经在带里却没出现在列表里的书签保留原序号，
  排到新写的下面：一次拖动不会顺手扔掉用户没碰过的书签。
- **行是按钮，不是分支**：没有箭头、不展开子树，点它就是打开那个容器——和左树上那六个固定入口同一种东西。
- **标题永远是落点**（空着也画，空着时写「把文件夹或工作区拖到这里」）：第一次放之前，用户得看得见它。
  带子里的**行**是那个文件夹本身，往行上放东西是放进那个文件夹（`containerDrop`），不是加书签（m03793）。
- 删文件夹 / workspace 时 `deleteFolder` / `deleteWorkspace` 顺手删掉 `pins` 与 `quickAccess` 里的条目，
  两张表都不会只增不减。

## 9. 多选与批量动作

勾选是「多行上的同一个动作」，不是每行一个小事务。菜单里每一项都对**整批**做同一件事，方向只读一次
（第一个被勾选的项，或者「是不是全都在里面」），所以混合选择不会被翻转一半：

| 项 | 写什么 | 什么时候出现 |
|---|---|---|
| 收藏 / 待办 `{n} 项` | `POST /shortcuts` 或 `DELETE /shortcuts/:id` | 有勾选就有 |
| 置顶 / 取消置顶 `{n} 项` | `POST /sessions/:id/pin`、`POST /nodes/:id/pin` | 有勾选就有 |
| 归档 / 取消归档 `{n} 项` | `POST /sessions/:id/archive` | 勾选的**全是会话** |
| 添加到 / 移出快速访问 `{n} 项` | `POST /nodes/:id/quick-access` | 勾选的**全是容器** |

两条「全部」规则互为镜像：归档需要每一行都是会话（容器没有归档），快速访问需要每一行都是容器（会话不是
地方）。勾选行先用 `bulkTargetOf` 解析：收藏 / 待办里的成员行作用于它背后的会话或容器，不会把一个快捷方式
再套进另一个快捷方式。

**框选**是勾选的快捷方式，不是第二种选择。在列表空白处按下并拖动，途中的行一起进集合（与已有勾选取并集
还是替换，看有没有按住 ctrl / ⌘：按住是并集）；松手留下结果。

行本身用的是原生 HTML5 拖放，所以**拖动先要选中**（`rowDraggable()`）：当前行（点过的那行）或已勾选的行拖走
自己，没被选中的行和空白一样是可以起框的表面——否则浏览器会先拉起原生拖影，框永远收不到那次按下。这条闸口
只写一遍，行用它决定 `draggable`，框用它决定要不要让路（`marqueeDrag` 的 `canDragRow`）；两边一旦不同源，
就会出现「拖出幻影但什么都没动」。按在行内控件上（复选框、按钮、列宽手柄、折叠箭头）依旧不起框。

**双击打开有自己的时限**（`countsAsDoublePress()`，`DOUBLE_CLICK_MS = 400`）：浏览器给的 `dblclick` 阈值来自系统设置，慢设置下两次悠哉的按下也算一次双击，而打开会话意味着启动 DSH——代价太大，所以打开被挪到 `onClick` 的第二次按下上，凭同一行、400ms 内这一对来认；慢一拍只算两次单击，而且那次慢按成为新一对的开始（连点三下是「一次双击 + 一次单击」，不是两次双击）。`onDoubleClick` 只留 `preventDefault` + `stopPropagation`，用来吞掉选中文字。

拖的是**整份勾选集**，起手那行只是其中一员（m01540）。勾选集里会话和容器可以混着，而 id 前缀判不出
（工作区是 `w-`、文件夹是 `f-`，会话 id 不透明），所以起手时用 `splitDragIds()` 按树和索引分成两个
半边，落点各取自己收得下的那半：文件夹行只收容器（`draggedNodeIds()`），会话槽只收会话
（`draggedSessionIds()`）。往文件夹里放多个容器走 `moveNodesTo()`——一次 `mutate`、一条提示
（`已移动 {0} 个目录到「{1}」`），部分放不下的先提示再搬放得下的；只勾一个时它退回 `moveNodeTo()`，
保留原来那句单数提示。浏览器读不到 `DataTransfer` 时回落到模块里的 `dragPayload`，因为拖动载荷本来就是
同源信息，不必依赖那个可能被隐私设置清空的槽。

判定只看矩形与行的重叠，所以擦过一个角也算命中，而仅仅上下相邻不算——零面积的矩形（也就是一次点击）
什么都不选，空白处（或没选中的行上）点一下因此是「取消全选」：`setChecked(new Set())` 并清掉当前行。框本身
是一个真实的 `.selrect` 元素，拖动时直接改它的 `left/top/width/height` 而不重渲染列表，贴近上下边缘时列表跟着滚。

起始点是**内容上的一个点**，不是屏幕上的一个点：按下时记下列表当时的 `scrollTop`/`scrollLeft`，之后每帧把滚动增量抵消掉（m01775）。否则滚轮一动，行在静止的指针下滑走，而用屏幕坐标算的起点不动，整个选区跟着手指往下漂——「起始位置没有锁定」。

框是拿**面板当前矩形**画的，每帧重读一次而不是按下时取一份快照：手势期间布局会动（滚轮、滚动条、贴边
自动滚、面板换尺寸、祖先位移），快照一陈旧，画的框和命中的行就一起偏移（m01540）。同理，列表
`scroll` 会点亮脏标记——没有 `mousemove` 时行也会在静止的指针下走过去，不重算就会"框到上一帧的集合"。

方向是「全都已经在里面了才移出」，否则把缺的加进去（`flagMany` / `pinMany` / `quickMany`），文案跟着翻成
`取消收藏 {n} 项` 这类。归档会把 DSH 那边的置顶清掉——那是 DSH 自己的规则（「DSH refuses to pin an archived
session」，`lib/index.js` 有注释），不是这里的批量逻辑。

## 10. 相关文件

| 文件 | 职责 |
|---|---|
| `lib/domain/tree.js` | `buildTree()`：造节点、算 `sessionHome`、算徽章、排序 |
| `lib/domain/tree-rules.js` | 全部规则：`placementOfNode` / `sessionsOfNode` / `sessionsUnderNode` / `acceptsOf` / `canMove` / `decorateTree` |
| `lib/domain/shortcuts.js` | 快捷方式的规范化、目标解析、`canHoldShortcuts`、`dropShortcutsTo` |
| `lib/domain/quick-access.js` | 快速访问：`isBookmarkable` 谁能当书签、`applyQuickAccessOrder` 整条写 |
| `lib/host/flags.js` | 一次性迁移：注解里的收藏 / 待办标记 → 快捷方式 |
| `lib/domain/folders.js` | 文件夹命名、新建、上提删除 |
| `lib/domain/sessions.js` | 合并视图、`home` / `homeOverride` 的推导 |
