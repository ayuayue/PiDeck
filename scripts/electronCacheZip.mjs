// @ts-check
/**
 * Electron 缓存 zip 兜底还原：install.js 联网失败时，直接从本地下载缓存解压出一份 dist。
 *
 * 为什么需要这条路径（2026-09 实测，用户机器上复现）：
 * `@electron/get` 的缓存目录名 = **下载 URL 所在目录的 sha256**（见其 `Cache.getCacheDirectory`），
 * 也就是「换下载源 = 换缓存键」。于是「曾经用镜像装成功过」的机器会出现这种组合：
 * 缓存里躺着完整且校验通过的 zip，install.js 却因为「按 GitHub URL 算出的键对不上 + 连不上
 * GitHub」而失败，`npm run dev` 直接报 `Error: Electron uninstall`。
 * 注意 npm 的 `proxy` / `https-proxy` 只作用于 npm 自己的请求，electron 的 postinstall 走
 * `@electron/get`，不读 npm 代理配置 —— 所以「npm 能装包」不代表 electron 能装上。
 *
 * 这里刻意不依赖 URL 派生的键：用 `node_modules/electron/checksums.json`（install.js 自己也用它）
 * 里的文件名 + sha256 在缓存里找，命中就照 install.js 的 extractFile 语义解压（含 electron.d.ts
 * 上移、写 path.txt），全程不联网。安全底线与 install.js 一致：**先校验 sha256 再解压**，
 * 校验不过的候选一律跳过（截断/写坏的 zip 宁可不用，也不能解出一份坏二进制）。
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

/** 默认 fs 依赖包：集中一处，测试可整体替换。 */
const defaultFs = { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync };

/** 错误 → 可读文本（错误对象各字段可能缺席，逐层兜底）。 */
function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 解析 Electron 下载缓存根目录。
 * 优先级对齐工具链：`electron_config_cache`（npm 从 .npmrc 注入，install.js 用的就是它）
 * → `ELECTRON_CACHE`（electron-builder 等历史约定）→ 平台默认（同 env-paths('electron')）。
 */
