# DSH 0.2.1 升级对照

状态：代码适配与本机隔离验证完成，发布前跨平台与人工 smoke 待补齐（0.2.0-rc.2 → 0.2.1-rc.1 → 0.2.1-rc.2 → 0.2.1-rc.5）。

升级路径：先落 npm `next` 上当时可用的 `0.2.1-rc.1`（`@deepseek-ai/dsh@0.2.1-rc.2` 当时 404，只有 GitHub tag）；rc.2 上架 npm 后按同一套门禁补升到 `0.2.1-rc.2`；rc.5 为 0.2.1 线当前 latest，按同一套门禁补升。补丁级差异见下文「rc.2 补丁升级」与「rc.5 补丁升级」。

## 边界与验收

本次只升级 PiDeck 的 DSH 运行时集成，不改 PiDeck 的会话/RPC 契约。开发验证使用临时 HOME/profile，不读取凭据、不启动真实会话、不重启应用、不发布线上 runtime。

| 能力 | 新版变化 | 适配与验收 |
| --- | --- | --- |
| 依赖布局 | 19 个 profile 插件包（jobs-local、session-query-sqlite、storage-json 等）不再 hoist 到顶层 | lock 全量重建（删除 `@deepseek-ai` 条目后重新解析），并显式声明 `dsh-web-app`、`dsh-goal`、`dsh-workspace`、`dsh-api-session-controller`、`dsh-ptc-runtime-node`、`dsh-subagent-{fork,spawn}-in-process`；否则归档内只有嵌套副本，boot 在 `dsh-runtime/node_modules` 解析失败 |
| 停发包 | `dsh-invariants`、`dsh-subagent-in-process-driver` 不再发布；driver 拆成 spawn/fork 两个 provider | 从 devDependencies 与 REQUIRED 移除两个旧包，REQUIRED 补两个新 provider（dsh-base 补丁的直接入口） |
| Peer 作用域 | Connection fetch 与 Gateway stream 都要求显式 `PeerScope`（旧版传 `undefined` 表示进程内 operator） | `hostEntry` 统一用 `ctx.connection.browserPeer`（Connection 服务持有的本机 owner Peer，生命周期随 host 插件） |
| wire 描述符 | 生成物改为 `$remote` + `TYPERT.invocations` getter，并 import `createTypertRemoteInfo` | `check-dsh-wire` 兼容两种形状（descriptors/invocations），注入真实 `createTypertRemoteInfo`；31 个调用点形状仍匹配 |
| 预设 | 主补丁移除 `tool-ralph` 的 disabled 行；standard/ptc 移除 persona 工作目录后缀、新增 time-context/tool-schedule 行 | `dshWebAgentPlaneDisabledIds` 24 → 23（只删 `tool-ralph`）；PiDeck 不硬编码 persona suffix 与子代理后台模式 |
| 子代理默认值 | 预设不再设 `backgroundMode: continuable` | PiDeck 显式传 one-shot/continuable，行为不变（dsh 测试覆盖） |
| `--from-default-profile` | 由「补缺失」改为「模板全新覆盖已有 profile」 | PiDeck 使用独立 profile + 组合补丁，不依赖该参数的增量语义 |
| 本地插件 peer | rc 线的 caret 会解析到更高 prerelease（`^0.2.1-rc.1` → rc.2），产生两套 runtime 副本 | `dsh-tool-pwsh-persistent` 的 peer 精确 pin 到当前声明版本，测试断言同步 |

## rc.2 补丁升级（0.2.1-rc.1 → 0.2.1-rc.2）

rc.2 是 DeepSeek Search/Fetch API provider 的补丁版：86 个直接依赖全部对齐 rc.2，但逐文件抽查 14 个集成面关键包（dsh、app-boot、base、agent-preset(-registry)、web-app、web、web-fetch-http、session、session-projection、subagent、tool-web、llm、host-webserver、ptc-runtime-node、api-session-controller、workspace、goal）后，只有 web 面三个包有实质变化。

| 变化 | 内容 | PiDeck 适配 |
| --- | --- | --- |
| 新包与预设行 | `dsh-base` 补丁新增 `web-deepseek-api` 行（`@deepseek-ai/dsh-web-deepseek-api`，rc.2 首发，DeepSeek Search/Fetch API provider，复用 `DEEPSEEK_API_KEY`） | 由 `dsh-base` 依赖自动进闭包（归档 640 包，asar 门禁 642 个包目录入口解析通过）；PiDeck 镜像的 agent-plane 禁用表只含工具行（`tool-web`），不涉及 provider 行，无需改动 |
| web 运行时配置 | `WebRuntimeConfig.searchProvider` / `fetchProvider` 由 `string` 改为 `Volatile<string \| undefined>`（改配置立即对下一次 search/fetch 生效，不必重挂服务） | PiDeck 不设置这两个字段（web 工具在 agent 面被禁用），typecheck 直接通过 |
| web plane UI 行 | `dsh-web-app` 补丁新增 `ui-deepseek-model-label-1017` | 属 web 客户端 UI 平面，PiDeck 用自有 hostEntry + 组合补丁，不在镜像范围 |

