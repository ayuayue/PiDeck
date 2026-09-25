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
import { join, relative, resolve } from "node:path";
import { getWhisperModelDef, resolveWhisperHostSupport, WHISPER_CPP_RELEASE_TAG, WHISPER_MODEL_CATALOG, whisperAssetUrl, whisperCppReleaseApiUrl, whisperModelUrlCandidates, type WhisperInstallProgress, type WhisperModelId, type WhisperRuntimeStatus } from "../../shared/types/whisperRuntime";

/** 下载器：`onProgress(receivedBytes, totalBytes|undefined)`。 */
export type WhisperDownloader = (url: string, destPath: string, onProgress?: (received: number, total?: number) => void, signal?: AbortSignal) => Promise<void>;

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

/** 在解出的目录树里找 CLI 可执行文件（旧版归档叫 main，新版叫 whisper-cli）。 */
export function findWhisperCliBinary(dir: string, platform: NodeJS.Platform): string | null {
	const names = platform === "win32" ? ["whisper-cli.exe", "main.exe"] : ["whisper-cli", "main"];
	const stack = [dir];
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
			} else if (names.includes(entry.name) && isSafeArchiveEntry(dir, relative(dir, full))) {
				return full;
			}
		}
	}
	return null;
}

export class WhisperRuntimeManager {
	constructor(private readonly deps: WhisperRuntimeManagerDeps) {}

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
			})),
		};
	}

	/** 解析当前生效的 whisper-cli 绝对路径（自定义优先，其次自动下载目录）。 */
	resolveCliPath(config: { cliPath?: string }): string | null {
		const status = this.getStatus({ cliPath: config.cliPath, localModelId: undefined });
		return status.cliPath;
	}

	private autoRuntimeStatus(): { cliPath: string | null; version: string | null } {
		const versionDir = join(this.deps.layout.runtimeRoot, WHISPER_CPP_RELEASE_TAG);
		try {
			const marker = JSON.parse(readFileSync(join(versionDir, RUNTIME_MARKER_FILE), "utf8")) as { cliRelPath?: unknown };
			if (typeof marker.cliRelPath === "string") {
				const cli = join(versionDir, marker.cliRelPath);
				if (existsSync(cli)) return { cliPath: cli, version: WHISPER_CPP_RELEASE_TAG };
			}
		} catch {
			/* 未安装或标记损坏 = 不可用 */
		}
		return { cliPath: null, version: null };
	}

	/** 安装 whisper-cli 二进制归档（已就位时直接成功，不重复下载）。 */
	async installRuntime(onProgress: (progress: WhisperInstallProgress) => void, signal?: AbortSignal): Promise<WhisperCommandResult> {
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

			const versionDir = join(layout.runtimeRoot, WHISPER_CPP_RELEASE_TAG);
			// rename 到已存在目录在 Windows 会失败：先移除旧版本目录。
			rmSync(versionDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
			mkdirSync(layout.runtimeRoot, { recursive: true });
			renameSync(staging, versionDir);
			writeFileSync(join(versionDir, RUNTIME_MARKER_FILE), JSON.stringify({ version: WHISPER_CPP_RELEASE_TAG, cliRelPath: relative(versionDir, cli), platform: this.deps.platform, arch: this.deps.arch }, null, 2), "utf8");
			onProgress({ target: "runtime", phase: "done", percent: 100 });
			log?.("voice-runtime", "runtime installed", { version: WHISPER_CPP_RELEASE_TAG });
			return { ok: true };
		} catch (error) {
			return fail(errorMessage(error));
		} finally {
			rmSync(archivePath, { force: true });
			rmSync(staging, { recursive: true, force: true });
		}
	}

	/** 下载并校验安装指定模型；已装且字节一致时短路。 */
	async installModel(modelId: WhisperModelId, onProgress: (progress: WhisperInstallProgress) => void, signal?: AbortSignal): Promise<WhisperCommandResult> {
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
		const partPath = join(layout.tempRoot, `${def.file}.${Date.now()}.part`);
		let lastError = "download-failed";
		for (const url of whisperModelUrlCandidates(def.file)) {
			try {
				onProgress({ target: modelId, phase: "downloading", percent: 0 });
				await this.deps.download(
					url,
					partPath,
					(received, total) => {
						// 超字节上限直接失败：镜像返回 HTML 错误页/重定向套娃时挡住。
						if (received > def.bytes * 1.2) throw new Error("download-exceeded-size");
						onProgress({ target: modelId, phase: "downloading", percent: this.dlPercent(received, total), receivedBytes: received, totalBytes: total ?? def.bytes });
					},
					signal,
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
				if (signal?.aborted) break;
				log?.("voice-runtime", "model candidate failed, trying next", { modelId, url, error: lastError });
			} finally {
				rmSync(partPath, { force: true });
			}
		}
		return fail(lastError);
	}

	/** 删除已下载模型（释放磁盘；正在被转写进程读取时 Windows 会拒删，转成结构化错误）。 */
	deleteModel(modelId: WhisperModelId): WhisperCommandResult {
		const def = getWhisperModelDef(modelId);
		if (!def) return { ok: false, error: "unknown-model" };
		try {
			rmSync(join(this.deps.layout.modelsRoot, def.file), { force: true });
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
