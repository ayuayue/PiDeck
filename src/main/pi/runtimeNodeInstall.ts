/**
 * pi 环境引导：便携 Node 副本安装器。
 *
 * 面向「什么都没装」的全新机器：从国内镜像（npmmirror → 华为云 → nodejs.org 官方）
 * 下载官方 Node 发行包，sha256 校验后解压到 `<userData>/pi-runtime/node/`。
 * 发行包自带 npm，因此「安装 npm」这一步天然完成，不需要单独安装。
 *
 * 设计要点：
 * - 便携安装，不做系统级安装：不弹 UAC、不写注册表、不改系统 PATH；
 *   卸载 PiDeck（删 userData）即彻底清理。
 * - 哈希固化在 `shared/types/piRuntimeNode.ts`（取自官方 SHASUMS256.txt），
 *   不依赖网络拉索引——镜像文件被篡改时校验必然失败。
 * - 下载复用 DSH runtime 的 net 下载器（尊重应用代理、流式落盘、重定向跟随），
 *   解压复用 DSH 的系统 tar 两遍式（先列条目做 tar slip 安全校验，再解压）。
 * - 安装完成后探测 `node -v` 确认可用；半截解压（下载中断/杀软拦截）文件会在
 *   但跑不起来，必须探测确认而不是 existsSync 就算装好。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DshRuntimeDownloader, DshRuntimeExtractor } from "../dsh/runtime/DshRuntimeManager";
import { sha256OfFile } from "../dsh/runtime/DshRuntimeManager";
import { piRuntimeNodeBinDir, piRuntimeNodeExePath, piRuntimeRootDir } from "./piRuntimePaths";
import { PI_RUNTIME_NODE_VERSION, PI_RUNTIME_NODE_SHA256, piRuntimeNodeArchiveName, piRuntimeNodeDownloadUrls, piRuntimeNodeInnerDir, toPiRuntimePlatform, toPiRuntimeArch, type PiRuntimeNodeInstallResult, type PiRuntimeNodeStatus } from "../../shared/types/piRuntimeNode";

// 便携副本的路径约定（含 POSIX 的 bin/ 层级）统一在 ./piRuntimePaths，避免各处自己拼而漂移；
// 这里 re-export 保持既有调用方（IPC / 测试）的 import 面不变。
export { piRuntimeNodeBinDir, piRuntimeNodeExePath, piRuntimeRootDir };

const execFileAsync = promisify(execFile);

/** 安装器可替换的 IO 依赖（测试注入本地替身，不碰网络与磁盘归档）。 */
export type RuntimeNodeInstallerDeps = {
	/** 下载器：DSH runtime 同源的 net 流式下载（file:// 支持本地测试）。 */
	download: DshRuntimeDownloader;
	/** 解压器：系统 tar 两遍式（安全校验）。 */
	extract: DshRuntimeExtractor;
};

/**
 * 自愈：修复旧版本 PiDeck 在 POSIX 上装出来的悬空 `npm`/`npx`/`corepack` 软链。
 *
 * 成因见 `copyDirEntryVerbatim` 的注释：`cpSync` 默认把相对链接解析成绝对路径，
 * 指向已删除的解压临时目录（`/tmp/pideck-node-extract-*`）。后果是便携 node “可执行但没 npm”：
 * 引导第 1 步显示已就绪、第 2 步却报 npm 不可用，而重装又因幂等短路恢复不了（node 本体是好的）。
 *
 * 判据保守：只看三类已知可执行入口；只在「确实是绝对链接 + 目标已不存在 + 本地 lib/node_modules
 * 下对应文件存在」三个条件同时成立时才重写为相对链接（按链接目标里发行包目录名后的尾巴推导）。
 * 任何一步不满足就原样放过，宁可不修也不改坏用户数据。
 *
 * @returns 实际修复的入口名（供测试断言；空数组 = 不需要修）
 */
