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

所有资产上传完成后，`finalize-release` 作业先 `GET .../releases/tags/<tag>` 取 release id，再 `gh api -X PATCH .../releases/<id> -f name=<tag> -F make_latest=true`（Update a release 只接受 id，`/releases/tags/<tag>` 仅支持 GET，直接 PATCH 恒 404），并把 `/releases/latest` 指向本 tag 作为门禁断言（60s 内未生效即发版失败）。

为什么不能只靠 `softprops/action-gh-release`：Release 若是先建成 draft/预发布暂存、之后由 build 矩阵补资产并把 `prerelease` 翻成 false，GitHub **不会**把已存在的 release 提升为 latest，latest 会静默停在上一版——存量客户端（Windows electron-updater、macOS/Linux 手动更新都读 `/releases/latest`）就完全收不到这次更新，而 CI 全绿。2026-10-31 的 v0.9.9 正是这样漏出去的。

手工补修（历史 tag 已发但 latest 没跟上）：先 `gh api repos/ayuayue/PiDeck/releases/tags/<tag> --jq .id` 取 id，再 `gh api -X PATCH repos/ayuayue/PiDeck/releases/<id> -f name=<tag> -F make_latest=true`，随后 `curl -sI https://github.com/ayuayue/PiDeck/releases/latest` 确认 302 到该 tag；AtomGit 侧 latest 标记由 `sync-atomgit` 按 GitHub latest 校正，补修后重跑一次 `gh workflow run sync-atomgit.yml -f tags=<tag>` 即可。

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

### macOS 签名与更新后的权限保留

- `build.mac.identity: "-"` 继续作为**本地与测试构建的无证书兜底**，不要直接删除：electron-builder 26.15+ 已移除自动 ad-hoc 回退，省略身份且没有证书会再次产出未封印的坏包（#347）。`beforePack` 的 `scripts/configure-mac-signing.js` 在配置 `CSC_LINK` / `CSC_NAME` 或显式证书身份时解除 `"-"` 的覆盖，选择 distribution 证书并强制签名。发布构建（`PIDECK_RELEASE_BUILD=1`）必须提供证书选择与固定 Team ID；缺证书、导入失败、显式禁用签名或缺少/非法 Team ID 都会停止打包，不能静默降级。
- **签名有效不等于权限可跨版本保留。** 默认 ad-hoc 的 designated requirement 是 `cdhash H"…"`；二进制、Info.plist、图标等封印资源变化并重签后，哈希会改变。TCC 仍可显示文件夹已允许，但旧授权要求已无法匹配新应用。持续使用同一 Developer ID / Team 与 Bundle ID 是系统识别更新的前提；只固定 Bundle ID 或重复 ad-hoc 重签不能解决这个问题。
- 四个 mac 构建 workflow（`release.yml`、`build-dev.yml`、`build-macos.yml`、`mac-test-build.yml`）都支持证书配置。维护者在仓库 Actions secrets 配置 `MAC_CSC_LINK`（导出的 Developer ID Application `.p12`，按 electron-builder 的 `CSC_LINK` 约定）、`MAC_CSC_KEY_PASSWORD`，可选 `MAC_CSC_NAME`（证书名称选择器，不含 `Developer ID Application:` 前缀）。**发布入口 `release.yml`（含 stable/dev 通道）与 `build-dev.yml` 必须另设 Actions variable `MAC_TEAM_ID`**，固定预期的 10 位 Team ID。构建和上传前校验两步都接收它，严格校验不再由 secrets 是否为空决定。证书导入信息只放 secrets，不提交私钥到仓库；`MAC_TEAM_ID` 不是密钥，但不得随每次发布变更。
- 上传前要求发布包的主应用与 Helper 均为 Apple 证书链认可的 Developer ID Application 签名，Team ID 与固定值一致，并拒绝绑定 `cdhash` 或缺少 Apple / Team 约束的 designated requirement。`PIDECK_MAC_REQUIRE_DEVELOPER_ID=false` 不能覆盖发布策略。`build-macos.yml` / `mac-test-build.yml` 的构建产物和本地无证书构建仍允许 ad-hoc，仅用于测试，不能承诺跨版本授权继承；配置了证书或 Team ID 时仍执行相应的严格校验。公证凭据仍按 electron-builder 的 `APPLE_*` 约定另配；Developer ID 签名与公证是两项不同步骤。
- 原有产物级门禁继续保留：`release/mac*/*.app` 存在、资源封印非空、`codesign --verify --deep --strict` 通过、主应用及 Helper 的签名 `Identifier` 与各自 `CFBundleIdentifier` 一致、Info.plist 已封印。可运行 `PIDECK_RELEASE_BUILD=1 node scripts/verify-mac-signature.mjs --team-id "$MAC_TEAM_ID" --json` 独立核对完整发布策略；`--release-dir` 指定产物目录。不要用仅含 identifier 的自定义签名要求绕过检查，也不要修改用户的 TCC 数据库。根因、官方发布日志、本机只读证据和回归边界见 [更新授权丢失排查报告](macos-update-permissions.md)。
- ad-hoc + 默认 `hardenedRuntime: true` 仍依赖 app-builder-lib 默认 entitlement 中的 `com.apple.security.cs.disable-library-validation`；不要用缺少该项的自有 entitlements 文件覆盖它，否则会阻断 node-pty 等原生模块加载。`build.mac.extendInfo.NSLocalNetworkUsageDescription` 也必须保留。

macOS 发布验收在独立测试账号下覆盖以下场景，CI 的签名校验不能替代真实系统授权回归：

1. 安装旧版并允许文稿、桌面、下载目录访问；记录 `codesign -d -r-` 与 Team ID。仅测试用户已明确允许的目录，不扩大授权范围。
2. 用**同一 Developer ID / Team 和 Bundle ID**构建新版本，覆盖安装与应用内更新分别验证；完全退出重开后，已允许目录仍可访问，不反复要求授权。stable / dev 的 Bundle ID 各自稳定，不合并两个通道的授权身份。
3. 在 PiDeck 终端及 pi 子进程中分别访问授权目录、连接一台局域网主机，并使用局域网模型服务；重启应用后重复。辅助功能、屏幕录制等已有授权也应按实际功能逐项验收，不能由文件夹结果推断全部权限均已继承。
4. 从 ad-hoc 切换到证书签名、换 Team 或本地重签名都可能需要重新授权一次；已有 cdhash 绑定授权不能安全地由应用迁移。发布说明写清这条边界，并分别验证升级前后的权限；不运行全局 `tccutil reset`，不自动申请全磁盘访问。

参考：Apple [TN2206 — Code Designated Requirement](https://developer.apple.com/library/archive/technotes/tn2206/_index.html) 说明系统如何通过 DR 识别更新；Apple [TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy) 说明本地网络的 responsible code 与构建身份注意事项。
