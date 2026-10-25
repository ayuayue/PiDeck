// 配置守卫：build.nsis 不得包含 allowDowngrade。
// 反向守卫原因（2026-09-25 channel-switch PoC 结论）：electron-builder 26.x（app-builder-lib
// scheme.json 的 NsisOptions additionalProperties:false）没有 allowDowngrade 这个配置项，
// 误加会在打包时被 @develar/schema-utils 校验直接抛
// "configuration.nsis has an unknown property 'allowDowngrade'"（InvalidConfigurationError），
// 所有 electron-builder 构建全部失败。
// dev→stable 降级覆盖安装不需要任何配置：NSIS 模板 uninstallOldVersion
// （app-builder-lib/templates/nsis/include/installUtil.nsh）只读注册表后无条件执行旧版卸载器，
// 没有版本比较逻辑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("build.nsis 不得包含 allowDowngrade（electron-builder 26.x 无此键，误加即炸构建）", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.ok(!("allowDowngrade" in (pkg.build?.nsis ?? {})), "build.nsis.allowDowngrade 不是 electron-builder 26.x 的合法配置项；降级安装由 NSIS 模板无条件卸载旧版天然支持");
});

// 配置守卫：build.mac.identity 必须显式 "-"（ad-hoc 签名）。// 反向守卫原因（2026-10 issue #347）：electron-builder 26.15 删除了「arm64/universal 找不到
// 证书时自动改用 ad-hoc」的 fallBackToAdhoc（26.8.1 的 macPackager.js 里还有：
// `const fallBackToAdhoc = (arch === arm64 || arch === universal) && !this.forceCodeSigning`），
// 而本仓库没有任何 CSC_*/APPLE_* 签名密钥，于是签名被静默跳过、CI 依旧绿灯：0.9.0 官方
// arm64 包的 PiDeck.app 没有 Contents/_CodeSignature，CodeDirectory identifier 仍是 Electron、
// nSpecialSlots=0（Info.plist 未封印），Apple Silicon 上停在 _dyld_start 起不来。
// 显式 identity: "-" 才走 ad-hoc；默认 hardenedRuntime: true 要求
// com.apple.security.cs.disable-library-validation entitlement——靠 app-builder-lib 默认模板
// （本仓库未提供自有 entitlements 文件，别为了「自定义」把它覆盖成缺这条的版本，否则原生模块加载会被拦下）。
// 将来拿到 Developer ID 证书：删掉这一行 + 配 CSC_LINK/CSC_NAME secrets，本测试需同步删除
//（产物级门禁 tests/macSignatureGate.test.mjs 不区分 ad-hoc/正式证书，无需改动）。
test('build.mac.identity 必须显式 "-"：无证书时 electron-builder 26.15+ 不再自动回退 ad-hoc（#347）', () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.build?.mac?.identity, "-", "无 Apple 证书时必须显式 ad-hoc：省略该键会产出没有任何 bundle 签名的 mac 包（Apple Silicon 启动即失败），而 CI 不会报错");
});

// 配置守卫：本项目依赖 mac.identity 这个键存在且接受字符串，electron-builder 升级后若键名/类型漂移，
// 上面那条 identity: "-" 会变成无效配置（27.x 可能直接抛 unknown property），需要当次发现。
test("electron-builder scheme 仍把 mac.identity 定义为字符串键（升级后语义/键名漂移即拦下）", () => {
	const scheme = JSON.parse(readFileSync(new URL("../node_modules/app-builder-lib/scheme.json", import.meta.url), "utf8"));
	const identity = scheme.definitions?.MacConfiguration?.properties?.identity;
	assert.ok(identity, "app-builder-lib scheme.json 已没有 MacConfiguration.properties.identity：显式 ad-hoc 签名需要一个合法入口");
	assert.match(JSON.stringify(identity.type), /string/);
});

// 配置守卫：mac 必须在 Info.plist 里声明 NSLocalNetworkUsageDescription。
// 原因（#347 后续评论）：macOS 的「本地网络」授权弹窗读这条文案，缺失时系统不弹窗，
// 局域网模型服务与终端 SSH 可能被默默拒绝（与签名 identifier 退化是两个独立故障点）。
// 该键只进 Info.plist，不影响签名与公证，删除不会报错——所以用测试钉住。
test("build.mac.extendInfo 必须声明 NSLocalNetworkUsageDescription（本地网络授权说明）", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const description = pkg.build?.mac?.extendInfo?.NSLocalNetworkUsageDescription;
	assert.equal(typeof description, "string", "build.mac.extendInfo.NSLocalNetworkUsageDescription 缺失：macOS 不会为本地网络访问弹授权说明");
	assert.ok(description.trim().length > 0, "NSLocalNetworkUsageDescription 不能为空字符串");
});
