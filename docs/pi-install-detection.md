# pi 安装检测与多安装选择（状态：已实现，2026-09-30）

## 背景：一个真实事故

用户机器上有 **两份 pi**：

| | 路径 | 形态 |
|---|---|---|
| 终端 `pi` | `~/.pi/agent/bin/pi` | 官方安装器（`curl -fsSL https://pi.dev/install.sh \| sh`）的 managed 安装：启动器脚本 → 读 `~/.pi/agent/install/current-version` → exec `install/releases/<ver>/node_modules/.bin/pi`，并导出 `PI_MANAGED_INSTALL_ROOT` |
| PiDeck 启动的 pi | `~/…/.nvm/versions/node/<ver>/bin/pi` | npm 全局包装 → `lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` |

成因链（逐条验证过）：

1. 官方安装器把启动器写到 `<agentDir>/bin/pi`，并且**只把 PATH 写进当前 shell 的配置文件**
   （bash：有 `~/.bashrc` 就写 `.bashrc`，否则写 `.profile`；见 `install.sh` 的 `shell_config_file` /
   `prompt_add_path_to_profile`）。只有**交互式** shell 会 source 它。
2. GUI 启动的 PiDeck 继承的 PATH 来自桌面会话（`~/.profile` 链路），没有 `~/.pi/agent/bin`。
3. `PiLocator` 的登录 shell 探测是 `/bin/sh -lc`（**非交互**登录 shell，dash 读 `~/.profile`），
   同样读不到 `.bashrc`；而扫描目录里根本没有 `~/.pi/agent/bin`。
4. 于是第一个命中的候选是别的副本（这台机器上是 nvm 里那份）。

后果不只是「显示错了」：**终端 `pi update` 更新的是 managed 安装，PiDeck 的「更新 Pi」`pi update pi`
更新的是 npm 那份**，两边会漂移；环境诊断里的「pi 版本/路径」也不是用户终端用的那个。
更糟的是环境引导把这种情况判成「未安装」，推着用户又装第二份（引导安装写 `npm -g --prefix <userData>/pi-runtime/pi-global`），
而安装器自己的日志早就警告过这种局面（`print_existing_global_pi_not_writable_message`）。

## 目标与边界

目标：

- 官方 managed 安装（含 `~/.local/bin/pi` 这类软链入口）必须能被识别，并带来源标签。
- 检测到 ≥1 份安装 → 启动流程跳过安装引导（不再推着用户重复安装）。
- 检测到 ≥2 份 → 界面列出全部（来源 / 版本 / 路径 / 徽章），用户选定后写 `settings.customPiPath`。

非目标（刻意不做）：

- **不静默改变默认解析优先级**。`~/.pi/agent/bin` 排在版本管理器目录**之后**，只在其他候选都没命中时才生效。
  静默把用户切到另一份安装（可能是旧版）风险大于收益；换装由用户在列表里选。
- 不替 pi 做安装/卸载；不新增 IPC 域；不引入第二条通信通道。

## 实现

### 1）检测：官方给出的每一种装法都要认出来

| 官方装法 | 落点 | 识别方式 |
|---|---|---|
| `curl -fsSL https://pi.dev/install.sh \| sh` | `<agentDir>/bin/pi` + `<agentDir>/install/releases/<ver>` | `managed-install.json` 标记校验 → `managed` |
| `powershell -c "irm https://pi.dev/install.ps1 \| iex"` | 同上（Windows 需 `PI_EXPERIMENTAL=1`，否则走 npm） | 同上 |
| `npm install -g --ignore-scripts …` | npm 全局 bin（含 nvm/mise/asdf/volta/scoop 等前缀） | 目录表 → `package-manager` |
| `pnpm add -g --ignore-scripts …` | `$PNPM_HOME`（默认 Linux `~/.local/share/pnpm`、macOS `~/Library/pnpm`、Windows `%LOCALAPPDATA%\pnpm`） | 同上 |
| `bun add -g --ignore-scripts …` | `~/.bun/bin` | 同上 |
| （yarn global） | `~/.yarn/bin`、`~/.config/yarn/global/bin`、`%LOCALAPPDATA%\Yarn\bin` | 同上 |

