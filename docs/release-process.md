# 发版流程（Release Process）

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

`npm run pack`（--dir 快速验证）→ `dist:win/mac/linux`；发版前至少跑过一次目标平台完整安装包的人工 smoke，不依赖 CI 构建成功即发布。

### macOS 签名（无 Apple 证书时的 ad-hoc 策略）

- CI 与打包机都没有 Apple 证书，`package.json` 的 `build.mac.identity: "-"` 是签名身份的唯一来源（`scripts/dist-dev.js` 以 `build.mac` 为基底，dev 通道同样继承）。**不要删这一行**：electron-builder 26.15 起找不到证书时不再回退 ad-hoc（26.8.1 的 `fallBackToAdhoc` 已删除，`scheme.json` 的 identity 说明也写明 "no automatic ad-hoc fallback"），省略它只会得到「签名静默跳过、CI 全绿」的假绿包——0.9.0 的 arm64 包就是这样：没有 `Contents/_CodeSignature`、`Info.plist` 未封印（CodeDirectory identifier 仍是 Electron），Apple Silicon 上停在 `_dyld_start` 打不开（#347）。
- ad-hoc + 默认 `hardenedRuntime: true` 需要 `com.apple.security.cs.disable-library-validation` entitlement，该键已在 app-builder-lib 默认模板里；不要另加一份缺它的 `build/entitlements.mac.plist`（会连累 node-pty 等原生模块加载）。
- 每个 mac 打包 job 在 `Build packages` 之后跑 `node scripts/verify-mac-signature.mjs`（本地打了 mac 包也可手动跑，`--release-dir` 指目录、`--json` 出报告）。判据：`release/mac*/*.app` 存在 + `<app>/Contents/_CodeSignature/CodeResources` 非空 + `codesign --verify --deep --strict` 退出码 0 + （`codesign -dv --verbose=4`）签名 `Identifier` 等于 `Contents/Info.plist` 的 `CFBundleIdentifier`、`Info.plist entries=` 已封印、`Sealed Resources version=` 不是 `none` + `Contents/Frameworks/*.app`（Helper）的签名标识等于各自的 Bundle ID（官方 0.8.0 arm64 全过、0.9.0 arm64 全挂）。后三条是 #347 后续评论补的：0.9.0 的 `Identifier=Electron`、`Info.plist=not bound`、`Sealed Resources=none`、Helper 用通用 `Electron Helper` 标识，这些不会被纯 `--verify` 判红，但会让 macOS 把本地网络授权记在 `Electron` 名下，表现为局域网模型服务连不上、PiDeck 终端 `ssh` 报 `No route to host`。门禁红灯时该 job 会停在上传之前——宁可 Release 缺 mac 资产（红 job 可见、重跑补齐），也不发一个装上去打不开或局域网不可用的包。
- `build.mac.extendInfo.NSLocalNetworkUsageDescription` 是 macOS「本地网络」权限弹窗的说明文案，缺了它系统不会弹窗、本地网络访问可能被默默拒绝；发版时不要删（只影响 Info.plist，不影响签名）。用户从 0.9.0 升级后，系统设置 → 隐私与安全性 → 本地网络里可能残留旧的 `Electron` 条目，发布说明要提示删掉后重新允许 PiDeck。
- mac 人工 smoke 除「能启动」外必须覆盖本地网络：在 PiDeck 终端里 `ssh`/`nc` 一台局域网主机、用局域网地址的模型服务各跑一次，然后重启应用重复一次。这两个场景是签名 identifier 退化时唯一会暴露的用户可见回归（启动正常、局域网 EHOSTUNREACH / No route to host），CI 无法代跑（需要真实局域网与 TCC 授权）。
- 将来拿到 Developer ID：删掉 `build.mac.identity` 这一行、配置 `CSC_LINK`/`CSC_NAME`（需要公证再配 `APPLE_*`）secrets，并同步删掉 `tests/releaseConfig.test.mjs` 里的配置守卫（文件内已写迁移说明）；产物级门禁不用改，它只要求「存在有效 bundle 签名」。
