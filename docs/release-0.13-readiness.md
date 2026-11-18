# 0.13 发布候选收尾

状态：`0.13.0-rc.1` 源码候选已准备，2026-11-18 复核；仍待发布门禁与安装包验收。审查基线为 `v0.12.0..5116bb2e4`，共 367 次提交、1,002 个变更文件；本轮在 `dev` 上完成修复。本文不代表已经发布。

## 实施边界

1. **RS-001 资源迁移**：原生写入、进度持久化、旧记录清理依次执行；只有无未解析条目且清理成功才记完成。重试不得把用户后来启用的原生资源再次禁用。兼容旧完成记录，项目迁移只拥有项目作用域。状态写失败保留旧输入并报告，下一次可重试。
2. **DR-001 草稿迁移**：只处理普通旧文件，在 drafts 内独占发布副本；同名冲突保留两份，复制后源删除失败可重入；源或目标是链接时保留。同秒新建草稿以 `wx` 和唯一后缀防覆盖。**EX-001** 停止按文件名硬删历史扩展，仅迁出与当前随包内容完全一致且已备份的普通文件；未知旧版、已下线无对照、用户修改与异常路径均保留。
3. **#534 托管进程**：仅在 Linux 本地 pi / ACP 启动入口注入实例 owner PID、启动 ticks 与作用域标记；后代继承此标记。启动扫描只处理同 uid、同作用域、owner 已确认死亡或 PID 复用的进程，杀前重验目标 ticks 和 owner；权限不足/读不全一律跳过。不接管旧版无标记进程、不在本机杀未知进程、不把标记扩成 pi 通信通道。
4. **#533 测试临时目录**：统一测试/E2E 自建目录的生命周期，保留 KEEP 诊断开关；不通配扫删既有用户临时目录。先迁移一组明确缺少清理的调用点，并机械核查剩余欠账。
5. **重试与历史 E2E**：成功重试卡退出时间线，进行中只留当前周期一张，失败保留次数与原因；恢复历史/编辑删除按现行会话所有权和 context_edit/fork 契约验证。删除已下线功能的过时测试，不用跳过有效用例换绿。

## 门禁

- 每个单元的行为回归，含冲突、失败重试、并发与安全边界。
- `npm run typecheck`、涉及文件 Biome、结构门禁、全量单测与 release preflight。
- 用当前源码定向构建后运行会话恢复、重试、历史状态矩阵、滚动和已有 smoke E2E。
- 保留他人工作树文件；本任务只暂存并提交明确归属的文件。不触发 tag、merge、正式发布或真实用户数据清理。

## 仍须安装包验收

Windows / macOS / Linux 从 0.12 升级、首次/第二次启动、已有会话续聊、凭据与飞书绑定；macOS 签名、公证、权限与自动更新；Linux 实际 `/proc` 进程回收。资源 native 写入与迁移进度文件之间仍有跨文件崩溃窗口；草稿发布要求文件系统支持硬链接，不支持时保留源并记录错误。真实机器证据完成前，不把候选状态写成正式可发布。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 最新源码通过 |
| `npx electron-vite build` | main / preload / renderer 定向构建通过；未跑含 sidecar/runtime 的全量 build |
| 迁移/进程/临时目录定向单测 | 51 通过、1 个文件 symlink 用例因 Windows EPERM 条件跳过；目录 junction 拒绝用例通过。随后项目清理/历史 policy/busy 组合 14/14 通过 |
| 重试、历史与滚动 Electron E2E | 21 项各自均有通过记录；组合首轮 20 通过、1 项窗口 setup 超时，单独复跑过程组 spec 4/4 通过 |
| CI 八 spec smoke + 有效 settle 滚动回归 | 14/14 通过；包含三条手动上滚/历史打开/启动 runtime 不重定位用例 |
| IPC / test-shape / file-size / package-json / hooks | 通过；本轮两个旧巨文件均未净增长 |
| 发布一致性泳道 | 12 项通过：版本、CHANGELOG、README、工作流选项、模型/扩展/提示词/技能清单、公告、提示词库、DSH payload、Electron 及 runtime 归档（按预检步骤计 12） |
| `npm run test:serial` | 17,561 项：17,227 通过、330 跳过、4 失败。完整日志 `.tmp/rc-test-serial.log`（忽略目录，仅本机证据） |
| 全工作区 `npm run preflight` | typecheck 与 release 泳道通过；unit-tests 与 format 泳道失败，详见下方；报告 `release-preflight/report-2026-11-17T15-05-29-289Z.json` |

本任务的 history 源码断言已同步到目标 session 的忙闲查询；fork 分支检查改为解析语法树，不再依赖 legacy 注释文字。针对性回归通过。

### 并行工作区的未收口门禁

本轮保留并行远程配置改动原样，以下失败不随本任务提交；不能把该工作区宣称为发布门禁全绿：

- `tests/mcpConfigUi.test.mjs`：仍假定 `rawFileName === "mcp.json"` 的旧 ConfigModal 结构。
- `tests/remoteSessionRootIsolation.test.mjs` 两项：冻结 helper 仍要求 1.29.0 和旧方法表，工作区已改到 1.30.0 并新增 `config.replace`。
- `tests/scrollContainerGuard.test.mjs`：`RemoteModelCatalogSection.tsx` 新容器未登记滚动边界。
- format：外部未跟踪的 `e2e/fixtures/git-scroll.tsx` 和 `e2e/git-scroll.spec.ts` 尚未格式化。本任务源码/测试格式检查通过。

发布前须在最终合入版本上重新获得完整 CI 证据，再完成三平台安装升级验收。本轮只准备并推送候选源码，不建 tag 或公开 Release。
