# DSH Runtime 独立化与按需安装方案（AgentRuntimeProvider）

> 目标：把 DSH runtime（28 个 `@deepseek-ai/*` 依赖）从 PiDeck 安装包中拆出，改为**用户按需下载、可配置、可独立升级**的托管组件；并将「agent 后端 runtime 管理」抽象为 `AgentRuntimeProvider`，为后续更多 agent 后端接入 PiDeck 提供统一插槽。
> 参考：flowix（Tauri 应用）将 dsh host 独立为 `dsh-flowix-host` 组件、按需获取的做法。
> 非目标：不改 dsh 深融合架构（utilityProcess + ApiProxy IPC 桥）；不改 pi 现有链路；不做「同一会话中途换引擎」。

**状态：** 方案待评审，未实施。

---

## 1. 背景与动机

### 1.1 现状量化（2026-08-30 实测，v0.7.2）

| 项目 | 数值 |
|------|------|
| 安装包内 `@deepseek-ai` payload | 约 26MB（app.asar 内 ~19MB + asar.unpacked ~7MB，1877 个文件） |
| 安装包总体积（win-unpacked） | 510MB |
| dev 环境 `node_modules/@deepseek-ai` | 199MB |
| package.json 中 dsh 相关依赖 | 28 个，全部锁定 `0.1.1-rc.2` |
| PiDeck 侧 dsh 桥接代码 | `src/main/dsh/` 28 个模块 + hostEntry chunk + 渲染层 DSH 配置/会话 UI |

### 1.2 动机（按强度排序）

1. **心智负担**：只用 pi 的用户（预期是大多数）在设置里看到完整 DSH Tab（供应商/模型/插件/凭据），新建会话时看到 DSH agent 选项，全部是噪音。未安装态下这些 UI 应当整体消失，只留一个「安装 DSH 后端」入口。
2. **版本解耦**：dsh 处于 rc 快速迭代期。当前每次升级 dsh 都必须发布新版 PiDeck；独立 runtime 后 dsh 升级走独立通道，app 版本节奏不被绑死。
3. **多 agent 扩展性**：PiDeck 的定位是「多 agent 桌面工作台」。后续任何 agent 后端接入都应复用同一套「声明 → 可用性检查 → 按需安装 → 解析启动」机制，而不是每个 agent 都往包里塞 runtime。
4. **形态对称**：pi 后端本就是外部命令（`PiLocator` 解析用户自装 pi，支持 WSL）。dsh 内嵌反而是不对称的；独立化后两个后端在 runtime 管理上统一。
5. **包体积**：~26MB（约 5%）+ dev 侧 199MB 安装时间。是最弱但仍然真实的收益。

### 1.3 关键技术事实（已核查）

- dsh runtime **不是单个 CLI**，而是 28 个必须版本对齐的 npm 包；PiDeck 侧的 `hostEntry.js`（由 electron-vite 独立 chunk 打进 `out/main`）通过 `bareModuleBaseUrl`（即 `--dsh-node-modules` 参数）从 node_modules 解析这些包。
- **接缝天然存在**：`DshHost` 构造时 `require.resolve("@deepseek-ai/dsh-base/package.json")` 定位 appRoot 并传入 `--dsh-node-modules`。把这一解析改为「优先指向外部 runtime 目录」即可外置，hostEntry 侧零改动。
- 本地构建包 `dsh-tool-pwsh-persistent`（packages/）与 `dsh-bill` 同样被 hostEntry external，属于 runtime payload 的一部分，打包脚本需一并收入。
- electron.vite 对 `@deepseek-ai/*` 的 external 规则保持不变（hostEntry 仍随 app 打包）。

---

## 2. 目标架构

```
┌─ PiDeck 安装包（不含 dsh runtime）────────────────┐
│  App 核心 + hostEntry chunk + dsh 桥接代码        │
│  ┌─ AgentRuntimeProvider 注册表 ──────────────┐   │
│  │ pi  : external-command（用户自装，现状即如此）│   │
│  │ dsh : managed-download（按需下载安装）       │   │
│  │ ... : 未来 agent 后端，同一插槽             │   │
│  └────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
        │ 首次使用时
        ▼
userData/runtimes/dsh/<version>/{manifest.json, node_modules/...}
```

### 2.1 AgentRuntimeProvider 契约（shared/types/runtimeProvider.ts）

