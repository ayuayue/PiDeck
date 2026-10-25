/**
 * 飞书 SDK 运行时加载器（体积优化，2026-10）。
 *
 * 为什么存在：`@larksuiteoapi/node-sdk` 的 CJS 入口是单文件 5MB，加上它独占的传递依赖
 * （protobufjs、axios、lodash 系列、form-data 链）在 app.asar 里约占 7.2MB；而飞书是
 * 可选集成（用户自己填 appId/appSecret）。打包链路把它压成
 * `resources/feishu-sdk/feishu-sdk-<version>.tar.gz`（实测 0.93MB，gzip -9），首次启用
 * 飞书时解压到 `<userData>/feishu-sdk/<version>/`，安装包净省约 6.3MB，且不引入网络依赖。
 *
 * 与「按需 npm 安装」的取舍：本方案零网络、零 npm 依赖、失败面只有解压；代价是包里仍带
 * 压缩后的 SDK（0.93MB）。解压产物按版本隔离，SDK 升级只需重新打 tar 包。
 *
 * 纪律：
 * - 压缩包是不可信输入：运行前校验字节数与 sha256（manifest 随包分发），解压走
 *   `fs/tarRead` 的常规文件 + 路径穿越校验，gzip 解压有展开上限。
 * - 解压先写 `<cache>.tmp-<pid>`，全部落盘后 rename 换入；失败清理临时目录，
 *   不会留下半套 SDK 让下次 require 到缺文件的包。
 * - dev（未打包）直接用 node_modules，不生成缓存。
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { readTarFiles } from "../fs/tarRead";

const SDK_PACKAGE = "@larksuiteoapi/node-sdk";
/** 压缩包上限：实测 0.93MB，留足未来版本增长余量。 */
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
/** 解压后上限：实测约 7MB 运行时文件，留 8 倍余量防解压炸弹。 */
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
/** 解压写盘并发：567 个文件串行在慢盘上要几百 ms。 */
const EXTRACT_CONCURRENCY = 16;

/** 只声明本项目用到的 SDK 面（FeishuConnection 的 LarkSDK 类型来自这里）。 */
export type FeishuSdkModule = {
	Client: new (options: Record<string, unknown>) => unknown;
	WSClient: new (options: Record<string, unknown>) => { start: (options: Record<string, unknown>) => Promise<unknown> };
	EventDispatcher: new (options: Record<string, unknown>) => { register: (handlers: Record<string, unknown>) => unknown };
	AppType: Record<string, unknown>;
	Domain: Record<string, unknown>;
	LoggerLevel: Record<string, unknown>;
	normalizeCardAction: (data: Record<string, unknown>, options?: Record<string, unknown>) => unknown;
};

export type FeishuSdkManifest = {
	version: string;
	archive: string;
	sha256: string;
	bytes: number;
	packages: string[];
	files: number;
};

export type FeishuSdkRuntimeOptions = {
	/** 打包态：`process.resourcesPath`；dev 传 null/undefined 走 node_modules。 */
	resourcesPath?: string | null;
	/** 解压缓存根：`app.getPath("userData")`。 */
	cacheRoot: string;
	/** 注入用（测试）；默认读 `resourcesPath/feishu-sdk/manifest.json`。 */
	loadManifest?: () => Promise<FeishuSdkManifest>;
	/** dev 态加载器（测试注入）；默认 `import("@larksuiteoapi/node-sdk")`。 */
	importFromNodeModules?: () => Promise<FeishuSdkModule>;
};

export type FeishuSdkLoadResult = { ok: true; module: FeishuSdkModule; source: "node_modules" | "archive" | "cache" } | { ok: false; reason: "missing-archive" | "checksum" | "extract-failed" | "load-failed"; message: string };

/** 解压缓存目录（按版本隔离，升级 SDK 不会读到旧文件）。 */
export function feishuSdkCacheDir(cacheRoot: string, version: string): string {
	return join(cacheRoot, "feishu-sdk", version);
}

function sdkEntryPath(root: string): string {
	return join(root, "node_modules", SDK_PACKAGE, "lib", "index.js");
}

function requireSdk(root: string): FeishuSdkModule {
	// 以解压根为基准建 require：Node 会从 `<root>/node_modules` 逐级向上找，
	// 依赖（axios/protobufjs/...）与 SDK 同级，解析结果与常规 install 布局一致。
	const requireFromCache = createRequire(join(root, "package.json"));
	return requireFromCache(SDK_PACKAGE) as FeishuSdkModule;
}

async function writeEntries(root: string, entries: ReturnType<typeof readTarFiles>): Promise<void> {
	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			if (index >= entries.length) return;
			const entry = entries[index]!;
			const target = join(root, entry.path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, entry.bytes);
		}
	};
	await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, entries.length) }, worker));
}

/** Windows 文件锁抖动：删除/换入失败按 100ms 退避重试三次。 */
async function removeDirWithRetry(dir: string): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await rm(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt >= 2) throw error;
			await delay(100 * (attempt + 1));
		}
	}
}

async function renameWithRetry(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			if (attempt >= 2) throw error;
			await delay(100 * (attempt + 1));
		}
	}
}

