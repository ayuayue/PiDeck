// src/main/update/releaseSelection.ts —— ChannelSwitchService 与 macManualUpdate(dev) 共用的发布选择纯函数。
// 纯函数无 electron 依赖：输入 GitHub Releases API 形状的数据 + 平台参数，输出归一化的 TargetChannelRelease。
// 任务 7 的 mac 手动更新（UpdateService dev 路径）复用同一选择逻辑，避免两处资产匹配规则漂移。

import type { TargetChannelRelease, UpdateChannel } from "../../shared/types/app";
import { compareVersions, normalizeVersion } from "../utils/versionCompare";
import { RELEASES_URL } from "./releaseRepo";

/** GitHub Releases API 的 release 形状（仅声明本功能消费的字段，其余忽略）。 */
export interface GithubReleaseLike {
	tag_name?: string;
	prerelease?: boolean;
	body?: string;
	html_url?: string;
	assets?: Array<{ name?: string; browser_download_url?: string; digest?: string; size?: number }>;
}

/** notes 摘要截断长度（规格 §3：切换向导只展示短摘要，全文走发布页）。 */
const NOTES_EXCERPT_MAX_LENGTH = 300;

/**
 * 查询目标 = 反向通道：dev 构建切到 stable 正式版，stable 构建切到 dev 预发布。
 * （通道在编译期固定，切换即安装另一条通道的发行物，规格 §3。）
 */
export function inverseChannel(channel: UpdateChannel): UpdateChannel {
	return channel === "dev" ? "stable" : "dev";
}

/**
 * 平台资产匹配（沿用 scripts/atomgit-asset-selection.mjs 的模式过滤思路，独立小实现，不 import AtomGit 域）：
 * win x64 → NSIS Setup `.exe`（排除 portable/zip）；mac arm64/x64 → `.dmg`；
 * linux x64 → `.AppImage`（排除 arm64 命名）。其余平台组合无发行资产。
 */
function assetMatchesPlatform(name: string, platform: NodeJS.Platform, arch: string): boolean {
	const lower = name.toLowerCase();
	if (platform === "win32") {
		return arch === "x64" && lower.endsWith(".exe") && lower.includes("setup");
	}
	if (platform === "darwin") {
		if (!lower.endsWith(".dmg")) return false;
		// mac x64 资产命名历史上既有 -x64 也有无后缀，arm64 必带 -arm64：按「排除 arm64」判定 x64。
		return arch === "arm64" ? lower.includes("arm64") : !lower.includes("arm64");
	}
	if (platform === "linux") {
		return arch === "x64" && lower.endsWith(".appimage") && !lower.includes("arm64");
	}
	return false;
}

/** 网络来的数据不可信：只保留对象元素（字段全可选，逐字段访问前各自校验）。 */
function toReleaseList(value: unknown): GithubReleaseLike[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is GithubReleaseLike => typeof item === "object" && item !== null);
}

/** notes 截断 300 字符摘要；截断时补省略号示意未完。 */
function excerptNotes(body: string | undefined): string {
	const trimmed = typeof body === "string" ? body.trim() : "";
	if (trimmed.length <= NOTES_EXCERPT_MAX_LENGTH) return trimmed;
	return `${trimmed.slice(0, NOTES_EXCERPT_MAX_LENGTH)}…`;
}

/**
 * 从 GitHub releases 列表选出目标通道的最新可安装发布。
 * 选择规则：prerelease 布尔按目标通道过滤（stable=正式 / dev=预发布）→ tag_name 去 v 前缀后
 * compareVersions 取最新 → 依次取第一个带平台匹配资产的 release（最新无资产时回退更旧的可安装版本）。
 * 无匹配返回 null（由调用方转结构化错误，签名与账本扫描 #10 一致）。
 */
export function selectTargetRelease(releases: GithubReleaseLike[], target: UpdateChannel, platform: NodeJS.Platform, arch: string): TargetChannelRelease | null {
	if (!Array.isArray(releases)) return null;
	const wantPrerelease = target === "dev";
	const candidates = releases.filter((release) => typeof release.tag_name === "string" && release.tag_name.trim() !== "" && Boolean(release.prerelease) === wantPrerelease).sort((left, right) => compareVersions(normalizeVersion(right.tag_name ?? ""), normalizeVersion(left.tag_name ?? "")));
	for (const release of candidates) {
		const asset = (release.assets ?? []).find((item) => typeof item.name === "string" && item.name !== "" && typeof item.browser_download_url === "string" && item.browser_download_url !== "" && assetMatchesPlatform(item.name, platform, arch));
		if (!asset) continue;
		return {
			version: normalizeVersion(release.tag_name ?? ""),
			notesExcerpt: excerptNotes(release.body),
			assetUrl: asset.browser_download_url ?? "",
			assetName: asset.name ?? "",
			// digest 形如 "sha256:hex"（GitHub API 可选字段）：存在则透传，缺失则 undefined（下载后跳过校验并 appLogger 记录）。
			digestSha256: typeof asset.digest === "string" && asset.digest.trim() !== "" ? asset.digest : undefined,
			releasePageUrl: typeof release.html_url === "string" && release.html_url !== "" ? release.html_url : RELEASES_URL,
		};
	}
	return null;
}

/** 外部 releases JSON → 可选列表（防渲染层/网络异常形状；selectTargetRelease 的数据入口归一）。 */
export { toReleaseList };
