# 中间过程展示调研：PiDeck vs 新版 DSH vs beui `agent-activity`

- **状态**：调研中（只读调研 + 本报告；**尚未改动任何产品代码**）
- **分支**：`research/dsh-process-display`（基线 `dev` @ `988c74d46`，package version `0.7.7`）
- **对照对象**：
  - 新版 DSH：`F:\deepseek-harness-master\deepseek-harness-master`（`packages/client/ui-chat`）
  - beui 组件库：`https://beui.dev/r/agent-activity.json`（本地已有部分依赖）
- **调研问题**：能不能把 PiDeck 的「中间思考 / 中间工具调用 / 中间回复」展示，改成 DSH 那样「合并 + 点开才显示」的更清楚的形态？

---

## 0. 结论速览

1. **PiDeck 已经有一层 run 级折叠**（不是"全部一级平铺"）：一轮只有一个「执行过程: N个工具 N次思考 N段中间回复」折叠条，思考/工具/重试/错误/中间回复统一收在里面，最终回答在外常驻。
   证据：`src/renderer/src/components/session/turn/TurnRow.tsx:271-350`、`.../timeline/segmentSummary.ts:19-39`。
   另外**每个步骤卡片自带折叠**（`ThinkingBlock` 单行预览↔全文、`ToolCard` trigger↔详情、`RetryStep` / `ErrorStep` 同）——所以 DSH 的第 3 层（单条思考/工具正文可再展开）PiDeck **已经有了**。
   → **真正缺的是中间层：DSH 的「过程组」（把连续思考+工具调用合并成一组，组头给类别摘要）**。
2. **"看起来乱"的真正原因不是缺折叠，而是折叠后没有任何高度上限**：`.execution-summary-details` 只有 `display:flex`，**没有 `max-height` / `overflow`**（`src/renderer/src/styles/timeline.css:191-200`），而 `expandInterimDuringStream` 默认 `true`（`src/main/settings/SettingsStore.ts:158`、`App.tsx:665-667`）——**长任务流式期间整轮过程是全程无限长平铺的**，这才是用户看到的画面。
3. **"只挂 120 条"是对上面这个症状的补偿**：`TIMELINE_MOUNTED_STEP_LIMIT = 120`（`.../timeline/turnMountBudget.ts:21`）限制的是一轮内步骤的 **DOM 挂载条数**，超出部分藏在「显示更早 N 条步骤」按钮后；它不是折叠，是性能兜底。
4. **DSH 的做法确实是三层结构**，比 PiDeck 多两层信息组织：
   - 第 1 层：整轮过程折叠条（时长/状态 + 不可折叠的运行中轮次）；
   - 第 2 层：**过程组**（连续思考+工具调用合并成一组，组头是"类别摘要"如「已读取文件并搜索代码」，组体默认收起、限高滚动）；
   - 第 3 层：单条思考/工具行（可再展开看正文）。
   证据：`packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx`、`chat/ChatGroupSeat.tsx`、`contract/process-groups.ts`、`conversation-nodes/README.zh.md`。
5. **DSH 里「中间回复」是一级行**：模型给出的阶段回复会**截断二级过程组**，成为与组头并列的一级内容；但整轮收起时它仍会一起消失（只有最终答案不参与整轮折叠）。这正是用户描述的"中间回复也是一级显示"。
   证据：`conversation-nodes/README.zh.md:29-40 / 169-202`。
6. **beui 里有一个现成的同类组件**：`agent-activity`——"One adaptive activity stream for reasoning, searches, tool calls"。它的形态介于两者之间：**单层紧凑行 + 一个折叠条 + 208px 限高内部滚动 + 流式贴底跟随 + 完成自动收起 + 摘要行**。
   而且它的共享依赖（`agent-disclosure` / `text-shimmer` / `lib/ease` / `lib/utils`）**本地已经全部存在**，安装成本只有 2 个新文件。
7. **推荐路线**：~~先做方案 A 再做方案 B~~ → 用户已确认目标结构就是**方案 B 的形状**（见下条），方案 A 降级为组体视觉的可选打磨。
8. **（用户已确认目标结构）** 目标 = 一个**大折叠栏**内「**中间回复** / **过程组（思考+工具合并折叠）**」严格按原始时序交替，**最终回复常驻栏外**；大折叠栏本身可整体折叠。这与 **DSH `standard` 模式逐字对应**。
   可落地设计稿见 **§9**：分组算法规格、新增状态归属、**4 个必须先解决的冲突**（live 挂载点 / 嵌套滚动 / 工具归类 / 中间回复视觉标记）、S0–S5 切片、DOM 影响。
   **关键好消息**：叶子渲染器（`ThinkingStep` / `ToolStep` / `InterimAnswer` / `FinalAnswer`）**几乎零改动可复用**——新增的只是一个纯函数分组层 + 一个组壳组件。

---

## 1. 现状：PiDeck 现在到底怎么显示

### 1.1 过程组织只有两级（缺的是中间那层「过程组」）

```
article.turn-row                       ← 一轮 agent-run
├─ TurnAuthorHeader                    行头：头像 + Pi/DSH 署名 + 时间
├─ Collapsible.execution-summary       ← 第 1 层（唯一折叠开关 stepsVisible）
│  ├─ ProcessSummaryToggle             「执行过程: N个工具 N次思考 N段中间回复」
│  └─ CollapsibleContent.execution-summary-details   ← 内部是【扁平】列表，无限高
│     ├─ button「显示更早的 N 条步骤」    （仅当超过 120 条）TurnRow.tsx:287-299
│     ├─ ThinkingStep   | ToolStep | RetryStep | ErrorStep   同层，原位穿插
│     ├─ InterimAnswer  variant="process"                    中间回复，同层
│     └─ button.execution-summary-collapse  「收起」
├─ InterimAnswer mode="live"           仅当前流式那一份提到容器外（避免被卸载）
└─ FinalAnswer                          最终回答：常驻，永不折叠
```

证据：`TurnRow.tsx:260-422`（渲染）、`TurnRow.tsx:300-340`（渲染循环，全部是同一个 `map` 的兄弟节点）、`timeline/types.ts:19-31`（`TurnDisplayItem` 三态：`process-entry` / `interim-answer` / `final-answer`）。

**关键点：折叠区内部没有二级分组、没有组头、没有类别摘要。** 思考、工具、中间回复是**同一个层级**的兄弟行——这就是用户说的"都是一级显示"。

补充精确口径（避免误判改造量）：
- 每个步骤卡片**内部**有自己的一级折叠（`ThinkingBlock` / `ToolCard` / `RetryStep` / `ErrorStep` 各自 `useState(expanded)`，见 `tests/turnRowExecutionProcess.test.mjs:63-79`、`ToolCallComponents.tsx:410-427`）。
- 所以完整层级是「**run 级折叠 → 步骤行（扁平）→ 卡片内折叠**」三层。缺的是**过程组**这一中间层，不是底层折叠。
- 折叠容器关闭时 **children 完全不进 DOM**（Radix `@radix-ui/react-collapsible@1.1.20` `dist/index.mjs:137` `children: isOpen && children`），因此 `TurnRow.tsx:280-286` 注释所称「live 流式轮折叠时保持挂载（`display:none`）以保打字机状态」**在当前 Radix 版本下不成立**，那段守卫（`stepsVisible || agentRunning === true` + `hidden={!stepsVisible}`）实际是死代码；同理注释所称「`CollapsibleContent` 自带高度过渡动画」也不成立——`styles/timeline.css:191-199` 没有任何 transition，折叠是瞬时挂载/卸载。**改造前不要沿用这两条注释假设。**

### 1.2 折叠默认态：流式期间是展开的

`useTurnExecution`（`turn/useTurnExecution.ts:56-78`）的初始态规则：

| 场景 | 默认态 |
|---|---|
| 非 live（历史轮 / 会话空闲） | **一律折叠** |
| live 流式轮 + `expandInterimDuringStream` | **展开**（设置默认 `true`） |
| 用户手动开合 | 最高优先级，记忆跨挂载（`runStepsVisibleMemory`） |
| 最新轮结束 + 1.5s 无操作 | 自动收起（`useTurnExecution.ts:134-144`） |
| 新一轮开始 | 非最新轮强制收起（`useTurnExecution.ts:118-129`） |

所以真实体验是：**历史轮很干净（只有折叠条 + 最终回答），但任务正在跑的时候整轮过程是全程展开的**，而展开区没有高度上限 → 长任务真的"显得有点乱"。

### 1.3 三层预算（120 是其中一层）

| 机制 | 数字 | 限制什么 | 证据 |
|---|---|---|---|
| turn 挂载窗口 | 贴底 3 轮 / 上滚 +3 轮 cohort | 挂多少个 `TurnRow` | `timeline/turnRenderWindow.ts:12-16` |
| **单轮步骤挂载预算** | **120** | 一轮里挂多少个步骤 DOM（思考/工具/中间回复统一计数） | `timeline/turnMountBudget.ts:21,37-45` |
| 折叠卸载 | 折叠时**内容整体不进 DOM**（Radix `children: isOpen && children`，`@radix-ui/react-collapsible@1.1.20`） | 省 DOM | 已实测确认，见 §1.1 补充口径 |

