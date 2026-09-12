# DSH 原生能力对齐对照计划：插件配置热应用 + 本地/npm 插件安装

> 目标：让 PiDeck 内嵌 DSH 在**插件**这一维度上达到官方 `dsh` / `dsh web` 的原生能力：
> ① 用户 patch 层（插件配置）改动**即时生效**（官方 `patchReload: live`）；
> ② 支持安装**自己写的本地插件**与**从 npm 装的第三方插件**（官方 `dsh plugin --profile <name> add`）。
>
> 非目标：Client 半区插件渲染、插件市场/评分、官方 dsh-web 前端内嵌、跨 API 大版本的 runtime 热升级
> （见 §10）。pi 链路零改动。
>
> 基线：`dev` 分支；DSH runtime `0.1.5-rc.1`；deep-fusion 形态（utilityProcess + MessagePort fetch 桥）。
> 配套文档：`docs/dsh-agent-backend-plan.md`（接入计划）、`docs/dsh-compat-gap-analysis.md` §7（G13 动态插件现状）、
> `docs/dsh-runtime-optional-plan.md`（runtime 按需安装）。

**状态：方案待评审（未实施）。** 本计划属架构级改动（host 部署形态），按 AGENTS.md「长期重构纪律」
必须先评审对照表再动手。

---

## 1. 一句话诊断

内嵌 DSH 与官方 `dsh` 跑的是**同一棵插件树**，差距不在 host 能力，而在**部署形态**：

| | 官方 | PiDeck 现状 |
|---|---|---|
| profile 目录 | `$DSH_HOME/profiles/<name>/`（`package.json` + `cordis.patch.yml` + `cordis.yml`） | 无。组合文件在 `<runtime>/pideck-host/cordis.yml` |
| 插件来源 | profile 的 npm 依赖（声明 `dsh.bundle` 的包自动进 `dsh.profile.bundles`） | 只有 PiDeck 自己 insert 的行 + `$DSH_HOME/cordis.patch.yml` 手写行 |
| 裸包名解析 | 从组合文件所在目录向上走：`profiles/<name>/node_modules` → `profiles/node_modules`（安装闭包镜像） | **单一锚点** `bareModuleBaseUrl = <runtime>`（`hostEntry.ts:327`）→ 树外插件包解析不到 |
| 配置热应用 | `patchReload: live` + `watchUserPatches` | ❌ 未接；`hmr` 行显式 `disabled`（`hostEntry.ts:112`），home 层只在 boot 时读一次 |

结论：**② 是低风险纯增量，可以独立先落地；npm 插件安装必须把 host 迁到官方 profile 形态**，
两者不是同一量级的改动，因此分阶段而不是一把梭。

---

## 2. 核查结论：官方机制（源码证据）

> 依据：`node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`、`@deepseek-ai/dsh/lib/profile-boot-*.js`、
> `@deepseek-ai/dsh/lib/plugin-*.js`、`@deepseek-ai/dsh-base/cordis.patch.yml`（0.1.5-rc.1 实装包）。

### 2.1 profile 部署形态

`dsh-app-boot` 的 `initProfile(dir, bundles, patchReload)`（L379）在首次使用时写出：

- `package.json`：`{ name: "dsh-profile-<name>", private, dependencies: {}, dsh: { profile: { bundles, patchReload } } }`
- `cordis.patch.yml`：用户自己的 patch 层（初始 `[]`）
- `pnpm-workspace.yaml`：`nodeLinker: hoisted` / `autoInstallPeers: false`（树外插件需要的 pnpm 设置）

`PROFILE_TEMPLATES`（L331）里 **`web` profile 的 `patchReload` 是 `"live"`**，其它（acp/headless/sdk）是 `"startup"`；
自定义 profile 默认也是 `live`（`DEFAULT_PROFILE_PATCH_RELOAD`，L377）。

`cordis.yml`（空根 `[]`）由 launcher 每次 boot 前重写（`prepareProfile`），注释写明原因：
"the whole composition is patch layers, and the vendored Loader's tree write-back … can bake composed rows into
this file — which would duplicate every bundle insert on the next boot"。**PiDeck 现在也是逐字复刻这个做法**
（`hostCompositionPath` + `if (!existsSync) writeFileSync("[]")`，但只在缺失时写，缺了"每次重写"这一层）。

