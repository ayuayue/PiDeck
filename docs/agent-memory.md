# 智能体记忆（agent-memory）

一句话：PiDeck 给**所有后端**（pi / DSH / ACP）提供同一份长期记忆——Markdown 是唯一真值，SQLite 只是索引，经由一个本地 stdio MCP 服务器以工具形式暴露。

对齐的参考实现是 `pi-hermes-memory`（pi 扩展），复刻它的取舍见文末「与 hermes 的差异」。本文件是这一领域的唯一设计入口；宿主通道边界另见 `docs/host-boundaries.md` 例外八。

**状态**：M2 已完成（服务器 + 采集 + pi/ACP 挂载 + 设置页状态/导出/导入/清空索引）。DSH 侧为设计待办，见 §5。

## 1. 为什么是「独立 stdio MCP 服务器」

| 方案 | 三后端覆盖 | 结论 |
|---|---|---|
| 宿主内建领域模块 | pi 只能靠系统提示注入；ACP 需要 PiDeck 转发 ACP 会话 | 排除 |
| pi 扩展（像 hermes 那样） | 只覆盖 pi，另外两个后端要各写一遍 | 排除（M1 的教训） |
| **stdio MCP 服务器** | pi 内置 MCP 支持 `command` 形态；ACP `session/new` 的 `mcpServers` 也只有 stdio 形态 | **采用** |

同一份代码、同一份数据、三端零重复实现；不需要监听端口、不需要令牌、不需要新增 IPC。脚本在 `resources/agent-memory/`，随包进 `extraResources`；宿主编排在 `src/main/agentMemory/`（注意与内存剖析的 `src/main/memory/` 不是同一领域）。

进程由宿主用 `ELECTRON_RUN_AS_NODE=1 <electron> server.mjs` 拉起，因此跑在 Node 24 上，`node:sqlite`（含 FTS5）可用。

## 2. 存储模型

```
<userData>/memory/
├── MEMORY.md              # 全局事实（预算 8000 字符 / 120 条）
├── USER.md                # 用户画像（4000 / 60）
├── STANDING.md            # 常驻指令（4000 / 40，暂无写入工具）
├── failures.md            # 教训，条目带 [category] 前缀（8000 / 120）
├── projects/<projectKey>/MEMORY.md + failures.md
├── devices/<deviceKey>/MEMORY.md   # 设备专属事实（盘符、本机路径），不导出
├── device.json            # 本机档案 {id, name}，首次使用时生成后固定
├── tombstones.json        # 删除记录，让「删掉的记忆」不会因导入旧包复活
└── memory.db              # SQLite 镜像 + 会话索引（可随时删，自愈重建）
```

- **条目格式**：条目之间用 `\n§\n` 分隔，纯文本，用户用任意编辑器都能改。解析宽容空行/CRLF。
- **projectKey**：由会话 `cwd` 派生（`C--Users-me-proj` 形态），跨后端共享——同一个项目在 pi 和 ACP 里看到的是同一份项目记忆。
- **Markdown 是真值**：SQLite 只是可重建的镜像。任何写入先落 Markdown，再对账索引；索引坏了不影响读写与检索（退化为子串匹配）。
- **预算**：超预算从**最老的**条目开始丢（文件按追加顺序排列）。单条上限 2000 字符。
- **去重**：折叠空白后比对，同一句话重复写不会产生第二条。
- **原子写**：同目录临时文件 + rename，不产生半截文件。

## 3. 工具面（7 个）

| 工具 | 用途 | 关键约束 |
|---|---|---|
| `memory_add` | 写一条事实 | `target` ∈ memory/user/project/failure/device；project 必须有 projectId；device 只落本机 |
| `memory_replace` | 改一条（事实变了用它，别加第二条） | 定位必须唯一，歧义报 `entry-ambiguous` |
| `memory_remove` | 删一条 | 同上 |
| `memory_search` | 全文检索（全局+项目+教训） | target 过滤在 FTS 与 LIKE 两条通道都生效 |
| `memory_get` | 按 target 列举（旧→新） | 分页 |
| `session_search` | 跨后端检索历史会话 | 采集源为空时报 `session-sources-empty` |
| `memory_status` | 预算用量（含设备作用域）+ 索引规模 | 用于诊断「记忆到底有没有在工作」 |

