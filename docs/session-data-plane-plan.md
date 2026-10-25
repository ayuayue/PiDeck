# 会话数据面统一 sidecar 对照计划（Session Data Plane）

> 状态：**Wave 0 完成；Wave 1/2 设计已细化（§8），实现未开始**（落地时按本文件收口：每波完成后更新状态行与 parity 表；全部迁完删除本文件）。
> 前置已落地：`native/session-index`（跨会话正文搜索，多词 AND + 项目级 roots）、`native/file-index`（工作区文件索引 + 正文检索）、`native/xue-index`。三个 sidecar 的宿主客户端（`SessionIndexService` / `FileIndexService` / `XueIndexService`）已定型同一套纪律：NDJSON stdio 协议、roots/库签名变化重启、请求 id 配对、迟到响应丢弃、进程身份核对、失败一律 `{ ok: false }` 降级不抛异常。

## 1. 问题

同一份 pi 会话 JSONL（`<sessionDir>/**/*.jsonl`）目前在主进程被 4 套 TS 代码各自解析一遍，各自有各自的上界、缓存与失效策略：

| 消费方 | 文件 | 规模 | 读法/上界 | 失效策略 |
|---|---|---|---|---|
| 侧栏目录 + 标题/预览 | `src/main/sessions/SessionScanner.ts` | 2490 行 | 每文件只读头部（`SUMMARY_PARSE_MAX_BYTES = 1MiB`），超 `MAX_IN_MEMORY_SESSION_BYTES = 32MiB` 的会话直接拒绝整体进内存 | 目录扫描 + 进程内 catalog |
| 会话目录/身份修复 | `src/main/sessions/SessionCatalog.ts` | 1823 行 | 与 scanner 重叠的头部解析 | 同上 |
| 打开会话的历史分页/跳转 | `src/main/pi/SessionHistoryReader.ts` | 2280 行 | 全量解析 + 每次打开重建显示索引；`FULL_TEXT_CACHE_MAX_BYTES = 32MiB`、`MAX_LOAD_WINDOW_ENTRIES = 1600`、`MAX_PAGE_WINDOW_ENTRIES = 600`、`MAX_TURN_PAGE_SIZE = 10`、`BRANCH_PREVIEW_MAX_ENTRIES = 1000` | 无持久化，进程内 LRU |
| 用量聚合 | `src/main/usageStats/{UsageLogReader,UsageStatsService,usageStatsAggregator,usageLogParser}.ts` | 172+310+450+100 行 | 增量读（`DEFAULT_MAX_LOG_BYTES = 256MiB`） | 自己的游标 |
| 外部 transcript 导入 | `src/main/sessions/*Importer.ts`（12 个） | 3794 行 | 各自解析外部格式后**写** pi JSONL | 不适用·写路径 |

直接后果：

- 每个新消费方（正文搜索、轨迹重建、token 统计…）都要重新发明「怎么读 JSONL、上界多少、缓存怎么失效」；**消费侧的读取上界、缓存与渲染成本另见 `docs/trajectory-session-consumer-plan.md`**（本文件只管传输层，不重复它的问题清单）；
- 大会话必须整体进内存（32MiB 上限之外直接拒绝打开），打开成本随文件大小线性上升；
- 上界与字段解释略有差异，容易出现「同一文件在不同 UI 里表现不一致」（历史上出现过 toolResult 配对、分支预览截断一类问题）。

`native/session-index` 已经证明：**只读投影到紧凑语料 + 定长快照**能把这类成本压到毫秒级——实测 646 个会话文件 / 594.6MB → 首建 5008ms、语料 12.7MB、快照复用 boot 0ms / indexMs 28ms、单词查询 5–8ms。

## 2. 目标 / 非目标

目标：

1. 主进程只保留**一个**会话文件读入口（sidecar，NDJSON 协议，与既有三个 sidecar 同哲学）；
2. 打开会话/刷新侧栏不再重新解析 JSONL（快照复用优先）；
3. 统一字段解释与上界，新消费方只加协议方法，不再各自解析；
4. 全程 fail-open：sidecar 缺失/未就绪/超时 → 回退现有 TS 路径（旧代码留到 parity 全绿再删）。

非目标（硬边界）：

