/**
 * 本地语音转写运行时（whisper.cpp）生命周期管理。
 *
 * 职责：按需下载官方预编译二进制与 ggml 模型到 userData/voice-runtime/，
 * 提供「已装状态」查询、删除模型、解析生效 CLI 路径。安装包零增长。
 *
 * 三条硬约束（与 DshRuntimeManager 同源）：
 * 1. **先校验后落位**：模型用固定 sha256 清单逐一校验；二进制归档优先取 GitHub
 *    Release API 的 digest，拿不到时落到本地「哈希锁定」（首次下载记录 sha256，
 *    重装时比对）——挡住镜像被篡改后反复感染。
 * 2. **原子落位**：下载进 `.part`/暂存目录，全部校验通过才 rename 到正式路径；
 *    任何一步失败清掉临时产物，正式路径「要么没有、要么完整可用」。
 * 3. **解压防逃逸**：归档条目必须是相对路径且不含 `..`（tar slip 防护）。
 *
 * 下载器/Release 摘要读取可注入（测试不碰真实网络）。
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getWhisperModelDef, resolveWhisperHostSupport, WHISPER_CPP_RELEASE_TAG, WHISPER_MODEL_CATALOG, whisperAssetUrl, whisperCppReleaseApiUrl, whisperModelUrlCandidates, type WhisperInstallProgress, type WhisperModelId, type WhisperRuntimeStatus } from "../../shared/types/whisperRuntime";

/** 下载器：`onProgress(receivedBytes, totalBytes|undefined)`；`options.resumeFromBytes` 见 createNetDownloader。 */
export type WhisperDownloader = (url: string, destPath: string, onProgress?: (received: number, total?: number) => void, signal?: AbortSignal, options?: { resumeFromBytes?: number }) => Promise<void>;

/** Release 资产名 → sha256（小写 hex）；返回 null = API 不可达/解析失败。 */
export type WhisperReleaseDigestsFetcher = (url: string) => Promise<Record<string, string> | null>;

export type WhisperRuntimeLayout = {
	/** userData/voice-runtime：二进制版本目录与哈希锁都在这。 */
	runtimeRoot: string;
	/** 模型目录（runtimeRoot/models）。 */
	modelsRoot: string;
	/** 下载/解压暂存根（runtimeRoot/tmp，同卷保证 rename 原子）。 */
	tempRoot: string;
};

export type WhisperRuntimeManagerDeps = {
	platform: NodeJS.Platform;
	arch: string;
	layout: WhisperRuntimeLayout;
	download: WhisperDownloader;
	fetchReleaseDigests?: WhisperReleaseDigestsFetcher;
	log?: (scope: string, message: string, detail?: unknown) => void;
};

export type WhisperCommandResult = { ok: true } | { ok: false; error: string };

/** 落位标记文件：记录版本与 CLI 相对路径（归档内目录布局随版本变化，装时解析一次）。 */
const RUNTIME_MARKER_FILE = "pideck-runtime.json";
const HASH_LOCK_FILE = "pideck-hash-locks.json";

function errorMessage(error: unknown): string {
	if (error !== null && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.length > 0) return message;
	}
	return String(error);
}

/**
 * 「内容级」失败码：这类错误说明手里的半截 .part 字节不可信，续传上去也永远校验不过，
 * 必须丢弃后从 0 重下。网络中断/镜像 5xx 不在其列——它们留下的断点是有效的。
 */
const DISCARDABLE_MODEL_ERRORS = ["size-mismatch", "sha256-mismatch", "download-exceeded-size"];

function isDiscardableModelError(error: string): boolean {
	return DISCARDABLE_MODEL_ERRORS.some((code) => error.includes(code));
}

