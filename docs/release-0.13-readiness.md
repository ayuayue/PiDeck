# 0.13 正式发布准备

状态：`0.13.0` 版本号、双语 CHANGELOG、README 与官网亮点已在 `dev` 上对齐，2026-11-18 复核；Windows 0.12 → 0.13 升级已在候选包上通过，macOS / Linux 安装升级与真实时间线矩阵仍未验收。审查基线 `v0.12.0..` 截至 2026-11-18 的 `dev`。本文不代表已经发布。

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

## Windows 0.12 → 0.13 候选包验收

- 官方基线来自 GitHub Release 的 `PiDeck-0.12.0-win.zip`（147,862,465 bytes，SHA256 `383898e4239af9fabb773b37d6afa56ae80ec9c439225673384143f9bd23eae1`）与 `PiDeck-0.12.0-setup.exe`（108,667,769 bytes，SHA256 `6c1e26ccb7e6ce4c0cee2408f1051589a7240b60a2ab51656b06c27c228e72e6`）。
- 首个候选包启动了旧共享 `node_modules` junction，树内 `.package-lock.json` 仍对应 0.12；`electron-builder` 因此只收集了不完整的生产闭包，依次暴露 `graceful-fs`、`brace-expansion`、`balanced-match` 和 `@aws-sdk/checksums/flexible-checksums` 缺失。把传递依赖提升为根依赖只能掩盖问题，已全部撤回。在隔离 worktree 按当前 `package-lock.json` 执行 `npm ci` 后，AWS、MCP、WebDAV、tar、`proper-lockfile` 与 `minimatch` 链路均由原依赖图正确进入 asar。
- 最终 `candidate-clean-final/win-unpacked` 通过真实 exe smoke：`app.asar` 为 74,801,066 bytes、5,446 entries、214 个运行时包根；上述启动链的关键包均在包内。此结论要求打包机器从当前 lockfile 干净安装，不能用主工作区的旧共享安装树制造候选包。
- `e2e/windows-upgrade.spec.ts` 在 Windows 真机 **1/1 通过**（1.4min）：官方 0.12 创建设置、项目、会话、草稿、快捷消息、飞书 Bot 与 DPAPI 密文；0.13 首启读取全部数据、保留会话原字节、续聊并启动 `node-pty`；二次启动继续保留。测试同时断言工具卡内部无可滚动 overflow，会话外层可上滚、出现回底按钮并恢复跟随。
- 实验入口只替换 `package.json.main` 并增加 lab bootstrap；原 `out/main/index.js` 与全部其他 payload 保持原字节，分别校验 4,416 / 4,417 个文件。lab 固定 `home`、`appData`、`userData`、`sessionData`、`temp`，屏蔽协议注册和开机项。它不是生产入口，不能替代正式安装包 smoke。`tests/windowsUpgradeLab.test.mjs` 锁定 payload 保真与嵌套输出拒绝。
- NSIS 覆盖安装使用专用 lab `appId=cc.debugtools.pideck.windows-upgrade-lab`，禁用协议、桌面和开始菜单快捷方式，在同目录从 0.12.0 静默升级到候选版本。安装目录 `app.asar` 从 `6ca31430…` 替换为 `e912f233…`，版本外数据标记保留，卸载登记只有一项，安装版主界面通过启动验证。
- Windows 候选 exe 与实验安装器均为 `NotSigned`；官方 0.12 zip 内 exe 与 setup 也是 `NotSigned`，与既有发布状态一致。正式发布仍须决定是否继续不带 Authenticode，不能把 lab 覆盖安装通过误写成已验代码签名。
- 证据目录 `.tmp/windows-upgrade-20261118/`（7.1G 解包产物与 profile 副本）在本次发版准备中清理以腾磁盘；本节保留事实与哈希，需要时用同一 spec 重建。

## 仍须完成