- **不接管 pi 的会话写入**（append / edit / fork / 删除墓碑仍由 pi 负责；PiDeck 只读，`context_edit` 三道闸不许放宽）；
- 不改 pi 的 JSONL 格式、不做双写；
- 不改 `sessions:*` IPC 的入参/出参/错误语义（渲染层零感知）；
- 不把导入器搬进 sidecar（写路径留在宿主，见 P9）。

## 3. 能力 parity 表（逐行迁移，未迁完不删旧实现）

| # | 能力 | 现在在哪 | sidecar 协议方法 | parity 判据 | 状态 |
|---|---|---|---|---|---|
| P1 | 会话文件清单（按项目/全局） | `SessionScanner` 目录扫描 | `list-files { roots, since? }` | 文件集合、`updatedAtMs`、size 逐项一致 | 待迁 |
| P2 | 摘要头字段（title/preview/messageCount/首条用户消息…） | `SessionScanner` 头部解析 | `read-summary { path }` | 侧栏渲染字段逐字段一致（含缺失值语义） | 待迁 |
| P3 | 分页窗口（load window / page window） | `SessionHistoryReader` | `read-window { path, from, count }` | 同窗口条目数、边界、`hasMore` 一致 | 待迁 |
| P4 | 单轮分页 | `SessionHistoryReader` | `read-turn { path, turnId, page }` | 轮边界与条目切分一致 | 待迁 |
| P5 | 分支预览（1000 条 / 256KiB 行截断） | `SessionHistoryReader` | `read-branch { path, ref }` | 预览条目与截断标记一致 | 待迁 |
| P6 | 跳转定位（`jumpToMessage`） | `SessionHistoryReader` 显示索引 | `locate { path, messageId }` | 返回窗口起点与现有跳转落点一致 | 待迁 |
| P7 | 用量聚合（按日/按模型） | `usageStats/*` | `usage-rollup { roots, from, to }` | 对账脚本按日/模型比对误差 0 | 待迁 |
| P8 | 跨会话正文搜索 | `native/session-index` | 已有 | — | 已完成 |
| P9 | 导入外部 transcript | 12 个 `*Importer.ts` | **不进 sidecar** | 只要求导入产物能被 P1–P7 读出 | 明确不迁 |

## 4. 分波计划（每波独立可验证、可回滚）

- **Wave 0 — 基线与探针（无行为变化）**：✅ 已完成。`scripts/probeSessionRead.mjs` 量出三个现状数字：侧栏首屏扫描耗时（文件数/总字节）、打开 1MB / 10MB / 50MB 会话耗时、主进程内存增量，数字见 §7。命令：`node scripts/probeSessionRead.mjs`（改实现后用同一命令复跑对比）。
- **Wave 1 — 会话投影 sidecar（P1/P2）**：`native/session-store`（纯标准库，快照布局照 `native/session-index`），只做清单 + 摘要头；宿主 `SessionStoreService`（照 `src/main/files/FileIndexService.ts` 抄：`isReady` / `warmup` / 就绪粘滞）；`SessionScanner` 原路保留作回退，用设置开关 `settings.sessionStoreEnabled`（默认开，开发者页可关）切换。
- **Wave 2 — 历史窗口（P3–P6）**：协议扩展 `read-window` / `read-turn` / `read-branch` / `locate`；宿主在 `SessionHistoryReader` 外挂适配层（sidecar 优先、失败回退），**不动 IPC 与渲染层契约**。门禁：把开大会话的耗时/内存对比写回本文档。
- **Wave 3 — 用量（P7）**：`usage-rollup` 替换 `usageStatsAggregator` 的读路径（账本与游标仍由宿主维护）；对账脚本逐日/逐模型比对到 0 误差。
- **Wave 4 — 进程收敛（可选）**：把 session-index 语料与 session-store 快照合并进一个进程（多方法一进程，减少常驻进程数）。仅在 Wave 1–3 落地且进程数成为实际问题时做。

## 5. 合并门禁（每波必须全绿）

