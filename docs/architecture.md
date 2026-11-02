# 架构与跨层契约

> **Status: Current（2026-10-31 核对；以代码与测试为准）**


> 改 `src/main/index.ts`、`src/main/ipc/`、`src/shared/`、新增领域模块或调整后端适配层前读本文。
> 铁律与路由见根 `AGENTS.md`；Electron 运行时细节见 `docs/electron-playbook.md`。

## 后端矩阵（PiDeck 不只跑 pi）

`AgentBackend = "pi" | "dsh" | "acp" | "imagegen" | "videogen"`（`src/shared/types/agent.ts`）。

| 后端 | 通信方式 | 归属 |
|---|---|---|
| `pi` | stdio JSON-RPC（`AgentManager` ↔ pi 子进程） | 会话/工具/模型/会话文件全部由 pi 负责 |
| `dsh` | 内置 DSH host（`src/main/dsh/`，进程内 handler + 可选 runner node sidecar） | DSH runtime 随包分发，版本由 `sync:dsh-version` 对齐 |
| `acp` | stdio NDJSON JSON-RPC 到外部 CLI（`src/main/acp/AcpConnection.ts`） | 只做协议适配与会话投影，不实现 Agent 行为 |
| `imagegen` / `videogen` | PiDeck 自有生成链路 + 供应商 API | 产物落 `userData/imagegen`，见 `docs/maintenance-domains.md` §生图 |

- **会话是唯一一等公民**：`SessionRecord.id` 跨重启稳定；`agentId` 只表示当前子进程；runtime 命令与事件必须带 `sessionId + agentId + runtimeGeneration`，旧 generation 的迟到结果一律拒绝（`SessionRuntimeCoordinator`）。
- 新增后端不是加一个 `if`：先实现 `SessionRuntimeCoordinator` 的窄接口（capabilities 声明能做什么），再在 `CompositeAgentGateway` 注册；不支持的能力（如 DSH/ACP 的 `reloadResources`）必须显式缺席，让 UI 自然不渲染入口。

## 目录与依赖方向

```
src/
├── main/              # Electron 主进程（唯一可访问 Node/主进程能力）
│   ├── pi/            # pi RPC 进程、认证、模型请求快照、standby 池、enhance 侧车
│   ├── dsh/ acp/      # 非 pi 后端适配
│   ├── sessions/      # 会话扫描、导入、SessionRuntimeCoordinator
│   ├── git/           # GitService；子进程收口 git/gitRun.ts
│   ├── prompts/ skills/ extensions/ settings/ plugins/   # 各领域 Manager
│   ├── terminal/      # node-pty 终端会话
│   ├── browser/ cua/  # 内置浏览器 / CUA 桌面输入（pideck-cua MCP 工具面）
│   ├── memory/        # 内存剖析（MemoryMonitor / DOM 归属 / 内存画像 CSV）
│   ├── agentMemory/   # 智能体长期记忆：stdio MCP 服务器挂载（脚本在 resources/agent-memory/）
│   ├── feishu/ pet/ web/ ipc/ ipc/                      # IM、桌宠、Web 服务、IPC 域
│   └── ipc/           # ★ *Ipc.ts 只做入参校验与转发
├── preload/           # contextBridge 暴露最小 PiDesktopApi
├── renderer/src/      # atoms/ components/<域>/ hooks/ i18n/ styles/
└── shared/            # 纯契约层：types/*.ts 按域拆分 + ipc.ts 通道定义
```

- `shared/` 不得反向依赖任何运行时层；类型按域拆文件，IPC 通道名只在 `shared/ipc.ts`。
- `main/<domain>/` 放领域行为；`main/ipc/*Ipc.ts` 只做校验与委托；`main/index.ts` 只增装配不增业务。
- `renderer/` 只经 `desktopApi`/preload 调桌面能力；不得直接 import Node/Electron；跨组件状态只用 Jotai。
- 单向依赖：`main`/`preload`/`renderer` → `shared`；`main` 不 import renderer。

## IPC 注册（新增通道三处同步）

1. `src/shared/ipc.ts` 加通道常量（`domain:action` 命名）。
2. `src/main/ipc/<domain>Ipc.ts` 注册 handler：第一行校验入参（类型/路径合法性/枚举范围），再委托领域模块。
3. `src/preload/index.ts` 用 `ipcChannels.<name>` 逐个转发/订阅；事件订阅必须返回 unsubscribe。

漏任一处 → 运行时 undefined。新增域时开新 `*Ipc.ts`，不要继续往 `sessionIpc.ts` / `systemIpc.ts` 里堆。

