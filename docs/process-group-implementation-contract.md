# 过程组实现契约（冻结版）

- **状态**：**已实现并通过验证**（T1–T5 全部完成；`typecheck` 0 错误、针对性测试全绿、全仓 biome 格式干净）。接口在实现期间冻结；后续要改先改本文件再改代码。
- **分支**：`research/dsh-process-display`
- **关联文档**：[timeline-process-display-research.md](./timeline-process-display-research.md) §9（设计稿）、[process-group-scroll.html](./mockups/process-group-scroll.html)（视觉效果稿）
- **已定产品决策**：组头不带步数；大折叠栏文案不动；中间回复不加视觉标记（保持正文样式）；重试/错误 = 与中间回复同级的一级行 + 截断组；组体限高 + 内部滚轮；行内容一律照抄现状。

---

## 0. 全局硬性规则（违反即返工）

1. **不改现有行组件**：`ThinkingBlock` / `ToolCard` / `TimelineMarker` / `InterimAnswer` / `FinalAnswer` / `RetryStep` / `ErrorStep` 一个字都不改，只能复用。
2. **样式只用 Tailwind utility**（AGENTS.md 硬性）：禁止新增手写 CSS class。语义 token 用现有变量（`--color-*` / `--radius-md` / `--font-size-caption` 等），不写死色值。
3. **i18n 必须 zh-CN / en-US 同步**：JSX 里禁止硬编码中英文。
4. **用户可见文案一律走 `t()`**；新键必须两个 locale 都加。
5. **测试**：单测用 `tests/helpers/loadTsCommonJs.mjs`（**不要手写 vm 加载器**）。跨 realm 断言必须先 `JSON.parse(JSON.stringify(x))` 归一化，再做 `assert.deepEqual`（仓库既有惯例，否则 `deepStrictEqual` 会因原型不同判不等）。
6. **不碰他人写作用域**。写作用域清单见各自任务描述。
7. 任何改动后必须自跑：`node --test tests/<你的测试>.test.mjs`（node 在 `D:\nodejs\node.exe`，bash 里用 `/mnt/d/nodejs/node.exe`，路径要传 **Windows 形式** 如 `F:\PiDeck\tests\x.test.mjs`）。

---

## 1. 已冻结的纯函数（**已完成，勿改**）

### `src/renderer/src/components/session/timeline/toolCategory.ts`

```ts
export type ToolActivityCategory = "read" | "readImage" | "search" | "write" | "edit" | "commands" | "code" | "webSearch" | "webFetch" | "subagents" | "plan" | "questions" | "tools";
export interface ActivityCount { kind: ToolActivityCategory; count: number }
export function toolActivityCategory(toolName: string): ToolActivityCategory;
export function activityCountsFromToolNames(toolNames: readonly string[]): ActivityCount[];
export function rankActivityCounts(counts: readonly ActivityCount[]): ActivityCount[];
export function topActivityKinds(counts: readonly ActivityCount[], max?: number): ToolActivityCategory[];
export function activityCategoryLabelKey(kind: ToolActivityCategory, phase: "running" | "done"): string;
```

### `src/renderer/src/components/session/timeline/groupTurnProcess.ts`

```ts
export type TurnProcessNode =
  | { kind: "interim"; id: string; message: ChatMessage }
  | { kind: "group"; id: string; members: TurnProcessEntry[]; counts: ActivityCount[]; toolCount: number; hasThinking: boolean }
  | { kind: "entry"; id: string; entry: TurnProcessEntry };   // retry / error：一级行 + 组边界

export function toolNamesOfEntry(entry: TurnProcessEntry): string[];
export function groupTurnProcess(items: readonly TurnDisplayItem[]): TurnProcessNode[];
export function lastProcessGroup(nodes: readonly TurnProcessNode[]): Extract<TurnProcessNode, { kind: "group" }> | undefined;
export function lastProcessGroupIndex(nodes: readonly TurnProcessNode[]): number;
```

**分组语义**（写 UI 时按这个理解，不要自己重新分组）：
- `final-answer` 不参与分组（由 `FinalAnswer` 在大折叠栏外渲染）。
- 有文本的 `interim-answer` → 先关掉当前组，再产出一条一级 `interim` 节点。
- **空文本 `interim-answer` 既不作边界也不产出**（live 骨架 / 空 error 占位；把它当边界会凭空多出空组头）。
- `retry-entry` / `error-entry` → 先关掉当前组，再产出一条一级 `entry` 节点（与中间回复同级）。
- 其余（`thinking-entry` / `tool-entry`）→ 并入当前组；**工具类别变化不拆组**。
- 组 id = `grp:${首成员 id}`，只要该组内容不变就稳定（组开合状态、React key、滚动锚点都挂在它上面）。