超预算时只渲染**尾部 120 条**，顶部给「显示更早的 N 条步骤」按钮，点开全量挂载（`TurnRow.tsx:287-299`）。内容从不丢失。

### 1.4 中间回复现在在哪

- 有文本的中间回复 → `TurnDisplayItem.kind === "interim-answer"`，**渲染在折叠容器内部**，`variant="process"`（`TurnRow.tsx:317-334`）。
- 正在流式的那一条 → 通过 `resolveLiveInterimId` 提升到**容器外**渲染（`TurnRow.tsx:139-158, 353`），避免 Radix Collapsible 卸载/收起导致 DOM 消失。
- 折叠条会统计「N段中间回复」（`segmentSummary.ts:31-36`，只数有文本的）。

也就是说：**PiDeck 的中间回复默认是被折叠隐藏的**（历史轮里完全看不到），这与 DSH"中间回复是一级显示"相反——但**DHS 整轮收起时也隐藏阶段回复**，两者只在"整轮展开时"的层级不同（DSH 提升为一级行，PiDeck 是扁平列表里的一行）。

### 1.5 每步行本身的重量

| 步骤 | 形态 | 重量 |
|---|---|---|
| `ThinkingBlock` | 默认单行 + `SingleLinePreview` 首句预览，点开才展开全文 | 轻（`TimelineEventCards.tsx:72+`，契约见 `tests/turnRowExecutionProcess.test.mjs:63-79`） |
| `ToolGroupCard` | 工具卡，一个 `ToolGroupItem`（`messages: ChatMessage[]`）一张卡 | 中（`ToolCallComponents.tsx` 428 行） |
| `InterimAnswer` | 正文尺寸与最终回答相同，`process` 档只多间距 | 重 |

**结论：问题不在单个步骤太花哨（卡片本身已经有折叠），而在于（a）行数无上限、（b）没有组头做信息压缩。**

### 1.6 三个容易踩的既有事实

1. **汇总计数是「组」数，不是工具调用条数**：`buildProcessSummary` 数的是 `tool-entry` 条数，而连续 tool 消息会被合并进同一个 `ToolGroupItem`（`AppUtils.ts:341-354`）——「连续 5 次工具调用」在折叠条上显示为「1个工具」。
2. **中间回答里的图片会被挪到最终回答下面**：折叠区内渲染的 `InterimAnswer` **不接收 images**（`TurnRow.tsx:317-334`），而 `allImages` 收集本轮**全部** assistant 图片统一传给 `FinalAnswer`（`TurnRow.tsx:229-232, 360`）。
3. **中间回答与最终回答在视觉上几乎无差别**：同字号（`--font-size-chat` 15px）、同色（`--color-text-primary`），唯一差异是「在折叠容器内（默认不可见）」+ settled 中间段多 `my-3` 间距；过程区已无左侧竖线（`styles/timeline.css:75-84, 191-199`）。
   → 若把中间回复提升为一级行（对齐 DSH），**必须先解决"看不出它是中间回复"**的问题（加标记/前缀/缩进），否则用户会分不清哪段是最终答案。

---

## 2. 新版 DSH 怎么做

### 2.1 三层结构

```
Turn（轮次）
├─ 起始输入（user / steering / turn-trigger 通知）
├─ [turn-process]  整轮过程折叠条          ← 第 1 层
│   label：运行中「深度思考中… 12s」/ 已结束「用时 12 秒」/ 失败 / 已停止
├─ 过程范围（受第 1 层控制显隐）
│   ├─ 过程组 G1                            ← 第 2 层：组头（类别摘要）+ 组体（默认收起、限高滚动）
│   │   ├─ 单条思考行（默认收起，带首行预览）  ← 第 3 层
│   │   ├─ read 工具行
│   │   └─ bash 工具行
│   ├─ 阶段回复（interim answer）            ← 一级行，截断 G1、G2
│   └─ 过程组 G2（思考 + run_code）
├─ 最终答案正文                             永不参与整轮折叠（其推理仍算过程）
└─ 轮次页脚（操作按钮 / token 用量）
```

证据：
- 整轮折叠条 `chat/TurnProcessNodeView.tsx:27-65`：`canCollapse = turnProcess.foldable && turnProcess.hasContent && !turnProcessAlwaysOpen(node)`。
- 「运行中/已中止/已失败」的轮**不允许整轮折叠**：`contract/turn-process.ts:69-74`。
- 过程组容器 `chat/ChatGroupSeat.tsx:128-189`：组头 + `data-step-process-body`（限高滚动 + 上下 fade）+ 成员。
- 组头文案 `chat/ChatGroupSeat.tsx:91-126`：已结束用 `processTitle(summary)`（类别摘要），运行中用实时活动 + 可选 detail，**最短保留 150ms**。
- 中文业务规则全文：`conversation-nodes/README.zh.md`（300 行，权威口径）。

**架构差异（值得注意）**：DSH **没有"包裹整轮"的组件**。`ChatView` 是一个扁平列表（`chat/ChatView.tsx:65-76`），Turn 只是节点上的元数据（`node.location.turn`）+ 一层可见性开关；"整轮折叠"是靠一个**合成节点** `turn-process` 实现的（`conversation-nodes/turn-process.ts:294-299`）。
→ 对比 PiDeck：`TurnRow` 是真正的整轮容器。这对移植是**有利**的——PiDeck 不需要引入合成节点机制，直接在 `TurnRow` 里加分组层即可。

### 2.2 分组边界（哪些进同一组）

来自 `conversation-nodes/README.zh.md:169-202`：

| 输入 | 归属 |
|---|---|
| 非空白 Assistant 推理 | 加入**当前组** |
| Assistant 回复（阶段回复） | **结束前面的组**，回复本身作为独立一级引用 |
| `user` / `steering` / `turn-trigger` / `model-retry` / `turn-error` / `turn-max-tokens` / `turn-tail` | **结束前面的组**，节点独立保留 |
| 工具调用 | 整个节点加入当前组（**工具类别变化不拆组**） |
| 另一轮次 / 无轮次归属 | 截断序列 |

示例：`read → bash → subagent`（中间无回复、无输入）→ **一个组**；`T1 → steering → T2` → `G[T1] → steering → G[T2]`。

代码级确认（第二轮审计，实跑测试）：
- 分组算法唯一实现在 `conversation-nodes/process-groups.ts:146-164`，独立种类集合在 `:13`（`INDEPENDENT = {user, steering, turn-trigger, model-retry, turn-error, turn-max-tokens, turn-tail}`）。
- 遇到 assistant **正文回复**时先 `flush(true)`（结束当前组）再 `emit(key, {kind:'node', key, groupPart:'response'})` —— 回复作为**顶层同级行**输出。
- 同一个 assistant-step 若**既有 reasoning 又有正文**，会**被渲染两次**：reasoning 入组、正文在顶层，靠 `groupPart` 区分 React key（`chat/render-entry.ts:10-15`）。
- 实跑 `vitest` 两条用例通过：`chat-view.client.spec.tsx` 的 "preserves steering-separated process groups"（`[data-chat-group-part="response"]` 行与组卡 `[data-chat-group-key]` 交替）与 "folds Think and Tool rows before the final answer"（折起后 3 个 `[data-turn-process-member]` 全为 `hidden="until-found"`，最终答案保持可见）。

### 2.3 组头是"类别摘要"，不是计数

已结束的组头显示**类别文案**（按次数排序取前 3），**不显示次数**：如「已读取文件并搜索代码」「已执行命令」「已完成分析」。运行中的组头显示实时活动 + 参数详情（`标准` 模式追加），详情字段优先级 `title → description → … → file_path → path`，截断 160 字素。

类别表（13 类）：`read` / `readImage` / `search` / `write` / `edit` / `commands` / `code` / `webSearch` / `webFetch` / `subagents` / `plan` / `questions` / `tools`。
计数规则：按 `callId` 去重、父先子后、失败也计数（"已读取文件"不保证成功）。

证据：`contract/process-groups.ts:1-19`、`conversation-nodes/README.zh.md:206-299`。

### 2.4 展示模式（4 档，PiDeck 目前没有）

`设置 → 通用设置 → 工作步骤展示`：`compact` / `standard`（默认）/ `detailed` / `verbose`（`chat-settings.ts:12,32`）。

渲染层不比较模式枚举，而是各自取一张**能力表**里的单个字段（`presentation-policy.ts:11-52`）：

| 能力字段 | compact | standard（默认） | detailed | verbose |
|---|---|---|---|---|
| `foldCompletedTurns`（已结束轮整轮折叠） | ✅ | ✅ | ✅ | ❌（始终展开） |
| `stepGrouping`（组头显示范围） | `collapsed`（全部轮） | `collapsed` | `history`（仅历史轮，运行中轮直接显示组体） | `none`（无组头） |
| `liveProcessDetail`（组头追加实时参数详情） | ❌ | ✅ | ✅ | ❌ |
| `settledReasoningPreview`（推理首行预览） | ❌ | ✅ | ✅ | ✅ |