1. **parity 对照**：对应行的字段级对照测试（Go 表驱动 + 宿主契约测试），不以「看起来一样」结案；
2. **降级证明**：sidecar 缺失/未就绪/超时/异常各有一条测试证明回退到旧路径生效（形状同 `tests/fileIndexService.test.mjs` 的 `binary-missing` / `not-ready` 用例）；
3. **有界读取**：新增读路径必须有字节/条目上界（沿用或严于现有口径），禁止无界 `readFile`；
4. **IPC 不变**：`sessions:*` 通道入参/出参/错误语义逐项不变，相关 e2e 差分跑一次；
5. **验证命令**：`npm run typecheck` + 改动涉及的针对性 `node --test tests/<x>.test.mjs` + `go -C native/<mod> test ./...`；不做全量构建（项目硬约束）；
6. **开关与回滚**：设置项一键关闭后行为与今天逐字一致；
7. **文档**：本文件状态行、parity 表、实测数字当次更新；全绿后删除本文件（不留悬空计划）。

## 6. 风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| pi 会话格式演进 | 新增条目类型/字段时严格解析会漏读 | 未知类型跳过并计数（stats 回传，便于诊断），保留 TS 回退 |
| 双实现漂移 | sidecar 与回退路径可能给出不同结果 | parity 表逐行对照；迁完即删旧实现，避免长期双实现 |
| 进程/内存 | 每项目一个 sidecar 会放大常驻内存 | Wave 1–3 单进程多方法；只在必要时谈 Wave 4 |
| 打包/签名 | 新 Go 二进制要进 `extraResources`、CI 构建、macOS 签名链 | 照 `scripts/build-file-index.mjs` + 三平台 workflow env + `go test` 步骤抄，不新发明 |
| WSL | 宿主 Go 进程读 UNC 不可靠 | 与现有 sidecar 一致：WSL 模式整体降级回 TS 路径 |
| 写入路径误伤 | 一旦 sidecar 越界写文件可能损坏会话 | 协议只读（`mode=ro` / 只 open 读），写路径留在宿主与 pi |

## 7. 现状参考数字

### sidecar 侧（`native/session-index`，本机 646 文件 / 594.6MB 源）

首建索引 5008ms、30484 条目、语料 12.7MB；快照复用 boot 0ms / `indexMs` 28；单词查询 5–8ms。

### TS 侧基线（Wave 0，`node scripts/probeSessionRead.mjs --top 5`，2026-10，本机）

口径：侧栏扫描 = 并发 4 + 每文件 1MiB 头窗口 + 逐行 `JSON.parse`（对齐 `SessionScanner`）；打开会话 = 1MiB 定长块流式扫描 + 逐行 `JSON.parse`（对齐 `SessionHistoryReader` 全量重建）。

| 根 | 文件数 / 总字节 | 侧栏首屏扫描 | 每文件 | 头+尾窗口变体 | 打开 1MiB | 打开 10MiB | 打开 20–31MiB |
|---|---|---|---|---|---|---|---|
| `~/.pi/agent/sessions` | 647 / 595.1 MiB | **2786 ms**（头读 275 MiB，9.07 万行） | 4.31 ms | +758 ms（多读 155 MiB） | 4 ms | 165 ms | 94 ms（19.4 MiB） |
| `<repo>/.pi/sessions` | 242 / 512.2 MiB | **1298 ms**（头读 173 MiB，4.15 万行） | 5.36 ms | +649 ms（多读 126 MiB） | 5 ms | 102 ms | 87 ms（31.1 MiB） |

内存（同一次运行，未开 `--expose-gc`）：全局根 rss Δ142.7 MiB / 峰值 288.6 MiB，仓库根 rss Δ43.7 MiB / 峰值 286.1 MiB；heapUsed 增量仅 7–18 MiB（parse 产物被回收），说明**峰值内存压力来自 read 缓冲与一次性字符串，不来自常驻对象**，但已逼近主进程 384MB 老生代上限（见 `src/main/v8HeapLimits.ts`）。

注：单机多次复跑有 ±20% 波动（磁盘缓存冷热、杀毒扫盘），只看同机前后对比，不做跨机比较；内存数字建议加 `--expose-gc` 复跑一次取更干净的口径。

结论（决定波次顺序）：