其余 rc.2 差异只有版本号、agent-preset 的技能参考文档与 lock 里的 duplicate 收敛，不动会话格式、wire 描述符、Peer 接口与预设语义，因此回退边界与 rc.1 相同。

## rc.5 补丁升级（0.2.1-rc.2 → 0.2.1-rc.5）

rc.3、rc.4、rc.5 三个补丁都只动 web 客户端与 ACP 附属面，未改 host / session / RPC 契约：

| 版本 | 变化 | PiDeck 适配 |
| --- | --- | --- |
| rc.3 | web 客户端左/中/右栏新增「更多」菜单与插件草稿入口；修复切换会话后新会话丢草稿；DeepSeek API Key 适配器的模型列表改为与账号登录同路径 | `dsh-web-app` 的 `cordis.patch.yml` 仅新增 client-ui 行 `entry-customization`；PiDeck 的 agent-plane 禁用表（23 项）不变 |
| rc.4 | 修复 ACP 模式诊断输出混入 stdout | PiDeck DSH 后端走自有 hostEntry，不经 `dsh-acp-app`；包随闭包升级，无代码适配 |
| rc.5 | 优化对话中思考内容的展示（供应商思维签名块剥离） | 展示层改动位于 `dsh-client-ui-chat`；PiDeck 已在 `df287bc2f` 移植同一净化逻辑到 `src/shared/reasoningText.ts`，时间线行为一致 |

依赖与 lock：

- 29 个 `@deepseek-ai/dsh*` 直接依赖与根字段 `dshRuntimeVersion` 全部对齐 `0.2.1-rc.5`；lock 内 296 个 dsh 包均为 rc.5，无混版。
- 按既有做法从 lock 删除 `@deepseek-ai/dsh*` 条目后重新解析（子包 peer 精确 pin 到 rc.2，只改根版本会 ERESOLVE）；同时移除已下线的本地包 `packages/dsh-tool-pwsh-persistent` 残留条目。
- 重建后 npm 11.6.2 仍会漏掉顶层 `@emnapi/wasi-threads`，已按 `pideck-npm-ci-lockfile-emnapi` 补回 1.2.3，`npm ci` 才能通过。

## 升级与回退

会话格式（V3/V4）与 0.2.0 一致，由 DSH runtime 负责迁移；回退边界同 [DSH 0.2.0 升级对照](../../dsh-0.2.0-migration.md)：不能只降 npm 版本，V4 新写入不会回填 V3。

## 验证门禁

- `npm run typecheck`。
- `node --test --test-concurrency=4 "tests/dsh*.test.mjs" tests/providerMigration.test.mjs`。
- `npm run check:dsh-wire`。
- 只构建改动涉及的子包，不跑全仓构建（本地 pwsh 插件已下线，无单包构建项）。
- `node scripts/pack-dsh-runtime.mjs --out <隔离目录> --lite` 后，用同一 tgz 依次跑 `check-dsh-asar.mjs`、`check-dsh-boot.mjs`、`check-dsh-migration.mjs`。
- 分平台归档只验证归档完整性；非本机平台真实运行需对应 runner，不把交叉打包称为跨平台运行通过。

## 交付记录

### rc.5（当前声明版本，0.2.1-rc.5）

在隔离 worktree（`../pideck-dsh-rc5`，分支 `chore/dsh-0.2.1-rc.5`，`npm ci --ignore-scripts`）内完成，不干扰主工作区的并行改动与 node_modules。