```ts
interface AgentRuntimeProvider {
  id: string;                       // "pi" | "dsh" | ...
  displayName: string;
  kind: "external-command" | "managed-download";
  /** 可用性：external-command 探测命令是否存在；managed-download 探测 runtime 是否已安装且版本兼容 */
  availability(): Promise<RuntimeAvailability>;
  /** 仅 managed-download：下载 → 校验 sha256 → 解压 → 原子落位 → 写 manifest */
  install?(progress: (p: RuntimeInstallProgress) => void): Promise<void>;
  /** 解析启动锚点（pi: 命令行；dsh: runtime node_modules 目录 + hostEntry 参数） */
  resolve(): Promise<RuntimeResolution>;
}
```

阶段 1/2 先在 dsh 域内实现该形态（`src/main/dsh/runtime/`），阶段 3 提升为通用注册表；避免一开始就过度抽象。

---

## 3. 阶段拆分

### 阶段 1：安装态门控（零分发变更，先立骨架）

dsh 仍随包分发，但把「runtime 是否可用」做成一等状态并据此门控 UI：

1. **主进程**：新增 `src/main/dsh/runtime/DshRuntimeStatus.ts`，输出 `installed | notInstalled | checking | broken`（本阶段 installed 恒真，状态源为占位实现）。IPC 通道 `dsh-runtime:status` / `dsh-runtime:status-changed`（订阅式，返回 unsubscribe），通道名进 `shared/ipc.ts`。
2. **渲染层**：
   - 新建 DSH 会话入口、sidebar DSH 会话区：`notInstalled` 时隐藏或降级为「安装 DSH 后端」引导卡（复用 skills/extensions 商店卡片风格）。
   - `ConfigModal` 的 `DshConfigTab`：`notInstalled` 时整 Tab 替换为安装引导，不渲染任何 dsh 配置表单。
   - i18n：zh-CN / en-US 同步加 key。
3. **测试**：门控纯函数（状态 → UI 可见性矩阵）单测；`dshRuntimeStatus` IPC 边界测试。

> 阶段 1 的价值：状态契约与空态 UI 先行落地并回归验证，阶段 2 只需把状态源从「恒 installed」换成真实探测，UI 零改动。

#### 阶段 1 实施记录（已落地）

| 层 | 落点 |
| --- | --- |
| 契约 | `src/shared/types/dshRuntime.ts`（`DshRuntimeState` / `dshUiVisibilityFor` / `resolveEffectiveAgentBackend`，纯类型 + 纯函数） |
| 主进程 | `src/main/dsh/runtime/DshRuntimeStatus.ts`；探测锚点 `createRequire(appPath).resolve("@deepseek-ai/dsh-base")`，与 `DshHost.start` 同接缝 |
| IPC | `dsh-runtime:get-status`（查询）+ `dsh-runtime:status-changed`（订阅，返回 unsubscribe）；未装配 dshBackend 时返回 `notInstalled` |
| 门控点 | `sessionsCatalogCreateDraft` / `sessionsCreateAnonymous` 拒绝 dsh；`startDshHostInBackground` 加 `canCreateDshSession()`；`ConfigModal` DSH Tab 整页换 `DshRuntimeInstallGuide`；`CommonTab` 的 dsh 选项禁选 |
| 渲染层关键设计 | `effectiveAgentBackendAtom` 派生 atom（= `defaultAgentBackend` × `dshRuntimeStatus`）。安装态由 IPC 异步送达、晚于 settings 落 atom，派生才能保证同帧收敛；App 只挂一份 `useDshRuntimeStatusSync` |
| 测试 | `tests/dshRuntimeStatus.test.mjs`（10 项）、`tests/dshRuntimeIpc.test.mjs`（8 项） |

阶段 2 需要改动的地方（其余保持不动）：把 `DshRuntimeStatusService.probeOnce()` 的状态源换成外部 runtime 目录 manifest 探测 + app 内置回退，并把 `DshRuntimeInstallGuide` 的 `onInstall` 接到真实下载器。

### 阶段 2：runtime 外置 + 按需下载

1. **runtime 打包脚本** `scripts/pack-dsh-runtime.mjs`：
   - 输入：dev `node_modules` 中 28 个 `@deepseek-ai/*` 包 + `dsh-tool-pwsh-persistent` 产物 + `dsh-bill`；
   - 产出：`dsh-runtime-<dshVersion>.tgz`，内含 `manifest.json`（runtimeVersion / dshVersion / minAppVersion / maxAppVersion / files+sha256）；
   - 替代/改造现有 `scripts/check-dsh-asar.mjs` 的校验职责（改为校验 tarball 清单，19 个关键包必须在）。
