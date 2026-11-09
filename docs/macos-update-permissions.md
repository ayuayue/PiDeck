# macOS 更新后授权失效排查与修复

状态：基于 `dev` 的 `b7dd4e95b6c5db963843e9c358fdd212a97cb885` 排查并补齐发布策略；证书发布及真实升级验收仍需维护者完成。排查时 GitHub 最新正式版为 `v0.11.3`。本文中的用户路径、签名哈希和自动化目标均不公开。

## 结论与故障链

macOS 可以保留「已允许」的 TCC 记录，但不再把更新后的 PiDeck 视为获得该授权的应用。本次确认的故障链为：

```text
未配置发行证书
  → beforePack 保留 mac.identity = "-"
  → 发布门禁按 secrets 是否存在决定是否验证 Developer ID
  → 无证书只告警，完整性有效的 ad-hoc 包仍被上传
  → 更新改变封印资源 / 二进制，默认 designated requirement 中的 cdhash 改变
  → 旧授权要求不再匹配新应用，出现重新授权或访问失败
```

PR [#498](https://github.com/ayuayue/PiDeck/pull/498) 已接通 Developer ID 签名和严格产物校验，但明确保留了无证书发布的兼容路径。后续发布仍使用该路径，问题因此继续出现。这里需要修正的前提是「缺证书时允许发布，再由用户承担重复授权」，而不是继续放宽签名要求。

本报告涉及 macOS 系统隐私授权。它不把所有登录、API key、Cookie 或宿主插件授权异常归为同一原因；这些持久化链路需要各自证据。

## 官方发布证据

[v0.11.3 的 Release workflow run 42353807143](https://github.com/ayuayue/PiDeck/actions/runs/42353807143) 的 x64 与 arm64 作业均显示：

```text
CSC_LINK:
CSC_KEY_PASSWORD:
CSC_NAME:
signing ... platform=darwin type=distribution identityName=- identityHash=none
Warning: ... 使用 ad-hoc 签名：TCC 权限按二进制 cdhash 记账...
macOS bundles signed (1): ... (identifier=com.ayuayue.pi-desktop, helpers=4)
```

该次 workflow 成功，发布了 macOS 安装包。因此，仅确认 #498 合入或 `codesign --verify --deep --strict` 成功，不能说明发行包已经采用稳定的权限身份。日志中的 `type=distribution` 也不代表实际使用 Developer ID，必须查看真实签名。

## 本机只读证据

环境：macOS 15.7.9 / arm64，已安装 PiDeck 0.11.3。检查没有修改应用、授权记录或用户配置。

```text
Identifier=com.ayuayue.pi-desktop
Signature=adhoc
TeamIdentifier=not set
Info.plist entries=34
Sealed Resources version=2
# designated => cdhash H"<current-hash>"
```

当前应用通过 `codesign --verify --deep --strict`。对用户 TCC 数据库只读查询后，将对应的已保存要求传给系统 `codesign --verify --strict -R=<saved-requirement>`，观察到：

| 系统授权记录 | 保存的状态 | 要求类型 | 当前应用匹配结果 |
| --- | --- | --- | --- |
| 桌面目录 | 允许（auth_value=2） | cdhash | rc=3，不满足旧要求 |
| 多项 AppleEvents 自动化 | 允许（auth_value=2） | cdhash | rc=3，不满足旧要求 |
| 文稿目录 | 允许（auth_value=2） | cdhash | rc=0，匹配 |
| 下载目录 | 允许（auth_value=2） | cdhash | rc=0，匹配 |

不同授权的结果不同，符合各项授权在不同应用身份阶段建立的情况；本次未读取授权时间来推断具体先后顺序。上述对照证明「数据库仍为允许」与「当前应用满足授权要求」是两件事，不能据此声称所有权限都丢失，也不能由文件夹结果推断本地网络、辅助功能或屏幕录制的状态。

没有重新下载并对比当前安装的整个应用与官方资产的哈希；本机证据针对该安装，官方发布证据独立来自 workflow 日志。

## 更新路径与修复范围

当前 `src/main/update/macManualUpdate.ts` 负责获取版本与安装包信息；`manualUpdateDelivery.ts` 负责下载并打开安装器。该路径未发现清空 TCC 授权的操作。macOS 当前交付方式不因本次签名修复改变，也不直接切换为 electron-updater 自动替换。

修复集中在现有发布链路：

1. 打包钩子与校验 CLI 共用签名策略。`PIDECK_RELEASE_BUILD=1` 强制 Developer ID，不受可选签名开关为 false 或缺少 secrets 影响；固定 Team ID 本身也启用严格签名。
2. 发布打包必须提供证书选择与合法的 `PIDECK_MAC_TEAM_ID`。缺证书、空白凭据、显式禁用签名、缺少或非法 Team ID 均停止打包。实际证书不可用时仍由 electron-builder 的 `forceCodeSigning` 阻断。
3. `release.yml` 的 stable/dev 发布与 `build-dev.yml` 的预发布都向构建步骤传入固定 Team ID，并在上传前无条件启用发布签名校验。检查 Apple Developer ID 证书链、主应用/Helper 的 Team、封印和 designated requirement。
4. 保留本地及构建测试用的显式 ad-hoc 兜底，避免 #347 的未封印包回归。测试包不能承诺更新授权保留。stable/dev 原有 Bundle ID 各自保持，不能靠改成同一个身份共享权限。

这项变更会使**未配置发行证书的 macOS 发布失败**，这是阻止同类包继续发行的必要行为。它没有提供、生成或导入维护者的发行私钥，也没有替维护者设置 GitHub secrets。

## 验证与回归

自动化测试使用真实 electron-builder `MacPackager`、注入的产物检查边界，以及系统 `codesign` 签名的临时 bundle：

- 原生测试先保存旧 designated requirement，再修改资源并重新签名；新包完整性通过，而旧要求验证 rc=3，稳定复现升级后的身份失配。
- 缺证书、空白凭据、禁用签名、缺少/非法 Team ID 的回归先在原实现失败，再修复到通过。
- 从两条实际发布 workflow 的 env 读取策略，模拟 secrets/variables 为空；真实 ad-hoc bundle 必须被拒绝，不能再仅依赖脚本单独测试。
- 覆盖有效 Developer ID 的边界数据、错误团队、不可信证书链、cdhash 绑定、过弱要求、Helper 身份以及 stable/dev 差异。
- 保留无证书本地构建、空白凭据清理、Windows/Linux 构建及品牌配置的既有验证。

执行命令（Node.js 24.13.0 / npm 11.6.2）：

```sh
node --test tests/macSigningConfig.test.mjs tests/macSignatureGate.test.mjs tests/macPermissionIdentity.test.mjs tests/releaseConfig.test.mjs tests/appBrandPackaging.test.mjs tests/releaseWorkflowBuildOrigin.test.mjs tests/distDevConfig.test.mjs tests/packageLockIntegrity.test.mjs
npm run typecheck
npx biome format scripts/configure-mac-signing.js scripts/verify-mac-signature.mjs tests/macSigningConfig.test.mjs tests/macSignatureGate.test.mjs tests/macPermissionIdentity.test.mjs
git diff --check
```

上述针对性测试共 71 项通过，类型检查通过，改动文件格式通过。五份相关 workflow 已通过 YAML 解析。未执行全量 `npm run build`，遵守根 AGENTS.md 的构建范围要求；测试不申请实际隐私权限、不访问受保护的用户文件夹、不导入签名私钥。

全仓 `npm run check:format` 有 6 个未触达文件失败，`npm run check:test-shape` 在 `tests/rebindPanelUi.test.mjs` 失败；在相同 `b7dd4e95` 的干净 worktree 中复跑得到相同结果，没有为本次 PR 改写这些文件或刷新基线。附加 AST 诊断对 `defaultReadInfoPlist` 的既有 `JSON.parse` 给出未捕获调用提示，干净基线同样存在，调用方已有错误处理。

## 发行启用与验收边界

维护者需要配置 Developer ID Application 的 `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`，可选 `MAC_CSC_NAME`，以及固定的 Actions variable `MAC_TEAM_ID`。配置方式和逐项升级验收见 [发版流程](release-process.md#macos-签名与更新后的权限保留)。

现有 cdhash 绑定授权不能安全地由应用迁移到另一身份。首次改为 Developer ID、变更 Team 或本地重签后，受影响权限可能仍需用户重新授予；新签名也不会自动恢复已经失配的旧授权。不要用只含 identifier 的宽松 requirement 冒充稳定身份，不要写 TCC 数据库或全局重置授权。

没有维护者的 Developer ID 私钥，本次不能生成真实发行证书签名的两个版本并完成系统授权 UI 验收。发布前仍需在独立 macOS 测试账号下验证同 Team、同 Bundle ID 的连续版本覆盖安装、应用内下载交付及完全重启，分别检查目录、终端/pi 子进程、局域网服务、辅助功能和屏幕录制；不能用 CI 的签名测试替代这些结果。

参考：Apple [TN2206 — Code Designated Requirement](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)；Apple [TN3179 — Understanding local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)。
