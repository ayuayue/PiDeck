/**
 * 手动更新交付的「设备 → 推荐安装包」纯规则。
 *
 * 背景：macOS（无 Developer ID）、Linux arm64、Linux deb/tar.gz 无法可靠地走
 * electron-updater 应用内更新。此前 UI 直接把用户丢到 Release 页，十几项资产里
 * 分不清 dmg/zip/AppImage/deb、x64/arm64，装错架构还会全程跑 Rosetta。
 *
 * 本模块只做纯函数判定（无 electron/network/fs）：
 * 1. resolveManualUpdateTarget：把平台/架构/安装形态归一成推荐目标；
 * 2. classifyInstallerAsset：从资产名识别平台 + 架构 + 格式（排除 blockmap/yml/source）；
 * 3. selectRecommendedAsset：按「保持当前安装形态」的优先级挑一个包；
 * 4. toManualUpdateRelease：把 GitHub/AtomGit release JSON 归一成快照形状。
 *
 * 资产命名事实来源：package.json 的 artifactName（mac `${productName}-${version}-${arch}.${ext}`、
 * Linux AppImage `PiDeck-${arch}.AppImage`、deb `PiDeck_${version}_${arch}.deb`、Windows
 * `PiDeck-${version}-setup.exe` / `-portable.exe`）。测试用真实 v0.9.1 资产名做契约。
 */

import type { AppManualUpdateAssetKind, AppManualUpdateRelease, UpdateChannel } from "../../shared/types/app";
import type { UpdateSourceId } from "../../shared/types/settings";
import { ATOMGIT_HOST, UPDATE_REPO, UPDATE_REPO_OWNER, gitHubReleasesBase } from "../../shared/updateSources";
import { compareVersions, normalizeVersion } from "../utils/versionCompare";
import type { GithubReleaseLike } from "./releaseSelection";

export type ManualUpdatePlatform = "darwin" | "win32" | "linux";
export type ManualUpdateInstallKind = "installed" | "portable" | "appimage" | "deb";

/** 归一后的设备推荐目标（arch 是「应该安装」的架构，不是 process.arch 的机械复制）。 */
export type ManualUpdateTarget = {
	platform: ManualUpdatePlatform;
	arch: "x64" | "arm64";
	/** 当前安装形态：决定优先推荐 dmg/安装版/portable/AppImage/deb。 */
	installKind: ManualUpdateInstallKind;
	/** macOS Rosetta：当前 x64 进程应换装原生 arm64 包。 */
	translated: boolean;
};

export type ManualUpdateTargetInput = {
	platform: NodeJS.Platform;
	arch: string;
	/** Windows 便携版（electron-builder 注入 PORTABLE_EXECUTABLE_DIR）。 */
	isPortable?: boolean;
	/** Linux AppImage（electron-builder 注入 APPIMAGE）。 */
	isAppImage?: boolean;
	/** Linux 可执行文件路径：/opt/PiDeck 下视为 deb 安装（保守猜测）。 */
	execPath?: string;
	/** macOS Apple Silicon 上的 x64 进程（Rosetta 2）。 */
	runningUnderArm64Translation?: boolean;
};

/**
 * 解析设备推荐目标。返回 null 表示没有可靠的推荐（UI 退化到发布页）。
 *
 * Windows 只发 x64 安装包：ARM64 Windows 上也推荐 x64（系统模拟可运行），
 * 不推荐不存在的 arm64 资产。macOS 历史 x64 包可能没有 `-x64` 后缀，按 x64 处理。
 */
export function resolveManualUpdateTarget(input: ManualUpdateTargetInput): ManualUpdateTarget | null {
	if (input.platform === "darwin") {
		const translated = input.runningUnderArm64Translation === true;
		const arch = translated || input.arch === "arm64" ? "arm64" : "x64";
		return { platform: "darwin", arch, installKind: "installed", translated };
	}
	if (input.platform === "win32") {
		return { platform: "win32", arch: "x64", installKind: input.isPortable ? "portable" : "installed", translated: false };
	}
	if (input.platform === "linux") {
		const arch = input.arch === "arm64" || input.arch === "aarch64" ? "arm64" : input.arch === "x64" || input.arch === "x86_64" ? "x64" : null;
		if (!arch) return null;
		const installKind: ManualUpdateInstallKind = input.isAppImage ? "appimage" : looksLikeDebInstall(input.execPath) ? "deb" : "appimage";
		return { platform: "linux", arch, installKind, translated: false };
	}
	return null;
}