2. **依赖迁移**：package.json 中 28 个 `@deepseek-ai/*` 依赖从 `dependencies` 移入 `devDependencies`（构建期打 tarball 用，运行期不进 app）。electron-builder `files` / `asarUnpack` 相应收缩。
3. **主进程 runtime 管理** `src/main/dsh/runtime/DshRuntimeManager.ts`：
   - 发现：扫描 `userData/runtimes/dsh/*/manifest.json`，按兼容区间（min/maxAppVersion）选定版本；
   - 安装：下载（默认 GitHub Release 资产，URL 可配置镜像）→ sha256 校验 → 临时目录解压 → 原子 rename 落位 → 失败清理；
   - 卸载/更新：多版本共存，按 manifest 保留最新兼容版，其余回收；
   - **手动导入**：支持用户选择本地 tgz 文件安装（离线 / 镜像不可达场景的兜底，走既有文件对话框 IPC，路径限制在解压目标内）。
4. **DshHost 接缝切换**：`appRoot` 解析改为「优先 `DshRuntimeManager` 解析出的 runtime node_modules；dev 模式回退项目 node_modules」。`--dsh-node-modules` 参数随之指向 runtime 目录。hostEntry / 桥代码零改动。
5. **迁移**：升级后首次启动，检测 `DSH_HOME` 非空或 session catalog 中存在 dsh 会话 → 弹「DSH 后端需要下载运行时」引导（含下载进度与手动导入入口）。未确认前 dsh UI 保持门控态，pi 零影响。
6. **测试**：manifest 兼容区间判定纯函数、下载失败/校验失败/解压中断的恢复路径、多版本选择与回收，全部单测（mock 下载，不依赖真实网络）；`pack-dsh-runtime` 冒烟测试。

#### 阶段 2 实施记录（主体已落地，依赖分区待决策）

| 层 | 落点 |
| --- | --- |
| 契约 | `src/shared/types/dshRuntimeManifest.ts`：manifest / release 索引 / 语义版本比较 / 兼容区间判定 / 版本选择与回收（纯函数） |
| 管理器 | `src/main/dsh/runtime/DshRuntimeManager.ts`：扫描 → 选版本 → sha256 校验 → 临时目录解压 → 原子 rename 落位 → 失败清理 → 旧版本回收 → 卸载 |
| 安装编排 | `src/main/dsh/runtime/DshRuntimeInstaller.ts`：拉索引 → `selectRelease` 挑兼容版本 → 下载 → 进度换算（下载 0-70%，校验/解压/落位 75/85/95） |
| IO | `src/main/dsh/runtime/dshRuntimeIo.ts`：Electron `net` 下载（跟随重定向、按 chunk 落盘、可取消）、`tar` 解压（拒绝绝对路径与 `..` 逃逸条目）、索引拉取 |
| 接缝 | `DshHost.start` 的 `createRequire` 基准改为 runtime 目录，`--dsh-node-modules` 随之指向外部 runtime —— **hostEntry 零改动**（它本就从该参数建 require） |
| 状态 | `DshRuntimeStatusService` 改为「外部 runtime 优先 → 回退 app 内置 → 都没有才是 notInstalled」；新增 `resolveAppRoot()` 供 DshHost 复用同一份探测结果 |
| IPC | `dsh-runtime:install` / `install-local` / `uninstall` / `install-progress`（订阅式）；本地导入的**文件对话框在主进程弹**，渲染层不接触路径 |
| UI | `DshRuntimeInstallGuide` 接真实下载器（进度条 + 阶段文案 + 手动导入 + 失败原因）；`CommonTab` 增加 runtime 状态行（版本 + 来源 + 卸载，内置不可卸）；`useDshRuntimeMigrationNotice` 给存量 dsh 用户一次直达提示 |
| host 衔接 | `restartDshHostAfterRuntimeChange()`：装/导入 runtime 后重启已运行的 host（fork 时路径已固化，不重启会用旧 runtime）；未启动则不白起 |
| 下载源 | 随包安装为主路径（runtime 直接打进安装包，零网络）。在线索引 `dsh-runtime-releases.json` 仅保留给可选的 `--lite` 场景（不随包、需手动维护 Release 资产）；打包脚本**不再产出** `dsh-runtime-releases.json` |
| 打包 | `scripts/pack-dsh-runtime.mjs`：闭包收集 + 文件级裁剪 + **零复制打包**（用 tar 的 `onWriteEntry` 重命名条目，直接引用 node_modules 原文件）；`scripts/check-dsh-asar.mjs` 职责改为校验 runtime 归档（19 个基线包 + 6 个入口包） |
| 依赖分区 | 24 个 dsh 包（22 个 `@deepseek-ai/*` + `dsh-bill` + `dsh-tool-pwsh-persistent`）已移入 devDependencies；production 依赖从 31 个降到 7 个 |

