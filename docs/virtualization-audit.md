# 渲染层虚拟化审计

> **Status: Historical（2026-10-31 归档；测试固定读取此路径，内容记录当时审计，不代表现状）**


> 判据 + 现状登记。判定标准是长期资产，具体行数/接入点数量会变——变的东西不写死在这里，
> 由 `tests/scrollContainerGuard.mjs` 现算（`node tests/scrollContainerGuard.mjs`）。

## 一、什么时候该虚拟化

两个条件**同时**成立：

1. **有自己的滚动视口**——容器上有 `max-h-*` / `h-*` 且有 `overflow-y-auto`（含 flex 填充的滚动窗）。
2. **行数随数据增长**——不是受控分页、不是固定枚举、不是一次性弹窗。

缺第 1 条就没有「窗口」这个概念，算不出该挂哪几行；缺第 2 条虚拟器自身的开销（一条
ResizeObserver + 每帧行集合计算）比直接渲染几个 div 更贵。

## 二、行高方差不是判据（这条曾经写错过）

早期版本写的是「行高方差 > 2 倍不用虚拟化，改用挂载预算」。**归因错了。**

那次失败（执行过程组体套虚拟栈后「展开方向反了」）的真因是**纯估值**：
`estimateSize` 固定返回 40px，行位置全按估值算，而真实行高从 28px 到几百 px。

正确判据：

| 行高怎么定 | 适合的行高分布 |
| --- | --- |
| 纯估值（`estimateSize` 常数） | 方差小；方差 > 2 倍必然错位 |
| 实测（`measureElement` + ResizeObserver） | 任意分布 |

**红线只有一条：虚拟化必须配 `measureElement`。** `VirtualStack` 的默认行为就是实测。

所以「含可展开块的列表不能虚拟化」这句话是错的——折叠区（组头 32px / 展开组 352px /
中间回复几百 px）就是靠实测接进去的。

## 三、接入点

通用件：`src/renderer/src/components/ui-shadcn/virtual-stack.tsx`。

- 行数 ≤ `minRows`（默认 16）时直出 Fragment，DOM 与接入前逐字一致；
- 接入点只描述「怎么画一行」，不写测量/缓存代码；
- 虚拟行是 `absolute`，**不参与 flex 布局**，原来靠父容器 `gap` 提供的行距会消失
  → 用 `rowClassName` 补（例如 `pb-2`）。漏了的表现是行贴在一起，一眼可见。

## 四、明确的例外与理由

标记写在滚动窗**容器这一行之上**（中间可隔最多 13 行的多行属性）。三条边界，违反任一条都不算豁免：

1. 写在容器**下方**等于没写（守卫只向上找）；
2. 向上查找**遇到上一个元素的开标签收尾**（`>` 或 `/>`）就停 —— 标记写在别的元素上时，不会顺带豁免它下方的容器；
3. 类别名必须在白名单内（`tests/scrollContainerGuard.test.mjs` 会把本表与代码里的 `EXEMPT_CATEGORIES` 逐项比对，两边不同就红）。

`scroll-ok: <类别>`，六类：

| 类别 | 含义 | 典型场景 |
| --- | --- | --- |
| `bounded` | 行数有硬上限 | 受控分页（每次 +30）、固定枚举、短预览 |
| `transient` | 一次性弹窗/表单 | 设置页各 tab、反馈弹窗、Dropdown 菜单 |
| `nested` | 嵌套树，需先扁平化 | 目录→文件两层、两段异质列表混在一个滚动窗 |
| `flip` | 有退场动画，卸载会失去锚点 | `RemovalRow` 的 FLIP 淡出 |
| `probe` | 探针/守卫自测用 | 测试夹具 |
| `text` | 单一文本块，没有「行列表」可虚拟化 | 原始 JSON `<pre>`、复制出来的记录正文 |

## 五、守卫

```bash
node tests/scrollContainerGuard.mjs          # 检查（新增未判定项 exit 1）
node tests/scrollContainerGuard.mjs --list   # 只列未判定
node tests/scrollContainerGuard.mjs --seed   # 重新生成基线
```

四种合法状态：**接线**（容器带一个 ref，同一个 ref 名作为 `scrollRef` 传给 `<VirtualStack>`）/ **自持**（容器元素本身就是虚拟化组件，标签以 `Virtualizer`/`VirtualStack`/`VirtualList` 开头，没有外部 ref 可对）/ 写 `scroll-ok:` / 已登记进基线。