/** 流式 sha256（小写 hex）：模型可达数百 MB，禁止整读进内存。 */
export async function sha256OfFile(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

/** 归档条目 → 落盘路径的安全判定（绝对路径 / `..` 段 / 解析越界一律拒绝）。 */
export function isSafeArchiveEntry(destDir: string, entryPath: string): boolean {
	const normalized = entryPath.replace(/\\/g, "/");
	if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
	if (normalized.split("/").includes("..")) return false;
	const rel = relative(destDir, resolve(destDir, normalized));
	return rel === "" || (!rel.startsWith("..") && !resolve(destDir, rel).startsWith(".."));
}

/** 在解出的目录树里找指定可执行文件：按 names 优先级返回（新版名字优先于旧版 main）。 */
export function findWhisperBinary(dir: string, platform: NodeJS.Platform, names: readonly string[]): string | null {
	const suffix = platform === "win32" ? ".exe" : "";
	const candidates = names.map((name) => (platform === "win32" ? `${name}${suffix}` : name));
	const stack = [dir];
	let best: string | null = null;
	let bestRank = Number.POSITIVE_INFINITY;
	while (stack.length > 0) {
		const current = stack.pop() as string;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			const rank = candidates.indexOf(entry.name);
			if (rank >= 0 && rank < bestRank && isSafeArchiveEntry(dir, relative(dir, full))) {
				best = full;
				bestRank = rank;
			}
		}
	}
	return best;
}

/** CLI 在归档里的候选名（旧版 whisper.cpp 叫 main）。 */
const WHISPER_CLI_NAMES = ["whisper-cli", "main"] as const;
/** 常驻 HTTP 服务进程，与 CLI 同一个归档、同一个目录。 */
const WHISPER_SERVER_NAMES = ["whisper-server"] as const;

/** 在解出的目录树里找 CLI 可执行文件：按 names 优先级返回（新版 whisper-cli 优先于旧版 main）。 */
export function findWhisperCliBinary(dir: string, platform: NodeJS.Platform): string | null {
	return findWhisperBinary(dir, platform, WHISPER_CLI_NAMES);
}

export class WhisperRuntimeManager {
	/** 当前安装任务的中止入口（见 withExclusiveInstall）。 */
	private installController: AbortController | null = null;

	constructor(private readonly deps: WhisperRuntimeManagerDeps) {}

	/**
	 * 取消进行中的运行时/模型下载。
	 *
	 * 渲染层没法把 AbortSignal 传过 IPC，所以中止入口放在主进程这一侧：
	 * 下载由本管理器发起、也由它持有 controller，abortInstall() 是唯一出口。
	 * @returns false = 当前没有在跑的任务。
	 */
	abortInstall(): boolean {
		if (!this.installController) return false;
		this.installController.abort();
		return true;
	}

	/**
	 * 安装任务串行化：同一时刻只允许一个下载（避免两个任务互相覆盖 tmp 与版本目录），
	 * 并把该任务的 signal 交给具体安装逻辑，使 abortInstall() 能精确中止当前那一个。
	 */
	private async withExclusiveInstall(target: WhisperInstallProgress["target"], onProgress: (progress: WhisperInstallProgress) => void, run: (signal: AbortSignal) => Promise<WhisperCommandResult>): Promise<WhisperCommandResult> {
		if (this.installController) {
			onProgress({ target, phase: "error", percent: 100, error: "already-installing" });
			return { ok: false, error: "already-installing" };
		}
		const controller = new AbortController();
		this.installController = controller;
		try {
			return await run(controller.signal);
		} finally {
			if (this.installController === controller) this.installController = null;
		}
	}

	/**
	 * 汇总运行时状态。configCliPath：用户自定义 whisper-cli 路径（存在才生效）。
	 * 模型「已装」按存在 + 字节数一致判定；内容级校验发生在下载落位时。
	 */
	getStatus(config: { cliPath?: string; localModelId?: WhisperModelId }): WhisperRuntimeStatus {
		const auto = this.autoRuntimeStatus();
		const customReady = Boolean(config.cliPath && existsSync(config.cliPath) && statSync(config.cliPath).isFile());
		const cliPath = customReady ? (config.cliPath as string) : auto.cliPath;
		return {
			autoRuntimeSupported: resolveWhisperHostSupport(this.deps.platform, this.deps.arch)?.autoRuntime ?? false,
			cliReady: cliPath !== null,
			cliSource: customReady ? "custom" : auto.cliPath ? "auto" : "none",
			cliPath,
			runtimeVersion: auto.version,
			models: WHISPER_MODEL_CATALOG.map((def) => ({
				id: def.id,
				installed: this.isModelInstalled(def.id),
				bytes: def.bytes,
				// 未完成下载的字节数：设置页据此显示「已下载 X，再次下载接着传」，
				// 用户关心的「有没有记录进度」就有了可见答案。
				partialBytes: this.partialModelBytes(def.file),
			})),
		};
	}

