/**
 * electron-builder 配置的唯一装配点：以 package.json `build` 为基底，按环境变量决定
 * macOS 签名/公证方式，再可选叠加通道差异项（dist-dev.js 的 PiDeck Dev 覆盖）。
 *
 * 为什么不能只靠 package.json：
 * - electron-builder 26.15 起找不到证书时**不再**回退 ad-hoc（#347），所以 package.json
 *   必须写死 `build.mac.identity: "-"` 才能在无证书环境产出能启动的包；
 * - 但 `identity: "-"` 是硬覆盖——哪怕 CI 注入了 CSC_LINK，electron-builder 也只会 ad-hoc，
 *   Developer ID 证书永远用不上。
 * 两个诉求在静态 JSON 里互斥，只能在加载期按环境裁决：
 *   - 有 Developer ID 凭据（CSC_LINK 或 CSC_NAME 非空）→ 删掉 identity，交给 electron-builder
 *     自动发现（CSC_IDENTITY_AUTO_DISCOVERY 默认 true），并在公证凭据齐全时开启 notarize；
 *   - 否则维持 ad-hoc + notarize:false（ad-hoc 包公证必失败，必须显式关掉而非留给
 *     electron-builder 的「凭据缺失则跳过」——它只跳过未配置，配置了半套会直接抛错）。
 *
 * 其它 mac 签名参数（hardenedRuntime 默认 true、entitlements 默认模板含
 * disable-library-validation、gatekeeperAssess 默认 false）沿用 electron-builder 默认值，
 * 不在仓库另放 entitlements 文件——见 docs/release-process.md「macOS 签名」。
 *
 * 产物级门禁 scripts/verify-mac-signature.mjs 会按同一组环境变量判断「期望 Developer ID」，
 * 保证配置与产物同口径：配了证书却产出 ad-hoc 包时 CI 红。
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
// Binary detection in osx-sign also matches Chromium locale data. The signed framework seals it.
const MAC_RESOURCE_SIGN_IGNORE = "/Electron Framework\\.framework/.*\\.lproj/locale\\.pak$";

/** 空串/纯空白按未配置处理：GitHub Actions 把未设置的 secret 注入为空字符串。 */
function hasValue(value) {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Developer ID 证书是否可用（electron-builder 的两种来源）：
 * - CSC_LINK（+CSC_KEY_PASSWORD）：CI 常用，base64 .p12 导入临时钥匙串；
 * - CSC_NAME：本机登录钥匙串里已装证书时按名称匹配（本地打包）。
 */
function hasDeveloperIdCertificate(env) {
	return hasValue(env.CSC_LINK) || hasValue(env.CSC_NAME);
}

/**
 * 公证凭据是否齐全（与 app-builder-lib MacTargetHelper.getNotarizeOptions 三条路径一致）：
 * Apple ID + app 专用密码 + Team ID；或 App Store Connect API key 三元组；或 notarytool
 * keychain profile。半套凭据视为未配置（electron-builder 会对半套直接抛错，所以这里也
 * 不开 notarize，让 verify 门禁去报「签了但没公证」）。
 */
function hasNotarizationCredentials(env) {
	if (hasValue(env.APPLE_ID) && hasValue(env.APPLE_APP_SPECIFIC_PASSWORD) && hasValue(env.APPLE_TEAM_ID)) return true;
	if (hasValue(env.APPLE_API_KEY) && hasValue(env.APPLE_API_KEY_ID) && hasValue(env.APPLE_API_ISSUER)) return true;
	if (hasValue(env.APPLE_KEYCHAIN_PROFILE)) return true;
	return false;
}

/**
 * 解析 mac 签名策略。返回值：
 * - mode: "developer-id" | "adhoc"
 * - notarize: 是否开启公证（仅 developer-id 且凭据齐全）
 * - mac: 要合并进 build.mac 的字段（developer-id 模式下 identity 为 undefined = 删除该键）
 */
function resolveMacSigning(env = process.env) {
	const certificate = hasDeveloperIdCertificate(env);
	const notarize = hasNotarizationCredentials(env);
	if (env.PIDECK_MAC_REQUIRE_NOTARIZATION === "1") {
		if (!certificate) throw new Error("macOS 正式发布需要 Developer ID 证书：请配置 CSC_LINK 或 CSC_NAME");
		if (!notarize) throw new Error("macOS 正式发布需要完整公证凭据：APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID，或 API key / keychain profile");
	}
	if (!certificate) {
		return { mode: "adhoc", notarize: false, mac: { identity: "-", notarize: false } };
	}
	return { mode: "developer-id", notarize, mac: { identity: undefined, notarize } };
}

/** 子对象按一层浅合并，保留 icon/target 等既有键；标量/数组整体替换。 */
function mergeOverrides(baseConfig, overrides) {
	const merged = { ...baseConfig };
	for (const [key, value] of Object.entries(overrides ?? {})) {
		const isPlainObject = typeof value === "object" && value !== null && !Array.isArray(value);
		merged[key] = isPlainObject ? { ...(baseConfig[key] ?? {}), ...value } : value;
	}
	return merged;
}

function readBaseBuildConfig() {
	return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).build;
}

/**
 * 生成完整 electron-builder 配置（`--config` 外部文件是完整配置、不与 package.json 合并，
 * 所以这里必须返回全量）。
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] 测试注入
 * @param {object} [options.overrides] 通道差异项（dist-dev.js 的 DEV_OVERRIDES）
 * @param {object} [options.baseConfig] 测试注入的基底，默认读 package.json build
 */
function createElectronBuilderConfig(options = {}) {
	const env = options.env ?? process.env;
	const baseConfig = options.baseConfig ?? readBaseBuildConfig();
	const config = mergeOverrides(baseConfig, options.overrides);
	const signing = resolveMacSigning(env);
	const mac = { ...(config.mac ?? {}) };
	const ignored = mac.signIgnore == null ? [] : Array.isArray(mac.signIgnore) ? mac.signIgnore : [mac.signIgnore];
	mac.signIgnore = [...new Set([MAC_RESOURCE_SIGN_IGNORE, ...ignored])];
	for (const [key, value] of Object.entries(signing.mac)) {
		if (value === undefined) delete mac[key];
		else mac[key] = value;
	}
	config.mac = mac;
	if (env.PIDECK_MAC_REQUIRE_NOTARIZATION === "1") config.forceCodeSigning = true;
	return config;
}

module.exports = {
	hasDeveloperIdCertificate,
	hasNotarizationCredentials,
	resolveMacSigning,
	mergeOverrides,
	createElectronBuilderConfig,
};
