# WSL 项目 IO 走发行版内执行（对照计划）

> 状态：**Wave 0 已合入；Wave 1a 代码完成（未提交，待真机验证）**。本文是实现对照表与合并门禁，不是已完成的能力清单；
> 每 wave 合入后更新顶部状态行与该 wave 的「已合入」标记。相关既有规划：
> `docs/project-location-architecture.md`（Proposed，位置模型，第 11 步已落、第 14 步未落）、
> `docs/remote-file-tree-and-git-unification-plan.md`（W0–W6，文件/Git 的 target 收口口径同源）。

## 攻击掉的前提

PiDeck 今天假设「`\\wsl.localhost\<distro>\…` 是 Windows 主进程也能直接读的投影」。这句话对
**档案用户 ≠ 发行版默认用户** 的情形不成立，且与文件属主无关：

| 实测（Debian，默认用户 `debian`） | 结果 |
|---|---|
| `ls //wsl.localhost/Debian/root` | `Permission denied`（`drwx------ root:root`） |
| `cat //wsl.localhost/Debian/root/.bashrc` | `Permission denied` |
| `/tmp/pideck-perm-root`（root 建、`chmod 700`） | Windows 侧 `Permission denied` |
| `/tmp/pideck-perm-debian`（debian 建、`chmod 700`） | Windows 侧 **可读** |

结论：9P 一律按发行版**默认用户**鉴权；`wsl.exe -u root` 只影响 `wsl.exe` 那一条命令，
改不了 Explorer/Node fs 看到的身份。因此 root 档案的 Windows 侧读取面必须**在发行版内执行**。

第二句被攻击掉的前提：内置目录选择器只解决「选得出」，不解决「读得到」，单独做它等于在同一道
门禁上写第二次修复。所以选择器与文件读取面在同一份计划里分 wave 交付。

## 目标 / 非目标

**目标**：WSL 项目按档案 `distro + user` 在发行版内完成 目录浏览 → 添加 → 文件树 → 读写。
**非目标（本轮）**：会话正文读写、Git 的 fs 侧副作用、项目存在性徽标、markdown 本地图（Wave 2/3）；
不可路由的宿主能力（资源管理器显示、外部编辑器、拖到 Explorer）按 ADR 明确禁用并说明原因，**不假装能工作**。

## 架构决定

1. **项目内文件域复用远端 helper，不新写脚本语言方案。** 协议、方法词汇表、NDJSON 客户端
   （`RemoteControlClient`，其 `send`/`handleLine` 与 transport 无关）全部照用；WSL 只是
   把同一个 helper 跑在 `wsl.exe -d <distro> -u <user>` 的 stdio 上，`--root <项目 Linux 路径>`。
   理由：`ProjectFileBackend` 已声明 `list/search/readContent/writeContent/create/delete/rename/copy/move/stat/pathsExist`
   这组语义（`src/main/files/ProjectFileBackend.ts:3`），一次性 `sh` 脚本方案在递归目录页与正文搜索上要
   N 次 `wsl.exe` spawn（冷启 ~100–300ms），抽屉与搜索必卡。
2. **目录选择器用一次性 `sh`，不用 helper——这是形状决定的终态，不是权宜。** helper 的 `--root` 按设计拒绝
   文件系统根（`RemoteHelperEntry.ts` 的 `isAbsoluteRoot`：末字符为 `/` 即 `ROOT_INVALID`），而选择器是
   **还没有项目根**时的操作（要从 `/` 往下逛），二者语义冲突；且一次导航只需一个目录的 `maxdepth 1`，
   常驻 helper 零收益。**不为 WSL 放开 `--root /`**：那等于给不受信的远端主机一起削弱 containment 保证。
   一次性 `sh` 沿用 `WslPiConfigStore` 的纪律：`-d <distro> -u <user> --exec /bin/sh -c <SCRIPT>`，
   **路径走 stdin 不进脚本**（`&`/空格/引号/`$( )` 都不成为命令语法）。
3. **bundle 身份共用、部署 ceremony 不走。** `REMOTE_HELPER_ARTIFACTS`（7 个文件 + name/source/sha256，
   `RemoteHelperEntry.ts:270`）与 content-addressed 目录名是同一对象；SSH 侧那套 bootstrap
   staging/lock/WebCrypto 是为**不受信主机**设计的，WSL 是本机受信 FS，直接按声明写文件并在写前
   本地校验 sha256 即可。**不得**为此再造第二个 bundle 清单。
   部署目录形状不是可选项：`readDeployFacts` 要求 `…/bundles/<64hex>/helper.mjs`，deploy root 为
   `$HOME/.pideck/remote-host`（root 档案即 `/root/.pideck/…`），目录 0700、文件按声明 mode。
4. **node 定位复用 `wslPiProbe`**：`buildWslPiProbeScript` / `parseWslPiProbeOutput` 已解析出
   `nodeBinDir`（nvm/fnm/volta/mise 全在这条路上），启动口径沿用
   `-e /usr/bin/env PATH=<nodeBin>:<WSL_PI_BASE_PATH> node …`。helper 依赖 `process.getBuiltinModule`
   （node ≥ 22.3），部署时探测版本，不够就回稳定码。
5. **路由按项目身份，不按路径形状。** 今天 `gitWsl.ts:60` 是按 `\\wsl.localhost` 字符串嗅探决定走不走
   wsl——root 档案下 Linux 路径形式入库会被当宿主 git 跑。files 侧的接缝是
   `ProjectFileBackendRouter.forProject`（今天只认 `kind:"local"`，而 WSL 正是 `kind:"local"` +
   `environment:"wsl"`），在此按 `locator.environment` 分派，渲染层**不改**（`projectServices.ts:48`
   「UI 唯一允许知道本地/远端」这条纪律不能被破坏）。
