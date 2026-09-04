import { net } from "electron";
import { compareVersions } from "../utils/versionCompare";
import { RELEASES_URL } from "./releaseRepo";

/** GitHub 的 `/releases/latest` 不走 REST API 配额，最终会重定向到具体 tag 页面。 */
export const MAC_MANUAL_LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;

export type ManualReleaseCheckResult = {
	latestVersion: string;
	hasUpdate: boolean;
};

type LatestReleaseResponse = {
	ok: boolean;
	status: number;
	url: string;
};

type LatestReleaseFetcher = (url: string) => Promise<LatestReleaseResponse>;

/**
 * 从 GitHub latest release 重定向 URL 提取发布版本。
 * URL 例：`https://github.com/ayuayue/PiDeck/releases/tag/v0.7.4`。
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
 * macOS 无签名分发的更新检测器。
 *
 * 不调用 electron-updater：该路径在没有 Developer ID 签名/公证时无法承诺可靠
 * 的下载、替换和重启体验。这里只做 GitHub 静态重定向检测，随后由 UI 打开
 * Release 页面交给用户手动安装，避免 GitHub REST API 共享限流。
 */
export function createMacManualUpdateChecker(options?: {
	fetchLatestRelease?: LatestReleaseFetcher;
}): (currentVersion: string) => Promise<ManualReleaseCheckResult> {
	const fetchLatestRelease =
		options?.fetchLatestRelease ??
		(async (url: string): Promise<LatestReleaseResponse> => {
			const response = await net.fetch(url, { redirect: "follow" });
			return { ok: response.ok, status: response.status, url: response.url };
		});

	return async (currentVersion: string): Promise<ManualReleaseCheckResult> => {
		const response = await fetchLatestRelease(MAC_MANUAL_LATEST_RELEASE_URL);
		if (!response.ok) {
			throw new Error(`GitHub latest release request failed (${response.status}).`);
		}
		const latestVersion = parseGitHubReleaseVersion(response.url);
		if (!latestVersion) {
			throw new Error("GitHub latest release response did not resolve to a release tag.");
		}
		return {
			latestVersion,
			hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
		};
	};
}
