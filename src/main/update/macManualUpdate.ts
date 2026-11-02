import { net } from "electron";
import { compareVersions, normalizeVersion } from "../utils/versionCompare";
import { GITHUB_RELEASES_API } from "./ChannelSwitchService";
import { RELEASES_URL, UPDATE_REPO, UPDATE_REPO_OWNER } from "./releaseRepo";
import { selectNewestRelease, toManualUpdateRelease, type ManualUpdateTarget, resolveManualUpdateTarget } from "./manualUpdateSelection";
import { toReleaseList } from "./releaseSelection";
import type { GithubReleaseLike } from "./releaseSelection";
import type { AppManualUpdateRelease, UpdateChannel } from "../../shared/types/app";
import type { UpdateSourceId } from "../../shared/types/settings";

/** GitHub 的 `/releases/latest` 不走 REST API 配额，最终会重定向到具体 tag 页面。 */
export const MAC_MANUAL_LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;

/** 需要资产列表时走 REST latest（一次请求拿 tag + assets）；失败不影响版本检测。 */
export const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases/latest`;

export type ManualReleaseCheckResult = {
	latestVersion: string;
	hasUpdate: boolean;
	/** 按当前设备匹配到的安装包；无资产/未匹配/资产查询失败时为 null，UI 退化到发布页。 */
	recommendedDownload?: AppManualUpdateRelease | null;
};

export type LatestReleaseResponse = {
	ok: boolean;
	status: number;
	url: string;
	/** OpenAPI JSON 正文。GitHub HTML 重定向路径不需要 body。 */
	body?: string;
};

type LatestReleaseFetcher = (url: string) => Promise<LatestReleaseResponse>;

/** GitHub Releases API 列表响应（body 为 releases JSON 文本）。 */
export type ReleasesListResponse = {
	ok: boolean;
	status: number;
	body?: string;
};

type ReleasesListFetcher = (url: string) => Promise<ReleasesListResponse>;

/**
 * 从 GitHub latest release 重定向 URL 提取发布版本。
 * URL 例：`https://github.com/ayuayue/PiDeck/releases/tag/v0.7.4`。
 * AtomGit 网页 `/releases/latest` 不会 302 到这种路径，返回 null。
 */