业务错误走 MCP `isError: true` + `{ok:false,error:{code,detail}}`，模型能据此自我纠正；协议错误才走 JSON-RPC error。单条请求失败不会杀掉服务器（客户端会判定服务器已死）。

**消息 id 只在会话内唯一**：PiDeck 的 fork 会话是父会话的字节前缀副本，两边共享同一批 pi entry id。`messages` 表因此用 `rowid` 主键 + `(session_id, msg_id)` 唯一索引——用全局主键会让 fork 插入撞键、整份事务回滚（首次实测 676 会话里失败 199 个）。

## 4. 三端挂载

**总开关 `settings.agentMemoryEnabled`，默认 `false`**（设置 → 通用 → 智能体记忆）。关闭时不注册、不写用户 `mcp.json`、不给 ACP 会话挂工具，与引入前完全一致；开启后启动即幂等注册，设置里改了立刻同步（`syncAgentMemoryRegistration`：开→注册、关→只删自己那一项）。关掉开关不删记忆文件。

| 后端 | 机制 | 状态 |
|---|---|---|
| pi | 写 `~/.pi/agent/mcp.json` 的 `pideck-agent-memory` 条目（`planPiMcpRegistration` 只增改自己那一项，`mcpServers` 形状不对就跳过而不是抢修覆盖；脚本不存在时不写悬空条目） | ✅ 已验证落盘 |
| ACP | `AcpHandshakeDeps.mcpServers(cwd)` → `session/new` 与 `session/load` 的 `mcpServers`；`AcpMcpServer = {name,command,args[],env[]}`（ACP 的 `McpServerStdio.env` 是 `{name,value}` **数组**，不是对象，四个字段全 required）；开关关闭时给空数组（该字段必填） | ✅ 真实 CLI 实测（CodeBuddy 2.179.2） |
| DSH | 见 §5：工具面未接，**会话采集已接**（`backend:"dsh"`，zstd 帧 + 事件投影同一套口径） | ✅ 采集已验证 |

环境变量（`AGENT_MEMORY_ENV` + 实际值）是服务器唯一的配置入口：

- `PIDECK_AGENT_MEMORY_DIR`：记忆根（缺省时服务器**拒绝启动**——默认值会写到某个进程的 cwd 里，那是更坏的失败模式）
- `PIDECK_AGENT_MEMORY_PROJECT_CWD`：会话 cwd，用于推导项目键
- `PIDECK_AGENT_MEMORY_SOURCES`：会话采集源 JSON `[{backend:"pi"|"acp"|"dsh",dir,project?}]`，服务器自己不猜路径

## 4.5 导出 / 导入：多设备共用

导出的是一个 **JSON 包**（不是数据库文件）：真值本来就是可手改的 Markdown，导出条目即可，索引到哪台机器都按文件重建。包是普通 JSON，可以看、可以进 git、可以自己删条目再导入。

```
{ format: "pideck-agent-memory", version: 1, exportedAt, device: { id, name }, entries[], tombstones[] }
```

**条目身份是内容算出来的**：`exportEntryId = 目标|作用域|作用域键|归一化内容`（折叠空白 + 转小写）。导出弹窗的勾选、导入的去重都靠它，所以 Markdown 里不存 id，手改也不会打破身份。

**搬运前先看一眼清单**（导出与导入都是两步：先预览，再确认）：

- **导出**：弹窗列出可导出条目（全局 / 各项目），默认全选，可以取消；只把勾中的条目写进包。设备作用域的条目不在列表里——它们描述这台机器的路径，换台机器就是错的。
- **导入**：先读包并**只读预览**（`previewBundle`，不落盘），每条标成 `new` / `duplicate` / `conflict` / `tombstoned` / `invalid`（后两类带 `reason`: `device-scope` / `unsafe-content` / `tombstone`），冲突项并排给出本地那一版原文。用户勾选要并入的条目，再选冲突处理与墓碑同步。

**合并语义**：