	/** 指定模型的未完成下载字节数（无断点或读不到为 0）。 */
	private partialModelBytes(fileName: string): number {
		try {
			return statSync(join(this.deps.layout.tempRoot, `${fileName}.part`)).size;
		} catch {
			return 0;
		}
	}

	/** 解析当前生效的 whisper-cli 绝对路径（自定义优先，其次自动下载目录）。 */
	resolveCliPath(config: { cliPath?: string }): string | null {
		const status = this.getStatus({ cliPath: config.cliPath, localModelId: undefined });
		return status.cliPath;
	}

	/**
	 * 解析与生效 CLI **同目录**的 whisper-server（常驻推理用）。
	 * 优先取 CLI 旁边的兄弟文件：用户自定义 cliPath 时，配套的 server 只可能在同一目录，
	 * 拿别处的 server 配用户的模型路径会让 DLL 版本对不上。找不到返回 null，
	 * 调用方（WhisperServerPool）据此回退 whisper-cli。
	 */
	resolveServerPath(config: { cliPath?: string }): string | null {
		const cliPath = this.resolveCliPath(config);
		if (!cliPath) return null;
		const sibling = join(dirname(cliPath), this.deps.platform === "win32" ? "whisper-server.exe" : "whisper-server");
		if (existsSync(sibling)) return sibling;
		return findWhisperBinary(dirname(cliPath), this.deps.platform, WHISPER_SERVER_NAMES);
	}

	/**
	 * 检测优先：只要版本目录里找得到 CLI 就算已安装，标记文件只用于加速定位。
	 * 标记可能缺失、损坏、缺 version，或记录了安装后被清理掉的临时路径（历史 bug，
	 * 线上那份 pideck-runtime.json 就是这样）——任何一种都必须退回扫描，
	 * 否则用户「明明装过」仍被提示去下载（installRuntime 也走这里，因此点击不再重下）。
	 */
	private autoRuntimeStatus(): { cliPath: string | null; version: string | null } {
		const versionDir = join(this.deps.layout.runtimeRoot, WHISPER_CPP_RELEASE_TAG);
		let marker: { version?: unknown; cliRelPath?: unknown } | null = null;
		try {
			marker = JSON.parse(readFileSync(join(versionDir, RUNTIME_MARKER_FILE), "utf8")) as { version?: unknown; cliRelPath?: unknown };
		} catch {
			marker = null; // 未安装或标记损坏：交给下面的目录扫描判定
		}
		if (typeof marker?.cliRelPath === "string") {
			const recorded = join(versionDir, marker.cliRelPath);
			if (existsSync(recorded)) return { cliPath: recorded, version: WHISPER_CPP_RELEASE_TAG };
		}
		const scanned = findWhisperCliBinary(versionDir, this.deps.platform);
		if (scanned) return { cliPath: scanned, version: WHISPER_CPP_RELEASE_TAG };
		return { cliPath: null, version: null };
	}

	/** 安装 whisper-cli 二进制归档（已就位时直接成功，不重复下载）。 */
	async installRuntime(onProgress: (progress: WhisperInstallProgress) => void): Promise<WhisperCommandResult> {
		return this.withExclusiveInstall("runtime", onProgress, (signal) => this.installRuntimeInner(onProgress, signal));
	}

