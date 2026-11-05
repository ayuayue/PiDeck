# 远程功能正式发布准备状态

> Status: **最终工作树本地门禁已全绿；真机签收待授权（2026-11-04）**。
> 基线：`dev` / `60ce6e4d9`。本文单独记录当前工作树的发布准备度；`docs/archive/remote/` 中的旧台账保留历史时点，不能替代本页证据。

## 1. 已开放的发布口径

- 远端能力不再绑定更新通道：stable 正式包与 dev 包都装配远端 IPC，并显示「设置 → 连接」与「添加远端项目」入口。
- `src/main/remote/remoteFeaturePolicy.ts` 的 `REMOTE_FEATURE_AVAILABLE` 是唯一发布策略源。
- 主进程通过现有 `update:get-channel` 下发 `remoteAvailable`；渲染层不再读取 `devBuild` 判断远端功能。
- 更新通道 `devBuild` 仍只描述构建身份，不承担功能门控。
- 各远端域继续保留 `enabled=false` 时的 `REMOTE_FEATURE_DISABLED` fail-closed 分支；开放策略不削弱输入校验、trust、pin、项目隔离、连接代或写面 unknown 语义。

## 2. 当前工作树本地门禁

| 门禁 | 结果 | 证据 |
|---|---|---|
| 远端发布策略与装配定向回归 | **PASS：109 tests / 109 pass / 0 fail / 0 skip** | `node --test tests/remoteChannelGate.test.mjs tests/remoteHostIpc.test.mjs tests/remoteProjectIpc.test.mjs tests/remoteProjectFileIpc.test.mjs tests/remoteProjectEntryIpc.test.mjs tests/remotePiModelWiring.test.mjs tests/remotePiConfigRouting.test.mjs tests/remoteSessionMessageMutationUi.test.mjs tests/remoteSessionAcceptanceSpecGuard.test.mjs` |
| `npm run typecheck` | **PASS：exit 0** | 本次闸门改造后运行 |
| `npm run check:ipc-wiring` | **PASS：843 channels / 8 agentEventTags** | 无重复，主进程与 preload 齐备 |
| `npm run check:test-shape` | **PASS：sourceOnly 396 / 1935；基线 397，新增 0** | 存量已减 1 |
| `npm run check:format` | **PASS：4498 files，No fixes applied** | 本次闸门改造后运行 |
| 三线远端定向测试汇总 | **PASS：1356 tests / 1328 pass / 0 fail / 28 skip / 0 cancelled / 0 todo** | 三个分支相对 `eca70c60d` 的测试文件并集，共 114 files；exit 0 |
| Cloud Sync OAuth 轮换定向回归 | **PASS：42 tests / 42 pass / 0 fail / 0 skip** | 覆盖 await 落盘后重启与并发轮换最后写入胜出 |
| `npm test` | **PASS：16386 tests / 16097 pass / 0 fail / 289 skip / 0 cancelled / 0 todo；exit 0** | 本次最终树重跑，duration 590693ms |
| Go `native/remote-sftp` | **PASS：`go test ./...` exit 0** | 本次闸门改造后运行 |

## 3. 历史真机证据（不等于当前最终树签收）

| 链路 | 历史结果 | 当前最终树 |
|---|---|---|
| 生产默认 root pooling | 2026-11-02 初次真机通过，2026-11-03 审计修复后复验通过；见 `remote-host-root-pooling-adr.md` §8 | **PASS（2026-11-05 复验）** |
| SFTP 上传/下载/进度/取消/A-B 隔离 | 2026-11-02 真实 SSH + Electron 核心链路通过；见 `remote-sftp-phase-1-plan.md` §11 | **PASS（2026-11-05 复验）** |
| Git 读取/写入/历史/ref diff/恢复 | 历史远端 Git 真机批次通过；见 `remote-wsl-verification-log.md` | **PASS（2026-11-05 复验，10/10）** |
| SFTP-2 普通目录新路径 | 离线实现与测试完成；见 `remote-sftp-phase-2-plan.md` | **NOT RUN**（未跑独立矩阵） |

历史证据证明相关链路曾经工作。2026-11-05 已在本工作树上重跑 root pooling / SFTP-1 / Git 三条主线（见 §4）；SFTP-2 的独立矩阵仍未跑，不能由目录读取用例外推。

## 4. 当前工作树真机验收

