# Linux CI remote/SSH：已清零与硬门禁边界

> **Status: Current（2026-11-02）**
>
> 2026-10-31 初版挂账 7 条 Linux 既有红；2026-11-02 本轮全部修复并摘除。
> 硬门禁从 17 个文件扩到 **21 个文件**，跟踪全扫已 **0 fail**。本文保留口径、修复证据与复现命令。

## 0. 口径与证据环境

| 项 | 事实 |
|----|------|
| 证据环境 | WSL2 Ubuntu 26.04（kernel 6.18.33.2-microsoft-standard-WSL2），node **v24.19.0** |
| CI 目标环境 | GitHub `ubuntu-latest` + node **24.13.0**（`ci.yml` 固定版本） |
| 两者关系 | WSL2 不等价于 runner；跑绿证明「Linux 上不再红」，不替代首轮 CI 实跑 |
| 复现命令 | `node --test --test-concurrency=1 tests/<file>.test.mjs`（cwd = 仓库根） |
| CI 命令 | 同一条，额外加 `--test-timeout=120000 --test-force-exit` |

## 1. 硬门禁：21 个文件在 Linux 实测全绿

2026-11-02 单并发实测（WSL2、node v24.19.0，含本轮 4 个新入组文件）：

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
| 18 | `tests/remoteGitStability.test.mjs` | 4 | 4 | 0 | 0 |
| 19 | `tests/remoteHelperSearchNames.test.mjs` | 13 | 13 | 0 | 0 |
| 20 | `tests/remoteSearchIsolation.test.mjs` | 25 | 25 | 0 | 0 |
| 21 | `tests/sshClientRuntime.test.mjs` | 12 | 8 | **4** | 0 |
| | **合计** | **307** | **302** | **5** | **0** |

- 5 个 skip：`sshClientRuntime` 的 4 条 Windows-only；`remoteBootstrapContract:909` 的 1 条 root-only。
- 实测耗时 **92.9s**（/mnt/f 9p 慢盘），CI 硬门禁 timeout 15 分钟仍有约 10 倍余量。
- 硬门禁验收口径：**307 tests = 302 pass + 5 skip + 0 fail**。任何第 6 个 skip 都要查。

## 2. 原 7 条既有红：根因与修复

| # | 文件 | 原红/总 | 根因 | 修复 | 当前 |
|---|------|---------|------|------|------|
| 1–4 | `remoteGitStability` | 4 / 4 | 测试夹具 `helperCapabilities` 漏了 `git.discard`；`git.write` 能力要求 stage/unstage/commit/discard 全在，Linux-only 用例因此 `cap.write=false`，`mutate()` 直接 no-op，后续断言看到 undefined | 夹具补 `git.discard` | **4 / 4 pass** |
| 5 | `remoteHelperSearchNames` | 1 / 13 | helper 的 `readSearchDirectory` 按 readdir 返回顺序先截到 20000 再排序；Linux readdir 顺序不保证字典序，`zzzz-match.txt` 可能落在前 20000 内并被命中 | helper 改为读 `budget+1`、按名字排序、再截到 budget；helper 1.25.1 + 新 SHA | **13 / 13 pass** |
| 6 | `remoteSearchIsolation` | 1 / 25 | 同上：`z-more` 目录可能被读进前 20000 并继续下钻，visited 多 1–2 条 | 同 5，改为排序后截断 | **25 / 25 pass** |
| 7 | `sshClientRuntime` | 1 / 12 | 用例用 `/bin/ls` 当「存在但不是 OpenSSH」；Ubuntu `/bin` 是 usrmerge 符号链接，先被 `SSH_CLIENT_NOT_REGULAR_FILE` 拒绝 | 改用普通文件夹具（regular + executable 的假 `ssh`/`scp`），仍断言 `SSH_CLIENT_VERSION_UNSUPPORTED` | **8 pass + 4 skip** |

### 2.1 搜索上限修复的契约口径