	private async installRuntimeInner(onProgress: (progress: WhisperInstallProgress) => void, signal: AbortSignal): Promise<WhisperCommandResult> {
		const { layout, log } = this.deps;
		const fail = (error: string): WhisperCommandResult => {
			onProgress({ target: "runtime", phase: "error", percent: 100, error });
			log?.("voice-runtime", "runtime install failed", { error });
			return { ok: false, error };
		};
		const host = resolveWhisperHostSupport(this.deps.platform, this.deps.arch);
		if (!host || !host.autoRuntime) return fail("unsupported-platform");
		const existing = this.autoRuntimeStatus();
		if (existing.cliPath) {
			onProgress({ target: "runtime", phase: "done", percent: 100 });
			return { ok: true };
		}

		mkdirSync(layout.tempRoot, { recursive: true });
		const ext = host.format === "zip" ? "zip" : "tar.gz";
		const archivePath = join(layout.tempRoot, `${host.asset}.${Date.now()}.${ext}`);
		const staging = join(layout.tempRoot, `runtime-${Date.now()}`);
		try {
			onProgress({ target: "runtime", phase: "downloading", percent: 0 });
			await this.deps.download(
				whisperAssetUrl(host.asset),
				archivePath,
				(received, total) => {
					onProgress({ target: "runtime", phase: "downloading", percent: this.dlPercent(received, total), receivedBytes: received, totalBytes: total });
				},
				signal,
			);

			onProgress({ target: "runtime", phase: "verifying", percent: 75 });
			const actual = await sha256OfFile(archivePath);
			const lockError = await this.verifyOrLockHash(host.asset, actual);
			if (lockError) return fail(lockError);

			onProgress({ target: "runtime", phase: "installing", percent: 85 });
			await extractArchive(archivePath, staging, host.format, this.deps.log);
			const cli = findWhisperCliBinary(staging, this.deps.platform);
			if (!cli) return fail("cli-missing-in-archive");
			// 先按暂存目录算出相对路径：rename 后暂存目录整体成为版本目录，
			// 用「相对暂存目录」而非「相对版本目录」才不会记成指向临时目录的死路径。
			const cliRelPath = relative(staging, cli);

			const versionDir = join(layout.runtimeRoot, WHISPER_CPP_RELEASE_TAG);
			// rename 到已存在目录在 Windows 会失败：先移除旧版本目录。
			rmSync(versionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
			mkdirSync(layout.runtimeRoot, { recursive: true });
			renameSync(staging, versionDir);
			writeFileSync(join(versionDir, RUNTIME_MARKER_FILE), JSON.stringify({ version: WHISPER_CPP_RELEASE_TAG, cliRelPath, platform: this.deps.platform, arch: this.deps.arch }, null, 2), "utf8");
			onProgress({ target: "runtime", phase: "done", percent: 100 });
			log?.("voice-runtime", "runtime installed", { version: WHISPER_CPP_RELEASE_TAG });
			return { ok: true };
		} catch (error) {
			return fail(signal.aborted ? "cancelled" : errorMessage(error));
		} finally {
			rmSync(archivePath, { force: true });
			rmSync(staging, { recursive: true, force: true });
		}
	}

	/** 下载并校验安装指定模型；已装且字节一致时短路。 */
	async installModel(modelId: WhisperModelId, onProgress: (progress: WhisperInstallProgress) => void): Promise<WhisperCommandResult> {
		return this.withExclusiveInstall(modelId, onProgress, (signal) => this.installModelInner(modelId, onProgress, signal));
	}

	private async installModelInner(modelId: WhisperModelId, onProgress: (progress: WhisperInstallProgress) => void, signal: AbortSignal): Promise<WhisperCommandResult> {
		const { layout, log } = this.deps;
		const fail = (error: string): WhisperCommandResult => {
			onProgress({ target: modelId, phase: "error", percent: 100, error });
			log?.("voice-runtime", "model install failed", { modelId, error });
			return { ok: false, error };
		};
		const def = getWhisperModelDef(modelId);
		if (!def) return fail("unknown-model");
		const target = join(layout.modelsRoot, def.file);
		if (this.isModelInstalled(modelId)) {
			onProgress({ target: modelId, phase: "done", percent: 100 });
			return { ok: true };
		}

		mkdirSync(layout.tempRoot, { recursive: true });
		mkdirSync(layout.modelsRoot, { recursive: true });
		// 断点文件名固定（不带时间戳）：取消或网络中断后它留在 tmp 里，下次点「下载模型」接着传，
		// 而不是把几百 MB 从头再来。完整性失败才会删它。
		const partPath = join(layout.tempRoot, `${def.file}.part`);
		this.discardLegacyPartFiles(def.file);
		let lastError = "download-failed";
		for (const url of whisperModelUrlCandidates(def.file)) {
			try {
				if (signal.aborted) break;
				const resumeFrom = this.resumableBytes(partPath, def.bytes);
				onProgress({ target: modelId, phase: "downloading", percent: this.dlPercent(resumeFrom, def.bytes), receivedBytes: resumeFrom, totalBytes: def.bytes });
				await this.deps.download(
					url,
					partPath,
					(received, total) => {
						// 超字节上限直接失败：镜像返回 HTML 错误页/重定向套娃时挡住。
						if (received > def.bytes * 1.2) throw new Error("download-exceeded-size");
						onProgress({ target: modelId, phase: "downloading", percent: this.dlPercent(received, total), receivedBytes: received, totalBytes: total ?? def.bytes });
					},
					signal,
					{ resumeFromBytes: resumeFrom },
				);
				onProgress({ target: modelId, phase: "verifying", percent: 80 });
				const size = statSync(partPath).size;
				if (size !== def.bytes) throw new Error(`size-mismatch:${size}`);
				const actual = await sha256OfFile(partPath);
				if (actual.toLowerCase() !== def.sha256) throw new Error("sha256-mismatch");
				onProgress({ target: modelId, phase: "installing", percent: 92 });
				// 正式名先占位删除再 rename（同卷原子）；旧半截文件不污染校验。
				rmSync(target, { force: true });
				renameSync(partPath, target);
				onProgress({ target: modelId, phase: "done", percent: 100 });
				log?.("voice-runtime", "model installed", { modelId });
				return { ok: true };
			} catch (error) {
				lastError = errorMessage(error);
				// 取消后不要再试下一个镜像源（那等于把刚中止的下载又起一遍）。
				if (signal.aborted) break;
				// 只有「内容不可信」才丢弃断点：超长/尺寸不符/哈希不符意味着续传上去的字节是错的，
				// 留着只会每次都校验失败。网络中断、镜像 5xx 都保留 .part。
				if (isDiscardableModelError(lastError)) rmSync(partPath, { force: true });
				log?.("voice-runtime", "model candidate failed, trying next", { modelId, url, error: lastError });
			}
		}
		if (signal.aborted) return fail("cancelled");
		return fail(lastError);
	}

	/**
	 * 旧命名断点（`<文件>.<时间戳>.part`）一律清掉：改名成固定名之前每次下载都换一个后缀，
	 * 那些半截文件既续不上也没入口删除，升级后只会变成几百 MB 的磁盘垃圾。
	 */
	private discardLegacyPartFiles(fileName: string): void {
		let entries: string[];
		try {
			entries = readdirSync(this.deps.layout.tempRoot);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry === `${fileName}.part`) continue;
			if (!entry.startsWith(`${fileName}.`) || !entry.endsWith(".part")) continue;
			rmSync(join(this.deps.layout.tempRoot, entry), { force: true });
			this.deps.log?.("voice-runtime", "removed legacy partial download", { entry });
		}
	}

