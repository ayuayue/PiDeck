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
import {
	compareSemver,
	generatePiAiCatalogFromFiles,
	type CatalogSourceFile,
} from "./piAiCatalogGenerate";
import type {
	CatalogArtifactSourceStatus,
	CatalogCheckResult,
	CatalogUpdateResult,
	CatalogUpdateStatus,
} from "../../shared/types/catalog";
import type { UpdateSourceId } from "../../shared/types/settings";
import { normalizeCustomMirrorHost, UPDATE_SOURCE_MIRRORS } from "../../shared/updateSources";

/** 默认回退分支：main（发行分支，模型目录与正式发行版对齐） */
export const CATALOG_UPDATE_DEFAULT_BRANCH = "main";
/** 允许的分支白名单（IPC 边界校验也使用同一常量，防路径/URL 注入） */
export const CATALOG_UPDATE_ALLOWED_BRANCHES = ["main", "dev"] as const;

/** 上游 npm 包名（与生成器/内置校验一致，来源即 @earendil-works/pi-ai）。 */
export const CATALOG_SOURCE_PACKAGE = "@earendil-works/pi-ai";
/** npm 版本解析源（中国镜像优先，官方兜底）：只取 latest 版本号。 */
export const CATALOG_NPM_LATEST_URLS = [
	"https://registry.npmmirror.com/@earendil-works/pi-ai/latest",
	"https://registry.npmjs.org/@earendil-works/pi-ai/latest",
] as const;
/** jsDelivr 文件列表 API（枚举 dist/providers/data/*.json），取 flat 列表。 */
export const CATALOG_JSDELIVR_FLAT_PREFIX =
	"https://data.jsdelivr.com/v1/package/npm/@earendil-works/pi-ai@";
/** jsDelivr 单文件 CDN 前缀（按版本取 dist/providers/data/<file>）。 */
export const CATALOG_JSDELIVR_FILE_PREFIX =
	"https://cdn.jsdelivr.net/npm/@earendil-works/pi-ai@";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 下载源（按顺序尝试）：镜像代理 GitHub raw → GitHub raw。
 * 镜像前缀形如 `https://ghfast.top/https://raw.githubusercontent.com/...`，
 * 与应用更新的 GitHub 镜像体系同源（shared/updateSources.ts），国内可达性远好于
 * 直连 GitHub raw。未配置镜像时只有 GitHub raw 一个源。
 *
 * 注意：不再把 jsDelivr gh CDN 列为下载回退源。实测 jsDelivr 对 manifest/catalog
 * 有陈旧缓存（如 0.85.0），与 GitHub raw 当前的 0.85.1 内容不同（dataSha256
 * 不一致）。一旦 GitHub raw 短暂失败、回落到 jsDelivr，就会拿到过期数据且无法
 * 与"当前版本"区分 —— 表现为 checkRemote 永远报"已是最新"而错过真更新。
 * 下载失败时由调用方走 npm 生成回退（checkRemote）或直接报错（update），
 * 不拿陈旧 CDN 数据当真值。
 */
function sourceBaseUrls(
	branch: string,
	mirrorHost?: string | null,
): { catalog: string; manifest: string }[] {
	const rawCatalog = `https://raw.githubusercontent.com/ayuayue/PiDeck/${branch}/resources/${PI_AI_CATALOG_FILE_NAME}`;
	const rawManifest = `https://raw.githubusercontent.com/ayuayue/PiDeck/${branch}/resources/${PI_AI_CATALOG_MANIFEST_FILE_NAME}`;
	const sources: { catalog: string; manifest: string }[] = [];
	if (mirrorHost) {
		sources.push({ catalog: `${mirrorHost}/${rawCatalog}`, manifest: `${mirrorHost}/${rawManifest}` });
	}
	sources.push({ catalog: rawCatalog, manifest: rawManifest });
	return sources;
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
	/**
	 * 更新源：复用应用更新的 GitHub 镜像配置（shared/updateSources.ts）。
	 * 目录下载/检测默认直连 GitHub 分支，国内用户切镜像后自动走代理前缀。
	 * 用函数而非快照：设置可在运行时更改，每次检查/下载读最新值。
	 */
	source?: () => UpdateSourceId;
	/** source="custom" 时的镜像前缀；与 source 同生命周期（运行时读最新）。 */
	customHost?: () => string;
};

export class PiAiCatalogUpdater {
	private readonly userDataDir: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly maxCatalogBytes: number;
	private readonly maxManifestBytes: number;
	private readonly branch: string;
	private readonly source: () => UpdateSourceId;
	private readonly customHost: () => string;

