import { net } from "electron";
import { compareVersions } from "../utils/versionCompare";
import { GITHUB_RELEASES_API } from "./ChannelSwitchService";
import { RELEASES_URL } from "./releaseRepo";
import { selectTargetRelease, toReleaseList } from "./releaseSelection";
import type { UpdateChannel } from "../../shared/types/app";

/** GitHub 的 `/releases/latest` 不走 REST API 配额，最终会重定向到具体 tag 页面。 */
export const MAC_MANUAL_LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;

export type ManualReleaseCheckResult = {
	latestVersion: string;
	hasUpdate: boolean;
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
 * macOS 无签名分发的更新检测器。
 *
 * 不调用 electron-updater：该路径在没有 Developer ID 签名/公证时无法承诺可靠
 * 的下载、替换和重启体验。随后由 UI 打开 Release 页面交给用户手动安装。
 *
 * stable：跟随 `/releases/latest` 的 302，从最终 tag URL 取版本（不打 REST，避开配额）；
 * AtomGit 源的网页 `/releases/latest` 是 SPA 壳，地址不会变成 `/releases/tag/vX.Y.Z`，
 * 必须走 OpenAPI `.../releases/latest` 读 `tag_name`（与 CHANGELOG / 扩展热更新同一原因）。
 * dev：GitHub `/releases/latest` 恒指向最新 **stable** release，dev 的 0.8.0-beta.*
 * 永不出现在那里 —— 必须拉 releases 全量列表并按 prerelease 过滤取最新
 * （复用任务 6 的 selectTargetRelease；镜像源无 prerelease feed，dev 不适用）。
 */
export function createMacManualUpdateChecker(options?: {
	fetchLatestRelease?: LatestReleaseFetcher;
	/** 更新通道（装配注入）；dev 走 releases 列表选 prerelease，stable 照旧 /latest。 */
	channel?: UpdateChannel;
	/** dev 通道的 releases 列表拉取（测试桩注入；真实实现走 GitHub API）。 */
	fetchReleases?: ReleasesListFetcher;
	/** 平台/架构（测试注入；默认当前进程，用于资产名匹配）。 */
	platform?: NodeJS.Platform;
	arch?: string;
}): (currentVersion: string, latestReleaseUrl?: string) => Promise<ManualReleaseCheckResult> {
	const channel: UpdateChannel = options?.channel ?? "stable";
	const platform = options?.platform ?? process.platform;
	const arch = options?.arch ?? process.arch;
	const fetchLatestRelease =
		options?.fetchLatestRelease ??
		(async (url: string): Promise<LatestReleaseResponse> => {
			const response = await net.fetch(url, { redirect: "follow" });
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

	return async (currentVersion: string, latestReleaseUrl?: string): Promise<ManualReleaseCheckResult> => {
		if (channel === "dev") {
			// dev 从 releases 全量列表选最新可安装 prerelease；不依赖 /latest 302（它恒指 stable）。
			const response = await fetchReleases(GITHUB_RELEASES_API);
			if (!response.ok) {
				throw new Error(`Dev prerelease list request failed (${response.status}).`);
			}
			const release = selectTargetRelease(toReleaseList(response.body ? JSON.parse(response.body) : []), "dev", platform, arch);
			if (!release) {
				throw new Error("Dev channel has no installable prerelease release.");
			}
			return { latestVersion: release.version, hasUpdate: compareVersions(release.version, currentVersion) > 0 };
		}
		const response = await fetchLatestRelease(latestReleaseUrl ?? MAC_MANUAL_LATEST_RELEASE_URL);
		if (!response.ok) {
			throw new Error(`Latest release request failed (${response.status}).`);
		}
		const latestVersion = resolveLatestReleaseVersion(response);
		if (!latestVersion) {
			throw new Error("Latest release response did not resolve to a release tag.");
		}
		return {
			latestVersion,
			hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
		};
	};
}