export function repairPortableNodeLinks(userDataPath: string, platform: NodeJS.Platform = process.platform): string[] {
	// Windows 官方 zip 里 npm.cmd/npx.cmd 是真实文件而非软链，不存在这个问题。
	if (platform === "win32") return [];
	const binDir = piRuntimeNodeBinDir(userDataPath, platform);
	const nodeRoot = join(piRuntimeRootDir(userDataPath), "node");
	const repaired: string[] = [];
	for (const name of ["npm", "npx", "corepack"]) {
		const linkPath = join(binDir, name);
		let target: string;
		try {
			target = readlinkSync(linkPath);
		} catch {
			continue; // 不存在或不是软链（真实文件）：不用管
		}
		if (!isAbsolute(target)) continue; // 相对链接本来就是对的
		if (existsSync(linkPath)) continue; // 链接目标还在：无需修复
		// 从绝对目标里取出发行包目录名之后的尾巴（如 lib/node_modules/npm/bin/npm-cli.js），
		// 拼回本地已存在的同名文件，再写成从 bin 目录出发的相对链接。
		const marker = /[/\\]node-v\d+\.\d+\.\d+-[^/\\]+[/\\]/.exec(target);
		const tail = marker ? target.slice(marker.index + marker[0].length) : "";
		const localTarget = tail ? join(nodeRoot, tail) : "";
		if (!localTarget || !existsSync(localTarget)) continue;
		// Windows 杀毒/索引器会短暂锁住新建的软链，紧接着的 rmSync/symlinkSync 报 EPERM/EBUSY
		//（2026-10 GitHub runner 复现：输入全部合法但修复静默失败，25-50ms 退避仍不够扫描窗口）。
		// 阶梯退避最多 ~1.5s，仅修复失败路径触发；Atomics.wait 是主进程同步睡眠的标准做法。
		const retryBackoffMs = [0, 50, 150, 400, 900];
		let linked = false;
		for (let attempt = 0; attempt < retryBackoffMs.length && !linked; attempt += 1) {
			if (retryBackoffMs[attempt] > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryBackoffMs[attempt]);
			try {
				rmSync(linkPath, { force: true });
				symlinkSync(relative(binDir, localTarget), linkPath);
				linked = true;
			} catch {
				// 重试后仍失败（权限等）不影响检测结果，保持原样。
			}
		}
		if (linked) repaired.push(name);
	}
	return repaired;
}

/**
 * 检测便携 Node 副本状态。
 * installed 只在「文件存在且 `node -v` 可执行」时为 true——
 * 半截解压（下载中断、杀软拦截）会让文件在但跑不起来，必须探测确认。
 */
export async function detectPiRuntimeNode(
	userDataPath: string,
	systemNodeVersion: string | undefined,
	platform: NodeJS.Platform = process.platform,
	/** 可替换的版本探测（测试注入）；缺省用真实 execFile 探测。 */
	probeVersion: (nodePath: string) => Promise<string | undefined> = probeNodeVersion,
): Promise<PiRuntimeNodeStatus> {
	const installSupported = toPiRuntimePlatform(platform) !== null && toPiRuntimeArch(process.arch) !== null;
	const exePath = piRuntimeNodeExePath(userDataPath, platform);
	// 旧版本装出来的悬空 npm 在这里顺手修好（见 repairPortableNodeLinks）：
	// node 本体可用但 npm 没了的话，引导会卡在 npm 步骤且反复重装也没用。
	// 返回值只给测试用；这里的修复结果是「npm 又能用了」，无需额外字段上报。
	repairPortableNodeLinks(userDataPath, platform);
	const systemState = {
		systemNodeAvailable: systemNodeVersion !== undefined,
		systemNodeVersion,
		installSupported,
	};
	if (!existsSync(exePath)) {
		return { installed: false, ...systemState };
	}
	const version = await probeVersion(exePath);
	if (!version) {
		return { installed: false, path: exePath, error: "portable node exists but is not executable", ...systemState };
	}
	return { installed: true, path: exePath, version, ...systemState };
}