6. **不破坏 UNC 可读的多数用户（合入门禁的一部分）**：helper 不可用（无 node / 版本过低 / 发行版未启动）时，
   Windows 侧 `readdir` 能读通的项目**保持今天的 local backend 行为**；读不通时才给可解释错误。
   即：新链路失败不许把老链路能用的人一起拖倒。
7. **写侧只在发行版内做原子替换**：跨 9P 的 `rename` 不是原子的（既有结论，`WslPiConfigStore.ts:14-17`），
   中途崩溃会留半份文件。

## Wave 表与门禁

| Wave | 交付 | 合并门禁 |
|---|---|---|
| **0** | 一次性 `sh` 目录浏览（`WslDirectoryBrowser`：`wsl.exe -d <distro> -u <user> --exec /bin/sh -c <脚本> pideck-dir <path>`，路径是独立 argv，绝不进脚本语法；上限与 SSH 浏览同为 300 条，共用同一句「目录过多」文案）；新增 `projects:list-wsl-directory` / `projects:add-wsl-path`（三处同步）并退役 `projects:add-wsl`（系统对话框链路）；`ProjectStore.chooseAndAdd()` 去掉 WSL 参数——不再把不可达的 UNC 甩给系统对话框；渲染层 `DirectoryBrowser`（SSH 与 WSL 共用一个浏览器，来源由调用方注入 `load`/`describeError`）+ `WslProjectPickerDialog`，入口分流在 App 的 `addProject()`（`wslEnabled` 时开选择器）与连接页档案行（按档案 id 打开） | `npm run typecheck` + `node --test tests/wslDirectoryBrowser.test.mjs tests/wslPaths.test.mjs tests/wslProjectAddContract.test.mjs tests/remoteDirectoryBrowser.test.mjs` + `npm run check:ipc-wiring`；真机 root 档案能列出并添加 `/root/…`；Windows 模式对话框行为逐字不变 |
| **1a** | helper 在发行版内的部署+会话（`WslHelperSession`，`--root <项目 Linux 路径>`）；files 读侧收口：`filesList`/`filesDirectoryPage`/`filesSearch*`/`filesReadContent`/`filesReadBase64`/`filesStat`/`filesPathsExist` 经 backend 分派；WSL 项目走 `WslProjectFileBackend`；读边界（realpath/symlink）由 helper 侧 `fs.stat` 语义承担 | 同一棵 fixture 树 → 与 `LocalProjectFileBackend` **同形状**（含 `truncated`、隐藏/生成目录规则）；typecheck + 文件域针对性测试 || **1b** | files 写侧：`writeContent`/`create`/`delete`/`rename`/`copy`/`move` 走 helper 新方法（协议 + contract + client + helper 源，**同时更新 SSH 侧 parity**） | helper 契约测试双 transport 通过；禁止只为消红而弱化既有断言 |
| **2** | 会话正文读写/导出、项目存在性、markdown 本地图 | 大会话分块读语义不回退（见 CHANGELOG 超大会话条目） |
| **3** | Git 的 fs 侧副作用 + 把 gitWsl 的 UNC 嗅探改为按项目身份；不可路由项 fail-closed + 文案 | 现有 git 测试全绿；`-X theirs/ours` 禁用 |

## 能力 parity（Wave 0+1 视角）

| 能力 | 今天 | Wave 0 | Wave 1 |
|---|---|---|---|
| 添加项目（WSL） | 系统对话框 + 不可达 defaultPath（本次故障） | 内置发行版内浏览 | 同 |
| 文件树 / 搜索 / 读 | Node fs 读 UNC（root 档案 EACCES） | 不变（Wave 0 不动读取面） | helper |
| 文件写 / 建 / 删 / 改名 | Node fs 写 UNC | 不变 | helper 内原子替换 |
| 会话列表 | 已 wsl.exe | 不变 | 不变 |
| git 命令 | 已 wsl.exe（按 UNC 字符串嗅探） | 不变 | 不变（Wave 3 改身份驱动） |
| 资源管理器显示 / 外部编辑器 | UNC 交外部进程 | 不变 | 不变（Wave 3 禁用+说明） |

## 文案与 i18n

新增 key 只进 zh-CN 词典，改完必须 `node scripts/genZhTwCopy.mjs` 重生成四份 `*.zh-TW.ts`（铁律 9）。
错误一律稳定码 + 可行动文案，参照 `project.wslPathNotFound`、`wsl.connectionFailed` 的既有口径。

## 验证

- 每 wave：`npm run typecheck` + 该域针对性单测（不跑全量 `npm test`，不跑全量 `npm run build`）。
- 真机：root 档案的 Debian 上「添加项目 → 进入 /root → 选中 → 文件抽屉能列出 → 编辑保存」。
- 回归：`wslUser` 为普通用户的档案（UNC 本就可读）行为逐字不变。

### Wave 0 遗留（不是本 wave 引入，勿顺手改）

- `tests/unifiedApiChannelSnapshot.test.mjs` 的快照常量在 HEAD 就已过期（表内 808/92，实际 811/93）。
  Wave 0 只让 `projects:*` 净 +1（新增 2、退役 1），刷新快照要把他人未入账的通道一起认领，
  属于公共汇聚文件的写者决策——留给用户指定由谁刷。`npm run check:ipc-wiring`（机械三处同步）为绿。
- `npm run check:format` 在本 wave 前已有 11 个文件不合规（`SettingsStore.ts`、`CommonTab.tsx`、
  `mainProcessCopy.ts:412` 等）。只对本次新增/改写的文件跑过 `biome format --write`，没有整仓格式化。
