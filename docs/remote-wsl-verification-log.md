# SSH/WSL 功能收敛 — 远端验证记录（WS4）

> **Status: Current（2026-10-31 核对；以代码与测试为准）**


> 滚动验证记录：**每节自带时点/HEAD**；最新一轮见 §10–§14。初版记录于 2026-10-30（分支 `feat/ws4-verify`，基线 `46523b525`）。
> 本文件只记录证据，不改产品代码；**跳过 / 未运行 = 未验证，绝不算通过**。
> 安全口径：主机名 / 用户名 / 指纹 / 私钥一律不写入本文件，也不打印到终端；凭据只在 PowerShell 进程内以 `$env:PIDECK_E2E_REMOTE_*` 形式存在。

## 0. 记录口径

- 门禁命令禁止用管道吞退出码，统一写成：`$o = & npm run xxx 2>&1; $rc = $LASTEXITCODE; $o | Select-Object -Last 20; "EXIT=$rc"`。
- 所有远端 E2E 都用同一个包装脚本 `%TEMP%\pideck-ws4-remote.ps1`（派生凭据 → 清环境变量 → 跑 Playwright → 输出脱敏日志），**脚本在 `%TEMP%`，不入库、不含任何凭据值**。
- 真实 Electron（`out/main/index.js`）+ 真实主机；跳过与未运行分开记，都不进通过统计。

## 1. 环境前提（跑 E2E 前必须做）

| # | 前提 | 说明 |
|---|------|------|
| 1 | **清除 `ELECTRON_RUN_AS_NODE`** | 在「Electron 宿主里的 agent 会话」中直接跑 Playwright 会失败：`electron.launch: Process failed to launch!` + `electron.exe: bad option: --remote-debugging-port=0`。根因是宿主进程环境带 `ELECTRON_RUN_AS_NODE=1`，`electron.exe` 退化成纯 Node，拒绝 Chromium 开关。**跑前必须同一进程 `Remove-Item Env:ELECTRON_RUN_AS_NODE`**（本记录的统一包装脚本已处理）。这是宿主环境特性，不是产品缺陷；普通终端 / CI 无此变量。 |
| 2 | 先把 `out/main/index.js` 构建出来 | E2E 直接启动未打包产物；本轮用 `npx electron-vite build`（**仅测试准备**，不是 `npm run build`，不打包、不发布）。 |
| 3 | 凭据只走进程环境变量 | `PIDECK_E2E_REMOTE_HOST/USER/PORT/FINGERPRINT`；缺任意一个，spec 在 fixture setup 前整体 skip（不会启动 Electron），此时结论必须记「未验证」而不是「通过」。 |

## 2. 远端环境事实（不含主机名 / 用户 / 指纹）

| 项 | 事实 |
|----|------|
| 连通方式 | 本机 SSH 配置别名 `serve` 可免密（BatchMode）登录；该别名配了 ProxyJump，故**本机直接 `ssh-keyscan` 不可用**，指纹从 `~/.ssh/known_hosts` 取并与「经跳板在远端本机 `ssh-keyscan 127.0.0.1`」交叉核对一致 |
| 系统 | Linux |
| 远端 `git` | ✅ 存在 |
| 远端 `node` | PATH 上默认是 **v12.22.9**（旧），nvm 另有 **v24.11.0** |
| 远端 `pi` | **不在默认 PATH**，只存在于 nvm 目录（`~/.nvm/versions/node/v24.11.0/bin/pi`）；`~/.pi` 存在 |
| 产品侧解析 | ✅ 产品自动解析到 nvm 里的 pi（第 5 节 smoke 的主进程日志 `Pi process exit` 显示启动的是 nvm 路径的 pi），不需要人工改远端 PATH |
| 主机密钥算法 | 产品强制 `HostKeyAlgorithms=ssh-ed25519`；取到的 ED25519 指纹与产品落盘 pin 一致（smoke 断言通过即为证） |

派生命令（值不打印）：`ssh -G serve` → `ssh-keygen -F <host-key> -f ~/.ssh/known_hosts` → `ssh-keygen -lf -`（必要时经跳板 `ssh serve 'ssh-keyscan -t ed25519 -p 22 127.0.0.1'`）→ 直连连通性 `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -p <port> <user>@<host> 'echo DIRECT_OK'`（exit 0）。

## 3. 基线提交对应关系（区分"修复前 / 修复后"）

| 角色 | 提交 | 说明 |
|------|------|------|
| **本轮 smoke 实际运行的代码** | `46523b525` | `feat/ws4-verify` 的基点；`dev` 合入 WS1 之前，**不含任何 P0 修复** |
| Lead 通报的 dev（含 WS1 P0-1 + 装配） | `50b4f7dc3` | 仅记录，未在本分支运行 |
| 写本记录时只读查看的 dev HEAD | `a5b833b39` | `fix(remote): 装配文件写后 Git status 失效`（P0-2 已并入）；dev 仍在前进，集成以合并点为准 |
| **集成 run #1（WS1 全部 + WS2 全部 + i18n 重生成）** | dev `8b1178bce` → 本地 merge 提交 `7a74adc66` | 详见 §9；同一批命令重跑，逐项对比"修复前 / 修复后" |
| **集成 run #2（最终：WS1 全部 + WS2 ×6 + WS3 全部 + i18n 重生成）** | dev `3ac0e14e4` → 本地 merge 提交 `afd5ec3a4` | 最终证据，详见 §9.5 |

> 读法：第 5 节的 3 条 smoke 结论只代表 `46523b525`。WS1 的 P0-2/P0-3/P0-4 合并后再跑同一批 `--grep`，才能得出"修复后"结论；两轮记录放在一起即可对比。

## 4. 本地基线门禁（`feat/ws4-verify` @ `46523b525`）

| 命令 | 退出码 | 结论 | 备注 |
|------|--------|------|------|
| `npm run typecheck` | 0 | 通过 | 与 Lead 已跑结果一致 |
| `npm run check:ipc-wiring` | 0 | 通过 | 795 个 ipcChannels 齐备、agentEventTags 8、无重复 |
| `npm run check:test-shape` | 0 | 通过 | sourceOnly 407 / 1762 个测试文件（基线 407，新增 0） |
| `npm run check:format` | 0 | 通过 | 4116 文件、无差异 |
| `npx electron-vite build`（**仅 E2E 测试准备**） | 0 | 通过 | 59.44s，产物仅 `out/`（入库忽略）；未跑 `npm run build` / `preflight` / `pack` |

## 5. 远端 E2E 用例清单与状态（`e2e/remoteSessionAcceptance.spec.ts`）

`npx playwright test e2e/remoteSessionAcceptance.spec.ts --list` ⇒ **16 tests in 1 file**（exit 0）。
远端 E2E 合计 18 条：本 spec 16 条 + `remoteHostAcceptance.spec.ts` 1 条（基线补跑结果见 5.2）+ `remoteFunctionalAcceptance.spec.ts` 1 条（**未验证：本轮不做，原因＝远端写操作风险**——该 spec 会临时挪动远端 deploy 根下的 bundle，不在 P0/P1 验收范围内；集成阶段如需覆盖另开任务）。

| # | 用例（行号） | 命令（除第 1 列外均经统一包装脚本） | 退出码 | 时长 | 结论 |
|---|--------------|--------------------------------------|--------|------|------|
| 1 | 远端会话产品路：新建 → 发 prompt 出正文 → 关闭 Agent → 重开历史仍在（324） | `npx playwright test e2e/remoteSessionAcceptance.spec.ts --grep "远端会话产品路"` | 1 | 6.1m | **baseline-fail / 待复跑区分**（失败点见 5.1；前 12 个 step 已通过） |
| 2 | 远端代码文件：UI 编辑保存 → 外部冲突保留草稿 → 双项目隔离 → Agent 真实运行测试（661） | 同形（`--grep`） | — | — | 未验证（未运行） |
| 3 | 远端 Git G1：只读 SCM 与差异 → 双项目隔离 → 断开不重连 → Git 字节不变（723） | `--grep "远端 Git G1"` | 0 | 1.3m | **通过** |
| 4 | 远端 Git G2a/G2b：精确暂存取消 → 提交已确认暂存区 → 拒绝面 → unborn 与工作区不变（751） | 同上 | — | — | 未验证（未运行） |
| 5 | 远端 Git G3a：只读历史分页与详情 → 引用 → 两版本差异 → 仓库字节不变（780） | 同上 | — | — | 未验证（未运行） |
| 6 | 远端 Git G3b：新建分支 → 切换 → 工作区冲突拒绝不丢文件 → 只多一个 ref（805） | 同上 | — | — | 未验证（未运行） |
| 7 | 远端 Git G4a：丢弃工作区改动 → 删除未跟踪文件 → 先备份后可恢复（830） | 同上 | — | — | 未验证（未运行） |
| 8 | 远端 Git G4b：丢弃留快照 → 恢复区列出 → 一键还原字节一致（855） | 同上 | — | — | 未验证（未运行） |
| 9 | 远端 Git G5a：获取更新远端跟踪引用 → 拉取快进 → 脏工作区拒绝 → 推送（880） | 同上 | — | — | 未验证（未运行） |
| 10 | 远端 Git G5b：引用对比与原生 diff 一致 → 逐文件两侧内容 → 轮询策略（905） | 同上 | — | — | 未验证（未运行） |
| 11 | 远端 Git G5c：非仓库根显式初始化 → 原生 .git 出现 → 初始化入口消失（932） | 同上 | — | — | 未验证（未运行） |
| 12 | 远端文件管理 v1：新建空项目 → 新建/改名/移动/删除+回收站还原/清空（959） | 同上 | — | — | 未验证（未运行） |
| 13 | 远端 Git G5d/G5e：仓库发现与 scope → 嵌套读取匹配原生 → 嵌套写控件（993） | 同上 | — | — | 未验证（未运行） |
| 14 | G6b opt-in real SSH soak：真实 SSH 长稳 → 连接中断恢复不重放（1023） | 需显式 opt-in 开关 | — | — | 未验证（opt-in，未运行） |
| 15 | 远端终端：项目隔离 → 已保存代码测试 → resize → 关闭/断开/退出清理（1050） | 同上 | — | — | 未验证（未运行） |
| 16 | 远端会话的 trust 提示（远端项目资源未加载）在 runtime 起来后可见（1096） | `--grep "远端会话的 trust 提示"` | 0 | 1.0m | **通过** |

