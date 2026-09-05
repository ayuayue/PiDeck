/**
 * 更新源（GitHub Release 镜像）配置 —— 主进程侧编排逻辑。
 *
 * 纯数据与拼接规则在 shared/updateSources.ts（主/渲染共用同一份清单，UI 展示与
 * feed URL 生成自动同步）；本文件只保留需要主进程侧的归一化与查询函数。
 */

import type { UpdateSourceId } from "../../shared/types/settings";
import {
  UPDATE_SOURCE_MIRRORS,
  buildCustomSourceFeedUrl,
  gitHubReleasesBase,
  normalizeCustomMirrorHost,
} from "../../shared/updateSources";

export { normalizeCustomMirrorHost }; // 再导出，供调用点单一来源

/** 校验设置里的更新源 id 是否已知；未知值回退 github（设置文件可能被手改/旧版本）。 */
export function normalizeUpdateSource(source: unknown): UpdateSourceId {
  const id = typeof source === "string" ? (source as UpdateSourceId) : "github";
  return id === "github" || id === "custom" || UPDATE_SOURCE_MIRRORS.some((m) => m.id === id)
    ? id
    : "github";
}

/** 镜像展示信息（设置页下拉/列表用）：id + 显示名 labelKey + 完整 feed URL。 */
export type UpdateSourceOption = {
  id: UpdateSourceId;
  /** 渲染层 i18n label key 后缀（settings.updateSourceOption.<id>）；github 也带，custom 由输入框驱动。 */
  labelKey: string;
  host: string | null;
  feedUrl: string | null;
};

/**
 * 预设镜像 + 官方源的下拉选项（按设置顺序：官方在前，镜像按清单序）。
 * host/feedUrl 供 UI 直接展示地址；custom 项不在此列（由自定义输入驱动）。
 */
export function updateSourceOptions(): UpdateSourceOption[] {
  const options: UpdateSourceOption[] = [
    { id: "github", labelKey: "github", host: null, feedUrl: null },
    ...UPDATE_SOURCE_MIRRORS.map((m) => ({
      id: m.id,
      labelKey: m.id,
      host: m.host,
      feedUrl: buildCustomSourceFeedUrl(m.host),
    })),
  ];
  return options;
}

/**
 * 生成镜像源的 generic feed baseUrl。
 * github 源无 URL（返回 null → 走默认 app-update.yml/原生 GitHub provider）；
 * custom 源依赖 customHost（已规范化，非法则回退 null 走默认）。
 */
export function updateSourceFeedUrl(source: UpdateSourceId, customHost?: string | null): string | null {
  if (source === "github") return null;
  if (source === "custom") {
    // 防御性规范化：调用方已 normalize，这里再校验一次避免非法前缀进入 feed URL。
    const host = normalizeCustomMirrorHost(customHost);
    return host ? buildCustomSourceFeedUrl(host) : null;
  }
  const mirror = UPDATE_SOURCE_MIRRORS.find((m) => m.id === source);
  if (!mirror) return null;
  return buildCustomSourceFeedUrl(mirror.host);
}

/**
 * macOS manual 检查的镜像 latest-release 页 URL（镜像同样支持重定向跟随），
 * 例：`https://ghfast.top/https://github.com/ayuayue/PiDeck/releases/latest`；
 * github 源返回 null → 主进程走官方 URL。
 */
export function updateSourceLatestReleaseUrl(source: UpdateSourceId, customHost?: string | null): string | null {
  if (source === "github") return null;
  const host =
    source === "custom" ? (customHost ?? null) : (UPDATE_SOURCE_MIRRORS.find((m) => m.id === source)?.host ?? null);
  if (!host) return null;
  return `${host}/${gitHubReleasesBase()}/releases/latest`;
}