/**
 * 执行便携 Node 安装：下载 → sha256 校验 → 解压 → 探测。
 * 任一镜像失败自动尝试下一个；全部失败返回最后一个错误（渲染层展示）。
 */
export async function installPiRuntimeNode(
	input: {
		userDataPath: string;
		platform?: NodeJS.Platform;
		arch?: string;
		log?: (message: string, detail?: unknown) => void;
		signal?: AbortSignal;
		/** 可替换的版本探测（测试注入）；缺省用真实 execFile 探测。 */
		probeVersion?: (nodePath: string) => Promise<string | undefined>;
		/** 覆盖固化哈希表（测试 / 内网自建镜像校验用）；缺省用官方 SHASUMS256 固化值。 */
		expectedSha256?: string;
	},
	deps: RuntimeNodeInstallerDeps,
): Promise<PiRuntimeNodeInstallResult> {
	const platform = input.platform ?? process.platform;
	const contractPlatform = toPiRuntimePlatform(platform);
	const contractArch = toPiRuntimeArch(input.arch ?? process.arch);
	if (!contractPlatform || !contractArch) {
		return {
			ok: false,
			error: `unsupported platform for portable node install: ${platform}/${input.arch ?? process.arch}`,
		};
	}
	const probeVersion = input.probeVersion ?? probeNodeVersion;

	const exePath = piRuntimeNodeExePath(input.userDataPath, platform);
	// 已装且可用时幂等返回，不重复下载（按钮重复点击、重试风暴都安全）。
	const existing = await probeVersion(exePath);
	if (existing) return { ok: true, path: exePath, version: existing, source: "existing" };

	const archiveName = piRuntimeNodeArchiveName(contractPlatform, contractArch);
	// 哈希优先级：显式覆盖（测试/内网镜像）→ 固化表。表里没有的组合在上面已拒绝，兜底防漏。
	const expectedSha256 = input.expectedSha256 ?? PI_RUNTIME_NODE_SHA256[`${platform}-${contractArch}`];
	if (!expectedSha256) {
		return { ok: false, error: `no pinned sha256 for ${platform}-${contractArch}` };
	}

	// 归档落临时目录：校验失败/下载中断时整体清理，不污染 userData。
	const tmpDir = await mkdtemp(join(tmpdir(), "pideck-node-download-"));
	const archivePath = join(tmpDir, archiveName);
	try {
		let lastError = "download failed";
		for (const url of piRuntimeNodeDownloadUrls(contractPlatform, contractArch)) {
			try {
				input.log?.(`downloading node from ${url}`);
				await deps.download(url, archivePath, undefined, input.signal);
				const actual = await sha256OfFile(archivePath);
				if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
					// 哈希不匹配：该镜像的文件不可信，换下一个源，绝不解压。
					lastError = `sha256 mismatch from ${url}`;
					input.log?.(lastError, { expected: expectedSha256, actual });
					continue;
				}
				return await extractAndProbe({
					archivePath,
					destDir: join(piRuntimeRootDir(input.userDataPath), "node"),
					innerDir: piRuntimeNodeInnerDir(contractPlatform, contractArch),
					exePath,
					expectedMajor: `v${PI_RUNTIME_NODE_VERSION.split(".")[0]}.`,
					extract: deps.extract,
					probeVersion,
					log: input.log,
				});
			} catch (error) {
				lastError = `${url}: ${error instanceof Error ? error.message : String(error)}`;
				input.log?.("node download failed, trying next mirror", { error: lastError });
			}
		}
		return { ok: false, error: lastError };
	} finally {
		// 归档是临时的：无论成败都清理（解压产物在 userData，不受影响）。
		await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** 校验通过的归档：解压到临时目录 → 平铺移动整个发行包到 userData → 探测版本。 */
async function extractAndProbe(input: {
	archivePath: string;
	destDir: string;
	innerDir: string;
	exePath: string;
	expectedMajor: string;
	extract: DshRuntimeExtractor;
	probeVersion: (nodePath: string) => Promise<string | undefined>;
	log?: (message: string, detail?: unknown) => void;
}): Promise<PiRuntimeNodeInstallResult> {
	// 解压目标用全新空目录（DshRuntimeExtractor 契约要求 destDir 为空），
	// 解压后内层目录平铺移动到 destDir。
	const extractRoot = await mkdtemp(join(tmpdir(), "pideck-node-extract-"));
	try {
		mkdirSync(input.destDir, { recursive: true });
		await input.extract(input.archivePath, extractRoot);
		const innerDir = join(extractRoot, input.innerDir);
		if (!existsSync(innerDir)) {
			return { ok: false, error: `archive missing inner dir ${input.innerDir}` };
		}
		// 平铺移动：npm 必须与 node 同目录才能被 PATH 解析（pi 的 .cmd shim 也依赖
		// 同目录 node），所以把内层目录所有条目移到 destDir 根，而不是只挪 node 单文件。
		moveDirContents(innerDir, input.destDir);
		const version = await input.probeVersion(input.exePath);
		if (!version) {
			return { ok: false, error: "extracted node is not executable" };
		}
		// 主版本必须匹配（v24.x）：下错大版本会让 pi 的 npm 依赖树 ABI 漂移。
		if (!version.startsWith(input.expectedMajor)) {
			return { ok: false, error: `unexpected node version ${version}` };
		}
		input.log?.("portable node installed", { version, path: input.exePath });
		return { ok: true, path: input.exePath, version, source: "download" };
	} finally {
		await rm(extractRoot, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** 把 src 目录的所有条目移动到 dest（跨设备 rename 失败时退回复制+删除）。 */
function moveDirContents(src: string, dest: string): void {
	if (!existsSync(src)) return;
	for (const entry of readdirSync(src)) {
		const from = join(src, entry);
		const to = join(dest, entry);
		try {
			renameSync(from, to);
		} catch {
			// EXDEV（临时目录与 userData 跨盘）等场景退回复制。
			copyDirEntryVerbatim(from, to);
			rmSync(from, { recursive: true, force: true });
		}
	}
}

/**
 * 跨设备回退的逐条目复制。**必须**带 `verbatimSymlinks: true`，否则整个便携副本会废掉。
 *
 * 根因（2026-09-30 在 Linux 上实测复现）：Node 的 `cpSync` 默认 `verbatimSymlinks: false`，
 * 会把软链目标**解析成绝对路径**。官方 node 包里 `bin/npm`、`bin/npx`、`bin/corepack`
 * 都是相对链接（`../lib/node_modules/npm/bin/npm-cli.js`），复制后就变成了
 * `/tmp/pideck-node-extract-xxxx/…` 的绝对链接；解压临时目录一删，便携 npm 全部悬空
 * （`bin/npm` 不可执行 → 引导回退到系统 npm，没系统 npm 的机器直接卡在第 2 步）。
 * 必然触发场景：/tmp 是 tmpfs（多数 Linux 发行版默认），rename 跨设备 → 走这条回退。
 *
 * 导出仅为让测试锁住“相对链接必须原样保留”这个行为（改回默认会直接红灯）。
 */
export function copyDirEntryVerbatim(from: string, to: string): void {
	cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/** 执行 `node -v`；不可执行/超时返回 undefined（不抛错，调用方按「不可用」处理）。 */
export async function probeNodeVersion(nodePath: string, timeoutMs = 8_000): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(nodePath, ["-v"], { timeout: timeoutMs, windowsHide: true });
		const version = stdout.trim();
		return /^v\d+\.\d+\.\d+$/.test(version) ? version : undefined;
	} catch {
		return undefined;
	}
}
