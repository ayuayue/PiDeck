# PiDeck 打包版内存占用分析报告

> 日期：2026-08-06 ｜ 版本：0.7.0-beta ｜ 分支：refactor/issue-113-structure
> 场景：Windows 11 打包版（`release/win-unpacked`），启动后加载项目 + 开启 3 个会话来回切换

## 1. 结论摘要

- 打包版全进程树实测约 **2.2GB**（PiDeck 自身）+ 约 0.5GB（PiDeck 拉起的 pi agent 子进程）。
- **渲染进程独占 1.6GB（私有内存）**，是绝对大头，也是"切换会话卡顿"与"越用越卡"的直接原因。
- 渲染进程内存构成按代码证据排序：会话消息全量驻留（LRU 20 会话 × 每条含工具全文）＞ streamdown/shiki 双主题全语言高亮管线 ＞ monaco 编辑器（worker + 语言服务）＞ V8 heap 膨胀 + GC 滞后正反馈。
- "启动加载项目卡"根因：展开项目时主进程同步全量扫描该项目的会话 JSONL（摘要缓存未命中时逐一读文件 + 逐条过滤归属）。
- 渲染层已有分页（`useMessagePagination` 初始 100 条）与 LRU 缓存上限（20 会话），但**激活会话时仍 IPC 全量传消息 + 整体重建数组**，导致每次切换全量重渲染 markdown。

## 2. 实测数据（2026-08-06 用户实例）

### 2.1 PiDeck 自身进程树

| 进程 | PID | 私有内存 | 工作集 | 说明 |
|---|---|---|---|---|
| Renderer（主窗口） | 50068 | **1,598MB** | 1,681MB | 绝对大头，见 §3 |
| Main（主进程） | 57472 | 233MB | 281MB | 2 个活跃 agent 的全量消息 + sql.js + 扫描缓存 |
| GPU 进程 | 58012 | 198MB | 252MB | 合成器 + 透明窗口（EnableTransparentHwndEnlargement） |
| Network utility | 9512 | 14MB | 53MB | Chromium 网络服务 |
| 启动器 stub（单实例重启） | 51296 | 7MB | 20MB | — |

PiDeck 自身合计 ≈ 2.2GB（任务管理器按 WorkingSet 口径）。

### 2.2 PiDeck 拉起的 pi agent 子进程（独立 node 进程）

| 进程 | 内存 | 说明 |
|---|---|---|
| pi RPC agent × 2（node） | 170–203MB / 个 | `pi.cmd --mode rpc --no-themes --offline --session ...` |
| context-mode server × 2（node） | ~73MB / 个 | `context-mode/server.bundle.mjs` |

这些小计约 500MB，会出现在任务管理器中，用户感知的"总内存"≈ 2.7GB。

### 2.3 现场日志佐证（`%APPDATA%/pi-desktop/logs/app-2026-08-06.log`）

- 激活会话时加载消息：`rawMessages: 533 / trimmedMessages: 521`、另一个会话 `rawMessages: 316`（`AgentManager.loadMessages`，get_messages RPC 全量）。
- 同时存活 2 个 agent 进程（issue-113-structure 与 T6 项目），退出时 SIGTERM。
- 会话目录缓存：`session-catalog.json` 380 个会话（单项目最多 163 个）。

## 3. 渲染进程 1.6GB 构成拆解

> 未抓 V8 heap 快照（用户实例未重启），以下为代码路径 + 运行证据的推断，均有源码佐证。

### 3.1 会话消息全量驻留（主因之一）

- `src/renderer/src/atoms/session-atoms.ts`
  - `SESSION_MESSAGE_CACHE_LIMIT = 20`：LRU 缓存最多 20 个会话的完整 `ChatMessage[]`。
  - `cacheSessionMessagesAtom` 每次激活/流式更新都**整体替换** `messages` 数组（`messages: input.messages`）。
- 每个会话 300–500+ 条消息，含**工具调用全文**（bash 输出、diff 内容）与**压缩归档消息**（`compactionSummary.meta.archivedMessages`，主进程 `parseSessionArchives` 从会话 JSONL 补回）。
- 激活链路：`activateRuntime` → 主进程 `AgentManager.loadMessages`（get_messages RPC 全量）→ IPC 整体下发（`src/main/index.ts:452` `messages: agentManager.getMessages(...)`）。

### 3.2 streamdown markdown 管线（常驻 + 每次渲染）

- `src/renderer/src/components/session/MarkdownStream.tsx`：唯一 markdown 引擎。
  - 代码高亮：`@streamdown/code`（shiki 3.x，**github-light/github-dark 双主题 + 全语言 grammar 常驻**）。
  - 数学公式：`@streamdown/math`（KaTeX）；图表：`@streamdown/mermaid`（mermaid）+ cytoscape/wardley 自定义渲染器。