### 2.2 bundle 与插件安装

- **bundle 的定义**：一个 npm 包，manifest 声明 `dsh.bundle.patch`（指向自己的 `cordis.patch.yml`）。
  `loadProfileDirectory`（L843）对 `dsh.profile.bundles` 里每个名字 `resolveBundleDir` → 读 `dsh.bundle.patch`
  → `loadOverlayPatches` 得到该层；缺声明 = **fail loud**（不是"无补丁"）。
- **安装**：`dsh plugin --profile <name> <args>` 是 **pnpm 转发器**（`dsh/lib/plugin-*.js`）：
  `initProfile` → `spawnSync("pnpm", args, { cwd: profileDir, shell: win32 })` → `reconcilePlugins`。
  `reconcilePlugins` 按**安装态**（不是依赖 diff）把「能解析到且声明 `dsh.bundle`」的依赖追加进 `bundles`；
  已移除/不再声明 `dsh.bundle` 的名字移出；非 bundle 依赖只告警（"installed as a plain dependency"）。
  pnpm 不在 PATH → 退出码 127 + 明确提示。
- **bundle 优先从安装锚点解析**：`resolveBundleDir`（L826）先 `installAnchor`（= `<install>/node_modules/@deepseek-ai/dsh/package.json`）
  再 profile 目录 —— 契约是「in-box bundle 永远来自运行中的同一个安装，绝不用 profile 里的私有副本」。

### 2.3 两锚解析与 module fallback（npm 插件能跑起来的真正关键）

`healProfilesModuleFallback({ installAnchor, profile, home })`（L657）：

1. `resolveModuleFallbackEntries(installAnchor)`：从安装锚点 package.json 出发，按
   `dependencies + peerDependencies` 广度遍历，得到「安装闭包」；非 `process.pkg` 环境写 **symlink（junction）**，
   pkg 打包环境写 **ESM proxy**（`dsh.moduleFallback.targets` 记录）。落点 `$DSH_HOME/profiles/node_modules`。
2. `healProfileModuleFallback(profile, installationPackageNames)`：把**仅由所选 bundle 携带**的包
   链进该 profile 自己的 `node_modules`（经 profile 私有 owned 目录间接链接），**pnpm 管理的条目不被覆盖**。

于是 profile 目录下的 `cordis.yml` 里一个裸包名，能沿 Node 父级查找走到：
`profiles/<name>/node_modules`（插件）→ `profiles/node_modules`（安装闭包镜像）→ 命中。

PiDeck 现在走的是 `mountRootInclude` 的 `bareModuleBaseUrl` 分支（L1322-1343）——
**所有裸名都被强制丢给单一 runtime 锚点**，父级查找被跳过，这就是树外插件解析不到的根因。

### 2.4 `patchReload: live` 的官方接线

`dsh/lib/profile-boot-*.js` `runProfile`：

```js
const composeLive = () => structuredClone([
  ...composed.bundlePatches,
  ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],
  ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
  ...composed.overlays,
]);
const ctx = await boot(NAME, rootConfig, structuredClone(allPatches(composed)), prepare);
if (composed.profile.patchReload === "live" && ...) {
  if (ctx.get("hmr") === void 0) {
    if (ctx.get("timer") === void 0) await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-timer" });
    await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } });  // 空 root = 只做配置监听
  }
  await watchUserPatches(ctx, { binName: NAME, filename: composed.profile.patchPath, compose: composeLive });
  await watchUserPatches(ctx, { binName: NAME, filename: homePatchPath(), compose: composeLive });
}
```

`watchUserPatches`（app-boot L1109）= `hmr.registerConfig(file, async () => entry.update({ config: { ...includeConfig, patches: compose(loadOptionalPatches(file) ?? []) } }))`
—— **事务性重应用 boot include**；坏补丁不会砸掉旧树（HMR 侧 `hmr/config-update-failed` 事件）。
注意 `hmr` 行在 base 里默认 `disabled: true`（"Module reload is opt-in per profile"），CLI 是**运行时 `loader.create`** 挂上去的，
所以 PiDeck 保留 `disabled: true` 并不妨碍 ② —— 只要照 CLI 的做法按需 create。

### 2.5 层序（优先级，低 → 高）