- `readSearchDirectory` 现在最多读 `budget+1` 个目录项，按 `compareEntryName` 排序，再截到 `budget`；被截掉的条目既不计入 `scanned`，也不匹配。
- 这样 20000/20001 条边界与 readdir 平台顺序无关；目录项超过 `budget+1` 时仍只读有界数量，不整目录 materialize。
- 因 helper 冻结体变化：`REMOTE_HELPER_ENTRY_VERSION` 1.25.0 → **1.25.1**，`REMOTE_HELPER_ENTRY_SHA256` 重新计算并同步契约测试。
- 证据：`remoteHelperSearchNames` 13/13、`remoteSearchIsolation` 25/25，含「the scanned-entry cap reports exactly the cap...」「the entry ceiling stops at 20000...」两条原红。

## 3. CI 边界：硬门禁 vs 跟踪

`.github/workflows/ci.yml` 的 `linux-unit-remote`：

| step | 内容 | 失败影响 | 超时 |
|------|------|----------|------|
| Hard gate - remote/SSH subset green on Linux | §1 的 **21** 个文件，单并发 + timeout/force-exit | **挡合并** | 15 分钟 |
| Track full remote/SSH sweep (non-blocking) | `tests/remote*.test.mjs` + `tests/ssh*.test.mjs` | `continue-on-error`，不挡合并 | 25 分钟 |

- 跟踪全扫实测（2026-11-02）：**2380 tests / 2369 pass / 0 fail / 11 skip，797.6s（约 13.3 分钟）**，rc=0。
- 对比 2026-10-31 基线：2362 pass / 7 fail / 11 skip；本轮 **+7 pass、7 红清零、skip 不变**。
- 跟踪 step 仍保留 `continue-on-error`：环境差异（runner 与 WSL 不同）不应挡合并；但**当前已知红已清零**，任何新红按缺陷处理，不允许用改断言/加 skip/删用例消红。
- 25 分钟对 13.3 分钟约 1.9 倍余量；若首轮 CI 逼近 25 分钟，改超时，不把红挪进硬门禁。

## 4. Skip 区分（不是通过）

| 类型 | 位置 | Linux 上 | Windows 上 | 记账 |
|------|------|----------|------------|------|
| Windows-only | `sshClientRuntime` 4 条 | skip | 真跑 | Linux 硬门禁预期 4 skip |
| root-only | `remoteBootstrapContract:909` | 非 root skip | 同左 | 硬门禁预期 1 skip |

硬门禁在 GitHub runner（非 root）上的预期：**307 tests = 302 pass + 5 skip + 0 fail**。

## 5. 复现 / 维护

```bash
# 硬门禁 21 文件（与 ci.yml 同口径；WSL 用 /home/wsl/node24/bin/node）
node --test --test-concurrency=1 --test-timeout=120000 --test-force-exit \
  tests/remoteProjectLifecycle.test.mjs tests/remoteProjectDirFacts.test.mjs \
  tests/remoteDirWatchDeep.test.mjs tests/remoteDirWatchDegradedHint.test.mjs \
  tests/remoteDirectoryPageWatchDegraded.test.mjs tests/remoteProjectUpload.test.mjs \
  tests/remoteRootPooling.test.mjs tests/remoteRootSessionPool.test.mjs \
  tests/remoteProjectRootReverify.test.mjs tests/remoteProjectWatchKeepAlive.test.mjs \
  tests/remoteGitCompare.test.mjs tests/remoteBootstrapContract.test.mjs \
  tests/remoteBootstrapSessionIntegration.test.mjs tests/remoteBrowseRoot.test.mjs \
  tests/piAuthHostLaunch.test.mjs tests/remoteBootstrapUpload.test.mjs \
  tests/remoteBundleMaintenance.test.mjs tests/remoteGitStability.test.mjs \
  tests/remoteHelperSearchNames.test.mjs tests/remoteSearchIsolation.test.mjs \
  tests/sshClientRuntime.test.mjs

# 全扫（跟踪）
node --test --test-concurrency=1 --test-timeout=120000 --test-force-exit \
  "tests/remote*.test.mjs" "tests/ssh*.test.mjs"
```

维护规则：

- **新增红**：先在当前 HEAD 与上一提交快照复现，定性为「既有」才挂账；挂账只记录，不改断言/不加 skip/不删用例。
- **修复后**：从 §2 摘除，在同一次提交把文件加进 §1/ci.yml 硬门禁，并附「修复前红 → 修复后绿」输出。
- **任何 skip 增加**：按未验证处理，先查环境差异或是否有人偷偷加 skip。