- 每个可见消息渲染产物（DOM + 语法树 + SVG）随 timeline 保留；`useMessagePagination` 初始 100 条，滚动继续加载。
- 打包佐证：`out/renderer` 72MB，其中 monaco worker 13+8+4MB、mermaid 2MB、各语言高亮 chunk 数百 KB 到 1MB 不等。

### 3.3 monaco 编辑器

- `EditorSurface.tsx` → `FileDiffViewer`：diff/编辑文件时初始化 monaco，`ts.worker`（13MB 代码）+ 语言服务 V8 heap；关闭 tab 后 editor/model 是否 dispose 需在 FileDiffViewer 内确认。

### 3.4 V8 heap 膨胀 + GC 滞后（卡顿放大）

切换会话 = 整体重建消息数组 → React 全量重渲染所有可见消息的 markdown（shiki/mermaid 重算）→ JS 主线程被占满 → GC 无法及时回收旧 DOM/对象 → heap 越涨越大 → 更卡。**这是"三个会话来回切换卡顿 + 内存持续上涨"的正反馈环**。

## 4. 主进程 233MB / GPU 252MB

- 主进程：`AgentManager` 为每个活跃 agent 持有完整 messages 数组（`src/main/pi/AgentManager.ts:88` `messages = new Map<string, ChatMessage[]>()`）+ `streamingThinking` + 压缩归档解析结果；sql.js WASM 全量加载 xueprompts.db（4.3MB）；SessionScanner 摘要缓存（459KB 磁盘文件）。
- GPU 进程：Chromium 合成器 + 透明窗口 + 合成层缓存；无壁纸/宠物时 252MB 偏高但非异常。

## 5. "启动加载项目卡"根因

- `src/main/ipc/sessionIpc.ts` `sessionsCatalogList` → `sessionScanner.list(projectPath)`：**同步全量扫描**该项目的会话根目录（`collectFromRootsLocal` 遍历全部文件 → 逐一 `readSummary` → `isSameProject` 过滤）→ 全部完成后才返回渲染层。
- 摘要缓存（`session-summary-cache.json`）命中可跳过 JSONL 重读，但**文件列表遍历 + 归属过滤每次都全量执行**；版本升级/字段变更（`sessionSummaryCache.ts` 有 CACHE_VERSION）后全量重扫。
- 用户项目规模：T6 163 会话、T6-2.0.5.1 120 会话、全库 380 会话。

## 6. 优化建议（按性价比排序）

> 2026-08 评审修正：
> - 原 P0「切 tab 卸载非活动 timeline DOM」与「流畅、动画优雅」冲突（粗暴卸载 → 切回白屏 + 重渲染闪烁），
>   改为 **keep-alive + 空闲回收**：最近 2–3 个 tab 以 `visibility` 保活，切回零重渲染；空闲/内存压力时回收更老的。
> - 原 P0「LRU 20→5」对当前 3 会话场景收益有限（只防长期累积），改为 **LRU 按内存水位动态回收**
>   （上限收紧至 5–8，触发条件 = 数量 + 内存水位）。
> - 新增「流畅」与「动画优雅」两条主线；动画规范与 Batch 6 任务拆解同步落于
>   `docs/ui-optimization-backlog.md`（原则 4 / Batch 6），本报告只留性能侧依据。

### 主线 A：内存 P0（核心）

| 改动 | 位置 | 预期收益 |
|---|---|---|
| 会话激活 IPC 分页：激活只下发最近 50–100 条，历史按需经 `prependSessionMessagePageAtom` 拼接 | `main/index.ts` activateRuntime 链路 + `useSessionTimelineController` | 渲染进程降 300–600MB；切会话卡顿基本消除；数组不再整体重建 |
| tab keep-alive + 空闲回收：最近 2–3 个 tab visibility 保活，空闲/内存压力回收更老的 | `SessionTabsBar` / `SessionMessageTimeline` | 3 tab 全挂载 DOM 省掉 2/3（200–500MB）；且是切 tab 动画的前提 |
| 消息 LRU 按内存水位动态回收（上限 5–8） | `session-atoms.ts` `SESSION_MESSAGE_CACHE_LIMIT` | 防长期累积 100–300MB；当前 3 会话场景收益有限 |
| 空闲 agent 回收：无交互 N 分钟的 pi RPC 进程退出，重激活再拉起 | `AgentManager` 生命周期 | 每个省 170–203MB + context-mode server 73MB |
| 关闭文件编辑器时 dispose monaco editor/model | `FileDiffViewer` | 编辑器内存可回收（50–200MB，打开过大文件时显著） |

### 主线 B：内存 P1

