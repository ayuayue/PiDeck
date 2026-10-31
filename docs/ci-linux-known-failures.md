# Linux CI 既有红挂账（remote/SSH 域）

> **Status: Current（2026-10-31 建立；HEAD `f870d5574`，分支 `dev`）**
>
> 本文件登记「在 Linux 上已经红、与本轮改动无关」的单测，供 `.github/workflows/ci.yml` 的
> `linux-unit-remote` job 对照。**挂账 = 只记录：不改测试、不改产品代码、不加 skip。**
> 口径沿用 `docs/remote-wsl-verification-log.md`：**跳过 / 未运行 = 未验证，绝不算通过。**

## 0. 口径与证据环境

| 项 | 事实 |
|----|------|
| 记录时点 / HEAD | 2026-10-31，`f870d5574`（`dev`）；任务开始时 `git status --porcelain` 为空 |
| Linux 证据环境 | WSL2 Ubuntu 26.04（kernel `6.18.33.2-microsoft-standard-WSL2`），node **v24.19.0** |
| CI 目标环境 | GitHub `ubuntu-latest` + node **24.13.0**（`ci.yml` 里 `setup-node` 的固定版本） |
| 两者关系 | WSL2 **不是** runner 的等价物；本文的结论是「Linux 上确实红」，不代表 runner 上逐字复现。这正是跟踪 step 用 `continue-on-error` 而非硬门禁的原因 |
| 复现统一命令 | `node --test --test-concurrency=1 tests/<file>.test.mjs`（cwd = 仓库根） |
| CI 实际命令 | 上面同一条，额外加 `--test-timeout=120000 --test-force-exit`（与 Windows job 同口径，兜底超时与 open handle） |

**基线对照（证明「既有」而不是「本轮引入」）**：两份快照都用 `git archive <sha> | tar -x -C <仓库外目录>`
导出，并逐 blob 与 `git ls-tree -r <sha>` 校验一致（`git hash-object` 全等，0 缺失 0 差异）：

| 角色 | 提交 | blob 校验 | 用途 |
|------|------|-----------|------|
| **HEAD~1** | `a905d4d7d` | 4825 / 4825 一致 | 主基线：「既有红」= 与 HEAD~1 同红 |
| 更早基线 | `09aca4203`（HEAD~3） | 4822 / 4822 一致 | 证明不是 `55dd5b702`/`a905d4d7d`/`f870d5574` 这条链路引入 |

快照里没有 `.git`，跑测试时用 `ln -s <主仓>/node_modules node_modules` 复用依赖（只读引用）。
本轮原始日志在仓库外（`/home/wsl/pideck-runs/logs/`，不入库）；结论可用 §5 的命令重跑复现。

## 1. 硬门禁：17 个文件在 Linux 实测全绿

这 17 个文件是 `ci.yml` → `linux-unit-remote` → step「Hard gate - remote/SSH subset green on Linux」
的内容：**覆盖本轮远端目录监听 / root 池化 / bootstrap 上传 / 浏览根 / Git 比较 / pi 宿主启动
链路，且在 Linux 上实测全绿**，所以能当硬门禁——一上来就红的文件放硬门禁只会让人习惯性重跑。

单文件串行实测（node v24.19.0，WSL2 Ubuntu 26.04，`f870d5574`）：

| # | 文件 | tests | pass | skip | fail |
|---|------|-------|------|------|------|
| 1 | `tests/remoteProjectLifecycle.test.mjs` | 7 | 7 | 0 | 0 |
| 2 | `tests/remoteProjectDirFacts.test.mjs` | 14 | 14 | 0 | 0 |
| 3 | `tests/remoteDirWatchDeep.test.mjs` | 15 | 15 | 0 | 0 |
| 4 | `tests/remoteDirWatchDegradedHint.test.mjs` | 4 | 4 | 0 | 0 |
| 5 | `tests/remoteDirectoryPageWatchDegraded.test.mjs` | 5 | 5 | 0 | 0 |
| 6 | `tests/remoteProjectUpload.test.mjs` | 17 | 17 | 0 | 0 |
| 7 | `tests/remoteRootPooling.test.mjs` | 14 | 14 | 0 | 0 |
| 8 | `tests/remoteRootSessionPool.test.mjs` | 19 | 19 | 0 | 0 |
| 9 | `tests/remoteProjectRootReverify.test.mjs` | 14 | 14 | 0 | 0 |
| 10 | `tests/remoteProjectWatchKeepAlive.test.mjs` | 4 | 4 | 0 | 0 |
| 11 | `tests/remoteGitCompare.test.mjs` | 9 | 9 | 0 | 0 |
| 12 | `tests/remoteBootstrapContract.test.mjs` | 81 | 80 | **1** | 0 |
| 13 | `tests/remoteBootstrapSessionIntegration.test.mjs` | 1 | 1 | 0 | 0 |
| 14 | `tests/remoteBrowseRoot.test.mjs` | 7 | 7 | 0 | 0 |
| 15 | `tests/piAuthHostLaunch.test.mjs` | 13 | 13 | 0 | 0 |
| 16 | `tests/remoteBootstrapUpload.test.mjs` | 14 | 14 | 0 | 0 |
| 17 | `tests/remoteBundleMaintenance.test.mjs` | 15 | 15 | 0 | 0 |
| | **合计** | **253** | **252** | **1** | **0** |