| 命令 | 结果 |
| --- | --- |
| `npm ci --dry-run`（bundled npm 11.6.2） | 补回 `@emnapi/wasi-threads@1.2.3` 后通过 |
| `npm run typecheck` | 通过 |
| `node --test --test-concurrency=4 "tests/dsh*.test.mjs" tests/providerMigration.test.mjs` | 906 项通过，0 失败/跳过 |
| `node --test tests/packageLockIntegrity.test.mjs tests/releaseConsistency.test.mjs` | 10 项通过 |
| `node --test tests/agentMessageProjector.test.mjs tests/liveStreamThinkingDisplay.test.mjs tests/reasoningText.test.mjs` | 26 项思考净化回归通过 |
| `npm run check:dsh-wire` | 31 个调用点形状匹配，0 不符 |
| `node scripts/pack-dsh-runtime.mjs --out "$TEMP/dsh-021-rc5-pack" --lite` | win32-x64 归档成功，639 包 / 38,307 文件 |
| `node scripts/check-dsh-asar.mjs <tgz>` | 38,308 entries / 513 packages；19 基线 + 8 入口包、639 个包目录入口与关键文件通过 |
| `node scripts/check-dsh-boot.mjs <tgz>` | 真实 hostEntry、官方/旧预设健康、相对资源、配置保存/重启通过 |
| `node scripts/check-dsh-migration.mjs <tgz>` | V3 冷读/写租约发布 V4/V3 保留/V4 重启/损坏输入/最高代扫描/follow/control/fork 通过 |

验证产物：`C:/Users/14012/AppData/Local/Temp/dsh-021-rc5-pack/`，`dsh-runtime-win32-x64.tgz` 为 153,325,470 bytes（146.2 MiB），runtime `0.2.1-rc.5`、最低应用版本 `0.9.9`，SHA-256 `30d370e61731e7e552a4875bf6bbb8c365719e12ea9d31d07b5d39d1bc380596`。发布落点（win32-x64）：GitHub `v0.9.8`（当前 latest，未打包 dev 跟随 latest）与 `v0.9.9` 预发布（打包态 0.9.9 按 `v${appVersion}` 取资产；仅放 runtime，latest 仍为 v0.9.8）、AtomGit 同名两个 Release 的 `dsh-runtime-win32-x64.tgz` + `-releases.json` 已替换为 rc.5。打包态 0.9.9 首次安装曾因 `v0.9.9` Release 不存在而 404（`resolveDshRuntimeReleaseTag` 对已打包 app 固定取 `v${appVersion}`），补建该预发布后恢复；AtomGit 侧 `release_status` 保持 none，latest 经同步脚本校正回 `v0.9.8`。AtomGit 同步踩中「索引文件改版本后大小不变（305 bytes）被按大小去重跳过」，处理方式是先删掉两个 win32-x64 附件再重传；GitHub 侧下载归档超时（`gh ETIMEDOUT`），改用本地归档直传预签名 URL。两条 `releases/download/latest` 链路实测索引 `runtimeVersion` 均为 rc.5、sha256 均为 `30d370e6…c380596`，Range 长度均为 153,325,470。

注意：rc.5 归档的 `minAppVersion=0.9.9`，而 `v0.9.8` 客户端声明 rc.2，因此 0.9.8 的新装用户不会再被提供可下载 runtime（已装 rc.2 的用户不受影响）；需要升级到 0.9.9 或手动导入归档。其他平台归档、安装包内 utilityProcess、真实供应商请求与人工 UI smoke 未在本次验证范围。

### rc.2（历史记录，已被 rc.5 取代）

在隔离 worktree（`../pideck-dsh-rc2`，分支 `chore/dsh-0.2.1-rc.2`，`npm ci --ignore-scripts`）内完成，不干扰主工作区的并行改动与 node_modules。

| 命令 | 结果 |
| --- | --- |
| `npm ci --dry-run`（bundled npm 11.6.2） | 通过（lock 重建后掉的两个 `@tailwindcss/oxide-wasm32-wasi` 内置 `@emnapi/*` 条目已按 `pideck-npm-ci-lockfile-emnapi` 手工补回） |
| `npm run typecheck` | 通过 |
| `node --test --test-concurrency=4 "tests/dsh*.test.mjs" tests/providerMigration.test.mjs` | 822 项通过，0 失败/跳过 |
| `node --test tests/packageLockIntegrity.test.mjs tests/releaseConsistency.test.mjs` | 10 项通过 |
| `npm run check:dsh-wire` | 31 个调用点形状匹配，0 不符 |
| `npm run build --prefix packages/dsh-tool-pwsh-persistent` | 单包构建通过 |
| `node scripts/pack-dsh-runtime.mjs --out "$TEMP/dsh-021-rc2-pack" --lite` | win32-x64 归档成功，640 包 / 38,514 文件 |
| `node scripts/check-dsh-asar.mjs <tgz>` | 38,515 entries / 514 packages；19 基线 + 9 入口包、642 个包目录入口与关键文件通过 |
| `node scripts/check-dsh-boot.mjs <tgz>` | 真实 hostEntry、官方/旧预设健康、相对资源、配置保存/重启通过 |
| `node scripts/check-dsh-migration.mjs <tgz>` | V3 冷读/写租约发布 V4/V3 保留/V4 重启/损坏输入/最高代扫描/follow/control/fork 通过 |