证据：`packages/client/ui-chat/src/client/presentation-policy.ts`、`chat-settings.ts:12,32`、业务口径 `conversation-nodes/README.zh.md:108-164`。

> 这个"**模式 → 能力表 → 各渲染器各取一个字段**"的写法值得 PiDeck 借鉴：新增模式只改表，不散落 `if (mode === ...)`。

### 2.5 条目多了怎么办：不限条数，限高 + 分页

- **没有单轮步骤条数上限**（`ui-chat` / `ui-conversation` 内搜 `MOUNT/PAGE_SIZE/MAX_*ITEMS` 无命中）。
- **Chat 列表刻意不做虚拟化**：折起的行用 `hidden="until-found"` 保持挂载（换"可被 Ctrl+F 搜到 + 有状态工具视图不丢"）。
- 组体限高 `min(400px, 50vh)` + 内部滚动 + 24px 方向渐隐（`README.zh.md:158`、`ChatGroupSeat.module.css:74-80`）。
- 历史回溯靠**宿主分页 + 「加载更早」**：分页参数 `PAGE_MESSAGES = 50`、`HISTORY_PAGE_OPTIONS = {maxMessages: 500, turnWindow: {minMessages: 50, minTurns: 2}}`、跳转页 `JUMP_PAGE_MESSAGES = 200`（`api/session-controller/src/client/sessions/session.ts:51-62`），裁切自尾部往前数、`minTurns` 保证不切半轮（`api/session-controller/src/history.ts:392-427`）；`hasMore` → 「加载更早」（`chat/ChatView.tsx:241-247`，文案 `chat.loadOlder`）。
- 另有局部行数上限：工具卡展开体 diff 9 行 / read 8 行 / search 8 行，实时明细截断 160 字素，工具调用树 `MAX_DEPTH = 256`。只有**轮次导航轨**与 **Trajectory 表格**用了虚拟化。

> 这解释了 DSH 为什么不需要 120 这样的数字：**视觉高度被限高组吃掉了，DOM 量用分页 + 限高受控**。PiDeck 的 120 是"整轮过程平铺"这一形态下的必要兜底。

### 2.6 两个容易看漏的实现细节（第二轮审计补充）

**(1) Turn 级按钮只显示"时长 / 状态"，不显示计数。**
`TurnProcessNodeView.tsx:35-44` 的 label 只有四种：运行中「深度求索中，用时 X 秒」、已停止、处理失败、已结束「用时 X 秒」；`worked` 兜底「已完成工作」。
计数**存在但只作为 DOM 属性**（`:52-55`：`data-turn-process-messages` / `-tool-calls` / `-subagents`），供给测试与埋点，不呈现给用户。
→ 对比 PiDeck：折叠条显示「执行过程: N个工具 N次思考 N段中间回复」。**要不要改成"时长 + 状态"是一个独立的产品决策**（见 §9.9 第 6 条）。
（另注：`.agents/notes/archived/feature/2026-08-14-web-turn-process-folding.md:20` 描述的是老版"折叠显示计数"设计稿，与当前代码不符，已过期。）

**(2) 折起的成员用 `hidden="until-found"` 保持挂载，而不是卸载。**
`chat/searchable-hidden.ts:14-29`：折叠成员保留在 DOM 里但标记为可搜索隐藏；浏览器 Ctrl+F 命中时 `beforematch` 触发并自动展开对应披露。同时还有**焦点守卫**：若折叠会把焦点吞掉，则改为保持展开；手动折叠前先把焦点移到控制按钮（`TurnProcessNodeView.tsx:58-61`）。
理由（设计注记）：保留有状态工具视图 + 支持浏览器查找。
→ 这是一个明确的**取舍**：DSH 用 DOM 量换「可搜索 + 状态不丢」；PiDeck 用 Radix 卸载换 DOM 量。两者都自洽，但 PiDeck 若不改成 `until-found`，**折叠态下的过程内容无法被 Ctrl+F 搜到**——这是新结构会放大的一处体验缺口（现在过程内容本来就默认折叠，问题不显著；改成"中间回复也在一级"后会更明显）。

**(3) 中间回复与最终回复的区分方式（三件套）。** 这是 §9.5 冲突 4 的现成答案：
1. 中间回复行带 `data-turn-process-member`，整轮折起时 `hidden="until-found"`；最终答案行不带。
2. 折起态下最终答案额外带 `data-turn-process-answer` → CSS 把行间距压成 8px（`ChatView.module.css:79-83`）。
3. **每轮只有一个操作行**（复制 / 分支 / 用量），由该轮的 `turn-tail` 渲染（`TurnTailNodeView.tsx:56-78`）——中间回复**没有任何操作**。

**(4) 展开状态存续**：Turn 级手动展开存在**会话级内存 store**、按 `(turn, answerStep)` 记录（`stores.ts:31-46`），不落盘、刷新即失效；组级是每个座位自己的本地 state，外层折起时通过 `disclosureReset` 版本号重置（`ChatNodeSeat.tsx:118-122`）。

**(5) 版本确认**：这套能力在 `deepseek-harness-0.1.1-rc.2` 里**完全不存在**（grep `turn-process|stepProcess|processGroup` 零命中，Chat 渲染还在旧路径、reasoning 与 text 逐块并列）；`dsh-desktop` 只是桌面壳，不参与会话渲染。→ 用户说的"新版 DSH"确实是**新增能力**，值得对标。

---

## 3. 第三个候选：beui `agent-activity`

用户提示的这个组件确实对口。完整源码已从 `https://beui.dev/r/agent-activity.json` 取到。

### 3.1 它是什么

> "One adaptive activity stream for reasoning, searches, tool calls, structured execution traces, or a chronological mix."

API（`components/agents/agent-activity/types.ts`）：

```ts
items: AgentActivityItem[]              // step | text | search | tool | trace
status?: "working" | "complete"
duration?: number                        // 秒
open / defaultOpen / onOpenChange        // 受控
collapseOnComplete?: boolean             // 默认 true
activeLabel? / summary? / renderWorkingStatus? / renderCompletedStatus?
maxHeight?: number                       // 默认 208
```

行为要点（`components/agents/agent-activity/index.tsx`）：

| 能力 | 实现 |
|---|---|
| 运行中强制展开 | `const expanded = working \|\| currentOpen` |
| 运行中抬头 | `ThinkingShimmer`，文案按内容类型推导：`Thinking…` / `Running tools…` / `Searching the web…` / `Working through it…` |
| 运行中贴底自动跟随 | `streamOffset = Math.min(0, viewportHeight - contentHeight)`，内容用 spring 平移 |
| **限高** | `maxHeight = 208`，`capped = contentHeight > maxHeight`，超出时内部滚动 + 上下 mask 渐隐 |
| 完成自动收起 | `previousStatus === "working" && status === "complete"` → `setOpen(!collapseOnComplete)` |
| 完成摘要 | `Thought for 12s` / `Searched the web` / `Ran N tools` / `N tool calls, M messages` / `Completed N steps` |
| 进入/退出动画 | `AnimatePresence mode="popLayout"` + `layout="position"` |
| 行类型 | `step`（✓/脉冲点/待办 + meta）、`text`、`search`（query + 结果 + 域名）、`tool`（动作图标 + 动作词 + 等宽 target 药丸 + `+/-` 行数）、`trace`（图标 + label + 等宽 detail） |
| 无障碍 | trigger/`aria-expanded`/`aria-controls`/`role="list"`、`inert`、`prefers-reduced-motion` 降级 |

### 3.2 本地依赖已经就绪（重要）

`agent-activity` 的 registry 依赖里，**PiDeck 本地已存在**：

| 依赖 | 本地状态 |
|---|---|
| `components/agents/agent-disclosure.tsx` | ✅ 已有（且与官方逐字节一致，见 AGENTS.md） |
| `components/motion/text-shimmer.tsx` | ✅ 已有 |
| `lib/ease.ts` / `lib/text-shimmer.ts` / `lib/utils.ts` | ✅ 已有 |
| `components/agents/agent-activity/{index,activity-row,types}.tsx` | ❌ 缺 |
| `components/agents/loading-states/thinking-shimmer.tsx` | ❌ 缺 |

也就是说 `npx shadcn add @beui/agent-activity` 只需要新增 4 个文件，不动任何既有文件——**完全符合 AGENTS.md 的 beUI 迁移纪律**（走 CLI、共享文件不私有化）。

顺带：beui 还有 `agent-progress`（"activity glyph, action verb, live tabular timer"），正好可当运行中的抬头（对应 DSH 的「深度思考中… 12s」）。

### 3.3 它能解决什么 / 不能解决什么

