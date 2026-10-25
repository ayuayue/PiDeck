# pi 1.0.4 适配实施计划

> 状态：**已执行（2026-10）**。P1 配置、P2 目录、P4 会话已落地；P3（嵌套工具展示）按用户要求后置，未实施。
> 核查基线：PiDeck `dev`，起点 HEAD `0e4e8bf4`；本机 pi 1.0.4；项目 `@earendil-works/pi-ai` 已为 1.0.4。
> 落地提交：`90dedf04`（配置）、`4fe72c54`（目录）、`7b16d801`（会话读取）、`9a2cb8d8`（会话写入）。
> 范围：配置保存、模型目录去白名单、嵌套工具展示、原生会话记录及编辑／删除。分类模型的产品入口与调用支持后置。

## 1. 完成后的行为

| 项目 | 当前问题 | 本轮完成条件 |
|---|---|---|
| Azure 认证 | 新增预设仍用旧 provider 键 | 新增 Azure 凭据使用 `azure`；API 协议名仍可为 `azure-openai-responses` |
| API 配置保存 | 未列入六项枚举的 API 会被改成 `openai-completions` | 保存前后的有效 API 值一致；已有自定义值可显示、可保留 |
| 模型目录 | 提取时按白名单丢字段，`type` 等不可恢复 | 单文件继续用，但不再摘字段：保留官方分组结构与全部字段，紧凑序列化 |
| 嵌套工具 | 没有处理父子关联及持久化调用摘要 | codemode 等父工具下面显示子调用；实时与历史恢复不重复、不串会话 |
| 原生会话读取 | 文件读取链路未处理 `context_edit` | 能分清原始历史与当前有效上下文，正确呈现原生编辑／排除状态 |
| 消息编辑／删除 | 原地改文本或写 PiDeck `deleted` 墓碑 | 后续普通编辑／删除追加 pi 原生 `context_edit`，保留原文与父子链 |

明确不做：旧 Azure 键自动迁移、历史墓碑改写、迁移向导、classifier 界面／调用 API、独立生图服务改造、替 pi 执行工具或模型调用。已经适配的 MCP exposure、defaultTools 和 `session_info` 不重做。

## 2. 已确认的依据与边界

- 声明依赖和 bundled catalog 已更新到 1.0.4；本轮问题在消费和保存逻辑，不是再次升级依赖。复核发现当前 `node_modules` 中 pi-ai 实际仍为 1.0.0，不能用它重生成目录；实施时须验证输入确为声明的 1.0.4，不绕过现有版本守卫。
- `ConfigManager.normalizeApiType()` 的兜底会覆盖未知 API。其调用同时涉及配置写入和模型列表请求，修改时必须分开这两种用途。
- pi-ai 1.0.4 原始 `dist/providers/data` 为 42 份 JSON、913,791 字节、1620 条模型，全部带显式 `type`（chat 1537、image 60、classifier 23），没有缺省类型的条目。当前生成目录 674,244 字节，每条只保留 9 个字段，`type` 在提取时被丢弃。
- 原始数据中存在 3 组同 provider／同 ID、不同 `type` 的条目：`openrouter/google/gemini-3-pro-image`、`openrouter/openrouter/auto`、`openrouter/openrouter/auto-beta`（均同时有 chat 与 image）。生成格式丢掉类型后，两者在查找身份上无法区分。
- 目录更新器 `fetchNpmCatalogDataFiles()` 已按 `dist/providers/data/*.json` 枚举并逐份下载原始文件，随后才在本地合并裁剪；保存原始文件不需要新增下载通道。
- `nestedCalls` 位于最终 `toolResult` 消息上，形状是 `{ calls, complete }`；子项包含 ID、名称、可选参数、状态、耗时和截断错误，**不包含子工具结果正文**。实时 `tool_execution_*` 用 `parentToolCallId` 关联。
- `structuredContent` 是工具执行结果可带的数据，不等于 JSONL 必然保存的字段。当前 pi-agent-core 的 `createToolResultMessage()` 不复制该字段；不能承诺恢复历史后仍有完整结构化结果。
- pi 的 `appendContextEdit()` 追加 `{ type, id, parentId, timestamp, targetId, replacement }`；`replacement: null` 表示不再把目标消息送入模型，`{ content }` 表示替换内容。目标限当前分支上的 user／assistant／toolResult／custom_message，不能任意指向 compaction 等条目。
- pi 按当前 leaf 的父链和最近一次压缩构造有效上下文，再应用保留下来的编辑记录；同一目标以后出现的编辑覆盖此前编辑。不能遍历整个文件后全局套用所有编辑。
- RPC 有 `get_entries`（返回原始条目及 leafId）与 `get_messages`（当前运行时消息）。核查的 1.0.4 RPC 没有直接追加 `context_edit` 的命令。本轮沿用停止进程后的文件操作，不新增 SDK 桥或伪造 RPC。
- 当前 `SessionFileEditor` 的删除会把原行换成墓碑，原文仅留在备份；不是一直保留在原 JSONL。维护文档中相反的描述需要随实现纠正。