主进程（`src/main/pi/PiLocator.ts`）：

- `searchDirEntries()`：目录 + 来源标签（`managed` / `package-manager` / `portable` / `path`），
  `getSearchDirs()` 由它派生 —— 顺序与原来逐条对齐，只是新增了 `~/.pi/agent/bin`（Windows 同路径对称）。
- `resolveManagedInstallRoot()`：与安装器 `managed_install_root_for_command` 语义对齐
  （入口父目录的父目录下有合法 `managed-install.json`；软链按 realpath 解析后重试）。
  只有标记校验通过才算 `managed`，残留/半删目录不会被宣称成官方安装。
- `listInstallations()`：候选按 realpath 去重 → 并行 `--version`（失败保留该条并带 `versionError`）→
  标 `isActive`（与 `resolveCommand` 的结果同源）与 `isNewest` → 稳定排序 → 10s 进程内缓存。
  WSL 模式返回 `[]`（Agent 跑在发行版内，宿主候选不代表用户实际用的 pi）。
- `probeLoginShellPi()`：只在这两种情况下真的跑交互式登录 shell
  （`$SHELL` → `/bin/bash` → `/bin/zsh` → `/bin/sh`，只取 stdout 里存在的绝对路径，过滤 alias 形态输出）：
  ① 用户显式点「从终端再找一次」；② 目录扫描**一份都没找到**时的最后兜底。
  结果只用于列表展示与排序（`shellDefault`），**不参与 `resolveCommand`**；因此常规启动
  不会白付一次交互式 rc 加载的代价。
- `runCheck(..., { quiet })`：列表探测不再为每个失败候选刷 `console.error`。

### 2）自定义导入：用户自己指的那份永远可见可选

- `listInstallations()` 把 `settings.customPiPath`（当前使用）与 `settings.piCustomPaths`（备选池）一并纳入候选：
  它们可能不在任何扫描目录里（稀有/自定义安装），但正是用户实际要用/在用的那几份——不列出来就看不出当前用谁、也切不回去。
  来源标 `custom`（目录不在已知落点时才归到它）；用户添加的条目带 `userAdded`，不存在的带 `missing`。
- 「浏览…」：系统文件选择器挑 pi 可执行文件（`pi:choose-executable`），选完归一化 + 校验 + 入池 + 立即切换。
- 手输路径同样走添加流程（粘贴 → 校验并添加）。
- 详设见下条：设置页已把这两块合并成一块。

### 3）避免重复安装：安装动作本身再挡一次

- `src/main/pi/piInstallGuard.ts`：`resolvePiInstallGuard(installations)` 纯函数——只要本机已探测到任何一份 pi
  就 `skip`，`pi:runtime-pi-install` 直接不执行 `npm install`，把已有安装列表回给渲染层。
- 为什么不能只靠 UI：引导只在「检测没找到 pi」时展示，但检测总有覆盖不到的地方
  （自定义目录、别名指向 JS 源文件、GUI 看不见的 shell PATH）。漏判一次就是用户真的多出一份 pi。
- 引导面板收到 `alreadyInstalled` 后显示「本机已装好 pi，已跳过安装」+ 已有路径列表，并隐藏安装按钮。

### 4）设置页合并为一块「pi 命令来源」面板（2026-09-30）

原先拆成两块：

- 「自定义 pi 路径」：一个输入框 + 浏览/校验并使用/清除，**只能存一条**，存进去看不出它与别的关系；
- 「检测到的 pi 安装」：另一个列表 + 又一组浏览按钮。

同一个动作出现在两处（见面就不知道看哪个），且两块说明文字在讲同一件事。合并后：

- **一块列表**：自动发现的与用户自己添加的分两组，来源只是行上的标签；点一行 = 切换为当前使用。
- 每行带版本、路径、来源、状态（当前使用/终端默认/较新/较旧/路径不存在）。
- **添加**：粘贴完整路径或「浏览…」选文件，校验通过后入池并立即切换使用（产品确认的默认行为）。
- **编辑/移除**只对用户自己添加的行开放（自动发现的是系统事实，不给改）；移除当前使用项时主进程
  一并清空 `customPiPath`，解析回落到自动检测首选，并提示用户。