---

## 2. 冻结的 i18n 键（zh-CN 与 en-US 必须都有）

| 键 | zh-CN | en-US |
|---|---|---|
| `timeline.processGroup.running.read` | 正在读取文件 | Reading files |
| `timeline.processGroup.running.readImage` | 正在读取图片 | Reading images |
| `timeline.processGroup.running.search` | 正在搜索代码 | Searching the code |
| `timeline.processGroup.running.write` | 正在写入文件 | Writing files |
| `timeline.processGroup.running.edit` | 正在编辑文件 | Editing files |
| `timeline.processGroup.running.commands` | 正在运行命令 | Running commands |
| `timeline.processGroup.running.code` | 正在运行代码 | Running code |
| `timeline.processGroup.running.webSearch` | 正在搜索网页 | Searching the web |
| `timeline.processGroup.running.webFetch` | 正在访问网页 | Fetching pages |
| `timeline.processGroup.running.subagents` | 正在协调子代理 | Coordinating subagents |
| `timeline.processGroup.running.plan` | 正在更新计划 | Updating the plan |
| `timeline.processGroup.running.questions` | 等待你的操作 | Waiting for you |
| `timeline.processGroup.running.tools` | 正在调用工具 | Calling tools |
| `timeline.processGroup.done.read` | 已读取文件 | Read files |
| `timeline.processGroup.done.readImage` | 已读取图片 | Read images |
| `timeline.processGroup.done.search` | 已搜索代码 | Searched the code |
| `timeline.processGroup.done.write` | 已写入文件 | Wrote files |
| `timeline.processGroup.done.edit` | 修改了文件 | Edited files |
| `timeline.processGroup.done.commands` | 执行了命令 | Ran commands |
| `timeline.processGroup.done.code` | 运行了代码 | Ran code |
| `timeline.processGroup.done.webSearch` | 已搜索网页 | Searched the web |
| `timeline.processGroup.done.webFetch` | 已访问网页 | Fetched pages |
| `timeline.processGroup.done.subagents` | 已协调子代理 | Coordinated subagents |
| `timeline.processGroup.done.plan` | 更新了计划 | Updated the plan |
| `timeline.processGroup.done.questions` | 向用户提出了问题 | Asked you a question |
| `timeline.processGroup.done.tools` | 已调用工具 | Called tools |
| `timeline.processGroup.analyzing` | 正在分析请求 | Analyzing the request |
| `timeline.processGroup.analyzed` | 已完成分析 | Finished analyzing |
| `timeline.processGroup.separator` | `·` | `·` |
| `timeline.processGroup.joinTwo` | `{first}并{second}` | `{first} and {second}` |
| `timeline.processGroup.joinList` | `{items}` | `{items}` |
| `timeline.processGroup.listSeparator` | `、` | `, ` |
| `timeline.processGroup.more` | `{title} 等` | `{title}, and more` |

### 2b. 设置开关的 i18n 键（同样 zh-CN + en-US 都要有）

| 键 | zh-CN | en-US |
|---|---|---|
| `settings.processGroupDisplay` | 过程组显示（实验） | Grouped process display (experimental) |
| `settings.processGroupDisplayDesc` | 开启后，一轮里的连续思考与工具调用会合并成「过程组」，点开组头才展开明细；关闭则保持现在的平铺方式。 | When on, consecutive reasoning and tool calls in a turn merge into process groups; expand a group header to see its details. Turn it off to keep the current flat layout. |

**默认值：关闭（走保守项）**。理由：AGENTS.md「特性开关……默认值取保守项」。要改成默认开启只需同步改 5 处默认值（见 §6）。

---

## 3. 冻结的组开合状态接口（手风琴）

`src/renderer/src/components/session/turn/useProcessGroupState.ts`

```ts
export interface ProcessGroupOpenState {
  /** 自动通道：只有一个槽位，永远指向「最新的组」。新组出现时推进到新组，旧自动组因此关闭。 */
  readonly autoGroupId: string | undefined;
  /** 手动通道：用户亲手点开的组，互不干扰；新内容不影响它们。 */
  readonly manualGroupIds: readonly string[];
}

export const EMPTY_PROCESS_GROUP_STATE: ProcessGroupOpenState;

export function isGroupOpen(state: ProcessGroupOpenState, groupId: string): boolean;
/** 最新组变化时推进自动槽（同值返回原引用，便于 memo）。 */
export function advanceAutoGroup(state: ProcessGroupOpenState, latestGroupId: string | undefined): ProcessGroupOpenState;
/** 用户点击组头。open=true：加入手动集合，并清空占着该组的自动槽；open=false：从手动集合移除，若占着自动槽也一并清空。 */
export function toggleGroupByUser(state: ProcessGroupOpenState, groupId: string, open: boolean): ProcessGroupOpenState;
/** 大折叠栏关闭时调用：两个通道一起清空。 */
export function resetProcessGroupState(): ProcessGroupOpenState;
```