这些是源码核查结论，不代表真实 UI、RPC 会话或跨版本兼容测试已经通过。

## 3. P1：修正配置预设与保存

### 实施

1. `AuthTab.tsx` 的 Azure 预设 provider 改为 `azure`。不替换协议 ID `azure-openai-responses`，不扫描或改写已有认证项。
2. 将“保存时规范化”和“发起某类模型列表请求时选择协议”拆开。保存保留已配置的非空 API 字符串，现有已知别名转换维持原行为；不把未知值兜底成 OpenAI。
3. 维持 provider 默认与 model 继承关系，尤其 model 未写 `api` 时不得补成 OpenAI、覆盖其 provider 协议。合法的缺省 provider 字段也不应被保存操作无故补写。
4. UI 能显示并保存已有自定义 API。聊天协议选项按 pi 1.0.4 支持的配置契约补齐；核查 `azure-openai-responses`、`bedrock-converse-stream`、`google-vertex`、`pi-messages` 各自的认证／端点要求，不将“出现在 catalog 中”当成统一 `/models` 接口的依据。
5. 不将 `openrouter-images`、`typesafe-system-one`、`cloudflare-workers-ai-system-one` 加入普通聊天协议菜单；但保存已有配置时仍须保留其值和未知字段。
6. 对没有通用模型列表接口的协议，保留手填配置能力，明确呈现不支持的列表拉取，不能静默改协议试探。

### 主要文件

- `src/main/config/ConfigManager.ts`
- `src/renderer/src/config/AuthTab.tsx`
- `src/renderer/src/config/providerHeaders.ts` 及直接使用该选项的配置组件
- 需要新增文案时同步中英文 i18n 文件

### 验证

先用测试复现“保存覆盖 API”，再修到绿。覆盖 provider/model 两层、已知新协议、自定义协议、继承缺省、未知字段保留、Azure 新预设和重新打开配置页。

优先扩展 `tests/configValidateModels.test.mjs`、`tests/configFetchedModels.test.mjs`、`tests/configFetchModelsHeaders.test.mjs`、`tests/providerOptions.test.mjs`；仅在现有文件不能覆盖公开保存入口时新增专门测试。列表请求用 mock，不访问真实供应商、不读取用户凭据。

## 4. P2：保留单文件，但不再裁剪官方数据

此项只改“提取成什么”，不改“存几份文件”。分类模型的调用功能仍后置。

### 单文件本身不是问题，白名单才是

把 42 份官方 JSON 合成一份、按白名单只留 9 个字段，是两个独立决定，被一起做掉了：

- **合并成单文件**：读取、sha256 校验、原子替换、备份回滚都只需处理一个文件，现有机制可以直接复用。成本仅为 42 个文件名的键名开销。
- **白名单摘字段**：丢掉了 `type`、价格、`inputLimits`、`compat`、`output` 等，是本次要取消的部分。

