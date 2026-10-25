import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { wallpaperEnginePreviewUrl, wallpaperEngineVideoUrl } from "../../../../../shared/wallpaperEngine";
import type { AppSettings } from "../../../../../shared/types";
import { isVideoWallpaperActive, shouldPlayVideoWallpaper, videoWallpaperRender } from "../../../hooks/appearance/videoWallpaper";
import { t } from "../../../i18n";

/**
 * Wallpaper Engine 视频壁纸背景层（第一期只做 video）。
 *
 * - portal 到 body、fixed 铺满、z-index 0，位于 #root（z-index 1）之下；
 *   透明度档位沿用 useAppAppearance 注入的壁纸 token，遮罩复用 --app-bg-mask。
 * - <video muted loop playsinline>，src 是 pideck-we://video/<id>：视频字节由主进程协议
 *   按 Range 流式读取，不经 IPC；preload="auto" 交给 Chromium 自行缓冲。
 * - 窗口失焦 / 最小化（document.hidden）时暂停，聚焦后恢复。
 * - <video> error（如无 GPU 环境解不了 HEVC）→ 提示一次并回退到预览图；预览也失败则不显示壁纸。
 * - 全局只有一个实例；关闭或切换时清空 src 并 load()，立即释放解码器与缓冲。
 */
export function WallpaperVideoLayer({ settings }: { settings: Pick<AppSettings, "weWorkshopDir" | "weWallpaperId"> }) {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const active = isVideoWallpaperActive(settings);
	const src = active ? wallpaperEngineVideoUrl(settings.weWallpaperId) : "";
	// 失败状态按 src 记录：切换到别的壁纸自动重置
	const [failedSrc, setFailedSrc] = useState("");
	const [previewFailedSrc, setPreviewFailedSrc] = useState("");
	const render = videoWallpaperRender({ videoFailed: failedSrc === src, previewFailed: previewFailedSrc === src });
	const [playable, setPlayable] = useState(() => shouldPlayVideoWallpaper({ hidden: document.hidden, focused: document.hasFocus() }));

	useEffect(() => {
		if (!src) return;
		const update = () => setPlayable(shouldPlayVideoWallpaper({ hidden: document.hidden, focused: document.hasFocus() }));
		window.addEventListener("focus", update);
		window.addEventListener("blur", update);
		document.addEventListener("visibilitychange", update);
		update();
		return () => {
			window.removeEventListener("focus", update);
			window.removeEventListener("blur", update);
			document.removeEventListener("visibilitychange", update);
		};
	}, [src]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !src || render !== "video") return;
		if (playable) void video.play().catch(() => undefined);
		else video.pause();
	}, [playable, src, render]);

	// 切换/关闭时显式释放：React 卸载 <video> 不保证立刻回收媒体管线
	useEffect(() => {
		const video = videoRef.current;
		return () => {
			if (!video) return;
			video.pause();
			video.removeAttribute("src");
			video.load();
		};
	}, [src]);

	if (!src) return null;
	return createPortal(
		<div className="wallpaper-video-layer" aria-hidden="true" data-testid="wallpaper-video-layer">
			{render === "video" ? (
				<video
					ref={videoRef}
					key={src}
					src={src}
					muted
					loop
					playsInline
					autoPlay={playable}
					preload="auto"
					disablePictureInPicture
					onError={() => {
						setFailedSrc(src);
						toast.warning(t("settings.wallpaperEnginePlaybackFailed"));
					}}
				/>
			) : render === "preview" ? (
				<img key={src} src={wallpaperEnginePreviewUrl(settings.weWallpaperId)} alt="" onError={() => setPreviewFailedSrc(src)} />
			) : null}
			<div className="wallpaper-video-mask" />
		</div>,
		document.body,
	);
}
