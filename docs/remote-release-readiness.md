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
| 生产默认 root pooling | 2026-11-02 初次真机通过，2026-11-03 审计修复后复验通过；见 `remote-host-root-pooling-adr.md` §8 | **NOT RUN** |
| SFTP 上传/下载/进度/取消/A-B 隔离 | 2026-11-02 真实 SSH + Electron 核心链路通过；见 `remote-sftp-phase-1-plan.md` §11 | **NOT RUN** |
| Git 读取/写入/历史/ref diff/恢复 | 历史远端 Git 真机批次通过；见 `remote-wsl-verification-log.md` | **NOT RUN** |
| SFTP-2 普通目录新路径 | 离线实现与测试完成；见 `remote-sftp-phase-2-plan.md` | **NOT RUN** |

历史证据证明相关链路曾经工作，但不能外推到本次 74 文件集成工作树或本次通道开放改动。

## 4. 当前工作树真机验收

以下均需用户明确授权连接真实主机后才可执行：

| 验收项 | 当前状态 |
|---|---|
| root pooling 生产默认验收 | **NOT RUN** |
| SFTP upload/download/progress/cancel/A-B 隔离 | **NOT RUN** |
| Git read/write/history/ref diff/恢复 | **NOT RUN** |
| 文件目录读取与 SFTP-2 新路径 | **NOT RUN** |
| 多项目 A/B/C 切换 | **NOT RUN** |
| watch/search 回归 | **NOT RUN** |

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
3. 获授权执行第 4 节真机矩阵；或由发布负责人书面接受未跑项并缩小发布口径。
4. 取得用户明确授权后才执行 commit、push、PR 或远端合并。

**当前结论：代码已按正式发布口径开放远端能力，最终工作树本地门禁已全绿；真机矩阵尚未签收，因此仍不能宣称 Remote v1 已完成最终发布认证。**