- 那 1 个 skip 是 `remoteBootstrapContract.test.mjs:909` 的 **root-only** 用例（`chown` 造
  他人所有文件，非 root 必然 skip），见 §4 —— 这是硬门禁**唯一允许**的 skip。
- 硬门禁的验收口径：`253 tests = 252 pass + 1 skip + 0 fail`。**出现第 2 个 skip 就要查**
  （环境差异或有人偷偷加了 skip），不能当绿灯放过去。

## 2. 既有 Linux 红：7 条 / 4 个文件

汇总（`f870d5574` 与 HEAD~1 `a905d4d7d` 计数完全一致）。**全扫 `tests/remote*.test.mjs` +
`tests/ssh*.test.mjs`（248 文件、2380 tests、单并发）实测共 7 红，全部落在下表 4 个文件里，
没有第 8 条**：

| # | 文件 | 红 / 总 | 基线 HEAD~1 | 更早基线 `09aca4203` | 处置 |
|---|------|---------|-------------|------------------------|------|
| 1–4 | `tests/remoteGitStability.test.mjs` | 4 / 4 | 4 / 4 同红 | 4 / 4 同红 | 挂账 |
| 5 | `tests/remoteHelperSearchNames.test.mjs` | 1 / 13 | 1 / 13 同红 | 1 / 13 同红 | 挂账 |
| 6 | `tests/remoteSearchIsolation.test.mjs` | 1 / 25 | 1 / 25 同红 | 1 / 25 同红 | 挂账 |
| 7 | `tests/sshClientRuntime.test.mjs` | 1 / 12（另有 4 skip） | 1 / 12 同红 | 1 / 12 同红 | 挂账 |

「同红」= 同一个 test 名、同一处断言失败；不是「数量巧合」。

### 2.1 `tests/remoteGitStability.test.mjs`（4 红）

- 命令：`node --test --test-concurrency=1 tests/remoteGitStability.test.mjs`
- 现象：4 条全红（`tests 4 / pass 0 / fail 4`），4 条都是「真实 helper 进程 + 原生 Git 写盘时序」
  类断言，错误码/顺序与 Windows 不同：

| test（行） | 断言失败点 | 现象 |
|---|---|---|
| `remote Git lost applied reply remains unknown across reconnect…`（193） | :199 `strictEqual` | 实际 `undefined`，期望 `'GIT_WRITE_RESULT_UNCONFIRMED'` |
| `two windows sharing one real helper cannot overwrite the first index write…`（222） | :229 `strictEqual` | 实际 `undefined`，期望 `'GIT_RESOURCE_CHANGED'` |
| `canceling a host-lock queued window sends zero Git writes…`（244） | :266 `strictEqual` | 实际 `'REMOTE_CONNECTION_LOST'`，期望 `'GIT_WRITE_RESULT_UNCONFIRMED'` |
| `bounded 24-cycle renderer/IPC/helper/native-Git soak…`（281） | :293 抛出 | `Error: GIT_RESOURCE_CHANGED`，来自 `src/renderer/src/utils/remoteGitPanelApi.ts:24`（`workspaceFileDiff`） |

- 基线：HEAD~1 `a905d4d7d` 与 `09aca4203` 均 `tests 4 / pass 0 / fail 4`，test 名与断言一致。
- 处置：**挂账**。4 条共用同一前提（真实 helper + 原生 Git 的 host-lock 时序），未定性根因；
  修需要先判「Linux 上错误码语义是否本就该不同」，单独开任务，不在本 CI 任务里动测试或产品。

### 2.2 `tests/remoteHelperSearchNames.test.mjs`（1 红）

