# 发版流程（Release Process）

> **Status: Current（2026-10-31 核对；以代码与测试为准）**


> 本文档承接 AGENTS.md 移出的发版细节。发版前通读一遍，按清单执行。

## 发版前检查

1. 核对 `README.md` / `README.en.md` 功能与安装说明仍准确。
2. 架构级变更（如 session-first 切换）先发 pre-release 观察，再标正式版。

## 一键预检（npm run preflight）

发版前机器能判的门禁全部收口在 `scripts/release-preflight.mjs`，泳道并行、不首错即停、失败只打尾部输出、完整 JSON 报告落盘 `release-preflight/`（gitignored）兼存 `latest.json`：

- `npm run preflight` —— typecheck + 全量单测 + biome 格式 + 发布一致性（版本号/CHANGELOG/README 一致、全部 `--check` 型生成器同步、提示词库可检索、DSH wire payload 形状）四泳道并行；
- `npm run preflight -- --e2e` —— 追加 Playwright E2E 泳道（慢，含完整构建）；
- `npm run preflight -- --skip unit-tests` —— 日常快速通道；`--only <ids>` 只跑指定泳道；`--list` 列泳道；`--test-concurrency N` 调单测并发。
- 门禁红灯时按提示先跑对应 `--apply`（如 `node scripts/sync-release-notes.js --apply`）再重试；发版期 `CHANGELOG` 仍是 `(Unreleased)` 只提醒不拦截。
- 机器不能判的仍属人工：README 描述准确性、安装包人工 smoke（见下）、GitHub Release notes 编写。

注意：preflight 不代替日常开发的针对性测试——日常按 AGENTS.md 只跑改动涉及的测试，preflight 是发版前的全景收口。

## CHANGELOG 与发布说明

1. `CHANGELOG.md` / `CHANGELOG.zh-CN.md` 加版本号与日期，条目记录用户可感知变化，中英文一致，条目用 `- **标题** — 描述` 格式。
2. GitHub Release notes 写明主要变化，不接受只写版本号。发版 workflow 的 `extract-changelog` 作业会按 tag 从 `CHANGELOG.zh-CN.md`（缺失时回落 `CHANGELOG.md`）抽取 `## v<版本>` 整段作为 Release 正文，因此**正文不需要另行撰写**，把 CHANGELOG 写全即可；需要额外说明时再手动编辑 Release。
3. **发版后修改 CHANGELOG 不回写 Release 正文**（正文是发版那一刻的静态快照，AtomGit 侧又是 `scripts/sync-release-to-atomgit.mjs` 从 GitHub 正文复制的）：补致谢 / 改错字后必须手动同步两端 —— `gh release edit <tag> --repo ayuayue/PiDeck --notes-file <新正文>` 改 GitHub，再 `gh workflow run sync-atomgit.yml -f tags=<tag>` 重跑同步；该次同步走增量路径（仅 PATCH name/body，附件按同名+同大小跳过，不重传安装包），`latest` 标记也会按 GitHub 最新 Release 校正。
4. docs-site 官网同步更新。

## 发布说明同步（scripts/sync-release-notes.js，不手改 README 亮点区块）

- `node scripts/sync-release-notes.js` 预览 → `--apply` 应用，自动同步 README.md / README.en.md / docs-site/changelog.md 三处亮点（README 取 🚀 前 12 + ✨/🐛 前 4，docs-site 取 🚀 前 15 + ✨ 前 4）；`--check` 只判同步不写盘（preflight 内置调用，也可单独跑）。
- 脚本不更新 README 顶部版本徽章（shields.io badge），需手动改为当前版本。
- `--apply` 后检查 `git diff`：脚本只清理重复的 v0.6.6 条目，历史条目不允许丢失（2026-08 曾因无条件删除逻辑误删唯一一份 v0.6.6 条目，已修复）。

## 版本与提交

1. `package.json` 与 `package-lock.json` 版本号一致；发版提交用 `chore: release vX.Y.Z`。

## latest 指针（release.yml 的 finalize-release 作业）

新版本先作为 draft 上传资产，`scripts/release-staging.mjs` 在重跑既有版本时保留原可见性，不把已发布版本重新隐藏。安装包、DSH runtime 与合并后的 `latest-mac.yml` 全部上传后，`finalize-release` 才通过 `gh release edit --draft=false` 公开版本；stable 同时显式 `--latest` 并读回 `/releases/latest` 验证，dev 使用 `--prerelease=true --latest=false`。独立 `build-dev.yml` 同样等待 mac 清单后才公开预发布草稿。

