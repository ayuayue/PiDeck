/**
 * GUI 扩展桥 —— 会话标题副作用（`ctx.ui.setTitle`，§8.2 A 组 title 落点）。
 *
 * 桥把扩展设的标题推给渲染层，但「终端标题」在桌面端没有直接对应物。
 * 计划 §8.2 给的目标是：`document.title` 与 Tab 标题。
 *
 * 这里只做 **`document.title`** 这一个明确、低风险的落点：
 * - 有桥标题时用桥标题；无贡献时**不碰** `document.title`（保持 PiDeck 原样，§7.4 只追加）
 * - 切换会话 / 组件卸载时**恢复**上一个值，避免残留
 *
 * Tab 标题的替换涉及 `SessionTabsBar` 的既有渲染逻辑，属于「替换类落点」，
 * 风险高于收益，暂不改动（在文档里记为已知缺口）。
 */

import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { sessionRuntimeUiByIdAtom } from "../atoms/session-atoms";

/**
 * 把桥的会话标题应用到 `document.title`。
 *
 * 只在「有桥标题」时生效；无贡献时完全不动（不占位、不改动原有行为）。
 */
export function useBridgeSessionTitle(sessionId: string | undefined): void {
	const ui = useAtomValue(sessionRuntimeUiByIdAtom);
	const bridgeTitle = sessionId ? ui[sessionId]?.bridgeTitle : undefined;

	useEffect(() => {
		if (!bridgeTitle) return;
		const previous = document.title;
		document.title = bridgeTitle;
		// 卸载或标题变化时恢复：桥的标题是「扩展贡献」，不是 PiDeck 的持久标题
		return () => {
			document.title = previous;
		};
	}, [bridgeTitle]);
}