**实测数据（win32-x64，dsh 0.1.1-rc.1）**

| 项 | 裁剪前 | 裁剪后 |
| --- | --- | --- |
| 闭包 | 478 个包 / 34333 文件 | 482 个包 / 22098 文件 |
| 未压缩 | 225.4 MB | **150.5 MB**（裁掉 126.1 MB） |
| tarball | 47.2 MB | **33.6 MB**（-29%） |

裁剪掉的构成：`src/` 源码副本约 60MB、`*.map` 约 29.5MB、测试/示例/文档约 8MB、`*.md` 约 5MB，
外加 `.pdb`、其他平台 prebuilds、`third_party/`、`*.d.ts`。其中 @deepseek-ai 自身只占约 15MB，
其余是 dsh 的第三方依赖（`@img/sharp` 18MB、`@google/genai` 12MB、`@mistralai` 8MB、`openai` 6MB 等）。

**`src/` 必须条件裁剪**：只在包内已有 `lib/` 或 `dist/` 时才丢 `src/`。个别包（如嵌套进来的 zod 副本）
只有 `src/` 没有编译产物，无脑裁会让模块直接消失——这一条是裁剪里唯一有风险的地方，
靠「解包后逐个 `require.resolve` 入口」的校验兜住。

闭包按「整个 `@deepseek-ai` 作用域 + dependencies/optionalDependencies 传递闭包」收集，**不跟随 peerDependencies**（peer 是「宿主提供」语义，跟随会把 `react-dom` 这类前端包拖进来）。收集时用 package.json 的 `name` 字段判定，不能用路径推断——嵌套 `node_modules` 会让路径推断把 `@deepseek-ai/x/node_modules/y` 误判成 `@deepseek-ai` 包。

#### 随包 runtime（解决「没有发布位置时打包产物 DSH 不可用」）

`runtime:pack` 除了 tarball，还会产出 `dist-runtime/dsh-runtime/`（tgz + 带真实 sha256 的 manifest），
由 electron-builder 的 `extraResources` 原样放进 `resources/dsh-runtime/`。应用内
`readBundledRuntime()` 读到它就在安装时本地解压——**零网络、零等待**，用户点击后几秒可用。

- 它不进 asar、不随启动加载，不用 DSH 的用户永远不会触发解压。
- 想要小安装包时用 `npm run runtime:pack:lite`：随包目录留空（只保留 `.gitkeep`，
  因为 extraResources 的源目录不能缺失），应用自动回退到在线索引 / 手动导入。
- `npm run build` 已串上 `runtime:pack`，不必手动执行。
- `dist:fast` 原本不走 `npm run build`，会打出**没有 runtime 的包**（extraResources 拿到只有
  `.gitkeep` 的空目录）。已在该脚本里补一步 `pack-dsh-runtime.mjs --if-missing`：
  随包资源已存在就跳过（几乎零耗时），首次或手动删掉 `dist-runtime/` 后才花那 20 秒。

安装优先级：**随包资源 → 在线索引 → 手动导入**。有随包资源时不会发起任何网络请求
（有单测断言这一点）。

**依赖分区后的行为变化（重要）**

- **dev 模式不受影响**：`@deepseek-ai` 仍在项目 node_modules 里，内置探测仍成功 → 内置回退依旧可用，本地开发 DSH 照常。
- **打包后不再内置**：electron-builder 只收集 production 依赖，`@deepseek-ai` 不会进 asar → 首次使用 DSH 必须下载 runtime（或手动导入 tgz）。
- 因此标准发布**不再需要下载源**：runtime 已随包打进安装包，用户点击即用。仅当用 `--lite` 打不带 runtime 的安装包时，才需在 Release 上手工维护 `dsh-runtime-releases.json` 索引与其 tarball（自测可设 `DSH_RUNTIME_INDEX_URL` 指向该索引，url 用 `file://`）。

**剩余一件事（在线更新源）**

体积优化已做（47.2MB → 33.6MB，见上表）。还想再降就得**整包排除**，但那需要实测 host 是否加载，
风险显著高于文件级裁剪——候选是 `dsh-web*` / `dsh-client-*`（43 个包，9.3MB，PiDeck 有自己 UI）、
`@img/sharp` 18MB、`@vscode/ripgrep` 5MB。验证方式是排除后用**真实 Electron 启动 host 并发一条消息**，
而不是只做静态检查。收益/风险比不划算，暂不做。

