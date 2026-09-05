/**
 * pi-ai 模型目录更新器（设置页「模型目录」功能）。
 *
 * 打包态 resources 目录只读（Program Files 权限 / 签名校验），无法原地覆盖，
 * 因此把 GitHub 拉取的新目录写入 userData 覆盖层（pi-ai-catalog.json + manifest），
 * piAiBuiltinCatalog 读取时覆盖层优先、内置兜底。
 *
 * 安全底线：任何写入都「先校验后原子替换」（manifest sha256 + entryCount 校验通过，
 * tmp 写入 + rename）；下载/校验/写入任意一环失败都不会破坏当前生效目录；
 * 当前覆盖版在替换前备份为 .bak，支持「恢复上一个覆盖版」。
 *
 * 依赖注入：fetchImpl（默认 globalThis.fetch，单测注入替身）、userDataDir（构造函数传入）。
 * 不依赖 electron，可被 node --test 直接加载。
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	PI_AI_CATALOG_FILE_NAME,
	PI_AI_CATALOG_MANIFEST_FILE_NAME,
	invalidatePiAiCatalogIndex,
	parsePiAiCatalogArtifact,
	resolveBuiltinPiAiCatalogArtifactPaths,
} from "./piAiBuiltinCatalog";
import type {
	CatalogArtifactSourceStatus,
	CatalogCheckResult,
	CatalogUpdateResult,
	CatalogUpdateStatus,
} from "../../shared/types/catalog";

/** 默认拉取分支：main（发行分支，模型目录与正式发行版对齐） */
export const CATALOG_UPDATE_DEFAULT_BRANCH = "main";
/** 允许的分支白名单（IPC 边界校验也使用同一常量，防路径/URL 注入） */
export const CATALOG_UPDATE_ALLOWED_BRANCHES = ["main", "dev"] as const;

/** 下载源（按顺序尝试）：jsDelivr CDN → GitHub raw。raw 位于 CDN 失效/被墙时兜底。 */
function sourceBaseUrls(branch: string): { catalog: string; manifest: string }[] {
	return [
		{
			catalog: `https://cdn.jsdelivr.net/gh/ayuayue/PiDeck@${branch}/resources/${PI_AI_CATALOG_FILE_NAME}`,
			manifest: `https://cdn.jsdelivr.net/gh/ayuayue/PiDeck@${branch}/resources/${PI_AI_CATALOG_MANIFEST_FILE_NAME}`,
		},
		{
			catalog: `https://raw.githubusercontent.com/ayuayue/PiDeck/${branch}/resources/${PI_AI_CATALOG_FILE_NAME}`,
			manifest: `https://raw.githubusercontent.com/ayuayue/PiDeck/${branch}/resources/${PI_AI_CATALOG_MANIFEST_FILE_NAME}`,
		},
	];
}

/**
 * 从 manifest 原始文本读取 source.packageVersion；解析失败返回 null。
 * 版本号只做展示与比对，不做校验强依赖（强校验由 parsePiAiCatalogArtifact 承担）。
 */
function manifestPackageVersion(manifestRaw: string): string | null {
	try {
		const parsed: unknown = JSON.parse(manifestRaw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const source = (parsed as Record<string, unknown>).source;
			if (source && typeof source === "object" && !Array.isArray(source)) {
				const version = (source as Record<string, unknown>).packageVersion;
				if (typeof version === "string" && version.length > 0) return version;
			}
		}
		return null;
	} catch {
		return null;
	}
}

/** 目录来源摘要：校验通过才有值，否则 null（未生效）。直接传 catalog/manifest 文件路径。 */
function sourceStatusFromFiles(
	catalogPath: string,
	manifestPath: string,
): CatalogArtifactSourceStatus | null {
	try {
		if (!existsSync(catalogPath) || !existsSync(manifestPath)) return null;
		const catalogRaw = readFileSync(catalogPath, "utf8");
		const manifestRaw = readFileSync(manifestPath, "utf8");
		const entries = parsePiAiCatalogArtifact(catalogRaw, manifestRaw);
		if (entries.length === 0) return null;
		return { packageVersion: manifestPackageVersion(manifestRaw), entryCount: entries.length };
	} catch {
		return null;
	}
}

function sourceStatusFromDir(dir: string): CatalogArtifactSourceStatus | null {
	return sourceStatusFromFiles(join(dir, PI_AI_CATALOG_FILE_NAME), join(dir, PI_AI_CATALOG_MANIFEST_FILE_NAME));
}

export type PiAiCatalogUpdaterOptions = {
	userDataDir: string;
	/** 网络实现注入（单测）；默认 globalThis.fetch */
	fetchImpl?: typeof fetch;
	/** 单次请求超时（ms），默认 15s */
	timeoutMs?: number;
	/** catalog 文件大小上限（防异常大响应），默认 16MB */
	maxCatalogBytes?: number;
	/** manifest 文件大小上限，默认 64KB */
	maxManifestBytes?: number;
	/** 默认分支，默认 main */
	branch?: string;
};