`src/renderer/src/atoms/session-atoms.ts`（只加这一处 + 清理一处）
```ts
/** 过程组手风琴状态，按 sessionId → runId 两级记忆（内存级，不持久化，与 runStepsVisibleMemory 同规约）。 */
export const processGroupOpenBySessionIdAtomFamily = atomFamily((sessionId: string) => atom<Record<string, ProcessGroupOpenState>>({}));
```
并在既有的「删除会话」清理路径（`runStepsVisibleMemoryBySessionIdAtomFamily.remove(sessionId)` 那一组附近）补 `processGroupOpenBySessionIdAtomFamily.remove(sessionId)`。

### 3b. 冻结的窄 hook（集成层直接用，名字与签名不许改）

```ts
export function useProcessGroupOpenState(
  sessionId: string | undefined,
  runId: string | undefined,
): {
  /** 本轮的组开合状态；无会话/无 run 时返回 EMPTY_PROCESS_GROUP_STATE */
  groupState: ProcessGroupOpenState;
  /** 用户点某个组头：走 toggleGroupByUser 并写回 atom */
  toggleGroup: (groupId: string, open: boolean) => void;
  /** 最新组变化时推进自动槽（内部同值短路，避免无谓写 atom） */
  syncLatestGroup: (latestGroupId: string | undefined) => void;
  /** 大折叠栏关闭时调用：两通道一起清空并写回 */
  reset: () => void;
};
```

- `sessionId` / `runId` 为空 → `groupState` 返回 `EMPTY_PROCESS_GROUP_STATE`，三个命令退化为安全 no-op（不抛错）。
- `syncLatestGroup` 必须同值短路；`advanceAutoGroup` 值没变时返回原引用 —— 两者都要有测试。
- 三个命令必须 `useCallback` 稳定引用（集成层会把它们放进 memo 组件的 props）。

**语义要点（产品已确认）**：
- 大折叠栏展开时 → 自动槽指向**最新**的过程组。
- 出现**新组** → 自动槽换到新组，**上一个自动展开的组自动关闭**；手动打开的组不受影响。
- 用户手动点开的组 → 一直开着，直到 (a) 用户自己点关，或 (b) 大折叠栏关闭。
- 大折叠栏关闭 → 组状态全部清空。**组内卡片的展开态不需要额外代码**：Radix 折叠时子树整体卸载（`children: isOpen && children`），组件内部 state 随之销毁。

---

## 4. 冻结的组件接口

### `src/renderer/src/components/session/turn/ProcessGroupStep.tsx`（T3 负责）

```ts
export type ProcessGroupStepProps = {
  group: Extract<TurnProcessNode, { kind: "group" }>;
  /** 该组是否「最新组且在跑」→ 组头走「正在…」文案 + shimmer */
  running: boolean;
  /** 该组当前是否展开 */
  open: boolean;
  onToggle: (open: boolean) => void;
  showThinking?: boolean;
  sessionId?: string;
  onOpenFile?: (path: string) => void;
  onOpenExternal: (url: string) => void;
};
export const ProcessGroupStep = memo(function ProcessGroupStep(props: ProcessGroupStepProps) { ... });
```

渲染要求：
- **组头是一个 `<button>`，宽度必须 `w-full`**（占满内容列，与流式输出同宽），悬停底色也随之铺满整行 —— **不要出现「文字多宽、框就多宽」**。内部布局与现有过程行同构：左起 20px 类别图标方块 → 类别文案 → chevron。
- 组头文案：
  - `running === true`：`t(activityCategoryLabelKey(topKind, "running"))` + 若有实时详情则追加 `t("timeline.processGroup.separator")` + 详情；文案走 `<ShimmerText>`（复用 `src/renderer/src/components/session/ShimmerText.tsx`）。
  - 已结束：`topActivityKinds(group.counts, 3)` → 分别取 `done` 文案，按 `joinTwo` / `joinList` + `listSeparator` 组装；超过 3 类用 `more` 包裹；**`counts` 为空且有思考时**用 `t("timeline.processGroup.analyzed")`。
  - 实时详情来源：组内最后一个 `tool-entry` 的工具名 + 参数 → 复用 `timeline/toolPhrase.ts` 的 `getToolPhraseFromArgs(toolName, args).loadingLabel`；取不到就不显示详情。
