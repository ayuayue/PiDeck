# main/index.ts 拆分计划

> 状态：**进行中**（Wave 1 已落地，2027-02）。目标：`src/main/index.ts` 只增装配不增业务（AGENTS.md 硬性），文件体量进入 ≤400 行目标轨道。
> 方法沿用 `docs/agent-manager-split-plan.md` / `docs/app-tsx-split-plan.md` 的薄包装迁移纪律：零行为变化、契约测试同步改读新模块、每步 typecheck + 针对性回归。

## 基线

- 拆分前 `src/main/index.ts` ≈ 4892 行（P0/P1/P2 批次后）。
- Wave 1 后 4556 行（飞书域 333 行迁出 + 安装器 spawn 兜底注释）。

## 结构地图（行号为 Wave 1 后快照，仅供定位参考）

| 域 | 原位置 | 内容 | 状态 |
|----|--------|------|------|
| imports | 1–370 | 全量导入（含域 import 逐步下沉） | 随波次收缩 |
| 模块级状态 | ~372–1000 | mainWindow/agentManager/projectStore/feishuBridgeRef/sessionCatalog/settingsStore/quitCleanup 登记等 | 保留（装配态） |
| feishuSessionRuntimeBindings gateway | ~989–1050 | Catalog-first 网关对象（origin-safe 守卫） | 保留在 index.ts（测试按 mainSource 断言） |
| 启动诊断/迁移 | ~1500–2050 | userData 迁移、resolveAppUserDataDir 决策、环境检测 | Wave 2 候选 |
| 飞书 IPC | 2066–2398（已删） | 17 个 feishu:* handler | ✅ Wave 1 → `src/main/ipc/feishuIpc.ts`（377 行，FeishuIpcDeps 注入） |
| 会话命令/运行时块 | ~2100 起 | sendAgentPromptWithIntegrations、会话 IPC、启动诊断队列 | Wave 3 候选 |
| registerIpc | ~4100+ | 其余 IPC 装配 + 域注册调用 | Wave 4 候选（拆 *Ipc.ts 域文件） |
| createWindow/生命周期 | 末段 | 窗口、托盘、单实例、quit | 保留 |

## Wave 1（已完成）：飞书域 IPC

- 新建 `src/main/ipc/feishuIpc.ts`：`registerFeishuIpc(deps: FeishuIpcDeps)`。
  - `feishuBridge` 可变单例改为 `feishuBridgeRef: { current }` 槽位共享（index.ts 退出清理 / setLocale / hasSessionBinding 统一改读写槽位）。
  - console.* 全部转 `getAppLogger()` 结构化日志（原文案信息保留在 data 字段）。
  - handler 逻辑零变化（含 feishuSessionBotSet 的 activateRuntime 自动启动链路）。
- index.ts 侧：`registerFeishuIpc({...deps})`、`quitCleanup.register("feishu-bridge", ...)` 改读 ref。
- 契约测试同步：`feishuConnectionSafety.test.mjs`（2 处 handler 断言改读新模块 + `feishuBridgeRef.current`/`deps.` 前缀）、`feishuSessionRuntimeBinding.test.mjs`（bind 块改读新模块；origin-safe 网关注入面统计跨 index+feishuIpc 两文件合计）、`portableUserData.test.mjs`（启动序正则接受 deps 对象形态）。52+40 全绿。

## Wave 2+（未做，按需启动）

1. 启动迁移/决策域（userData 更名迁移 + resolveAppUserDataDir 调用块）→ `main/startup/userDataStartup.ts`。
2. 会话命令块（sendAgentPromptWithIntegrations 及周边）→ 会话域已有模块或新 `main/sessions/` 文件。
3. registerIpc 内联域逐个外迁（同 feishuIpc 模式，deps 注入 + 契约测试改读）。
4. 模块级 console 收敛：剩余 ~40 处 console.*（排除 appLogger 尚未初始化的早期路径）转结构化日志。

## 门禁

- 每波次：`node node_modules/typescript/bin/tsc --noEmit`（或 `npm run typecheck`）零新增错误。
- 针对性测试：迁移域相关 `tests/*.test.mjs` 全绿 + `grep -rl "index.ts" tests/` 核对契约引用。
- 行数单调下降，最终目标 ≤400 行（装配态），硬红线 ≤600。