1. **macOS / Linux 升级**：Windows 已完成上述 0.12 升级矩阵。Linux 仍须实测 `/proc` 回收与安装包启动；macOS 须验 Developer ID、公证、权限继承、本地网络和自动更新。
2. **真实时间线与外部链路**：完成 [时间线五条手动验收](timeline-manual-qa.md)（大历史第一条、连续 20 页、停 30 秒、小会话、流式上翻）。Pi 1.6.0 仍有 [兼容账本](pi-compatibility.md) 中的真实会话待验项；SSH 配置为隔离模拟 IPC 验收，没有连接真实主机。旧 [远端发布记录](remote-release-readiness.md) 是历史基线证据。
3. **现有未全验收范围**：未重跑所有历史 Electron spec，也未验收远端 TTL、多 host 争用、soak、硬断网、ProxyJump、大文件独立矩阵。不能用定向通过覆盖这些范围。
4. **最终合入树的门禁与 CI**：`dev` 上跑完整的 `npm run preflight` 与发行构建产物（`out/`、`runtime:pack` 归档、目标平台安装包）后，再跑 `release-core` / `smoke` 核心 E2E 集。
5. **资源迁移与草稿的已知窗口**：资源 native 写入与迁移进度文件之间仍有跨文件崩溃窗口；草稿发布要求文件系统支持硬链接，不支持时保留源并记录错误。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 最新源码通过 |
| `npx electron-vite build` | main / preload / renderer 定向构建通过；未跑含 sidecar/runtime 的全量 build |
| 迁移/进程/临时目录定向单测 | 51 通过、1 个文件 symlink 用例因 Windows EPERM 条件跳过；目录 junction 拒绝用例通过。随后项目清理/历史 policy/busy 组合 14/14 通过 |
| 重试、历史与滚动 Electron E2E | 21 项各自均有通过记录；组合首轮 20 通过、1 项窗口 setup 超时，单独复跑过程组 spec 4/4 通过 |
| CI 八 spec smoke + 有效 settle 滚动回归 | 14/14 通过；包含三条手动上滚/历史打开/启动 runtime 不重定位用例 |
| IPC / test-shape / file-size / package-json / hooks | 通过；本轮两个旧巨文件均未净增长 |
| 发布一致性泳道 | 12 项通过：版本、CHANGELOG、README、工作流选项、模型/扩展/提示词/技能清单、公告、提示词库、DSH payload、Electron 及 runtime 归档 |
| `npm run test:serial`（候选分支） | 17,561 项：17,227 通过、330 跳过、4 失败；4 项随后全部收口（见下） |
| 2026-11-18 全量 `npm run preflight`（`dev`） | **四泳道全绿**：typecheck 149.3s、全量单测 889.3s（rc=0）、format 10.7s、发布一致性 20.8s；报告 `release-preflight/report-2026-11-18T15-51-06-081Z.json` |
| Windows 升级 lab 定向测试 | `tests/windowsUpgradeLab.test.mjs` 2/2 通过；两个工具提交落到 `dev` 后 typecheck / file-size / test-shape / format 均 rc=0 |

本任务的 history 源码断言已同步到目标 session 的忙闲查询；fork 分支检查改为解析语法树，不再依赖 legacy 注释文字。针对性回归通过。

### 候选期并行工作区的未收口项（已收口）

候选分支上曾有三条失败与一处格式漂移来自并行远程配置工作区：`tests/mcpConfigUi.test.mjs`、`tests/remoteSessionRootIsolation.test.mjs`（两项）、`tests/scrollContainerGuard.test.mjs`。2026-11-18 的 `dev` 全量 preflight 已全部通过（含 `RemoteModelCatalogSection.tsx` 滚动边界登记），格式泳道同时转绿，因此不再作为发版阻塞项。

发布前须在最终合入版本上重新获得完整 CI 证据，再完成 macOS / Linux 安装升级验收。本轮只准备并推送正式版源码，不建 tag 或公开 Release。