- **并集**：本地独有与包内独有的都留下；`duplicate`（内容完全相同）直接跳过。
- **冲突按「首行」判定**：同 target + 同作用域 + 首行相同、正文不同 = 同一条记忆的两个版本 → `conflict`。整句首行相同几乎不可能是巧合，这比引入条目 id 更符合「一句话事实」的形态。
- **冲突策略二选一**：`append`（默认，两版都留，下次由人或 Agent 手动合并）/ `overwrite`（包里的替换本地那条，`replaced` 计数）。
- **删除靠墓碑传播**：`memory_remove` 会记一条墓碑（内容键 + 作用域）。导入时包内墓碑优先（包里有删除又有新增时，删除优先）——A 机删掉的内容，B 机导入后跟着删，且以后导旧包也不会复活。墓碑上限 500 条，只服务「不该复活」，不是审计日志。这步可以在导入弹窗里关掉（只做新增/替换）。
- **设备专属记忆永不出设备**：`devices/<key>/` 下的条目不进包；包里带设备条目的也一律拒收（别的机器的盘符在本机是错的）。
- **导入内容同样不可信**：不可见字符/注入句式/疑似密钥、未知 target、超 2000 字符、空条目 → 计入 `rejected`，不中断整次导入。整包格式或版本不对则直接报错，不做半截导入。
- **幂等**：同一个包按同样的勾选导两次，第二次 `added: 0`。

### 4.5.1 设置页：「记忆」tab

独立的设置 tab（`AgentMemoryTab.tsx`，侧栏「基础」簇，terminal 之后），不再挤在「常用设置」里。分三块，正好对应三个问题：

1. **开关**：启用 / 自动学习（主开关关着时学习项置灰）。
2. **常驻指令**（`AgentMemoryStandingEditor.tsx`）：STANDING.md 的唯一写入口——它不是 Agent 工具的 target，语义是「用户显式同意、每条会话都注入」，模型改不了这里。保存立即生效（不等设置保存），超预算（4000 字）禁用保存。
3. **用量与索引**：状态行（各文件体积/条目数/索引规模/本机名字）+ 导出 / 导入 / 重命名设备 / 清空索引。自动学习开着时多一行「上次学习」（学过的会话数与最近时间，来自 learn-state.json 的水位）。清空索引只删 SQLite 里的行，记忆文件不动，下一次检索自动重建。
4. **记忆条目**（`AgentMemoryEntryList.tsx`）：按「作用域 → 文件」逐条列出，可展开看全文、可按内容/项目名过滤、可删单条（删后可**撤销**：写回内容并回收墓碑）。分组头显示作用域（全局 / 项目名 / 本机设备）、条目数、字数与预算，答的是「为什么这条 DSH 会话看不到」——它可能落在项目或设备作用域里，只参与检索不参与每轮注入。

**能删不能改**：改写一条记忆的语义（去重键、预算裁剪、墓碑）都在工具层，设置页再放一个编辑器等于把那套规则抄第二遍；想改内容就让 Agent `memory_replace`，想改措辞就删掉再说一遍。删除与列表共用同一套内容规范化（`normalizeKey`），所以列表给的 `key` 一定能删掉它自己那一行——这条由 `tests/agentMemoryEntryList.test.mjs` 守着。全局/项目作用域的删除会写墓碑（旧导出包不会复活它），设备作用域不写（那类条目本来就不参与导出导入）。

IPC：`agentMemory:status | clear-index | export | preview-bundle | import | list | delete-entry | restore-entry | reveal-root | standing-read | standing-write | rename-device`（`src/main/ipc/agentMemoryIpc.ts`），只接受主框架来源、入参校验、错误以 `{ok:false,code}` 返回而不是抛。导出与导入都由弹窗发起：`export` 收勾选 id 数组，`import` 收 `{filePath, selection, conflictPolicy, applyTombstones}`，`preview-bundle` 只读返回包里每条的状态。

## 4.6 学习循环（宿主侧，默认关）

记忆平时只由模型主动 `memory_add`。开启「自动学习」后，宿主在**回合结算**时尝试一次提炼：

