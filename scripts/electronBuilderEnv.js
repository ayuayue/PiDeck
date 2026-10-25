/**
 * 本地打包脚本的 Electron 下载源环境（electron-builder / @electron/get）。
 *
 * 为什么需要：electron-builder 取 Electron 二进制走 @electron/get，默认源是
 * github.com；而 @electron/get 的 `validateArtifact` 每次都把 SHASUMS256.txt 以
 * `cacheMode: Bypass` 重新拉一遍（源码注释：Never use the cache for loading
 * checksums）。所以「zip 已在本地缓存」并不等于离线可打包——github.com 不可达时
 * 依然会 `connect ETIMEDOUT`（2026-10 实测：本机缓存 zip 校验完好，仍卡在 SHASUMS）。
 * CI 早已在 workflow 里给 win/linux 矩阵注入 ELECTRON_MIRROR，本地脚本此前没有，
 * 于是只有本地打包踩坑。
 *
 * 规则：
 * - 任一 electron 下载源环境变量（含 `npm_config_*` 形态）已存在时不覆盖——显式设成
 *   空字符串表示「走 github 默认源」（@electron/get 的 mirrorVar 用 `||` 取值，
 *   空串自动落回 BASE_URL），高级用户与 CI 都可据此关闭镜像；
 * - 未配置时默认 npmmirror：Electron 与 electron-builder-binaries（nsis / 7zip /
 *   winCodeSign 等工具集）都走同一镜像站，与 .github/workflows 的矩阵取值一致。
 */
const ELECTRON_MIRROR_DEFAULT = "https://npmmirror.com/mirrors/electron/";
const ELECTRON_BUILDER_BINARIES_MIRROR_DEFAULT = "https://npmmirror.com/mirrors/electron-builder-binaries/";

/** @electron/get 读取的 mirror 环境变量名（顺序与 mirrorVar 一致）。 */
const ELECTRON_MIRROR_KEYS = ["npm_config_electron_mirror", "NPM_CONFIG_ELECTRON_MIRROR", "npm_package_config_electron_mirror", "ELECTRON_MIRROR"];

/** electron-builder 读取的工具集镜像环境变量名（见 app-builder-lib getBinariesMirrorUrl）。 */
const BINARIES_MIRROR_KEYS = ["NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR", "npm_config_electron_builder_binaries_mirror", "npm_package_config_electron_builder_binaries_mirror", "ELECTRON_BUILDER_BINARIES_MIRROR"];

/** 是否已有显式配置（存在即为显式，哪怕值是空字符串）。 */
function hasConfigured(env, keys) {
	return keys.some((key) => Object.prototype.hasOwnProperty.call(env, key));
}

/** 把已配置的值当作 env 的规范键回写，保证子进程看到的是 ELECTRON_MIRROR / ELECTRON_BUILDER_BINARIES_MIRROR。 */
function mirrorValue(env, keys) {
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(env, key)) return env[key];
	}
	return undefined;
}

/**
 * 在给定 env 上补齐 Electron 下载源，返回新对象（不修改入参）。
 * 已配置的来源一律保留，因此 CI 的 `ELECTRON_MIRROR: ""` 语义不变。
 */
function createElectronDownloadEnv({ env = process.env } = {}) {
	const resolved = { ...env };
	// 已配置时保留原值但统一回写到规范键：@electron/get 的 mirrorVar 与 electron-builder 的
	// getBinariesMirrorUrl 都按各自顺序读多套键名，回写规范键让「显式空 = 走 GitHub 默认」在任何键名下都成立。
	resolved.ELECTRON_MIRROR = hasConfigured(env, ELECTRON_MIRROR_KEYS) ? (mirrorValue(env, ELECTRON_MIRROR_KEYS) ?? "") : ELECTRON_MIRROR_DEFAULT;
	resolved.ELECTRON_BUILDER_BINARIES_MIRROR = hasConfigured(env, BINARIES_MIRROR_KEYS) ? (mirrorValue(env, BINARIES_MIRROR_KEYS) ?? "") : ELECTRON_BUILDER_BINARIES_MIRROR_DEFAULT;
	return resolved;
}

/** 打包脚本共用：把下载源补进 spawn 用的子进程 env。 */
function electronBuilderEnv(baseEnv = process.env) {
	return createElectronDownloadEnv({ env: baseEnv });
}

module.exports = {
	createElectronDownloadEnv,
	electronBuilderEnv,
	ELECTRON_MIRROR_DEFAULT,
	ELECTRON_BUILDER_BINARIES_MIRROR_DEFAULT,
	ELECTRON_MIRROR_KEYS,
	BINARIES_MIRROR_KEYS,
};