为什么不能只靠 `softprops/action-gh-release`：Release 若是先建成 draft/预发布暂存、之后由 build 矩阵补资产并把 `prerelease` 翻成 false，GitHub **不会**把已存在的 release 提升为 latest，latest 会静默停在上一版——存量客户端（Windows electron-updater、macOS/Linux 手动更新都读 `/releases/latest`）就完全收不到这次更新，而 CI 全绿。2026-10-31 的 v0.9.9 正是这样漏出去的。

手工补修（历史 tag 已发但 latest 没跟上）：`gh release edit <tag> --repo ayuayue/PiDeck --title <tag> --latest`，再 `curl -sI https://github.com/ayuayue/PiDeck/releases/latest` 确认 302 到该 tag；AtomGit 侧 latest 标记由 `sync-atomgit` 按 GitHub latest 校正，补修后重跑一次 `gh workflow run sync-atomgit.yml -f tags=<tag>` 即可。

发版后复核：`node scripts/probe-update-check.mjs`（联网，不属于单测）——校验仓库坐标一致、`/releases/latest` 的 tag 与 latest.yml 版本对齐、latest.yml 声明的安装包真实可下载且字节数一致、AtomGit 的 latest 与 latest.yml 同步，并打印「哪些存量客户端会被提示」的判定矩阵；任一条不成立退出码 1。

## Issue 自动关闭（发版合并时一次性触发）

关闭关键字只在**提交第一次可从默认分支到达**的那一刻触发——即 `dev → main` 那次 push。打 tag、建 Release、`workflow_dispatch` 发版都**不会**关闭任何 issue。默认分支是 `main`，开发合并全部进 `dev`，所以修复提交的 `Closes #N` 在合进 `dev` 时毫无效果，要等发版合并。

发版时按以下三条执行，否则会留下「发版了但 issue 还开着」：

1. **关键字必须落在提交里，不能只写 PR 描述**：PR 描述里的关键字只在 PR 的 base 是默认分支（`main`）时生效；本项目 PR 都合进 `dev`，因此描述里的 `Closes #N` 永远不会触发（#406、#428 就是这么漏掉的，修复提交 `4852205a4`、`1d76ed5d7` 的提交信息里都没有关键字）。
2. **发版合并提交正文逐行补 `Closes #N`**：`dev → main` 的真 merge 提交是唯一能兜住「提交信息漏写关键字」的位置。正文里每行一个 `Closes #N`，该次 push 会把它们一起关掉。示例：

   ```
   Merge branch 'dev' into main: v0.9.9 正式发版（…）

   Closes #406
   Closes #428
   ```

3. **别提前手工关闭**：GitHub 发现 issue 已关闭就什么都不做（#395 于 10-22 手工关闭，修复提交 `3aa01178c` 直到 10-24 才进 `main`，只留下一条 `referenced` 交叉引用）。想让自动关闭可见，就等到发版合并之后再判断。

关键字只认 `close/closes/closed`、`fix/fixes/fixed`、`resolve/resolves/resolved` + `#N`。`Refs #N`、`（#N）`、`关联 #N` 都不算——`Refs` 是「仅关联、不关闭」的写法，用在明确不打算关的提交上。

**逐条验证**（判定标准：`closed` 事件的 `commit_id` 非空 = 被提交关闭；`-` = 手工关闭；只有 `referenced` 没有 `closed` = 关键字没到达 `main` 或已被提前关闭）：

```bash
gh api "repos/ayuayue/PiDeck/issues/<N>/timeline?per_page=100" \
  --jq '.[] | select(.event=="closed" or .event=="referenced") | "\(.event) \(.created_at) \(.commit_id // "-")"'
```

## workflow_dispatch tag 下拉同步（scripts/sync-workflow-choices.js）

GitHub 的 choice 只能写死静态列表，无法动态读 tag，所以每发一版都要更新，否则新版本在下拉里选不到（只能手输 `tag_custom`）：

- 发版前跑 `node scripts/sync-workflow-choices.js --check`（列表与 CHANGELOG 不一致则退出码 1）；
- 有差异时 `--apply` 应用，默认保留最近 10 个正式版（`--keep N` 可调），更旧的版本走 `tag_custom`；
- 列表首项是哨兵值 `auto`（语义：跟随 GitHub latest / 按 package.json 正式发版），不要手动移动或删除；带 `auto` 的 workflow 都必须有 `tag_custom` 兜底输入，且 `tag_custom` 非空时优先级高于下拉；
- 回归测试：`node --test tests/syncWorkflowChoices.test.mjs`（含 v 前缀、新→旧排序、哨兵值、input 顺序）。