`bundlePatches < profile.patches（cordis.patch.yml） < homePatches（$DSH_HOME/cordis.patch.yml） < overlays（--patch / 启动旗标）`

`composeProfile` 用一次 `composeEntries` 摊平后取 `rows.get(id)` 判定 telemetry 行是否存在 —— 即**同一 id 后层覆盖前层**。

---

## 3. 现状与差距（parity 表）

| # | 能力 | 官方 | PiDeck 现状 | 差距 | 本计划 |
|---|---|---|---|---|---|
| P1 | profile 目录（`dsh.profile.bundles`） | ✅ | ❌ 无 profile 概念 | 结构缺失 | Phase 2 |
| P2 | 树外 npm 插件解析 | ✅ 两锚 + fallback 镜像 | ❌ 单锚点，解析不到 | **根因** | Phase 2 |
| P3 | 本地插件（目录/单文件/绝对路径） | ✅ bundle 或 patch 行 | ⚠️ 机制已在用（`pideck-slash-bridge.js` 等绝对路径行），但**无安装/管理入口** | 缺 UI + 缺 profile 归属 | Phase 3 |
| P4 | 插件安装（`dsh plugin add`） | ✅ pnpm 转发 + bundle 自动入栈 | ❌ | 缺 | Phase 3 |
| P5 | **配置热应用（`patchReload: live`）** | ✅ `watchUserPatches` × 2 | ❌ hmr 显式 disabled、home 层只读一次 | 缺 | **Phase 1** |
| P6 | 插件启停（不卸载） | ⚠️ 官方亦无 UI；等价手段是 patch 里的 `disabled: true` 行 | ❌ 只读清单 | 可用 patch 表达 | Phase 3 |
| P7 | 动态 Cordis 插件（临时、按会话） | ✅ `cordis-host-runner` | ✅ 已复原（G13） | 无 | 保持 |
| P8 | 模块级 HMR（改插件源码热替换） | ⚠️ 默认关，仅开发 | ❌ | 可选 | Phase 4 |
| P9 | Client 半区插件 | ✅（浏览器端） | ❌ 无 client runtime | **硬边界** | 不做（§10） |
| P10 | 运行时装完即生效 | ❌ 官方要下次 boot | ❌（改 patch 也要重启 host） | PiDeck 可超越 | Phase 1+3 |

> 说明：P5 + P4 组合之后，PiDeck 能做到「**装插件不重启 host、会话不断**」——这是官方 CLI 也给不了的体验
> （官方 `dsh plugin add` 只改 profile 三件套，生效靠下次 boot）。

---

## 4. 目标架构

```
$DSH_HOME/.pideck/profiles/              # PiDeck 私有 profiles 根（决策 D1）
├── node_modules/                        # 安装闭包镜像：healProfilesModuleFallback 维护（symlink/junction）
└── pideck-dsh/
    ├── package.json                     # dsh.profile.bundles（base + 用户插件 bundle）+ patchReload: "live"
    ├── pnpm-workspace.yaml              # initProfile 产物（hoisted）
    ├── cordis.yml                       # 空根，每次 boot 重写（官方语义）
    ├── cordis.patch.yml                 # profile 用户层（PiDeck 插件管理 UI 写入）
    └── node_modules/                    # pnpm/npm 装的树外插件 + bundle 携带包链接

$DSH_HOME/cordis.patch.yml               # home 层（与 dsh CLI/dsh web 共享；继续加载并纳入 watch）
<PiDeck overlays>                        # 运行时动态行：桥插件（绝对路径）、禁用行、require.resolve 结果
```

启动序列（`hostEntry.ts`，Phase 2 后）：