「自持」这一条是 2026-11 补的：diff 视图写的是 `<Virtualizer className="… overflow-auto">`，容器与虚拟化是同一个节点，旧判据只认外部 `scrollRef` 两头对上，于是**已经虚拟化的它被当成未判定**，唯一的出路只剩写一条假豁免。

「接线」是 2026-10 收紧后的判据，之前的判据是「同文件 ±80 行内出现过 `<VirtualStack>`」——那样两种真缺陷都能过关：接了但容器没 ref（虚拟器拿不到 `scrollElement`，视口恒 0、一行不渲染），以及压根没接却挨得近（永久逃出判定面）。现在判据要求同名 ref 两头都在，`props.` 开头的透传 ref 不算（透传无法静态证明调用方给了实 ref，要在组件内 `props.scrollRef ?? localRef` 兜底）。

基线是**台账**，不是免罪金牌——判定掉一个就把它的指纹删掉，让基线只减不增。
`tests/scrollContainerGuard.test.mjs` 把它接进 `npm test`，并额外守一条：扫描器自身
必须有产出（> 100 个容器、至少一个已虚拟化），防止正则被改坏导致「永远 0 命中、永远绿」。

## 六、已知限制

- **虚拟行离屏即卸载**：行内展开态（哪个组打开着）会随滚动丢失。这是虚拟化的固有代价，
  不是 bug。需要保住的展开态必须提到组件 state（按 id 记），不能放在行内 `useState`。
- **键盘导航/焦点**：离屏行没有 DOM，`querySelector` 与 `.focus()` 会静默变成 no-op。
  用 `virtualizerRef.scrollToIndex` 先把行拉进视口再操作（见 `SessionFindOverlay`、分支树）。
- **`role="list"` / `role="tree"`**：虚拟化会插入一层内容盒，`listitem` 的 owner 变了。
  两种写法都合法，选哪种看短列表路径：
  1. `containerProps={{ role: "list" }}` —— role 落在内容盒上（轨迹视图、子代理条、会话内查找、分支树用这个）；
  2. role 挂在**外层容器**上 —— 内容盒是无 role 的 generic div，在 a11y 树里透明，`listitem` 的 owner 仍然是它（待办条、队列条用这个）。
  选 2 的理由是短列表零 DOM 变化：`containerProps` 一旦传入，短列表也会多包一层 `<div>`（`virtual-stack.tsx` 短列表分支），
  而这两条的短列表本来是 `ul > li`，多一层就是「为了虚拟化改短列表的 DOM」——正是本补丁极力避免的。
  判据：**如果短列表是 `ul`/`ol`，role 不要传 `containerProps`（外层容器已经是 list）；如果短列表也是 `div`，用 `containerProps`。**


## 七、2026-11 第二轮：基线清零

上一轮留下 133 条「等后续批次处理」的基线。基线的问题是**它和缺陷长得一样**：没人知道
里面多少条是真待办、多少条其实早有判定。这一轮把它清到 0，规则是每条必须二选一：

- 接 `<VirtualStack>`（容器 ref 与 `scrollRef` 同名接线）；或
- 写 `scroll-ok: <类别>` 并给出**能复算的依据**（指向具体的分页函数、上限常量、子组件边界）。

判据不写死数字，随时可复算：

```bash
node tests/scrollContainerGuard.mjs        # 四档统计；未判定必须为 0
node tests/scrollContainerGuard.mjs --seed # 只有全量判定后才允许重建基线（本轮之后基线应为空）
```

### 7.1 本轮修订的三条分类判据

上一轮的四类不够用，出现了三种反复出现的形状，各自定死判据：

| 形状 | 判据 | 依据在哪 | 归类 |
| --- | --- | --- | --- |
| 受控分页列表 | 行数由「点了多少次更多」决定，而不是随数据自动增长 | 侧栏 `showMoreChildren` / 网页侧栏 `resolveSidebarWindow` / Git 提交图每次 +30 / 快捷消息 `MAX_QUICK_MESSAGES` | `bounded` |
| 行列表在子组件里 | 本层只是个空滚动窗，行模型由 children 或子组件持有 | `MessageShareModal` → `MessageSelectionTree`；`WebWorkspaceDrawer` → 各 tab 自己的面板 | `nested` |
| 单一文本块 | 一块 markdown / `pre` / diff 原文，没有「行列表」概念 | 公告正文、文件预览、错误原文 | `text` |

