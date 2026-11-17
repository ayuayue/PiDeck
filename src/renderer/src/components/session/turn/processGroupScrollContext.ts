import { createContext, useContext } from "react";

/**
 * 过程组内的长内容自然展开，纵向滚动统一交给会话时间线。
 * 工具输出和 diff 不再限高；长工具/思考的标题共用会话视口的几何与定位入口。
 * 组外（扁平路径 / 最终回答里的工具卡）保持原有限高，行为不变。
 */
export const ProcessGroupBodyScrollContext = createContext(false);

/** 当前是否挂在自然高度的过程组组体内。 */
export function useInsideProcessGroupBody(): boolean {
	return useContext(ProcessGroupBodyScrollContext);
}
