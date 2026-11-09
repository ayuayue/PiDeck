/**
 * electron-builder 26.15.x 的 macOS 签名 keychain 补丁（CSC_LINK 路径）。
 *
 * 问题：createKeychain() 用随机密码创建并解锁临时 keychain，但 importCerts() 只收到 `.p12` 的
 * 导入密码，并把它当成 **keychain 自身密码** 传给 `security set-key-partition-list -k`。
 * macOS 26（Darwin 25）的 runner 会严格校验该参数，于是任何走 CSC_LINK 的 mac 签名都在
 * 导入证书阶段失败：
 *   security: SecKeychainUnlock: The user name or passphrase you entered is not correct.
 * CI 没有预装证书的登录钥匙串，只能走 CSC_LINK，所以这是 mac 发版的硬阻塞：2026-11-09 的
 * Build macOS arm64（macos-latest = macOS 26）就挂在这里，而同一次 x64（macos-15-intel）通过。
 *
 * 上游：electron-userland/electron-builder#10066，修复 PR #10101，26.17.0 起正式发布。
 * 本仓库仍固定在 26.15.3（升级会连带 asar/blockmap/dmg 行为变化，需要单独验收），因此按同一处
 * 修复打补丁：把 createKeychain() 的随机密码透传给 importCerts()，只用于 set-key-partition-list
 * 的 `-k`；`security import -P` 仍使用 `.p12` 密码。升级到 >=26.17.0 后本补丁的锚点会消失
 * （postinstall 只 warn，tests/electronBuilderKeychainPasswordPatch.test.mjs 会红灯），届时删除
 * 本文件与 package.json 里的调用即可。
 *
 * 应用方式：postinstall（package.json）幂等执行；结构不符只 warn，不阻断 npm install。
 */
const fs = require("node:fs");

const PATCH_MARKER = "pideck-patch: mac-keychain-password";

const MAC_CODE_SIGN_MODULE = "app-builder-lib/out/codeSign/macCodeSign.js";

// createKeychain() 末尾的调用点：keychainPassword 是随机生成、只用于 create/unlock-keychain 的密码。
const IMPORT_CERTS_CALL = "    return await importCerts(keychainFile, certPaths, cscPasswords);";
// 需要新增第 4 个形参。
const IMPORT_CERTS_SIGNATURE = "async function importCerts(keychainFile, paths, keyPasswords) {";
// 唯一需要换密码的调用：-k 传 keychain 密码，而不是上面 `security import -P` 的 p12 密码。
const PARTITION_LIST_CALL = '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]';

const SHAPE_ERROR = "app-builder-lib 的 macCodeSign 结构与补丁预期不符（上游可能已修复或已改动）；请更新 scripts/patch-electron-builder-keychain-password.js";

/**
 * 给 macCodeSign.js 源码打补丁：把临时 keychain 的密码传给 set-key-partition-list。
 * @param {string} content macCodeSign.js 原文
 * @returns {string} 补丁后内容；已打过补丁时原样返回
 * @throws 锚点缺失/重复时抛错（结构变化 = 补丁静默失效 = mac 签名又开始失败）
 */
function patchMacCodeSignKeychainPassword(content) {
	if (content.includes(PATCH_MARKER)) {
		return content;
	}
	const anchors = [
		["importCerts 调用点", IMPORT_CERTS_CALL],
		["importCerts 函数声明", IMPORT_CERTS_SIGNATURE],
		["set-key-partition-list 调用", PARTITION_LIST_CALL],
	];
	for (const [label, anchor] of anchors) {
		const count = content.split(anchor).length - 1;
		if (count !== 1) {
			throw new Error(`${SHAPE_ERROR}（${label} 锚点数量 ${count}，期望 1）`);
		}
	}
	return content
		.replace(IMPORT_CERTS_CALL, `    // ${PATCH_MARKER} —— set-key-partition-list 的 -k 需要临时 keychain 自己的密码（上游 #10066）\n    return await importCerts(keychainFile, certPaths, cscPasswords, keychainPassword);`)
		.replace(IMPORT_CERTS_SIGNATURE, "async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {")
		.replace(PARTITION_LIST_CALL, '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]');
}

/**
 * 对已安装的 app-builder-lib 应用补丁。
 * @param {{ log?: Console, entry?: string, modulePath?: string }} [options]
 *   entry：直接指定 macCodeSign.js 路径；modulePath：模块标识符（默认 app-builder-lib 的路径）
 * @returns {{ status: "patched"|"already-patched"|"module-missing", file?: string }}
 */
function applyElectronBuilderKeychainPasswordPatch(options = {}) {
	const log = options.log ?? console;
	let entry = options.entry;
	if (entry === undefined) {
		try {
			entry = require.resolve(options.modulePath ?? MAC_CODE_SIGN_MODULE);
		} catch {
			log.warn(`[keychain-password] 未找到 ${options.modulePath ?? MAC_CODE_SIGN_MODULE}（生产安装或未装 electron-builder），跳过补丁`);
			return { status: "module-missing" };
		}
	}
	const original = fs.readFileSync(entry, "utf8");
	const patched = patchMacCodeSignKeychainPassword(original);
	if (patched === original) {
		return { status: "already-patched", file: entry };
	}
	fs.writeFileSync(entry, patched);
	log.log(`[keychain-password] 已注入 macOS 签名 keychain 密码补丁：${entry}`);
	return { status: "patched", file: entry };
}

function main() {
	try {
		const result = applyElectronBuilderKeychainPasswordPatch();
		if (result.status === "already-patched") {
			console.log(`[keychain-password] 补丁已存在，无需处理：${result.file}`);
		}
	} catch (error) {
		// 安装期永不因为补丁失败而中断 npm install；结构变化会在 tests/electronBuilderKeychainPasswordPatch.test.mjs 里红灯
		console.warn(`[keychain-password] 补丁未应用：${error.message}`);
		console.warn("[keychain-password] 影响：macOS 26 runner 上用 CSC_LINK 签名的 mac 包会在导入证书阶段失败（上游 #10066）");
	}
}

if (require.main === module) {
	main();
}

module.exports = {
	PATCH_MARKER,
	IMPORT_CERTS_CALL,
	IMPORT_CERTS_SIGNATURE,
	PARTITION_LIST_CALL,
	patchMacCodeSignKeychainPassword,
	applyElectronBuilderKeychainPasswordPatch,
};
