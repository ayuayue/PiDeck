/**
 * DSH runtime 生命周期管理（AgentRuntimeProvider 阶段 2）。
 *
 * runtime 是解压在 `userData/runtimes/dsh/<runtimeVersion>/` 的 @deepseek-ai 依赖集合，
 * 目录内带 manifest.json 声明兼容的 app 版本区间。本模块负责：
 * 扫描已装版本 → 按兼容区间选启用版本 → 下载/校验/解压/落位 → 回收多余版本 → 卸载。
 *
 * 三条硬约束：
 * 1. **先校验后落位**：sha256 不过就直接失败，绝不把可疑归档解压进数据目录。
 * 2. **原子落位**：解压进临时目录，全部校验通过后才 rename 到正式目录；
 *    任何一步失败都清掉临时目录，正式目录保持「要么没有、要么完整可用」。
 * 3. **解压路径必须在目标内**：tar slip（归档内 `../../` 逃逸条目）会让攻击者
 *    写穿数据目录，这里显式过滤。
 *
 * 下载与解压是可注入的（测试用替身，不依赖真实网络/文件系统布局）。
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
// 大目录的复制/删除/改名必须走异步版：runtime 目录有数万个小文件（约 150MB），
// 用 cpSync/rmSync 会同步阻塞主进程事件循环，安装/卸载期间整个 UI 卡死。
import { cp, rename, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
	DSH_RUNTIME_ARCHIVE_ROOT,
	DSH_RUNTIME_MANIFEST_FILE,
	isAppVersionCompatible,
	isManifestSchemaSupported,
	selectRuntime,
	type DshRuntimeManifest,
	type InstalledDshRuntime,
} from "../../../shared/types/dshRuntimeManifest";

/** 随包 runtime 目录名（位于 Electron 的 resources 目录下）。 */
export const DSH_BUNDLED_RUNTIME_DIRNAME = "dsh-runtime";

/** 落位后的 runtime 布局。 */
export type DshRuntimeLayout = {
	/** 版本目录的父目录：userData/runtimes/dsh。 */
	runtimesRoot: string;
	/** 解压暂存根目录（与 runtimesRoot 同级，便于整体清理）。 */
	tempRoot: string;
};

/** 下载器：`onProgress(receivedBytes, totalBytes|undefined)`。 */
export type DshRuntimeDownloader = (
	url: string,
	destPath: string,
	onProgress?: (received: number, total?: number) => void,
	signal?: AbortSignal,
) => Promise<void>;

/** 解压器：把 tarball 解到 destDir（destDir 由本模块创建并保证为空）。 */
export type DshRuntimeExtractor = (archivePath: string, destDir: string) => Promise<void>;

export type DshRuntimeManagerDeps = {
	layout: DshRuntimeLayout;
	/** 当前 app 版本（兼容区间判定用）。 */
	appVersion: () => string;
	download?: DshRuntimeDownloader;
	extract?: DshRuntimeExtractor;
	log?: (scope: string, message: string, detail?: unknown) => void;
};

/** 安装结果：成功给出落位目录与版本；失败给出原因（调用方决定是否提示）。 */
export type DshRuntimeInstallResult =
	| { ok: true; dirName: string; manifest: DshRuntimeManifest }
	| { ok: false; error: string };

export type DshRuntimeInstallOptions = {
	signal?: AbortSignal;
	onPhase?: (phase: "downloading" | "verifying" | "extracting" | "finalizing") => void;
	onDownloadProgress?: (received: number, total?: number) => void;
};

/** 读取并校验单个版本目录的 manifest；不可读/不兼容返回 undefined（调用方按不存在处理）。 */
export function readRuntimeManifest(
	dir: string,
	appVersion: string,
): { manifest: DshRuntimeManifest; compatible: boolean } | undefined {
	const manifestPath = join(dir, DSH_RUNTIME_MANIFEST_FILE);
	if (!existsSync(manifestPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as DshRuntimeManifest;
		if (typeof parsed?.runtimeVersion !== "string" || typeof parsed?.schemaVersion !== "number") {
			return undefined;
		}
		return {
			manifest: parsed,
			compatible:
				isManifestSchemaSupported(parsed) && isAppVersionCompatible(appVersion, parsed),
		};
	} catch {
		// 清单损坏 = 该版本不可用，但目录仍在，等待回收或重装。
		return undefined;
	}
}

/**
 * 提取错误文案。
 * 不用 `instanceof Error`：跨 realm（如 Node 测试用 vm 沙箱加载本模块）时该判定
 * 恒为 false，会退化成 "Error: xxx" 这种带类名前缀的脏文案。取 message 字段
 * 在两种环境下都得到干净的一手原因。
 */
function errorMessage(error: unknown): string {
	if (error !== null && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.length > 0) return message;
	}
	return String(error);
}