export function parseGitHubReleaseVersion(url: string): string | null {
	try {
		const pathname = new URL(url).pathname;
		const match = pathname.match(/\/releases\/tag\/v?([^/?#]+)$/i);
		return match?.[1] ? decodeURIComponent(match[1]) : null;
	} catch {
		return null;
	}
}

/**
 * AtomGit / GitHub REST 的 latest release JSON：版本写在 `tag_name`。
 * 例：`{"tag_name":"v0.7.6"}` → `"0.7.6"`。
 */
export function parseLatestReleaseTagFromJson(body: string): string | null {
	try {
		const payload: unknown = JSON.parse(body);
		if (typeof payload !== "object" || payload === null || !("tag_name" in payload)) {
			return null;
		}
		const tag = payload.tag_name;
		if (typeof tag !== "string") return null;
		const trimmed = tag.trim();
		if (!trimmed) return null;
		return trimmed.replace(/^v/i, "");
	} catch {
		return null;
	}
}

/** latest release JSON → release 形状（保留 assets 供推荐安装包选择）；非法 JSON 返回 null。 */
export function parseLatestReleaseJson(body: string): GithubReleaseLike | null {
	try {
		const payload: unknown = JSON.parse(body);
		if (!isRecord(payload)) return null;
		if (typeof payload.tag_name !== "string" || payload.tag_name.trim() === "") return null;
		const rawAssets = Array.isArray(payload.assets) ? payload.assets : [];
		const assets: GithubReleaseLike["assets"] = [];
		for (const rawAsset of rawAssets) {
			if (!isRecord(rawAsset)) continue;
			assets.push({
				...(typeof rawAsset.name === "string" ? { name: rawAsset.name } : {}),
				...(typeof rawAsset.browser_download_url === "string" ? { browser_download_url: rawAsset.browser_download_url } : {}),
				...(typeof rawAsset.digest === "string" ? { digest: rawAsset.digest } : {}),
				...(typeof rawAsset.size === "number" ? { size: rawAsset.size } : {}),
			});
		}
		return {
			tag_name: payload.tag_name,
			...(typeof payload.prerelease === "boolean" ? { prerelease: payload.prerelease } : {}),
			...(typeof payload.body === "string" ? { body: payload.body } : {}),
			...(typeof payload.html_url === "string" ? { html_url: payload.html_url } : {}),
			assets,
		};
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** 任意错误 → 可读消息（跨 realm 的错误不满足 instanceof，仍优先保留 message）。 */
function toErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (isRecord(error) && typeof error.message === "string") return error.message;
	return String(error);
}

/** 优先从 GitHub 风格的最终 URL 取版本；取不到再读 JSON 的 tag_name（AtomGit OpenAPI）。 */
export function resolveLatestReleaseVersion(response: Pick<LatestReleaseResponse, "url" | "body">): string | null {
	return parseGitHubReleaseVersion(response.url) ?? (response.body ? parseLatestReleaseTagFromJson(response.body) : null);
}

/**
 * 默认 fetcher 是否该读响应正文。
 * GitHub HTML 只要最终 URL；AtomGit OpenAPI 的版本号在 JSON 里。
 */
export function shouldReadJsonBody(url: string, contentType: string): boolean {
	if (/\bjson\b/i.test(contentType)) return true;
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === "api.atomgit.com" || host === "api.github.com";
	} catch {
		return false;
	}
}

/**
 * 手动交付更新检查器（macOS 无签名 / Linux arm64 / deb / tar.gz 共用）。
 *
 * 不调用 electron-updater：这些组合没有可靠的应用内下载+替换链路。检查结果同时
 * 带上按当前设备匹配的推荐安装包（GitHub/AtomGit Release 资产），UI 据此一键下载。
 *
 * stable：跟随 `/releases/latest` 的 302，从最终 tag URL 取版本（不打 REST，避开配额）；
 * 发现新版本时再取一次资产（GitHub 走 REST latest，AtomGit 的 OpenAPI 正文已含 assets）。
 * AtomGit 源的网页 `/releases/latest` 是 SPA 壳，地址不会变成 `/releases/tag/vX.Y.Z`，
 * 必须走 OpenAPI `.../releases/latest` 读 `tag_name`（与 CHANGELOG / 扩展热更新同一原因）。
 * Electron 的 net.fetch() 不保证回填重定向后的 response.url：GitHub 的 HTML 302 拿不到
 * tag 时改用 REST latest 的 `tag_name` 兜底，不能因为 URL 为空就整次检查失败。
 * 镜像源返回 429/5xx/SPA 壳时退回官方 GitHub 再查一次（更新源是优先级，不是硬失败）。
 * dev：GitHub `/releases/latest` 恒指向最新 **stable** release，dev 的 0.8.0-beta.*
 * 永不出现在那里 —— 官方源必须拉 releases 全量列表并按 prerelease 过滤取最新；
 * 镜像源没有 prerelease feed，按镜像 latest 检查（与 stable 同一路径）。
 */
export function createManualUpdateChecker(options?: {
	fetchLatestRelease?: LatestReleaseFetcher;
	/** 更新通道（装配注入）；dev + 官方源走 releases 列表选 prerelease，其余照旧 /latest。 */
	channel?: UpdateChannel;
	/** dev + 官方源时的 releases 列表拉取（测试桩注入；真实实现走 GitHub API）。 */
	fetchReleases?: ReleasesListFetcher;
	/** 平台/架构（测试注入；默认当前进程，用于资产名匹配）。 */
	platform?: NodeJS.Platform;
	arch?: string;
	/** 显式推荐目标（装配层按 PORTABLE_EXECUTABLE_DIR / APPIMAGE / Rosetta 判定后传入）。 */
	target?: ManualUpdateTarget | null;
	isPortable?: boolean;
	isAppImage?: boolean;
	execPath?: string;
	runningUnderArm64Translation?: boolean;
}): (currentVersion: string, latestReleaseUrl?: string) => Promise<ManualReleaseCheckResult> {
	const channel: UpdateChannel = options?.channel ?? "stable";
	const platform = options?.platform ?? process.platform;
	const arch = options?.arch ?? process.arch;
	const target =
		options?.target !== undefined
			? options.target
			: resolveManualUpdateTarget({
					platform,
					arch,
					isPortable: options?.isPortable,
					isAppImage: options?.isAppImage,
					execPath: options?.execPath,
					runningUnderArm64Translation: options?.runningUnderArm64Translation,
				});
	const fetchLatestRelease =
		options?.fetchLatestRelease ??
		(async (url: string): Promise<LatestReleaseResponse> => {
			// GitHub REST 无 User-Agent 会直接 403；Accept 指明 JSON 表示。
			const headers: Record<string, string> = { "User-Agent": "PiDeck-UpdateService" };
			try {
				if (new URL(url).hostname.toLowerCase() === "api.github.com") headers.Accept = "application/vnd.github+json";
			} catch {
				// URL 非法交给 net.fetch 报错；这里不阻断。
			}
			const response = await net.fetch(url, { redirect: "follow", headers });
			const contentType = response.headers.get("content-type") ?? "";
			const body = shouldReadJsonBody(response.url || url, contentType) ? await response.text() : undefined;
			return { ok: response.ok, status: response.status, url: response.url, body };
		});
	const fetchReleases =
		options?.fetchReleases ??
		(async (url: string): Promise<ReleasesListResponse> => {
			// GitHub API 要求显式 User-Agent；Accept 指明可接受的 JSON 表示。
			const response = await net.fetch(url, { headers: { "User-Agent": "PiDeck-UpdateService", Accept: "application/vnd.github+json" } });
			return { ok: response.ok, status: response.status, body: await response.text() };
		});

	/** 资产查询失败只失去推荐入口，不能把「有更新」变成检查失败（版本检测已成功）。 */
	const tryResolveRecommended = (release: GithubReleaseLike | null, source: UpdateSourceId): AppManualUpdateRelease | null => {
		if (!release || !target) return null;
		try {
			return toManualUpdateRelease(release, target, source);
		} catch {
			return null;
		}
	};

	const readLatestReleaseVersion = (release: GithubReleaseLike | null): string | null => {
		if (!release || typeof release.tag_name !== "string") return null;
		const version = normalizeVersion(release.tag_name);
		return version === "" ? null : version;
	};

	/** dev + 官方源的检查路径：拉 releases 全量列表选最新 prerelease（/latest 恒指 stable）。 */
	const checkGithubPrereleases = async (currentVersion: string): Promise<ManualReleaseCheckResult> => {
		const response = await fetchReleases(GITHUB_RELEASES_API);
		if (!response.ok) {
			throw new Error(`Dev prerelease list request failed (${response.status}).`);
		}
		let releases: GithubReleaseLike[];
		try {
			releases = toReleaseList(response.body ? JSON.parse(response.body) : []);
		} catch {
			throw new Error("Dev prerelease list response was not valid JSON.");
		}
		const newest = selectNewestRelease(releases, "dev");
		const latestVersion = readLatestReleaseVersion(newest);
		if (!latestVersion) {
			throw new Error("Dev channel has no prerelease release.");
		}
		return {
			latestVersion,
			hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
			recommendedDownload: tryResolveRecommended(newest, "github"),
		};
	};

	return async (currentVersion: string, latestReleaseUrl?: string): Promise<ManualReleaseCheckResult> => {
		// dev 通道只有官方 GitHub 源需要拉 releases 全量列表选 prerelease；镜像源没有预发布
		// 产物，按镜像 latest 检查（与 stable 同一路径），避免 dev 用户选镜像后检查直接失败。
		if (channel === "dev" && !latestReleaseUrl) {
			return checkGithubPrereleases(currentVersion);
		}

		let source: UpdateSourceId = latestReleaseUrl ? "atomgit" : "github";
		let response: LatestReleaseResponse | null = null;
		let fetchError: unknown = null;
		try {
			response = await fetchLatestRelease(latestReleaseUrl ?? MAC_MANUAL_LATEST_RELEASE_URL);
		} catch (error) {
			fetchError = error;
		}
		let latestVersion = response?.ok ? resolveLatestReleaseVersion(response) : null;
		// 镜像失败时保留原因，最终错误里同时带上两条链路的状态。
		const mirrorFailed = Boolean(latestReleaseUrl) && (!response || !response.ok || !latestVersion);
		const mirrorFailure = mirrorFailed ? (response && !response.ok ? `HTTP ${response.status}` : fetchError ? toErrorMessage(fetchError) : "unresolved response") : null;

		// 镜像不可用（429 限流 / 5xx / 网络失败 / SPA 壳）时退回官方 GitHub 再查一次：
		// 更新源是「优先走哪条路」而不是硬失败，镜像挂掉不该让用户彻底看不到新版本。
		if (source === "atomgit" && mirrorFailed) {
			// dev 的镜像没有预发布产物；镜像不可用时优先回到 GitHub 的 prerelease 列表，
			// 保持 dev 通道语义，而不是退化成 stable /latest。
			if (channel === "dev") return checkGithubPrereleases(currentVersion);
			source = "github";
			response = null;
			fetchError = null;
			try {
				response = await fetchLatestRelease(MAC_MANUAL_LATEST_RELEASE_URL);
			} catch (error) {
				fetchError = error;
			}
			latestVersion = response?.ok ? resolveLatestReleaseVersion(response) : null;
		}

		let release = response?.body ? parseLatestReleaseJson(response.body) : null;
		// Electron 43 的 net.fetch() 不保证回填重定向后的 response.url：GitHub 的 /latest
		// 是 HTML 302，拿不到 tag URL 时改读 REST latest 的 tag_name（正文同时带 assets，
		// 后续推荐安装包无需再请求一次）。国内直连 GitHub HTML 超时也走这条兜底。
		let releaseApiTried = false;
		let apiFailure: string | null = null;
		if (!latestVersion && source === "github") {
			releaseApiTried = true;
			try {
				const apiResponse = await fetchLatestRelease(GITHUB_LATEST_RELEASE_API);
				if (apiResponse.ok && apiResponse.body) {
					release = parseLatestReleaseJson(apiResponse.body);
					latestVersion = readLatestReleaseVersion(release);
				} else if (!apiResponse.ok) {
					apiFailure = `HTTP ${apiResponse.status}`;
				}
			} catch (error) {
				apiFailure = toErrorMessage(error);
			}
		}
		if (!latestVersion) {
			const githubFailure = apiFailure ?? (response && !response.ok ? `HTTP ${response.status}` : fetchError ? toErrorMessage(fetchError) : "unresolved response");
			const detail = mirrorFailure ? ` (mirror: ${mirrorFailure}; GitHub: ${githubFailure})` : ` (${githubFailure})`;
			throw new Error(`Latest release response did not resolve to a release tag.${detail}`);
		}
		let hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
		if (!hasUpdate || !target) {
			return { latestVersion, hasUpdate, recommendedDownload: null };
		}

		// AtomGit 的 OpenAPI latest 正文里已经带 assets；GitHub 的 /latest 是 HTML 重定向，
		// 只有发现新版本时才补一次 REST latest（避免每次检查都吃 API 配额）。
		const embeddedVersion = readLatestReleaseVersion(release);
		if (embeddedVersion && compareVersions(embeddedVersion, latestVersion) >= 0) {
			latestVersion = embeddedVersion;
			hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
		} else if (embeddedVersion) {
			// 正文比重定向版本旧（发布切换瞬间）：不用它做推荐，避免推荐低版本。
			release = null;
		}
		if (!release && source === "github" && !releaseApiTried) {
			try {
				const assetResponse = await fetchLatestRelease(GITHUB_LATEST_RELEASE_API);
				if (assetResponse.ok && assetResponse.body) {
					const assetRelease = parseLatestReleaseJson(assetResponse.body);
					const assetVersion = readLatestReleaseVersion(assetRelease);
					if (assetRelease && assetVersion && compareVersions(assetVersion, latestVersion) >= 0) {
						release = assetRelease;
						latestVersion = assetVersion;
						hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
					}
				}
			} catch {
				// 推荐资产是增强项：REST 限流/断网时保留版本检查结果。
			}
		}
		return {
			latestVersion,
			hasUpdate,
			recommendedDownload: hasUpdate ? tryResolveRecommended(release, source) : null,
		};
	};
}

/** 兼容旧导出名（历史代码与测试均从 macManualUpdate 引入）。 */
export const createMacManualUpdateChecker = createManualUpdateChecker;
