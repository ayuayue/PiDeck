import { createContext, useContext, type RefObject } from "react";

/**
 * 「外层已自带滚轮」标记（过程组组体）。
 *
 * 为什么需要它：组体是「限高 + 内部滚轮」（`max-h-[min(320px,30vh)] overflow-y-auto`），
 * 而组内的工具卡展开后又各自带着一个限高滚动区（`ToolResult` maxHeight=320、
 * `FileDiff` maxHeight=200）。两层叠在一起就是用户看到的「双层滚动条」：
 * 内层滚轮到边后被 `overscroll-contain` 切断，外层一像素不动，观感像卡死。
 *
 * 因此**组内的内层一律让位**：不再限高、不再自转滚轮，整组内容只由组体那一条滚轮承载。
 * 组外（扁平路径 / 最终回答里的工具卡）保持原有限高，行为不变。
 */
export const ProcessGroupBodyScrollContext = createContext(false);

/** 组体自己的几何通知与阅读位置入口，不向外层时间线传播跟随状态。 */
export type ProcessGroupScrollControls = {
	scrollRef: RefObject<HTMLElement | null>;
	restoreAt: (scrollTop: number) => void;
	subscribeGeometry: (listener: () => void) => () => void;
};

/** 与旧布尔语境分开：组外组件保留原布局，也不订阅组内几何。 */
export const ProcessGroupScrollControlsContext = createContext<ProcessGroupScrollControls | null>(null);

/** 当前是否挂在过程组组体内（外层已有一条滚轮）。 */
export function useInsideProcessGroupBody(): boolean {
	return useContext(ProcessGroupBodyScrollContext);
}
