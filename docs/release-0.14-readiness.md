# 0.14.0 发版准备

状态：`0.14.0` 版本号、双语 CHANGELOG、README 与 docs-site 亮点已在 `dev` 上对齐，2026-11-23 复核；发版核心 E2E 与四泳道 preflight 在最终树上通过。本文不代表已经发布（未建 tag、未公开 Release）。

## 本版范围

审查基线 `v0.13.2..` 截至 2026-11-23 的 `dev`（48 个提交）。主线是**远端工作区可用化**：文本读写走 SFTP 并做「版本一致才替换」的上传提交、会话历史在远端就地维护（去掉整文件往返的 256 KiB 上界）、远端设置与 MCP 复用本地表单；并行修掉 Windows 沙箱 `0xC0000142`（#591 / #582）与 WSL 会话列表卡死（#588），Markdown 预览支持目录锚点跳转。

## 门禁证据（2026-11-23）

| 验证 | 结果 |
| --- | --- |
| `npm run preflight`（四泳道） | typecheck 70.9s ✓、全量单测 629.6s ✓、format ✓、release 一致性 6.5s ✓；报告 `release-preflight/report-2026-11-23T10-44-17-867Z.json`（format 泳道随后对 10 个文件跑 `biome format --write` 转绿，重跑 `--only typecheck,format,release` 全绿） |
| 发版核心 E2E（`docs/release-process.md` 的核心集） | 11/11 通过（1.5min）：`release-core`（pi mock CLI / ACP 真 stdio / DSH 真 host + 离线 runtime 导入）各首发+续发，另有 `smoke`、`session-bootstrap-tabs`、`git-panel`、`settings`、`drawer`、`file-tree-dom-budget` |
| 构建产物 | `npm run build:fast` 用当前源码重建 `out/`；`dist-runtime/dsh-runtime-win32-x64.tgz`（147 MB）与 linux-x64（28 MB）在库 |
| 发布一致性 | 版本/CHANGELOG/README 徽章与最新版行一致（0 提醒）；workflow tag 下拉 5 处已同步；README 亮点、docs-site/changelog 由 `sync-release-notes --apply` 生成 |

## 本版同时收口的开发树红灯（均为测试侧陈旧断言，非产品缺陷）

1. `tests/windowsUpgradeLab.test.mjs` — Node 24 起 `cp(dir → 已存在目录)` 在 `errorOnExist` 下直接 `EEXIST`：改为逐子项复制（目标目录仍由 `recursive:false` 守「必须是新目录」）。
2. `tests/wslHelperDeploy.test.mjs`、`tests/remoteHelperSearchContent.test.mjs`、`tests/remoteConfigContract.test.mjs` — 冻结 helper 清单新增 `session-maintain.mjs`，三处硬编码清单未跟上。
3. `tests/remoteHelperEntry.test.mjs` — `session.maintain` 只在 Linux 主机公布（依赖 `/proc/self/fd` 改名），Windows 上 hello 本来就不该报它；断言改成按平台取期望能力集。
4. `tests/remoteProjectHostIdentity.test.mjs` — 云朵角标的 `doesNotMatch(/bg-sidebar/)` 被组件自身解释「旧做法垫过 `bg-sidebar` 圆盘」的注释误伤，收窄到真实 `className`。
5. `tests/remoteProjectTextTransfer.test.mjs` — 「替换保留原文件模式」只在 POSIX 可验（Windows `stat` 无权限位，恒 `0o666`）。
6. `tests/gitPanelRefreshStability.test.mjs`、`tests/remoteGitPanelCapabilityGate.test.mjs`、`tests/dshManualStopWiring.test.mjs`、`tests/autoInstallBundledSkills.test.mjs` — 源码形态/文件位置变化后的契约断言更新（总数改用 `countLoader`、错误文案改走 `const text = remoteGitErrorText(...)`、原因集合已拆到 `sessionMessagePage.ts`、路由表里的 `references/<那一份>` 是占位符而非路径）。

## 仍须人工完成（机器不能判）

1. **安装包 smoke**：`npm run dist:win`（或 `pack`）产物装一次，覆盖启动、SSH 远端会话首发/续发、WSL 模式的会话列表、Markdown 预览目录跳转。
2. **macOS / Linux**：签名、公证、权限继承、本地网络、自动更新与安装升级（沿用 `docs/release-process.md` 的签名与 smoke 清单）。
3. **真实外部链路**：真实供应商联网/认证、真实 SSH 主机、真实 WSL 发行版——本版 core E2E 全部用隔离配置，不证明这些链路可用。
4. **时间线手动验收**：`docs/timeline-manual-qa.md` 五条动作（本版未改时间线，仍建议过一遍）。