**统计：2 通过 / 1 失败 / 13 未验证（跳过=未验证）。**

### 5.1 基线失败（baseline-fail / 待复跑区分）：#1 产品路

> 定性：该 run 在 `46523b525`（早于全部 P0 修复），**不归因于本轮任何改动**，也不在本轮修复。
> 处置：合并 `dev` 后重跑同一条 `--grep`；仍失败则由 Lead 作为**独立缺陷**写进最终汇报（handoff 规则：不顺手修无关缺陷，只记录）。

- **失败 step**：`远端并发冲突：上传期间外部追加必须保留，UI 提示重载且不自动覆盖`（`e2e/remote-history-mutations.ts:92`，由 spec:616 调用）。
- **失败摘要**：`expect(locator).toBeVisible() failed` → `getByText(/远端会话文件已被其他程序修改/)` 在 240s 内未出现（`element(s) not found`）。
- **同一步已通过的断言**：注入本身成功（`injected[0].stdout` 含 `REMOTE_WRITE_CONFLICT_INJECTED`），即「上传期间外部追加」确实发生了。
- **主进程日志（唯一相关一条，已脱敏）**：
  ```json
  {"level":"warn","scope":"session-command","message":"Session command failed (SESSION_COMMAND_FAILED)",
   "detail":{"code":"SESSION_COMMAND_FAILED","debugDetails":"SSH_HOST_COMMAND_TIMEOUT",
             "operation":"editCatalogMessage","messageId":"_viewer-history-7d32f397"}}
  ```
  ⇒ 该次保存走的是**远端命令超时**分支（`src/main/remote/SshClientRuntime.ts:121`），不是冲突分支；UI 文案 key `sessionCommand.remoteFileChanged` 本身存在。
- **失败前已通过的 step（同一条用例内，按 spec 顺序）**：项目目录前置 → 加主机 + 落盘 pin 命中 → 连接 ready → 登记远端项目 → 新建会话 → **发 prompt 出正文且回合结束** → 远端模型目录拉取 → 运行中拒绝归档 → 「关闭 Agent」回到可启动 → 关标签页重开历史仍在（含远端会话文件行数佐证）→ 「从磁盘重新加载消息」历史仍在 → 远端归档/恢复（文件 sha256 不变）→ Fork 换绑且原文件字节不变。
- **复现命令**：
  ```powershell
  & "$env:TEMP\pideck-ws4-remote.ps1" -Grep "远端会话产品路"
  ```
- **判定建议**：可能是「192KiB 大块改写 + CAS 校验」在这条链路上超过远端命令超时（超时后提示走 unknown 分支），也可能是冲突检测真的没命中。**本轮只记录、不修**；WS1 合并后重跑同一 `--grep` 可区分「修复前/修复后」，再由 Lead 决定是否单开缺陷。
- **证据留存**：Playwright `test-results/...`（含 trace / screenshot / error-context，均在本地、不入库）；主进程日志副本 `%TEMP%\p42-app-logs-<runId>\`。

### 5.2 另一条远端 spec 的基线补跑：`remoteHostAcceptance`（同为 baseline-fail，但成因是**既有 spec 过时**）

> 后续状态：这一版「旧选择器」问题已由 W4 在本轮（v-final）修掉；本轮同一 spec 先暴露产品缺陷（rootStatus 信封形状），又由 task-12 修复并真机验证 —— 见 §11.5。本节保留为**上一轮（ws4）历史证据**。

| 项 | 内容 |
|----|------|
| 命令 | `& "$env:TEMP\pideck-ws4-remote.ps1" -Spec "e2e/remoteHostAcceptance.spec.ts" -Grep "远端主机功能级验收"` |
| 退出码 / 时长 | 1 / 39.9s |
| 结论 | **失败（baseline-fail；既有 e2e 选择器过时，不是产品缺陷）** |
| 失败点 | 「设置页加主机：ssh config 候选中挑出目标 user@host…」——`e2e/remoteHostAcceptance.spec.ts:171` |
| 失败摘要 | `locator.click: Timeout 30000ms exceeded`，等不到 `.settings-modal` 内 `getByRole("button", { name: "添加", exact: true })` |
| 成因判定 | 设置页「连接」页签的入口按钮现在用的是 `settings.connections.new` =「新建连接」（`src/renderer/src/components/app/settings/ConnectionsTab.tsx:283`）；这条旧 spec 仍用精确名「添加」。较新的 `remoteSessionAcceptance.spec.ts:203` 已改成 `/^(添加|新建连接)$/` 兼容两种文案，所以同一操作在那边能通过。 |
| 处置 | 按 handoff 规则**不顺手修无关缺陷、不改既有断言**，只记录；该 spec 其余 12 步（连接 ready、双项目、会话列表/标题/导入、项目级 root 状态）**未验证**。 |

## 6. 未覆盖 / 风险

- 16 条远端会话用例只跑了 3 条；13 条**未验证**。另有 `remoteHostAcceptance`（已跑、失败，成因是旧 spec 选择器过时，见 5.2）与 `remoteFunctionalAcceptance`（**未验证：本轮不做，原因＝远端写操作风险**，见 §5 清单说明；集成阶段如需覆盖另开任务）。历史通过结论不适用于当前基线。
- `#1 产品路` 记为 **baseline-fail / 待复跑区分**：其中"新建→发送→出正文→关闭→重开历史"这条主链路已验证通过，失败只发生在后续的「并发冲突提示」子步骤；该结论属 `46523b525` 基线，不归因于 WS1/WS2/WS3 的改动。
- 本轮基线**不含** P0-1～P0-4 与 P1 任何修复，因此通过项只证明「存量主路径可用」，不证明缺口已修。
- WSL 侧（`Ubuntu-26.04`）无实机证据；macOS 无本机证据，不声称已验证。
- 全量远端 E2E 连续串跑未执行；全量 `npm test` 按分工留到集成阶段（Lead 统一跑）。

## 7. 复跑方法（不落凭据）

```powershell
# 只验证凭据派生链路（不打印任何值）
& "$env:TEMP\pideck-ws4-remote.ps1" -ProbeOnly     # 期望：ENV_READY host=True user=True port=True fp=True
# 跑单条用例
& "$env:TEMP\pideck-ws4-remote.ps1" -Grep "远端 Git G1"
```

包装脚本做的事：`ssh -G serve` 取 host/user/port → `ssh-keygen -F`（必要时经跳板 `ssh-keyscan`）取 ED25519 指纹 → 写入当前进程环境变量 → `Remove-Item Env:ELECTRON_RUN_AS_NODE` → `npx playwright test e2e/remoteSessionAcceptance.spec.ts --grep <pattern>` → 输出脱敏日志（脱敏后落到 `%TEMP%`，不入库）。

## 8. 更新记录

- 2026-10-30（`46523b525`）：建立本记录。本地 5 项基线门禁全绿；远端 smoke 3 条 → 2 通过（Git G1、trust 提示）/ 1 失败（产品路的并发冲突子步骤，定性 baseline-fail / 待复跑区分）/ 13 未验证；定位并规避 `ELECTRON_RUN_AS_NODE` 环境坑。
- 2026-10-30（`46523b525`，补跑）：`remoteHostAcceptance` 基线跑 → 失败，成因为旧 spec 选择器过时（`添加` vs 现行「新建连接」），非产品缺陷；已记入 5.2，未改任何断言。
- 2026-10-30（决策）：`remoteFunctionalAcceptance` **本轮不做**（原因＝远端写操作风险：会临时挪动远端 deploy 根下 bundle，且不在 P0/P1 验收范围），记为「未验证」；`remoteHostAcceptance` 保持"既有 spec 选择器过时"记录、不改断言、不修，集成阶段如需该覆盖另开任务。
- 2026-10-30（决策/集成 run #1）：dev `8b1178bce` 已合入本分支（merge `7a74adc66`）。全量单测 15006/14721/0/285 全绿；远端 trust 与产品路通过，Git G1 因「旧断言 vs P0-3 静默轮询」冲突失败，裁定不改断言、等 WS1 follow-up 合并后复跑（详见 §9）。
- 2026-10-30（集成 run #2 / 最终 HEAD）：dev `3ac0e14e4` 合入（merge `afd5ec3a4`）。G1 复跑通过、产品路第二次通过、四项门禁与 8 个定向测试文件全绿；全量 `npm test` 在 ws4 因交叉 npm 安装极慢被我提前 kill（**不是死锁**，定性更正见 §9.5），改由 Lead 在主工作树复跑 ⇒ **EXIT=0，15019/14734/0/285，641s**；最终证据汇总见 §9.6。

## 9. 集成 run #1（dev `8b1178bce` 合并后）

**合并**：`feat/ws4-verify` ← `dev`，无冲突，merge 提交 `7a74adc66`（56 文件 / +3834 −303）；构建 `npx electron-vite build`（仅 E2E 准备）。