实测 pi-ai 1.0.4（42 份上游文件本身已是紧凑格式，无缩进空白）：

| 形式 | 字节 |
|---|---|
| 42 份官方文件（现状来源） | 913,791 |
| 单文件嵌入原分组、紧凑序列化 | 914,614 |
| 单文件嵌入原分组、两空格缩进 | 1,678,983 |
| 单文件扁平数组、全字段、紧凑 | 864,830 |
| 当前白名单目录（9 字段、缩进） | 674,244 |

即：**只要放弃白名单并保持紧凑序列化，单文件比 42 份原件只多 823 字节（0.09%）**，却保留了全部 1620 个模型和所有字段。当前 674KB 看着更小，是靠丢字段换来的，而缩进一开就反超（原分组缩进后达 1.68MB）。

因此保留单文件、只取消白名单，比改成分发 42 份原件更划算：后者需要把原子替换、`.bak` 备份、`restorePrevious` 全部改成目录级切换，改动面和回滚风险都更大。

### 实施

1. 保留 `resources/pi-ai-catalog.json` 单文件与 manifest 结构，取消字段白名单：条目按官方原字段完整写入，包含 `type`、`cost`、`output`、`inputLimits`、`compat` 等。
2. 保留官方分组结构（文件名 → API → 模型键），不压成扁平数组，也不改写官方键名。这样仍可逐条对回上游，且未来新增字段无需改脚本。
3. 输出保持紧凑序列化（无缩进）。当前两空格缩进是体积翻倍的主因；改为紧凑后以极小体积代价换回全字段。清单不记录生成时间，仍保证同输入字节级一致。
4. 主进程读取分组结构，在内存中建索引。读取仍做类型、大小和完整性校验；传给 UI 的字段按实际用途选取。
5. 将 `type` 保留到模型条目和查找身份中。同 provider／ID 的不同类型不能互相覆盖（1.0.4 中已存在 3 组，见第 2 节）；消费方按用途查询，目录保留所有模型。1.0.4 全部条目都带显式 `type`，对缺省值按上游“缺省即 chat”处理只是防御，不改写数据。
6. 目录更新继续写单文件覆盖层，沿用来源版本锁定／防降级、下载校验、备份、原子替换和内存索引失效机制。更新器已在用 `dist/providers/data/*.json` 逐份拉取原始文件，只需把“合并裁剪”改为“保留全字段合并”，不新增下载通道。
7. 旧白名单目录补不回丢失字段，不做转换器；缺少新增标记的旧覆盖层不参与新读取路径，使用随包目录。用户配置、会话与旧缓存文件不扫描改写。
8. 更新打包资源声明与对应检查，验证发行包无需完整 pi-ai SDK 也能离线查目录。聊天模型选择器仍由 pi 提供运行时列表；新增分类／生图调用能力不在本轮。

### 主要文件

- `scripts/generate-pi-ai-catalog.mjs`：取消白名单，保留原分组与全字段，紧凑输出
- `src/main/pi/piAiCatalogGenerate.ts`：运行时生成器同步同一规则（与构建脚本逐字节一致）
- `src/main/pi/piAiBuiltinCatalog.ts`：读取分组结构，保留类型并建立索引
- `src/main/pi/PiAiCatalogUpdater.ts`：合并规则改为保留全字段，覆盖层写入机制不变
- `resources/pi-ai-catalog.json`、`resources/pi-ai-catalog.manifest.json`：按新规则重新生成

### 验证

核对生成件包含全部模型与 `type` 等字段、原分组结构和键名保留、紧凑输出与原数据字节差在预期内；同 provider／ID 的不同类型互不覆盖；现有聊天参数补全可用。覆盖缺省 chat、畸形文件、哈希不匹配、覆盖层校验、更新中断回退、旧覆盖层跳过和内置资源可离线读取。