- 列表头承担「重新检测 / 从终端再找一次 / 重置检测标记」；顶部状态行只留版本摘要与
  「检查 Pi 更新 / 更新 Pi」（不再有第二个检测入口）。

数据模型（不动既有语义）：

- `settings.customPiPath` **仍是唯一生效指针**（主进程有 26 处读它：启动/更新/扩展/模型探测/登录助手…），
  不改成数组。
- 新增 `settings.piCustomPaths: string[]`：仅“备选池”，用于列表展示与切换；
  写入前经 `sanitizePiCustomPaths`（绝对路径或 `wsl://`、去重、限额 20、超长丢弃）。
- IPC：`pi:installations`（列表，含 `userAdded` / `missing` 标记）、`pi:set-custom-paths`（存池）、
  `pi:check-custom`（多一个 `activate=false` 的“只校验不切换”，供编辑备选路径用）、`pi:choose-executable`（文件选择器）。
- 用户添加但**已不存在**的路径仍然列出（`missing: true`）：行会静默消失的话，用户既看不到也无法修/删。

契约 / IPC / UI

- `utils/piInstallationOptions.ts`：纯映射（徽章优先级、来源/徽章/版本文案 key、是否需要选择）。
- `hooks/usePiUpdate.ts`：`piInstallations` / `piInstallationsProbing` / `loadPiInstallations` / `choosePiInstallation`；
  `validateCustomPiPath` 支持显式 `path`（列表点击是异步的，不能依赖 state）。
  **多份安装时不自动关弹窗**（`canAutoClose = installations.length <= 1`）。
- `components/app/PiCommandSourcePanel.tsx`：弹窗与设置页共用的列表（Tailwind utility，无新增手写 CSS class）。
- 弹窗（`overlays/OverlayComponents.tsx`）与设置页开发 tab（`settings/DevTab.tsx`，进 tab 即拉一次）两处入口。

### 5）引导安装的便携副本（POSIX 三个既有缺陷，本次一并修掉）

引导安装把 Node 与 pi 装在 PiDeck 自己的数据目录（`<userData>/pi-runtime/`），**不写系统环境**；
代价是终端里默认敲 `pi` 找不到它（设计如此，不修）。但 Linux/macOS 上它之前根本用不起来，
三个缺陷都是从「POSIX 比 Windows 多一层 `bin/`」衍生出来的：

| 缺陷 | 现象 | 修复 |
|---|---|---|
| 便携 pi 入口目录少 `bin/` | 引导装完 → 「重新检测」还是说没装 → 又引导你再装一遍 | `PiLocator.getSearchDirs()` 改为 `<pi-runtime>/pi-global/bin`（Windows 保持根目录） |
| 便携 node 可执行路径少 `bin/` | 引导第 1 步永远显示未安装；再点安装报 `extracted node is not executable` | 路径由新模块 `src/main/pi/piRuntimePaths.ts` 统一给（含 `piRuntimeNodeBinDir()`，PATH 前缀与 npm 定位共用） |
| 便携 npm/npx/corepack 悬空 | `bin/npm` 指向已删除的 `/tmp/pideck-node-extract-*`（便携 npm 不可用，无系统 npm 的机器卡在第 2 步） | `moveDirContents` 的跨设备回退改用 `copyDirEntryVerbatim`（`cpSync` 必须带 `verbatimSymlinks: true`，否则相对软链被解析成绝对路径）；已装坏的副本由 `repairPortableNodeLinks()` 自愈 |

`piRuntimePaths.ts` 是这三处路径的唯一来源（只依赖 `node:path`，零 Electron 依赖）——
PiLocator 会在裸 Node 沙箱里被加载，不能把便携 Node 安装器整条依赖链拖进检测链路。

验证证据（实机，Linux）：修复前 `listInstallations` 只能看到 nvm 那份；修复后能看到
`~/.config/PiDeck/pi-runtime/pi-global/bin/pi`（来源 `portable`，版本 0.87.1）。
自愈后 `~/.config/PiDeck/pi-runtime/node/bin/npm --version` → `11.6.2`。

