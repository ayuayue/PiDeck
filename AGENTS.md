# AGENTS.md

PiDeck 的开发规则入口。每次会话注入，只放**铁律 + 路由**；细节按「改动前先读」到 `docs/` 取。
维护纪律：新增规则先问「是否每次会话都适用」——否则写进 docs 并在路由表加一行；每条规则必须可判定（触发条件 + 动作 + 验证方式）；失效引用当次删除。本文件上限 **120 行 / 8KB**。
本项目只维护根这一份 `AGENTS.md`，不在子目录生成规则文件；`~/.pi/agent/AGENTS.md` 的通用规则（中文、先读后改、最小改动、专用工具优先）仍然生效，冲突时以本文件为准；与代码实际类型/API 冲突时以代码为准。

## 项目

PiDeck 是 Electron 桌面应用：在多个项目目录间管理和运行 AI Agent——多项目工作区、会话时间线、历史恢复、文件抽屉、Git 面板、终端、内置浏览器、提示词/技能/扩展商店、宿主插件、打包发布。

- 栈：Electron + React 19 + TypeScript + Vite（版本以 `package.json` 为准）。
- 会话后端 `AgentBackend = pi | dsh | acp | imagegen | videogen`：pi 走 stdio JSON-RPC，DSH 是内置 host，ACP 是外部 CLI 的 stdio JSON-RPC，生图/生视频是 PiDeck 自有链路。后端矩阵见 `docs/architecture.md`。
- **pi 负责 Agent 行为、工具调用、会话读写、模型调用；PiDeck 负责窗口、进程生命周期、会话浏览、Git/终端/设置。** 两边只经既有通道通信，每条通道的用途与禁止项见 `docs/host-boundaries.md`。

## 命令

| 场景 | 命令 |
|------|------|
| 类型检查（每次改动后） | `npm run typecheck` |
| 针对性单测（日常必跑） | `node --test tests/<相关>.test.mjs` |
| 全量单测（仅跨域大改 / 合并前） | `npm test` |
| 单测串行（排查并发干扰） | `npm run test:serial` |
| 格式化 | `npm run format`（CI 用 `npm run check:format`） |
| 本地启动 | `npm run dev` |
| 构建 | 只跑改动涉及的子构建；**禁止全量 `npm run build`**（含 4 个 Go sidecar、packages/catalog/SDK、runtime 打包、vite），除非用户明确要求 |
| E2E（窗口默认屏幕外、不打扰；需要看窗口设 `PIDECK_E2E_WINDOW_MODE=visible`） | `npx playwright test e2e/<相关>.spec.ts` |

- **门禁**：合并前 `typecheck` + 改动涉及的针对性测试全绿；纯 UI 样式微调至少 typecheck。禁止「先合再修」。
- **退出码**：门禁命令禁止用管道吞 rc（`npm run typecheck | tail` 返回的是 tail 的 0）。用 `set -o pipefail` 或重定向后查 `$?`——测试经沙箱 TS 转译对语法错误容错，可能假绿。

## 铁律

1. **不加第二条 pi↔PiDeck 通道。** 六类宿主通道（认证、模型快照、standby 池、一次性补全、`/reload` 扩展、`pideck-cua` MCP）各只允许一种用途，**禁止扩成通用桥**；新增工具/通道先改 `docs/host-boundaries.md` 再改代码。
2. **不改写 pi 正在使用的会话文件。** 编辑/删除走 `context_edit`，重发用 `deleted` 墓碑；导入/迁移走专用写入路径，不直接改 pi 活着的 JSONL。
3. **新 IPC 三处同步**：`src/shared/ipc.ts` 通道常量 → `src/main/ipc/*Ipc.ts` handler → `src/preload/index.ts` 转发，漏一处运行时 undefined。
4. **`shared/` 是纯契约层**：只被依赖，不反向 import 任何运行时层；类型按域放 `shared/types/`，IPC 名只在 `shared/ipc.ts`。
5. **原生模块禁止顶层静态 import**（koffi / node-pty）：必须在专属模块内 `createRequire` 惰性加载 + try/catch 降级，否则跨 arch 打包后缺二进制启动即崩。
6. **破坏性动作先确认**：删除/覆盖用户数据、连接外部系统、merge、发布、部署，先说明影响并取得授权。数据迁移 / schema / 服务重启 / 公共契约变更先给实施计划。
7. **不自动提交**：只有用户明确说「提交 / commit / push」才执行 `git add`/`commit`/`push`；完成后总结并问一句。本项目规则覆盖全局 `~/.pi/agent/AGENTS.md` 的「自动提交并推送」默认。
8. **不破坏并行 agent 的未提交工作**：只 `git add <本任务文件>`；禁止 `add -A/.`、`restore`/`checkout --` 非本任务文件、`git clean`、`reset --hard`、`stash`；并行期间不 `npm install`、不杀不认识的进程。
9. **改任何 zh-CN 词典后必须重跑 `node scripts/genZhTwCopy.mjs`**：四份 `*.zh-TW.ts` 是生成物，禁止手改；JSX 不硬编码中英文。
10. **测试随需求和契约演进**：任务内可更新、替换或删除过时测试，无需仅因涉及旧测试另行确认；交付说明行为与覆盖变化，验证新契约并保留仍有效的回归/安全边界。禁止仅为消红而弱化断言、跳过有效用例或迁就错误实现。

