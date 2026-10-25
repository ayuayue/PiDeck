# pi 自更新链路拆分计划（ExtensionManager 瘦身）

> 状态：**Wave 1–3 全部落地（2026-10-13）**。`src/main/extensions/ExtensionManager.ts` 1254 → **564 行**（低于 600 红线）；拆出 `piSelfUpdateChannel.ts`（134 行，纯判定/命令构造）、`piSelfUpdateRunner.ts`（326 行，自更新执行）、`piExtensionCatalog.ts`（529 行，目录/版本查询）。
> 触发：2026-10 修 bun/WSL 更新通道时，「检查 → 分派 → 失败提示 → 包管理器代跑」这一段已达 ~280 行，且与扩展目录/安装域同处一文件，按 AGENTS.md 的文件体量红线需要评估拆分。
> 长期目标：自更新链路收口为 `src/main/pi/piSelfUpdateRunner.ts`（纯判定与命令构造已在 `piSelfUpdateChannel.ts`），ExtensionManager 只保留 spawn 装配、扩展管理域与薄包装，最终 ≤600 行。

## 拆分纪律（沿用 app-tsx / agent-manager 的既有方法）

- 每波一个域，独立可验证：`npm run typecheck` + 该域契约测试全绿 + 引用扫描（`grep -rln "ExtensionManager" tests/` 现为 8 个文件；改动方法所属域的测试必须同步换 seam）。
- 行为零变化：纯搬家 + 委托，命名与注释随迁；不顺手改语义、不改 IPC 契约、不改用户可见文案。
- 协作者不反向 import ExtensionManager：依赖全部构造注入（`locator` / `getSettings` / `translate` / `sanitizeCommandOutput` / `runPi` 回调 / 版本缓存失效回调 / `execFile`）。
- 行数单调下降才算一波完成；每波独立 commit，便于 `git revert`。

## Wave 1（已落地，2026-10-13）

| 域 | 新模块 | 迁出内容 | 接线点 |
|----|--------|---------|--------|
| 通道判定 + 安装命令构造 + bun 版本解析 | `src/main/pi/piSelfUpdateChannel.ts`（134 行，纯函数、零 Electron/磁盘依赖） | `resolvePiSelfUpdateChannel`、`resolveBunInstallRoot`、`npmGlobalInstallArgs`、`bunGlobalInstallArgs`、`parseBunVersion`、`isLocalAbsolutePath`、`PI_OFFICIAL_REGISTRY`、`BUN_MIN_VERSION_FOR_RELEASE_AGE_FLAG` | `updatePi` 分派与 `channelLabel` 改为同一 argv 构造器渲染；提示命令与代跑共用构造器；`tests/piSelfUpdateChannel.test.mjs` 直接测构造器 |

结果：ExtensionManager 1254 → 1216 行；`channelLabel` 不再单独维护第三份「通道 → 命令」映射（这是 2026-10 提示与代跑参数漂移的根因）。

## Wave 2（已落地，2026-10-13）：自更新执行链路 → `src/main/pi/piSelfUpdateRunner.ts`

| 迁出内容（ExtensionManager 现行号） | 说明 |
|---|---|
| `checkPiUpdate`、`checkPiUpdateFor`(570)、`fetchPiLatestVersion`(835) | 更新检查 + pi.dev 版本接口（Electron `net.fetch`，代理生效） |
| `updatePi`(593)、`withUpdateFailureHint`(652) | 通道分派 + 三类失败提示（源未同步 / 发布年龄门 / 其余透传） |
| `runPackageInstall`(669)、`pickBunCommand`(705)、`runBunGlobalUpdate`(720)、`bunSupportsReleaseAgeFlag`(731)、`runNpmPrefixUpdate`(746) | 包管理器代跑（bun / npm 前缀）与 bun 版本探测 |
| 常量 `PACKAGE_MISSING_VERSION_PATTERN`、`RELEASE_AGE_BLOCK_PATTERN`、`PI_LATEST_VERSION_URL`、`PI_LATEST_VERSION_TIMEOUT_MS` | 失败文本分类与检查超时 |

Wave 2 保留在 ExtensionManager（不迁）：

- `runPi`(1094)：`--no-approve` 判定、PATH/代理环境装配、WSL 处理，扩展 list/install/uninstall 也在用 → 以回调注入 runner；
- `npmViewVersion`(870)（扩展版本查询）与 `sanitizeCommandOutput`(932)（多条链路共用）→ 注入；
- `toUpdateResult`(936)（`updateExtensions` 也用）→ 保留，runner 返回原始结构由薄包装转换；
- `piVersion` / `piVersionPromise` 字段与 `PiProcess.invalidateVersionCache()` 调用 → 以回调注入（runner 的 `finally` 里调）。