/**
 * 是否 deb 安装。electron-builder 的 .deb 默认装到 /opt/PiDeck（可执行文件 pideck）；
 * 解压 tar.gz 到同样路径会被误判，但推荐的 .deb 仍可安装，属于可接受的保守猜测。
 */
export function looksLikeDebInstall(execPath: string | undefined): boolean {
	if (typeof execPath !== "string" || execPath === "") return false;
	const normalized = execPath.replace(/\\/g, "/").toLowerCase();
	return /^\/opt\/pideck\//.test(normalized) || /^\/usr\/lib\/pideck\//.test(normalized);
}

export type ClassifiedInstallerAsset = {
	platform: ManualUpdatePlatform;
	arch: "x64" | "arm64";
	kind: AppManualUpdateAssetKind;
};

/** 资产名里的架构 token；x64 在 mac 历史资产中可省略。 */
function detectAssetArch(lowerName: string, platform: ManualUpdatePlatform): "x64" | "arm64" | null {
	if (/(?:^|[-_.])(arm64|aarch64)(?:[-_.]|$)/.test(lowerName)) return "arm64";
	if (platform === "win32") return "x64";
	if (/(?:^|[-_.])(x64|x86_64|amd64)(?:[-_.]|$)/.test(lowerName)) return "x64";
	return platform === "darwin" ? "x64" : null;
}

/**
 * 从资产名识别安装包。返回 null 表示不是可下载的桌面安装包：
 * 排除 blockmap / latest*.yml / source zip/tar.gz / dsh-runtime / node 运行时等。
 */
export function classifyInstallerAsset(name: string, platform: ManualUpdatePlatform): ClassifiedInstallerAsset | null {
	if (typeof name !== "string") return null;
	const lower = name.trim().toLowerCase();
	if (!lower) return null;
	if (lower.endsWith(".blockmap") || lower.endsWith(".yml") || lower.endsWith(".yaml") || lower.endsWith(".json") || lower.endsWith(".sha256") || lower.endsWith(".sig")) {
		return null;
	}
	// AtomGit 把源码归档也放进 assets（type=source，名字是 v0.9.1.zip / v0.9.1.tar.gz），
	// mac 的 x64 历史资产允许无架构后缀，若不先排除会被误当成安装包。
	if (/^v?\d+\.\d+\.\d+(?:[-+].*)?\.(?:zip|tar\.gz|tgz)$/.test(lower)) return null;
	if (lower.startsWith("dsh-") || lower.startsWith("node-v")) return null;
	const arch = detectAssetArch(lower, platform);
	if (!arch) return null;

	if (platform === "win32") {
		if (lower.endsWith(".exe")) {
			if (lower.includes("setup") || lower.includes("installer")) return { platform, arch, kind: "nsis" };
			if (lower.includes("portable")) return { platform, arch, kind: "portable" };
			return null;
		}
		return lower.endsWith(".zip") ? { platform, arch, kind: "zip" } : null;
	}

	if (platform === "darwin") {
		const kind: AppManualUpdateAssetKind | null = lower.endsWith(".dmg") ? "dmg" : lower.endsWith(".zip") ? "zip" : null;
		if (!kind) return null;
		return { platform, arch, kind };
	}

	const kind: AppManualUpdateAssetKind | null = lower.endsWith(".appimage") ? "appimage" : lower.endsWith(".deb") ? "deb" : lower.endsWith(".tar.gz") || lower.endsWith(".tgz") ? "tar.gz" : null;
	if (!kind) return null;
	// Linux 的 detectAssetArch 没有 x64 兜底：arm64 资产必须显式带 arm64/aarch64，
	// 不会把无架构后缀的包误判成当前架构。
	return { platform, arch, kind };
}