- 命令：`node --test --test-concurrency=1 tests/remoteHelperSearchNames.test.mjs`
- 现象：`tests 13 / pass 12 / fail 1`。test `the entry ceiling stops at 20000 visited entries and
  never counts or matches the next one`（:54）在 :407 `deepStrictEqual` 失败——
  **越过 20000 上限后的那个条目仍被访问并命中**：实际 `[{ path: 'zzzz-match.txt', name: 'zzzz-match.txt',
  kind: 'file', bytes: 0 }]`，期望 `[]`（断言消息：`the entry past the ceiling was never visited, so
  it was never matched`）。
- 基线：HEAD~1 与 `09aca4203` 均 `13 / 12 / 1`，同一 test、同一断言。
- 处置：**挂账**。遍历条目上限的边界计数在 Linux 上差 1~N，疑似目录遍历顺序/计数口径与平台相关，
  未定性；不在本任务改测试或产品。

### 2.3 `tests/remoteSearchIsolation.test.mjs`（1 红）

- 命令：`node --test --test-concurrency=1 tests/remoteSearchIsolation.test.mjs`
- 现象：`tests 25 / pass 24 / fail 1`。test `the scanned-entry cap reports exactly the cap and
  truncated, with zero matches`（:447）在 :459 失败，断言消息 `read 20002 entries: the traversal did
  not stop at the scanned cap`——**扫描条数上限在 Linux 上多读了 2 条**。
- 基线：HEAD~1 与 `09aca4203` 均 `25 / 24 / 1`，同一 test。
- 处置：**挂账**。与 2.2 同族（遍历上限边界），同样未定性。

### 2.4 `tests/sshClientRuntime.test.mjs`（1 红 + 4 skip）

- 命令：`node --test --test-concurrency=1 tests/sshClientRuntime.test.mjs`
- 现象：`tests 12 / pass 7 / fail 1 / skipped 4`。test `discovery fails closed with a stable code
  instead of falling back to an unverified client`（:166，走 POSIX-only 分支）在 :171 `rejects` 失败：
  期望 `/SSH_CLIENT_VERSION_UNSUPPORTED/`，实际 `Error: SSH_CLIENT_NOT_REGULAR_FILE`，抛自
  `src/main/remote/SshClientRuntime.ts:211`（`resolvePosixSshClient`）——POSIX 客户端探测在 Linux 上
  先撞「不是普通文件」而不是「版本不支持」。
- 基线：HEAD~1 与 `09aca4203` 均 `12 / 7 / 1 / 4 skip`，同一 test。
- 处置：**挂账**。修法与 2.1–2.3 不同：要先决定「探测顺序（stat vs 版本探测）在 POSIX 上是否该变」，
  单独开任务。

## 3. CI 边界：硬门禁 vs 跟踪

`ci.yml` 新增 job `linux-unit-remote`（`Linux unit tests (remote/SSH)`，`ubuntu-latest`，
node `24.13.0`，`npm ci` + npm 缓存，job 上限 45 分钟）：

| step | 内容 | 失败影响 | 超时 |
|------|------|----------|------|
| Hard gate - remote/SSH subset green on Linux | §1 的 17 个文件，`node --test --test-concurrency=1 --test-timeout=120000 --test-force-exit` | **挡合并** | 15 分钟 |
| Track full remote/SSH sweep (known reds, non-blocking) | `tests/remote*.test.mjs` + `tests/ssh*.test.mjs`（`--test-concurrency=1`，同为 1 并发） | `continue-on-error`，**不挡合并** | 25 分钟 |

超时是按实测定的，不是拍的：

- 硬门禁那条命令**原样**（17 个文件、单进程、串行、带 `--test-timeout/--test-force-exit`）在 WSL2
  上跑一遍 = **46s，RC=0，253 tests / 252 pass + 1 skip**；15 分钟对 ~1 分钟是约 20 倍余量，
  挡的是整文件挂起而不是正常慢。
- 跟踪那条命令**原样**（248 文件、1 并发）= **668s（约 11 分钟），2380 tests / 2362 pass / 7 fail /
  11 skip**，7 红全部命中 §2；25 分钟对 ~11 分钟约 2.2 倍余量。这个 11 分钟是跑在 `/mnt/f` 9p
  慢盘上的**上限**，runner 本地盘只会更快。

两份耗时都只是量级参考（WSL2 ≠ ubuntu-latest）；真正的余额以 CI 首轮实跑为准，若跟踪 step 逼近
25 分钟，改的是超时而不是把红挪进硬门禁。

边界规则（必须成对理解）：

