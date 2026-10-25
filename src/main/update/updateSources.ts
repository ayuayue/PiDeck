/**
 * 更新源（GitHub Release 镜像）配置 —— 主进程侧编排逻辑。
 *
 * 纯数据与拼接规则在 shared/updateSources.ts（主/渲染共用同一份清单，UI 展示与
 * feed URL 生成自动同步）；本文件只保留需要主进程侧的归一化与查询函数。
 */

import type { UpdateSourceId } from "../../shared/types/settings";
import { ATOMGIT_HOST, atomGitLatestReleaseApiUrl, UPDATE_SOURCE_MIRRORS, buildCustomSourceFeedUrl, normalizeCustomMirrorHost } from "../../shared/updateSources";

export { normalizeCustomMirrorHost }; // 再导出，供调用点单一来源

/** 校验设置里的更新源 id 是否已知；未知值回退 atomgit。 */
export function normalizeUpdateSource(source: unknown): UpdateSourceId {
	const id = typeof source === "string" ? (source as UpdateSourceId) : "atomgit";
	return id === "atomgit" || id === "github" ? id : "atomgit";
}

/** 镜像展示信息（设置页下拉/列表用）：id + 显示名 labelKey + 完整 feed URL。 */
export type UpdateSourceOption = {
	id: UpdateSourceId;
	/** 渲染层 i18n label key 后缀（settings.updateSourceOption.<id>）。 */
	labelKey: string;
	host: string | null;
	feedUrl: string | null;
};

/**
 * 更新源下拉选项（atomgit 第一首选，github 官方次选）。
 */
export function updateSourceOptions(): UpdateSourceOption[] {
	const options: UpdateSourceOption[] = [
		{
			id: "atomgit",
			labelKey: "atomgit",
			host: ATOMGIT_HOST,
			feedUrl: buildCustomSourceFeedUrl(ATOMGIT_HOST),
		},
		{ id: "github", labelKey: "github", host: null, feedUrl: null },
	];
	return options;
}

/**
 * 生成镜像源的 generic feed baseUrl。
 * github 源无 URL（返回 null → 走默认 app-update.yml/原生 GitHub provider）；
 * atomgit 源返回 AtomGit generic feed baseUrl。
 */
export function updateSourceFeedUrl(source: UpdateSourceId, _customHost?: string | null): string | null {
	if (source === "github") return null;
	const mirror = UPDATE_SOURCE_MIRRORS.find((m) => m.id === source);
	if (!mirror) return buildCustomSourceFeedUrl(ATOMGIT_HOST);
	return buildCustomSourceFeedUrl(mirror.host);
}

/**
 * macOS manual 检查的 latest-release 探测 URL：
 * atomgit 源返回 OpenAPI latest（网页是 SPA，不会 302 到 tag）；
 * github 源返回 null → 主进程走官方 GitHub `/releases/latest` 重定向。
 */
export function updateSourceLatestReleaseUrl(source: UpdateSourceId, _customHost?: string | null): string | null {
	if (source === "github") return null;
	return atomGitLatestReleaseApiUrl();
}