## 提示词库 db 资产发布（xueprompts.db，远程拉取通道）

安装包不内置 `resources/xueprompts.db`（省 ~4.3MB，且库可独立于发版更新）：打包后的应用首次打开提示词商店时从 Release 资产下载缓存到 userData，版本判定用同目录的 `.sha256` 文件。

- db 内容有更新时：跑 `node scripts/publish-xueprompts.mjs`（先做 sql.js 健康检查再生成 `resources/xueprompts.db.sha256`，两个文件一起提交），再把这两个文件上传到对应平台的 Release 资产（GitHub `gh release upload <tag> resources/xueprompts.db resources/xueprompts.db.sha256`，AtomGit 侧由 sync-atomgit 同步）；上传到既有 tag 后客户端在 1h 检查 TTL 后自然更新。
- 两份资产必须同源成套上传（客户端按源配对拉取 sha+db 并校验，跨源指纹不匹配会整体作废）。
- 平时发版无需重新上传：客户端按 sha 判断未变更则免下载。仓库内的 `resources/xueprompts.db` 仅作为源码运行（dev）副本与发布脚本的健康检查输入。

## 打包验证

时间线相关的改动（历史翻页 / 刻度跳转 / 加载更多）打包前额外过一遍 [`docs/timeline-manual-qa.md`](timeline-manual-qa.md) 的五条动作。

`npm run pack`（--dir 快速验证）→ `dist:win/mac/linux`；发版前至少跑过一次目标平台完整安装包的人工 smoke，不依赖 CI 构建成功即发布。

构建来源标记：本机脚本一律不注入 `PIDECK_RELEASE_BUILD`，产物因此在设置页显示「本地构建」徽章；
发布 workflow（`release.yml` / `build-dev.yml` / `release-linux-manual.yml`）必须在其构建步骤 env 注入
`PIDECK_RELEASE_BUILD: "1"`（编译期 define `__PIDECK_RELEASE_BUILD__` → 构建来源判定 release，见
`src/main/buildIdentity.ts`）。漏标的表现是发布包也显示「本地构建」，守卫测试
`tests/releaseWorkflowBuildOrigin.test.mjs` 会按「会发 Release 的 workflow」逐一拦下。

### macOS 签名（Developer ID + 公证；无证书时 ad-hoc 兜底）

- **配置裁决点只有一个**：`scripts/electronBuilderConfig.js`（入口 `scripts/electron-builder.config.js`，dev 通道经 `scripts/dist-dev.js` 复用）。它以 `package.json build` 为基底，按环境变量决定 mac 签名：
  - `CSC_LINK`（base64 .p12，配 `CSC_KEY_PASSWORD`）或 `CSC_NAME`（本机钥匙串已装证书）非空 → 删掉 `identity`，交给 electron-builder 自动发现 Developer ID Application 证书；`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`（或 `APPLE_API_KEY` 三元组 / `APPLE_KEYCHAIN_PROFILE`）齐全时 `notarize: true`（notarytool 公证 + 装订）；
  - 否则 `identity: "-"` + `notarize: false`（ad-hoc；公证对 ad-hoc 包必失败，所以显式关掉）。GitHub Actions 未配置的 secret 注入为空串，按未配置处理，fork PR 与本地无证书打包自然回退。