### 9.1 门禁与全量单测

| 命令 | 退出码 | 结果 | 备注 |
|------|--------|------|------|
| `git merge dev` | 0 | 无冲突 | dev HEAD `8b1178bce`（WS1 ×5 + WS2 全部 + i18n 重生成） |
| `npx electron-vite build` | 0 | 58.34s | 仅 `out/`，未跑 `npm run build` / `pack` |
| `npm test`（`node --test --test-concurrency=4`） | **0** | **tests 15006 / pass 14721 / fail 0 / skipped 285**，496s | 交接基线为 14928 / 14643 / 0 / 285；新增 78 条全部通过 |
| `npm run typecheck` | 0 | 通过 | |
| `npm run check:ipc-wiring` | 0 | 795 通道齐备、agentEventTags 8 | |
| `npm run check:test-shape` | 0 | sourceOnly 407 / 1773 文件，新增 0 | |
| `npm run check:format` | 0 | 4143 文件无差异 | |

### 9.2 远端 E2E 复跑（与基线逐条对比）

| 用例 | 基线 `46523b525` | 集成 run #1（`7a74adc66`） | 结论 |
|------|-------------------|------------------------------|------|
| 远端 trust 提示 | 1 passed (1.0m) | **1 passed (1.1m)** | 稳定通过 |
| 远端会话产品路 | **1 failed (6.1m)**（并发冲突子步，baseline-fail） | **1 passed (3.4m)** | 基线失败**未再复现**；单次通过不足以断言"已修复"（基线那次伴随 `SSH_HOST_COMMAND_TIMEOUT`，更像时序/超时偶发），最终复跑再取一次证据 |
| 远端 Git G1 | 1 passed (1.3m) | **1 failed**（断言 vs P0-3 语义冲突） | 见 9.3；**post-merge-fail（断言 vs P0-3 语义冲突）→ 修复待合并** |

### 9.3 Git G1 失败：旧断言「重连不重放一次读」与 P0-3 静默轮询冲突（**不改断言**）

- 失败位置：`e2e/remote-git.ts:192`
  `await expect(panel.getByTestId("remote-git-workingTree")).toHaveCount(0); // explicit reconnect alone never replays a read`
- 实测：`Expected 0 / Received 1`，10 秒内 23 次采样都解析到 1 个元素（稳定出现，非偶发）。
- 机制：该处 Git 面板仍可见、host 已 ready，WS1 P0-3 的 5 秒静默 status 轮询（`src/renderer/src/utils/remoteGitStatusPolling.ts:32` 的闸门 `pageVisible && hostReady && !mutating && !loading && !diffLoading`）把 status 读回来了，工作树区块随之渲染；而 P0-3 验收条款本身要求"面板可见、host ready、非变更中时每 5 秒静默刷新 status"。
- **裁决（Lead）**：**不改 e2e 断言**；由 WS1 追加产品侧 follow-up —— `invalidateConnection()` 后**暂停** 5 秒静默 status 轮询，直到一次成功的显式 refresh 才恢复。这样「断线/重连后不自动读」与「点刷新后恢复轮询」两条同时成立。
- 处置：等 follow-up 合入 dev 后 `git merge dev` → `npx electron-vite build` → 复跑 G1（期望 pass）+ 产品路，结果补进本节。
- 复现：`& "$env:TEMP\pideck-ws4-remote.ps1" -Grep "远端 Git G1"`

### 9.4 风险与口径

- 全量 `npm test` 与远端 E2E 本次并行执行（16 核，4 并发单测 + 单条 Electron E2E），E2E 计时可能偏慢；G1 的失败与计时无关（断言冲突）。
- 「产品路基线失败 → 集成通过」目前只有 1 次 post-merge 证据，不写成"已修复"。
- 本轮仍未跑：其余 13 条远端会话用例、`remoteFunctionalAcceptance`（本轮不做）。
- 最终复跑前需再 merge 一次 dev（Lead 通报已到 `68117b2a3`：WS2 最后一个提交 + WS3 task-6 + i18n 重生成）。

### 9.5 最终 run #2（HEAD `afd5ec3a4`）：全部通过；全量 `npm test` 在 ws4 因交叉 npm 安装**极慢**被提前 kill，改由主工作树复跑取证

**合并**：`feat/ws4-verify` ← `dev 3ac0e14e4`（WS1 全部 + WS2 ×6 + WS3 全部 + 每次合并后 i18n 重生成），merge 提交 `afd5ec3a4`，无冲突（16 文件 / +409 −30）。

| 项 | 命令 | 退出码 | 结果 |
|----|------|--------|------|
| 构建 | `npx electron-vite build`（仅 E2E 准备） | 0 | 2m28s（与全量单测并行，故偏慢） |
| 远端 Git G1 | `--grep "远端 Git G1"` | **0** | **1 passed (1.7m)** —— WS1「连接失效后暂停静默 status 轮询」follow-up 生效：`e2e/remote-git.ts:192` 旧断言原样通过，**断言未改** |
| 远端产品路 | `--grep "远端会话产品路"` | **0** | **1 passed (3.2m)**（第二次 post-merge 证据） |
| typecheck | `npm run typecheck` | 0 | 通过 |
| ipc 接线 | `npm run check:ipc-wiring` | 0 | 795 通道齐备、agentEventTags 8 |
| 测试形状 | `npm run check:test-shape` | 0 | sourceOnly 407 / **1775** 文件，新增 0 |
| 格式 | `npm run check:format` | 0 | **4148** 文件无差异 |
| 定向单测 | `node --test` 8 个文件：`remoteGitStatusPolling` / `remoteGitViewState` / `remoteGitRefsPolling` / `remoteGitFactsInvalidation` / `remoteGitReadIpc` / `remoteGitCapabilityNotesUi` / `remoteWorktreeEntryGate` / `sshLauncherOutput` | 0 | **95 passed / 0 failed**（2.7s） |
| 全量单测 | `npm test`（`node --test --test-concurrency=4`） | **0** | **tests 15019 / pass 14734 / fail 0 / skipped 285，641s**（在**主工作树** `F:\PiDeck` @ `3ac0e14e4` 跑出，见下） |

**交叉 npm install 极慢取证（ws4 环境；两次被我提前 kill；定性已由"hang"更正为"慢"）**

| 项 | 内容 |
|----|------|
| 首次（集成 run #2） | 16:48:42 启动，输出停在 **16:58:09**（log 6281 行）；此后采样窗口内无新增（PowerShell 重定向按块刷，输出滞后），我在约 20 分钟无新增后 kill，属**提前终止** |
| 进程链 | `npm-cli.js test`(27320) → `node --test --test-concurrency=4`(20036) → 测试文件子进程(26864) → `node scripts/pack-dsh-runtime.mjs --dry-run --target-os win32 --target-arch x64`(7004) → `npm install --os win32 --cpu x64 --ignore-scripts --omit=dev --cache <node_modules/.cache/dsh-cross-npm>`(38952) |
| 采样到的事实（当时据此误判为 hang） | 采样窗口内该 `npm install`：**20s CPU 增量 0**、**采样瞬间无 TCP 连接**、npm debug 日志 **0 字节**（文件已建、内容为空）、缓存目录最后写入 17:02:25 后无变化 |
| **更正（Lead 复跑实测）** | 同一步在**主工作树**（同一物理 cache）上采样到 **CPU 53.9s / 工作集 1071MB**，随后**正常完成** ⇒ 不是进程死锁，而是**交叉安装 ~200MB 的下载/解包极慢**；本次全量 641s 中占大头。`npm view` 同 cache 1.2s 可通、无 lock 文件、`_cacache/tmp` 为空，也支持"慢"而非"死锁" |
| 第二次（单独取证） | `node --test tests/packDshRuntimeCross.test.mjs`（串行、不并发）17:04:46 启动 → 其子 `pack-dsh-runtime --dry-run` 于 17:04:48 起；17:07:02 的 npm install 采样同样 0 CPU 增量 / 无 TCP / debug 日志 0 字节，**17:08 被我 kill（同样属提前终止，不是死锁证据）** |
| 触发测试 | `tests/packDshRuntimeCross.test.mjs` → `scripts/pack-dsh-runtime.mjs:426` `execFileSync("npm", ["install", ... "--cache", node_modules/.cache/dsh-cross-npm], { stdio: "inherit", shell: true })`：真实联网/缓存解析交叉平台依赖。**既有测试，与 WS1/WS2/WS3 改动无关**（run #1 同测试通过） |
| 加剧因素 | `F:\PiDeck-ws4\node_modules` 是指向 `F:\PiDeck\node_modules` 的 junction ⇒ 两个工作树的 `node_modules/.cache/dsh-cross-npm` 是**同一个物理缓存**；两边的交叉 install 会互相拖慢（本次 ws4 与主工作树的全量确实同时在跑这一步） |
| 定性（更正后） | **交叉 npm install 极慢**（~200MB 下载/解包），前两次被提前 kill，**非进程死锁**；不是产品缺陷、不是断言问题。共享 cache（junction）会让两个工作树互相拖慢，但这是加剧因素、不是根因 |
| 处置与最终取证 | 按 Lead 分工 kill 本 worktree 两条进程树（只 kill 自己启动的 pid），**不重试第三次**，**不改这条测试、不加超时跳过**；改由 Lead 在**主工作树 `F:\PiDeck`（HEAD `3ac0e14e4`，真实 node_modules）复跑全量** ⇒ **EXIT=0，tests 15019 / pass 14734 / fail 0 / skipped 285，641s** |
| 复现 | `node --test tests/packDshRuntimeCross.test.mjs`（ws4；串行无并发也会慢，需把交叉安装的下载/解包时间算进去，别按"无输出=卡死"判） |