	/**
	 * 可用于续传的字节数：没有断点返回 0；断点已经不小于目标体积说明它是坏数据
	 * （完整的文件早就该被 rename 走了），丢弃后从 0 开始，否则会永远卡在同一个错误上。
	 */
	private resumableBytes(partPath: string, expectedBytes: number): number {
		try {
			const size = statSync(partPath).size;
			if (size < expectedBytes) return size;
			rmSync(partPath, { force: true });
			this.deps.log?.("voice-runtime", "discarded oversized partial download", { partPath, size, expectedBytes });
			return 0;
		} catch {
			return 0;
		}
	}

	/** 删除已下载模型（释放磁盘；正在被转写进程读取时 Windows 会拒删，转成结构化错误）。 */
	deleteModel(modelId: WhisperModelId): WhisperCommandResult {
		const def = getWhisperModelDef(modelId);
		if (!def) return { ok: false, error: "unknown-model" };
		try {
			rmSync(join(this.deps.layout.modelsRoot, def.file), { force: true });
			// 断点也一并清掉：用户主动删除模型表示不要这份下载，不该下次点下载又续上来。
			rmSync(join(this.deps.layout.tempRoot, `${def.file}.part`), { force: true });
			return { ok: true };
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}

	isModelInstalled(modelId: WhisperModelId): boolean {
		const def = getWhisperModelDef(modelId);
		if (!def) return false;
		try {
			return statSync(join(this.deps.layout.modelsRoot, def.file)).size === def.bytes;
		} catch {
			return false;
		}
	}

	modelPath(modelId: WhisperModelId): string | null {
		const def = getWhisperModelDef(modelId);
		if (!def) return null;
		const path = join(this.deps.layout.modelsRoot, def.file);
		return existsSync(path) ? path : null;
	}

	/**
	 * 二进制归档哈希策略：GitHub API digest 优先（权威）；API 不可达时
	 * 「哈希锁定」兜底——首次成功下载记录 sha256，之后的重装/重下与该记录比对。
	 * 返回 null = 通过；字符串 = 失败原因。
	 */
	private async verifyOrLockHash(assetName: string, actualHex: string): Promise<string | null> {
		const locks = this.readLocks();
		const digests = await this.deps.fetchReleaseDigests?.(whisperCppReleaseApiUrl());
		const authoritative = digests?.[assetName]?.toLowerCase();
		if (authoritative) {
			if (authoritative !== actualHex) return "sha256-mismatch";
			this.writeLocks({ ...locks, [assetName]: actualHex });
			return null;
		}
		const locked = locks[assetName]?.toLowerCase();
		if (locked) {
			return locked === actualHex ? null : "sha256-mismatch";
		}
		if (!/^[0-9a-f]{64}$/.test(actualHex)) return "bad-hash";
		this.writeLocks({ ...locks, [assetName]: actualHex });
		this.deps.log?.("voice-runtime", "runtime hash locked on first install (release API digest unavailable)", { assetName });
		return null;
	}

	private readLocks(): Record<string, string> {
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(this.deps.layout.runtimeRoot, HASH_LOCK_FILE), "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
			const out: Record<string, string> = {};
			for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value)) out[key] = value;
			}
			return out;
		} catch {
			return {};
		}
	}

	private writeLocks(locks: Record<string, string>): void {
		try {
			mkdirSync(this.deps.layout.runtimeRoot, { recursive: true });
			writeFileSync(join(this.deps.layout.runtimeRoot, HASH_LOCK_FILE), JSON.stringify(locks, null, 2), "utf8");
		} catch (error) {
			this.deps.log?.("voice-runtime", "hash lock persist failed", { error: errorMessage(error) });
		}
	}

	private dlPercent(received: number, total: number | undefined): number {
		const ratio = total && total > 0 ? received / total : 0;
		return Math.min(70, Math.round(ratio * 70));
	}
}

