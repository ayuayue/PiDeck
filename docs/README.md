# PiDeck 文档索引与治理规则

> 本文件是 `docs/` 的唯一入口。**只列现行文档与活动计划；历史文档在 [archive/](archive/README.md)。**
> 文档由历代 AI 会话与人工共同维护：**代码与测试是事实，文档是意图/契约/记录**。带 `Status:` 行的是可信度最高的；没有状态行的按本文分类为准。

## 1. 文档状态与规则

| 状态 | 含义 | 放哪 |
|---|---|---|
| **Current** | 现行契约/指南，改代码前先读 | `docs/` 根 |
| **Active plan** | 正在执行或待执行的任务书 | `docs/` 根 |
| **Historical** | 已交付/已过期的计划、交接、评审、调研 | `docs/archive/` |
| **Archive index** | 归档清单与旧路径映射 | [archive/README.md](archive/README.md) |

规则：

1. 新文档首行必须有 `Status:`（Current / Active plan / Historical）与最后更新日期；没有状态的文档默认视为 Historical。
2. **完成后**的计划：状态改为 Historical，移入 `docs/archive/<category>/`，并在 archive/README.md 登记旧路径。
3. 只有满足以下全部条件才可**删除**：已完成/已废弃、无代码/测试引用、无其他文档链接、内容已被现行文档覆盖。
4. 被 `src/`、`tests/`、`scripts/` 引用的文档**保留原路径**（改路径必须同步改引用），本文标注“代码引用”。
5. 不要再把“计划”写成“现状”；现状只写进 Current 文档。

## 2. 现行文档（Current）

| 文档 | 用途 |
|---|---|
| [architecture.md](architecture.md) | 分层与跨层契约（shared / main / ipc / preload / renderer） |
| [host-boundaries.md](host-boundaries.md) | pi ↔ PiDeck 通道边界与例外 |
| [engineering-standards.md](engineering-standards.md) | 代码/测试/安全/兼容标准 |
| [electron-playbook.md](electron-playbook.md) | 窗口、preload、打包、原生模块 |
| [ui-and-css.md](ui-and-css.md) | Tailwind / 组件 / 样式规范 |
| [maintenance-domains.md](maintenance-domains.md) | 领域维护手册（改到哪读哪） |
| [unified-api.md](unified-api.md) | `piDeckApi` 统一门面契约 |
| [pi-compatibility.md](pi-compatibility.md) | pi 版本兼容矩阵与上游差异 |
| [host-plugins.md](host-plugins.md) | 宿主插件机制 |
| [host-plugin-dev-guide.md](host-plugin-dev-guide.md) | 宿主插件开发指南 |
| [project-location-architecture.md](project-location-architecture.md) | 本地/SSH/WSL 位置模型 ADR（**Proposed**，未实现部分未定） |
| [remote-host-root-pooling-adr.md](remote-host-root-pooling-adr.md) | 同主机多 root 池化 ADR（测量 + 方案；默认关闭的池化路径已实现，真机验收未做） |
| [remote-wsl-verification-log.md](remote-wsl-verification-log.md) | SSH/WSL 功能收敛的验证证据（现行台账） |
| [remote-acceptance-55dd5b702.md](remote-acceptance-55dd5b702.md) | 检查点 55dd5b702 独立验收：四焦点复核、Linux 证据、真实 SSH 方案、旧文档同步 |
| [ci-linux-known-failures.md](ci-linux-known-failures.md) | Linux CI remote/SSH 清零记录、21 文件硬门禁与跟踪边界 |
| [process-group-implementation-contract.md](process-group-implementation-contract.md) | 过程组冻结契约（已实现） |
| [release-process.md](release-process.md) | 发版流程 |
| [release-test-shape-exceptions.md](release-test-shape-exceptions.md) | `check:test-shape` 基线例外 |
| [data-migrations.md](data-migrations.md) | 持久数据迁移索引 |
| [ai-assist.md](ai-assist.md) | AI issue/PR 协助工作流 |
| [dsh-remote-contract.md](dsh-remote-contract.md) | DSH Typert Remote 集成契约 |
| [dsh-0.2.0-migration.md](dsh-0.2.0-migration.md) | DSH 0.2.0 增量契约（与上文叠加） |
| [pideck-mcp.md](pideck-mcp.md) | PiDeck 本机 MCP 服务说明 |

## 3. 活动计划（Active plan）

| 文档 | 状态 |
|---|---|
| [ui-commercialization-plan.md](ui-commercialization-plan.md) | Wave 1–7 已落地；剩余项按文中标记 |
| [ui-unification-plan.md](ui-unification-plan.md) | wave 1 执行中 |
| [remote-file-tree-and-git-unification-plan.md](remote-file-tree-and-git-unification-plan.md) | T1–T9 分片已交付；当前事实/保留项见 §10.7/§10.8 |
| [project-panel-service-seam-adr.md](project-panel-service-seam-adr.md) | Phase A 已落地、A0 纯 stat 已修；S 契约已冻结（并行交接 §8.2），B 的 UI 迁移待 F/G |
| [remote-project-parallel-handoff.md](remote-project-parallel-handoff.md) | 远程多项目并行入口：A0/P/S/T 已整合（§8），S 契约冻结、F/G 可开工、V 未核验；含基线同步（§8.4）与可复制提示词 |
| [root-pooling-handoff.md](root-pooling-handoff.md) | 池化专用入口（已标 Historical）；P 已交付默认关闭的池化路径（离线测试通过，真机验收未做），开启=改 `main/index.ts` 构造参数 `rootPooling`（无设置项） |

## 4. 代码/测试引用与归档

本轮归档已把 `src/`、`tests/`、`scripts/`、`e2e/` 里指向历史文档的路径同步改到 `docs/archive/`，并在移动后校验了所有站内 Markdown 链接（仅余 3 条外部仓库链接：ZCode / deepseek-harness，不在本仓库）。

**两份保留在根的历史文档**（测试硬编码了路径，移动会破坏测试；已标 Historical）：

- [markdown-image-rendering-plan.md](markdown-image-rendering-plan.md)（`tests/localImageWhitelist.test.mjs` 读取）
- [virtualization-audit.md](virtualization-audit.md)（`tests/scrollContainerGuard.test.mjs` 读取）

如果以后要移动这两份，必须同时改测试路径；改完可一起归档。

## 5. 归档（Historical）

- 归档清单与旧路径映射：[archive/README.md](archive/README.md)
- 已删除（无引用、内容已覆盖）：`remote-merge-to-dev-plan.md`、`mcp-page-refresh-plan.md`

## 6. 关于“文档是怎么来的”

这些文档多数由历代 AI 会话按“读代码 → 写计划 → 执行 → 再写交接”的节奏生成，**计划/意图/现状常常混在一起**，且执行后没有回写状态。治理原则：

- 读文档先看 `Status:`；没有状态就当历史；
- 任何“已实现/已修复”必须有代码位置或验证记录；
- 新计划落文档前先查重，完成后必须归档，不再新增“一次性总结”。
