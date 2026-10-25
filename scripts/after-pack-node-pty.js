/**
 * node-pty-specific afterPack cleanup and artifact verification.
 *
 * Top-level node-pty@1.1.0 does not ship Linux prebuilds. Linux npm installs
 * therefore create build/Release/pty.node, which is the package's only runtime
 * native addon. This module keeps the fallback intact and validates the final
 * asar-to-disk mapping before an installer can be produced.
 */
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const { dirSize, rmDir } = require("./after-pack-file-utils");
const { describeAddon, evaluateBaseline, formatAddonLine } = require("./linux-native-baseline");

const NODE_PTY_RELATIVE_ROOT = "node_modules/node-pty";
const NODE_PTY_PRUNABLE_DIRECTORIES = ["src", "third_party", "deps", "scripts"];

function isNonEmptyFile(filePath) {
	try {
		const stat = fs.statSync(filePath);
		return stat.isFile() && stat.size > 0;
	} catch {
		return false;
	}
}

function nodePtyHasTargetPrebuild(nodePtyDir, targetPlatform) {
	return isNonEmptyFile(path.join(nodePtyDir, "prebuilds", targetPlatform, "pty.node"));
}

/** Clean source-only node-pty directories without deleting a source-built runtime fallback. */
async function cleanNodePtyCompileTimeDirectories(nodePtyDir, targetPlatform, location) {
	if (!fs.existsSync(nodePtyDir)) return 0;

	const hasTargetPrebuild = nodePtyHasTargetPrebuild(nodePtyDir, targetPlatform);
	const directories = hasTargetPrebuild ? [...NODE_PTY_PRUNABLE_DIRECTORIES, "build"] : NODE_PTY_PRUNABLE_DIRECTORIES;
	const locationPrefix = location ? `${location} ` : "";
	let removedBytes = 0;

	for (const directory of directories) {
		const directoryPath = path.join(nodePtyDir, directory);
		if (!fs.existsSync(directoryPath)) continue;
		const size = await dirSize(directoryPath);
		await rmDir(directoryPath);
		removedBytes += size;
		console.log(`  [afterPack] ${locationPrefix}已删除 node-pty ${directory}/ (${(size / 1024 / 1024).toFixed(1)} MB)`);
	}

	const releaseNodePath = path.join(nodePtyDir, "build", "Release", "pty.node");
	if (!hasTargetPrebuild && isNonEmptyFile(releaseNodePath)) {
		// node-gyp layouts vary by version. Keeping the entire fallback tree is safer than pruning it heuristically.
		console.log(`[afterPack] ${locationPrefix}保留 node-pty build/：${targetPlatform} 缺少 prebuild，运行时回退 build/Release`);
	}

	return removedBytes;
}

function asarHeaderNodeForPath(header, relativePath) {
	let node = header;
	for (const segment of relativePath.replaceAll("\\", "/").replace(/^\/+/, "").split("/")) {
		if (!segment) continue;
		node = node?.files?.[segment];
		if (!node) return undefined;
	}
	return node;
}

function nodePtyRuntimeRelativePaths(targetPlatform) {
	return [`${NODE_PTY_RELATIVE_ROOT}/build/Release/pty.node`, `${NODE_PTY_RELATIVE_ROOT}/build/Debug/pty.node`, `${NODE_PTY_RELATIVE_ROOT}/prebuilds/${targetPlatform}/pty.node`];
}

function unpackedPathForAsarFile(asarPath, relativePath) {
	return path.join(path.dirname(asarPath), `${path.basename(asarPath)}.unpacked`, ...relativePath.split("/"));
}

/**
 * Fail closed when Electron cannot resolve node-pty's native addon from the
 * packaged app. Electron requires both the asar unpacked marker and the real
 * app.asar.unpacked file; either omission crashes the main process at startup.
 */
function assertNodePtyRuntimeArtifact(asarPath, targetPlatform) {
	const header = asar.getRawHeader(asarPath).header;
	if (!asarHeaderNodeForPath(header, NODE_PTY_RELATIVE_ROOT)) {
		throw new Error("[afterPack] node-pty package missing from app.asar; terminal startup would crash");
	}

	const candidates = nodePtyRuntimeRelativePaths(targetPlatform);
	for (const relativePath of candidates) {
		const headerNode = asarHeaderNodeForPath(header, relativePath);
		const unpackedPath = unpackedPathForAsarFile(asarPath, relativePath);
		if (headerNode?.unpacked === true && isNonEmptyFile(unpackedPath)) {
			return { relativePath, unpackedPath };
		}
	}

	const details = candidates
		.map((relativePath) => {
			const headerNode = asarHeaderNodeForPath(header, relativePath);
			const unpackedPath = unpackedPathForAsarFile(asarPath, relativePath);
			return `${relativePath} (unpacked=${headerNode?.unpacked === true}, file=${isNonEmptyFile(unpackedPath)})`;
		})
		.join(", ");
	throw new Error(`[afterPack] node-pty runtime artifact missing for ${targetPlatform}: ${details}`);
}

/**
 * Linux 额外核对 glibc/GLIBCXX 符号基线（#257 用户反馈的实际根因）。
 *
 * ubuntu-24.04(-arm) 自带 glibc 2.39，npm ci 现编的 pty.node 会把 openpty/forkpty 绑到
 * GLIBC_2.34（2.34 起这两个符号从 libutil.so.1 并入 libc.so.6），而统信 UOS 20 /
 * 麒麟 V10 仍是 glibc 2.28：dlopen 失败后 node-pty 的 loader 会把真实错误掩盖成
 * "Cannot find module './prebuilds/linux-arm64//pty.node'"，看起来像打包漏了原生模块。
 * 基线内产物由 release.yml 的 Debian 10 容器重建步骤产出；这里 fail-closed，防止重建被
 * 跳过或 runner 工具链升级后静默回退。
 *
 * objdump 不存在时只告警不拦：权威门禁是 CI 里对打包产物的 `scan --fail`，本地缺 binutils
 * 不该阻断打包。
 *
 * @param {string} filePath 已确认存在的 app.asar.unpacked 内原生模块路径
 * @param {{describeAddon?: typeof describeAddon}} [options] 测试注入点
 */
function assertLinuxNativeBaseline(filePath, options = {}) {
	const read = options.describeAddon ?? describeAddon;
	let addon;
	try {
		addon = read(filePath);
	} catch (error) {
		const message = error?.message ?? String(error);
		if (!/无法执行 objdump/.test(message)) throw error;
		console.warn(`[afterPack] 跳过 glibc 基线核对：${message}`);
		return null;
	}
	if (addon.skipped) {
		console.warn(`[afterPack] 跳过 glibc 基线核对：${filePath} 不是 ELF 产物`);
		return null;
	}
	const verdict = evaluateBaseline(addon);
	console.log(`[afterPack] ${formatAddonLine(addon, verdict)}`);
	if (!verdict.ok) {
		throw new Error(`[afterPack] node-pty 产物超出 glibc ${verdict.glibcCeiling} 基线：${verdict.offenders.join(" ")}（${filePath}）；需在基线容器内重建，见 scripts/linux-native-baseline.js`);
	}
	return verdict;
}

module.exports = {
	assertLinuxNativeBaseline,
	assertNodePtyRuntimeArtifact,
	cleanNodePtyCompileTimeDirectories,
};