1. **硬门禁只含实测全绿的文件**，不含本文件 §2 的任何一条。往硬门禁里加已知红 = 把门禁变成噪音。
2. **跟踪 step 的 `continue-on-error` 是为了「不让既有红挡合并」，不是「允许新红」。** 每轮跑完，
   把失败 test 清单与 §2 对照：
   - 都能对上 §2 → 正常，忽略；
   - **对不上（新红）→ 按缺陷处理**：要么当轮修，要么补齐 §2 的定性证据（基线同红 + 当前 HEAD 同红 +
     原因）后登记。**不允许**用改断言、加 skip、删用例来消红（AGENTS.md 铁律 10）。
3. `--test-concurrency=1` 与 `npm run test:serial` 同口径：测试文件共享进程全局状态，并发会互相干扰。
4. 本 job 不跑 typecheck / build / 打包：那些由 `dev-guard.yml`（ubuntu）与 Windows `build` job 覆盖，
   不在这里重复烧 runner。
5. 本文件只覆盖 `remote*/ssh*` 这一片；**Windows 上本来就红、或 Windows↔Linux 语义不同的其它域**不在
   本文范围（Windows job 仍是全量门禁，维持原状——本次没有改动它）。

## 4. Windows-only / POSIX skip 的区分

Linux 与 Windows 的 skip 集合**不是同一批**，混着记账会把「没跑」当「通过」。三类 skip：

| 类型 | 写法（示例） | 在 Linux 上 | 在 Windows 上 | 记账规则 |
|------|--------------|-------------|---------------|----------|
| **Windows-only** | `{ skip: !isWindows }` —— `tests/sshClientRuntime.test.mjs:32/41/122/130` 共 4 条 | skip（**不算通过**） | 真跑 | Windows 的绿灯含这 4 条；Linux 的绿灯不含 |
| **POSIX-only** | `if (process.platform === "win32") return t.skip("POSIX-only …")` —— `tests/sshClientRuntime.test.mjs:156/167/175/195`、`tests/remoteBootstrapContract.test.mjs:628` | 真跑（**Linux 才能验证**） | skip | 反向同理：Windows 绿证明不了这几条 |
| **root-only** | `{ skip: CAN_STAGE_FOREIGN_OWNER ? false : "root only: …" }` —— `tests/remoteBootstrapContract.test.mjs:909`（`chown` 造他人所有文件） | 非 root → skip（**本文硬门禁里唯一预期 skip**） | 同左 | GitHub runner 非 root，硬门禁按 1 个 skip 验收 |

结论：

- 硬门禁在 Ubuntu runner（非 root）上的预期结果是 **253 tests = 252 pass + 1 root-only skip + 0 fail**。
- `sshClientRuntime` 在 Linux 上是 **7 pass + 1 fail（§2.4）+ 4 个 Windows-only skip**；那条 fail 走的是
  POSIX-only 分支，Windows 上根本不执行——**所以 Windows job 绿不能替这条买单，反过来 Linux 红也不能
  说明 Windows 回归**。
- 任何「Windows 上跳过 ⇒ 视为 Linux 通过」的推断都是错的（反之亦然）。

## 5. 本地复现 / 更新本文件的流程

在 Linux（或 WSL）上复现当前 HEAD 的红：

```bash
node --test --test-concurrency=1 tests/remoteGitStability.test.mjs      # 4 红
node --test --test-concurrency=1 tests/remoteHelperSearchNames.test.mjs # 1 红
node --test --test-concurrency=1 tests/remoteSearchIsolation.test.mjs   # 1 红
node --test --test-concurrency=1 tests/sshClientRuntime.test.mjs        # 1 红 + 4 skip
```

复现「基线同红」（证明不是本轮引入）：

```bash
# 仓库外建快照，不碰工作区
git archive <sha> | tar -x -C /tmp/pideck-<sha>
ln -s "<主仓>/node_modules" /tmp/pideck-<sha>/node_modules
cd /tmp/pideck-<sha> && node --test --test-concurrency=1 tests/remoteGitStability.test.mjs
# 快照一致性自检：git hash-object 逐文件比对 git ls-tree -r <sha>，应为 0 缺失 0 差异
```

登记/摘除规则：

- **登记**：同一条红要在「HEAD~1 快照」和「当前 HEAD」两处都复现，再把命令、现象（含断言行号）、
  基线证据、处置写进 §2；同时在 PR 描述里贴两条命令的 `pass/fail` 摘要。
- **修复后摘除**：把该条从 §2 删掉，并**同一次提交**把它加进 `ci.yml` 的硬门禁文件表（§1），
  附「修复前红 → 修复后绿」两组输出。
- **禁止**：为消红改断言 / 加 skip / 删用例 / 在 `ci.yml` 里对单条红做 `continue-on-error` 白名单。