/** 计算文件 sha256（小写 hex）。 */
export async function sha256OfFile(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	const stream = createReadStream(filePath);
	for await (const chunk of stream) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

/**
 * 归档内条目 → 落盘路径的安全判定（tar slip 防护）。
 * 只接受相对路径、不接受 `..` 段，且解析后必须仍在 destDir 内。
 */
export function isSafeArchiveEntry(destDir: string, entryPath: string): boolean {
	const normalized = entryPath.replace(/\\/g, "/");
	if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
	if (normalized.split("/").includes("..")) return false;
	const target = resolve(destDir, normalized);
	const rel = relative(destDir, target);
	return rel === "" || (!rel.startsWith("..") && !resolve(destDir, rel).startsWith(".."));
}

/**
 * 随包 runtime 资源（resources/dsh-runtime/）的一份归档。
 * 由打包脚本产出，与 tarball 同目录放一份 manifest.json（带真实 sha256）。
 */
export type BundledDshRuntime = {
	archivePath: string;
	manifest: DshRuntimeManifest;
};

/**
 * 读取随包 runtime：目录里有 manifest.json 且归档存在、且兼容当前 app 才返回。
 *
 * 为什么需要它：Release 资产尚未发布时，在线下载链路跑不通，打包产物的 DSH 就
 * 完全不可用。随包资源让「安装」退化成本地解压——零网络、零等待，而不用 DSH 的
 * 用户永远不会触发解压（它不进 asar、不随启动加载）。想要小安装包的场景用
 * `--lite` 打出不含该目录的包，届时回到在线/手动导入。
 */
export function readBundledRuntime(
	dir: string | undefined,
	appVersion: string,
): BundledDshRuntime | undefined {
	if (!dir || !existsSync(dir)) return undefined;
	const manifestPath = join(dir, DSH_RUNTIME_MANIFEST_FILE);
	if (!existsSync(manifestPath)) return undefined;
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DshRuntimeManifest;
		if (!isManifestSchemaSupported(manifest)) return undefined;
		if (!isAppVersionCompatible(appVersion, manifest)) return undefined;
		const archivePath = join(dir, `dsh-runtime-${process.platform}-${process.arch}.tgz`);
		return existsSync(archivePath) ? { archivePath, manifest } : undefined;
	} catch {
		return undefined;
	}
}

export class DshRuntimeManager {
	private readonly download: DshRuntimeDownloader | undefined;
	private readonly extract: DshRuntimeExtractor | undefined;

	constructor(private readonly deps: DshRuntimeManagerDeps) {
		this.download = deps.download;
		this.extract = deps.extract;
	}