/** 推荐优先级：先保持当前安装形态，再退到可直接运行的格式。 */
export function preferredAssetKinds(target: ManualUpdateTarget): AppManualUpdateAssetKind[] {
	if (target.platform === "darwin") return ["dmg", "zip"];
	if (target.platform === "win32") return target.installKind === "portable" ? ["portable", "zip", "nsis"] : ["nsis", "zip", "portable"];
	return target.installKind === "deb" ? ["deb", "appimage", "tar.gz"] : ["appimage", "deb", "tar.gz"];
}

export type RecommendedInstallerAsset = {
	name: string;
	url: string;
	digestSha256?: string;
	size?: number;
	kind: AppManualUpdateAssetKind;
	arch: "x64" | "arm64";
};

function isHttpsUrl(value: unknown): value is string {
	return typeof value === "string" && /^https:\/\//i.test(value);
}

/** 从 release.assets 里挑设备最合适的安装包；跳过非 https / 非安装包资产。 */
export function selectRecommendedAsset(assets: Array<Pick<{ name?: string; browser_download_url?: string; digest?: string; size?: number }, "name" | "browser_download_url" | "digest" | "size">>, target: ManualUpdateTarget): RecommendedInstallerAsset | null {
	const candidates: RecommendedInstallerAsset[] = [];
	for (const asset of assets) {
		if (typeof asset.name !== "string" || !isHttpsUrl(asset.browser_download_url)) continue;
		const classified = classifyInstallerAsset(asset.name, target.platform);
		if (!classified || classified.arch !== target.arch) continue;
		candidates.push({
			name: asset.name,
			url: asset.browser_download_url,
			...(typeof asset.digest === "string" && asset.digest.trim() !== "" ? { digestSha256: asset.digest } : {}),
			...(typeof asset.size === "number" && Number.isFinite(asset.size) && asset.size > 0 ? { size: asset.size } : {}),
			kind: classified.kind,
			arch: classified.arch,
		});
	}
	for (const kind of preferredAssetKinds(target)) {
		const match = candidates.find((candidate) => candidate.kind === kind);
		if (match) return match;
	}
	return null;
}

/** 由 GitHub/AtomGit release JSON 构造推荐安装包；无匹配资产返回 null。 */
export function toManualUpdateRelease(release: GithubReleaseLike, target: ManualUpdateTarget, source: UpdateSourceId): AppManualUpdateRelease | null {
	const tagName = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
	if (!tagName) return null;
	const version = normalizeVersion(tagName);
	if (!version) return null;
	const asset = selectRecommendedAsset(Array.isArray(release.assets) ? release.assets : [], target);
	if (!asset) return null;
	return {
		version,
		assetName: asset.name,
		assetUrl: asset.url,
		...(asset.size !== undefined ? { assetSize: asset.size } : {}),
		...(asset.digestSha256 !== undefined ? { digestSha256: asset.digestSha256 } : {}),
		kind: asset.kind,
		platform: target.platform,
		arch: target.arch,
		...(target.translated ? { translated: true } : {}),
		releasePageUrl: resolveReleasePageUrl(release.html_url, source, tagName),
	};
}

/** 发布页兜底：优先用 API 的 html_url；AtomGit 不返回 html_url，按 tag 拼。 */
export function resolveReleasePageUrl(htmlUrl: string | undefined, source: UpdateSourceId, tagName: string): string {
	if (isHttpsUrl(htmlUrl)) return htmlUrl;
	const base = source === "atomgit" ? `${ATOMGIT_HOST}/${UPDATE_REPO_OWNER}/${UPDATE_REPO}` : gitHubReleasesBase();
	return tagName ? `${base}/releases/tag/${encodeURIComponent(tagName)}` : `${base}/releases`;
}

/** 目标通道最新的 release（不要求有本机资产；无匹配时 UI 退化到发布页）。 */
export function selectNewestRelease(releases: GithubReleaseLike[], channel: UpdateChannel): GithubReleaseLike | null {
	const wantPrerelease = channel === "dev";
	const candidates = releases.filter((release) => typeof release.tag_name === "string" && release.tag_name.trim() !== "" && Boolean(release.prerelease) === wantPrerelease).sort((left, right) => compareVersions(normalizeVersion(right.tag_name ?? ""), normalizeVersion(left.tag_name ?? "")));
	return candidates[0] ?? null;
}