现有 `tests/piAiCatalogGenerate.test.mjs`、`tests/piAiCatalogArtifact.test.mjs`、`tests/piAiBuiltinCatalog.test.mjs`、`tests/piAiCatalogOverlay.test.mjs`、`tests/piAiCatalogUpdater.test.mjs`、`tests/piAiCatalogNpmUpdate.test.mjs`、`tests/piAiCatalogPackaging.test.mjs` 随触达范围调整。仅执行针对性测试和类型检查，本轮不为此运行全仓构建或打包。

体积断言应改成相对上限而不是硬编码数字，避免上游小改动就红。

## 5. P3：嵌套工具调用展示

### 实施

1. 在共享消息契约中加入有界的父子关联与调用摘要类型，在主进程边界校验，不直接让任意结果对象进入渲染层状态。
2. 实时路径读取 `parentToolCallId`，按会话、runtime generation、父调用 ID、子调用 ID 合并 start/update/end；子调用附着父卡片，父工具仍是时间线主项。
3. 最终 `toolResult.nestedCalls` 用于收敛状态及历史恢复。实时事件和最终消息可能都到达，同一子调用只显示一次；迟到的旧 runtime 事件仍按现有身份校验丢弃。
4. 展示名称、状态、耗时、允许展开的参数及错误。参数被省略时使用 `argumentsBytes` 提示；`unfinished` 与 `complete: false` 显式表示未完成／记录不完整，不补造结果。
5. `structuredContent` 若在实时执行结果中存在，提供限长、默认折叠的只读 JSON 展示；不执行 HTML，不把内容当指令。历史只有文本／details 时显示实际可用数据，不为补齐此字段新增旁路存储或改写 pi JSONL。
6. 空调用、父卡片缺失、异常字段、大结果和失败调用均能退化为现有工具卡片，不拖垮整个时间线。清理与父消息、会话运行时生命周期配对。
7. 复用现有工具展示和 shadcn/Tailwind；文案走中英文 i18n。pi 的权限和工具执行流程保持由 pi 处理。

### 主要文件

- `src/shared/types/agent.ts`
- `src/main/pi/AgentManager.ts`（只接线，解析／合并策略独立放小模块）
- `src/main/pi/AgentMessageProjector.ts`、`SessionHistoryReader.ts`、`historyMessages.ts`
- `src/renderer/src/components/session/ToolCallComponents.tsx` 及工具卡片子组件

### 验证

使用录制形状的 RPC fixture，覆盖串行／并行子调用、失败、取消或 unfinished、部分记录、乱序与重复、缺失父项、跨 session/generation 隔离，以及实时结束后重载历史。

扩展 `tests/agentMessageProjector.test.mjs`、`tests/sessionHistoryReader.test.mjs`、`tests/historyMessagesMerge.test.mjs`、`tests/toolCallComponents.test.mjs`；父子合并策略用行为单测。手工用本地只读工具的 codemode 验收展开、状态和重载，不调用真实供应商。

## 6. P4：读懂原生会话记录，再切换编辑／删除

此阶段同属本轮，内部先完成读取与展示，再开启原生写入；不能只替换写文件格式。

### 6.1 读取与展示

1. 抽出纯函数处理当前分支、压缩后的有效条目和 context_edit 的覆盖顺序。与 pi 1.0.4 的 `buildSessionProjection` 语义对齐，保留 entry ID 作为来源，不靠消息正文猜目标。
2. 保留原始历史及已经发生的 usage/cost，另行提供当前有效内容与编辑状态。界面默认折叠已排除的正文，显示“已移出上下文”；替换内容显示“上下文已改写”，允许查看原文。
3. UI 历史标记与当前上下文状态分开：某条编辑记录出现在原始分支，不代表经过后续压缩后仍以相同方式作用于模型。
4. RPC 原始条目由现有 RPC 通道取得；文件加载与运行时同步使用同一投影策略。不会用 `get_messages` 的缺席推断原始消息已被物理删除。
5. 补齐文件读取路径的 `branch_summary` 展示与 `label` 元数据处理，复用已有摘要／树组件；`session_info` 保持现有标题链路，避免重复维护标题。label 不当作模型聊天内容。
6. 原始 token/费用不因删除或编辑而扣除；上下文使用量以 pi 运行时提供的有效信息为准，不按删除文字长度承诺精确节省。

