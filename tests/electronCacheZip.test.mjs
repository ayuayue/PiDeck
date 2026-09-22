// @ts-check
/**
 * Electron 缓存 zip 兜底还原的回归测试。
 *
 * 背景：`@electron/get` 的缓存目录名 = 下载 URL 目录的 sha256，换过镜像的机器上 install.js
 * 按 GitHub URL 算出的键永远对不上本地那份缓存，于是「缓存里有完整 zip 却报 Electron
 * uninstall」。本测试锁住这条兜底路径的判据：只认本平台主包、必须先过 sha256 再解压、
 * 解压后要按 install.js 的语义写好 electron.d.ts 与 path.txt。
 *
 * 端到端部分刻意用真实临时目录 + 注入假解压器：真实 fs 行为（目录布局、文件落盘）是要验的对象，
 * 而 zip 解压本身属于 electron 包的依赖，不是本模块的实现。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const cacheModule = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "electronCacheZip.mjs")).href);
const { extractElectronFromCache, findCachedElectronZip, hashFileSha256, parseElectronArtifactCandidates, resolveElectronCacheRoot, resolvePlatformBinaryPath, resolveTargetPlatformArch, verifyFileChecksum } = cacheModule;

/** 造一个临时目录，测试结束即删（Windows 上必须递归 + force）；必须 await，否则删在异步体内前。 */
async function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-electron-cache-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** 真实 sha256，用来造「校验能过」的 checksums.json。 */
function sha256OfFile(filePath) {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

test("resolveElectronCacheRoot 先认工具链显式覆盖，再按平台默认（同 env-paths('electron')）", () => {
	// install.js 会把 .npmrc 里的 electron_config_cache 传进 @electron/get，它优先级最高。
	assert.equal(resolveElectronCacheRoot({ env: { electron_config_cache: "/c1", ELECTRON_CACHE: "/c2" }, platform: "win32" }), "/c1");
	assert.equal(resolveElectronCacheRoot({ env: { ELECTRON_CACHE: "/c2" }, platform: "win32" }), "/c2");
	assert.equal(resolveElectronCacheRoot({ env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, platform: "win32" }), join("C:\\Users\\u\\AppData\\Local", "electron", "Cache"));
	assert.equal(resolveElectronCacheRoot({ env: {}, platform: "darwin", homeDir: "/home/u" }), join("/home/u", "Library", "Caches", "electron"));
	assert.equal(resolveElectronCacheRoot({ env: { XDG_CACHE_HOME: "/xdg" }, platform: "linux" }), join("/xdg", "electron"));
	assert.equal(resolveElectronCacheRoot({ env: {}, platform: "linux", homeDir: "/home/u" }), join("/home/u", ".cache", "electron"));
});

test("resolveTargetPlatformArch 的覆盖顺序与 install.js 一致", () => {
	assert.deepEqual(resolveTargetPlatformArch({ env: { ELECTRON_INSTALL_PLATFORM: "darwin", ELECTRON_INSTALL_ARCH: "arm64" }, platform: "win32", arch: "x64" }), { platform: "darwin", arch: "arm64" });
	assert.deepEqual(resolveTargetPlatformArch({ env: { npm_config_platform: "linux", npm_config_arch: "ia32" }, platform: "win32", arch: "x64" }), { platform: "linux", arch: "ia32" });
	assert.deepEqual(resolveTargetPlatformArch({ env: {}, platform: "win32", arch: "x64" }), { platform: "win32", arch: "x64" });
});

test("parseElectronArtifactCandidates 只取本平台主包，排除 symbols/pdb/旁支产物", () => {
	const checksums = {
		"electron-v43.4.0-win32-x64.zip": "aaa",
		"electron-v43.4.0-win32-x64-symbols.zip": "bbb",
		"electron-v43.4.0-win32-x64-pdb.zip": "ccc",
		"electron-v43.4.0-win32-x64-toolchain-profile.zip": "ddd",
		"electron-v43.4.0-win32-arm64.zip": "eee",
		"electron-v43.4.0-linux-x64.zip": "fff",
		"ffmpeg-v43.4.0-win32-x64.zip": "ggg",
		"mksnapshot-v43.4.0-win32-x64.zip": "hhh",
		"chromedriver-v43.4.0-win32-x64.zip": "iii",
		"electron-v43.4.0-win32-x64.zip.sha256sum": "jjj",
	};
	assert.deepEqual(parseElectronArtifactCandidates({ checksums, platform: "win32", arch: "x64" }), [{ fileName: "electron-v43.4.0-win32-x64.zip", sha256: "aaa" }]);
	assert.deepEqual(parseElectronArtifactCandidates({ checksums, platform: "linux", arch: "x64" }), [{ fileName: "electron-v43.4.0-linux-x64.zip", sha256: "fff" }]);
	// 没有对应平台的记录时给空数组，让上层报「checksums.json 里没有 …」而不是瞎猜文件名。
	assert.deepEqual(parseElectronArtifactCandidates({ checksums, platform: "win32", arch: "ia32" }), []);
	assert.deepEqual(parseElectronArtifactCandidates({ checksums: undefined, platform: "win32", arch: "x64" }), []);
});

test("findCachedElectronZip 在缓存根与 hash 子目录里找，取最近落盘的非空文件", async () => {
	await withTempDir((dir) => {
		const fileName = "electron-v1.0.0-win32-x64.zip";
		// 缓存布局有两种历史形态：`<root>/<hash>/<file>`（@electron/get）与直接放根目录。
		mkdirSync(join(dir, "hash-a"));
		mkdirSync(join(dir, "hash-b"));
		writeFileSync(join(dir, "hash-a", fileName), "old");
		writeFileSync(join(dir, "hash-b", fileName), "new");
		writeFileSync(join(dir, fileName), "root");

		const hit = findCachedElectronZip({ cacheRoot: dir, fileName });
		assert.ok(hit);
		assert.ok(hit.size > 0);
		// 三个候选都读到（根目录那份也在），只是按 mtime 只有一个是「最新」。
		assert.ok(existsSync(hit.path));

		// 0 字节残留（下载中断）不算候选：解压它只会得到难懂的报错。
		const emptyDir = join(dir, "empty");
		mkdirSync(emptyDir);
		writeFileSync(join(emptyDir, fileName), "");
		const onlyEmpty = findCachedElectronZip({ cacheRoot: emptyDir, fileName });
		assert.equal(onlyEmpty, null);

		// 缓存根本不存在（干净机器）也不能抛错。
		assert.equal(findCachedElectronZip({ cacheRoot: join(dir, "missing"), fileName }), null);
		// 文件名必须精确匹配，不能把 symbols 包当成主包。
		assert.equal(findCachedElectronZip({ cacheRoot: dir, fileName: "electron-v1.0.0-win32-x64-symbols.zip" }), null);
	});
});

test("resolvePlatformBinaryPath 与 install.js 的 getPlatformPath 对齐", () => {
	assert.equal(resolvePlatformBinaryPath({ platform: "win32" }), "electron.exe");
	assert.equal(resolvePlatformBinaryPath({ platform: "darwin" }), "Electron.app/Contents/MacOS/Electron");
	assert.equal(resolvePlatformBinaryPath({ platform: "mas" }), "Electron.app/Contents/MacOS/Electron");
	assert.equal(resolvePlatformBinaryPath({ platform: "linux" }), "electron");
	// 未知平台返回 null，由上层给「不支持的平台」结论（不抛异常，修复路径不该炸）。
	assert.equal(resolvePlatformBinaryPath({ platform: "plan9" }), null);
});

test("verifyFileChecksum 用真实文件流算 sha256，不一致时必须判否", async () => {
	await withTempDir(async (dir) => {
		const file = join(dir, "artifact.bin");
		writeFileSync(file, "electron-artifact-bytes");
		const expected = sha256OfFile(file);
		assert.equal(await hashFileSha256(file), expected);
		assert.deepEqual(await verifyFileChecksum({ filePath: file, expectedSha256: expected }), { ok: true, actual: expected });
		// 截断/写坏的包：sha256 必然不同，宁可不修也不能解出一份坏二进制。
		const broken = await verifyFileChecksum({ filePath: file, expectedSha256: "0".repeat(64) });
		assert.equal(broken.ok, false);
		assert.equal(broken.actual, expected);
	});
});

test("extractElectronFromCache 命中缓存 zip：校验 → 解压 → 上移 electron.d.ts → 写 path.txt", async () => {
	await withTempDir(async (dir) => {
		const electronDir = join(dir, "node_modules", "electron");
		const cacheRoot = join(dir, "cache");
		const fileName = "electron-v9.9.9-win32-x64.zip";
		const zipPath = join(cacheRoot, "d4f166ee", fileName);
		mkdirSync(join(electronDir), { recursive: true });
		mkdirSync(join(cacheRoot, "d4f166ee"), { recursive: true });
		writeFileSync(zipPath, "fake-zip-bytes");
		writeFileSync(join(electronDir, "checksums.json"), JSON.stringify({ [fileName]: sha256OfFile(zipPath) }));

		const extracted = [];
		const result = await extractElectronFromCache({
			electronDir,
			env: { electron_config_cache: cacheRoot },
			platform: "win32",
			arch: "x64",
			log: () => {},
			// 假解压器：真实解压属于 electron 包的依赖，这里只验本模块的解压前后处理。
			loadExtract: async () => async (zip, options) => {
				extracted.push({ zip, dir: options.dir, absolute: options.dir === join(electronDir, "dist") });
				writeFileSync(join(options.dir, "electron.exe"), "binary");
				writeFileSync(join(options.dir, "electron.d.ts"), "types");
			},
		});

		assert.equal(result.ok, true);
		assert.equal(result.zipPath, zipPath);
		assert.equal(result.binaryPath, "electron.exe");
		assert.equal(extracted.length, 1);
		assert.equal(extracted[0].absolute, true, "解压目标必须是绝对路径（extract-zip 的要求）");
		// install.js 的 isInstalled() 认这两个标记：path.txt 内容 + dist/version 由 zip 自带。
		assert.equal(readFileSync(join(electronDir, "path.txt"), "utf8"), "electron.exe");
		// electron.d.ts 要挪到 electron 包根目录，否则 TS 类型解析会退化。
		assert.equal(existsSync(join(electronDir, "electron.d.ts")), true);
		assert.equal(existsSync(join(electronDir, "dist", "electron.d.ts")), false);
		assert.equal(readFileSync(join(electronDir, "dist", "electron.exe"), "utf8"), "binary");
	});
});

test("extractElectronFromCache 拒绝 sha256 不一致的缓存包（截断/写坏宁可不用）", async () => {
	await withTempDir(async (dir) => {
		const electronDir = join(dir, "node_modules", "electron");
		const cacheRoot = join(dir, "cache");
		const fileName = "electron-v9.9.9-win32-x64.zip";
		mkdirSync(electronDir, { recursive: true });
		mkdirSync(join(cacheRoot, "hash"), { recursive: true });
		writeFileSync(join(cacheRoot, "hash", fileName), "truncated");
		writeFileSync(join(electronDir, "checksums.json"), JSON.stringify({ [fileName]: "0".repeat(64) }));

		let extractCalled = false;
		const result = await extractElectronFromCache({
			electronDir,
			env: { electron_config_cache: cacheRoot },
			platform: "win32",
			arch: "x64",
			log: () => {},
			loadExtract: async () => async () => {
				extractCalled = true;
			},
		});
		assert.equal(result.ok, false);
		assert.match(result.detail, /sha256 校验/);
		assert.equal(extractCalled, false, "校验没过就绝不能解压");
		assert.equal(existsSync(join(electronDir, "path.txt")), false, "失败时不留半截安装标记");
	});
});

test("extractElectronFromCache 缓存缺包/缺 checksums.json 时给出可执行的下一步", async () => {
	await withTempDir(async (dir) => {
		const electronDir = join(dir, "node_modules", "electron");
		const cacheRoot = join(dir, "cache");
		mkdirSync(electronDir, { recursive: true });
		mkdirSync(cacheRoot, { recursive: true });
		const fileName = "electron-v9.9.9-win32-x64.zip";
		writeFileSync(join(electronDir, "checksums.json"), JSON.stringify({ [fileName]: "a".repeat(64) }));

		// 缓存里没有包：结论必须带上缓存路径与镜像提示（用户下一步就是设 ELECTRON_MIRROR）。
		const missingZip = await extractElectronFromCache({ electronDir, env: { electron_config_cache: cacheRoot }, platform: "win32", arch: "x64", log: () => {} });
		assert.equal(missingZip.ok, false);
		assert.match(missingZip.detail, new RegExp(fileName.replace(/[.]/g, "\\.")));
		assert.match(missingZip.detail, /ELECTRON_MIRROR/);

		// 平台/架构没有对应产物记录（如 npm_config_arch 被设成别的值）。
		const wrongPlatform = await extractElectronFromCache({ electronDir, env: { electron_config_cache: cacheRoot }, platform: "win32", arch: "arm64", log: () => {} });
		assert.equal(wrongPlatform.ok, false);
		assert.match(wrongPlatform.detail, /没有 win32-arm64 的 Electron 产物记录/);

		// checksums.json 缺失 = electron 包本身没装好，先 npm install。
		const noChecksums = await extractElectronFromCache({ electronDir: join(dir, "empty-electron"), env: { electron_config_cache: cacheRoot }, platform: "win32", arch: "x64", log: () => {} });
		assert.equal(noChecksums.ok, false);
		assert.match(noChecksums.detail, /checksums\.json/);
		assert.match(noChecksums.detail, /npm install electron/);
	});
});
