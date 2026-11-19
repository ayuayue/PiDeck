# e2e 已知失败清单

**用途**：进不了 CI、又暂时不修的 e2e 失败集中记在这里，避免每次重新调查。
**纪律**：新增条目必须写「现象 / 证据 / 根因判定到哪一层 / 下一步」；修好后连同条目一起删。
**判定口径**：先在**重构前的基线 commit**上复跑，确认不是近期改动引入的，再登记。

复跑单条：`npx playwright test "e2e/<file>.spec.ts:<line>" --retries=0 --workers=1 --reporter=line`
需要看主进程日志：加 `PIDECK_E2E_KEEP=1`，产物目录会打印在日志里（`profile/logs/app-*.log`）。

## 2026-11-14 历史全量体检快照

以下数字是当日旧分支状态的历史快照，**不是当前 HEAD 的结果**；2026-11-17 起的修复与定向复跑见各条结案记录和 0.13 发布候选记录。

88 个使用 mock-pi fixture 的 spec（排除需真实 DSH/SSH 的 `dsh-restart`、`remote*Acceptance`）：

| 项 | 数字 |
|---|---|
| 用例总数 | 215 |
| passed | 173 |
| failed | 40 |
| skipped | 2 |
| 耗时 | 14.9 分钟（`--workers=3`） |

失败分布（28 个 spec）：`session-history-agent-states` 4 / `terminal-first-open` 3（**已修**，见下）/ `favorites-bulk`、`file-link-repro`、`layout-terminal`、`provider-model-setup`、`retry-status-card`、`settle-reposition`、`visual-tune-surfaces` 各 2 / 其余 18 个各 1。

两类签名占绝大多数，**与 pi/fork 无关**：

1. `.conversation` 种子行找不到（`file-link-repro`、`imagegen-composer-layout`、`branch-tree-panel`、`agent-market-bulk`）——预置会话行没渲染，属种子数据/侧栏结构变化。
2. 布局与视觉度量（`content-width`、`settle-reposition`、`tab-font-size`、`process-group-display`、`typewriter`、`visual-*`、`tmp-table-menu`）——像素/字号/间距断言，随样式迭代腐烂最快。

**mock 改动的回归对照**（2026-11-14 为 mock 补 fork 仿真时做的）：把 `e2e/mock-pi.cjs` 换回改动前版本，重跑 8 个代表 spec 的 17 个用例，结果逐条一致（14 failed / 3 passed）→ mock 改动无回归。

---

## 已修复（留档，便于同类问题快速定位）