export class PiAiCatalogUpdater {
	private readonly userDataDir: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly maxCatalogBytes: number;
	private readonly maxManifestBytes: number;
	private readonly branch: string;

	constructor(options: PiAiCatalogUpdaterOptions) {
		this.userDataDir = options.userDataDir;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? 15_000;
		this.maxCatalogBytes = options.maxCatalogBytes ?? 16 * 1024 * 1024;
		this.maxManifestBytes = options.maxManifestBytes ?? 64 * 1024;
		this.branch = options.branch ?? CATALOG_UPDATE_DEFAULT_BRANCH;
	}

	private catalogPath(): string {
		return join(this.userDataDir, PI_AI_CATALOG_FILE_NAME);
	}

	/**
	 * 当前生效目录文件路径（覆盖层校验通过优先，否则内置 resources），供「打开文件」查看内容。
	 * 两层都不存在/无效时返回 null（此时内置也损坏，属异常态）。
	 */
	resolveEffectiveCatalogPath(): string | null {
		const overlay = sourceStatusFromDir(this.userDataDir);
		if (overlay) return this.catalogPath();
		const builtinPaths = resolveBuiltinPiAiCatalogArtifactPaths();
		if (builtinPaths && sourceStatusFromFiles(builtinPaths.catalogPath, builtinPaths.manifestPath)) {
			return builtinPaths.catalogPath;
		}
		return null;
	}

	private manifestPath(): string {
		return join(this.userDataDir, PI_AI_CATALOG_MANIFEST_FILE_NAME);
	}

	/** 设置页状态卡片：内置 + 覆盖层 + 备份标记。 */
	getStatus(): CatalogUpdateStatus {
		const builtinPaths = resolveBuiltinPiAiCatalogArtifactPaths();
		return {
			builtin: builtinPaths
				? sourceStatusFromFiles(builtinPaths.catalogPath, builtinPaths.manifestPath)
				: null,
			overlay: sourceStatusFromDir(this.userDataDir),
			hasOverlayFiles: existsSync(this.catalogPath()) || existsSync(this.manifestPath()),
			hasBackup: existsSync(`${this.catalogPath()}.bak`),
		};
	}