export function resolveElectronCacheRoot({ env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
	const explicit = env.electron_config_cache || env.ELECTRON_CACHE;
	if (explicit) return explicit;
	if (platform === "win32") return join(env.LOCALAPPDATA || join(homeDir, "AppData", "Local"), "electron", "Cache");
	if (platform === "darwin") return join(homeDir, "Library", "Caches", "electron");
	return join(env.XDG_CACHE_HOME || join(homeDir, ".cache"), "electron");
}

/** 目标平台/架构：与 install.js 同序（ELECTRON_INSTALL_* > npm_config_* > 运行平台）。 */
export function resolveTargetPlatformArch({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
	return {
		platform: env.ELECTRON_INSTALL_PLATFORM || env.npm_config_platform || platform,
		arch: env.ELECTRON_INSTALL_ARCH || env.npm_config_arch || arch,
	};
}

/**
 * 从 checksums.json 里挑出本平台主包的候选（文件名 + 期望 sha256）。
 * checksums.json 的 key 就是下载产物文件名，所以不自己拼名字、也就不会拼错；
 * 只取 `electron-` 主包并精确匹配 `-<platform>-<arch>.zip`，
 * 排除 -symbols / -pdb / -toolchain-profile 等同名旁支（它们解出来不是可用运行时）。
 */
export function parseElectronArtifactCandidates({ checksums, platform, arch } = {}) {
	const suffix = `-${platform}-${arch}.zip`;
	return Object.entries(checksums ?? {})
		.filter(([fileName, sha256]) => fileName.startsWith("electron-") && fileName.endsWith(suffix) && typeof sha256 === "string" && sha256.length > 0)
		.map(([fileName, sha256]) => ({ fileName, sha256 }));
}

/**
 * 在缓存里找指定文件名的 zip。
 * 缓存布局是 `<cacheRoot>/<url目录hash>/<fileName>`，但历史上也有工具把包直接放在缓存根，
 * 所以两处都找。同一文件名可能在多个键目录下各有一份（换过下载源），取最近落盘的那份。
 */
export function findCachedElectronZip({ cacheRoot, fileName, fs = defaultFs } = {}) {
	const readdir = fs.readdirSync ?? readdirSync;
	const stat = fs.statSync ?? statSync;
	const exists = fs.existsSync ?? existsSync;
	const roots = [cacheRoot];
	try {
		for (const entry of readdir(cacheRoot, { withFileTypes: true })) {
			if (entry.isDirectory()) roots.push(join(cacheRoot, entry.name));
		}
	} catch {
		// 缓存根不存在（干净机器）或不可读：保持只有 roots[0]，交给上层给结论。
	}
	const candidates = [];
	for (const root of roots) {
		const candidate = join(root, fileName);
		if (!exists(candidate)) continue;
		try {
			const stats = stat(candidate);
			// 只认非空文件：下载中断会留下 0 字节残留，解压必然失败且报错难懂。
			if (stats.isFile() && stats.size > 0) candidates.push({ path: candidate, size: stats.size, mtimeMs: stats.mtimeMs ?? 0 });
		} catch {
			// 单个候选读不到就跳过，不影响其它候选。
		}
	}
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return candidates[0];
}

/** 流式计算文件 sha256（144MB 的 zip 不能整份读进内存）。 */
export async function hashFileSha256(filePath) {
	const hasher = createHash("sha256");
	await pipeline(createReadStream(filePath), hasher);
	return hasher.digest("hex");
}

/** 校验文件 sha256；`hashFile` 为测试注入点。 */
export async function verifyFileChecksum({ filePath, expectedSha256, hashFile = hashFileSha256 } = {}) {
	const actual = await hashFile(filePath);
	return { ok: actual === expectedSha256, actual };
}

/** zip 内可执行文件名（同 install.js 的 getPlatformPath）。 */
export function resolvePlatformBinaryPath({ platform } = {}) {
	switch (platform) {
		case "mas":
		case "darwin":
			return "Electron.app/Contents/MacOS/Electron";
		case "freebsd":
		case "openbsd":
		case "linux":
			return "electron";
		case "win32":
			return "electron.exe";
		default:
			return null;
	}
}

/**
 * 解析解压实现：从 install.js 的位置解析，保证与 electron 包自己用的是同一份
 * （npm 未提升时也能命中 electron/node_modules 下的副本）。
 * createRequire 只接受绝对路径，所以先 resolve：相对 electronDir 不能变成难懂的参数错误。
 */
async function resolveExtractor({ electronDir, loadExtract }) {
	if (loadExtract) return loadExtract();
	const requireFromElectron = createRequire(resolve(join(electronDir, "install.js")));
	const entry = requireFromElectron.resolve("@electron-internal/extract-zip");
	const mod = await import(pathToFileURL(entry).href);
	const extract = mod.extract ?? mod.default;
	if (typeof extract !== "function") throw new Error("@electron-internal/extract-zip 未导出 extract");
	return extract;
}

/**
 * 兜底修复：缓存里找 zip → 校验 sha256 → 解压进 dist → 写 path.txt。
 * 返回 { ok, zipPath, distDir, binaryPath } 或 { ok:false, detail }（detail 里带下一步该怎么办）。
 */
export async function extractElectronFromCache({ electronDir, env = process.env, platform = process.platform, arch = process.arch, fs = defaultFs, log = console.log, loadExtract, hashFile } = {}) {
	const target = resolveTargetPlatformArch({ env, platform, arch });
	const readFile = fs.readFileSync ?? readFileSync;
	const exists = fs.existsSync ?? existsSync;
	const checksumsPath = join(electronDir, "checksums.json");
	let checksums;
	try {
		checksums = JSON.parse(readFile(checksumsPath, "utf8"));
	} catch (error) {
		return { ok: false, detail: `读不到 ${checksumsPath}（先 npm install electron）：${describe(error)}` };
	}
	const candidates = parseElectronArtifactCandidates({ checksums, platform: target.platform, arch: target.arch });
	if (candidates.length === 0) return { ok: false, detail: `checksums.json 里没有 ${target.platform}-${target.arch} 的 Electron 产物记录` };

	const cacheRoot = resolveElectronCacheRoot({ env, platform });
	const present = candidates.map((candidate) => ({ candidate, hit: findCachedElectronZip({ cacheRoot, fileName: candidate.fileName, fs }) })).filter((item) => item.hit);
	if (present.length === 0) {
		return { ok: false, detail: `本地缓存 ${cacheRoot} 里没有 ${candidates.map((candidate) => candidate.fileName).join(" / ")}；联网可用时 install.js 会自行下载，被墙时先设 ELECTRON_MIRROR（如 https://npmmirror.com/mirrors/electron/）再重跑` };
	}

	const verified = [];
	for (const { candidate, hit } of present) {
		try {
			const verdict = await verifyFileChecksum({ filePath: hit.path, expectedSha256: candidate.sha256, hashFile });
			if (verdict.ok) {
				verified.push({ ...hit, fileName: candidate.fileName });
				continue;
			}
			log(`[electron]   跳过校验不一致的缓存文件 ${hit.path}（sha256 ${verdict.actual.slice(0, 12)}… ≠ ${candidate.sha256.slice(0, 12)}…）`);
		} catch (error) {
			log(`[electron]   跳过无法读取的缓存文件 ${hit.path}：${describe(error)}`);
		}
	}
	if (verified.length === 0) return { ok: false, detail: `缓存里的 zip 都过不了 sha256 校验（可能被截断或写坏），请重新 npm install electron` };

	const zip = verified[0];
	const binaryPath = resolvePlatformBinaryPath({ platform: target.platform });
	if (!binaryPath) return { ok: false, detail: `不支持的平台 ${target.platform}` };
	// ELECTRON_OVERRIDE_DIST_PATH 是 electron 包支持的自定义安装位置，兜底路径同样尊重它。
	const distDir = env.ELECTRON_OVERRIDE_DIST_PATH || join(electronDir, "dist");
	log(`[electron] 从本地缓存还原：${zip.path}`);
	try {
		const extract = await resolveExtractor({ electronDir, loadExtract });
		(fs.mkdirSync ?? mkdirSync)(distDir, { recursive: true });
		await extract(zip.path, { dir: resolve(distDir) });
		// 与 install.js 的 extractFile 对齐：zip 里可能带 electron.d.ts，要挪到 electron 包根目录。
		const typeDefPath = join(distDir, "electron.d.ts");
		if (exists(typeDefPath)) (fs.renameSync ?? renameSync)(typeDefPath, join(electronDir, "electron.d.ts"));
		// path.txt 是 install.js 判断「已安装」的标记之一，内容必须是平台可执行文件名。
		(fs.writeFileSync ?? writeFileSync)(join(electronDir, "path.txt"), binaryPath);
	} catch (error) {
		return { ok: false, detail: `解压 ${zip.path} 失败：${describe(error)}` };
	}
	return { ok: true, zipPath: zip.path, distDir, binaryPath, fileName: zip.fileName };
}