- **组体**：`max-h-[min(320px,30vh)] overflow-y-auto overscroll-behavior-contain`，外层 `ml-5 border-l-2 border-border-subtle pl-3`（沿用现有「思考展开正文」的缩进语言）。限高 flex 列里的子项必须 `shrink-0`（AGENTS.md 记录过的塌陷事故）。
- **组体内容 = 复用现有组件**：`thinking-entry` → `<ThinkingStep hidden={false} .../>`；`tool-entry` → `<ToolStep stopped={!running} hidden={false} .../>`。
- **组内挂载预算（必须做，否则会 OOM 回归）**：一个组可能有几百个成员，全挂进 DOM 就是当年 `turnMountBudget` 要治的事故（2026-08 渲染进程 OOM）。所以组体必须对 `group.members` 套 `boundMountedSteps(group.members, TIMELINE_MOUNTED_STEP_LIMIT)`（`timeline/turnMountBudget.ts`，limit=120，从尾部保留）；`hiddenCount > 0` 时在**组体顶部**渲染与 TurnRow 同款的 ghost 入口按钮，文案用现有键 `t("timeline.showEarlierSteps", { count })`；点击后本地 `showAll` 全量挂载（用 `useState`，随组 id 变化重置，写法参照 `TurnRow.tsx` 里 `expandedStepsRunId` 的既有模式）。
- `aria-expanded` / `aria-controls` 必须有；组体 `id` 用 `useId()`。

### `src/renderer/src/components/session/turn/ProcessFold.tsx`（Lead 负责）

```ts
export type ProcessFoldProps = {
  nodes: readonly TurnProcessNode[];
  stepsVisible: boolean;
  agentRunning?: boolean;
  isStreaming?: boolean;
  showThinking?: boolean;
  sessionId?: string;
  /** 当前 live 中间回复 id（容器外渲染，这里跳过避免双份） */
  liveInterimId?: string;
  groupState: ProcessGroupOpenState;
  onToggleGroup: (groupId: string, open: boolean) => void;
  onOpenFile?: (path: string) => void;
  onOpenExternal: (url: string) => void;
  onCollapse: () => void;
};
```

---

## 5. 设置开关：过程组显示 / 现在的平铺显示（T4 负责）

新增一个 boolean 设置，**默认 `false`**（= 保持现在的平铺显示）。TurnRow 据它二选一渲染：
`true` → `<ProcessFold/>`（过程组）；`false` → **现有的扁平渲染循环原样保留**（一条都不能删）。

遵循项目既有的 boolean 设置通路（**不新增 IPC**），需同步改这 7 处（**按符号定位，不要按行号**）：

| 文件 | 要改什么 |
|---|---|
| `src/shared/types/settings.ts` | 在 `Settings` 里加 `processGroupDisplay: boolean;`（紧邻 `expandInterimDuringStream`） |
| `src/main/settings/SettingsStore.ts` | 默认值加 `processGroupDisplay: false`（与 `expandInterimDuringStream: true` 同一处对象） |
| `src/renderer/src/atoms/app-ui-atoms.ts` | ① `TurnFlowSettings` 类型加 `processGroupDisplay: boolean`；② `turnFlowSettingsAtom` 初值加 `processGroupDisplay: false` |
| `src/renderer/src/previewApi.ts` | 默认设置里加 `processGroupDisplay: false`（与另两处默认值同源） |
| `src/renderer/src/App.tsx` | ① 草稿默认值加 `processGroupDisplay: false`；② 把 `settings.processGroupDisplay` 同步进 `turnFlowSettingsAtom`（与 `expandInterimDuringStream` 同一个 `useEffect`，并把新字段加进依赖数组） |
| `src/renderer/src/components/app/settings/CommonTab.tsx` | 紧挨 `common-expand-interim-during-stream` 加一行 `SettingSwitchRow`，`anchor="common-process-group-display"` |
| `src/renderer/src/utils/settingsFieldAnchors.ts` | 加锚点 `common-process-group-display`（与另两个时间线设置同组） |

i18n 键见 §2b（由 T1 负责加，T4 只管引用，**不要自己动 locale 文件**）。

**验收**：
- 默认（未改设置）行为与改动前**完全一致**：设置页看不到差别、时间线仍是平铺。
- 打开开关后走过程组渲染；关掉再切回平铺，不需要重启、不需要刷新会话。
- 设置项在刷新后保持（走既有持久化通路）。

---

## 6. 验收与合并门禁（Lead 最终执行）