1. 侧栏清单不是瓶颈而是「机械成本」——每文件 4–5 ms 全部花在 stat + 头读 + 逐行 parse，且只读 1MiB；sidecar 快照复用（28ms）能把它压到接近 0，但收益上限就是这几秒，且只发生在冷启动/失效时。
2. **打开大会话才是真痛点**：10–31 MiB 会话 87–165 ms 且必须整体流式扫一遍（无持久化索引），每次打开重建；20 MB 级文件已接近 32MiB 全量内存闸门。
3. 因此 P3–P6（历史窗口）优先于 P1/P2（清单投影）在收益上更划算；P1/P2 仍值得做，但定位是「给 sidecar 立最小骨架 + 统一解析」，不是性能救命。
4. 侧栏扫描的 4 秒（两根合计）里还有未计入的策略成本（身份修复、子代理分组、fork 链、标题推断），sidecar 化后这部分仍留在 TS。

## 8. 详细设计（Wave 1/2 动手前定稿）

### 8.1 形态结论（读码得出，决定迁移面大小）

TS 历史路径已经是「**索引 + 定向读行**」两段式，而不是「整文件读进内存」：

- 建表：`SessionHistoryReader.getSessionDisplayIndex()`（`src/main/pi/SessionHistoryReader.ts:1485`）扫全文件，产出 `entries: Map<id, SessionDisplayEntry>` + `activeBranch` + `metadata` + `contextEdits` + `endsWithNewline`；`SessionDisplayEntry` 定义见 `SessionHistoryReader.ts:187-234`，`SessionDisplayIndex` 见 `:236-260`；
- 取值：`readIndexedLines()` 按 `{offset, byteLength}` 定向读单行，`readIndexedSessionMessages()` 只取每行的 `.message`，`readIndexedRawLines()` 取整行 JSON。

因此：

- **Wave 2 的 sidecar 只负责把 offset 表建快**（含 `id/parentId/type/role/offset/byteLength/…` 与 `hasCompaction/endsWithNewline`），消息体仍走现有定向读路径。迁移面小、字段 parity 可逐字段对照，风险可控。
- **不做**：让 sidecar 回传解析后的 `ChatMessage`。那要把 `parseIndexLine` + 消息转换 + 分支/压缩/`context_edit` 语义全量搬进 Go，收益只是省一次读盘，工作量与漂移风险都大得多。
- **派生留 TS**：`activeBranch`/`activeMessageEntries`/`metadata`/`contextEdits`/fork 链合并（`mergeForkChain`）/身份修复/去重/子代理分组/标题清洗/preview 截断全部是策略层，留在 TS，不进口协议。

### 8.2 协议（`native/session-store`，NDJSON stdio，`ProtocolVersion = 1`）

帧纪律照 `native/session-index`：`requestFrame{cmd,id,…}` / `readyFrame{type,protocolVersion,…}` / `responseFrame{type,id,ok,result,error}`；stdout 每帧显式 `Flush()`、日志一律 stderr 带 `[session-store] ` 前缀；空参/未知 cmd 回错误帧；请求串行；`id` 用 `json.RawMessage` 原样回填。

| cmd | 入参 | 出参 | 用途 |
|---|---|---|---|
| `list-files` | `{roots}` | `{files:[{path,size,mtimeMs,entryCount,hasCompaction,endsWithNewline,cached}]}` | 版本探测与失效判定（Wave 1 骨架） |
| `get-index` | `{path}` | `{entries:[EntryRecord…],hasCompaction,endsWithNewline,size,mtimeMs}` | 历史窗口索引（Wave 2） |
| `list-summaries` | `{roots,limit?}` | `{summaries:[ScanProjection…]}` | 侧栏清单（Wave 3，字段见 8.4a） |
| `refresh` | `{roots}` | `{changedFiles,rebuiltFiles,indexMs}` | 增量重建 |

`EntryRecord` = `{id,parentId,type,offset,byteLength,role?,customType?,customDisplay?,toolName?,messageId?,messageTimestamp?,modelChangeProvider?,modelChangeId?,assistantModel?,thinkingLevel?,hasMessage,oversized?,summary?,timestamp?,tokensBefore?,firstKeptEntryId?,parentSession?,contextEditTargetId?,contextEditExcludes?,contextEditText?}`——与 `SessionDisplayEntry`（`SessionHistoryReader.ts:187-234`）逐字段对齐。

### 8.3 快照布局

