# 0.13 发布候选检查

状态：**`0.13.0-rc.1` 源码候选通过本机检查，可以进入候选包验收；尚不具备正式发布签收证据。** 检查日期：2026-11-18。

## 基线与交付位置

- 审查范围：`v0.12.0..ffccabf1c`，368 次提交、1,036 个变更文件，再加本次收尾修复。版本变化覆盖会话与滚动、活动页 GTD、ACP、SSH 配置、资源迁移、进程生命周期及发布链路。
- 双层滚动首轮修复为 `5116bb2e4`，已在 `origin/dev` 历史中；本次补充正文流式切换后的跟随状态修复及候选检查。
- 最终检查在独立分支 `codex/release-0.13-rc1` 完成，worktree 为 `.tmp/rc-candidate-worktree`，基于 `ffccabf1c`。共享 `dev` 上仍有其它会话持续修改的 SSH/资源工作，本候选只复制明确归属的任务文件；新增 SSH 入参修复在隔离分支独立实现。
- 版本、双语 CHANGELOG、README 与官网亮点已对齐 `0.13.0-rc.1`。本轮交付源码提交与分支推送，未执行 merge、tag 或 Release。

## 发现与修复

| 领域 | 问题与最终行为 | 验证入口 |
| --- | --- | --- |
| 会话双层滚动 | 过程组、工具长输出与 diff 取消内部纵向限高，内容随会话自然增长；宽代码/diff 保留横向滚动。手动展开从标题开始阅读，长输出标题相对会话吸顶 | `process-fold-scroll`、`process-group-display`、`running-session-scroll` E2E |
| 正文流式会话切换 | 切换时用距底阈值保存阅读锚点、恢复后下一帧再按几何强制退出跟随，均把布局/动画滞后误当用户上滚。删除这两处推断，跟随状态统一由引擎输入/显式命令决定；上滚阅读仍保存稳定行、负偏移与窗口 | `timelineScrollAnchorFollow`、`sessionSendScroll` 单测；原失败场景连续 5 次 E2E 通过，断言未放宽 |
| SSH 配置 | 已提交的整文档保存缺少入口解析，合法请求被拒；补齐版本、patch/document 互斥、文档与凭据路径形状校验。模型目录去掉内部纵向滚动，160 模型用例验证滚轮移动配置外层 | `piConfigRouterWsl`、`remoteConfigDocument`、`remotePiConfigBackend`、`remoteConfigContract` 单测；`remote-config-editing` E2E |
| RS-001 资源迁移 | 逐条原生写入后持久化进度，再清理旧输入；只有无 unresolved 且清理成功才完成。重试不重放已经应用的禁用意图，项目清理共用 pi 配置锁；进度损坏时保留输入 | `piResourceMigration`、`piResourceMigrationRunner`、`piResourceMigrationProgress`、`projectResourceLegacyCleanup` |
| DR-001 / EX-001 | 草稿独占发布，冲突不覆盖，删除源失败可重试；同秒新建不截断。旧扩展只迁出已备份且与随包副本一致的普通文件，未知、修改内容和目录链接保留 | `scratchPadIpcBoundary`、`scratchPadMigration`、`legacyBuiltInExtensions` |
| Linux 进程 / 测试临时目录 | 本地 pi/ACP 后代继承实例 owner 标记；仅回收同 uid、同作用域且 owner 确认死亡的孤儿，杀前重验。测试只清理自己创建并登记的目录，保留 KEEP，不扫描旧目录 | `linuxOrphanSweep`、`tempDirCleanup`；Linux 真机待验收 |
| 重试与历史操作 | 成功重试卡退出时间线，当前周期一张，失败保留原因；assistant 编辑走 catalog/context_edit，user 编辑/resend 走 fork，忙闲状态按目标会话读取 | `agentManagerRetryStatusCards`、`turnSegments`、`sessionHistoryMutationPolicy`、`sessionPromptDispatchBusy`；历史/重试 E2E |

迁移细节、失败行为与退役条件见 [数据迁移台账](data-migrations.md)。

## 验证记录

本机日志与报告位于隔离 worktree 的 `.tmp/`、`release-preflight/`（均为忽略目录）；以下按实际验证阶段记录，完整单测之后新增的滚动修复使用相关模块回归，未将两批数字拼成一次最终全量运行。