## 改动方法

内化自 `unclebob/ub-mode`，只留铁律未覆盖且可判定的（取舍见 `docs/engineering-standards.md` §改动方法）：

- **先减后加**：动手前先找能删的复杂度；新增块与已有块结构相同（只差名字、字面量）时合并，不复制。
- **攻击前提**：同一前提下的两次修复挂在同一道门禁上，用一句话写下该前提、指出谁在承担不对称，然后删掉那段实现——不写第三次修复。
- **不焊新需求**：新需求与现有结构形状不符时，先问「它一开始就在我会建什么」，再分片交付。
- **造杠杆**：同一手工动作第二次，先手工做完一个单元，再让工具复现它。
- **可重入**：迁移、同步、热更新、落盘重跑一次或中途崩溃再跑，必须收敛到同一状态。

## 改动前先读（路由表）

| 改动涉及 | 先读 |
|---|---|
| `resources/*.mjs`、`resources/extensions/**`、`src/main/pi/**`、MCP host、spawn 侧车 | `docs/host-boundaries.md` |
| 窗口 / webview / preload / 打包 / 原生模块 / 跨平台路径 / git 子进程 / 终端（node-pty） | `docs/electron-playbook.md` |
| `src/main/index.ts`、`src/main/ipc/**`、`src/shared/**`、会话链路（`SessionRuntimeCoordinator`/`SessionScanner`）、renderer 组件逻辑与状态、新增领域模块、文件拆分 | `docs/architecture.md` |
| 写代码/写测试/补注释、改错误处理、动安全边界、改持久化/设置、i18n | `docs/engineering-standards.md` |
| CSS / Tailwind / shadcn / beUI / 布局 | `docs/ui-and-css.md` |
| Go sidecar、商店、搜索、会话存储、插件、公告、发版 | `docs/maintenance-domains.md`（先看顶部速查表） |
| 大文件域迁移 / 文件拆分 | `docs/main-index-split-plan.md`、`docs/app-tsx-split-plan.md`、`docs/agent-manager-split-plan.md`（方法见 `docs/architecture.md` §长期重构纪律） |
| pi 发新版 / 上游语义对齐 | `.pi/skills/pideck-pi-version-sync/`、`.pi/skills/pideck-upstream-parity-review/` |

## 协作

- **Issue 修复**：直接在当前开发分支（通常 `dev`）改，不为单个 issue 另拉分支；先定位根因再改，`fix:` 前缀关联 issue，PR 写 `Closes #<n>`、原因、修复摘要、验证命令。
- **多 agent 并行**：两个以上 agent 同时改 `src/` 优先各用 `git worktree`；否则按目录划 ownership，公共汇聚文件（`AGENTS.md`、`main/index.ts`、`shared/types/settings.ts`、i18n copy、`package*.json`）同一时刻只许一个写者。只读任务不受限。
- **收尾**：列出本任务产生的未提交文件与验证结果，停下等用户决定是否提交；不清理、不暂存、不评判他人的改动。
- **大重构**：先写对照计划（能力 parity 表 + 合并门禁）放 `docs/` 并注明状态；行为零变化，目标文件行数单调下降才算一个 wave。冲突禁止 `-X theirs` / `-X ours` 静默吞掉对方改动。