- 布局照 `native/session-index`（已验证可跑）：`<userData>/session-store/state.bin` = magic + 版本 + head JSON + 定长记录区 + 字符串池（id/路径），写入走 `state.bin.tmp` + `os.Rename`（先语料后快照的两段改名顺序要吸取 `native/session-index` 的同代校验教训：`loadState` 必须校验 head 里声明的文件大小与实际一致，不一致就丢弃重建）。
- 版本键：每文件 `{size, mtimeMs, endsWithNewline}`；命中即零读返回。
- 增量追加：`size > 记录值` 且旧记录 `endsWithNewline === true` → 从记录 size 读到 EOF，**只接受完整行**（末尾残行不记入、下轮重读）；否则该文件整文件重建。
- 失效：size 变小（压缩重写）或 `endsWithNewline` 为 false 或快照版本不匹配 → 重建单文件，不影响其它文件。
- 只读纪律：会话文件一律只读打开，绝不写；不产生 `-wal/-shm` 类副产物（参考 `native/xue-index` 的 `mode=ro`）。

### 8.4 Parity 判定依据

**(a) 侧栏投影（Wave 3）**：`SessionScanLine`（`SessionScanner.ts:47-77`）共 24 个字段——`type/customType/timestamp/name/sessionName/cwd/projectPath/parentSession/provider/modelId/thinkingLevel/codexSessionId/sourcePath/threadSource/parentThreadId/agentRole/agentNickname/role/content/model/message/data/header/session`。来源行类型固定：`session`（头：cwd/parentSession）、`session_info`（name，含「复制的父历史」判定）、`message`（role/content/preview/model）、`model_change`、`thinking_level_change`、`custom`/`custom_message`（子代理记录与 todo）、codex 导入标记（session/header 里的 codex 字段）。

**(b) 历史条目（Wave 2）**：`SessionDisplayEntry` 26 个字段中，**必须由 sidecar 提供**：`id/parentId/type/offset/byteLength/hasMessage/role/customType/customDisplay/toolName/messageId/messageTimestamp/modelChangeProvider/modelChangeId/assistantModel/thinkingLevel/oversized/summary/timestamp/tokensBefore/firstKeptEntryId/parentSession/contextEdit*`；**TS 派生**：`chainHostPath`（fork 链合并时标注）与整个 `SessionDisplayIndex` 的 `activeBranch/activeMessageEntries/metadata/contextEdits/chainSources`。

**Policy 不进 sidecar**（写进门禁）：身份修复、目录/标题去重、子代理分组、fork 合并、标题清洗（`cleanScanTitle`）、preview 截断、各类上限（1600/600/10/32MiB 等）。

### 8.5 P7（用量）重估

`<agentDir>/analytics/usage.jsonl` 本机 13.6 MB / 6.5 万行（append-only，已有游标增量读取）。全量重扫成本比会话 JSONL 低一个量级，且已有增量机制——**建议 P7 降到 Wave 3 之后或不做**，不占 Wave 1–2 注意力。

### 8.6 修订后的波次

| 波次 | 内容 | 交付判据 |
|---|---|---|
| Wave 1 | `native/session-store` 骨架：`list-files` + 快照读写 + 增量/失效 + 宿主 `SessionStoreService`（照 `FileIndexService` 抄）；构建/CI 登记齐全 | parity/失效/降级测试全绿；无消费者不常驻（启动不预热） |
| Wave 2 | `get-index` 接 `SessionHistoryReader`（先只用于「缓存未命中时的建表」，命中路径不变） | 索引 parity 逐字段一致；打开 10–31MiB 会话耗时/内存对比写回 §7 |
| Wave 3 | `list-summaries` 接侧栏清单（P1/P2） | 清单 parity；首屏扫描耗时对比 |
| Wave 4 | 进程收敛 + （可选）P7 | 视前几波结论决定 |

### 8.7 专属测试矩阵（Wave 1/2）

1. **索引 parity**：fixture JSONL 覆盖 正常 / fork（`parentSession`）/ 子代理锚点 / codex 导入 / 压缩条目 / `context_edit` / 巨型行（>64MiB，只留前缀）/ 末尾残行 / 空行 → sidecar 条目表与 `SessionHistoryReader` 建出的表逐字段相等；
2. **增量正确性**：追加若干行后 `get-index` 结果 === 同一 fixture 全量重建结果；末尾残行不得被固化成条目；
3. **失效**：文件被压缩重写（size 变小）/ mtime 变化 / 快照损坏（magic 不符）→ 重建而非回陈旧表；
4. **降级**：二进制缺失、boot 超时、roots 变化、协议版本不符 → 全部回退 TS 建表，`history-changed` 语义不变；
5. **不动 IPC**：`sessions:*` 历史通道出参形状逐字段不变（相关 e2e 差分一次）；
6. **内存/耗时**：同口径对比（`scripts/probeSessionRead.mjs`）写回 §7，未变好就回退该波。

