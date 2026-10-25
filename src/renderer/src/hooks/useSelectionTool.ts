import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { agentMarketSettingsAtom } from "../atoms/agent-atoms";
import { isSelectionToolAnchorElement, isSelectionToolIgnoredMouseUpTarget, normalizeSelectionText, SELECTION_TOOL_UI_SELECTOR, type SelectionAnchorRect } from "../utils/selectionToolPolicy";

/** 选区快照：文本在展示那刻定格（下一次 mousedown 会清掉浏览器选区），anchorRect 是 fixed 定位用的视口坐标。 */
export type SelectionToolSnapshot = { text: string; anchorRect: SelectionAnchorRect };

export type SelectionToolController = {
	/** 当前是否应显示浮出按钮（快照存在）。 */
	active: boolean;
	text: string;
	anchorRect: SelectionAnchorRect | null;
	/** 收起快照（面板关闭 / Escape / 滚动 / 选区塌陷都走这里）。 */
	dismiss: () => void;
	/** 设置里的划词开关：关闭时 hook 不注册任何全局监听。 */
	selectionEnabled: boolean;
};

/** 选区端点节点 → 元素（文本节点取父元素；游离节点返回 null，由 isSelectionToolAnchorElement 判 false）。 */
function elementForNode(node: Node | null): Element | null {
	if (!node) return null;
	return node instanceof Element ? node : node.parentElement;
}

/**
 * 全局划词监听：只在**助手回复正文**（selectionToolPolicy 的 SELECTION_TOOL_REPLY_SELECTOR）内划选时
 * 产出「文本 + 选区矩形」快照，供浮出按钮定位；侧栏/设置/用户气泡等非回复区域不弹（2026-10 用户反馈）。
 *
 * 生命周期：selectionToolEnabled=false（设置里关掉）时不注册任何监听，并清空残留快照；
 * 打开时注册、卸载时成对移除（mouseup/keyup/selectionchange/scroll/resize）。
 *
 * 快照在 mouseup / keyup 时**同步**捕获：浏览器在下一次 mousedown 就会清掉选区，
 * 晚一拍（setTimeout）读到的可能已经是空选区——「点完没反应」的经典成因。
 *
 * 显式忽略：工具自身 UI（[data-selection-tool-ui]）与编辑面内的划选；选区塌陷立刻收起；
 * 滚动/缩放让 fixed 定位失真，同样收起；Escape 收起。
 * 浮出按钮自身必须在 mousedown 里 preventDefault（见 SelectionToolHost）：按下按钮的默认行为
 * 会先清掉选区，click 时快照与选区已经对不上。
 */
export function useSelectionTool(): SelectionToolController {
	const selectionEnabled = useAtomValue(agentMarketSettingsAtom).selectionToolEnabled;
	const [snapshot, setSnapshot] = useState<SelectionToolSnapshot | null>(null);

	const dismiss = useCallback(() => {
		setSnapshot(null);
	}, []);

	useEffect(() => {
		if (!selectionEnabled) {
			// 特性开关关闭：不注册监听（划选不打扰），并清掉可能残留的浮出按钮。
			setSnapshot(null);
			return;
		}

		const evaluate = () => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
				setSnapshot(null);
				return;
			}
			const range = selection.getRangeAt(0);
			// 两端分别判：跨边界划选（从输入框拖到正文）任一端落在编辑面/工具 UI 内都不弹。
			if (!isSelectionToolAnchorElement(elementForNode(range.startContainer)) || !isSelectionToolAnchorElement(elementForNode(range.endContainer))) {
				setSnapshot(null);
				return;
			}
			const text = normalizeSelectionText(selection.toString());
			if (!text) {
				setSnapshot(null);
				return;
			}
			const rect = range.getBoundingClientRect();
			// 选区所在子树已卸载/折叠成零矩形：没有可定位的锚点，宁可不弹。
			if (rect.width === 0 && rect.height === 0) {
				setSnapshot(null);
				return;
			}
			setSnapshot({ text, anchorRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } });
		};

		const onMouseUp = (event: MouseEvent) => {
			// 只响应主键（右键菜单/中键滚动不应触发展示）；工具 UI / 菜单 / 引用浮层上的点击
			// 不重算快照：复制菜单项、翻译/引用按钮都不是新的划选手势，否则复制完会重新弹出翻译按钮。
			if (event.button !== 0) return;
			if (isSelectionToolIgnoredMouseUpTarget(event.target instanceof Element ? event.target : null)) return;
			evaluate();
		};
		const onPointerDown = (event: PointerEvent) => {
			// 新的按压 = 用户开始别的交互（含右键/点复制菜单）：先收起旧快照。
			// 浮出按钮自身必须放行（mousedown preventDefault，否则点击按钮会先清选区）。
			if (event.target instanceof Element && event.target.closest(SELECTION_TOOL_UI_SELECTOR)) return;
			dismiss();
		};
		const onCopy = () => {
			// 键盘 Ctrl/Cmd+C 不会触发 pointerdown：复制是「复制」而不是「划词」，同样收起浮钮。
			dismiss();
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				dismiss();
				return;
			}
			// Shift+方向键 / Ctrl(Cmd)+A：键盘扩选结束也要能弹；其他按键不改选区，保持现状。
			if (event.shiftKey || event.key === "a" || event.key === "A") evaluate();
		};
		const onSelectionChange = () => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed) dismiss();
		};
		// fixed 定位随滚动/缩放立即失真：直接收起，不尝试跟随（全局跟随会与各滚动容器打架）。
		const onViewportChange = () => dismiss();

		document.addEventListener("mouseup", onMouseUp);
		// capture：Radix 菜单项可能在自己的 pointerdown 里做处理，确保复制/菜单交互一定先收起快照。
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("copy", onCopy);
		document.addEventListener("keyup", onKeyUp);
		document.addEventListener("selectionchange", onSelectionChange);
		// scroll 用捕获：消息列/抽屉等内层滚动容器也要收起。
		document.addEventListener("scroll", onViewportChange, true);
		window.addEventListener("resize", onViewportChange);

		return () => {
			document.removeEventListener("mouseup", onMouseUp);
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("copy", onCopy);
			document.removeEventListener("keyup", onKeyUp);
			document.removeEventListener("selectionchange", onSelectionChange);
			document.removeEventListener("scroll", onViewportChange, true);
			window.removeEventListener("resize", onViewportChange);
		};
	}, [dismiss, selectionEnabled]);

	return {
		active: snapshot !== null,
		text: snapshot?.text ?? "",
		anchorRect: snapshot?.anchorRect ?? null,
		dismiss,
		selectionEnabled,
	};
}