```ts
const installAnchor = join(runtimeAppRoot, "node_modules/@deepseek-ai/dsh/package.json");
const profilesRoot  = join(dshHome, ".pideck", "profiles");
const profileDir    = join(profilesRoot, "pideck-dsh");

initProfile(profileDir, ["@deepseek-ai/dsh-base"], "live");          // 幂等，仅缺失时写
writeFileSync(join(profileDir, "cordis.yml"), PROFILE_ROOT_CONFIG);  // 每次 boot 重写（防 loader 写回 bake）
const profile = loadProfileDirectory("pideck-dsh", profileDir, installAnchor);
await healProfilesModuleFallback({ installAnchor, profile, home: profilesRoot });

const layers = () => composePatchLayers({                            // 官方层序，纯函数可单测
  bundlePatches:  profile.layers.flatMap((l) => l.patches),
  profilePatches: loadOptionalPatches("pideck-dsh", profile.patchPath) ?? [],
  homePatches:    loadOptionalPatches("pideck-dsh", join(dshHome, "cordis.patch.yml")) ?? [],
  overlays:       pideckOverlays,                                    // 动态行，最高优先级
});
const ctx = await boot("pideck-dsh", join(profileDir, "cordis.yml"), layers(), prepare, undefined); // ← 不再传 bareModuleBaseUrl（决策 D2，spike S1 把关）
await enableLivePatchReload(ctx, { files: [profile.patchPath, join(dshHome, "cordis.patch.yml")], compose: layers });
```

`--dsh-node-modules` 仍保留：hostEntry 自身 `createRequire(...).resolve("@deepseek-ai/...")` 的锚点不变
（它与组合树的裸名解析是两件事）。

---

## 5. 阶段拆分与门禁

| 阶段 | 内容 | 验收 | 依赖 | 风险 |
|---|---|---|---|---|
| **P0 spike**（不碰产品代码） | `scripts/dsh-plugin-parity-probe.mjs`：临时 profile + 临时 DSH_HOME，在**纯 Node** 下验证 S1–S4 | 4 条假设各有明确结论（绿/红/改方案） | 无 | 无（探针） |
| **P1 配置热应用（②）** | `hostEntry` 按 CLI 做法 `loader.create(timer/hmr{root:[]})` + `watchUserPatches(home patch)`；`hmr/config-update-failed` → 主进程日志 + 渲染层提示；抽 `dshPatchReload.ts` 纯函数 | typecheck + `tests/dshPatchReload.test.mjs`；真机：改 `$DSH_HOME/cordis.patch.yml` 不重启生效；**在跑会话受影响边界有实测结论** | 无 | 低 |
| **P2 profile 化** | 新 `dshProfile.ts`（目录/manifest/bundle reconcile 纯函数）；hostEntry 改 profile 装载 + heal + 层序；`DshHost` 传 `--dsh-profile-dir/--dsh-profiles-root/--dsh-install-anchor`；runtime 基线补锚点包；`--lite`/dev 回退路径不变 | DSH e2e 四件套全绿；新增 `tests/dshProfile.test.mjs`；`runtime:check` 通过；手测：装一个本地 bundle 目录后 host 能加载其 patch 行 | P0 | **中高**（换地基） |
| **P3 插件安装器** | `dshPluginManager.ts`（本地目录/tarball 免包管理器；registry 走 pnpm→npm 探测）+ IPC + 渲染层插件管理（已装列表/安装/启停/卸载/来源与 client 半区提示/安全确认）+ 「装完即生效」（复用 P1） | 单测（spec 校验、reconcile、manifest、回滚）+ e2e `e2e/dsh-plugins.spec.ts`（fixture 本地插件真实装载）+ 无包管理器降级路径手测 | P1,P2 | 中 |
| **P4 可选** | 模块级 HMR 开发者模式；runtime 更新入口；`installFailLoud` 对齐 | 按需 | P1–P3 | 低 |

**门禁（每阶段）**：`npm run typecheck` + 本阶段针对性单测；涉及 IPC/会话链路时补跑相关 e2e；
合并前 `npm test` 全量 + `npm run runtime:check`。

---

## 6. 关键决策（需拍板）