### 8.8 未决问题（动手前拍板）

1. **roots 语义**：现三个 sidecar 都是「单 roots 签名，变了重启」；会话文件按项目分目录，切项目会丢缓存。倾向：快照按**文件路径分桶**持久化（换 roots 不重建未变更文件），进程仍单 roots。
2. **快照粒度**：单 `state.bin` vs 每 roots 一份；倾向前者 + 文件级记录复用。
3. **收益证明**：`get-index` 建表同样要读全文件，收益来自「一次建表多次用 + 不在主进程建 10 万级对象」。Wave 2 门禁必须用同口径数字证明（对照 §7 的 87–165 ms）；若只有读盘没省其余，就不值得做。
4. **WSL**：现有 sidecar 一律降级；session-store 不做 WSL 支持（UNC 读不可靠），沿用降级。

### 8.9 Wave 1 落地记录（已完成，未接线到任何消费者）

**已交付**：`native/session-store`（`go.mod`/`main.go`/`store.go`/`scan.go` + 两个测试文件，纯标准库零依赖）+ 宿主 `src/main/sessions/SessionStoreService.ts` + 构建/打包/CI/文档登记 + 装配（`src/main/index.ts`：二进制定位、`statePath` 落 `<userData>/session-store/state.bin`、`quitCleanup.register("session-store")`，**启动不预热**）。

**§8.8 未决问题的落地答案**：

1. **roots 语义（Q1）**：快照按**绝对文件路径**分键持久化，roots 改为**逐请求参数**（`list-files {roots}`），换 roots 不重启进程、不丢未变更文件的复用记录。spawn 形态因此与三个兄弟服务不同：`spawnFn(binaryPath, [statePath])` 不带 roots。
2. **快照粒度（Q2）**：单 `state.bin`（JSON，`formatVersion = 1`，每文件一条记录），原子 `state.bin.tmp` + rename 落盘。
3. **开关（Wave 1 行的 `sessionStoreEnabled`）暂缓**：Wave 1 无消费者（接线要等 Wave 2 的 `get-index`），一个没人读的开关只会成为死配置；Wave 2 接线时与 `extraResources` 一起补（构建脚本头注释已写明这一点）。
4. **WSL**：沿用降级（不由本模块决定，调用方按 `environment === "wsl"` 跳过）。

**快照口径（Wave 1 已定，Wave 2 若需精确 parity 再升 `formatVersion`）**：每文件记录 `{path,size,mtimeMs,entryCount,hasCompaction,endsWithNewline}`；`entryCount` = 带 `id` 的完整行数（**行口径，未做身份去重**），`hasCompaction` = 文件里出现过 `compaction` 行（**文件口径，非 activeBranch 口径**）。Wave 2 的 `get-index` 必须补真实条目表，届时升版本。

**行边界提交不变量**：`size` 永远只推进到最后一个完整行（`\n` 结尾），末尾残行不计入；因此「size 变大 且 快照记录以换行结尾」才做增量尾扫，否则全量重建。单行超过 64MiB 时只留前 64KiB 前缀做 `id`/`compaction` 探测（与 `txt/jsonlLineStream.ts:MAX_JSONL_LINE_BYTES` 同口径），不会 OOM。

**实测（本机，源码 889 文件 / 两处根合计 ~595MiB；`reused`/`incremental`/`full`/`pruned`/`indexMs` 来自 ready/response 帧）**：

| 场景 | 数字 |
|---|---|
| 首建（冷启动全量扫，逐行探测） | `full = 889`，`indexMs = 7224`（端到端 7.26s）；快照 221 KB |
| 二开（快照复用，无文件变化） | `reused = 889`，`full = 0`，`indexMs = 40`，`bootMs = 2`（端到端 65ms） |
| 对照：TS 侧首屏（Wave 0 `probeSessionRead.mjs`，仅读每文件前 1MiB 头部） | `headSweepMs` 699ms |