	/** 扫描已安装的所有版本（清单可读的；损坏目录也列出，供回收）。 */
	listInstalled(): InstalledDshRuntime[] {
		const root = this.deps.layout.runtimesRoot;
		if (!existsSync(root)) return [];
		const result: InstalledDshRuntime[] = [];
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dirName = entry.name;
			const read = readRuntimeManifest(join(root, dirName), this.deps.appVersion());
			if (read) result.push({ manifest: read.manifest, dirName });
		}
		return result;
	}

	/**
	 * 当前应启用的 runtime：兼容区间内版本最大的那个。
	 * 返回 node_modules 路径（DshHost 用它拼 `--dsh-node-modules`）与版本目录名。
	 */
	resolveActive(): { dirName: string; manifest: DshRuntimeManifest; nodeModules: string } | undefined {
		const selected = selectRuntime(this.listInstalled(), this.deps.appVersion());
		if (!selected) return undefined;
		return {
			dirName: selected.dirName,
			manifest: selected.manifest,
			nodeModules: join(this.deps.layout.runtimesRoot, selected.dirName, "node_modules"),
		};
	}

	/**
	 * 从本地已解压的 runtime 目录安装（手动导入已解压目录的场景）。
	 * 与 installFromArchive 的区别：来源不是 tarball 而是现成目录，跳过解压、直接校验后复制落位。
	 * 流程：目录校验（manifest + 关键包）→ 复制到临时目录 → 原子 rename 落位 → 清理。
	 *
	 * 为什么复制而不是移动：用户选中的是磁盘上自己的解压目录（可能在任意盘符），
	 * 直接 rename 会跨卷失败（EXDEV）且破坏用户来源；复制到 tempRoot（与 runtimesRoot
	 * 同卷）再 rename，落位仍是原子的，来源目录保持不动。
	 */
	async installFromDirectory(
		dirPath: string,
		options: DshRuntimeInstallOptions = {},
	): Promise<DshRuntimeInstallResult> {
		const log = this.deps.log ?? (() => {});
		if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
			return { ok: false, error: "directory not found" };
		}

		// 与 tarball 约定一致：目录内可能直接是 dsh-runtime/（解压产物）或套一层包装，
		// 剥掉顶层后才是 node_modules + manifest。
		let sourceRoot = existsSync(join(dirPath, DSH_RUNTIME_ARCHIVE_ROOT))
			? join(dirPath, DSH_RUNTIME_ARCHIVE_ROOT)
			: dirPath;

		// 用户可能选中的是「安装目录的父级」（如 runtimesRoot 本身，卸载后仍残留在磁盘上）：
		// 目录自身没有 manifest，但里面唯一子目录就是完整 runtime。此时一级探测会失败，
		// 再尝试「唯一子目录下钻」——避免用户明明有 runtime 却被报 manifest missing。
		// 只接受唯一候选：多子目录时无法断定意图，保留原错误不去猜。
		let sourceManifest = this.verifyStagedRuntime(sourceRoot);
		if (typeof sourceManifest === "string") {
			const children = readdirSync(dirPath, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(dirPath, entry.name))
				.filter((child) => child !== sourceRoot);
			const candidates = children
				.map((child) => {
					const nested = this.verifyStagedRuntime(child);
					return typeof nested !== "string" ? { child, nested } : undefined;
				})
				.filter((entry): entry is { child: string; nested: DshRuntimeManifest } => entry !== undefined);
			if (candidates.length === 1) {
				sourceRoot = candidates[0].child;
				sourceManifest = candidates[0].nested;
			}
		}

		// 先在校验源目录上快速失败（manifest 不对就不复制，避免白拷几十 MB），
		// 校验通过后再复制到暂存目录落位——落位的始终是校验过的那份内容。
		if (typeof sourceManifest === "string") return { ok: false, error: sourceManifest };

		mkdirSync(this.deps.layout.tempRoot, { recursive: true });
		const staging = join(this.deps.layout.tempRoot, `install-${Date.now()}`);
		try {
			options.onPhase?.("extracting");
			// 异步复制来源目录（数万文件），避免 cpSync 阻塞主进程事件循环。
			await cp(sourceRoot, staging, { recursive: true });

			options.onPhase?.("finalizing");
			const target = this.versionDir(sourceManifest.runtimeVersion);
			// 同版本已存在：先清掉再 rename（rename 到非空目录在 Windows 会失败）。
			await rm(target, { recursive: true, force: true });
			mkdirSync(this.deps.layout.runtimesRoot, { recursive: true });
			await rename(staging, target);
			log("dsh-runtime", "runtime installed from directory", {
				version: sourceManifest.runtimeVersion,
			});
			return { ok: true, dirName: sourceManifest.runtimeVersion, manifest: sourceManifest };
		} catch (error) {
			const message = errorMessage(error);
			log("dsh-runtime", "runtime install from directory failed", { error: message });
			return { ok: false, error: message };
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}

	/**
	 * 从本地 tarball 安装（手动导入 / 已下载完成的场景）。
	 * 流程：sha256 校验 → 解压到临时目录 → 校验 manifest 与关键包 → 原子 rename 落位 → 清理。
	 */
	async installFromArchive(
		archivePath: string,
		expectedSha256?: string,
		options: DshRuntimeInstallOptions = {},
	): Promise<DshRuntimeInstallResult> {
		const log = this.deps.log ?? (() => {});
		if (!existsSync(archivePath)) return { ok: false, error: "archive not found" };
		if (!this.extract) return { ok: false, error: "extractor is not configured" };

		options.onPhase?.("verifying");
		if (expectedSha256) {
			const actual = await sha256OfFile(archivePath);
			if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
				log("dsh-runtime", "archive sha256 mismatch", { expected: expectedSha256, actual });
				return { ok: false, error: "sha256 mismatch" };
			}
		}

		mkdirSync(this.deps.layout.tempRoot, { recursive: true });
		const staging = join(this.deps.layout.tempRoot, `install-${Date.now()}`);
		try {
			options.onPhase?.("extracting");
			await this.extract(archivePath, staging);

			// 归档约定：顶层是 dsh-runtime/ 目录，剥掉这一层后才是 node_modules + manifest。
			const root = existsSync(join(staging, DSH_RUNTIME_ARCHIVE_ROOT))
				? join(staging, DSH_RUNTIME_ARCHIVE_ROOT)
				: staging;
			const manifest = this.verifyStagedRuntime(root);
			if (typeof manifest === "string") return { ok: false, error: manifest };

			options.onPhase?.("finalizing");
			const target = this.versionDir(manifest.runtimeVersion);
			// 同版本已存在：先清掉再 rename（rename 到非空目录在 Windows 会失败）。
			await rm(target, { recursive: true, force: true });
			mkdirSync(this.deps.layout.runtimesRoot, { recursive: true });
			await rename(root, target);
			log("dsh-runtime", "runtime installed", { version: manifest.runtimeVersion });
			return { ok: true, dirName: manifest.runtimeVersion, manifest };
		} catch (error) {
			const message = errorMessage(error);
			log("dsh-runtime", "runtime install failed", { error: message });
			return { ok: false, error: message };
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}

	/** 从 URL 安装：先下载到临时文件，再走 installFromArchive 的同一条校验/落位链路。 */
	async installFromUrl(
		url: string,
		expectedSha256: string,
		options: DshRuntimeInstallOptions = {},
	): Promise<DshRuntimeInstallResult> {
		if (!this.download) return { ok: false, error: "downloader is not configured" };
		mkdirSync(this.deps.layout.tempRoot, { recursive: true });
		const archivePath = join(this.deps.layout.tempRoot, `download-${Date.now()}.tgz`);
		try {
			options.onPhase?.("downloading");
			await this.download(url, archivePath, options.onDownloadProgress, options.signal);
			return await this.installFromArchive(archivePath, expectedSha256, options);
		} catch (error) {
			const message = errorMessage(error);
			this.deps.log?.("dsh-runtime", "runtime download failed", { error: message });
			return { ok: false, error: message };
		} finally {
			await rm(archivePath, { recursive: true, force: true });
		}
	}

	/** 卸载指定版本目录（当前启用的也可卸，卸载后状态服务会退回 notInstalled）。 */
	async uninstall(dirName: string): Promise<boolean> {
		const target = join(this.deps.layout.runtimesRoot, dirName);
		if (!existsSync(target)) return false;
		try {
			// Windows 上运行中进程（DSH host 持 .node 原生模块 DLL 句柄）、杀软扫描、
			// 资源管理器打开目录都会让 rm 抛 EPERM/EBUSY。这类占用大多是瞬时锁，
			// 用 fs/promises.rm 的线性退避重试（EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM）
			// 吸收；占用持续到重试耗尽才抛错，由调用方转成结构化结果。
			// 异步删除：整个 runtime 目录数万小文件，rmSync 会阻塞主进程事件循环。
			await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
			this.deps.log?.("dsh-runtime", "runtime uninstalled", { dirName });
			return true;
		} catch (error) {
			const message = errorMessage(error);
			this.deps.log?.("dsh-runtime", "runtime uninstall failed", { dirName, error: message });
			// 抛带上下文的可读错误（含失败版本），不让裸 EPERM 跨 IPC 变成「未处理异常」。
			throw new Error(`failed to remove runtime directory "${dirName}": ${message}`);
		}
	}

	/**
	 * 校验暂存目录内容：manifest 可读、schema 认识、关键包都在。
	 * 返回 manifest 对象，或失败原因字符串。
	 */
	private verifyStagedRuntime(root: string): DshRuntimeManifest | string {
		const manifestPath = join(root, DSH_RUNTIME_MANIFEST_FILE);
		if (!existsSync(manifestPath)) return "manifest missing";
		let manifest: DshRuntimeManifest;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DshRuntimeManifest;
		} catch {
			return "manifest unreadable";
		}
		if (!isManifestSchemaSupported(manifest)) return "manifest schema unsupported";
		if (!isAppVersionCompatible(this.deps.appVersion(), manifest)) return "app version incompatible";
		if (!existsSync(join(root, "node_modules"))) return "node_modules missing";
		// 关键包校验：归档与清单不一致（打包脚本跑错版本 / 手工篡改）时挡住。
		for (const pkg of manifest.requiredPackages ?? []) {
			if (!existsSync(join(root, "node_modules", pkg, "package.json"))) {
				return `required package missing: ${pkg}`;
			}
		}
		return manifest;
	}

	private versionDir(runtimeVersion: string): string {
		return join(this.deps.layout.runtimesRoot, runtimeVersion);
	}
}
