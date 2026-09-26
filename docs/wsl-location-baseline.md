# WSL 项目位置迁移：现状基线与首批测试

> 状态：只读代码审计 + 现有针对性测试基线；会话目录双快照不可读时的拒写保护已补上，**并列项目模型仍未实现**，未在 Windows+WSL 双发行版上进行实机 smoke。
>
> 适用 `feat/remote-development` 工作树；是[项目位置 ADR](project-location-architecture.md) 的事实与验收清单，不替代[远程实施计划](remote-development-plan.md)的 SSH 阶段门禁。本文只审计代码/现有测试与临时 fixture，不读取用户 `projects.json`、会话、SSH 凭据或真实 WSL 数据。

## 当前执行链路（静态可证）

| 入口 | 现在如何选择目标 | 迁移不能丢失的行为 / 当前风险 |
| --- | --- | --- |
| 项目列表/添加 | [`projectsIpc`](../src/main/ipc/projectsIpc.ts#L33-L75) 根据全局 `wslEnabled` 排他过滤项目并决定添加环境；[`ProjectStore.add`](../src/main/projects/ProjectStore.ts#L176-L206) 新建时只存 `path/environment`，按路径去重 | 改设置会隐藏另一类项目；不同 distro 的同路径可能合并。WSL 项目没有可靠的逐项目执行用户；新增项目未保存 distro。 |
| 文件 | [`filesIpc`](../src/main/ipc/filesIpc.ts#L60-L83) 先用当前全局 distro 将 WSL 路径转换为 Windows 路径，再交给 [`LocalProjectFileBackend`](../src/main/files/LocalProjectFileBackend.ts#L45-L68) 和 Node fs | WSL 项目的文件 IO 目前是 Windows 主进程执行，不是 WSL Linux fs 进程；不能因模型整理静默改变 `/mnt`/UNC 下的读写语义，也不能把另一项目的 distro 用作转换参数。 |
| Git/worktree | [`LocalGitBackend`](../src/main/git/GitBackend.ts#L25-L61) 解析本机仓库路径；[`GitService`](../src/main/git/GitService.ts#L185-L205) 在主进程启动 Git。`WorktreeService` 还有字面 `git` 命令分支（[`WorktreeService`](../src/main/git/WorktreeService.ts#L38-L78)） | Windows 运行时现有 WSL 项目走 **Windows Git**，并非 WSL Git。未来是否改为 WSL Git 是单独的行为变更；先验证现有 `/mnt`/UNC worktree、权限及 Git 路径语义。 |
| 项目终端 | [`TerminalSessionManager`](../src/main/terminal/TerminalSessionManager.ts#L263-L320) 按全局 WSL 设置优先选 `wsl.exe -d/-u --cd`，node-pty `cwd` 用 Windows 可访问路径；候选逐个尝试 | WSL 启动失败后当前代码可能回退到 Windows shell。并列模型中项目终端不得静默跨位置回退；显式手选其他 shell 应区别于“项目默认终端”。 |
| Pi runtime | [`PiLocator`](../src/main/pi/PiLocator.ts#L158-L185) 在 WSL 已开启时生成 `wsl://` 命令且探测失败不落回 Windows Pi；[`PiProcess`](../src/main/pi/PiProcess.ts#L383-L388) 仍从全局设置选择可执行文件 | 保留已有 Pi fail-closed 保护；把项目 distro/user 贯穿进启动与恢复，不让切换设置改变其他正在使用的项目目标。 |
| 会话与配置 | [`SessionCatalog`](../src/main/sessions/SessionCatalog.ts#L1423-L1453) 的 origin key 缺 WSL 身份时用可变 `identityContext` 补齐；[`SessionScanner`](../src/main/sessions/SessionScanner.ts#L629-L637) 读取项目/用户设置；[`systemIpc`](../src/main/ipc/systemIpc.ts#L1496-L1527) 改全局配置会重配置单例 | 扫描、修复相对路径、历史去重和 Pi HOME 必须由项目/会话自己的目标决定，不能按“当前 WSL”重写其他项目的 session 身份。Linux `/home` 项目设置读取路径还有 UNC 映射缺口需要实测。 |

[`WslPaths`](../src/main/wsl/WslPaths.ts#L38-L126) 可从 `\\wsl$`/`\\wsl.localhost` 提取 distro，可将 Windows 盘符和 `/mnt/<drive>` 相互转换；**路径可换算不证明运行环境、用户或授权身份**。`/home/<name>` 的目录名也不是执行用户的证据。

## 旧数据认领规则（拟议，未实现）

| 旧记录 | 可信证据 | 默认迁移动作 |
| --- | --- | --- |
| v1 数组项目缺 `environment` 或为 `windows`；v2 native | 记录自身显式为 native 或旧默认 | 保持 native、原 ID、路径、worktree 关联；盘符/UNC 形状不使它自动变 WSL。由 Explorer 注册的 WSL UNC 曾可能被记作 native，疑似项需要显式认领。 |
| `environment=wsl`，路径为 WSL UNC | [`parseWslUncPath`](../src/main/wsl/WslPaths.ts#L38-L47) 可取 distro 与 Linux 路径；user **未知** | 保持原 ID 与路径；仅绑定可信 distro，执行用户待用户确认；若已有 `wslDistro` 与 UNC 冲突，停止并提示，不能任选一个。 |
| WSL `/mnt/...`、`/home/...` 或盘符路径 | 路径没有 distro/user 身份；当前全局 [`SettingsStore`](../src/main/settings/SettingsStore.ts#L174-L177) 可能只是默认 Ubuntu/root 或后改值 | 保留原记录并标“待确认”；不使用当前全局值自动认领，不转 native、不访问错误目标。只有可审计的逐项目或逐会话历史证据、且无冲突时才能辅助确认；没有证据时必须人工选择。 |
| v2 local WSL 已含 `wslDistro` | 发行版字段及一致的 UNC（如存在） | 保留 distro，但 v2 locator 无执行 `user`（[`codec`](../src/main/projects/projectStoreCodec.ts#L108-L122)）；用户待确认，不能从 `/home/u` 推断。v2 SSH 项目当前仍被拒绝，不能伪造 local 路径（[`codec`](../src/main/projects/projectStoreCodec.ts#L74-L85)）。 |
| SessionCatalog v1 / local locator | `entry.id`、`projectId` 与记录内明确的 WSL 字段 | 保持 ID、来源、标题、手动项目分配及 DSH 墓碑；旧 `originKey` 中的 `unknown` 或可变全局 context 都不构成身份凭据。身份未确认时不扫描进当前 distro、不按路径重建另一个 ID。 |
| dismissed-project 路径名单与旧 trust | 仅路径，没有目标和执行用户 | 墓碑在认领前保持有效或隔离成 unresolved，防止被自动导入；旧 `trust=true` 不自动升级为新位置授权，旧拒绝记录也不能被新默认值绕过。用户确认只作用于指定目标。 |

迁移发布必须有预检和确认入口：旧单模式在未启用并存功能前按现有设置继续运行，不提前把未认领项目改写或停用；并存模式启用前提示用户逐项目确认目标。进入并存模式后仍未认领的项目可以显示但不得执行 files/Git/terminal/Pi/session/trust，不能以“保留兼容”为由悄悄回退到全局设置。不能在缺乏交互式认领方案时强制切换所有现有用户。

持久化先保全 primary/backup 和原始字段：[`ProjectStore` persistence](../src/main/projects/projectStorePersistence.ts#L25-L53) 对 v1/v2 选最高有效 revision 且双坏 fail closed。[`SessionCatalog.load`](../src/main/sessions/SessionCatalog.ts#L405-L453) 在 primary/backup 都不可读时仍为保证窗口启动而以空列表继续，但现在会锁住目录写入、返回 `SESSION_CATALOG_NEEDS_REPAIR`，保留两份原文件供修复；主目录为未知未来版本或含字段有效但 locator 类型未知的记录时，即使旧备份可读也不降写。已知 locator 损坏或 JSON 无法解析时仍可从有效备份恢复，无版本历史目录继续可读。尚未将“需修复”状态展示给用户，也没有交互式修复入口，不能将空列表当作历史确实为空。后续位置迁移必须继续保持未知新 locator 不被“丢条目再重扫”。升级现有 v2 结构需双版本 reader 或显式新 schema，不能改变 v2 的含义并自动重写。项目去重/查找当前只有路径（[`ProjectStore`](../src/main/projects/ProjectStore.ts#L176-L214)、[`findByPath`](../src/main/projects/ProjectStore.ts#L363-L367)），旧 dismissed path key 也只有路径，必须一起迁移到带位置作用域的键。

## 首批可执行测试（并列位置新增项仍未实现）

现有基线：运行 `node --test --test-concurrency=1 tests/wslPaths.test.mjs tests/wslPiProbe.test.mjs tests/projectsIpcWsl.test.mjs tests/projectStoreCodec.test.mjs tests/projectStoreMigration.test.mjs tests/projectStorePersistence.test.mjs tests/projectFileTarget.test.mjs tests/gitBackend.test.mjs tests/terminalTargetIpc.test.mjs tests/sessionLocatorRouter.test.mjs tests/sessionScannerWslMaxBuffer.test.mjs`，**64/64 通过**。这证明的是当前全局 WSL 模式的行为及部分 local/SSH 边界，不是并存能力；尤其 [`projectsIpcWsl.test.mjs`](../tests/projectsIpcWsl.test.mjs) 中的旧断言还会固定全局选择流程。

1. **迁移/灾难恢复**：在 [`projectStoreCodec.test.mjs`](../tests/projectStoreCodec.test.mjs)、[`projectStoreMigration.test.mjs`](../tests/projectStoreMigration.test.mjs)、[`projectStorePersistence.test.mjs`](../tests/projectStorePersistence.test.mjs) 扩展 v1/v2、UNC distro 冲突、无用户 `/mnt`、两快照损坏及中断写 fixture；每次重载仍保留原 ID、worktreeParentId、备份和未认领状态，未知位置不执行或覆盖记录。[`sessionCatalog.test.mjs`](../tests/sessionCatalog.test.mjs#L595-L731) 已覆盖目录两份不可读、未来 locator/版本遇到可读旧备份时拒绝降写、损坏已知 locator 可恢复与无版本旧数据兼容；需修复状态的用户可见入口仍待实现。
2. **位置去重**：注册 native `C:\repo`、Ubuntu `/mnt/c/repo`、Ubuntu `/home/u/repo`、Debian `/home/u/repo`；四个项目 ID 各异，重复添加同 `(kind,distro,user,root)` 才复用 ID；切换全局设置、重启后不变。再测同 distro/路径不同用户时是否应分为两个项目（产品决策待确认）。
3. **列表与授权**：行为级 mock `projects:list/add` 同时列出本机与两个 WSL 项目；离线 distro 只影响自身，不删记录；更改全局 WSL 配置不改变已注册目标。WSL 路径从另一发行版伪造、未确认 user、未知 host 都不能触发本地 fs/Git/terminal/Pi。不要只用源码正则证明界面并列。
4. **会话与信任隔离**：沿用 [`sessionIdentity.test.mjs`](../tests/sessionIdentity.test.mjs) 与 [`sessionCatalog.test.mjs`](../tests/sessionCatalog.test.mjs) fixture，同 `/home/u/repo` 跨 distro/user 的 origin 不碰撞；v1 catalog、相对 session path、历史 `unknown`、DSH 草稿、手动分配经重启与反复扫描保留原 ID。旧 dismissed 和 trust 父路径授权不自动串到其他位置。
5. **能力路由/失败关闭**：在 [`filesListTarget.test.mjs`](../tests/filesListTarget.test.mjs)、[`gitBackend.test.mjs`](../tests/gitBackend.test.mjs)、[`terminalTargetIpc.test.mjs`](../tests/terminalTargetIpc.test.mjs) 注入两个 distro 的 fs/Git/PTY spy；Ubuntu 目标离线时不能使用 Debian 或本机目标；WSL 终端 `spawn` 失败不尝试 pwsh/cmd；WSL Pi 探测失败也不能运行 Windows Pi。保留 Windows Git 与 Node fs 的基线，若产品选择改用 WSL Git/FS 则单独设计迁移和新增测试。

以上 fixture 可用临时 userData、mock IPC/execFile/node-pty/fs/Git service 完成，不需要真实 WSL 或 Pi。仍需独立 Windows + 两发行版实机 smoke：`/mnt` 与 UNC 项目文件读写/权限/大小写/回收站、Windows Git/Worktree、`wsl.exe -d/-u --cd` 用户与 cwd、Pi HOME 和会话恢复、全局设置切换后目标不变、发行版关停/改名不回退宿主机。非 Windows 平台须确认 WSL 入口不可执行。此 smoke 尚未进行。