结论：**冷启一次全量比 TS 只读头部慢一个量级（7.2s vs 0.7s，因为要逐行扫完 595MiB），但快照命中后是 40ms，比 TS 首屏还快 ~17×**。所以 Wave 2 接线必须把它用在「打开会话/读窗口」这类**重复读**路径上（首次仍可让 TS 顶一下），不能用在首屏清单扫描上；这条写入 Wave 2 门禁。

### 8.10 Wave 2 落地记录（已实现 + parity 全绿，但收益门禁未过 → 默认关）

**已交付**

- Go 侧 `get-index`：`native/session-store/table.go`（行级 `displayEntry` 镜像 + 超长行降级 + 与 TS 同 pattern 的字段探取）、`indexcache.go`（进程内表缓存：`maxCachedTables = 16` / 256MiB 上限 / LRU）、`main.go` 命令分支、`table_test.go` + `parity_test.go`（对基准逐字段）。
- 宿主：`SessionStoreService.getIndex(hostPath)`（单行上限放宽到 32MiB，条目表可能几十 MB）；`SessionHistoryReader` 加 `readIndexTable` 可选注入 + 字段级校验器（子进程输出不可信，形状不符整体弃用）+ 「缓存未命中先问 sidecar」分支；`AgentManager.setSessionStoreIndexReader`；`src/main/index.ts` 装配。
- 双向 parity 门禁：`tests/fixtures/sessionStoreIndexParity.jsonl` + `.golden.json`（18 条覆盖 session/message/model_change/thinking_level_change/custom/custom_message/compaction/context_edit/oversized）+ `scripts/genSessionStoreIndexGolden.mjs`（基准由**真实 Go 二进制**产出）+ Go 侧 `TestIndexTableMatchesGolden` + TS 侧 `tests/sessionStoreIndexParity.test.mjs`（同一文件、两个读者的公开 API 输出逐字段相等；残行/坏形状/sidecar 抛错三种情况都回退 TS）。
- 开关：`settings.sessionStoreEnabled`（**默认 false**、无 UI；实验时写 settings.json）。

**收益实测（本机 2026-10，4 个真实大会话；TS = 新建 reader 后 `readLoadWindow` 冷索引耗时；Go = `get-index` 的 `elapsedMs`）**

| 文件大小 | TS 冷建表（3 次） | TS 同实例再开 | Go 冷解析 | Go 表缓存命中 |
|---|---|---|---|---|
| 31.1 MiB | 116 / 113 / 99 | 35 | 343 | 0 |
| 29.2 MiB | 67 / 60 / 73 | 3 | 328 | 0 |
| 23.1 MiB | 188 / 158 / 163 | 58 | 319 | 0 |
| 19.4 MiB | 79 / 80 / 83 | 2 | 251 | 0 |

（与 §7 Wave 0 基线「打开会话 87–165ms」同量级。）

**结论（§8.8-Q3 的判定：不通过）**，所以不动产品路径：

1. Go 冷解析比 TS 冷建表慢 2–3×（`encoding/json` 逐行 vs V8 `JSON.parse`）——首次打开反而更慢。
2. sidecar 的表缓存只在进程内（`maxCachedTables = 16`），app 重启后没有条目缓存：快照 `state.bin` 只存文件级记账（`entryCount`/`hasCompaction`），不含条目表，所以「一次建表多次用」跨重启不成立。
3. 同一次运行内 TS 自己的 `sessionDisplayIndexes` LRU 已把「重复打开」做到 2–58ms；sidecar 只在 LRU 未命中时更快，而 LRU 未命中恰好就是冷解析（更慢）。

**Wave 2b 才是收益来源（未做）**：把条目表按文件落进快照（`formatVersion` 升为二进制定长记录区 + 字符串池）并在 pi 追加后做增量尾扫；那时重启后首次打开也能从 99–188ms 降到 ~10ms。代价：快照体积与写入放大（每次追加重写该文件记录）、Go 侧第二套持久化实现。

**启用方式（Wave 2 阶段，已被 §8.11 取代）**：当时只能 settings.json 置 `"sessionStoreEnabled": true` 手动实验，`extraResources` 未登记。

### 8.11 Wave 2b 落地记录（条目表落盘 → 收益门禁通过，默认开启）