| 日期 | 用例 | 原因 | 修法 |
|---|---|---|---|
| 2026-11-14 | `session-history-mutation`（3 条） | 删除确认文案按 running/idle 分变体、编辑/重发已改 fork 语义 | 对齐断言；mock 补真 fork |
| 2026-11-14 | `tab-context-menu:16` | `getByText("复制会话")` 子串同时命中「复制会话文件路径」 | 加 `exact: true` |
| 2026-11-14 | `visual-session` / `tab-font-size` / `provider-model-setup:63` | 合成器的发送/停止是同一颗主钮 `.composer-send-primary`（旧 `.composer-bar-btn.stop/send` 都已删）；模型与思考档位并进 `.model-thinking` 芯片（旧的 `.composer-bar-btn.model/thinking` 与 `.thinking-picker` 不存在）；打开「设置」会在 Tab 栏多一个「设置」tab 并抢走选中态；模型芯片可能直接开选择器，不再夹一层「选择模型」popover | 改定位器；tab 计数统一排除「设置」tab，删掉设置打开后不再成立的选中态断言（会话 tab 的选中契约在打开设置前已断言）；主题改为直切 `dataset.theme` |
| 2026-11-14 | `session-history-agent-states`（种子行 + 遮罩 2 条） | 预置项目行按**项目名**匹配（不是临时目录名 `pideck-seed-*`）、侧栏默认在「聊天」分段要先切「项目」；「重启」入口从 Tab 栏右键菜单改为会话头部运行控制钮（从未启动的会话是「启动 Agent」） | 改定位器与前置步骤 |
| 2026-11-14 | `layout-terminal`（2 条）/ `content-width` / `math-delimiters` / `visual-tune-surfaces`（2 条）/ `typewriter`（1 条，burst） | 终端入口从 outline 悬浮条并入「更多运行操作」菜单；solo 会话栏类名换成 `.session-v-timeline` 且空会话不渲染时间线；状态词「空闲」移进状态点、不再进会话行按钮的可访问名；抽屉打开时 Tab 栏的 drawer 开关会隐藏（并入活动栏左端）；BURST 合并帧上限过紧 | 前四条改定位器/时机；`typewriter` 把「合并帧 ≤3 帧」放宽到 ≤6 帧（实测该模式单帧落 4–5 字符，守卫目标是 10+ 的整段蹦出） |
| 2026-11-14 | `file-link-repro`/`imagegen-composer-layout`/`branch-tree-panel`/`agent-market-bulk`（5 条，同一批） | 侧栏行显示**项目名**（seed 里是 `link-repro` 等），不是临时目录名 `pideck-*`；抽屉「添加常驻面板」只把面板加进常驻栏、不自动选中；分支树压缩点行改为显示摘要正文；低频入口（智能体/收藏）收进「更多」折叠组 | hasText 改 seed 项目名、先展开「更多」、勾选后补点 rail 按钮、断言改为摘要 |
| 2026-11-14 | `favorites-bulk`（2 条） | 收藏入口收进侧栏「更多」折叠组（定时任务/智能体/收藏），且页面内还有同名「收藏」按钮 | 先展开「更多」，再用 `#sidebar-more-actions` 精确定位入口 |
| 2026-11-14 | `terminal-first-open`（3 条） | 会话操作菜单从 Tab 栏「更多操作」并入会话头部「更多运行操作」（`SessionActionsControl`） | 定位器改到新入口；**功能本身没坏**（#333 仍可用） |

### 已废弃用例（已删除）

| 用例 | 原因 |
|---|---|
| `tmp-table-menu`（整条删除） | 2026-08 的临时验证脚本：只有截图 + `console.log` 几何，唯一断言是「复制菜单项可见」，从未断言过菜单是否压住表格。表格工具栏与 i18n 都变过两轮，维护成本大于价值，直接删文件（它想守的重叠问题需要真实像素断言才有意义，见下方待办） |
| `settle-reposition` 的 2 条（mouse move + typing / holds its landing spot） | settle 后重新定位已被移除；两条断言已删除，保留手动上滚和历史打开行为覆盖 |

---

## 重试与历史状态 E2E（已修复，2026-11-17）

- `retry-status-card.spec.ts` 2/2 通过：成功周期退出时间线，进行中只显示当前周期，最终失败保留原因。
- `session-history-agent-states.spec.ts` 4/4 通过：运行中停止后删除、崩溃/未启动状态的历史编辑删除、发送激活及加载遮罩。
- 运行中历史操作现在明确以被操作的 session runtime 为忙闲来源；正在输出时编辑/删除隐藏，停止后可继续操作。
- assistant 编辑遵循 `context_edit`/catalog 路径，user 编辑和 resend 遵循真实 pi 默认 before-fork 语义。相应用例使用真实投影解析，未把后续编辑错误注入早期 fork。
- `history-restore.spec.ts` 已补 Windows 隔离环境、信任与配置种子、平台 shim；重启恢复验证通过，移除了旧 `fixme`。`process-group-display.spec.ts` 的当前 4 条回归也已通过。

## 非 live 会话编辑：旧行不消失（根因已定位并修掉 mock 侧，2026-11-15）

**结论先行**：先前记录的「会话文件重复追加同 id 条目」是**探针里提交了两次**造成的假象（两次点击各写一轮）。真正的缺陷在 **e2e mock 的 fork 语义与真实 pi 不一致**。

**真实 pi 语义**（`pi-coding-agent/dist/core/agent-session-runtime.js` 的 `fork()`）：

```js
const position = options?.position ?? "before";
if (position === "at") targetLeafId = selectedEntry.id;
else { …; targetLeafId = selectedEntry.parentId; selectedText = extractUserMessageText(…) }
```