| 验证 | 结果与证据 |
| --- | --- |
| 完整 `npm run preflight` | 四泳道全绿。单测 **17,563 项：17,233 通过、330 跳过、0 失败**，691.8s；typecheck、全仓格式与发布一致性通过。报告 `release-preflight/report-2026-11-17T17-05-53-199Z.json` |
| 滚动修复后的模块回归 | 时间线控制器相关 29 个测试文件 **273/273 通过**，另有 followState/restore/freshness 等组合 **61/61 通过**（两组覆盖重叠，不累加）。包括新增 6 项行为测试，日志 `.tmp/rc-scroll-controller-tests.log`、`.tmp/rc-scroll-unit.log` |
| 最后一次类型/格式/发布检查 | `npm run preflight -- --skip unit-tests` 全绿：typecheck 72.7s、全仓格式 3.8s、发布泳道 4.3s。报告 `release-preflight/report-2026-11-17T17-45-48-889Z.json` |
| 源码构建 | `npx electron-vite build` 的 main/preload/renderer 通过；滚动修复后 `npx electron-vite build --filter renderer` 通过。未执行含 Go sidecar/runtime 打包的全量 `npm run build` |
| Electron 集成回归 | 17 个 spec **40/40 通过**，5.2min；含双层滚动、运行中会话切换、历史恢复/编辑/删除/重发、预热、重试、Markdown、Git、设置、抽屉与启动 smoke。日志 `.tmp/rc-scroll-final-e2e.log` |
| 流式切换重复回归 | 原场景修复前 3 次有 2 次失败；修复后同一断言 **5/5 通过**。日志 `.tmp/rc-text-follow-repeat.log`、`.tmp/rc-scroll-follow-repeat.log` |
| 数据保护/进程/临时目录/配置/重试 | 最后一次 16 文件组合 **145 项：144 通过、1 个文件 symlink 因 Windows EPERM 条件跳过、0 失败**；目录 junction 拒绝通过。SSH 边界相关另有 31/31 通过；这些领域也包含在完整单测中。日志 `.tmp/rc-final-core-tests.log` |
| 结构与提交门禁 | IPC wiring、test-shape、file-size、package-json 与 hooks 检查通过；滚动修复后重跑 file-size/test-shape 通过，未增加源码文本断言；提交时仍执行 pre-commit |
| DSH 归档 | 隔离目录未复制 runtime tar，preflight 明确跳过该项；对原目录现有 `dist-runtime/dsh-runtime-win32-x64.tgz` 独立运行 `check-dsh-asar` 通过：runtime 0.2.1-rc.5、minApp 0.12.0、36,987 entries、513 packages。未重打包，不能代替候选安装包验证 |

首轮共享工作区全量单测的 4 个失败已收口：MCP 旧结构断言替换为真实 raw 保存/重载行为，helper pin 与封闭方法表对齐已提交的 1.30.0（保留 SHA 校验），SSH 模型目录消除内部滚动。共享工作区另有其它作者在途内容，因此不将它的格式/版本漂移混入隔离候选。历史 E2E 失败与结案口径见 [e2e 已知失败清单](e2e-known-failures.md)。

测试契约同步：删除已下线 settle 重定位的两条预期，保留手动上滚/历史打开/启动 runtime 不重定位覆盖；把依赖已删临时 ref 的源码断言替换成同一任务内切会话的锚点保存行为；恢复时几何不再拥有退出跟随权限，原“空操作引擎后退出跟随”测试改测延迟完成与真实引擎浏览上报。

## 正式 0.13 仍需完成

1. **最终分支整合与 CI**：本次核对的 `origin/dev` 为 `1217538fc`，相对候选基点还有四条独立提交：`87ac974bb` 技能规则、`b8d26e6f3` 侧栏分组、`d545da7d6` 工具标记标题、`1217538fc` superseded 会话复活/重复行（#571）。候选分支未擅自合并这些提交；正式发布须确定最终提交集合并在合入树重跑门禁。
2. **Windows/macOS/Linux 升级**：用测试用户或 VM 从 0.12 升级，验证首/二次启动、设置/项目/已有会话续聊、凭据与飞书绑定、资源启停、草稿与旧扩展保留。Linux 须实测 `/proc` 回收；macOS 须验 Developer ID、公证、权限继承、本地网络和自动更新。
3. **真实时间线与外部链路**：完成 [时间线五条手动验收](timeline-manual-qa.md)（大历史第一条、连续 20 页、停 30 秒、小会话、流式上翻）。Pi 1.5.1 仍有 [兼容账本](pi-compatibility.md) 中的真实会话待验项；SSH 配置本轮为隔离模拟 IPC 验收，没有连接真实主机。旧 [远端发布记录](remote-release-readiness.md) 是历史基线证据。
4. **现有未全验收范围**：未重跑所有历史 Electron spec，也未验收远端 TTL、多 host 争用、soak、硬断网、ProxyJump、大文件独立矩阵。不能用本轮 40 项定向通过覆盖这些范围。

资源 native 写入与进度文件之间仍有跨文件崩溃窗口；草稿独占发布需要硬链接支持，不支持时保留源并报错；扩展复核与删除之间保留普通文件系统 TOCTOU 限制。这些限制已有记录，候选升级验收应专门观察，不能宣称跨文件事务或所有历史数据形态已覆盖。