以下均需用户明确授权连接真实主机后才可执行。全部在 2026-11-05 于同一工作树（`dev`，`31a12cb02` 附近）对真实主机跑过：

| 验收项 | 当前状态 |
|---|---|
| root pooling 生产默认验收 | **PASS**：`e2e/remote-sftp-transfer.spec.ts`（含生产 root pooling 真机链路） |
| SFTP upload/download/progress/cancel/A-B 隔离 | **PASS**：同一 spec，A/B 隔离与取消均通过 |
| Git read/write/history/ref diff/恢复 | **PASS**：`e2e/remoteSessionAcceptance.spec.ts -g "远端 Git"` → 10 passed / 1 skipped / 0 failed |
| 文件目录读取与 SFTP-2 新路径 | 目录读取 **PASS**（文件管理 v1，含新建/改名/移动/删除/回收站还原/清空）；SFTP-2 独立矩阵 **NOT RUN** |
| 多项目 A/B/C 切换 | 双项目隔离 **PASS**（`e2e/remoteHostAcceptance.spec.ts`、Git neighbor 隔离）；三项目 A/B/C 未单独跑 |
| watch/search 回归 | **NOT RUN** |

### 4.1 2026-11-05 整轮真机结果

| 套件 | 结果 |
|---|---|
| `e2e/remoteHostAcceptance.spec.ts` | PASS（47.2 s） |
| `e2e/remote-sftp-transfer.spec.ts`（生产 root pooling + SFTP-1） | PASS |
| `e2e/remoteFunctionalAcceptance.spec.ts` | PASS（cancelMs=210、warmMs=3、bundles=4、scanMs=10782、entries=1533） |
| `e2e/remoteSessionAcceptance.spec.ts`（全部 16 例） | **PASS：15 passed / 1 skipped / 0 failed（16.5 min，exit 0）** |

会话套件覆盖：会话产品路（真实模型）、代码文件编辑、首次信任提示、终端、Git G1–G5e（含断开重连、仓库 scope、嵌套仓读写、恢复区）、文件管理 v1。跳过的 1 例是 G6b 真实 SSH 长稳 soak（需显式 opt-in）。

真机过程中的产品修复（同批提交）：Git 面板能力预热与重连不重放读、仓库选择器能力位归属、未知结果写仍刷新派生视图、根路径不可作为写操作操作数；E2E 侧修复：加主机等待预算与失败快路、文件管理远端状态断言改为有界轮询。

授权后使用 SSH 别名 `serve`（`10.81.2.15:22`，用户 `zhadainian`），测试根必须新建并隔离在
`/home/zhadainian/.pideck-acceptance/remote-integration-20261103`（若已存在则换唯一后缀），结束前校验绝对路径并清理本任务目录。不得 sudo，不得改动既有 deploy bundle，不得使用真实用户 home 作测试目录；Windows E2E 启动前清除 `ELECTRON_RUN_AS_NODE`。

## 5. 独立发布边界

以下项目不属于普通集成门禁，当前工作树全部 **NOT RUN**：

- 真实 10 分钟 TTL
- 第 7 root 的 30 秒等待、`SSH_ROOT_POOL_BUSY` 与释放恢复
- 多 host 六槽争用
- 小时级 soak 与网络抖动
- rebind UI
- Git 硬断网/崩溃恢复
- ProxyJump/askpass
- 8 GiB / 32 文件边界
- Linux 原生 Electron

单测、离线全绿或历史真机报告都不能把这些项目记成当前工作树通过。

## 6. 发布条件

1. 第 2 节全部门禁退出码 0，全量测试 0 fail。**已满足。**
2. 当前工作树经提交、CI 与打包产物核验；打包后 stable 包必须实际显示远端入口并注册远端 IPC。
3. 获授权执行第 4 节真机矩阵。**2026-11-05 已执行主线（见 §4.1）；仅 §5 独立发布边界与 SFTP-2 独立矩阵未跑。**
4. 取得用户明确授权后才执行 commit、push、PR 或远端合并。

**当前结论：代码已按正式发布口径开放远端能力；本地门禁全绿；真机主线矩阵（host / SFTP+root pooling / functional / 会话 16 例）2026-11-05 全过。剩余风险集中在 §5 独立发布边界（TTL、第 7 root、多 host、soak、硬断网、ProxyJump、8 GiB、Linux Electron）与 push/CI/PR 流程——这两块完成前不宣称最终发布认证。**
