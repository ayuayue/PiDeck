/**
 * Electron 二进制体检 / 修复。
 *
 *   node scripts/check-electron.mjs            体检（退出码非 0 = 二进制起不来）
 *   node scripts/check-electron.mjs --repair   按本地缓存 zip 重新解压修复
 *   等价 npm 脚本：npm run check:electron [-- --repair]
 *
 * 背景（2026-09-21 实测）：某次安装把 node_modules/electron/dist/electron.exe 写坏了
 * （大小与缓存 zip 一致、内容不同），`npm run dev` 的表现是「打印完构建日志 + start
 * electron app... 之后直接结束」，退出码 127 —— 子进程创建失败，看起来像代码问题。
 * 本脚本把这类问题在开发一开始就点明，并提供一条命令的修复路径。
 *
 * 修复分两段，先走官方路径、再走本地兜底：
 *   1) 删掉 install.js 判断「已安装」的两个标记（dist 与 path.txt）后跑 install.js —— 缓存 zip
 *      命中时它本地解压、不联网（缓存 zip 在 %LOCALAPPDATA%/electron/Cache、~/.cache/electron、
 *      ~/Library/Caches/electron 里）。
 *   2) install.js 失败（典型：连不上 GitHub，`Error: Electron uninstall`）时，改用
 *      scripts/electronCacheZip.mjs 直接从缓存 zip 还原 —— 见该模块顶部：@electron/get 的缓存
 *      目录名是**下载 URL 的 sha256**，换过镜像的机器上 install.js 按 GitHub URL 算出的键永远
 *      对不上自己那份缓存；按「文件名 + sha256」找则不受影响，所以这一步能离线救回来。
 * 两段都失败才算修复失败，并把两段原因一起报出来。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractElectronFromCache } from "./electronCacheZip.mjs";
import probeModule from "./electronBinaryProbe.js";

const { formatProbeFailure, probeElectronBinary } = probeModule;

/** 读取 electron 包版本号，仅用于打印可读结论。 */
export function readElectronVersion({ electronDir, fs = { existsSync, readFileSync } } = {}) {
	try {
		const manifestPath = join(electronDir, "package.json");
		if (!fs.existsSync(manifestPath)) return null;
		const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

/**
 * 删掉 install.js 会用来判断「已安装」的两个标记：dist 目录与 path.txt。
 * 只删这两个（不动 node_modules/electron 其余文件），保证修复不牵连其它包。
 */
export function resetElectronArtifacts({ electronDir, fs = {} } = {}) {
	const rm = fs.rmSync ?? rmSync;
	const targets = [join(electronDir, "dist"), join(electronDir, "path.txt")];
	try {
		for (const target of targets) rm(target, { recursive: true, force: true });
		return { ok: true, targets };
	} catch (error) {
		// Windows 上被正在运行的 Electron 占用会 EBUSY/EPERM，提示先关实例即可，不要重试硬删。
		return { ok: false, targets, detail: `删除 ${targets.join(" / ")} 失败（可能有正在运行的 Electron 进程占用，先关掉再试）：${error instanceof Error ? error.message : String(error)}` };
	}
}

/** 跑 electron 包自带的 install.js（本地解压缓存 zip → 重建 dist）。 */
export function runElectronInstaller({ electronDir, nodeExecPath = process.execPath, spawn = spawnSync, fs = {}, log = console.log } = {}) {
	const exists = fs.existsSync ?? existsSync;
	const installScript = join(electronDir, "install.js");
	if (!exists(installScript)) return { ok: false, detail: `缺少 ${installScript}，请先 npm install` };
	log("[electron] 正在按本地缓存重新解压 Electron …");
	const result = spawn(nodeExecPath, [installScript], { stdio: "inherit", windowsHide: true });
	if (result.error) return { ok: false, detail: `无法执行 install.js：${result.error.code ?? result.error.message}` };
	if (result.status !== 0) return { ok: false, detail: `install.js 退出码 ${result.status}` };
	return { ok: true };
}

/**
 * 一键修复：删标记 → install.js 重解压 →（失败则）本地缓存 zip 兜底 → 复检。
 * 任一步失败都返回可读原因；`extractFallback` 是测试注入点（真实实现会碰磁盘）。
 * 返回的 strategy 说明最终靠哪条路径还原（installer | cache-zip），供 CLI 提示用。
 */
export async function repairElectronBinary({ electronDir, requireFn, env, nodeExecPath, spawn, fs, log = console.log, probe = probeElectronBinary, extractFallback = extractElectronFromCache } = {}) {
	const reset = resetElectronArtifacts({ electronDir, fs });
	if (!reset.ok) return { ok: false, detail: reset.detail };
	const installed = runElectronInstaller({ electronDir, nodeExecPath, spawn, fs, log });
	let strategy = "installer";
	if (!installed.ok) {
		// 官方路径失败就不再重试同一件事（它本质上要联网），直接走不依赖 URL 缓存键的本地还原。
		log(`[electron] install.js 未能完成（${installed.detail}），改从本地缓存 zip 还原 …`);
		const fallback = await extractFallback({ electronDir, env, log });
		if (!fallback.ok) return { ok: false, detail: `${installed.detail}；本地缓存兜底也失败：${fallback.detail}` };
		strategy = "cache-zip";
	}
	// 探活的替身实现可能同步返回，await 对同步值与 Promise 都成立。
	const verdict = await probe({ requireFn, env, spawn });
	return verdict.ok ? { ok: true, binaryPath: verdict.binaryPath, strategy } : { ok: false, detail: verdict.detail, binaryPath: verdict.binaryPath, strategy };
}

/** CLI 主流程：体检 → 需要时修复 → 复检，返回进程退出码。 */
export async function runCli({ argv = process.argv.slice(2), projectRoot = join(dirname(fileURLToPath(import.meta.url)), ".."), probe = probeElectronBinary, repair = repairElectronBinary, log = console.log, warn = console.warn } = {}) {
	const electronDir = join(projectRoot, "node_modules", "electron");
	const repairRequested = argv.includes("--repair");
	const version = readElectronVersion({ electronDir });
	let verdict = probe({});

	if (!verdict.ok && repairRequested) {
		for (const line of formatProbeFailure(verdict)) warn(line);
		// repair 注入点：真实实现会删 dist/path.txt 并重解压，测试必须能替掉它。
		const repaired = await repair({ electronDir, log });
		if (!repaired.ok) {
			warn(`[electron] ✗ 修复失败：${repaired.detail}`);
			return 1;
		}
		verdict = probe({});
		if (!verdict.ok) {
			warn(`[electron] ✗ 重新解压后仍然无法启动：${verdict.detail}`);
			warn("[electron]   换个角度：确认杀软/EDR 是否拦了 electron.exe，或直接重新 npm install electron");
			return 1;
		}
		// 走了兜底路径时点明一句：它意味着 install.js 联网失败，本机下次装包还会遇到同样问题。
		if (repaired.strategy === "cache-zip") log("[electron] 说明：install.js 无法联网，本次是从本地缓存 zip 直接还原的。");
	}

	if (!verdict.ok) {
		for (const line of formatProbeFailure(verdict)) warn(line);
		return 1;
	}

	log(`✓ Electron${version ? ` ${version}` : ""} 二进制可正常启动（${verdict.binaryPath ?? "路径未知"}）`);
	if (repairRequested) log("[electron] 无需修复（探活已通过）。");
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exit(await runCli());
}