| # | 决策 | 选项 | 建议 + 理由 |
|---|---|---|---|
| **D1** | profiles 根位置 | (a) 私有 `<dshHome>/.pideck/profiles`；(b) 官方共享 `$DSH_HOME/profiles` | **(a)**。`$DSH_HOME` 默认就是用户真实 `~/.dsh`（与 dsh CLI 共享）。共享 profiles 根意味着两个安装世代争抢 `profiles/node_modules` 这一个 fallback 目录（`healProfilesModuleFallback` 按"当前安装世代"改写链接）→ 互相 heal 抖动。代价：失去 `dsh plugin --profile pideck-dsh` 的 CLI 互通（我们本来就要做自己的 UI，且 home 层仍共享） |
| **D2** | 裸名解析 | (a) 去掉 `bareModuleBaseUrl`，靠 fallback 父级查找（官方语义）；(b) 保留单锚点 + 只支持绝对路径插件 | **(a)**，由 spike S1 把关。这是 npm 插件能解析的唯一正解；树外插件内部 `import "@deepseek-ai/cordis"` 也必须靠 `profiles/node_modules` 才能共享**同一份** cordis 实例（否则双实例 → Context 不互通、插件挂不上） |
| **D3** | 层序变化 | (a) PiDeck overlay 最高（官方语义）；(b) 保持 home 在 overlay 之上（现状） | **(a)**。现状下用户 home 层能覆盖/禁用 PiDeck 的运行时代码行（`pideck-slash-bridge` 等），迁移后不能——**行为变化**，需在 CHANGELOG 写明，并提供设置级 kill switch 作为替代逃生口（`dshDisablePideckBridges` 类开关）。反向选择 (b) 会让"用户插件覆盖 PiDeck 桥"成为长期隐患 |
| **D4** | 包管理器 | (a) 依赖用户 pnpm（官方同款）；(b) 探测 pnpm → npm；(c) 只支持本地安装 | **(b)+本地兜底**。本地目录/单文件/tarball 安装不依赖任何包管理器（自己 junction/解包），registry 安装才需要 pnpm 或 npm；都没有时给明确引导（官方在 pnpm 缺失时也是 127 + 提示）。**不要把 pnpm 打进安装包** |
| **D5** | 安装脚本执行 | (a) 默认 `--ignore-scripts`（安全）；(b) 允许（官方行为，需要构建的插件才能装） | **(a) + 显式「允许运行安装脚本」开关**。插件 host 半区本来就不是安全边界，但 postinstall 的供应链风险面更大；默认关、失败时给出可操作提示（对齐官方 `allowBuilds` 指引） |
| **D6** | 「装完即生效」 | (a) 复用 P1 热应用；(b) 重启 host（会话不丢） | **(a) 优先、(b) 兜底**。热应用失败/插件需要重启时自动降级为重启 host 并提示 |

---

## 7. 安全、兼容与迁移

**安全**

- 插件 host 半区在 host 进程内执行 = 任意代码；官方运行器亦明示"不是安全边界"。UI 必须：展示包名/版本/来源（registry / 本地路径 / tarball）、二次确认、复用现有 `danger-full-access` 式文案层级。
- 所有 install spec 走**白名单校验**（IPC 边界）：registry 名（含 scope/版本范围）、`file:`/`link:` 绝对路径、`.tgz` 路径；**禁止字符串拼 shell**，`spawn(cmd, argsArray)`；路径做规范化 + 逃逸检查（限制在 profile 目录 / 用户选定目录内）。
- 安装失败必须**不留半成品**：包管理器失败 → 不改 `package.json`/`bundles`；本地解包走临时目录 + 原子 rename（复用 `DshRuntimeManager` 的既有模式）。
- `client` 半区检测：读已装包 manifest 的 `dsh.client` / 导出面，命中则在 UI 标注「桌面端不渲染该半区」（现有动态插件视图已有 `hasClientHalf` 先例）。

**兼容与迁移**

- `$DSH_HOME/cordis.patch.yml` 语义不变，继续生效（P1 后还会热生效）；用户已有行不迁移。
- `appRoot/pideck-host/cordis.yml`（`hostCompositionPath`）废弃；保留一个版本的空目录清理/忽略。
- dev 模式（项目 `node_modules` 作 runtime）+ `--lite`（无随包 runtime）两条回退路径必须继续可用。
- runtime 版本切换/卸载后 fallback 链接悬空：由下次 boot 的 `healProfilesModuleFallback`（比较 link target）自愈；补一条「悬空链接自愈」单测。
- 层序变化（D3）写进 CHANGELOG；若用户 patch 里出现 `pideck-*` 行 id，boot 时记 warning 提示该行不再能覆盖内部桥。

---

## 8. 测试计划