**做了什么**：`native/session-store` 增加条目表磁盘持久化（`tablepersist.go`），宿主 `SessionStoreService` 增加可选 `tablesDir`（装配层给 `<userData>/session-store/tables`），于是「重启后首次打开大会话」不再重扫源文件；`settings.sessionStoreEnabled` 默认值由 `false` 改为 `true`，并补上 `extraResources`（`resources/session-store/bin` → `session-store`）。

**格式与失效**：一文件一条目文件（`<sha1(path)>.table`），首行 header JSON（`version`/`path`/`size`/`mtimeMs`/`endsWithNewline`/`entryCount`/`oversizedLines`），其后每行一个 `displayEntry` JSON（复用 Go 的 `json` 标签，不引入二进制定长记录：可选字段十几个，编码代码量与漂移风险都不划算）。版本键与内存缓存同口径：`size + mtimeMs` 都相等才整表复用；只是变长且上次停在换行边界 → 复用旧条目 + 只解析尾部（`scanTableFrom(start)`）；变短/损坏/版本不符 → 单文件全量重扫。目录上限 `maxTableFiles = 256` / `maxTableDirBytes = 512MiB`，按 mtime 淘汰最旧；单表上限 32MB。写盘走 `.tmp` + `os.Rename`，失败只 log。

**v2 边界校验（issue #392）**：版本键看不出「文件被整份重写、恰好更长」——编辑消息、压缩重写、外部工具重建/导入都会造成这种重写，且重写后条目 id 往往全换；此时尾部增量从旧 `size` 处接着解析，条目从错位点起与文件脱节，活动链（`traceActiveBranch` 从末条沿 `parentId` 回溯）在断点处截断 = 用户看到的「只剩最后几轮、也没有『加载更多』」，而这张错表按 `size+mtimeMs` 永久命中、重启不自愈（删表才恢复）。现在复用命中（整表复用与尾部增量两种）之前都走 `verifyTableBoundary`：按表里的 `offset/byteLength` 回读**首条与末条**（超长行只读 64KiB 前缀并比正则抢到的 id），id 不符即丢弃命中、全量重扫覆盖落盘；同时 `tableFileVersion` 1 → 2，把用户手里已脱节的旧条目文件一次性丢弃重建（等价于报告者手删表）。残留取舍：同长改写且首/末条未变的中段改写仍可能误命中（与 TS 侧 `appendIndexFromTail` 首/末探针同一取舍）。

**实测（本机，同一批真实会话，`get-index` 全程经协议子进程）**

| 文件 | 大小 | 条目 | 冷（boot + 解析） | 重启后磁盘命中 #1 | #2 |
|---|---|---|---|---|---|
| `.pi/sessions/2026-10-04T01-36-54-875Z_…jsonl` | 31.1 MiB | 1386 | 15 + 421 = **436 ms** | **17 ms** | 20 ms |
| `.pi/sessions/2026-10-10T13-16-06-843Z_…jsonl` | 29.2 MiB | 644 | 8 + 409 = **417 ms** | **14 ms** | 14 ms |

对照 §8.10：TS 冷建表 99–188ms、sidecar 内存命中 0ms（重启即失效）。**磁盘命中 14–20ms（含进程 boot 8–15ms）比 TS 冷建表快 5–12×**，且不随会话大小线性增长（只是读几百 KB 条目文件 + JSON 解码）。这满足 §8.8-Q3「证明收益再接线」的判据，故默认开启。

**门禁**：`native/session-store/tablepersist_test.go` 10 个用例（跨实例复用——用「同长度改写 + 还原 mtime」证明真读了磁盘、尾部增量、残行不增量、损坏回退、截短重扫、无目录退化内存模式、目录淘汰保留最新与当前、整份重写换 id 且变长必须等于全量重扫且活动链覆盖全部条目、旧版本号条目文件丢弃重扫）；`tests/sessionStoreService.test.mjs` 18 项（含 argv 带 `tablesDir`）；`tests/sessionStoreIndexParity.test.mjs` 4 项 parity；`go -C native/session-store test ./...` 全绿。

**仍未做**：条目表尚未与 `state.bin` 合并（两套持久化并存，Wave 4 收敛）；`list-summaries`（Wave 3）因 TS 侧摘要缓存已足够快被判定不做（§8.10 后的实测结论）；`usage-rollup` 未动。
