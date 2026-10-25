import { forwardRef, useCallback } from "react";
import { ImageGenSection, type ImageGenSectionHandle } from "../../config/ImageGenSection";

/**
 * 设置 → 生图。
 * 生图供应商配置独立于 pi/dsh（userData/imagegen.json），因此从 Pi 管理迁移至设置页。
 * 与视觉桥（pi-deck-vision.json）同属独立落盘配置：由本 tab 自身管理草稿与保存，
 * 通过 onDirtyChange / ref 暴露给 SettingsModal 的统一脏标记与保存确认流程。
 */
export const ImageGenSettingsTab = forwardRef<
	ImageGenSectionHandle,
	{
		onDirtyChange?: (dirty: boolean) => void;
	}
>(function ImageGenSettingsTab(props, ref) {
	const handleDirtyChange = useCallback(
		(value: boolean) => {
			props.onDirtyChange?.(value);
		},
		[props.onDirtyChange],
	);

	// 不再自带 p-4：外层 TabsContent 的 .settings-panel 已提供内边距，
	// 这里再包一层会让生图页比其他设置页双倍缩进。
	return <ImageGenSection ref={ref} onDirtyChange={handleDirtyChange} />;
});

// 供 SettingsModal 通过 ref 直接调用保存（与 ConfigModal 复用同一 handle）
export type ImageGenSettingsTabHandle = ImageGenSectionHandle;