> 取证时的旁证：同机还存在一条**非本任务**的 `node --test tests/remoteGitStatusPolling.test.mjs`（16:07:05 起，pid 19044/12204）与多条历史 `dsh-cross-*` 临时目录（09 个，共约 0.96GB），均未被我清理或 kill。

### 9.6 最终证据汇总（HEAD `afd5ec3a4` = merge dev `3ac0e14e4`）

| 证据 | 结果 | 运行位置 / 备注 |
|------|------|-----------------|
| 全量单测 `npm test` | **EXIT=0；tests 15019 / pass 14734 / fail 0 / skipped 285；641s** | 主工作树 `F:\PiDeck` @ `3ac0e14e4`（真实 node_modules） |
| 远端 Git G1 | **1 passed (1.7m)**，rc 0 | ws4；WS1「连接失效后暂停静默轮询」follow-up 生效，`e2e/remote-git.ts:192` 旧断言未改即通过 |
| 远端会话产品路 | **1 passed (3.2m)**，rc 0 | ws4；post-merge 第 2 次证据 |
| 远端会话 trust 提示 | 1 passed (1.1m)，rc 0 | ws4（run #1，同代码路径未变） |
| 构建 `npx electron-vite build`（仅 E2E 准备） | 0（2m28s） | ws4 |
| 门禁四项 | typecheck 0 / check:ipc-wiring 0（795 通道）/ check:test-shape 0（sourceOnly 407、1775 文件、新增 0）/ check:format 0（4148 文件） | ws4 |
| 定向单测（8 文件） | 95 passed / 0 failed（2.7s） | ws4 |

**结论口径**

- 合并 HEAD（WS1 全部 + WS2 ×6 + WS3 全部 + i18n 重生成）上：全量单测绿、四项门禁绿、定向单测绿；远端 G1（含 follow-up 语义）与产品路均通过。
- 产品路：基线 `46523b525` fail → post-merge **2/2 通过**；按 Lead 口径记为「基线失败疑似 SSH 命令超时时序偶发，未定位根因」，不写"已修复"。
- **未验证项（绝不当通过）**：其余 13 条远端会话用例；`remoteFunctionalAcceptance`（本轮不做，远端写操作风险）；`remoteHostAcceptance`（既有 spec 选择器过时，`添加` vs 现行「新建连接」，不改断言、不修）。
- 全量单测的 ws4 侧两轮因交叉 npm 安装极慢被**提前 kill**（非死锁），最终由主工作树取证；取证结论见 §9.5。

---

## 10. 收尾轮（第二轮 · 基线 dev `3e87123da`）

> 工作树 `F:\PiDeck-v`（分支 `feat/v-final`，基线 = `dev` `3e87123da`）；旧 `F:\PiDeck-ws4` / `feat/ws4-verify` 冻结不再使用。
> 凭据派生与 E2E 包装脚本：`%TEMP%\pideck-v-remote.ps1`（`ssh -G serve` + `known_hosts`/`ssh-keyscan` 取 ED25519 指纹，值只在进程内、不打印不落库；跑前 `Remove-Item Env:ELECTRON_RUN_AS_NODE`）。
> 与 `w4-remote-debt` 约定：**同一时刻只有一条 Electron 远端用例**，按对方的「W4 开始 / W4 结束」消息错开。

### 10.1 构建与 WSL 只读 smoke

| 项 | 命令 | 退出码 | 结果 |
|----|------|--------|------|
| 构建（仅 E2E 准备） | `npx electron-vite build` | 0 | 1m7s；产物仅 `out/`（入库忽略），未跑 `npm run build`/`pack` |
| WSL 配置只读 smoke | `node tests/wslConfigReadSmoke.mjs` | **0** | 用**真实** `WslPiConfigStore`（`createWslPiConfigStoreFor`：WslHostStore 档案 + `resolveWslEnvironment`）读 `Ubuntu-26.04` 发行版 HOME 的 `.pi/agent`：`models.json` **不存在 → 返回空 providers 且不创建文件**；`settings.json` 存在（6 个键）。两个文件 sha256 **读前 = 读后**（settings 前缀 `d16a1b8…`；models `absent→absent`），**未调用任何 save\***，未写用户真实配置 |

> 说明：该 smoke 用临时 userData 里的 `wsl-hosts.json`（schemaVersion 1 + 单个档案：`Ubuntu-26.04` + 发行版当前用户）驱动，脚本在 `tests/wslConfigReadSmoke.mjs`（不是 `*.test.mjs`，不进 `npm test` glob），输出里不含用户名/绝对路径。

### 10.2 远端 E2E：当前 dev 上**从未跑过**的用例（逐条，串行）

| # | 用例（`e2e/remoteSessionAcceptance.spec.ts`，除 G6b opt-in soak 外全跑） | `--grep` | 退出码 | 时长 | 结果 |
|---|--------------------------------------------------|--------|--------|------|------|
| 1 | 远端 Git G1：只读 SCM 与差异 → 双项目读隔离 → 断开不重连（对照，上一轮已验） | `远端 Git G1` | 0 | 64s | **pass** |
| 2 | 远端 Git G2a/G2b：精确暂存取消 → 提交已确认暂存区 → 拒绝面 | `远端 Git G2a/G2b` | 0 | 76s | **pass** |
| 3 | 远端 Git G3a：只读历史分页与详情 → 引用 → 两版本差异 | `远端 Git G3a` | 0 | 34s | **pass** |
| 4 | 远端 Git G3b：新建分支 → 切换 → 工作区冲突拒绝 | `远端 Git G3b` | 0 | 35s | **pass** |
| 5 | 远端 Git G4a：丢弃工作区改动 → 删除未跟踪文件 → 先备份可恢复 | `远端 Git G4a` | 0 | 34s | **pass** |
| 6 | 远端 Git G4b：丢弃留快照 → 恢复区 → 一键还原字节一致 | `远端 Git G4b` | 0 | 35s | **pass** |
| 7 | 远端 Git G5a：获取更新远端跟踪引用 → 拉取快进 → 脏工作区拒绝 → 推送 | `远端 Git G5a` | 0 | 42s | **pass** |
| 8 | 远端 Git G5b：引用对比与原生 diff 一致 → 逐文件两侧内容 → 轮询策略 | `远端 Git G5b` | 0 | 85s | **pass** |
| 9 | 远端 Git G5c：非仓库根显式初始化 → 原生 `.git` 出现 | `远端 Git G5c` | 0 | 28s | **pass** |
| 10 | 远端 Git G5d/G5e：仓库发现与 scope → 嵌套读取匹配原生 → 嵌套写 | `远端 Git G5d/G5e` | 0 | 36s | **pass** |
| 11 | 远端文件管理 v1：新建/改名/移动/删除+回收站还原/清空 | `远端文件管理 v1` | 0 | 54s | **pass** |
| 12 | 远端代码文件：UI 编辑保存 → 外部冲突保留草稿 → 双项目隔离 → Agent 真实运行测试 | `远端代码文件` | **1** | 93s | **fail（待分类，见 10.3）** |
| 13 | 远端终端：项目隔离 → 已保存代码测试 → resize → 关闭/断开/退出清理 | `远端终端` | 0 | 143s | **pass** |
| 14 | 远端 trust 提示（对照，上一轮已验） | `远端会话的 trust 提示` | 0 | 62s | **pass** |
| 15 | 远端会话产品路（对照，上一轮已验） | `远端会话产品路` | 0 | 187s | **pass** |

> 串行执行（同一时刻只有一条 Electron 用例，与 `w4-remote-debt` 按「开始/结束」消息错开），15 条合计约 **16.8 分钟**；`G6b opt-in soak` 按设计不跑（未验证）。

### 10.3 失败项定性：远端代码文件编辑（`e2e/remoteSessionAcceptance.spec.ts:661`）

| 项 | 内容 |
|----|------|
| 现象 | 退出码 1，93s；错误来自**测试自己的 ssh oracle**，不是产品断言：`ssh -o BatchMode=yes … cat -- '<projectPath>/calc.cjs'` 命令失败（远端项目目录里该文件不存在/不可读） |
| 已有信息 | 失败前 UI 步骤（加主机 pin/连接 ready/登记项目/打开远端文件编辑器）未报断言错误；同一 run 的 app 日志里只有一条已知无害告警 `reply-actions seed write failed` |
| 当前定性 | **待分类**：可能是测试基础设施（oracle 路径/时序），也可能是产品远端写路径问题；**本轮不改产品代码**，需单跑复现后再判 |
| 复现计划 | W4 用完 Electron 后单跑 `--grep "远端代码文件"` 一次；若复现，再拉 trace 定位是哪一步的 `cat`（`e2e/remote-file-editing.ts:104`/`133`） |

### 10.4 WSL 发行版停/启 smoke（Lead 批准的 WSL 生命周期操作）

脚本 `tests/wslConfigLifecycleSmoke.mjs`（非 `*.test.mjs`，不进 `npm test`）；两次独立运行结论一致。