**别把 Agent 事件名加进 `ipcChannels`**：`src/shared/ipc.ts` 有两张语义不同的表。
`agentEventTags`（`agents:state` / `agents:message` / `agents:text-stream` 等 8 个）是
`AgentManager` / `AcpAgentManager` / `DshAgentManager` 调 `emit()` 的第一个参数，只由
`emitSessionRuntimeEvent()` 聚合成单通道 `sessionsRuntimeEvent` 出去，**preload 里不存在**。
混进 `ipcChannels` 会让「三处同步」失去机械可判定性（要么误报，要么开白名单）。
`npm run check:ipc-wiring` 校验这两条边界（CI 已接入）：通道必须主进程 + preload 齐备，事件标签只准在主进程。

**live 流按可见会话裁剪**：`agents:text-stream` / `agents:thinking` 只对主窗口当前挂载的聊天栏
（当前会话 + 分屏）下发。渲染层经 `sessions:set-visible-sessions` 上报可见集合，主进程
`VisibleSessionRegistry` 判定；不可见会话没有 live 消费者，几百路并发时会把渲染进程主线程打满
（discussion #446）。其余事件标签（`agents:message` / `agents:state` / `agents:runtime-state` /
`agents:notice` / `agents:ui-request`）全量下发；新可见的会话由 `AgentManager.emitLiveSnapshot()`
补一帧全量正文/思考。

## 文件体量（增量门禁，防回流）

存量现实（2026-10 核对）：`main/index.ts` 6724 行、`AgentManager.ts` 6439、`App.tsx` 3722，全仓 **86 个文件 >600 行**；三份拆分计划落地后都出现回涨。

因此规则按「增量」执行，不再承诺全局 ≤400：

- **新增文件**目标 ≤400 行；单文件超 600 行必须先写拆分计划再合入。
- **存量巨文件不得净增长**：改动前 `wc -l` 记基线，改动后不得更高；新逻辑放新模块（hook / 协作者 / `main/<domain>/`）。
- `main/index.ts`、`App.tsx` 只准更薄；`sessionIpc.ts`、`systemIpc.ts`、`ConfigModal.tsx`、`DshAgentManager.ts` 同理。
- 例外：i18n 词典与生成物（`rendererCopy.*`、`*.zh-TW.ts`、manifest）不受行数约束。
- 拆分方法与当前行数基线：`docs/main-index-split-plan.md`、`docs/app-tsx-split-plan.md`、`docs/agent-manager-split-plan.md`。

## 模块内聚（功能能跑 ≠ 结构合格）

1. **一个模块一件事**：状态机/策略/解析放纯函数；UI 只做呈现与事件转发；hook 拥有该域状态。禁止把完整域逻辑写进 `App.tsx` 匿名回调。
2. **按域抽 hook，不按屏幕堆 props**：跨子树同一域有明确 owner；禁止 30+ 字段「props 袋」；视图 props 只留身份与 chrome 开关。
3. **选中 ≠ 呈现**：`selectSession` 只管「当前会话是谁」；Tab 预览/分屏/拖拽属于 chrome 域，在边界组合。
4. **多实例按 session 订阅**：分屏/多栏只订本栏 `sessionId` 的 atom family，不订 `currentSession*` 全局原子。
5. **纯策略可单测**：落点边、预览替换、过滤排序等产品规则写成纯函数配 `tests/*.test.mjs`，不活在 JSX lambda 里。
6. **异步与拖放用快照/稳定入口**：`drop`/`close`/定时器不闭包过期状态；用 ref 快照、`useCallback` 或单一 `dispatch`；依赖数组禁止写整个 `props`。
7. **同一 UI 能力一个挂载点**：共享 chrome 放外层，避免 solo/split 各挂一份。
8. **改前自检**：改动是否让 `App.tsx` 更懂业务？新状态是否有单一 owner？多会话订阅是否按 `sessionId` 隔离？核心规则能否离开 React 单测？

## 长期重构纪律

- 大重构先写对照计划（能力 parity 表 + 合并门禁），文档放 `docs/` 并注明状态；落地后更新状态行，不留悬空计划。
- 域迁移固定手法：源码整块迁出 + 原文件留薄包装或依赖注入，**行为零变化**；每步迁完 `grep -rl "<旧文件路径>" tests/` 同步改 `readFileSync` 源码契约测试（含断言里的旧标识符前缀）。
- 跨文件共享的可变单例用 `{ current }` ref 槽位，不复制第二份状态；目标文件行数**单调下降**才算一个 wave 完成。
- 禁止无对照表的长期分叉分支；main 的用户可感知改动当周回填到进行中的重构分支。
- 重构冲突禁止 `-X theirs` / `-X ours` 静默吞掉对方改动；每个冲突都要确认能力归属。