| 能 | 不能 |
|---|---|
| 限高 208px + 内部滚动 → 彻底治好"无限长平铺" | 没有二级过程组、没有类别摘要组头 |
| 流式贴底跟随，长任务只滚一条窄带 | 没有 DSH 的 13 类工具归类 |
| 完成自动收起 + 一行摘要 + 时长 | 没有 4 档展示模式 |
| 紧凑行（等宽 detail 药丸），单行信息密度高 | 中间回复（正文）需要自己决定放哪一层 |
| 依赖几乎全就绪，改动面小 | 需要把 `TurnDisplayItem[]` 映射成 `AgentActivityItem[]`（新纯函数） |

---

## 4. 三方对照表

| 维度 | PiDeck 现状 | 新版 DSH | beui `agent-activity` |
|---|---|---|---|
| 层级 | 2 层过程组织（整轮折叠 → 扁平步骤行）+ 卡片内折叠 | **3 层**（整轮 → 过程组 → 单步） | 2 层（折叠条 → 紧凑行流） |
| 思考+工具是否合并 | ❌ 同层兄弟行 | ✅ 合并成过程组 | ✅ 合并进同一条流 |
| 折叠态摘要 | 纯计数「执行过程: N个工具 N次思考 N段中间回复」 | **类别摘要**「已读取文件并搜索代码」 | 类型摘要 `Ran N tools` / `Thought for 12s` |
| 展开区高度 | **无上限**（`timeline.css:191-200`） | 组体限高 `min(400px,50vh)` + 滚动 + 渐隐 | **208px** + 内部滚动 + mask 渐隐 |
| 运行中行为 | 自动展开（默认）、无限长 | 不提供整轮折叠；组头显示实时活动+详情 | 强制展开，**贴底自动跟随** |
| 完成后 | 1.5s 后自动收起 | 默认收起 | 立即自动收起 + 摘要行 |
| 中间回复层级 | 折叠容器内扁平行 | **一级行**（截断二级组） | 需自行决定 |
| 单条步骤可再展开 | ✅ **已有**（思考/工具卡各自带二级折叠） | ✅ | ❌（行内不再嵌套，仅 search 结果展开） |
| 条目上限 | 120（DOM 挂载）+ 3 轮窗口 + 分页 | 无条数上限；限高 + 「加载更早」 | 限高；无条数上限 |
| 展示模式 | 2 个开关（流式展开 / 新一轮收起） | 4 档（compact/standard/detailed/verbose） | 1 档 + 受控 props |
| 工具归类 | ❌ 无类别概念 | ✅ 13 类 + 计数排序 | 4 类动作（read/edit/run/other） |
| 落地成本 | — | 高 | **低** |

---

## 5. 为什么不能直接照抄 DSH

| 差异 | PiDeck | DSH | 影响 |
|---|---|---|---|
| 过程的分组时机 | `groupToolMessages` 在 AppUtils 里把消息**预先**归成 `thinking-group` / `tool-group` / `retry-group` / `error-group`（`AppUtils.ts:306+`） | 分组是**展示层**独立一遍（`process-groups.ts`），源节点不动 | 可行的做法：在 `buildTurnDisplay()` 之上再加**一个纯函数** `groupTurnProcess()`，不动既有消息归组 |
| 工具类别 | 没有 | 13 类，按工具名匹配 | 需新增纯函数 `toolCategory.ts`（可单测） |
| 阶段回复边界 | 已由 `stopReason` 判定 `interim-answer` / `final-answer`（`buildTurnDisplay.ts:132-144`） | 同样有，且"回复截断二级组" | PiDeck **已有**，直接把 `interim-answer` 当组边界即可 |
| 整轮折叠语义 | `stepsVisible`（含中间回复） | 整轮折叠**不含**最终答案，但含阶段回复 | 语义已一致，可复用 |
| 运行中不可折叠 | ❌ 运行中也允许用户收起 | ✅ 运行/中止/失败轮**禁止**整轮折叠 | 是否对齐需要产品决策 |
| 数据来源 | pi RPC 消息流（`run.items`） | DSH host 的 Node/Step/Turn 投影 | 工具调用缺 `callId` 父子树信息，子调用归类做不到 100% |

---

## 6. 建议方案（分阶段）

> **更新（用户已确认目标结构）**：用户确认的目标是「一个大的可折叠栏里面，中间回复 / 过程组（思考+工具）交替出现，最终回复长期挂在栏外」——即下面**方案 B 的形状**，也正是 DSH `standard` 模式。详见 **§9 设计稿**。
> 因此方案 A 从"首选"降级为"**组体视觉的可选打磨手段**"（组体内部要不要用 `agent-activity` 的紧凑行 + 限高，是 S5 的可选项）。下面两节保留原文，便于对照取舍过程。

### 方案 A：`agent-activity` 化（已降级为组体的可选打磨）

**目标**：折叠区不再无限长；长任务流式期间只占一条限高窄带。

- 新增纯函数 `timeline/buildActivityItems.ts`：`TurnDisplayItem[] → AgentActivityItem[]`
  - `thinking-entry` → `trace(kind:"thinking", label:"思考了 3s", detail: 首句预览)`
  - `tool-entry` → 每个工具调用一行 `trace`/`tool`（动作图标 + 动作词 + 等宽 detail 药丸）
  - `retry-entry` / `error-entry` → `step`（status: active/pending/complete）
  - `interim-answer` → `text` 行或提到容器外（见下）
- 折叠区改为 `<AgentActivity items status duration maxHeight={208} collapseOnComplete />`
  - `status = agentRunning ? "working" : "complete"`、`duration` 复用现有耗时计算（`TurnRow.tsx:104-112`）
- **中间回复的层位**（产品决策点）：
  - A1：仍在折叠区内，作为 `text` 行（改动最小）
  - A2：**提到大折叠栏内的一级**，与过程组并列（= 用户确认的目标结构，见 §9；注意不是"提到大折叠栏外"——最终回复才在栏外）
- 保留 `stepsVisible` 记忆 / 1.5s 自动收起 / 跨会话恢复（这些是用户已经反馈打磨过的行为，不要动）
- 保留 120 挂载预算作为**兜底**（上限可下调，因为展开态高度受限）

**改动面**：`TurnRow.tsx` 折叠区渲染、新增 1 个纯函数、i18n 文案、`ProcessSummaryToggle` 可能被 AgentActivity 的 trigger 取代。
**新依赖**：`npx shadcn add @beui/agent-activity`（新增 4 文件，共享依赖已在）。
**预估**：小-中。

### 方案 B：DSH 式二级过程组（**用户已确认的目标**，见 §9）

- 新增纯函数 `timeline/groupTurnProcess.ts`：按 §2.2 边界规则把扁平序列切成「过程组 + 一级引用」，**用 `interim-answer` / `retry` / `error` / 新一轮作为组边界，工具类别变化不拆组**。
- 新增纯函数 `timeline/toolCategory.ts`：工具名 → 类别（对照 DSH 13 类，按 PiDeck 实际工具名裁剪）。
- 新增 `turn/ProcessGroupStep.tsx`：组头（图标 + 类别摘要 + chevron）、组体默认收起、限高 `min(400px, 50vh)` + 滚动 + 渐隐。
- 组头文案 i18n：运行中「正在读取文件 · src/app.ts」/ 已结束「已读取文件并搜索代码」。
- 保留 A 的限高 + 贴底跟随作为组体的实现手段（两者可共用一套滚动基建）。
- 中间回复提升为一级行（与 DSH 一致）。

**改动面**：2 个新纯函数 + 1 个新组件 + `TurnRow` 渲染循环重写 + 契约测试更新。
**预估**：中。

### 方案 C：全量对齐 DSH（暂不建议）

B + 4 档展示模式（`compact/standard/detailed/verbose`）+ 组头 150ms 最短保留 + 组级滚动跟随策略 + 参数详情优先级表 + 分页锚点规则。
工作量大、产品语义需要重新定义，建议等 A/B 上线后按实际反馈再评估。

---

## 7. 风险与回归面（动手前必读）