1. `npm run typecheck` 全绿。
2. 针对性测试：`tests/groupTurnProcess.test.mjs`、`tests/toolCategory.test.mjs`、`tests/processGroupState.test.mjs`、`tests/processGroupCopy.test.mjs`、`tests/turnDisplayStructure.test.mjs`、`tests/turnRowExecutionProcess.test.mjs`、`tests/timelineContentVisibility.test.mjs`、`tests/turnCollapsePolicy.test.mjs`、`tests/turnMountBudget.test.mjs`、`tests/selectionToolbarPolicy.test.mjs`、`tests/appSettingsDefaults.test.mjs`（若不存在则新建，断言 3 处默认值同源）全绿。
3. **开关两条路径都要能跑**：默认关闭 = 与改动前逐像素同款；打开 = 过程组渲染。
4. 视觉零回归：思考行 / 工具行 / 中间回复 / 最终回复 / 重试错误行**与改动前同款**（只有外层多了缩进与竖线）。
5. `TurnRow.tsx` 体量不得因本次改动继续膨胀（目标 ≤ 600 行；折叠区内容已抽到 `ProcessFold.tsx`）。
6. **已知限制（v1 接受，需在文档中记录）**：组体内部滚动不会产生「用户意图」，因此不会自动解锁外层贴底跟随。若要修，需要把 controller 的「退出跟随」入口经 `SessionMessageTimeline → TurnRow → ProcessFold → ProcessGroupStep` 透传，属于 Lead 集成阶段的可选项。

---

## 7. 实现结果与已知限制

### 落地清单

| 件 | 文件 |
|---|---|
| 工具活动归类（13 类） | `timeline/toolCategory.ts`（含 `ActivityCategoryLabelKey` 模板字面量联合，调用方零 `as`） |
| 分组纯函数 | `timeline/groupTurnProcess.ts`（含 `TurnStandaloneEntry`：把「一级行只有重试/错误」这条不变量写进类型） |
| 两级挂载预算 | `timeline/turnMountBudget.ts` 新增 `PROCESS_GROUP_MEMBER_LIMIT` / `PROCESS_FOLD_NODE_LIMIT` |
| 手风琴状态机 | `turn/useProcessGroupState.ts`（纯函数 + `useProcessGroupOpenState` 窄 hook） |
| 状态归属 | `atoms/session-atoms.ts`（`ProcessGroupOpenState` 定义在此 + family + 删会话清理） |
| 组组件 | `turn/ProcessGroupStep.tsx`（组头 `flex w-full`、组体限高滚轮、组内预算） |
| 大折叠栏内容 | `turn/ProcessFold.tsx` |
| 二选一分支 | `turn/TurnRow.tsx`（`flowSettings.processGroupDisplay ? <ProcessFold/> : 原扁平渲染`） |
| 设置开关 | `processGroupDisplay`，默认 `false`，7 处默认值/同步 + 设置页开关行 + 未保存变更目录 |
| i18n | 35 键 × 2 locale |
| 测试 | `groupTurnProcess` / `toolCategory` / `processGroupState` / `processGroupCopy` / `appSettingsDefaults` / **`processGroupRendering`（结构契约）** |

### 设计上刻意做的三件事

1. **依赖方向**：`ProcessGroupOpenState` 定义在 `atoms`（atom 拥有该值），hook 从 atoms 取类型并 re-export —— 不是 atoms 反向 import components（那会层级倒置）。与 `RunStepsVisibleMemoryEntry` 的既有归属一致。
2. **不变量写进类型**：一级行只可能是重试/错误，用 `TurnStandaloneEntry` 表达，下游因此不需要「不可能分支」的兜底。
3. **不用 `as` 绕类型**：类别文案 key 返回模板字面量联合（26 个真实键），本身就是 `TranslationKey` 子集。

### 已知限制（v1）

1. **组内滚动不解锁外层跟随**：组体内部滚动不产生「用户意图」，时间线仍保持贴底跟随。修法见 §6 第 6 条。
2. **组体限高用 `vh`**：`min(320px, 30vh)` 量的是窗口高度，不是阅读区高度（阅读区约为窗口的 60~70%，即实际约占 45%）。更准需给滚动容器加 `container-type: size` 用 `cqh`，但要回归一次滚动/跟随。
3. **`TurnRow.tsx` 变长**：两条渲染路径并存，文件已接近 AGENTS.md 的体量评估阈值。若后续要加第三种模式，应先把扁平路径也抽成独立组件。
4. **`hidden={!stepsVisible}` 分支是历史遗留**：Radix 折叠时子树整体卸载，该分支在当前结构下不可达（审计已确认），保留是为了不改变既有契约测试的语义。