### 6）更新能力的版本门槛与结果核验（2026-10-05）

「能直接执行 bash」「能流式返回 bash 输出」「能自更新 pi」是三种不同能力，不能共用版本门槛：

| 能力 | 最低版本 | 官方依据 |
|---|---|---|
| RPC 直接执行 bash（`type: "bash"`） | 0.14.0 | [0.14.0 发布说明](https://pi.dev/changelog/releases/0.14.0) |
| RPC bash 的 `bash_execution_update` 流式事件 | 0.82.0 | [0.82.0 发布说明](https://pi.dev/changelog/releases/0.82.0) |
| pi 自更新（`pi update --self`） | 0.70.3 | [0.70.3 发布说明](https://pi.dev/changelog/releases/0.70.3) |

PiDeck 的设置页更新走主进程的 Node `execFile` + `PiLocator` 平台适配，不走会话 RPC bash。
改走会话 bash 会额外依赖活跃会话、影响会话历史，并不能消除底层包管理器或网络失败，因此不因缺少流式事件强制升级 pi。

- **自更新**：pi ≥ 0.70.3 使用 `pi update --self`；低于门槛、门槛版本的预发布版或版本未知时，提示用原安装方式手动升级后重新检测，不猜测 npm/pnpm 命令、不另装第二份。
- **扩展更新**：支持自更新的版本使用 `pi update --extensions`，更旧版本保留只更新包的 `pi update`；版本未知时先要求重新检测，避免把新版本的裸 `update` 误当成只更新扩展。
- **更新目标**：检查、执行、结果核验使用同一份安装设置快照；执行后失效版本缓存并重新检测该安装。退出码 0 但版本未达到检查时的目标版本，仍返回失败，不显示「更新成功」。
- **失败信息**：更新检查的网络失败不能当成「无需更新」；命令失败保留有长度上限、已脱敏的 stdout/stderr 与错误详情，便于区分网络、代理、权限或安装来源问题。扩展更新部分失败时也失效列表缓存。

#### 更新通道分派（2026-10-13）

通道由选中 pi 的**可执行路径形状**判定（`src/main/pi/piSelfUpdateChannel.ts`，零依赖纯函数）：

| 通道 | 触发形态 | PiDeck 实际执行 | 关键点 |
|---|---|---|---|
| `pi-self` | npm/pnpm/yarn 全局、官方 managed、homebrew、WSL、裸命令名 | `pi update --self` | WSL 的运行时命令形如 `wsl -d <distro> -u <user> <pi 路径>`（不是 `wsl://` 标记），一律交回发行版内的 pi 自己更新，绝不能用宿主包管理器代跑（会把 pi 装到 Windows 上） |
| `bun-global` | `…/.bun/bin/pi` 或 `…/install/global/node_modules/…` | `bun install -g --ignore-scripts [--minimum-release-age=0] <pkg>@<ver>` | bun 本体从**安装根** `<root>/bin` 推导（不是与 pi 入口同目录：Homebrew/scoop 的 bun 本体在别处，软链解析后的包路径下更不存在）；推导路径不存在时回退裸 `bun`；`<root>` 作为 `BUN_INSTALL` 传给子进程；年龄门开关只在 `bun --version` ≥ 1.3 时附带（1.3 才引入，老 bun 拒绝未知参数） |
| `portable-prefix` | `<userData>/pi-runtime/pi-global/…` | `npm install -g --ignore-scripts --min-release-age=0 <pkg>@<ver> --prefix <prefix>` | pi 的 npm 自更新在 Windows 不推断前缀，必须显式 `--prefix`，否则装到用户真实全局目录、前缀副本原地不动 |

- **源未同步提示**：失败输出命中 npm `ETARGET`/`notarget` 或 bun `No version matching` 时追加排查提示（文案已用真 bun 1.4.3 实测校准）。PiDeck 亲自代跑的通道给与代跑同源的命令 + `--registry=https://registry.npmjs.org`；`pi-self` 通道只给「把 registry 指向官方源」的建议、不给命令（npm/pnpm/yarn/brew/managed 都在这档，写死 npm 会在别的目录另装一份）。
- **发布年龄门提示**：bun 的 `blocked by minimum-release-age`、npm 的 `… with a date before …` 命中时给「放宽年龄门」的提示（bunfig `minimumReleaseAge` / npm `min-release-age`，或重试时加 `--minimum-release-age=0` / `--min-release-age=0`）。这两类先于镜像提示判定：年龄门文案里也含 `No version matching`，不先判会把「版本已发布但被年龄门拦下」误诊成镜像滞后（实测：配了年龄门时镜像重试命令会再次被拦下）。
- **已知局限**：自定义 `BUN_INSTALL` 的 shim 路径（`<root>/bin/pi`，路径里既无 `.bun` 也无 `install/global/node_modules`）无法与其它全局安装区分，归 `pi-self`；POSIX 上 pi 自己能更新，Windows 上受 pi 自身的 npm/pnpm gate 限制（默认 `~/.bun` 布局不受影响）。
- **提示里的路径不脱敏**（唯一的失败输出例外）：`--prefix` 要能直接粘贴执行，脱敏后的 `<user>` 在 shell/CMD 里都不是路径；该路径是 PiDeck 自己的 userData/pi-runtime 目录，不涉及用户数据。
- **提示与代跑同源**：命令由 `npmGlobalInstallArgs` / `bunGlobalInstallArgs` 一处生成，避免「代跑加了 flag、提示里还是旧命令」的漂移。

### 7）一键安装（2026-10，环境检测弹窗重做）

旧弹窗把安装拆成 Node / npm / pi 三个子按钮，叠在 4 步 stepper（安装 Pi / 确认路径 / 验证权限 / 完成）下面：
用户既不知道该先点哪个，也看不出点完会发生什么，「验证权限」甚至在流程里并不存在。现在未安装态只有一个主动作：

- **面板**：`components/overlays/EnvironmentSetupPanel.tsx`。一张主卡（Node.js / npm / Pi CLI 三行状态 + 「一键安装」+ 镜像开关），
  下挂两个默认收起的 Collapsible——「我已经装过 Pi，但没被检测到」（`where pi` + 路径输入 + 校验）与
  「手动安装 / 查看检测详情」（可编辑命令 + 输出 + 检测报错 + 已搜索目录 + 安装文档）。
  已安装态仍是「检测通过」卡 + 多份安装选择（`PiCommandSourcePanel`）。stepper 与旧 `env-guide-*` / `env-install-*` 样式一并删除。
- **编排**：`renderer/src/utils/piOneClickInstall.ts` 的 `runPiOneClickInstall()`（纯函数，可单测）：
  检测 Node → 确认 npm → 安装 pi → 重新检测。`renderer/src/hooks/usePiEnvironmentGuide.ts` 只把结果落进 React 状态。
- **不用内置 node/npm 的底线**：系统 Node 或已装的便携副本任一可用就跳过下载；**只有系统完全没有 Node** 才下载便携副本；
  系统有 Node 但 npm 缺失（精简安装/损坏）时，才补装一次便携 Node 并重试 npm。主进程的搜索目录本就把系统目录排在便携目录之前。
- **安装命令**：仍走 `pi:runtime-pi-install`（主进程收紧通道，先真全局 `npm install -g`，布局性失败才回退 `--prefix <userData>/pi-runtime/pi-global`），
  渲染层只传 `useMirror`；面板不拼命令，手动区执行的命令也是经同一 `pi:exec-install` 通道。
- **重新检测**：复用 `usePiUpdate.checkPiInstall("manual")`（返回 `PiInstallStatus`），由 App 注入给引导 hook——
  装完立即重跑完整环境检测，面板据 `installed` 切到「检测通过」，不再有「装完还要自己点重新检测」这一步。
  检测口径只有一处，避免引导页与主流程各判一次。
- **失败文案**：`node-unsupported` / `node-prepare` / `npm-missing` / `pi-install` / `pi-undetected` 映射成可执行的一句话；
  `pi-undetected`（装完 PATH 里仍找不到 pi）直接提示去展开「我已经装过 Pi」指定路径或看手动输出。
- **测试**：`tests/piOneClickInstall.test.mjs`（15 例：跳过/回退/失败分支、镜像透传、已有安装、重检失败、刚装完便携 Node 仍无 npm 不重复下载）、
  `tests/dialogLinkMode.test.mjs`（nodejs.org 外链仍强制系统浏览器）、`tests/environmentDialogScroll.test.mjs`（限高滚动不回退）。

### 8）不装 pi 的替代路径：DSH 运行时 + 默认后端自动选择（2026-10）

环境检测弹窗原来只讲 pi，只装 DSH 的用户会被反复提示「没有 pi」，而且 DSH 装好也不会成为新会话的默认后端。现在：

- **提示**：未安装态主卡下方是 `EnvironmentSetupPanel` 的 DSH 卡（`environment.dshTitle`），按 `dshRuntimeStatusAtom.state` 分派文案：
  未装/损坏/版本不符只给「安装/重装 DSH 运行时」，已装且不是默认后端给「改用 DSH 后端」，已装且是默认只给「管理 DSH 运行时」。
- **跳转**：安装/修复一律 `closeEnvironmentDialog()` + `store.set(openSettingsAtom, DSH_INSTALL_SETTINGS_TARGET)`
  （`utils/dshRuntimeHint.ts` 的 `{ tab: "common", pane: "config", backendPane: "dsh" }`）——未装时这一页就是安装引导，已装时是版本/目录/卸载管理。
  关窗在前，避免两层弹层叠压。
- **自动默认后端**：`resolveAutoAgentBackend({ piInstalled, dshState })`（`shared/types/dshRuntime.ts`，纯函数）只有
  `dshState === "installed" && !piInstalled` 才回 `"dsh"`，其余（含 checking/broken/outdated）一律 `"pi"`——与
  `resolveEffectiveAgentBackend` 的回落口径一致，避免写了 dsh 又被运行时挡回 pi 来回抖动。
  `renderer/src/hooks/useAutoDefaultAgentBackend.ts` 在 App 里装配：`piInstalled = piStatus ? piStatus.installed : Boolean(settings.piInstall)`
  （检测未完成时用持久化缓存顶一下，避免启动瞬间误判成「只有 DSH」）。
- **用户可改，且改了就不再被改写**：设置项 `defaultAgentBackendManual`（缺省 false = 自动）。设置页手选后端时同时置 true；
  环境检测里点「改用 DSH 后端」也会置 true，并把 `piEnvironmentChecked` 置 true——只装 DSH 的用户不会每次启动都被弹「没有 pi」。
  主进程 `SettingsStore.update` 只接受布尔值，非法入参丢弃（安全阀：否则自动选择可能被锁死）。
- **测试**：`tests/dshRuntimeStatus.test.mjs`（`resolveAutoAgentBackend` 五组：只有 dsh / 都有 / 只有 pi / 都没有 / checking·broken·outdated 不算已装）、
  `tests/autoDefaultAgentBackend.test.mjs`（默认 manual=false、老配置兼容、manual=true 落盘保留、非布尔入参不写盘、设置页与 App 接线契约）。

## 验证

```bash
npm run typecheck
node --test tests/piLocatorInstallations.test.mjs tests/piInstallationOptions.test.mjs \
  tests/piInstallGuard.test.mjs tests/piLocator.test.mjs tests/piLocatorLoginShell.test.mjs
```

### Windows 真机 smoke（2026-10-13）

上述单测在 Linux 宿主上用夹具模拟 win32；启动通道与 bun / npm 前缀 / WSL 更新通道的五个 Windows 形态
（2026-10 复审遗留项）由 `scripts/smoke-pi-windows-launch.mjs` 在真 Windows 上验证（人工触发，不进 CI）：

| 覆盖 | 断言要点 |
|---|---|
| cmd 包裹 | npm `pi.cmd` 走 node-direct 真跑 `--version`；非 npm `.cmd` 回退 `cmd.exe /d /s /c`（windowsVerbatimArguments），含空格/引号/`&` 的 11 个参数原样到达；`.cmd`/`.exe` 参数预算 5000、node 直启 26000 |
| pi.exe shim | bun 生成的 `<root>\bin\pi.exe` 能被 `normalizeCustomPath` 补全、`check()` 真跑出版本 |
| 自定义 BUN_INSTALL | `<root>\bin\pi.exe` 先归 `pi-self`，靠 `<root>\install\global\node_modules` 细化为 `bun-global`；`PiSelfUpdateRunner.update()` 真调 pi.dev 最新版 → bun 代跑带 `BUN_INSTALL` 与 `--minimum-release-age=0` → 1.1.0 → 1.2.0，`~/.bun` 前后一致 |
| portable-prefix | 真跑 `npm install -g --prefix <prefix>` 装出旧版与 `<prefix>\pi.cmd`，再经 `PiSelfUpdateRunner.update()` 真跑 npm 代跑（命令行带 `--prefix <prefix>`）原地更新到最新版 |
| WSL / UNC | 真探测 + `wsl.exe -e /usr/bin/env PATH=… <pi> --version`；运行时召唤串与 `\\wsl.localhost\`、`\\wsl$\` 一律 `pi-self` |

本机实测（Windows 10.0.26200 / bun 1.4.3 / npm pi 1.2.0 / WSL Ubuntu-26.04）：**11/11 通过**。
脚本在 `%TEMP%\pideck win smoke` 内自建隔离环境（路径刻意带空格），不写系统目录、不动 `~/.bun`、
不更新 WSL 里的 pi（只读版本）；`--clean` 清空临时根，`PIDECK_SMOKE_BUN` 可指定已有 bun。

这次真机 smoke 顺带抓到一个 Windows 缺陷（已修 + 回归测试 `tests/piLocator.test.mjs`）：npm 12 的
`npm.cmd`/`npx.cmd` 改用变量式垫片（`SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"` +
`"%NODE_EXE%" "%NPM_CLI_JS%" %*`），旧的「全文取第一个 `node_modules\…js`」会抓到变量赋值里的
`npm-prefix.js`：设置里把 npm 命令填成绝对路径的用户，扩展版本/源查询、旧前缀副本更新与引导安装
会跑成「打印前缀」——退出码 0 却什么都没装。现在只在**实际执行行**（含 `%*`）上认入口，这类无法
静态确定目标的垫片回退 `cmd.exe` 跑真实垫片。

两条真机事实（决定 UNC 行为边界，不是缺陷）：

- `\\wsl.localhost\<distro>\…` 经 9P **看不到 Linux 符号链接的目标**（`existsSync` 对 npm/bun 全局 pi 的软链返回 false；目录与普通文件正常），而两种全局安装的 pi 恰恰都是软链；
- Windows 不能从 UNC 执行 ELF（`execFile` 报 ENOENT、cmd 报找不到路径）。因此 UNC 形态的 WSL pi 过不了 `locator.check()`，`refineChannelForCustomBunRoot` 的磁盘细化也不会把它翻成宿主 bun——守卫是双保险。

## 后续可做（本次未做）

- **便携 node 版本 / 启动用哪个 node**：当前 PiDeck 拉起 pi 时用的是 PATH 里的 node（或与 shim 同目录的 node）。
  本机存在多个 node（nvm/mise/asdf/volta/brew/便携）时，尚未提供「用哪个 node 跑 pi」的选择。
- 引导安装目前固定用 npm 装到 PiDeck 自己的数据目录（`<userData>/pi-runtime/pi-global`，不写系统环境、不用提权）。
  若要让用户选择官方安装器那两种方式（curl / PowerShell 远程脚本），需单独决策：那会把「执行远端脚本」
  引进来，安全面与现在完全不同。
- 若将来 pi 在 Windows 把 managed 安装转为默认（现为 `PI_EXPERIMENTAL=1` 才启用），
  Windows 侧的启动器名/落点要按官方安装器再确认一次（当前按 `<home>/.pi/agent/bin` 对称实现）。
- 官方安装器的 PATH 写法定位于交互式 shell，属于上游行为；PiDeck 侧已用「扫目录 + 显式 shell 反查」绕过。