1. **正则契约测试（改标识符即红）**：多个测试直接 `readFileSync` 源码做正则断言，改 `TurnRow.tsx` / `buildTurnDisplay.ts` / `ProcessSummaryToggle.tsx` / `timeline.css` 会直接红灯：
   - `tests/turnDisplayStructure.test.mjs`：钉 `buildTurnDisplay(run`、`ProcessSummaryToggle summary={processSummary}`、`showProcessToggle && (`、`item.kind === "interim-answer"`、`<FinalAnswer`、`hidden={!stepsVisible}`、`variant="process"`、`boundMountedSteps(foldableItems, TIMELINE_MOUNTED_STEP_LIMIT`、`mountedSteps.items.map`、`mountedSteps.hiddenCount > 0`、`timeline.showEarlierSteps`、`finalItems.map`、`<Collapsible>`/`<CollapsibleContent`、`execution-summary-collapse`/`-toggle`，并断言不得出现 `stepsVisible ? undefined : "none"`。
   - `tests/turnRowExecutionProcess.test.mjs`：行号敏感的 `indexOf("mountedSteps.items.map")`、`stopped={props.agentRunning !== true}`、`sameAgentRunForRender`、`turnRowPropsEqual` 字段、`.execution-summary-toggle` 圆角契约、禁止 `executionAnswerCount`。
   - `tests/turnCollapsePolicy.test.mjs`：`if (!opts.agentRunning) return false;`、`memory.atTick >= currentTick`、`isLatestRun === false && currentTick > 0`、两个 tick ref 初始化形态、`next[runId] = { visible, atTick }`、`runStepsVisibleMemoryBySessionIdAtomFamily.remove(sessionId)`。
   - 其余相邻文件约 30+：`turnMountBudget` / `turnSegments` / `turnRenderWindow` / `turnWindowEntryBudget` / `timelineContentVisibility` / `timelineEventCards` / `timelineUxPolish` / `liveMountDecision` / `jumpWindowPolicy` / `streamTimelineFixes` / `thinkingLiveHandoff` / `reconcileRuns` / `toolCallComponents` / `sessionTimeline(Ownership)` / `agentTurnRuntimeState` / `paginationWindow` / `messageScrollerGrowthFollow` 等。
   - **必须同步更新断言**，并按 AGENTS.md 要求：新写的源码正则用空白容忍写法（`\s*`、`^[\t ]*` 锚点）。
2. **E2E / DOM 锚点不能破**：
   - `.turn-row` 贴底数量必须 = 3（`e2e/timeline-gobottom-lock.spec.ts:251,286,301,318,333,339`）。
   - `[data-final-answer]`（`e2e/settle-reposition.spec.ts:86`）。
   - `.execution-interim.markdown-body`（`e2e/typewriter.spec.ts:27-62`；`AnswerOutput.tsx:25` 注释标注不可改名）。
   - `data-message-id`（多选分享按它裁剪，`SessionMessageTimeline.tsx:670`）。
3. **Radix 折叠语义（已验证，务必改注释）**：`@radix-ui/react-collapsible@1.1.20` 关闭时 `children: isOpen && children` → **内容完全不进 DOM**。因此 `TurnRow.tsx:280-286` 的「live 流式轮折叠时保持挂载（`display:none`）以保打字机状态」与 `TurnRow.tsx:269-270` 的「CollapsibleContent 自带高度过渡动画」**两条注释均与实现不符**，`hidden={!stepsVisible}` + `agentRunning === true` 分支是死代码。改造时若真要「折叠保留 DOM / 高度动画」，必须显式用 `forceMount` 或自实现，不能沿用假设。
   - 连带：`ThinkingStep` / `ToolStep` 用 `display:none` 保状态的写法，在当前结构下也从未生效（它们只在展开时渲染）。
4. **流式 live 挂载点必须留在容器外**：`InterimAnswer mode="live"` 靠 `liveMount.ts:35-40` 的门控挂在折叠容器外（仅最后一个 agent-run + 有活动正文流才挂），这是打字机 E2E 的采样点。换成 beui 的 `AgentDisclosure`（`inert` + `clipPath`）时要重新验证这条，注意它同样会在 `open=false` 时逻辑上隐藏内容。
5. **性能预算不能退化**：现有「3 轮窗口 + 120 步挂载 + 折叠卸载」是 2026-08 渲染进程 OOM 事故后的治理结果（`turnMountBudget.ts:1-18`）。**限高滚动不等于省 DOM**——限高容器里仍会挂载全部子节点，必须配尾部窗口 / `content-visibility`，否则等于拆掉 120 上限换内存风险。相关预算还有主进程 9 轮/1200 条显示窗口、12 轮/1600 条运行缓存、`MAX_AUTO_HISTORY_LOAD_BYTES=5MB`（`main/pi/AgentManager.ts:249-292`）。
6. **memo 与深比较必须同步**：`TurnRow` 用自定义 `turnRowPropsEqual`（`TurnRow.tsx:435-452`），新增 prop 必须登记，否则历史轮不更新；`sameAgentRunForRender`（`AppUtils.ts:258-287`）逐 item 深比，**新增 item kind 必须补分支**，否则内容变化不重绘；`reconcileRuns`（`AppUtils.ts:587-606`）按 id 复用引用。
7. **atom 记忆与清理配对**：`runStepsVisibleMemoryBySessionIdAtomFamily`（内存级、不持久化，`atoms/session-atoms.ts:341-363`，删除会话时 `.remove`），`newTurnCollapseTick`(324-334)，live 通道 family（`streamingThinkingEntryByIdAtomFamily` / `liveTextActiveBySessionAtom` / `streamingTextBySessionIdAtomFamily`）都要成对释放。
8. **CSS 双轨纪律**：`timeline.css` 属 legacy 轨，新样式必须走 Tailwind utility + shadcn，不得新增手写 class（AGENTS.md）。beui 组件自带 utility 天然合规；`.execution-summary*` 旧规则按"改到哪迁到哪"收窄。另外 `tests/turnRowExecutionProcess.test.mjs:52-59` 钉死 `.execution-summary-toggle` 必须 `border-radius: var(--radius-md)`；`tests/timelineContentVisibility.test.mjs:29-50` 钉「默认折叠让单轮 DOM 轻量」。若用 `AgentActivity` 取代该按钮，这两个契约要一起改。
9. **计数口径与 i18n 同步**：汇总计的是**过程组数**（连续工具调用会被合并，见 §1.6）；空文本 interim 不计。改口径要同时动 `ProcessSummaryToggle`、`segmentSummary.ts`、`rendererCopy.zh-CN.ts` / `en-US.ts`（现有 `activity.execution*` 5 键 + `timeline.showEarlierSteps`），测试断言 `executionInterimCount` 存在。
10. **设置默认值三处同源**：`atoms/app-ui-atoms.ts:155-157`、`main/settings/SettingsStore.ts:158-159`、`src/renderer/src/previewApi.ts:132-133`（`turnCollapsePolicy.test.mjs` 断言前两处）；设置行锚点在 `utils/settingsFieldAnchors.ts:165,171` 与 `components/app/settings/CommonTab.tsx:292-293`。
11. **文件体量**：`TurnRow.tsx` 已 **453 行**（AGENTS.md 目标 ≤400），`SessionMessageTimeline.tsx` 1003 行。方案 A/B 都会让 `TurnRow` 更长——**应先把折叠区渲染抽成独立组件**（例如 `turn/ProcessFold.tsx`）再改，否则违反体量红线。
12. **注释与实现漂移点**（顺手修）：`TurnRow.tsx:44-47`（「run 结束后展开执行过程」已被 `useTurnExecution.ts:103-104` 的 1.5s 自动收起取代）、`TurnRow.tsx:269-286`（高度过渡动画 / live 保持挂载）、`styles/timeline.css:1-9`（头部注释仍写「助手内容：左侧竖线」，实际 rail 已隐藏）。

---

## 8. 待拍板的问题（用户已答复，更新版见 §9.9）

| # | 问题 | 用户答复 |
|---|---|---|
| 1 | 中间回复的层位 | **大折叠栏内一级**（与过程组并列，最终回复在栏外）→ 即方案 B / DSH `standard` 形状，见 §9 |
| 2 | 落地范围 | **先不动手，继续调研** → 本报告扩写 §9 设计稿，产品代码保持零改动 |
| 3–5 | 折叠态摘要 / 运行中可否折叠 / 组体限高 | 未决，见 §9.9 |

---

## 9. 目标结构设计稿（用户已确认）

> **状态：已实现。** 落地清单、刻意做的三个设计决策（依赖方向 / 不变量写进类型 / 不用 `as`）与已知限制，见 [process-group-implementation-contract.md](./process-group-implementation-contract.md) §7。
> 显示方式由设置项 `processGroupDisplay` 控制，**默认开启**（2026-11 起；可在设置中关回平铺显示）。

### 9.1 目标形状

用户原话（2026）：「一个大的可折叠栏里面，内容依次显示为：1. 中间回复 2. 一个折叠栏（里面包含思考和工具调用）3. 中间回复 4. 一个折叠栏（里面包含思考和工具调用）。这个大折叠栏是可以折叠起来的，最后长期挂在外面显示的是"最终回复"。」

规范化：

```
TurnRow（一轮 agent-run）
├─ 行头（Pi/DSH 署名 + 时间）
├─ 大折叠栏（整轮过程栏，可折叠）        ← 现有：Collapsible.execution-summary + ProcessSummaryToggle
│  ├─ ① 中间回复 A          （一级行，与过程组并列）
│  ├─ ② 过程组 G1            （思考 + 工具调用合并，独立折叠）
│  ├─ ③ 中间回复 B
│  ├─ ④ 过程组 G2
│  └─ …（严格按 run.items 原始时序交替）
└─ 最终回复（常驻，永不折叠）            ← 现有：FinalAnswer（容器外）
```

**这不是新发明，就是 DSH `standard` 模式的形状**，逐字对应 DSH 业务规则：
- `conversation-nodes/README.zh.md:29-40`：一轮 =「过程组 G1（思考、read、bash）→ 阶段回复（不属于 G1/G2，但仍属于整轮过程）→ 过程组 G2（思考、run_code）→ 最终答案正文，不随过程收起」。
- 同文件 `:40`：「每次回复都会截断二级组，但只有最终答案正文不参与整轮折叠。」

