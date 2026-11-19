import { createContext, useContext } from "react";
import type { MessageScrollerGeometry } from "../../agents/message-scroller-context";

/**
 * 「外层（组体）已自带一条滚轮」标记。
 *
 * 组体是**限高视口 + 会滚动**（`max-h-[min(640px,60vh)] overflow-y-auto`），而组内的
 * 工具卡展开后又各自带着一个限高滚动区（`ToolResult` 320 / `FileDiff` 200）。
 * 两层叠在一起就是用户看到的「双层滚动条」：内层滚轮到边后手势就换了主语，
 * 观感像卡死。所以**组内的内层一律让位**：不再限高、不再自转滚轮，
 * 整组内容只由组体那一条滚轮承载。（组体的滚动条本身是隐藏的，见 ProcessGroupStep。）
 *
 * 组外（扁平路径 / 最终回答里的工具卡）保持原有限高，行为不变。
 */
export const ProcessGroupBodyScrollContext = createContext(false);

/**
 * 组体自己的滚动几何与阅读位置入口。
 *
 * 组内的长工具/思考项标题要吸在**组体视口**顶端（`position: sticky` 绑定最近的滚动容器），
 * 「回到本项开头」也只能改组体的 `scrollTop`。因此组内行不能再用会话视口的几何，
 * 必须走这份。类型与会话侧同形（`MessageScrollerGeometry`），消费方无需区分。
 *
 * 组外为 null：此时退回会话几何（或按既有规则不启用吸顶）。
 */
export const ProcessGroupScrollControlsContext = createContext<MessageScrollerGeometry | null>(null);

/** 当前是否挂在过程组组体内（外层已有一条滚轮）。 */
export function useInsideProcessGroupBody(): boolean {
	return useContext(ProcessGroupBodyScrollContext);
}

/** 组体的几何通知与定位入口；组外返回 null。 */
export function useProcessGroupScrollControls(): MessageScrollerGeometry | null {
	return useContext(ProcessGroupScrollControlsContext);
}
