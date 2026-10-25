/**
 * electron-builder 解压目录 rename 的「瞬时占用」重试补丁（纯函数，便于单测）。
 *
 * 问题背景：app-builder-lib 在解压 electron dist（zip/7z/tar 同一段收尾逻辑）时先落到
 * `<dir>.tmp`，全部写完后 `fs.rm(dir)` + `fs.rename(tmpDir, dir)` 就位
 * （见 node_modules/app-builder-lib/out/util/electronGet.js 的 extractArchive）。
 * Windows 上杀软/索引器会短暂持有「刚写入文件」的句柄，该 rename 会返回 EPERM，
 * 而 electron-builder 只 rename 一次、不重试，于是整条 `npm run dist:win` 直接失败。
 *
 * 现场实测（Windows 11 + Defender 实时防护，electron-v43.4.0-win32-x64.zip，348MB/75 文件）：
 * - 解压到 F: 卷：4/4 次 EPERM，句柄 0.1~1.1s 后自行释放；重试即可稳定成功。
 * - 同一份 zip 解压到 C: 卷：4/4 次瞬间成功（占用与「卷/路径」相关，不是 PiDeck 代码问题）。
 * - 同样代码解压人造内容（1 文件 / 350MB 混合文件树）到 F:：4/4 次瞬间成功
 *   → 触发条件与文件内容（真实签名的 PE 二进制）相关，而非文件数量或字节数。
 *
 * 上游该处无重试、也没有可跳过 rename 的开关，因此在安装期给该文件注入有界重试。
 * 应用方式：postinstall（package.json）幂等执行；只重试 EPERM/EACCES/EBUSY，
 * 其它错误与重试耗尽都原样抛出，不吞真实失败。
 */
const fs = require("node:fs");

const PATCH_MARKER = "pideck-patch: extract-rename-retry";

const ELECTRON_GET_MODULE = "app-builder-lib/out/util/electronGet.js";

// electron-builder 收尾就位那行：`await fs.rename(tmpDir, dir);`（空白容忍，允许缩进差异）
const RENAME_CALL_PATTERN = /^([\t ]*)await fs\.rename\(tmpDir,\s*dir\);[\t ]*$/gm;

const SHAPE_ERROR = "app-builder-lib 的 extractArchive 结构与补丁预期不符（上游可能已改动或已内置重试）；请更新 scripts/patch-electron-builder-rename-retry.js";

/**
 * 注入到 extractArchive 之前的有界重试实现。
 * 参数 options 仅用于单测注入小延时；生产调用点不传，走默认 150ms × 40 ≈ 6s 预算。
 */
const RENAME_RETRY_HELPER_SOURCE = `// ${PATCH_MARKER} —— Windows 上刚写盘的文件会被杀软/索引器短暂持有，此处 rename 会 EPERM/EACCES/EBUSY，
// 有界重试等待句柄释放；重试耗尽仍抛原始错误，不掩盖真实失败（现场实测占用 0.1~1.1s）。
async function renameWithRetry(tmpDir, dir, options = {}) {
    const maxAttempts = options.maxAttempts === undefined ? 40 : options.maxAttempts;
    const delayMs = options.delayMs === undefined ? 150 : options.delayMs;
    for (let attempt = 1; ; attempt++) {
        try {
            return await fs.rename(tmpDir, dir);
        }
        catch (error) {
            const code = error && error.code;
            const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
            if (!transient || attempt >= maxAttempts) {
                throw error;
            }
            builder_util_1.log.warn({ tmpDir, dir, attempt, maxAttempts, code }, "extract dir rename blocked by another process; retrying");
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}
`;

/**
 * 给 electronGet.js 源码打补丁：rename 调用改为 renameWithRetry。
 * @param {string} content electronGet.js 原文
 * @returns {string} 补丁后内容；已打过补丁时原样返回
 * @throws 锚点缺失/重复时抛错（结构变化 = 补丁静默失效 = 打包又开始偶发失败）
 */
function patchElectronGetRename(content) {
	if (content.includes(PATCH_MARKER)) {
		return content;
	}
	const matches = [...content.matchAll(RENAME_CALL_PATTERN)];
	if (matches.length !== 1) {
		throw new Error(`${SHAPE_ERROR}（rename 锚点数量 ${matches.length}，期望 1）`);
	}
	const indent = matches[0][1];
	const withCallSite = content.replace(RENAME_CALL_PATTERN, `${indent}await renameWithRetry(tmpDir, dir);`);
	const archiveEntryPattern = /^async function extractArchive\(/m;
	if (!archiveEntryPattern.test(withCallSite)) {
		throw new Error(`${SHAPE_ERROR}（未找到 extractArchive 函数声明）`);
	}
	return withCallSite.replace(archiveEntryPattern, `${RENAME_RETRY_HELPER_SOURCE}async function extractArchive(`);
}

/**
 * 对已安装的 app-builder-lib 应用补丁。
 * @param {{ log?: Console, entry?: string, modulePath?: string }} [options]
 *   entry：直接指定 electronGet.js 路径；modulePath：模块标识符（默认 app-builder-lib 的路径）
 * @returns {{ status: "patched"|"already-patched"|"module-missing", file?: string }}
 */
function applyElectronBuilderRenameRetryPatch(options = {}) {
	const log = options.log ?? console;
	let entry = options.entry;
	if (entry === undefined) {
		try {
			entry = require.resolve(options.modulePath ?? ELECTRON_GET_MODULE);
		} catch {
			log.warn(`[rename-retry] 未找到 ${options.modulePath ?? ELECTRON_GET_MODULE}（生产安装或未装 electron-builder），跳过补丁`);
			return { status: "module-missing" };
		}
	}
	const original = fs.readFileSync(entry, "utf8");
	const patched = patchElectronGetRename(original);
	if (patched === original) {
		return { status: "already-patched", file: entry };
	}
	fs.writeFileSync(entry, patched);
	log.log(`[rename-retry] 已注入 rename 重试补丁：${entry}`);
	return { status: "patched", file: entry };
}

function main() {
	try {
		const result = applyElectronBuilderRenameRetryPatch();
		if (result.status === "already-patched") {
			console.log(`[rename-retry] 补丁已存在，无需处理：${result.file}`);
		}
	} catch (error) {
		// 安装期永不因为补丁失败而中断 npm install；结构变化会在 tests/electronBuilderRenameRetryPatch.test.mjs 里红灯
		console.warn(`[rename-retry] 补丁未应用：${error.message}`);
		console.warn("[rename-retry] 影响：Windows 上打包可能因 EPERM 失败（杀软/索引器占用刚解压的 electron dist）");
	}
}

if (require.main === module) {
	main();
}

module.exports = {
	PATCH_MARKER,
	RENAME_RETRY_HELPER_SOURCE,
	patchElectronGetRename,
	applyElectronBuilderRenameRetryPatch,
};