受影响契约测试（Wave 2 已迁移 seam）：

- `tests/extensionManager.test.mjs`（28 处）与 `tests/piCliUpdates.test.mjs`（3 处）改为 stub `manager.selfUpdate.*`：`runBunGlobalUpdate` / `runPackageInstall` / `runNpmPrefixUpdate` / `pickBunCommand` / `check`（原 `checkPiUpdateFor`）/ `fetchLatestVersion`（原 `fetchPiLatestVersion`）/ `locator`；
- **不用改**的：`manager.runPi`（runner 的注入回调是动态委托，stub 管理器方法依旧生效）与 `manager.piVersion`（缓存重置走回调）；
- 沙箱夹具新增 `"./PiProcess"` 桩键：runner 在 `src/main/pi/` 下，import 说明符比管理器短一层；
- 只用公开 API 的用例不受影响：`updatePi` / `checkPiUpdate` / `updateExtensions` / `updateExtension`。

结果：`piSelfUpdateRunner.ts` 326 行（依赖按名存为独立字段：`locator`/`getSettings`/`translate`/`sanitizeCommandOutput`/`runPi`/`resetVersionProbeCache`/`homeDir`）；
ExtensionManager 1216 → 985 行，只留 `checkPiUpdate`/`updatePi` 两个薄包装 + `runPi`/`npmViewVersion`/`toUpdateResult`；
`updatePi` 返回值统一走 `toUpdateResult` 脱敏（行为不变：原实现里未脱敏的「无需更新」文案经过同一函数也等价）。

门禁（已满足）：ExtensionManager ≤ 1000 行（现 985）、`piSelfUpdateRunner.ts` 只单向依赖 `piSelfUpdateChannel.ts`（不反向 import 管理器）、受影响测试全绿且不再 stub 已迁出的私有方法。

## Wave 3（已落地，2026-10-13）：扩展目录与版本查询域 → `piExtensionCatalog.ts`

| 迁出内容 | 说明 |
|---|---|
| `listCache*` / `listInflight*` / `listCacheGeneration` / `listRequestSequence` 状态 + `invalidateListCache` + `list` | 缓存、并发去重与「代际丢弃」语义整块搬入，管理器只留两个同名薄包装（`main/index.ts`、`AgentManager`、IPC 调用点无感） |
| `loadList` / `scanLocalExtensions` / `parseListOutput` / `projectCachedEnabled` / `applyEnabledProjection` | 扫描与投影；`nativeEnabledReader` 以闭包注入（装配仍留在管理器） |
| `enrichExtensionVersion` / `settleQuery` / `readInstalledVersion` / `npmViewVersion` / `resolveNpmRegistryBase` | 版本补全与 registry 快路 |
| `FILTERED_SUFFIX` / `ExtensionNativeState` / `BUILT_IN_CONFLICT_KEYWORDS` / `extensionNameMatches` | 随域搬入，管理器**原样再导出**保住外部契约（`tests/extensionNameMatches.test.mjs` 等无需改导入路径） |

注入依赖：`runPi`、`locator`、`getSettings`、`getPiDeckSettings`、`translate`、`homeDir`、`builtInRoots`、`readNativeState`、`toHostPath`（WSL 路径映射）、`removeBuiltInFile`、`saveRemovedBuiltIn`（内置生命周期与写盘仍在管理器）。

测试 seam 迁移：`manager.catalog.*`（`loadList` 1 处、`scanLocalExtensions` 6 处、`parseListOutput` 2 处、`npmViewVersion` 2 处、`readInstalledVersion` 1 处）；
公开面未变，`manager.list()` / `invalidateListCache()` / `toggleFromUi` / 内置生命周期用例一行未改（源码契约测试 `extensionDemoPluginClassification` 仍需在管理器里看到 `toggleFromUi + isBuiltInExtensionName`，本波保持原样）。

结果：ExtensionManager **985 → 564 行**（红线以下）；剩余内容是 `runPi` spawn 装配、pi 版本探测缓存、装/卸/开关/内置生命周期与薄包装——不再计划拆波。

## 验证与回滚

```bash
npm run typecheck
npm run check:format
node --test tests/piSelfUpdateChannel.test.mjs tests/extensionManager.test.mjs tests/piCliUpdates.test.mjs \
  tests/piUpdateStartupNotice.test.mjs tests/extensionManagerWsl.test.mjs tests/logAudit.test.mjs
```

- 源码契约测试扫描：迁移后重跑 `grep -rln "ExtensionManager" tests/`，逐文件确认是「换 seam」而不是「删断言」。
- 回滚：每波一个 commit，行为零变化，`git revert <wave-commit>` 即可回到上一波。