1. **在线更新源**（lite 包才需要）
2. **在线更新源**（lite 包才需要）：索引 `dsh-runtime-releases.json` 与 tarball 上传到可访问的地址（默认取 `UPDATE_REPO_OWNER/UPDATE_REPO` 的 `dsh-runtime` tag 资产）。sha256 校验对镜像同样强制生效。随包方案上线后这不再是必需项——它只在「不带 runtime 的安装包」以及「runtime 版本热更新」时才用到。

**验证记录**

- 端到端：本地索引（`file://`）→ 选版本 → 校验 sha256 → 解压 34389 个文件 → 原子落位，耗时约 60 秒，落位后 `dsh-app-boot` / `dsh-bill` / `dsh-tool-pwsh-persistent` 均在。
- 随包链路：8 个用例覆盖「随包资源缺失/清单缺失/版本不兼容 → 回退在线」与「有随包资源时不发起网络请求」。
- 裁剪后入口解析：解包 slim 归档，从 runtime 的 node_modules 逐个 `require.resolve` hostEntry 用到的
  15 个入口 → 14 个成功；唯一「失败」的 `@deepseek-ai/dsh` 本身没有 main/exports（只是 ESM 元包），
  hostEntry 只用它的 package.json，那个解析正常。关键原生包（node-pty / sharp / koffi / ripgrep）确认都在。
- `node scripts/check-dsh-asar.mjs <tgz>`：19 个基线包 + 6 个入口包全部通过。
- 回归：136 个用例通过 135，唯一失败是存量问题（`mainProcessI18n` 断言的 `update.checkFailed` 在 HEAD 里就不存在）。

### 阶段 3：泛化为 AgentRuntimeProvider 注册表

1. 契约上移 `shared/types/runtimeProvider.ts`；dsh 的 manager 适配为 `managed-download` provider；`PiLocator` 包装为 `external-command` provider（pi 探测失败同样给出安装引导，替代现有裸报错）。
2. 设置页新增「Agent 后端」总览：每个后端一行（图标 / 状态 / 版本 / 安装·更新·卸载按钮），DSH 明细仍留 DshConfigTab。
3. 后续新 agent 接入 = 注册一个 provider + 会话视图适配，不再动分发链路。

---

## 4. 兼容与安全

- **版本兼容清单**：app 内 hostEntry/桥代码与 dsh 版本的兼容性由 manifest 的 `minAppVersion/maxAppVersion` 表达；app 升级后发现已装 runtime 不兼容 → 引导下载新 runtime；runtime 单独升级同理反向检查。区间判定为纯函数，进单测。
- **完整性**：manifest 内逐文件 sha256 + tarball 总 sha256；安装失败/校验失败不留半成品（临时目录 + 原子 rename）。
- **路径安全**：runtime 只落 `userData/runtimes/`；解压路径做规范化与逃逸检查（沿用项目路径安全规范）。
- **下载源**：默认 GitHub Release，允许用户在设置中配置镜像 base URL（国内可达性）；手动导入 tgz 为最终兜底。
- **数据兼容**：`DSH_HOME`、session catalog、dsh-config 目录均不迁移不变更；仅 runtime 安装位置是新增概念。

---

## 5. 风险与开放问题

| 风险/问题 | 应对 |
|-----------|------|
| GitHub Release 国内下载不稳 | 镜像 URL 可配 + 手动导入 tgz |
| runtime 与 app 桥代码版本错配 | manifest 兼容区间 + 双向检查；过渡期保留「app 回退内置 runtime」一个版本（可选） |
| CI 发版流程变复杂（tarball 与 app 对齐） | 发版脚本串行产出：app 包 + runtime tarball，manifest 由 CI 注入 app 版本区间 |
| 本地包（pwsh-persistent 等）构建产物归属 | 一律收入 tarball，app 不再携带 |
| 全量 dsh e2e 依赖内置 runtime | e2e fixture 预装 runtime 或测试环境直接指向 dev node_modules（dev 探测回退已覆盖） |
| 是否同时发 full / lite 两种安装包 | 暂不做；单一 lite 包 + 按需下载。若分发数据证明需要再评估 |

---

## 6. 验收口径

- 阶段 1：typecheck + 针对性单测绿；状态门控矩阵测试绿；现有 dsh 功能零回归（dsh e2e 不变）。
- 阶段 2：安装包体积下降 ~26MB（asar 内 @deepseek-ai 条目为 0，`check-dsh-asar` 校验职责由 tarball 校验接管）；未装 dsh 的全新安装 → UI 无任何 dsh 痕迹（除安装引导入口）；存量 dsh 用户升级 → 引导下载后功能全量恢复；断网/校验失败可恢复且可手动导入。
- 阶段 3：pi 探测失败走统一引导；新增 provider 只需注册，不改分发链路。