1. `compositeAgentGateway.onAgentSettled` 是三种后端统一的结算信号（同一处也在发「会话完成」通知）。pi 会话也参与，记忆是跨后端同一份数据。
2. 先做一次增量索引（`indexSources`，按文件 size/mtime 跳过未变文件），再从索引取该会话最近 40 条消息——**不为学习新写一套会话读取**：三种后端的原始格式差异已经在索引层消化掉了。
3. 水位判断：`<root>/learn-state.json` 记录每个会话已学到第几轮用户回合，**每新增 12 轮**才调一次模型。水位按整份会话的用户回合数算，不是按那 40 条消息的窗口算（否则窗口一满就再也学不到）。
4. 一次模型调用（独立侧车实例 `createCompletionHelperService("agent-memory")`，与增强/预测/划词各自独立进程，避免把它们打断），模型优先级 = 用户指定的增强模型 > 该会话记录模型，都没有就跳过。
5. 模型输出按 `[`…`]` 截取成 JSON 数组，逐条校验 target/content/category，最多 3 条，其余计入 rejected。
6. 落盘走**工具层同一个 `addMemory`**：扫描（注入/密钥/不可见字符）、去重、预算裁剪一处生效，学习绕不过闸门。`target=project` 但没有项目上下文时退化成全局经验，不当失败丢弃。
7. 只有真的调用过模型才推水位：模型失败/超时/被取消保持原水位，下次满足阈值再试。

设计取舍：
- **默认关闭**并且是独立一格外关：开启会产生模型调用费用，用户必须显式同意；主开关关闭时学习开关在设置页置灰。
- **不静默扩面**：单次最多 3 条、单会话每 12 轮一次，`runLearnerPass` 全局单飞（同时只跑一趟）。
- **失败只进日志**：学习是可选增益，异常绝不影响会话（`catch` 只写 `agent-memory` 日志）。

守卫测试（`tests/agentMemoryLearn.test.mjs`，9 条）：不足阈值一次都不调模型、达到阈值落盘并推水位、再跑不重复计费、模型失败不推水位（下次重试）、围栏可解/超量截断/坏 target 拒收、注入内容被工具层闸门拒收、重复条目计入 duplicate、未指定会话直接跳过、状态区汇总学习水位（sessions/lastAt）。

## 5. DSH：采集已接，注入未做

**会话采集**：`backend:"dsh"` 与 pi/acp 走同一套 `indexSources`——`parseDshSessionLog` 认 `$DSH_HOME/sessions/<workspace>/<id>/session[.vN].jsonl[.zstd]`（同目录只采最新代，同代压缩件优先），zstd 按帧扫描逐帧解压（与 `dshForeignSessionScan` 同构：魔数 0xFD2FB528、单帧 8MiB 上限）。事件口径与 `dshEventProjector` 一致：真人 `user/message`（`source.kind` 缺失按真人，注入上下文跳过）、`assistant/message` 终态（chunk/delta 全跳过）；派生会话（subagent / 有 parent）不采。

**工具面仍未接**：DSH 不走 MCP（`src/main/dsh/` 里没有 MCP 客户端），工具进不去。可行的注入路径是 `dsh-agent-instructions` 插件的 `instructionFileCandidates`：宿主落一份 `AGENTS.memory.md` 到项目根候选位置，DSH 自己读进上下文。未做的理由不变——这等于给 DSH 造一条"记忆块文件"的新约定（候选优先级、`maxBytes` 截断、与用户 `AGENTS.md` 的冲突），且 DSH 自带 `session_query` 系列工具。

## 6. 安全

- **注入扫描**（写记忆、写技能都过）：零宽/双向控制字符、`ignore previous instructions` 类句式、疑似凭据（`AKIA…`、`sk-…` 等）。命中即拒绝，返回稳定错误码。
- **会话采集是只读的**：只读已落盘文件，跳过 system 消息（整份系统提示会把索引撑爆）、跳过工具结果（体量不可控），工具名单独入库便于"上次那个 grep 怎么用"这类检索。
- **单文件上限** 64MB、单会话保留最近 2000 条消息、单条入库消息截断到 `MAX_INDEXED_MESSAGE_CHARS`。超限跳过而不是让 MCP 进程吃满内存。
- **stdout 只放协议**：调试输出一律 stderr，否则客户端解析失败。
- **不写用户仓库**：一切路径都在 `<userData>` 下。

