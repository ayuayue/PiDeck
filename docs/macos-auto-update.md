# macOS 自动更新恢复

状态：恢复已签名 macOS 安装的自动更新；启用条件仍包括可用于发行的 Developer ID 签名。维护者在 PR [#514](https://github.com/ayuayue/PiDeck/pull/514) 的关闭说明中确认已付费开通苹果开发者账号；本项沿用仓库已有的证书配置支持，不强制修改无证书发布策略，也不依赖 #514 合入。

## 根因

排查时正式版为 `v0.11.3`。当前安装为 ad-hoc，不能依靠 Squirrel.Mac 直接完成不同身份之间的自动替换。除此之外，源码还存在三项独立阻碍：

1. `resolveAppUpdateDeliveryPlan` 对 `darwin` 无条件返回 `manual/mac-unsigned`。即使之后发布了有效 Developer ID 包，运行时也不会启用现有 electron-updater。
2. `AppUpdateCard` 将 `platform === "darwin"` 与手动交付相或；开发设置页也在 Mac 上直接隐藏自动下载开关。因此即使主进程返回自动交付，界面仍会显示打开安装包或缺少下载入口。
3. `release.yml` 与 `build-dev.yml` 的两个 macOS 架构任务分别上传同名清单，后完成者覆盖前者。下载的官方 `v0.11.3/latest-mac.yml` 只有 `PiDeck-0.11.3-x64.zip` / `.dmg`，没有 arm64 项。electron-updater 6.8.9 的 MacUpdater 会根据这些项挑 ZIP；在 Apple Silicon 上只有 x64 时允许回退到 Intel 包，在 Intel 上若清单只剩 arm64 则无可用 ZIP。

第三项的核查命令：

```sh
gh release download v0.11.3 --repo ayuayue/PiDeck --pattern latest-mac.yml
```

签名支持、启动时能力判定、设置页、双架构更新清单必须同时具备，才能形成可用的自动更新链。

## 实现与边界

- 启动时对当前打包的 `.app` 做有界的系统 `codesign` 探测：要求 Developer ID Application 的 Apple 证书链有效，Team 与 designated requirement 一致且不绑定 cdhash；失败、超时、无证书或源码运行都保留手动交付。不根据版本号、CI 环境变量或显示名称推断签名。
- 主进程 IPC 装配等待能力探测完成，再创建原有 `UpdateService`；没有建立另一条更新通道。有效签名的 Mac 使用现有自动下载和用户确认后的 `quitAndInstall`，保留设置/编辑器保存确认、退出标记及安装失败恢复。
- 设置页遵循主进程快照，签名 Mac 可看到自动下载开关、下载动作和「重启并安装」；旧 ad-hoc 安装继续显示手动下载/打开 DMG。
- 两条发布入口先将每个架构的 `*-mac.yml` 上传为 workflow artifact，禁止从构建任务直接发布不完整清单。共用的 workflow 等构建和安装包上传完成后合并清单，检查版本、品牌、ZIP 架构、大小与 SHA-512，再由单个发布者上传。
- 同时支持 `latest-mac.yml` 与 `beta-mac.yml` 等实际生成的通道文件。现代客户端从 `files` 选择原生 ZIP，旧字段 `path/sha512` 保留 Intel 回退。stable/dev 不混用品牌或签名身份。
- 正式版 latest 收尾与后续 runtime 打包等待清单发布完成，避免镜像资产稳定检测先看见 runtime 齐全而漏掉清单。

签名、目录与权限的边界：必须先手动安装一份有效 Developer ID 版本，后续同 Team/同 Bundle ID 的版本才能由原生更新器验证替换。配置发行证书本身不会给现有 ad-hoc 安装自动补证书；第一次切换签名身份时仍可能需要重新授权。不得禁用 Squirrel 签名校验、重签下载的应用或用 identifier-only 要求绕过身份。

本项不自动安装当前机器上的 PiDeck，也不更改用户设置、更新缓存或 GitHub Release 资产。

## 验证

本机 Node.js 24.13.0 / npm 11.6.2，macOS 15.7.9 / arm64。已同步最新 `dev`（`7aeb6af4`）并复跑：相关更新、启动装配和保存确认测试共 **157 项通过、0 失败、0 跳过**；macOS 专项 CI 命令在本机 **73 项通过**；`npm run typecheck`、全仓 `npm run check:format`、`git diff --check` 通过。四份 workflow 已通过 actionlint。主进程入口由 8286 行减至 8280 行。

全仓 `check:test-shape` 的 `rebindPanelUi.test.mjs` 问题在干净基线复现。曾启动全量 `npm test`，发现未安装 Electron 运行时导致 AgentManager 等测试加载失败，以及 ACP 退出、afterPack、记忆路径、activate 等既有失败；代表性失败已在基线复现，随后停止受阻运行。**不将这次全量运行宣称为通过，也未为此修改无关测试或检查基线。**

- 原实现上，新增真实卡片/设置页渲染回归三项失败，签名 Mac 的纯能力判定失败；修复后通过。
- 使用临时真实 ad-hoc bundle 及系统 codesign 验证旧包保留手动交付。只读探测当前 PiDeck 得到 `manual/mac-unsigned`，对本机另一有效 Developer ID 应用探测得到 `automatic`，没有启动或修改对照应用。
- 使用 electron-updater 6.8.9 自带的 `MacUpdater.filterFilesForArch` 检查 Intel、Apple Silicon/Rosetta 的选择。对两条实际 workflow 的合并命令运行临时架构输入，验证生成的清单。
- 覆盖缺失架构、版本不一致、非法 digest、混合品牌、系统校验失败/超时；验证既有检查、自动下载偏好、手动交付、安装退出、失败恢复和未保存内容守卫。
- IPC 装配改为等待异步探测后，更新两处旧源码测试的定位规则，使其接受 `async function` / `await`，原有飞书和领域装配断言保留。

未使用维护者发行私钥构建连续两个版本，未执行真实 Squirrel 替换当前应用，也未运行全量打包。真实发布验收仍需用独立 macOS 账号和相同 Team 的连续发行包，分别验证 x64、arm64、Rosetta、stable/dev，以及官方源和镜像源。

发布前检查：

1. 确认仓库已有的发行证书与固定 Team 配置已生效，主应用与 Helpers 通过发布签名门禁。
2. 检查 Release 同时含两个架构的 ZIP/DMG；对应 `*-mac.yml` 的 `files` 同时含 arm64/x64 ZIP 且摘要匹配。
3. 从第一份 Developer ID 包启动，自动下载新版本后确认安装；完全重开验证版本、配置、目录授权与终端/pi 子进程。开发通道应选择包含相应 beta 清单的 GitHub 预发布源；当前 AtomGit 仅镜像 stable，不能提供另一 Bundle ID 的 dev 自动升级，原生签名验证也不会允许用 stable 包替换 dev 应用。
4. 无签名旧包仍应可以检测并下载合适的 DMG，作为一次性过渡；不能显示已具备自动替换能力。

参考：electron-builder [Auto Update](https://www.electron.build/auto-update.html) 的 macOS ZIP 要求与 [macOS signing identity](https://www.electron.build/features/key-rotation.html)；行为以本项目锁定的 electron-updater 6.8.9 源码和回归为准。