- `tests/dshPatchReload.test.mjs`：`composePatchLayers` 层序/覆盖/`structuredClone` 隔离；`enableLivePatchReload` 用假 ctx（记录 `loader.create` 调用与 watcher 注册）断言幂等与文件列表。
- `tests/dshProfile.test.mjs`：profile 目录初始化（manifest 字段/patchReload 校验/pnpm-workspace）、`readProfileManifest` 容错、`mergeStaticPluginViews` 之外的 bundle 归并。
- `tests/dshPluginReconcile.test.mjs`：`reconcilePlugins` 语义（新 bundle 入栈、移除出栈、非 bundle 告警、安装态优先于依赖 diff），注入假 `resolveBundleDir`。
- `tests/dshPluginManager.test.mjs`：install spec 校验（合法/非法/逃逸）、本地目录 junction 安装、tarball 解包失败回滚、包管理器缺失 → 结构化错误、client 半区标记。
- `tests/dshHostBridge`（既有）补 `host-event` 帧解析（热应用失败事件）。
- e2e：`e2e/dsh-plugins.spec.ts` —— 用 `e2e/fixtures/dsh-plugin-hello/`（一个声明 `dsh.bundle` 的最小插件，注册一个自定义命令/工具），断言：安装 → 配置生效（工具可见）→ 卸载 → 消失；全程不重启应用。
- 回归门禁：既有 `dsh-models` / `dsh-restart` / `dsh-security-plan` / `dsh-title-diag` 必须全绿。
- 打包：`runtime:pack` 的 `requiredPackages` 补 `@deepseek-ai/dsh`（install anchor）、`@deepseek-ai/cordis-plugin-hmr`、`@deepseek-ai/cordis-plugin-timer`；`check-dsh-asar.mjs` 的 `REQUIRED`/`ENTRY_PACKAGES` 同步；`npm run runtime:check` 进 P1 之后的门禁。

---

## 9. 风险与开放问题

| 风险/问题 | 应对 |
|---|---|
| **S1**：Electron utilityProcess（非 `process.pkg`）下标准 Include 能否沿 `profiles/node_modules` 的 junction 解析裸名 | P0 spike 首验；红则退到 (b)「单锚点 + 只支持绝对路径插件」，npm 插件降级为"手动解包到目录 + 绝对路径行"（能力缩水，需重新评估收益） |
| **S2**：`entry.update` 事务重应用对**运行中 agent** 的影响（工具/预设是否被 remount、在途回合是否中断） | P0/P1 实测；必要时在 UI 侧规定「有运行中回合时延后应用」或明确提示 |
| **S3**：Windows 上 `$DSH_HOME` 下建 junction 的权限/文件系统限制（OneDrive 同步目录、非 NTFS） | P0 spike 覆盖；失败则给可读错误 + 建议切换 DSH_HOME |
| **S4**：用户机器无 pnpm/npm | D4 降级路径 + 引导文案；本地安装始终可用 |
| fallback 目录被外部工具（用户自己的 dsh CLI）改写 | D1 私有 profiles 根隔离 |
| profile 化后 boot 失败面变大（bundle 缺失 fail loud、坏插件阻断启动） | 复用官方 fail-loud 语义但**加 PiDeck 侧恢复路径**：坏 bundle 单独 disable 并提示（不整树起不来），补「坏插件不阻断启动」测试 |
| runtime 与 app 桥代码版本错配 | 维持 `minAppVersion/maxAppVersion` 契约（`docs/dsh-runtime-optional-plan.md` §4） |

---

## 10. 明确不做（记录理由，防蔓延）

- **Client 半区插件渲染**：需要 dsh client runtime + `dsh-client-ui-*` React 栈，PiDeck 有自己的渲染层；
  内嵌官方前端已被 S6 §2.2 否决（绑定 dsh client runtime、无法服务 pi 会话）。装作支持比不支持更糟。
- **插件市场/评分/自动更新**：超出「DSH 原生能力」范畴。原生只有 `dsh plugin add`，我们做到等价即达标。
- **`dsh plugin` CLI 全量代理**：我们做自己的 UI（复用同一 profile 布局）；不做 argv 透传（徒增攻击面）。
- **模块级 HMR 作为默认能力**：官方自己默认关闭；仅在 P4 作为开发者模式候选。
- **跨 API 大版本 runtime 热升级**：`hostEntry` + 各桥是编译进 app 的产物，由 runtime manifest 兼容区间表达边界，不承诺绕过。
