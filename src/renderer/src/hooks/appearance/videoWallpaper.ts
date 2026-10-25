import { WALLPAPER_ENGINE_ID_RE } from "../../../../shared/wallpaperEngine";
import type { AppSettings } from "../../../../shared/types";

/** 视频壁纸是否生效：工坊目录已设置且选中 ID 合法。 */
export function isVideoWallpaperActive(settings: Pick<AppSettings, "weWorkshopDir" | "weWallpaperId">): boolean {
	return Boolean(settings.weWorkshopDir) && WALLPAPER_ENGINE_ID_RE.test(settings.weWallpaperId ?? "");
}

/**
 * 视频壁纸何时应播放：窗口可见且聚焦。失焦、最小化（document.hidden）都暂停，
 * 解码器停在当前帧，CPU/GPU 占用随之回落。
 */
export function shouldPlayVideoWallpaper(state: { hidden: boolean; focused: boolean }): boolean {
	return !state.hidden && state.focused;
}

/**
 * 视频解码失败后的回退：先退到工坊预览图（preview.jpg/gif），预览也加载失败则不显示壁纸。
 * 典型场景：无 GPU 的 Linux/Electron 上 HEVC 视频无法解码，<video> 触发 error。
 */
export type VideoWallpaperRender = "video" | "preview" | "none";
export function videoWallpaperRender(state: { videoFailed: boolean; previewFailed: boolean }): VideoWallpaperRender {
	if (!state.videoFailed) return "video";
	return state.previewFailed ? "none" : "preview";
}