**受控分页为什么算判定而不是缺口**：判据是「会不会随数据无限变长」。分页列表在用户
不点「更多」时行数恒定，点了是用户主动的一次性动作，不是流式或历史增长；而虚拟化它要
先设计无限滚动（把「更多」按钮换成触底加载），那是另一个功能，不是接一个栈能解决的。

### 7.2 本轮接入的滚动窗

判定记录（`node tests/scrollContainerGuard.mjs` 现算已达 22 处）：

| 接入点 | 为什么 |
| --- | --- |
| `web/WebTimeline.tsx` 消息流 | 长会话几百轮、每轮几十个节点；同时补了命令式跳转句柄（见 7.3） |
| `web/WebSessionStrips.tsx` 子代理 / 待办条 | 与桌面同一数据源，条数随子代理与任务增长 |
| `components/session/ComposerPanels.tsx` | 命令面板候选列表 |
| `components/session/DshAgentToolsPanel.tsx` | 工具清单，插件多了会几十上百条 |
| `components/session/trajectory/SessionTrajectoryView.tsx` 详情面板 | 轨迹事件流 |
| `components/session/SessionSubagentsStrip.tsx` | 子代理行（已有虚拟化的姊妹条） |
| `config/PiDeckMcpPanel.tsx` | MCP 服务器 / 工具清单 |

### 7.3 流式输出时「点刻度跳不回去」：仲裁补了第三维

前一轮只挡了「跳转挂起（`pendingJump`）」这一种情况下的引擎上报。真机上仍然失效，
因为**最常见的那条路径根本不设 `pendingJump`**：用户点的刻度若在已挂载窗口内（流式时
点的常常就是最新那几轮），`jumpToMessage` 走「DOM 已存在」分支，落位后直接返回。

于是流式下一帧：引擎 resize → 上报 following=true → `autoScroll` 变回 true → 跟着新内容
滚回底部。用户看到的就是「跳过去了又弹回来」。

修法（`hooks/timelineJumpGuard.ts`）：仲裁条件从「有挂起跳转」扩展为
**「有挂起跳转 或 有浏览 pin」**。pin 存在表示视口被钉在某一行，此时引擎的「已跟底」
是过期判定。落位后立刻建立 pin（`jumpToMessage` 两条路径都建），RO 才能在内客增高时
补位移；用户自己滚回底部时 pin 被清、上报恢复接收。

判据在 `tests/timelineJumpGuard.test.mjs`（含「没有 pin 时必须照常接收上报」的反向样本——
只测「该忽略」一侧，把条件写成恒 true 也能全绿）。

### 7.4 review 修订：类名抽成变量是一条静默逃跑通道

review 指出（PR #471）守卫里「跳过变量声明行」那条规则只看声明，等于把容器判据丢了一半：

- 声明行 `const listClass = "m-0 max-h-64 overflow-y-auto"` 被跳过（这一行确实不是容器）；
- 真正那一行 `<ul className={listClass}>` 里没有 `overflow-*` 字面量，于是**整个容器从判定面消失**：
  既不进基线、也不报未判定，等于永久逃出审计。

实测命中 4 处，已全部把类名内联回元素行，并给出归类：

| 位置 | 归类 | 依据 |
| --- | --- | --- |
| `tool-result.tsx` 工具输出视口 | `nested` | 行模型由 children（ToolCard 渲染的内容）持有，本层只是限高视口 |
| `PiCommandSourcePanel.tsx` ×2 | `bounded` | 安装来源是固定枚举（nvm/mise/pnpm 的 shim），条数有硬上限 |
| `ProviderLoginModal.tsx` 阶段内容区 | `transient` | loading / 表单 / 二维码轮换，随弹窗生命周期结束 |

守卫补上了反方向判据：文件内定义了含 `overflow-*` 的字符串常量、元素行又引用到它时，
那个元素行照样算容器候选，必须落进「虚拟化 / 豁免 / 基线」三档之一。三条用例钉住这个方向
（抽成变量必须报、内联后必须能被标记认下来、只声明不引用不算容器）。

**写新容器时照这条来**：滚动容器的类名内联在元素行上。要复用就别抽类名常量——
抽类名会让守卫扫不到，正确的做法是拆组件。

**已知取舍**：`WebFilePreview` 的 markdown 分支整段交给 `MarkdownStream`，不虚拟化。
理由不只是「没有行列表」——跨屏整段选中复制依赖完整 DOM，虚拟化后只能拿到视口内的行。
这条取舍适用于所有 `text` 类别容器。