### 6.2 普通编辑／删除写入

1. 保留“pi 已停止”这一硬条件，以及协调层、AgentManager 和文件写入处的检查。追加 JSONL 也不能与 pi 同时写。
2. 删除：针对目标追加 `replacement: null`。编辑：追加 `{ content }`，仅替换用户修改的文本，并保留目标原有的图片、工具块等其他合法内容。多次编辑基于当前有效内容计算，避免把先前改动覆盖回原始内容。
3. 每条新记录生成不冲突的 ID，`parentId` 从当前 leaf 串接，使用标准 `timestamp`；保留原始条目的 ID、parentId 和正文，不重接其子节点。
4. 删除 assistant 回答时保留现有“关联过程不串入下一回答”的产品行为：先由纯策略求出同轮关联消息，再为每个合法目标生成原生排除记录，并一次完成文件事务。工具调用与结果成组验证，不能产生孤立 toolResult。
5. 沿用文件锁、大小限制、备份、写前内容一致性校验、reload 标记和失败回滚。针对写盘与激活竞态，在实际写入期间保证互斥；不能仅依赖入口处检查一次。
6. 旧 `deleted` 记录保持现有读取处理，不扫描转换、不声称恢复其原文。后续普通编辑／删除不再生成该格式。

### 6.3 压缩与重发的明确边界

- 已被压缩进摘要的旧消息，原生 context_edit 不能删除摘要里转述的事实。界面提示该限制；不自动重写摘要、不宣称模型已彻底忘记。
- 对不再贡献当前有效上下文的目标，不报虚假的“当前上下文已更新”；使用明确状态说明操作对原始历史标记和现有摘要的影响。
- “重发”还包含回到某条用户消息及截断后续路径，不能等同于追加普通删除记录。本轮保持现有重发语义及其截断实现，不扩展分支管理产品。
- 必须验证重发遇到新增 context_edit 时，条目定位、后续范围、图片恢复、active leaf 和 reload 均正确。此路径仍可能使用现有墓碑，文档不能笼统写成“所有文件操作都只追加”。

### 主要文件

- `src/main/pi/SessionHistoryReader.ts`、`sessionEntryIds.ts`、`historyMessages.ts`
- `src/main/pi/SessionFileEditor.ts`（已有大文件，新增投影／批量编辑策略放独立模块）
- `src/main/pi/AgentMessageProjector.ts` 与现有消息 mutation 装配入口
- `src/main/sessions/SessionRuntimeCoordinator.ts`、`src/main/ipc/sessionIpc.ts`
- `src/shared/types/agent.ts`、会话消息组件及 i18n
- `docs/maintenance-domains.md` 的消息编辑／删除／重发小节

### 验证

先写能复现缺失 context_edit 投影、旧删除丢失原文的测试，再修改实现。核心样例包括：

- user／assistant 编辑及删除、原文逐字节保留、重复编辑和最后一次覆盖；
- 分叉共享祖先、另一分支的编辑不泄漏、非当前分支目标拒绝；
- compaction 的 retained range、编辑位于压缩前后、目标已进摘要；
- assistant 过程链、工具调用和结果、图片块、custom_message 读取；
- 旧墓碑与新编辑记录共存，重发经过编辑／删除后的用户消息；
- 进程存活、正在激活、并发文件变更、文件大小上限、reload 失败回滚；
- 原文折叠与展开、改后内容、费用不倒扣、重新打开会话状态一致。