	/**
	 * 从 GitHub 分支拉取最新目录并写入覆盖层。
	 * 流程：双源下载 → manifest 校验 → 备份当前覆盖 → 原子替换 → 失效索引缓存。
	 * 成功返回 { ok: true }（UI 随后拉 getStatus 刷新状态卡片）。
	 */
	async update(branch?: string): Promise<CatalogUpdateResult> {
		const targetBranch = branch ?? this.branch;
		let pair: { catalogRaw: string; manifestRaw: string };
		try {
			pair = await this.downloadFromAnySource(targetBranch);
		} catch (error) {
			return {
				ok: false,
				code: "network",
				message: `catalog download failed from all sources: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const entries = parsePiAiCatalogArtifact(pair.catalogRaw, pair.manifestRaw);
		if (entries.length === 0) {
			// 下载内容与 manifest 不匹配（或被篡改）：拒绝写入，防止坏数据上盘
			return { ok: false, code: "validation", message: "downloaded artifact failed manifest validation" };
		}
		try {
			this.writeOverlayAtomically(pair.catalogRaw, pair.manifestRaw);
		} catch (error) {
			return {
				ok: false,
				code: "write",
				message: `failed to write overlay: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		invalidatePiAiCatalogIndex();
		return { ok: true };
	}

	/** 一键还原：当前覆盖版转存为 .bak 并删除覆盖文件，回退到内置目录。 */
	restoreBuiltin(): CatalogUpdateResult {
		if (!existsSync(this.catalogPath()) && !existsSync(this.manifestPath())) {
			// 没有覆盖层：无需操作，视为成功（UI 状态卡片会显示内置生效）
			return { ok: true };
		}
		try {
			this.moveOverlayToBackup();
			invalidatePiAiCatalogIndex();
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				code: "write",
				message: `failed to restore builtin catalog: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/** 恢复上一个覆盖版：.bak 校验通过后写回覆盖层。 */
	restorePrevious(): CatalogUpdateResult {
		const bakCatalog = `${this.catalogPath()}.bak`;
		const bakManifest = `${this.manifestPath()}.bak`;
		if (!existsSync(bakCatalog) || !existsSync(bakManifest)) {
			return { ok: false, code: "no-backup", message: "no previous overlay backup found" };
		}
		try {
			const catalogRaw = readFileSync(bakCatalog, "utf8");
			const manifestRaw = readFileSync(bakManifest, "utf8");
			if (parsePiAiCatalogArtifact(catalogRaw, manifestRaw).length === 0) {
				return { ok: false, code: "validation", message: "backup artifact failed manifest validation" };
			}
			this.writeOverlayAtomically(catalogRaw, manifestRaw);
			invalidatePiAiCatalogIndex();
			return { ok: true };
		} catch (error) {
			return {
				ok: false,
				code: "write",
				message: `failed to restore previous overlay: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/**
	 * 检查远端是否有新版本：下载远端 manifest（双源）、解析 packageVersion，
	 * 与当前生效版本（覆盖层优先，否则内置）比对。
	 */
	async checkRemote(branch?: string): Promise<CatalogCheckResult> {
		let manifestRaw: string;
		try {
			manifestRaw = await this.downloadManifestFromAnySource(branch ?? this.branch);
		} catch (error) {
			return {
				ok: false,
				code: "network",
				message: `catalog manifest download failed from all sources: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const remoteVersion = manifestPackageVersion(manifestRaw);
		if (remoteVersion === null) {
			return { ok: false, code: "validation", message: "remote manifest has no valid packageVersion" };
		}
		const status = this.getStatus();
		const localVersion = status.overlay?.packageVersion ?? status.builtin?.packageVersion ?? null;
		return { ok: true, remoteVersion, localVersion, hasUpdate: remoteVersion !== localVersion };
	}

	/**
	 * 下载一对 artifact（先 manifest 后 catalog），按源列表顺序尝试：
	 * 源内任一文件失败（网络/超时/HTTP 错误/超大小）即换下一个源。
	 * 全部失败抛错，由调用方归为 network。
	 */
	private async downloadFromAnySource(
		branch: string,
	): Promise<{ catalogRaw: string; manifestRaw: string }> {
		let lastError: unknown;
		for (const source of sourceBaseUrls(branch)) {
			try {
				const manifestRaw = await this.downloadText(source.manifest, this.maxManifestBytes);
				const catalogRaw = await this.downloadText(source.catalog, this.maxCatalogBytes);
				return { catalogRaw, manifestRaw };
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError ?? new Error("no download sources configured");
	}

	/** 只下载 manifest（checkRemote 用），源列表同 update，全部失败抛错。 */
	private async downloadManifestFromAnySource(branch: string): Promise<string> {
		let lastError: unknown;
		for (const source of sourceBaseUrls(branch)) {
			try {
				return await this.downloadText(source.manifest, this.maxManifestBytes);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError ?? new Error("no download sources configured");
	}

	private async downloadText(url: string, maxBytes: number): Promise<string> {
		const controller = new AbortController();
		// 超时中止：网络挂起（DNS/连接阶段）时同样生效，防止 UI 长期转圈
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await this.fetchImpl(url, {
				signal: controller.signal,
				redirect: "follow",
				headers: { "user-agent": "PiDeck-catalog-updater" },
			});
			if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
			const buffer = await response.arrayBuffer();
			if (buffer.byteLength > maxBytes) {
				throw new Error(`response too large (${buffer.byteLength} bytes) for ${url}`);
			}
			return new TextDecoder("utf-8").decode(buffer);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * 原子替换覆盖层文件：tmp 写入 → 校验无误 → 当前覆盖版复制为 .bak → rename 顶上。
	 * 任一步失败只清理 tmp，当前生效文件与 .bak 不会被破坏。
	 */
	private writeOverlayAtomically(catalogRaw: string, manifestRaw: string): void {
		mkdirSync(this.userDataDir, { recursive: true });
		const catalogPath = this.catalogPath();
		const manifestPath = this.manifestPath();
		const tmpCatalog = `${catalogPath}.tmp`;
		const tmpManifest = `${manifestPath}.tmp`;
		try {
			writeFileSync(tmpCatalog, catalogRaw, "utf8");
			writeFileSync(tmpManifest, manifestRaw, "utf8");
			// 备份当前覆盖版（无论新旧都保留一份，供「恢复上一个覆盖版」）
			if (existsSync(catalogPath)) copyFileSync(catalogPath, `${catalogPath}.bak`);
			if (existsSync(manifestPath)) copyFileSync(manifestPath, `${manifestPath}.bak`);
			renameSync(tmpCatalog, catalogPath);
			renameSync(tmpManifest, manifestPath);
		} catch (error) {
			// 清理半成品；失败重抛给调用方归类 write，备份文件保留供人工恢复
			try {
				rmSync(tmpCatalog, { force: true });
				rmSync(tmpManifest, { force: true });
			} catch {
				/* 清理失败不掩盖原始错误 */
			}
			throw error;
		}
	}

	/** 覆盖文件转 .bak（覆盖旧 .bak）；暴露给 restoreBuiltin。 */
	private moveOverlayToBackup(): void {
		const catalogPath = this.catalogPath();
		const manifestPath = this.manifestPath();
		if (existsSync(catalogPath)) renameSync(catalogPath, `${catalogPath}.bak`);
		if (existsSync(manifestPath)) renameSync(manifestPath, `${manifestPath}.bak`);
	}
}