/**
 * 读取 GitHub Release 各资产的 sha256 digest（`assets[].digest = "sha256:<hex>"`）。
 * API 不可达/无 digest 返回 null，调用方落到「哈希锁定」兜底。
 */
export async function fetchWhisperReleaseDigests(url: string): Promise<Record<string, string> | null> {
	try {
		const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return null;
		const parsed: unknown = await response.json();
		if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { assets?: unknown }).assets)) return null;
		const out: Record<string, string> = {};
		for (const asset of (parsed as { assets: Array<{ name?: unknown; digest?: unknown }> }).assets) {
			if (typeof asset.name === "string" && typeof asset.digest === "string" && asset.digest.startsWith("sha256:")) {
				out[asset.name] = asset.digest.slice("sha256:".length).toLowerCase();
			}
		}
		return out;
	} catch {
		return null;
	}
}

/**
 * 系统 tar 解压（bsdtar 同时认 zip 与 tar.gz；Linux 的 GNU tar 只喂它 tar.gz，
 * 平台与归档格式由 resolveWhisperHostSupport 一一配对，无需纯 JS 兜底）。
 * 两遍式：先 `-tf` 列出条目做 tar slip 校验，再解压。
 */
async function extractArchive(archivePath: string, destDir: string, format: "zip" | "tar.gz", log?: WhisperRuntimeManagerDeps["log"]): Promise<void> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	mkdirSync(destDir, { recursive: true });
	const run = promisify(execFile);
	const { stdout } = await run("tar", ["-tf", archivePath], { windowsHide: true, maxBuffer: 1 << 24 });
	for (const entry of stdout.split(/\r?\n/)) {
		if (!entry) continue;
		if (!isSafeArchiveEntry(destDir, entry)) {
			log?.("voice-runtime", "rejected unsafe archive entry", { entry });
			throw new Error(`unsafe archive entry: ${entry}`);
		}
	}
	if (format === "zip") await run("tar", ["-xf", archivePath, "-C", destDir], { windowsHide: true });
	else await run("tar", ["-xzf", archivePath, "-C", destDir], { windowsHide: true });
}