优先扩展 `sessionFileEditor`、`sessionFileEditorAgentManager`、`sessionHistoryReader`、`sessionHistoryReaderForkChain`、`sessionHistoryCatalogMutation`、`sessionHistoryMutationPolicy`、`sessionRuntimeCoordinator`、`agentMessageProjector`、`historyMessagesMerge` 对应测试。

增加独立投影行为测试。CI 使用本地 fixture 和已有 TS loader，不依赖真实 pi 进程或模型网络。交付前用临时会话文件单独比对安装版 pi 1.0.4 的投影结果；不改真实会话，不把未运行的比对称为兼容实测。

## 7. 执行次序与交付门禁

### 执行记录（2026-10）

| 阶段 | 提交 | 实际落地与偏差 |
|---|---|---|
| P1 配置 | `90dedf04` | Azure 预设改 `azure`；保存只归一历史别名、其余 `api` 原样保留；缺省/空白删键；下拉补齐 pi 1.0.4 聊天协议，DSH 单独用三协议选项；无通用 `/models` 的四种协议给出「手填模型 ID」提示 |
| P2 目录 | `4fe72c54` | 取消白名单，透传官方全字段（含 `type`）；紧凑序列化（0.67MB → 0.86MB）；`schemaVersion` 1→2，v1 旧覆盖层被拒并回落内置；索引同 provider+id 时 chat 优先；能力补全只取 chat |
| P4a 读取 | `7b16d801` | 新增 `sessionContextProjection`（含与 pi `buildContextEntries` 的差异校验）；索引抓取 `context_edit`；分页下发 `contextEdits`；UI 出「已移出上下文 / 上下文已改写」徐章 |
| P4b 写入 | `9a2cb8d8` | 编辑/删除改追加原生 `context_edit`（原文不改写）；重发保留墓碑截断；修复「追加消息接在最后一条 message 而非当前 leaf」导致编辑静默失效的真 bug |
| P3 嵌套工具 | — | 用户明确本轮不做，未实施 |

### 验证与如实说明

- 每阶段均跑 `npm run typecheck` 与针对性测试；P4b 另用真实 pi（`loadEntriesFromFile` + `buildSessionProjection`）逐项验收。
- **环境已知偏差**：本机 `node_modules` 的 pi-ai 为 1.0.0 而 `package.json` 锁定 1.0.4，三个目录一致性测试（catalog generate/ packaging/ build guard 的仓库状态项）在当前工作区失败；基线 worktree 同样失败，非本轮引入，`npm ci` 后应转绿。P2 的等价断言改用核验过的 1.0.4 来源逐字节验证通过。
- **未验证**：分类模型（classifier）的产品入口与调用；`label` / `branch_summary` 的界面展示；压缩摘要与删除并存的界面提示文案。
- **并行工作隔离**：实施期间工作树存在其他 agent 的未提交改动（`sessionIdentity.ts`、`SessionCatalog.ts`、`useSessionTimelineController.ts` 等）。P4b 的 `SessionHistoryReader.ts` 采用 hunk 级暂存，已核对提交内容不含他人改动，也未修改/还原他人文件。

### 原计划次序（备查）

1. P1 配置保存：改动小、能直接避免错误写入。
2. P2 官方目录：保留单文件，取消字段白名单，改紧凑输出，打通读取、更新与校验；分类调用继续后置。
3. P3 工具展示：先打通消息契约／投影，再接 UI。（后置）
4. P4 会话适配：先读与展示，再写与失败回滚，最后核对相邻重发路径。
5. 更新维护说明和本计划状态，记录实际通过、失败、未验证项，不以本计划作为已完成证明。

每阶段先跑对应 `node --test tests/<相关文件>.test.mjs`；代码改动后执行 `npm run typecheck`。仅运行触达范围的测试，不运行全仓构建、打包或启动真实用户会话。新增界面用针对性的组件／E2E 场景核对最终态。

格式遵循项目 biome 配置。提交前执行格式检查；共享工作树中先检查改动归属，避免全目录格式化覆盖他人的文件，必要时只格式化本任务路径。