### 9.2 现有代码可复用度（关键：叶子渲染器几乎零改动）

| 目标元素 | 现有实现 | 需要做什么 |
|---|---|---|
| 大折叠栏 | `Collapsible.execution-summary` + `ProcessSummaryToggle`（`TurnRow.tsx:271-350`） | **复用**；内容从"扁平步骤"改为"中间回复 + 组头"序列 |
| 过程组（组头 + 折叠） | ❌ 无 | 新增 `turn/ProcessGroupStep.tsx` |
| 组体内容（思考/工具行） | `ThinkingStep`（已是单行 + 首句预览）、`ToolStep` → `ToolGroupCard`（`ToolCallComponents.tsx:410-428` 已把工具组平铺为自折叠的 `ToolCard` 列表） | **零改动复用** |
| 单条再折叠（第 3 层） | 卡片级折叠已存在（`ThinkingBlock` / `ToolCard` / `RetryStep` / `ErrorStep`） | **复用** → 完整层级 = 整轮 → 组 → 单条正文，**与 DSH 三层完全一致** |
| 中间回复一级行 | `InterimAnswer`（`variant="process"`） | 渲染器复用，位置从"扁平列表项"改为"组的兄弟节点" |
| 最终回复常驻 | `FinalAnswer`（容器外，`TurnRow.tsx:355-375`） | 零改动 |
| 分组逻辑 | ❌ 无 | 新增纯函数 `timeline/groupTurnProcess.ts` |
| 组头类别摘要 | ❌ 无 | 新增纯函数 `timeline/toolCategory.ts` + i18n（zh/en） |

→ **新增的是一个纯函数层 + 一个组壳组件**，不是重写渲染管线。这也是为什么 §6 的方案 B 被用户选中后是最短路径。

### 9.3 分组算法（纯函数规格，可单测）

```
输入：TurnDisplayItem[]（buildTurnDisplay 的输出，已严格时序）
输出：TurnProcessNode[]
      = Array< {kind:"interim"; item} | {kind:"group"; id; members: TurnProcessEntry[]} >

1. currentGroup: TurnProcessEntry[] = []
2. for item of items:
   a. item.kind === "final-answer"  → 跳过（不参与分组；由 FinalAnswer 在栏外渲染）
   b. item.kind === "interim-answer":
        - item.message.text.trim() === ""  → 跳过，**不作为边界**（live 骨架 / error 空占位，
          否则会产出"一行组头 + 一个空块"，`buildProcessSummary` 已有同类防呆 `segmentSummary.ts:31-36`）
        - 否则 → flush(currentGroup)（仅当非空才产出 group），再 push {kind:"interim", item}
   c. item.kind === "process-entry" → currentGroup.push(item.entry)（thinking / tool / retry / error 都算成员）
3. flush(currentGroup)   // 尾部组
```

`flush` 只在 `members.length > 0` 时产出 group（对齐 DSH「只有存在成员才创建组」）。

**边界与 DSH 的差异（需拍板，见 §9.9）**：

| 输入 | DSH 规则 | 本设计建议 | 理由 |
|---|---|---|---|
| Assistant 阶段回复 | 截断组 + 独立一级 | 同 DSH | 用户明确要求 |
| 模型重试 `model-retry`（PiDeck：`retry-entry`） | 截断组 + 独立节点 | **作组成员，不拆组** | PiDeck 把重试/错误"收进过程行"是刻意的用户反馈改动（`AppUtils.ts:148-171` 注释），拆出来是倒退 |
| 轮次错误 `turn-error`（`error-entry`） | 截断组 + 独立节点 | 同上，作组成员 | 同上 |
| 用户 steering | 截断组 + 独立节点 | 天然已对齐 | steering 是时间线一级用户气泡，不在 `run.items` 内 |
| 工具类别变化 | 不拆组 | 同 DSH | — |

### 9.4 新增状态与归属

| 状态 | 归属 | 生命周期 |
|---|---|---|
| 大折叠栏开合 | **沿用** `stepsVisible`（`useTurnExecution`） | 不动：跨挂载记忆 + 1.5s 自动收起 + 新一轮收起都是已打磨行为 |
| 组开合 | 新增 `runProcessGroupOpenBySessionAtomFamily`（key: `sessionId + runId + groupId`），**但不能是组件局部 `useState`**——切换必须经 timeline chrome 的命令入口，以便切换前后捕获/恢复视口锚点（§9.11 必坏 2） | 默认**收起**（对齐 DSH standard「组正文初始收起」）；收大折叠栏时按 DSH 规则重置内部组开合（`README.zh.md:104`）；删会话时 `.remove`（与 `session-atoms.ts` 现有 family 同规约） |
| 组头类别摘要 | 纯派生（`useMemo(groupTurnProcess → toolCategory)`） | 不存 state |

### 9.5 必须解决的 4 个冲突（本次新增调研的核心发现）

**冲突 1（最关键）：live 中间回复挂在哪。**
- 现状：live 正文挂在**大折叠容器外**（`TurnRow.tsx:353`），因为 Radix 折叠关闭时 children 完全不进 DOM（已验证，见 §1.1）。
- 新结构：中间回复在**大折叠栏内** → 大折叠栏一旦可处于关闭态，live 就会消失。
- DSH 的解法：**运行中的轮不允许整轮折叠**（`contract/turn-process.ts:69-74` `turnProcessAlwaysOpen`：`status === 'open' || aborted || error`）。
- **建议对齐**：`agentRunning === true` 时禁用大折叠栏的 toggle（保留标题行，只显示状态/时长）。这样 live 正文可安全留在栏内，**删掉"容器外 live"这条特殊分支**，结构统一、少一套双渲染路径。
- 备选：大折叠栏用 `forceMount` —— 会牺牲折叠态的 DOM 收益，正是我们要的收益，不建议。

**冲突 2：嵌套滚动与锚定粒度（已完成专项审计，结论见 §9.11）。**
新结构会引入「时间线外层滚动 + 大折叠栏 + 组体限高」三层滚动，还要与 `pinTurnScroll` / stick-to-bottom 跟随共存。
→ **第一步严禁加组级限高**：审计确认组体一旦 `max-height + overflow-y:auto`，引擎的滚轮分流（`useStickToBottom.ts:517-547`）会把内层滚轮判为"子容器在滚"而**消费掉，不产生用户意图**——不解锁跟随、也不取消在途的 settle 定位动画；且 touch / keyboard / 滚动条拖动三条路径语义不一致。**不加限高就完全绕开这一整类问题**（§9.11 必坏 3）。
→ **真正的新增风险是锚定粒度**：钉行锚点是**整轮**（`.turn-row[data-message-id]`），组级展开/收起若发生在**被钉住的同一轮内、视口上方**，轮根 `offsetTop` 漂移 = 0 → 补偿成为 no-op → 视线跳 Δ 高度。**这是新结构必然引入的**（§9.11 必坏 2），必须按 §9.11 的约束 5/6 处理。
→ 现成保护（可复用，但只覆盖已识别场景）：`lib/stick-to-bottom/` 的 `resizeScrollGuard`（generation token 区分"高度突变引发的 scroll"与"用户主动滚动"）与 `followState`；`lib/pinTurnScroll.ts` 可被用户操作取消的缓动；controller 观察 `[role="log"]` 的 `pinBrowseRow()`（`useSessionTimelineController.ts:1560-1572`）。

**冲突 3：组头类别摘要需要工具归类。**
「已读取文件并搜索代码」这类文案必须先有 `toolCategory.ts`。pi 的工具名（`read` / `edit` / `write` / `bash` / `powershell` / `grep` / `glob` …）与 DSH 不完全相同，需按实际工具名建表 + 单测；DSH 的 13 类表（`README.zh.md:230-244`）可直接裁剪复用。

**冲突 4：中间回复与最终回复目前视觉同款**（§1.6）。
提到一级后必须加区分标记，否则用户分不清哪段是最终答案。
→ 建议中间回复降一档（更小字号 + 次级色 + 左侧细线或"阶段回复"标签）。**必须拍板。**

### 9.6 这个结构为什么能治好"乱"（收益机制）

不是靠限高，而是靠**把一次展开的信息量降一个量级**：

| 交互 | 现状看到什么 | 新结构看到什么 |
|---|---|---|
| 大折叠栏收起（历史默认） | 大折叠栏标题 + 最终回复 | 同（无变化） |
| 大折叠栏展开（运行中默认） | **全部步骤平铺（最多 120 行，每行含卡片子树）** | **N 个组头 + M 段中间回复，看不到任何单条思考/工具** |
| 点某个组头 | — | 该段的思考/工具行 |
| 点某张卡片 | 展开该条正文 | 展开该条正文 |

现状的展开是 O(步骤数)，新结构的展开是 O(组数 + 中间回复数)。**这才是 DSH 看起来清楚的根因。**