## 7. 验证

```bash
node --test tests/agentMemoryServer.test.mjs   # 工具层 + 协议层（真进程走 stdio）
node --test tests/agentMemoryMounts.test.mjs   # 挂载形态、mcp.json 合并/幂等/可撤销、开关动作、项目键
node --test tests/agentMemorySettings.test.mjs  # 开关默认关、非法入参、渲染层与主进程接线
node --test tests/agentMemorySync.test.mjs     # 导出形状/勾选裁剪、预览五类状态、冲突策略、墓碑、设备作用域
node --test tests/agentMemoryBundleDialogs.test.mjs # 导入导出必须先弹窗、勾选与策略一路传到主进程、词典键齐全
node --test tests/agentMemoryEntryList.test.mjs # 条目浏览：列表 key 可删、只删一行、墓碑、撤销、STANDING 编辑、设备改名
node --test tests/agentMemoryLearn.test.mjs    # 学习循环：水位、失败不推、闸门
node --test tests/agentMemoryAcpE2E.test.mjs   # ACP 真进程：mcpServers 下发与工具调用
node --test tests/zhTwCopy.test.mjs            # 改了 zh-CN 词典后必须重跑生成器
npm run typecheck
```

守卫测试固定的行为（含学习循环：不白调模型、失败不推水位、写入过扫描闸门）：重复写入幂等、目标隔离、写入扫描拒绝、替换/删除歧义报错、CJK 子串检索、target 过滤不漏、会话指纹未变时跳过、追加后整份重灌不重复、`system` 消息不入库、fork 会话共享消息 id 时两边都要入索引、`cwd` 必须能派生出项目键、mcp.json 损坏时不覆盖、打包/开发两态脚本路径、导出不含设备记忆、导入幂等且坏条目不断任务、墓碑双向传播、设备记忆可检索且不进包、记忆 tab 的条目清单给的 key 正好能删掉它自己那一行、预览不写盘、按勾选裁剪导入导出（`overwrite` 让旧版本真的消失）、关掉墓碑同步就不删本地条目、删除后的撤销会回收墓碑、STANDING 保存穿透 mtime 短路且超预算拒写、设备改名只动 name 不动 id、DSH 会话（多帧 zstd）与 pi/acp 同一套索引且派生会话不采。

## 8. 与 hermes 的差异

| 维度 | hermes | 这里 | 原因 |
|---|---|---|---|
| 学习循环 | 每 N 轮起子进程让模型从对话里提炼记忆 | 有，宿主侧 opt-in（§4.6） | 走已有的回合结算信号 + 引擎索引取消息，不新增会话读取实现 |
| 常驻注入 | 每轮把记忆块塞进系统提示 | pi 不做（工具按需检索）；DSH 走 §5 | pi 走注入要改 pi 侧扩展，等于再开一条通道 |
| 纠正检测 | 三趟正则 + 挂起确认 | 不做 | 同上，依赖"每轮都看到对话" |
| 技能/合并/固化 | `skill_manage` + 自动 consolidator | 不做 | 记忆先跑通，技能库是另一条产品线 |
| 作用域键 | `<slug>-<sha1(path)>` | 派生 slug + 长路径哈希 | 同一意图，少一层哈希成本 |

## 9. 剩余工作（按价值排序）

1. **DSH 注入**（§5）：落 `AGENTS.memory.md` + 候选配置。DSH 没有 MCP 支持，工具面接不进去，只能走注入。
2. **技能库**：hermes 的 `skill_manage` + 自动 consolidator；这是另一条产品线，学习循环目前只写记忆条目。
3. **采集扩容**：`imported` 会话（claude/qoder 等）的 JSONL 都能接同一套解析器，只需加 adapter。
4. **远端同步**：导出包目前靠手动文件搬运。WebDAV/对象存储要新增外部副作用与凭据管理，先不做。