- 身份要求统一由 `scripts/mac-signing-policy.js` 解析；mac 专用 `beforePack` 和产物门禁共同使用。`PIDECK_RELEASE_BUILD=1` 或 `PIDECK_MAC_REQUIRE_NOTARIZATION=1` 强制固定 Team、Developer ID 与公证，可选身份开关设为 false 不能放宽发布要求。缺证书、公证凭据或合法 Team 时打包失败；产物中实际 Team 不符、Helper 身份不符或缺公证票据同样失败。非 mac 打包不执行这些身份要求。
- 本地/纯构建默认仍允许无证书 ad-hoc；这是验证包用途，不能代替正式公证发行物。固定 Team 的本地测试签名包也必须匹配指定身份。
- 签名忽略 Electron Framework 下的 `*.lproj/locale.pak` 单独签名：它们是 Chromium 数据，由完整 framework 资源封印保护；不忽略 Mach-O 或原生模块。mac afterPack 使用 electron-builder 的真实 bundle Resources 路径执行 asar 清理和 node-pty 校验。
- **所有 mac 打包命令必须带 `--config scripts/electron-builder.config.js`**（`npm run dist:mac`、release.yml / build-macos.yml / mac-test-build.yml 已带；dist-dev.js 内置）。裸跑仍由已有 `beforePack` 选择证书，但不会应用这里的公证策略；守卫 `tests/electronBuilderConfig.test.mjs`。
- CI secrets（仓库 Settings → Secrets）：`MAC_CSC_LINK`（`base64 -i cert.p12`）、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`（appleid.apple.com 生成的 app 专用密码，不是账号密码）、`APPLE_TEAM_ID`。workflow 里只给 mac job 注入 `CSC_LINK`（`matrix.platform == 'macos'` 门控）——CSC_LINK 对 Windows 同样生效，泄到 win job 会拿 mac 证书签 exe 而失败。
- 沿用可选 `MAC_CSC_NAME` 证书选择器。构建与门禁均将 `vars.MAC_TEAM_ID || secrets.APPLE_TEAM_ID` 注入 `PIDECK_MAC_TEAM_ID`：现有五项 Apple Secrets 已包含 Team，无需重复设置变量；也可用 `MAC_TEAM_ID` 显式固定发布身份。固定 Team 与 `APPLE_TEAM_ID` 同时存在时必须一致，防止签名/公证团队配置漂移。API key/keychain profile 方式则需显式提供固定 Team。
- entitlements 沿用 app-builder-lib 默认模板（allow-jit / allow-unsigned-executable-memory / disable-library-validation），`hardenedRuntime` 默认 true。这三条就是 Electron + 原生模块（koffi / node-pty）+ Go sidecar + DSH runtime 内 node 二进制所需的全部；不开 App Sandbox，所以不需要 network.client/server 等沙箱 entitlement。@electron/osx-sign 会递归签掉 bundle 内所有 Mach-O（含 `Resources/` 下的 sidecar 和 `app.asar.unpacked` 的 `.node`），公证对「所有二进制都签名 + hardened runtime + 时间戳」的要求由它满足。
- **mac 自动更新**：运行时 `src/main/update/macCodeSignature.ts` 用 `codesign -dv` 探测当前 .app 是否 Developer ID 签名，是则 `deliveryPlan` 走 automatic（electron-updater MacUpdater，读 `latest-mac.yml` + zip），否则仍是 manual（推荐 dmg 一键下载）。x64 / arm64 两个 job 的 `latest-mac.yml` 各含一半文件，直接上传会互相覆盖（x64 用户报 ZIP file not provided / arm64 用户装到 x64 包），所以 mac job `skip_yml` + 上传 artifact，由 `merge-mac-update-manifest` job 跑 `scripts/merge-latest-mac-yml.mjs` 合并后 `gh release upload --clobber`（release.yml 与 build-dev.yml 同款）。合并失败阻止新草稿公开及 latest 提升，避免客户端拿到缺失的清单。
- 本地打签名包：证书装进登录钥匙串后 `CSC_NAME="<证书名不含 Developer ID Application: 前缀>" APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=... npm run dist:mac`，然后 `node scripts/verify-mac-signature.mjs`（同一组环境变量下跑，它才知道要按 Developer ID 判）。
- 历史背景（仍有效）：`package.json` 的 `build.mac.identity: "-"` 是裸跑 electron-builder 时的安全底线。**不要删这一行**：electron-builder 26.15 起找不到证书时不再回退 ad-hoc（26.8.1 的 `fallBackToAdhoc` 已删除，`scheme.json` 的 identity 说明也写明 "no automatic ad-hoc fallback"），省略它只会得到「签名静默跳过、CI 全绿」的假绿包——0.9.0 的 arm64 包就是这样：没有 `Contents/_CodeSignature`、`Info.plist` 未封印（CodeDirectory identifier 仍是 Electron），Apple Silicon 上停在 `_dyld_start` 打不开（#347）。
- ad-hoc + 默认 `hardenedRuntime: true` 需要 `com.apple.security.cs.disable-library-validation` entitlement，该键已在 app-builder-lib 默认模板里；不要另加一份缺它的 `build/entitlements.mac.plist`（会连累 node-pty 等原生模块加载）。
- 每个 mac 打包 job 在 `Build packages` 之后跑 `node scripts/verify-mac-signature.mjs`（本地打了 mac 包也可手动跑，`--release-dir` 指目录、`--json` 出报告）。门禁用与打包配置同一组环境变量推断期望：有 `CSC_LINK`/`CSC_NAME` 时要求主 .app 的 `Authority=Developer ID Application:`、`CodeDirectory flags` 含 `runtime`，公证凭据齐全时还要 `xcrun stapler validate` 与 `spctl --assess --type execute` 通过（配了证书却产出 `Signature=adhoc` 即红：那是证书导入失败被静默跳过）；签了但没公证只警告。ad-hoc 模式的判据：`release/mac*/*.app` 存在 + `<app>/Contents/_CodeSignature/CodeResources` 非空 + `codesign --verify --deep --strict` 退出码 0 + （`codesign -dv --verbose=4`）签名 `Identifier` 等于 `Contents/Info.plist` 的 `CFBundleIdentifier`、`Info.plist entries=` 已封印、`Sealed Resources version=` 不是 `none` + `Contents/Frameworks/*.app`（Helper）的签名标识等于各自的 Bundle ID（官方 0.8.0 arm64 全过、0.9.0 arm64 全挂）。后三条是 #347 后续评论补的：0.9.0 的 `Identifier=Electron`、`Info.plist=not bound`、`Sealed Resources=none`、Helper 用通用 `Electron Helper` 标识，这些不会被纯 `--verify` 判红，但会让 macOS 把本地网络授权记在 `Electron` 名下，表现为局域网模型服务连不上、PiDeck 终端 `ssh` 报 `No route to host`。门禁红灯时该 job 会停在上传之前——宁可 Release 缺 mac 资产（红 job 可见、重跑补齐），也不发一个装上去打不开或局域网不可用的包。
- `build.mac.extendInfo.NSLocalNetworkUsageDescription` 是 macOS「本地网络」权限弹窗的说明文案，缺了它系统不会弹窗、本地网络访问可能被默默拒绝；发版时不要删（只影响 Info.plist，不影响签名）。用户从 0.9.0 升级后，系统设置 → 隐私与安全性 → 本地网络里可能残留旧的 `Electron` 条目，发布说明要提示删掉后重新允许 PiDeck。
- mac 人工 smoke 除「能启动」外必须覆盖本地网络：在 PiDeck 终端里 `ssh`/`nc` 一台局域网主机、用局域网地址的模型服务各跑一次，然后重启应用重复一次。这两个场景是签名 identifier 退化时唯一会暴露的用户可见回归（启动正常、局域网 EHOSTUNREACH / No route to host），CI 无法代跑（需要真实局域网与 TCC 授权）。
- Intel 包使用 `macos-15-intel` 原生 runner，ARM 包使用 Apple Silicon runner，避免 npm 安装的 koffi / sharp 等可选原生依赖与目标架构不一致。
- 从历史 ad-hoc 版本首次迁移到 Developer ID 版本时，旧版仍走手动下载 DMG；安装一次正式签名版后，再验证签名版本之间的一键重启更新。
- 首次启用 Developer ID 后的人工 smoke 追加：从 Release 下载 dmg 在一台没装过 PiDeck 的 mac 上双击安装，必须**不出现**「无法验证开发者 / 已损坏」弹窗（不能靠 `xattr -cr` 绕）；装上上一个签名版后在设置页「检查更新 → 下载 → 重启并安装」走完一次应用内替换。

#### 更新后的权限保留

- **签名有效不等于权限可跨版本保留。** 默认 ad-hoc 的 designated requirement 是 `cdhash H"…"`；二进制、Info.plist、图标等封印资源变化并重签后，哈希会改变。TCC 仍可显示文件夹已允许，但旧授权要求已无法匹配新应用。持续使用同一 Developer ID / Team 与 Bundle ID 是系统识别更新的前提；只固定 Bundle ID 或重复 ad-hoc 重签不能解决这个问题。
- 公开发布时，主应用与 Helper 均须为 Apple 证书链认可的 Developer ID Application 签名，匹配固定 Team，并拒绝绑定 `cdhash` 或缺少 Apple / Team 约束的 designated requirement。仅本地/纯测试构建保留 ad-hoc 兼容和 TCC 权限保留警告。Developer ID 签名、公证和真实权限继承仍是分别验证的事项；本机升级演练未申请真实目录、自动化等 TCC 授权。