| 步骤 | 观测 | 结论 |
|------|------|------|
| 运行中读配置 | `kind=ok`，6 个键，**121–133ms** | 基线可用 |
| 显式 `wsl --terminate Ubuntu-26.04` | 退出码 0，**36–39ms**；状态 Stopped | 停发行版本身很快 |
| 显式重启 `wsl -d … -e true` | **2935ms**；状态回到 Running | 冷启动约 3s |
| 重启后读配置 | `kind=ok`，6 键，**125ms** | 恢复可用 |
| **停态下直接读配置** | `kind=ok`，6 键，**2626ms**；读完后状态由 Stopped 变 Running（`autoStartedByRead=true`） | **没有回稳定码**：访问 `\\wsl.localhost\<distro>\` 的 UNC 路径会把发行版**自动拉起**，2.6s 内成功返回；既没挂死（≤15s），也没静默回退到 Windows HOME |
| 收尾 | `stateFinal=Running` | 不留停止态 |

> 与 Lead 预期的差异：原计划期望「停发行版后 15s 内回稳定码」，实测是「WSL 自动拉起后成功」。二者都满足"不挂死、不回退 Windows HOME"，但语义不同：稳定码路径在这台机器上**不会**因为 `--terminate` 触发（只有发行版缺失/改名时才会）。**未改产品代码**，是否符合预期请 Lead 判定；若要"停态必须回稳定码"，那属于需求变更。

### 10.5 与 `w4-remote-debt` 的时段协调

双方约定「同一时刻只有一条 Electron 远端用例」，按「W4 开始 / W4 结束」消息错开：本轮 sweep（15 条，16.8 分钟）在收到对方「W4 结束」后启动，跑完立即通知对方「可插空」；对方的 `remoteHostAcceptance` 复跑与产品路 3 连跑由对方独占。失败项复跑安排在对方结束后。

### 10.6 远端内容搜索（W2 helper 1.25.0）覆盖待办

`grep searchContent e2e/` ⇒ **0 处**：现有 e2e 没有 `files.searchContent` / 远端内容搜索入口。等 Lead 通知 dev 已合并（W2 渲染层最后一环）后，按新实现选一条路径补最小证据（真实产品路径优先；若 e2e 无入口，则用真实主机 + 旧 helper 回退/新 helper 命中的只读探针），不新增产品代码。

---

## 11. 收尾轮最终验证（merge dev `30d5eca36` 后）

### 11.1 合并、构建与门禁

| 项 | 命令 | 退出码 | 结果 |
|----|------|--------|------|
| 合并 | `git merge dev`（dev `30d5eca36`：W1 + W2 + W3 + W4 全部 + i18n） | 0 | 本地 merge 提交 `2c4b35e51`，无冲突 |
| 构建 | `npx electron-vite build`（仅 E2E 准备） | 0 | 1m1s |
| 类型 | `npm run typecheck` | 0 | 通过 |
| IPC 接线 | `npm run check:ipc-wiring` | 0 | 795 通道、agentEventTags 8 |
| 测试形状 | `npm run check:test-shape` | 0 | sourceOnly 407 / **1787** 文件，新增 0 |
| 格式 | `npm run check:format` | 0 | **4175** 文件无差异 |

### 11.2 全量单测：`fail 2`（两条**源码形状守卫**，非行为回归；Lead 已派 W2 结构性修复）

`npm test`（`node --test --test-concurrency=4`）⇒ **tests 15093 / pass 14806 / fail 2 / skipped 285 / 437s**；`node --test` 失败即非零退出。
复现：`node --test tests/remoteDragMove.test.mjs tests/remoteProjectUpload.test.mjs` ⇒ **RC=1，tests 23 / pass 21 / fail 2**（确定性）。

| 失败 | 断言 | 实测 | 定性 |
|------|------|------|------|
| `tests/remoteDragMove.test.mjs:70` | `RemoteProjectPanel.tsx` 行数 ≤ 440 | **467 行**（本轮合并 +27） | 重构行数预算守卫；Lead 决定：抽出内容搜索分区组件（不篡改断言） |
| `tests/remoteProjectUpload.test.mjs:301` | `REMOTE_UPLOAD_TEMP_NAME.test(` 在 `remoteProjectIpc.ts` + `remoteProjectReadIpc.ts` 里**恰好 2 处** | **3 处** | 源码形状计数守卫（多一处过滤更严，不是漏过滤）；Lead 决定：把用户可见条目判据抽到被计数文件之外的共享模块（不篡改断言）。**2026-10-31 注：55dd5b702 已把列表过滤移到 `remoteProjectDirFacts.ts:123`，当前守卫读 projectIpc+dirFacts+readIpc 三文件；本行为当时历史记录。** |

> 处置口径：等 W2 提交合入 dev 后，本轮只需 `git merge dev` → **复跑全量 npm test + 这两个守卫文件 + 「远端文件管理」E2E（54s）**；其余 E2E 结果沿用（结构性改动、行为不变）。
>
> **后续（`f31b0104f` 复跑结果）**：两个守卫文件已恢复（23/23），但 W2 的拆分**又打破第三处形状守卫** `tests/remoteProjectEntryState.test.mjs:60`（行菜单锚点搬到新文件）——见 §11.8；定性同为「形状锚点被结构拆分打破」，非行为回归。

### 11.3 远端 E2E 最终 sweep（HEAD `2c4b35e51`，串行）

| # | 用例（`e2e/remoteSessionAcceptance.spec.ts`） | 退出码 | 时长 | 结果 |
|---|--------------------------------------------|--------|------|------|
| 1 | 远端 Git G1：只读 SCM 与差异 → 双项目读隔离 → 断开不重连 | 0 | 66s | **pass** |
| 2 | 远端 Git G2a/G2b：精确暂存取消 → 提交已确认暂存区 | 0 | 79s | **pass** |
| 3 | 远端 Git G3a：历史分页与详情 → 引用 → 两版本差异 | 0 | 37s | **pass** |
| 4 | 远端 Git G3b：新建分支 → 切换 → 冲突拒绝 | 0 | 37s | **pass** |
| 5 | 远端 Git G4a：丢弃改动 → 删除未跟踪文件 → 备份可恢复 | 0 | 34s | **pass** |
| 6 | 远端 Git G4b：丢弃留快照 → 恢复区 → 一键还原 | 0 | 32s | **pass** |
| 7 | 远端 Git G5a：获取/拉取/脏工作区拒绝/推送 | 0 | 37s | **pass** |
| 8 | 远端 Git G5b：引用对比 → 逐文件两侧 → 轮询策略 | 0 | 82s | **pass** |
| 9 | 远端 Git G5c：非仓库根显式初始化 | 0 | 29s | **pass** |
| 10 | 远端 Git G5d/G5e：仓库发现与 scope → 嵌套读写 | 0 | 37s | **pass** |
| 11 | 远端文件管理 v1：新建/改名/移动/删除+回收站/清空 | 0 | 55s | **pass**（并在最终 HEAD `f31b0104f` 复跑 **55.4s pass**，验证面板拆分未破坏抽屉） |
| 12 | 远端代码文件编辑（UI 保存→冲突草稿→双项目→Agent 运行） | **1** | 142s | fail（当时记「未验证」）→ **task-13 已修，最终 HEAD 上 1 passed (2.1m)**，见 §11.4 / §11.11 |
| 13 | 远端终端：项目隔离 → 保存代码测试 → resize → 清理 | 0 | 130s | **pass** |
| 14 | 远端会话 trust 提示 | 0 | 61s | **pass** |
| 15 | 远端会话产品路（新建→发 prompt→正文→关闭 Agent→重开历史） | 0 | 188s | **pass** |

> 串行（同一时刻只有一条 Electron），15 条合计约 **17.4 分钟**；`G6b opt-in soak` 按设计不跑（未验证）。
> **另**：`e2e/remoteHostAcceptance.spec.ts`（W4 修正版）在 `2c4b35e51` 上跑到「项目级 root 状态」失败（4.6m，见 11.5），**不是**本表这 15 条之一。
> **HEAD 说明**：本表 15 条跑在 `2c4b35e51`（W2 结构修复之前）；条 12 已在最终 HEAD `aa14565ef`（= dev `183193254`，e2e-only 增量）复跑为 pass；「全量 npm test」「两个守卫文件」「远端文件管理」E2E 分别在 `53ecfaac4` / `f31b0104f` 上复跑（结构改动、行为不变，其余结果沿用）。

### 11.4 「远端代码文件编辑」：既有 e2e 测试债 → **已修（task-13），最终 HEAD 上 pass**

**修复前（两个失败点，都在用例侧）**

| 次 | 失败点 | 证据 | 定性 |
|----|--------|------|------|
| 基线跑（1.24.0 build） | 测试自带 oracle：`ssh … cat -- '<project>/calc.cjs'` 命令失败（`runRemoteCommand` 抛出的子进程错误，**message 里没有 stderr**） | 远端项目目录里该文件不存在/不可读 | oracle 侧失败，未复现 |
| 最终 build 复跑 | `e2e/remoteSessionAcceptance.spec.ts:690` `.header-drawer-toggle` 30s 未见 | **截图显示抽屉已打开、右侧编辑器正常显示已保存的 `value: 2`**；抽屉打开时该 toggle 不再渲染 | **既有 spec 与当前 UI 交互契约不一致（测试债）** |

**修复（W4 task-13，e2e-only）**

- 抽屉二次 toggle 的过期交互改成「点『关闭右侧边栏』→ 断言 toggle 回到会话 Tab 栏」；
- oracle **不改语义**，只在失败路径补现场诊断（`ls -la` + `stat` 后原样 rethrow），下次可区分「文件不存在」与「SSH 失败」；
- W4 侧连续 2 次 **1 passed (2.2m)**。

**最终 HEAD 独立复跑（本 verifier）**

- HEAD `aa14565ef`（= dev `183193254`，相对 `bb9ab2d55` **只多 e2e 两个文件**，产品代码零变化；`out/` 仍是 `bb9ab2d55` 的构建）；
- `--grep "远端代码文件"` → **1 passed (2.1m)，exit 0**。
- 附注：oracle 那次失败（1.24.0 build）在 1.25.0 + 当前 HEAD 上未复现。

### 11.5 `remoteHostAcceptance`：修复前确定性 2/2 失败 → **根因已确认并修复（task-12，真机 1 passed 56.6s，待合入）**

**修复前证据（本 verifier，两个数据点）**

- 退出码 1，4.6m；前置步骤（加主机 pin/连接 ready/登记两项目/会话列表/惰性标题/导入/**重复导入**）全部通过 —— W4 的定位符与 Op 信封修正**有效**。
- 失败断言：`e2e/remoteHostAcceptance.spec.ts:327` —— 让项目 A 根目录漂移后再刷新，侧栏项目行必须出现 `remote-project-needs-attention`（标题含 `SSH_PROJECT_ROOT_(UNRESOLVED|CHANGED)`）；实测 **240s 内未出现**（`element(s) not found`）。
- 第二数据点（`f31b0104f` 复跑）同一断言再次失败（4.6m，**确定性 2/2**，不是偶发）。截图证据：侧栏 `proj-a-…` 仍显示 `serve ●`、**无「需处理」badge**；但主内容区已显示 `无法列出目录：SSH_PROJECT_ROOT_UNRESOLVED` ⇒ **漂移被检测到了，只是侧栏行拿不到项目级状态**。

**根因（W4 定位，与本记录观测吻合，已确认）**

- 渲染层 `readRootStatusResponse` **只认扁平形状**，而 main 的 `remoteProjectRootStatus` 已迁到 **Op 信封**（`opOk({ status, … })`）⇒ 侧栏 badge 永远读成 `unavailable`。
- 这正好解释「面板能显示稳定码（走列表错误路径）、侧栏 badge 不显示（走 rootStatus 读取路径）」的分裂。

**修复（task-12，W4 分支，待合入 dev）**

- 读取改为**信封优先 + 扁平兼容**（旧测试仍绿），并补 3 条 Op 信封回归：读函数三态 / hook 落 atom / badge 渲染；e2e 里 `statusB` 断言同步对齐信封。

**修复后真机验证（由 W4 在其分支跑，2026-10-30）**

- 命令：`npx playwright test e2e/remoteHostAcceptance.spec.ts --grep "远端主机功能级验收"`（dev + task-12 修复构建）
- 结果：**1 passed (56.6s)，exit 0**；整条走完：加主机 pin → ready → 登记两项目 → 远端会话列表/标题/导入/重复导入 → **A 漂移后侧栏 badge 出现（带 `SSH_PROJECT_ROOT_UNRESOLVED/CHANGED`）** → **邻居 B 不被污染（`rootStatus` ok）**。
- 归属：该结果由 **W4** 跑出，非本 verifier；合入 dev 后如需最终 HEAD 证据，本 verifier 可再跑一次（约 1 分钟）。

### 11.6 远端内容搜索：协议级真机证据（旧 helper 回退 + 新 helper 命中）

探针 `tests/remoteHelperContentSearchProbe.mjs`（非 `*.test.mjs`）：`ssh -T <alias> 'node <bundle>/helper.mjs --root <临时目录>'` + NDJSON 帧 `hello` → `fs.searchContent` → 非法 query。夹具在远端 `$HOME` 临时目录（文本关键词 + 前 8KiB 含 NUL 的二进制 + 三层深目录），结束删除；不打印主机/用户。

| 时点 | 部署 bundle | `helperVersion` | `fs.searchContent` 能力 | 结果 |
|------|-------------|------------------|--------------------------|------|
| 首次（合并前 e2e 只有旧构建连过） | 2 个，最新无 `search-content.mjs` | **1.24.0** | **否**（capabilities 34 项） | **old-helper-fallback**：主进程 `files.searchContent` 对远端项目返回 null ⇒ 渲染层走「仅文件名」；需要一次远程连接触发内容寻址热更新 |
| 最终 build 跑过 host acceptance 之后 | 3 个，含 `search-content.mjs` | **1.25.0** | **是**（35 项） | **pass**（详见下） |

新 helper 实测（`fs.searchContent`，`path:"."`，query=`PIDECK_CONTENT_PROBE_OK`）：
`matches=2`（`note.txt`、`d1/d2/d3/deep.txt`）、`matchedFiles=2`、`scannedFiles=3`、`scannedBytes=168`、`truncated=false`；**二进制 `blob.bin` 被跳过（不产生匹配）**、深层目录命中、snippet ≤200 字符；非法 query（空串）⇒ `ok:false` + **`QUERY_INVALID`**（稳定拒绝，不挂死）。

> **UI 端到端未覆盖**：现有 e2e 无文件搜索入口（`grep searchContent e2e/` = 0），新增 e2e spec 不在 verifier 写作用域；**协议级真机证据（上表）+ W2 的路由/能力单测**共同覆盖。

### 11.7 WSL 两个 smoke 在最终 HEAD 上复跑

| 脚本 | 退出码 | 结果 |
|------|--------|------|
| `node tests/wslConfigReadSmoke.mjs` | 0 | `models.json` 不存在→空 providers 且不创建；`settings.json` 6 键；两文件 sha256 读前=读后（settings 前缀 `d16a1b8…`） |
| `node tests/wslConfigLifecycleSmoke.mjs` | 0 | 运行中读 119ms；`--terminate` 35ms→Stopped；显式重启 **2190ms**；重启后读 96ms；**停态直接读 2362ms → ok（UNC 自动拉起发行版，`autoStartedByRead=true`）**；收尾 Running |

**WSL 停态裁定（Lead）**：接受「UNC 访问自动拉起发行版（约 2.4s）+ 成功读取」，不作为缺陷；15s 截止保证「不挂死、不回退 Windows HOME」。稳定码只覆盖发行版缺失/改名/路径不可读。

### 11.8 W2 结构修复后的最终 HEAD（`f31b0104f` ← dev `86ea31ded`）

| 项 | 命令 | 退出码 | 结果 |
|----|------|--------|------|
| 合并 | `git merge dev`（W2 结构修复：内容搜索分区拆分 + 共享条目判据） | 0 | 本地 merge 提交 `f31b0104f`；`RemoteProjectPanel` 由 467 行降到拆分后（新增 `RemoteContentSearchSection` / `RemoteProjectRowMenu` / `RemoteProjectNameRules`） |
| 构建 | `npx electron-vite build`（仅 E2E 准备） | 0 | 1m5s |
| 守卫 1 | `node --test tests/remoteDragMove.test.mjs tests/remoteProjectUpload.test.mjs` | **0** | **23 passed / 0 failed**（两个守卫文件从 fail → pass，断言未改） |
| 「远端文件管理」E2E 复跑 | `--grep "远端文件管理 v1"` | **0** | **1 passed (55.4s)** —— 面板拆分没有破坏抽屉/文件编辑入口 |
| 全量单测复跑 | `npm test`（`node --test --test-concurrency=4`） | **1** | **tests 15093 / pass 14807 / fail 1 / skipped 285 / 403s**；唯一失败＝`tests/remoteProjectEntryState.test.mjs:60`「UI contract anchors exist in the shipped renderer modules」——W2 把行菜单拆成 `RemoteProjectRowMenu.tsx` 后，四个 `remote-file-row-*` 锚点不再在 `RemoteProjectPanel.tsx` 里，属**形状锚点守卫被结构拆分打破**（行为未回归，锚点仍在同批源码），待 W2 把该断言改为同时读新模块 |

> 口径：**全量单测、两个守卫文件、「远端文件管理」E2E 在最终 HEAD `f31b0104f` 上跑；其余 14 条远端 E2E 与 host acceptance 沿用 `2c4b35e51` 的结果**（W2 的改动是结构性拆分 + 共享判据抽取，行为不变；文件管理这条正是因为改到面板才复跑）。

### 11.10 第三处守卫修复后的最终 HEAD（`53ecfaac4` ← dev `827a00908`）

| 项 | 命令 | 退出码 | 结果 |
|----|------|--------|------|
| 合并 | `git merge dev`（W2 测试跟随：`remoteProjectEntryState` 四个行菜单锚点改读 `RemoteProjectRowMenu.tsx`，断言强度不变） | 0 | 本地 merge 提交 `53ecfaac4`；**只改测试文件**（+4 −2），产品代码与 `out/` 不变 |
| 守卫 3 | `node --test tests/remoteProjectEntryState.test.mjs` | **0** | **4 passed / 0 failed** |
| 「远端文件管理」E2E 复跑 | `--grep "远端文件管理 v1"` | **0** | **1 passed (1.4m)** —— 行菜单拆分后抽屉/文件编辑入口无回归（比前次慢因机器负载，非失败） |
| 全量单测 | `npm test`（`node --test --test-concurrency=4`） | **0** | **tests 15093 / pass 14808 / fail 0 / skipped 285 / 438s** —— 三条形状守卫修复后**全绿** |

> 最终 HEAD 说明：`53ecfaac4` 相对 `f31b0104f` **只多了一条测试文件的改动**，所以 `out/` 产物仍是 `f31b0104f` 那次构建（`npx electron-vite build` 0），远端 E2E 无需重跑；**全量单测、三条守卫文件、文件管理 E2E 均在最终 HEAD 上跑**。
>
> **最终提交**：`feat/v-final` 上的收尾提交（本文件与探针脚本）见 git log；验证记录本身不随 dev 合并而变。

### 11.11 最终 HEAD（`aa14565ef` ← dev `183193254`）：task-12 + task-13 合入后的独立复跑

> dev 增量：`bb9ab2d55`（W1 收口 5 提交 + W4 badge 修复 + 装配 + i18n）→ `183193254`（W4 task-13，**仅 e2e 两文件**）。
> **HEAD 对应关系**：门禁 + host acceptance 在 `71fc7eefc`（= `bb9ab2d55`）；代码文件 E2E 在 `aa14565ef`（= `183193254`，e2e-only）；守卫 4 与全量单测在 **最终 HEAD `77b7e28bc`**（= `b5b88d913`，仅测试文件 +2/−1，产品代码与 `out/` 均未变）。

| 项 | 命令 | 退出码 | 结果 |
|----|------|--------|------|
| 合并（第一次） | `git merge dev`（`bb9ab2d55`） | 0 | `71fc7eefc` |
| 构建 | `npx electron-vite build`（仅 E2E 准备） | 0 | 1m52s |
| 门禁四项 | typecheck / ipc-wiring / test-shape / format | 0 / 0 / 0 / 0 | 795 通道；sourceOnly 407 / **1791** 文件；**4183** 文件无差异 |
| **host acceptance**（task-12 验证） | `--grep "远端主机功能级验收"` | **0** | **1 passed (45.4s)** —— 加主机 pin → ready → 登记两项目 → 会话列表/标题/导入/重复导入 → **A 漂移后侧栏 badge 出现** → **B 未被污染**；W4 分支那次为 56.6s，两者一致 |
| 合并（第二次） | `git merge dev`（`183193254`，e2e-only） | 0 | `aa14565ef` |
| **代码文件 E2E**（task-13 验证） | `--grep "远端代码文件"` | **0** | **1 passed (2.1m)**（W4 侧 2/2 pass，各 2.2m） |
| 合并（第三次） | `git merge dev`（`b5b88d913`，W1 签名跟随，**仅测试文件 +2/−1**） | 0 | `77b7e28bc`（最终 HEAD） |
| 守卫 4 | `node --test tests/projectPackageDiscoveredRow.test.mjs` | **0** | **11 passed / 0 failed** |
| **全量单测（最终 HEAD）** | `npm test`（`node --test --test-concurrency=4`） | **0** | **tests 15106 / pass 14821 / fail 0 / skipped 285 / 422s** —— 最终 HEAD 全绿 |
| 全量单测（**W1 守卫修复前**，`aa14565ef`） | `npm test`（`node --test --test-concurrency=4`） | 1 | tests 15106 / pass 14820 / fail 1 / skipped 285 / 987s；唯一失败＝`tests/projectPackageDiscoveredRow.test.mjs:105` 签名守卫（W1 给 `extensionsUninstall` 加了 `options?: unknown`，`storeIpc.ts:642`）——**源码形状，行为未回归**，W1 已补字面量，上表为修复后复跑 |

**helperCapabilities 说明（Lead 问）**：UI 侧读取（`rootStatus.helperCapabilities`）**真机未额外观测**——该字段只经 rootStatus 返回、主进程日志与 `remoteHosts.diagnostics` 都不带它，现有 e2e 也无断言；由单测覆盖（task-12 的 Op 信封回归 3 条 + W2 的 `fileSearchCapability` 单测）。**helper 侧能力声明有真机证据**：协议探针 `hello` 得 `helperVersion 1.25.0`、capabilities 35 项含 `fs.searchContent`（§11.6）。

### 11.12 最终收尾结论（HEAD `77b7e28bc` = dev `b5b88d913` + merge）

- 全量：**tests 15106 / pass 14821 / fail 0 / skipped 285 / 422s，RC=0**（最终 HEAD 全绿）。
- 门禁：typecheck / ipc-wiring（795）/ test-shape（sourceOnly 407，1791 文件，新增 0）/ format（4183 文件）全 0。
- 远端：host acceptance **1 passed (45.4s)**（task-12 修复生效）；代码文件 E2E **1 passed (2.1m)**（task-13 修复生效）；此前 15 条 sweep 14 pass（条 12 已由 task-13 修复并复跑通过）。
- WSL：只读 smoke 与停/启 smoke 均 0（停态 UNC 自动拉起 2.4s，按 Lead 裁定接受）。
- 内容搜索：协议级真机证据 pass（helper 1.25.0 / 35 项能力含 `fs.searchContent` / 命中 2 处 / 二进制跳过 / `QUERY_INVALID`）；UI 端到端未覆盖（无 e2e 入口）。
- 三条形状守卫（remoteDragMove 行数预算、remoteProjectUpload 计数、remoteProjectEntryState 锚点）与 W1 签名守卫（projectPackageDiscoveredRow）均已在最终 HEAD 前修复，**最终全量 0 fail**。

---

## 12. task-18：运行 `e2e/remoteFunctionalAcceptance.spec.ts`（F1–F4 真机，本轮首次跑）

**前置**：`F:\PiDeck-v` 从 `9e7a00d67` 快进到 dev `187c96041`（= 合入最终验证记录的 docs 提交，**产品代码与 `out/` 未变**，未重新构建）；
凭据照旧在 PowerShell 进程内派生（不打印）；跑前 `Remove-Item Env:ELECTRON_RUN_AS_NODE`；与 `w4-remote-debt` 错开（对方回「你先跑」）。

| 轮次 | 命令 | 退出码 | 时长 | 结果 |
|------|------|--------|------|------|
| 首跑（修复前，HEAD `187c96041`，`out/` 为旧构建） | `& "$env:TEMP\pideck-v-remote.ps1" -Spec "e2e/remoteFunctionalAcceptance.spec.ts"` | **1** | **40.8s**（`1 failed` / `0 skipped`） | **fail**：F4「1500 条整表扫描」1500 missing（Op 信封测试债，见 12.2） |
| **复跑（Op 修复后，HEAD `24428bc5a` ← dev `f857a331f`，已重建 `out/`）** | 同上 | **0** | **38.7s** | **pass**：F1 `cancelMs=87`、F3 `warmMs=3099 / bundles=3`、F4 `scanMs=11006 / entries=1531`（1500 夹具 + 31 条用户真实会话） |

### 12.0 复跑后的部署根核对（HEAD `24428bc5a`）

| 检查 | 结果 |
|------|------|
| `bundles` 目录数 | **3**（与复跑前一致，本版本 `6e49555f…` 仍在） |
| `.e2e-*` 临时副本残留 | **0** |
| `leases` / `staging` | **0 / 0** |
| 本次夹具目录 `~/.pi/agent/sessions/e2e-f4-*` | **0**（finally 已清） |

### 12.1 首跑逐 step 结果（修复前，供对照）

| step | 结果 | 证据 |
|------|------|------|
| 远端前置：1500 条会话夹具 | pass | 本 run 独有目录 `e2e-f4-fmvv0hvjd`，夹具条数断言 1500 |
| 加主机（产品 IPC） | pass | `remoteHosts.add` 返回扁平 `{ok:true, hostId}` |
| 冷部署前置：把本版本 bundle 暂时移开 | pass | 无活跃 lease 才动；`bundles/6e49555f…` → `…e2e-fmvv0hvjd` |
| **F1：冷部署中取消** | **pass** | `cancelMs=140`；connect 落 `SSH_HOST_DISCONNECTED`；staging/锁/bootstrap 进程全部收敛；bundle 未激活 |
| **F1：立即重试完成真实冷部署** | **pass** | `connect` 返回 ready；`bundles` 重新包含 `6e49555f…` |
| **F3：断开→重连命中复用** | **pass** | `warmMs=5174`、`bundles=3` 不变、无 staging |
| **F4：1500 条整表扫描** | **fail** | 断言「every fixture session must be listed (**1500 missing**)」——`scan.entries` 读不到（详见 12.2） |

### 12.2 失败定性：**既有 e2e 测试债（Op 信封契约）**，不是产品缺陷

- `src/main/ipc/remoteSessionIpc.ts:117` 的 `remoteSessions.scan` 返回 **Op 信封** `opOk({ entries })`；`src/shared/op.ts:21` `Op<T> = { ok: true; value: T } | OpFailure`；preload 原样透传（`src/preload/index.ts:486` 类型即 `RemoteSessionScanIpcResult = Op<…>`）。
- 而该 spec（`e2e/remoteFunctionalAcceptance.spec.ts:250-260`）仍按**扁平**形状读 `scan.entries`：`scan.ok` 为 true（所以第一处断言通过），但 `scan.entries` 是 `undefined`，`ids` 为空 ⇒ 1500 条全部算 missing。
- 同一 spec 里 `remoteHosts.add/connect/disconnect` 返回的是**扁平**结果（`RemoteHostAddResult` 等），所以前面的 step 不受影响——只有 scan 这一个通道迁到了 Op。
- 这是**该 spec 首次被运行**时暴露的历史契约漂移（与 W4 之前修掉的「重复导入 Op 信封」同族），**产品行为本身没问题**：F1 取消收敛、冷部署、F3 复用命中都真机通过。
- 建议修法（e2e owner，不改产品）：`const entries = scan.ok ? (scan.value?.entries ?? []) : [];`，其余断言不变；如 `register/title` 也迁了 Op，一并核对。

### 12.3 远端 deploy 根恢复核对（跑后只读快照）

- `bundles` 仍是 **3 个**，包含本版本 `6e49555f…`（冷部署已把它重新上传），**没有** `.e2e-fmvv0hvjd` 残留副本；
- `leases=0`、`staging=0`，本次夹具目录 `~/.pi/agent/sessions/e2e-f4-*` 已被 finally 清掉；
- 说明该 spec 的"移开→冷部署重建→删掉那份临时副本"路径按设计工作；**若在冷部署完成前中断**，`bundles/<sha>` 会缺失、临时副本 `<sha>.e2e-<runId>` 仍在——此时把副本 `mv` 回原名（或再连一次触发冷部署）即可恢复。
- 旁证：主机上另有 **1 个** `.pideck-e2e-*` 目录（非本次 run 产生，来自更早某次远端会话用例），本次未清理、仅记录。

### 11.9 本轮结论（口径）

**已通过（真实主机）**：远端 Git 全档（G1/G2/G3/G4/G5a-e，14 条含终端/trust/产品路/文件管理）；WSL 只读与停/启 smoke；远端内容搜索协议级（新 helper 1.25.0 命中、二进制跳过、非法 query 稳定拒绝；同时记录旧 helper 1.24.0 的「仅文件名」回退行为）；两项源码形状守卫在 W2 修复后恢复。

**未通过 / 未验证（不当作通过）**：
1. **远端代码文件编辑**：修复前是既有 e2e 与当前 UI 交互契约不一致（`.header-drawer-toggle` + 一次未复现的 oracle 失败）；**task-13 已修（e2e-only）**，最终 HEAD `aa14565ef` 独立复跑 **1 passed (2.1m)**（见 11.4）。
2. **remoteHostAcceptance**：修复前确定性 2/2 失败（漂移已检测但侧栏 badge 未显示）；根因＝渲染层 `readRootStatusResponse` 只认扁平形状、main 已迁 Op 信封 ⇒ badge 恒 `unavailable`；**task-12 已修并合入**，本 verifier 在 `71fc7eefc`（= dev `bb9ab2d55`）**独立复跑 1 passed (45.4s)**（见 11.5 / 11.11）。
3. **G6b opt-in soak**、其余未列出的远端用例。（`remoteFunctionalAcceptance` 已补跑：首跑 fail → Op 修复后 **pass 38.7s**，见 §12）
4. ~~远端内容搜索 UI 端到端未覆盖~~ → **已闭合**：W4 task-17 在「远端代码文件」用例里补了抽屉搜索步骤，最终 HEAD 真机通过（见 §13）。

---

## 13. 远端内容搜索 UI 端到端（W4 task-17 e2e 步骤，最终 HEAD 复跑）

**背景**：此前内容搜索只有**协议级真机证据**（§11.6：helper 1.25.0 / `fs.searchContent` 命中 / 二进制跳过 / `QUERY_INVALID`），UI 端到端因现有 e2e 无入口而未覆盖。W4 在 `e2e/remoteSessionAcceptance.spec.ts:690` 的「远端代码文件」用例里新增了 `test.step("文件抽屉内容搜索：…")`（不新增 spec、不改既有断言）。

| 项 | 内容 |
|----|------|
| HEAD | `24428bc5a` ← dev `f857a331f`（含 task-17 e2e 与 W1 task-16 产品代码；`out/` 已重建） |
| 命令 | `& "$env:TEMP\pideck-v-remote.ps1" -Grep "远端代码文件"` |
| 退出码 / 时长 | **0 / 2.1m** |
| 结果 | **1 passed** —— 新增的内容搜索步骤真机通过 |

**该步骤的断言（逐条）**

1. 抽屉里点「搜索文件名」→ 输入夹具正文标记 **「中文保存验收」** → 点「搜索」；
2. `.file-search-content` **内容命中分区出现**（依据 helper 1.25.0 的 `fs.searchContent` 能力）；
3. 命中行指向夹具文件 `calc.cjs`，`title` 匹配 **`/^calc\.cjs:\d+$/`**（项目相对路径:行号）；
4. 命中行正文片段带出 **「中文保存验收」**；
5. `file-search-name-only-hint`（「仅文件名」能力提示）**计数为 0** —— 新 helper 下不得显示能力缺失提示；
6. 点「清除搜索结果」→ 内容分区消失，后续步骤仍在原抽屉路径继续。

**覆盖边界**：真机无法回退 helper 版本，所以**只覆盖 helper 1.25.0 的「命中」路径**；「旧 helper ⇒ 仅文件名」的回退路径仍由单测覆盖（W2 的 `remoteContentSearchCapabilityUi` 等），本记录 §11.6 另有旧 helper 1.24.0 未部署新 bundle 时的**真实主机行为**证据（能力缺失 ⇒ 主进程返回 null）。

**与协议级证据的关系**：§11.6 证明「helper 侧能力与协议正确」，本节证明「产品 UI 链路（能力协商 → 抽屉搜索 → 命中分区 → 清除）」正确，两者互补；至此内容搜索的验证不再有"只有协议层"的缺口。

---

## 14. 最终收尾第二轮（dev `f857a331f` 之后）

### 14.1 中间全量（HEAD `24428bc5a`，两条契约修复前）：**fail 2**

`npm test` ⇒ **tests 15117 / pass 14830 / fail 2 / skipped 285 / 1127.7s**。两条都是**源码契约字面量**被 W1 task-16 的「资源目标路由」打破，产品行为无回归：

| # | 失败 | 原因 | 处置 |
|---|------|------|------|
| 1 | `tests/extensionUserPluginClassification.test.mjs:67` | 断言要求 `extensionManager.toggleFromUi(`；实际 toggle 先 `const manager = await resolvePiResourceWriteManager({…})`（该行末尾就是 `});`）再 `manager.toggleFromUi(…)`。语义契约仍成立：单一入口 + storeIpc 内无 `startsWith("pi-deck-")` | Lead 已改为 `/\.toggleFromUi\(/`（不绑变量名） |
| 2 | `tests/skillsRenameIpc.test.mjs:15` | 该测试用 `indexOf("});", start)` 切 handler 块；新 handler 第一行 `resolvePiResourceWriteManager({…});` 就含 `});` ⇒ 块在第 1978 行被截断，后面的校验语句在切片之外。**handler 本身校验完好**（`systemIpc.ts:1980` skillPath 校验、`1983` newName 校验、`1986` `manager.rename`） | 待修：block 边界改到下一个 `ipcMain.handle(`（或 `skillsOpenFolder`），三条断言语义不变 |

> 备注：本轮 `npm test` 总时长 1127.7s，明显长于此前 400-500s，主因是交叉安装（`packDshRuntimeCross` 的 npm install）在这段时间特别慢，属环境波动，非产品问题。

### 14.2 两条契约跟随后：最终 HEAD `1bc790122` ← dev `a1527a37c`

| 项 | 命令 | 退出码 | 结果 |
|----|------|--------|------|
| 合并 | `git merge dev`（`fc321865b` toggleFromUi 字面量 + `a1527a37c` skillsRename 切块） | 0 | `1bc790122`（**仅两个测试文件改动**，产品代码与 `out/` 未变） |
| 契约 1 | `node --test tests/extensionUserPluginClassification.test.mjs tests/skillsRenameIpc.test.mjs` | **0** | **5 passed / 0 failed** |
| 全量单测 | `npm test`（`node --test --test-concurrency=4`） | **1** | **tests 15117 / pass 14831 / fail 1 / skipped 285 / 1267.8s**；唯一失败＝`tests/packDshRuntimeCross.test.mjs:56`「交叉模式：临时 package.json 把平台门控包写进 optionalDependencies」→ **`spawnSync … ETIMEDOUT`**（该测试自身 10 分钟预算用尽，`pack-dsh-runtime --dry-run` 的交叉 `npm install` 没跑完）。**环境侧**：今晚交叉安装极慢（缓存已 665MB 且仍在增长；此前多轮全量 400–500s 就跑完、该文件也通过过），非产品回归、与本轮改动无关；单跑该文件复核时超过单次执行预算被中断（已清理我自己的残留进程，未触碰主工作树那条）。**最终全量以 Lead 在主工作树（dev `a1527a37c`）的取证为准** |
| 全量单测（**Lead 主工作树最终取证**） | `npm test`（`node --test --test-concurrency=4`，`F:\PiDeck` @ `a1527a37c`） | **0** | **tests 15117 / pass 14832 / fail 0 / skipped 285 / 768.9s** —— 环境恢复后全绿；产品/测试代码与 `1bc790122` 相同（仅 docs 差异） |

> 说明：`tests/skillsRenameIpc.test.mjs` 的 block 边界改为「下一个 handler 起点」，`rename` 断言改为 `/\.rename\(skillPath, newName\)/`（不绑变量名），三条语义断言强度不变；`extensionUserPluginClassification` 的 toggleFromUi 断言改为 `/\.toggleFromUi\(/`。




## 15. 检查点 55dd5b702 独立验收（2026-10-31）

> 本节登记 [remote-acceptance-55dd5b702.md](remote-acceptance-55dd5b702.md) 的验收结果，不改变上面各节的历史记录。

- 基线：`09aca4203..55dd5b702`；只读复核 + Windows 定向复跑 + WSL Linux 测试；未连接真实主机、未启动 Electron。
- Linux（WSL Ubuntu 26.04，node v24.19.0）：本提交 6 个测试文件 61/61；POSIX/Linux-only 邻接 139 pass / 1 skip；根池化 51/51；`tests/remote*.test.mjs` + `tests/ssh*.test.mjs` 全扫 2361 pass / 7 fail / 11 skip；7 例在 `HEAD~1` 副本同失败，属既有问题（`remoteGitStability` 4 例等）。
- F1（池化开启时的显式断开清理顺序）已复现并修复：提交 `a905d4d7d`（stale 暖缓存守卫 + 生产顺序回归）；Windows 62/62、Linux lifecycle 7/7、typecheck/format/ipc-wiring 均通过；原提交 `55dd5b702` 未改写。
- 未执行：真实 SSH + Electron 端到端验收（方案 §4，待目标与范围授权）。