fork 默认 **before**：新会话的 leaf 是锚点的**父节点**，锚点这条 user 消息**不进新分支**，它的文本由 RPC 回给客户端去重发。

**mock 原来的两处不一致**（都已修在 `e2e/mock-pi.cjs`）：

1. `slice(0, cut + 1)` —— 把锚点也留在分叉里（等于 position `at`）→ 重发/编辑后新分支里「旧消息 + 新消息」并存，时间线出现两份。
2. `get_fork_messages` 只报**本进程收到过**的 prompt；历史会话里落盘的 user 条目没有锚点 → fork 拿不到 entryId，编辑退化成「同文件追加」，连 fork 都没发生（种子文件因此被写脏）。

**修完实测**：种子文件不再被追加（保持 e1–e3），fork 出的新文件里已排除锚点；`session-history-agent-states` + `session-history-mutation` 共 7 passed。

## 配置管理「保存点了没反应」—— 实际是必填项缺失被校验拦下（已结案）

**结论**（先纠正前两轮的判断）：保存链路本身没坏，是**供应商缺 API 类型**导致主进程校验整条拒绝。

探针实测（临时日志已回退）：

```text
[probe] handleSaveCurrent {saving:false,target:"local",backendPane:"pi",section:"config",tab:"models",addingProvider:false,editingProvider:null}
[probe] saveByKey models {addingProvider:false,editingProvider:null}
[probe] handleSaveModels entry {providers:["中文供应商"]}
[probe] handleSaveModels afterSpec {filledCount:1}
[probe] handleSaveModels result {valid:false,error:"provider"中文供应商"的模型"gpt-4o"缺少 API 类型（api）：请在供应商或该模型上填写，否则 pi 会跳过整个供应商…"}
```

即：点击 → `saveCurrent` → `saveByKey("config:models")` → `saveModels` IPC 全部正常，只是返回 `valid:false`。

**为什么一开始会误判成「点了没反应」**：错误走的是内容区的 `setError`（不是 toast / alertdialog），而 dirty 不会因为一次失败清除，按钮 title 一直停在「有未保存的修改」。探针只搜了 toast 与 alertdialog，于是看起来像「什么都没发生」。

**修法**：spec 在「+ 添加供应商」里补选 API 类型（`openai-completions`）后再添加，两条用例转绿。

**UX 改进（已做）**：保存被校验拒绝时除了内容区错误条，再弹一条 error toast（`showNotice(message, 6000, "error")`），避免用户以为「保存按钮失灵」。回归用例：`provider-model-setup.spec.ts` 的「保存被校验拒绝时给 toast 提示（供应商缺 API 类型）」。

## 下一批待办

| 用例 | 现象 | 已经查到哪一步 / 下一步 |
|---|---|---|
| `tab-font-size:33` | `.session-tab[role=tab]` 期望 2 实际 3 | 多出来的一般是空草稿 tab；先确认这第三个 tab 的 `aria-selected`/标题，再决定计数改成「已选中的 2 个」还是等草稿回收 |
| `visual-session:22` | `.composer-bar-btn.stop` 不存在 | 合成器的发送/停止控件换过类名；下一步按 aria-label「停止」定位 |
| `web-service:62` | **已登记 `test.fixme`**：Web 前端换成了新的单页（`.app` / `textarea#prompt` / `.chat-list-pane` / `.assistant-text` 这些锚点都能对上），思考卡片不再以原始文本节点呈现，旧的 `text=推理：先分析文件结构...` 必然找不到 | 这份 Web 前端源码不在仓库里（`src/main/web/webPageTemplate.ts` 是旧的内联页，没有这些类名），下一步先定位构建产物来源，再按新 DOM 改断言 |
| 表格工具栏菜单与表格重叠 | 之前的 `tmp-table-menu` 只截图不断言 | 需要一条真实几何断言：菜单 `boundingBox` 底边 ≤ 表格顶边，或菜单不覆盖任意 `td` 文本；菜单是 portal 渲染，定位要从页面级取而不是 `.message-timeline` 内 |