### 9.7 DOM / 性能影响

| 状态 | 现状 DOM | 新结构 DOM |
|---|---|---|
| 大折叠栏收起 | 0（Radix 卸载） | 0 |
| 大折叠栏展开 | 尾部 120 条步骤（每条含卡片子树） | N 个组头 + M 段中间回复（组体默认收起 = 0） |
| 单个组展开 | — | 该组成员（受预算约束） |

→ 展开态 DOM 量下降一到两个数量级。建议把 `TIMELINE_MOUNTED_STEP_LIMIT`（120）从"每轮"改为"**每组**"预算，并新增一条**组数上界**（例如单轮最多挂 40 个组头），避免极端会话出现几百个组头。

### 9.8 落地切片（仍不动手，仅计划；每片可独立交付/回滚）

| 切片 | 内容 | 门禁 |
|---|---|---|
| **S0** | 抽 `turn/ProcessFold.tsx`：把 `TurnRow.tsx:271-350` 折叠区搬出去（`TurnRow.tsx` 已 453 行超体量红线） | 纯搬运、视觉零变化；`npm run typecheck` + `node --test tests/turnDisplayStructure.test.mjs tests/turnRowExecutionProcess.test.mjs` |
| **S1** | `timeline/groupTurnProcess.ts` + 单测 | 覆盖 §9.3 全部分支：空文本 interim 不作边界、空组不产出、首/尾组、连续 interim、无 interim（最常见：单组） |
| **S2** | `timeline/toolCategory.ts` + 单测 | 按 pi 实际工具名分类；未知名归 `tools` |
| **S3** | `turn/ProcessGroupStep.tsx`（组头 + 组体）+ i18n（zh/en 同步） | 组默认收起；组头类别摘要 + a11y（`aria-expanded`/`aria-controls`） |
| **S4** | `ProcessFold` 改为「中间回复 + 组头」序列；运行中禁用大折叠栏（冲突 1）；中间回复视觉标记（冲突 4） | 更新 `turnDisplayStructure` / `turnRowExecutionProcess` / `timelineContentVisibility` 契约；重跑 E2E：`.turn-row`=3（`e2e/timeline-gobottom-lock.spec.ts`）、`.execution-interim` 打字机（`e2e/typewriter.spec.ts`）、settle 定位（`e2e/settle-reposition.spec.ts`） |
| **S5**（可选） | 组体限高 + 组内滚动跟随；组体改用 beui `agent-activity` 紧凑行（§3） | 需独立评估三层滚动体验 |

### 9.9 仍未拍板的问题

1. **中间回复的视觉标记**：更小字号 + 次级色？左侧细线？"阶段回复"标签？（冲突 4）
2. **运行中是否禁止折叠大折叠栏**：建议禁止（对齐 DSH，且能删掉容器外 live 分支）。
3. **重试/错误行**：留作组成员（建议）还是像 DSH 一样当组边界？
4. **组数上界**：单轮最多挂多少个组头？（建议 40）
5. **大折叠栏展开时是否自动展开第一个组**？（DSH：否，全部组默认收起）
6. **大折叠栏折叠态的标题文案**：保留现在的纯计数（「N个工具 N次思考 N段中间回复」），还是像 DSH 那样**只显示「用时 X 秒」+ 状态**（DSH 的计数只作 DOM 属性、不呈现，见 §2.6）？
7. **折叠态是否改成「可搜索隐藏」**：DSH 折起成员用 `hidden="until-found"` 保持挂载（Ctrl+F 能搜到过程内容、有状态工具视图不丢），PiDeck 现在是 Radix 卸载。改成 `until-found` 会牺牲折叠态的 DOM 收益，但补上"过程内容搜不到"的缺口（§2.6）。

### 9.10 过程组外壳：自建 vs beui `agent-activity`（追评）

用户提到 beui 有"类似的渲染组件"，我核了源码后给出明确取舍：

| 方案 | 结论 | 理由 |
|---|---|---|
| **A. 自建 `ProcessGroupStep.tsx`**（Radix `Collapsible` + 组头 + 组体） | ✅ **推荐** | 与现有 `.execution-summary` 同一观感与 token；组头文案可自由做成类别摘要；组体直接塞现有 `ThinkingStep` / `ToolStep` **零改动复用**；不引新依赖；Tailwind utility 合规 |
| B. `AgentActivity` 作为**组壳** | ⚠️ 可做但要打架 | `AgentActivityTool` 行只能承载 `action` + `target` 文本，**装不下 `ToolCard` 的 diff / 工具结果 / 完整输出视图**。要用就得把每一步塞进它的 `text` 行（`text.content: ReactNode`，技术上可行），但外层行自带的 `text-muted-foreground` / `min-h-7` / `px-1.5 py-1` 会污染 PiDeck 现有观感——正是 AGENTS.md 警告的「半吊子 utility 比没写更糟」。另外 `status="working"` 会**强制展开**，与"组体默认收起"冲突（需按组区分 working/complete 规避） |
| C. `AgentActivity` 作为**大折叠栏** | ❌ 不建议 | 同样装不下 `ToolCard` 的完整内容 |
| D. beui 只做**局部增强** | ✅ 可选项 | `thinking-shimmer` 做组头运行中动效、`agent-progress` 做「深度思考中… 12s」抬头（对应 DSH 的 `TurnProcessNodeView` label）；这两个组件自带 utility、无历史包袱，可安全引入 |

→ **默认路线：自建组壳（A）**；S5 再评估是否把组体切换成 `AgentActivity` 的紧凑限高流（B），或只引入 `thinking-shimmer` / `agent-progress`（D）。

---

### 9.11 滚动专项审计结论（**动手前必读**）

对现有跟随/锚定机制做了专项只读审计，结论：**贴底跟随对"整轮级"高度突变本身安全，但新结构会引入 3 处必坏点**。

#### 现有机制（两个补偿 owner，原生锚定已关）

```
wheel/touch/key/滚动条 ──► useStickToBottom（唯一跟随状态机）
   applyWheelEscape（嵌套滚动分流）useStickToBottom.ts:517-547 ─► applyUserInput :431-464
内容增高 ──► content ResizeObserver :676-740 ──► 在底部? >28px instant 同步写底 :708-716 / 否则弹簧 :717-724
内容收缩 ──► 只记几何，不改跟随态 :726-728
浏览态上方长高 ──► controller RO（观察 [role=log]）useSessionTimelineController.ts:1560-1572
   ──► pinBrowseRow :941-962 ──► pinViewportAfterPrepend :915-925 ──► engine.restoreAt :417-427
```
- 跟随态是**状态机**（只由用户输入/显式命令改变，`followState.ts:1-15`；`handleScroll` 非用户驱动直接 return `useStickToBottom.ts:494-496`），几何阈值只用于报告与守卫。
- 关键阈值：`AT_BOTTOM_TOLERANCE_PX=25`、`STICK_TO_BOTTOM_OFFSET_PX=70`、`FAR_FROM_BOTTOM_PX=140`、引擎 instant 阈值 `28px`（`message-scroller.tsx:91`）、settle 守护 `70px` + 视口锚点比例 `0.3`（`useSessionTimelineController.ts:78,997,1003`）。
- 原生锚定已关：`foundation.css:3204` + `message-scroller.tsx:205` `overflow-anchor:none`；**所有补偿必须显式**。

#### 3 处必坏点

| # | 坏点 | 机制 | 后果 |
|---|---|---|---|
| 1 | **settle 定位时序** | 1.5s tick → 320ms 后 `scrollFinalAnswerToUpperMiddle`（`SessionMessageTimeline.tsx:487-508`）依赖「大栏收起后净高≈0」+「高度一次性到位」+ `[data-final-answer]` 存在；守卫 (b) 距底≤70、(d) 净位移>70（`:983,1003`）。且 `onAutoCollapsed` **从未被 timeline 传入**，定位其实只依赖那个 320ms 定时，与"是否真折叠"解耦 | 大栏收起后仍占高 → (b)/(d) 短路 → **定位静默不发生**（回底按钮不出、视口不回中上）；若加高度动画，320ms 读到中间态高度 → 落点偏（e2e 容差 ±90px） |
| 2 | **锚定粒度（新结构必然引入）** | 钉行锚点是**整轮**（首个可见 `.turn-row[data-message-id]`，`useSessionTimelineController.ts:107-136`）。组级展开/收起若发生在**被钉住同一轮内、视口上方**，轮根 `offsetTop` 漂移 = 0 → `pinBrowseRow` 补偿是 no-op | 视线跳 Δ 高度。当前代码没有"轮内组级高度变化"这种路径，**是本改动引入的**（标注：触发场景为推断，机制为读码确认） |
| 3 | **嵌套滚动吞掉用户意图** | 组体一旦 `max-height + overflow-y:auto`，`applyWheelEscape`（`useStickToBottom.ts:517-547`）判定"子容器还能滚"→ return，**不产生用户意图**；内层 scroll 事件也不冒泡到引擎（`:475-479`）。另有 3 处不对称：touch start 绑视口会冒泡（`:570-572`）、键盘只绑视口（`:606-611`）、**拖内层滚动条完全不改跟随态**（`:555-568`）。且内层滚轮**不会取消在途 settle 动画**（`:1474-1477`） | 用户在组内滚动时，跟随态/在途动画行为与直觉不一致 |