验证产物：`C:/Users/14012/AppData/Local/Temp/dsh-021-rc2-pack/`，`dsh-runtime-win32-x64.tgz` 为 155,969,204 bytes（148.7 MiB），runtime `0.2.1-rc.2`、最低应用版本 `0.9.1`，SHA-256 `84d611798a3f9979b26c84b07b822d62eb119984a9101a82d8507733c82b9b81`。

发布落点（win32-x64）：GitHub `v0.9.1`（打包态 0.9.1 客户端按 `v${appVersion}` 取资产）与 `v0.9.0`（GitHub latest，未打包 dev 运行跟随 latest）两个 Release 的 `dsh-runtime-win32-x64.tgz` + `-releases.json` 已替换为 rc.2，并通过 `scripts/sync-release-to-atomgit.mjs --only 'dsh-runtime-win32-x64*' --force-upload` 同步到 AtomGit 同名 tag；`v0.9.1` 标题/说明已改为「前置：DSH runtime 0.2.1-rc.2」。三条下载链路（`v0.9.1` / `v0.9.0` / `latest`）实测索引 `runtimeVersion` 均为 rc.2、归档 Range 长度均为 155,969,204。同 tag 其他平台仍为 rc.1 资产，未重新打包。

### rc.1（历史记录，已被 rc.2 取代）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `node --test --test-concurrency=4 "tests/dsh*.test.mjs" tests/providerMigration.test.mjs` | 822 项通过，0 失败/跳过 |
| `npm run check:dsh-wire` | 31 个调用点形状匹配，0 不符（跳过事件网关与动态端点） |
| `npm run build --prefix packages/dsh-tool-pwsh-persistent` | 本地 DSH 插件单包构建通过 |
| `node scripts/pack-dsh-runtime.mjs --out "$TEMP/dsh-021-pack" --lite` | win32-x64 归档成功，638 包 |
| `node scripts/check-dsh-asar.mjs "$TEMP/dsh-021-pack/dsh-runtime-win32-x64.tgz"` | 38,504 entries / 512 packages；19 基线 + 9 入口包、640 个包目录入口与关键文件通过 |
| `node scripts/check-dsh-boot.mjs <tgz>` | 真实 hostEntry 与 RPC 启动、官方/旧预设健康、相对资源、配置保存/重启通过 |
| `node scripts/check-dsh-migration.mjs <tgz>` | V3 冷读、写租约发布 V4、V3 字节保留、V4 重启、损坏输入拒绝、最高代扫描、follow/control/fork 通过 |

### 保留的验证产物（rc.1）

本次 win32-x64 产物位于 `C:/Users/14012/AppData/Local/Temp/dsh-021-pack/`：

- `dsh-runtime-win32-x64.tgz`：155,944,002 bytes（148.7 MiB）；runtime `0.2.1-rc.1`，最低应用版本 `0.9.1`。
- `dsh-runtime-win32-x64-releases.json`：下载索引与完整性校验元数据。
- 归档 SHA-256：`3dabb72b787779a4bb8360a3401638196ee2adfe03b996b796628663465d3d18`。

### 未验证及发布前要求

- 其他目标平台的归档完整性与真实启动不在已通过范围（本轮只重打了 win32-x64）；需各自对应 runner 补齐。
- 未验证安装包内 Electron utilityProcess、真实供应商请求/工具执行及人工 UI smoke。
- 主工作区 node_modules 未在本次改动中重装（多人并行写入期间禁止 `npm install`）；使用前需执行 `npm ci` 对齐新 lock。
- 已安装 rc.2 的客户端需自身 `dshRuntimeVersion` 声明 rc.2 才会启用：旧构建（声明 rc.1）只能走 App 自动更新或重新构建，手动导入 rc.2 会因版本不配套被硬门控。

### 发布侧踩坑：同大小索引被缓存/去重跳过

`.cache/release-sync/<tag>/` 的本地缓存与 AtomGit 附件去重都只按文件大小判断，而 `dsh-runtime-*-releases.json` 改版本号后大小仍是 305 bytes。rc.2 发布时因此把 rc.1 的旧索引原样传了上去（日志显示「使用本地缓存文件」）。重发索引必须：先 DELETE AtomGit 上同名附件（`/releases/{tag}/attach_files/{id}`，204 表示成功），再用新索引覆盖 `.cache/release-sync/<tag>/`，然后带 `--force-upload` 重跑；发布后务必回读索引确认 `runtimeVersion` / `sha256`。