	constructor(options: PiAiCatalogUpdaterOptions) {
		this.userDataDir = options.userDataDir;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? 15_000;
		this.maxCatalogBytes = options.maxCatalogBytes ?? 16 * 1024 * 1024;
		this.maxManifestBytes = options.maxManifestBytes ?? 64 * 1024;
		this.branch = options.branch ?? CATALOG_UPDATE_DEFAULT_BRANCH;
		this.source = options.source ?? (() => "github");
		this.customHost = options.customHost ?? (() => "");
	}

	/**
	 * 当前源对应的镜像 host：github 官方源返回 null（直连 GitHub raw），
	 * 镜像/自定义返回代理前缀（如 https://ghfast.top），供 sourceBaseUrls 生成
	 * `https://<镜像>/https://raw.githubusercontent.com/...` 形式的代理 URL。
	 */
	private mirrorHost(): string | null {
		const source = this.source();
		if (source === "github") return null;
		if (source === "custom") return normalizeCustomMirrorHost(this.customHost());
		return UPDATE_SOURCE_MIRRORS.find((m) => m.id === source)?.host ?? null;
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
	 * 更新到最新：主源走仓库分支预生成件（直连或经 GitHub 镜像代理，单文件下载，
	 * 国内比 npm 生成路径稳定），分支全挂时回退到 npm latest 生成。
	 * 流程：分支下载 → 校验 → 版本防降级 → 备份当前覆盖 → 原子替换 → 失效索引缓存。
	 * 返回 { ok: true, updated }：updated=false 表示已是最新（未覆盖写）。
	 */
	async update(branch?: string): Promise<CatalogUpdateResult> {
		const branchResult = await this.updateFromBranch(branch ?? this.branch);
		if (branchResult.ok) return branchResult;
		const npmResult = await this.tryUpdateFromNpmLatest();
		if (npmResult) return npmResult;
		// 两个源都失败时，分支源的校验失败（数据被篡改/损坏）比 network 更有诊断价值：
		// 用户需要知道是数据坏了而不是网络不通（UI 有 catalogFailValidation 文案分支）。
		if (branchResult.code === "validation") return branchResult;
		return {
			ok: false,
			code: "network",
			message: "catalog update failed from all sources (branch + npm)",
		};
	}

	/**
	 * 回退源：从 npm latest 生成并写入覆盖层（分支源全挂时的最后手段）。
	 * 返回 null 表示 npm 路径失败（网络/生成校验不过）。
	 */
	private async tryUpdateFromNpmLatest(): Promise<CatalogUpdateResult | null> {
		try {
			const version = await this.resolveNpmLatestVersion();
			if (!version) return null;
			const current = this.getEffectiveVersion();
			// 防降级：npm latest 不高于当前生效版本时，不覆盖（远端分支可能更旧）。
			if (current && compareSemver(version, current) <= 0) {
				return { ok: true, updated: false };
			}
			const files = await this.fetchNpmCatalogDataFiles(version);
			if (files.length === 0) return null;
			const generated = generatePiAiCatalogFromFiles(files, version);
			const entries = parsePiAiCatalogArtifact(generated.catalogText, generated.manifestText);
			// 生成结果本身需通过内置校验（哈希/结构），防止上游数据异常上盘。
			if (entries.length === 0) return null;
			this.writeOverlayAtomically(generated.catalogText, generated.manifestText);
			invalidatePiAiCatalogIndex();
			return { ok: true, updated: true };
		} catch {
			return null;
		}
	}

	/** 回退源：从仓库分支拉取预生成件（双源下载 → 校验 → 版本防降级 → 写入）。 */
	private async updateFromBranch(branch: string): Promise<CatalogUpdateResult> {
		const mirrorHost = this.mirrorHost();
		let pair: { catalogRaw: string; manifestRaw: string };
		try {
			pair = await this.downloadFromAnySource(branch, mirrorHost);
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
		return this.writeWithVersionGuard(
			pair.catalogRaw,
			pair.manifestRaw,
			manifestPackageVersion(pair.manifestRaw),
		);
	}

	/**
	 * 版本防降级写入：新版本不高于当前生效版本（覆盖层优先，否则内置）时跳过写入，
	 * 返回 { ok: true, updated: false }（已是最新，不覆盖）。
	 * 写入失败返回 write 码，成功返回 { ok: true, updated: true }。
	 */
	private writeWithVersionGuard(
		catalogRaw: string,
		manifestRaw: string,
		newVersion: string | null,
	): CatalogUpdateResult {
		const current = this.getEffectiveVersion();
		if (current && newVersion && compareSemver(newVersion, current) <= 0) {
			return { ok: true, updated: false };
		}
		try {
			this.writeOverlayAtomically(catalogRaw, manifestRaw);
		} catch (error) {
			return {
				ok: false,
				code: "write",
				message: `failed to write overlay: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		invalidatePiAiCatalogIndex();
		return { ok: true, updated: true };
	}

	/** 当前生效目录版本（覆盖层优先，否则内置）；无有效目录为 null。 */
	private getEffectiveVersion(): string | null {
		const status = this.getStatus();
		return status.overlay?.packageVersion ?? status.builtin?.packageVersion ?? null;
	}

	/** 解析 npm 包 latest 版本号；所有源失败返回 null（不抛，交由调用方回退）。 */
	private async resolveNpmLatestVersion(): Promise<string | null> {
		for (const url of CATALOG_NPM_LATEST_URLS) {
			try {
				const text = await this.downloadText(url, this.maxManifestBytes);
				const parsed: unknown = JSON.parse(text);
				if (isRecord(parsed)) {
					const version = nonEmptyString(parsed.version);
					if (version) return version;
				}
			} catch {
				// 换下一个镜像源
			}
		}
		return null;
	}

	/**
	 * 从 npm 包枚举并拉取 dist/providers/data/*.json（只取需要的模型规格数据，
	 * 不下载整个 4MB 包）。用 jsDelivr flat 列表枚举文件名，再并行拉各文件。
	 */
	private async fetchNpmCatalogDataFiles(version: string): Promise<CatalogSourceFile[]> {
		const flatUrl = `${CATALOG_JSDELIVR_FLAT_PREFIX}${version}/flat`;
		const flatText = await this.downloadText(flatUrl, this.maxCatalogBytes);
		const flat: unknown = JSON.parse(flatText);
		const files = isRecord(flat) && Array.isArray(flat.files) ? flat.files : [];
		const names = files
			.map((entry) => (isRecord(entry) && typeof entry.name === "string" ? entry.name.replace(/^\//, "") : ""))
			.filter(
				(name) =>
					name.startsWith("dist/providers/data/") &&
					name.endsWith(".json") &&
					!name.endsWith(".manifest.json"),
			);
		if (names.length === 0) return [];
		return Promise.all(
			names.map(async (name) => {
				const content = await this.downloadText(
					`${CATALOG_JSDELIVR_FILE_PREFIX}${version}/${name}`,
					this.maxCatalogBytes,
				);
				return { name: name.slice("dist/providers/data/".length), content };
			}),
		);
	}

	/** 一键还原：当前覆盖版转存为 .bak 并删除覆盖文件，回退到内置目录。 */
	restoreBuiltin(): CatalogUpdateResult {
		if (!existsSync(this.catalogPath()) && !existsSync(this.manifestPath())) {
			// 没有覆盖层：无需操作，视为成功（UI 状态卡片会显示内置生效）
			return { ok: true, updated: false };
		}
		try {
			this.moveOverlayToBackup();
			invalidatePiAiCatalogIndex();
			return { ok: true, updated: true };
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
			return { ok: true, updated: true };
		} catch (error) {
			return {
				ok: false,
				code: "write",
				message: `failed to restore previous overlay: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/**
	 * 检查是否有新版本：主源读仓库分支 manifest（直连或经 GitHub 镜像代理），
	 * 与下载同源，避免「检测说有更新、下载却拿不到」的版本错位；
	 * 分支全不可达时回退到 npm latest。
	 */
	async checkRemote(branch?: string): Promise<CatalogCheckResult> {
		const branchResult = await this.checkRemoteFromBranch(branch ?? this.branch);
		if (branchResult.ok) return branchResult;
		const npmVersion = await this.resolveNpmLatestVersion();
		if (npmVersion) {
			const localVersion = this.getEffectiveVersion();
			const hasUpdate = localVersion ? compareSemver(npmVersion, localVersion) > 0 : true;
			return { ok: true, remoteVersion: npmVersion, localVersion, hasUpdate };
		}
		return branchResult;
	}

	/** 回退：从仓库分支 manifest 解析版本并做语义比较。 */
	private async checkRemoteFromBranch(branch: string): Promise<CatalogCheckResult> {
		const mirrorHost = this.mirrorHost();
		let manifestRaw: string;
		try {
			manifestRaw = await this.downloadManifestFromAnySource(branch, mirrorHost);
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
		const hasUpdate = localVersion ? compareSemver(remoteVersion, localVersion) > 0 : true;
		return { ok: true, remoteVersion, localVersion, hasUpdate };
	}

	/**
	 * 下载一对 artifact（先 manifest 后 catalog），按源列表顺序尝试：
	 * 源内任一文件失败（网络/超时/HTTP 错误/超大小）即换下一个源。
	 * 全部失败抛错，由调用方归为 network。
	 */
	private async downloadFromAnySource(
		branch: string,
		mirrorHost?: string | null,
	): Promise<{ catalogRaw: string; manifestRaw: string }> {
		let lastError: unknown;
		for (const source of sourceBaseUrls(branch, mirrorHost)) {
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
	private async downloadManifestFromAnySource(
		branch: string,
		mirrorHost?: string | null,
	): Promise<string> {
		let lastError: unknown;
		for (const source of sourceBaseUrls(branch, mirrorHost)) {
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