| 改动 | 位置 | 预期收益 |
|---|---|---|
| shiki 语言裁剪 + 懒加载：`@streamdown/code` 全语言 grammar 常驻裁为常用 20–30 种，冷门语言动态 import | streamdown 插件配置 / `MarkdownStream.tsx` | 常驻引擎内存降一半（原方案漏列） |
| 静态消息 markdown 渲染产物按内容 hash 缓存，切回直接复用 | `MarkdownStream` / timeline | 降 50–150MB；切回秒开 |
| 大工具输出（bash/diff）超阈值截断存储 | 主进程消息转换（`AgentMessageProjector` 附近） | 单会话内存降 60–80% |
| GPU 进程对策：壁纸关闭时验证能否去掉 `EnableTransparentHwndEnlargement` | 主进程窗口创建 | GPU 进程 252MB 的回收路径（原方案只写“收益有限”，补验证项，见 §8） |

### 主线 C：流畅（掉帧/卡顿治理）

| 改动 | 位置 | 预期收益 |
|---|---|---|
| ~~流式渲染微批节流~~ ✅ 已完成（双管齐下：主进程增量 flush 协议——流式节流只发尾部增量 `upsertFrom+totalLength`，终态全量校准，IPC 载荷从全量数组/50ms 降为 1–2 条；渲染层 `useThrottledStreamingText` 120ms + Streamdown element memo，解析频率减半） | `AgentManager.ts` / `agentUtils.ts` / `session-atoms.ts` / `streamingTextThrottle.ts` | 流式主线程反序列化开销 ~99%↓，解析次数减半以上 |
| 时间线长列表 `content-visibility: auto` + `contain-intrinsic-size` | `timeline.css` / 消息行组件 | 流式增长不再触发全局 layout（长会话掉帧主因） |
| ~~`sessionScanner.list` 异步化 + 摘要缓存先回显、骨架屏先行~~ ✅ 已完成（两阶段：缓存先回显 + 后台扫描推送 `sessions:catalog-refreshed` + 启动预扫描；`BackgroundScanCoordinator` 去重/冷却防 3 秒轮询并发重扫） | `sessionIpc.ts` / `BackgroundScanCoordinator.ts` / `useProjectSync.ts` | 消除“加载项目卡几秒”；缓存项目首屏回显即时 |

### 主线 D：动画优雅（规范层）

| 改动 | 位置 | 预期收益 |
|---|---|---|
| motion token 统一：三档时长（120ms 微反馈 / 200ms 常规 / 320ms 面板级）+ 统一缓动，进 Tailwind `@theme`，禁裸写 `transition: all` | `tailwind.css` / 全局 | 全站动画节奏一致（详规见 ui-optimization-backlog 原则 4） |
| 布局动画 transform/opacity-only（合成器线程）；width/height 动画列评审红线 | tab 切换 / 抽屉开合 / 终端收起 | 动画不触发 layout，不掉帧 |
| 激活/加载骨架屏（shimmer 代替白屏），与 Batch 3 “状态尺寸固定”同线 | 会话激活 / 项目展开 | 加载观感流畅 |
| 列表进入 stagger 限流（前 8–12 个元素） | 会话列表 / 文件树 | 大列表 stagger 是掉帧重灾区 |

### 主线 E：P2（长期）

| 改动 | 位置 | 预期收益 |
|---|---|---|
| 渲染 bundle 瘦身：monaco 语言服务按需加载 | `electron.vite.config.ts` | 启动加载 + 首帧更快（Code Cache 303MB 佐证） |

## 7. 测量方法（复现 / 后续验证）

```powershell
# 进程树内存（区分主/渲染/GPU/utility）
Get-CimInstance Win32_Process -Filter "Name like 'PiDeck%'" |
  Select-Object ProcessId, ParentProcessId, @{n='MemMB';e={[math]::Round($_.WorkingSetSize/1MB,1)}}, CommandLine | Format-List

# 私有内存口径（更真实）
Get-Process -Id <rendererPid> | Select @{n='PrivateMB';e={[math]::Round($_.PrivateMemorySize64/1MB,1)}}
```

精确定位渲染进程对象分布（需要重启实例，用户确认后执行）：

```bash
# 带调试端口启动（用完还原）
release/win-unpacked/PiDeck.exe --remote-debugging-port=9222
# 连 CDP 抓 heap snapshot / Runtime.getHeapUsage
# 或主进程临时暴露 webContents.getV8HeapStatistics()
```

## 8. 遗留待确认

- [ ] 渲染进程 V8 heap 快照：验证 §3 各构成占比（需重启实例抓取）。
- [ ] `FileDiffViewer` 关闭 tab 是否 dispose monaco editor/model。
- [ ] `@streamdown/code` 是否预注册全部语言 grammar（可裁剪为常用子集）。
- [ ] GPU 进程 252MB 基线验证：壁纸/宠物关闭时去掉 `EnableTransparentHwndEnlargement` 是否可回收，以及去后对现有窗口透明效果的影响范围。
- [ ] 空闲 agent 回收的边界：重激活拉起耗时（当前 activationMs 2–18s 日志可见）是否可被"预热 + 骨架屏"掩盖。