/** 解压并原子换入缓存目录；返回 SDK 根路径。 */
async function extractToCache(cacheDir: string, archiveBytes: Buffer): Promise<void> {
	const tar = gunzipSync(archiveBytes, { maxOutputLength: MAX_EXPANDED_BYTES });
	const entries = readTarFiles(tar);
	if (entries.length === 0) throw new Error("archive-empty");
	const tempDir = `${cacheDir}.tmp-${process.pid}-${Date.now()}`;
	await rm(tempDir, { recursive: true, force: true });
	try {
		await mkdir(tempDir, { recursive: true });
		await writeEntries(tempDir, entries);
		// Windows 上 rename 到已存在的目录会失败：先删旧缓存（可能是半套/旧版本）。
		// 杀毒/索引器常会短暂锁住刚写完的目录，删除与换入都按 100ms 退避重试三次——
		// 否则首次启用飞书会偶发 extract-failed（用户只能靠重启碰运气）。
		await removeDirWithRetry(cacheDir);
		await mkdir(dirname(cacheDir), { recursive: true });
		await renameWithRetry(tempDir, cacheDir);
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

async function readManifestFromResources(resourcesPath: string): Promise<FeishuSdkManifest> {
	return JSON.parse(await readFile(join(resourcesPath, "feishu-sdk", "manifest.json"), "utf8")) as FeishuSdkManifest;
}

/**
 * 加载飞书 SDK。并发调用共享同一个进行中的 Promise（解压只做一次）。
 * 失败一律返回结构化结果，不抛裸异常跨 IPC（调用方转成用户可读提示）。
 */
export async function loadFeishuSdk(options: FeishuSdkRuntimeOptions): Promise<FeishuSdkLoadResult> {
	const importFromNodeModules = options.importFromNodeModules ?? (async () => (await import(SDK_PACKAGE)) as unknown as FeishuSdkModule);

	// dev：node_modules 就在仓库里，直接加载（打包链路才会排除它）。
	if (!options.resourcesPath) {
		try {
			return { ok: true, module: await importFromNodeModules(), source: "node_modules" };
		} catch (error) {
			return { ok: false, reason: "load-failed", message: error instanceof Error ? error.message : String(error) };
		}
	}

	let manifest: FeishuSdkManifest;
	try {
		manifest = options.loadManifest ? await options.loadManifest() : await readManifestFromResources(options.resourcesPath);
	} catch (error) {
		return { ok: false, reason: "missing-archive", message: error instanceof Error ? error.message : String(error) };
	}

	const cacheDir = feishuSdkCacheDir(options.cacheRoot, manifest.version);
	if (existsSync(sdkEntryPath(cacheDir))) {
		try {
			return { ok: true, module: requireSdk(cacheDir), source: "cache" };
		} catch (error) {
			// 缓存损坏（杀毒删文件/磁盘错误）：删掉重建，而不是把坏状态留给用户重试。
			await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
			void error;
		}
	}

	const archivePath = join(options.resourcesPath, "feishu-sdk", manifest.archive);
	let archiveBytes: Buffer;
	try {
		archiveBytes = await readFile(archivePath);
	} catch (error) {
		return { ok: false, reason: "missing-archive", message: error instanceof Error ? error.message : String(error) };
	}
	if (archiveBytes.length > MAX_ARCHIVE_BYTES) return { ok: false, reason: "checksum", message: "archive-too-large" };
	if (archiveBytes.length !== manifest.bytes) return { ok: false, reason: "checksum", message: "archive-size-mismatch" };
	const digest = createHash("sha256").update(archiveBytes).digest("hex");
	if (digest !== manifest.sha256) return { ok: false, reason: "checksum", message: "archive-sha256-mismatch" };

	try {
		await extractToCache(cacheDir, archiveBytes);
	} catch (error) {
		return { ok: false, reason: "extract-failed", message: error instanceof Error ? error.message : String(error) };
	}

	try {
		return { ok: true, module: requireSdk(cacheDir), source: "archive" };
	} catch (error) {
		return { ok: false, reason: "load-failed", message: error instanceof Error ? error.message : String(error) };
	}
}

/** 进程内单例：FeishuBridge 反复 start/stop 不重复解压。 */
let inflight: Promise<FeishuSdkLoadResult> | null = null;

export function loadFeishuSdkOnce(options: FeishuSdkRuntimeOptions): Promise<FeishuSdkLoadResult> {
	if (!inflight) {
		inflight = loadFeishuSdk(options)
			.catch((error: unknown): FeishuSdkLoadResult => ({ ok: false, reason: "load-failed", message: error instanceof Error ? error.message : String(error) }))
			.then((result) => {
				// 失败不缓存：压缩包缺失/被杀毒锁住都是可恢复的，缓存失败结果会让用户
				// 在本次进程内永远启不了飞书（只能重启）。成功结果才值得复用。
				if (!result.ok) inflight = null;
				return result;
			});
	}
	return inflight;
}

/** 测试/退出清理用。 */
export function resetFeishuSdkRuntime(): void {
	inflight = null;
}