**不会坏**：折叠造成的**收缩**（隐藏→显示）不会被误判成用户上滑（负 resize 只记几何，意图只来自真实输入）。

#### 必守约束（10 条，可执行）

1. 轮根 `.turn-row[data-message-id=run.id]`、`[data-final-answer=run.id]`、`.execution-interim.markdown-body` **原样保留**（`AnswerOutput.tsx:25` 标注不可改名）。
2. **大栏展开/收起必须是一次性净高度跳变**。若引入高度动画（beui `agent-disclosure` 的 clipPath / framer layout），必须把 `TURN_SETTLE_SCROLL_DELAY_MS`(320) 与动画时长绑定，否则等 2 失效。
3. **大栏收起后过程区净高必须 ≈0**（保持"未进 DOM"语义）。禁止 `max-height:0` + 常驻 DOM 之类仍占高的收法。
4. 新增组只加 **`data-process-group-id`**（稳定 id：`runId + 首成员 entryId`，**不许用会漂的 index**）；**不加** `data-message-id`——`computeCurrentAnchor` 的兜底分支会遍历全部 `[data-message-id]`（`:388`），把默认收起（已卸载）的组内元素当锚点会导致切回时找不到 → 降级到顶部。
5. **组开合必须走能保住锚点的入口**（对应必坏 2）：切换前捕获"视口内第一个可见内容项 + 偏移"，切换后恢复；参考现有 `pinViewportAfterPrepend` / `engine.restoreAt`（`:915-925`、`useStickToBottom.ts:417-427`）的原子定位写法。这也是 §9.4 把组开合从组件局部 state 提升到 chrome 命令的原因。
6. **第一步不加组体限高**；若后续要加：必须 `overflow-y:auto`（不能 `hidden`）、子项 `shrink-0`（AGENTS.md 已记的塌陷陷阱）、限高取固定值；并显式调 `escapeAutoScroll()` 处理"组内滚到底后希望解锁跟随"的场景，不要依赖自然滚轮。
7. 浏览态任何程序化布局变化（组展开 / 全量挂载 / 扩窗）都要让 `[role=log]` 的 RO 有机会跑 `pinBrowseRow`；不要裹进不会清理的 `skipBrowsePin` / `markProgrammaticScroll` 窗口。
8. 不许打开 `overflow-anchor`。
9. 保持"一轮一个 `.turn-row` 根"，**不要把组的 DOM 提到轮根外**（否则 `.turn-row`=3 的贴底窗口计数与轮窗口裁剪会错）。
10. 运行中禁止整轮折叠时（§9.5 冲突 1），live 中间回复**必须仍处于挂载态**——不能靠 `open=false` 卸载（那会切断 `.execution-interim.markdown-body` 打字机与 settle 采样）。禁用折叠正好满足这条。

#### 测试影响（滚动相关）

- **必须保持绿**（几何契约）：`e2e/timeline-gobottom-lock.spec.ts`（`:249,251` 按钮=0、`.turn-row`===3；`:263-266` scrollHeight 变化≤2、dist≤2）、`e2e/settle-reposition.spec.ts`（`:150-163` 30%±90、`:206-207` ±5px、`:225-231` dist<90）、`e2e/steer-scroll-repro.spec.ts`、`e2e/session-scroll-anchor.spec.ts`（≤28px）、`tests/browsePin.test.mjs`、`tests/resizeScrollGuard.test.mjs`、`tests/programmaticScrollGuard.test.mjs`、`tests/pinTurnScroll.test.mjs`。
- **必须同步修改**（源码正则契约）：`tests/messageScrollerGrowthFollow.test.mjs`（硬约束：`:143` 必须有 `pinBrowseRow()`、`:145` 不许出现 `timeline.scrollTop = nextTop`）、`tests/sessionTimeline.test.mjs`（锚点选择器字面量 `:120-128`）、`tests/stickToBottomEscapeTolerance.test.mjs`、`tests/stickToBottomUserIntent.test.mjs`、`tests/timelineContentVisibility.test.mjs:44-48`（仍断言 `<Collapsible>`/`<CollapsibleContent>`，换壳必改）。
- **新增守卫（建议）**：组锚点 e2e ——「滚动到某轮中部 → 展开/收起该轮**上方**的一个组 → 断言被钉住轮的偏移漂移 ≤2px」。**按现有机制这条会失败**，正是必坏 2 的守卫。
- **易漏**：新组体类名必须并入 `QUOTE_EXCLUDED_SELECTOR`（`components/session/timeline/selectionToolbarPolicy.ts:7`，测试 `tests/selectionToolbarPolicy.test.mjs:29-32`），否则在组内划选会弹出引用浮层。

---

## 附：证据索引

| 主题 | 位置 |
|---|---|
| PiDeck 折叠渲染 | `src/renderer/src/components/session/turn/TurnRow.tsx:260-422` |
| PiDeck 展示序列纯函数 | `src/renderer/src/components/session/timeline/buildTurnDisplay.ts:45-158` |
| PiDeck 折叠态决策 | `src/renderer/src/components/session/turn/useTurnExecution.ts:56-144` |
| PiDeck 摘要统计 / 文案 | `.../timeline/segmentSummary.ts:19-39`、`.../turn/ProcessSummaryToggle.tsx`、`src/renderer/src/i18n/rendererCopy.zh-CN.ts:4016-4019` |
| PiDeck 120 挂载预算 | `.../timeline/turnMountBudget.ts:21,37-45`（契约 `tests/turnMountBudget.test.mjs`） |
| PiDeck 3 轮窗口 | `.../timeline/turnRenderWindow.ts:12-16` |
| PiDeck 折叠区无高度上限 | `src/renderer/src/styles/timeline.css:191-200` |
| PiDeck 流式默认展开 | `src/main/settings/SettingsStore.ts:158`、`src/renderer/src/App.tsx:665-667` |
| DSH 整轮折叠条 | `packages/client/ui-chat/src/client/chat/TurnProcessNodeView.tsx:27-65` |
| DSH 过程组容器 | `.../chat/ChatGroupSeat.tsx:128-189`（组头 `:91-126`） |
| DSH 节点模型 | `.../contract/chat-nodes.ts:98-109`、`.../contract/turn-process.ts:20-74`、`.../contract/process-groups.ts` |
| **DSH 业务规则全文（中文）** | `.../conversation-nodes/README.zh.md`（分组 `:169-202`、整轮折叠 `:68-104`、展示模式 `:108-164`、活动摘要 `:206-299`） |
| DSH 分页 | `.../chat/ChatView.tsx:243-244`、`.../locale.ts:88` |
| DSH 展示模式能力表 | `packages/client/ui-chat/src/client/presentation-policy.ts:11-52`、`chat-settings.ts:12,32` |
| Radix 折叠关闭即卸载 | `node_modules/@radix-ui/react-collapsible/dist/index.mjs:137`（`children: isOpen && children`） |
| E2E / DOM 锚点 | `e2e/timeline-gobottom-lock.spec.ts`、`e2e/settle-reposition.spec.ts:86`、`e2e/typewriter.spec.ts:27-62` |
| PiDeck 滚动跟随 / 锚定 | `src/renderer/src/lib/stick-to-bottom/{useStickToBottom,followState,resizeScrollGuard}.ts`、`src/renderer/src/hooks/useSessionTimelineController.ts:107-136,941-962,971-1057,1560-1572` |
| PiDeck 划选策略 | `src/renderer/src/components/session/timeline/selectionToolbarPolicy.ts:7`（`QUOTE_EXCLUDED_SELECTOR`） |
| DSH 分组算法（代码级） | `packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts:13,146-164` |
| DSH 可搜索隐藏 / 焦点守卫 | `packages/client/ui-chat/src/client/chat/searchable-hidden.ts:14-29` |
| DSH 状态存续 | `packages/client/ui-chat/src/client/stores.ts:31-46`、`chat/use-disclosure.ts:11-21` |
| DSH 宿主分页 | `packages/api/session-controller/src/client/sessions/session.ts:51-62`、`api/session-controller/src/history.ts:392-427` |
| DSH 版本确认 | `deepseek-harness-0.1.1-rc.2` 无 `turn-process/stepProcess/processGroup`（该能力为 master 新增）；`dsh-desktop` 只是桌面壳 |
| beui `agent-activity` | `https://beui.dev/r/agent-activity.json`（registry index: `https://beui.dev/r/registry.json`；上游展示页 https://21st.dev/@starc007/components/agent-activity） |

> DSH 对照代码位于 `F:\deepseek-harness-master\deepseek-harness-master`（同盘另有 `deepseek-harness-0.1.1-rc.2` 与 `dsh-desktop`，本报告只以后者为辅、未展开）。
