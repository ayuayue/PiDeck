import { forwardRef, useCallback } from "react";
import { VideoGenSection, type VideoGenSectionHandle } from "../../config/VideoGenSection";

/**
 * 设置 → 生视频。
 * 生视频供应商配置独立于 pi/dsh（userData/videogen.json），与生图同属独立落盘配置：
 * 由本 tab 自身管理草稿与保存，通过 onDirtyChange / ref 暴露给 SettingsModal 的
 * 统一脏标记与保存确认流程。
 */
export const VideoGenSettingsTab = forwardRef<
	VideoGenSectionHandle,
	{
		onDirtyChange?: (dirty: boolean) => void;
	}
>(function VideoGenSettingsTab(props, ref) {
	const handleDirtyChange = useCallback(
		(value: boolean) => {
			props.onDirtyChange?.(value);
		},
		[props.onDirtyChange],
	);

	// 不再自带 p-4：外层 TabsContent 的 .settings-panel 已提供内边距，
	// 这里再包一层会让生视频页比其他设置页双倍缩进。
	return <VideoGenSection ref={ref} onDirtyChange={handleDirtyChange} />;
});

// 供 SettingsModal 通过 ref 直接调用保存（与生图 tab 复用同一 handle 形态）
export type VideoGenSettingsTabHandle = VideoGenSectionHandle;