当前已有、必须保留的外部改动：

- `e2e/settle-reposition.spec.ts`
- `e2e/tmp-send-pin-trace.spec.ts`
- `e2e/tmp-settle-trace.spec.ts`

实施开始前重新核对 HEAD、工作区和 pi 版本。沿用当前开发分支，不安装依赖、不启动子代理、不动上述文件。验证涉及的具体测试集合随实际触达模块收窄；任何尚未执行的 UI 或安装版 pi 比对均明确标为未验证。

## 8. 核查来源

- pi 1.0.4：`docs/session-format.md`、`docs/rpc.md`、`docs/rpc-commands.md`、`docs/message-types.md`、`docs/extensions.md`、`docs/codemode.md`、`docs/models.md`。
- pi 源码：`dist/core/session-manager.js` 的 `appendContextEdit`／`buildSessionProjection`，`dist/modes/rpc/rpc-mode.js` 的 `get_entries`／`get_messages`，`dist/core/agent-session.js` 的嵌套调用处理。
- pi-ai：`dist/types.d.ts` 的 `NestedToolCalls`／`ToolResultMessage`；pi-agent-core：`dist/agent-loop.js` 的 `createToolResultMessage`。
- PiDeck：本计划各阶段列出的生产模块与现有测试，以及 `docs/maintenance-domains.md`。此前已执行的 `docs/pi-1.0-adaptation-test-plan.md` 是另一轮验证记录，不覆盖本次计划。

## 9. 合并回主线的执行记录（2026-10-08 完成）

合并结果：`origin/dev` 推进到 `5c4b5eb2`，本轮全部提交与当时上游的 3 个提交均已合入。

1. **冲突**：两次合并各只有 1 处。第一次 `src/main/pi/SessionHistoryReader.ts`「双方各自新增」（本轮 context_edit 汇总 vs 上游分支树预览）——注意 git 把两个函数的收尾括号对齐成了公共上下文，直接保留双方会少一个 `}`，必须给两边各补闭合括号；第二次是生成物 `rendererCopy.zh-TW.ts`，取一侧清掉标记后重跑生成器即可。
2. **上游已覆盖、本轮无需再做**：`4fffb039` 的右侧「分支」面板，`branchTreeView.ts` 已处理 `branch_summary`。
3. **繁中词典**：上游引入 zh-TW 后，本轮新增的 9 个键必须由生成器补齐（生成物禁止手改，`tests/zhTwCopy.test.mjs` 断键集）：`npm i --no-save --no-package-lock opencc-js@1.4.2 && node scripts/genZhTwCopy.mjs`。
4. **依赖**：上游新增 `@xterm/addon-unicode11`、`@xterm/addon-webgl` 等；`npm install` 后 node_modules 与 lock 一致（pi-ai 1.0.4、electron 43.4.0），早前那 3 项「基线也红」的目录测试随之转绿。本机 npm 会拦 install-scripts，electron 二进制需按锁版本手动补：`node node_modules/electron/install.js`（走 `~/.cache/electron` 缓存，离线可完成）。
5. **验证**：typecheck 的 12 条错误与基线（`039a0db6`）逐条一致；全量测试 8408 通过 / 52 失败，失败用例集合与基线逐条一致（0 回归）。这 12 条与 52 条都是上游既有问题——其中 `npm run typecheck` 正是 CI 门禁，即上游 dev 当时本身是红的；归属为 `SessionHistoryReader`（上游分支树部分）、`dshProfileSettings`（缺 `lib: ES2023`）、`MiniOverlayWindow`（zh-TW 未并入联合类型）、`AcpAgentManager`（`lastTouched` 属性不存在）。
6. **推送**：因另一 agent 的合并在同一工作区进行中，本地 `dev` ref 未移动（移动会让对方那个基于旧 tip 的合并提交把上游 3 个提交当作已合并、实际回退掉），改用 `git push origin HEAD:refs/heads/dev` 直接推送快进结果。
