import { useAtomValue, useSetAtom } from "jotai";
import { Bot } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { agentMarketSettingsAtom, agentProfilesAtom, clearSelectionInlineAtom, quoteToolbarVisibleAtom, selectionInlineRequestAtom } from "../../atoms/agent-atoms";
import { useSelectionTool } from "../../hooks/useSelectionTool";
import { t } from "../../i18n";
import { clampFloatingPosition, toSelectionAnchorRect, type SelectionAnchorRect } from "../../utils/selectionToolPolicy";
import { resolveDefaultSelectionAgent } from "../agents/agentMarketFilters";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";
import { SelectionInlineToolbar } from "./SelectionInlineToolbar";

export type SelectionToolHostProps = {
	/**
	 * 「发送到会话」：由 App 装配层实现（新建草稿会话 + agentMessage 隐藏通道注入角色设定）。
	 * 返回 false 表示宿主已 toast 过具体失败原因；工具栏只在 Promise reject 时补通用错误。
	 */
	onSendToSession: (input: { agentId: string; text: string }) => Promise<boolean>;
};

/** 测量前的估算尺寸：只影响首帧定位，useLayoutEffect 在绘制前换成真实尺寸。 */
const BUTTON_SIZE_FALLBACK = { width: 96, height: 30 };

/** 一次原地工具栏打开请求：requestId 变化即重挂载（自动运行/内联输入等一次性状态全部重置）。 */
type InlineToolbarRequest = {
	requestId: number;
	anchorRect: SelectionAnchorRect | null;
	text: string;
	agentId: string | null;
};

/**
 * 划词工具唯一挂载点（App 根级渲染，全局一份）。
 *
 * 职责边界：
 * - 浮出按钮：选区出现后挂在选区附近（fixed + 视口夹紧），鼠标按下必须 preventDefault，
 *   否则浏览器默认的「按下清选区」会让快照失效；点击打开原地工具栏。
 * - 原地工具栏（phase-2）：结果直接流式输出在工具栏里，不再弹大面板。打开入口有两个：
 *   ① 浮出按钮（选区快照）；② 时间线「引用并提问」浮层里的「翻译」按钮——后者把请求写进
 *   selectionInlineRequestAtom，由本宿主消费：同一时间只有一个工具栏，避免两套浮层叠在一起。
 * - 引用浮层可见时（quoteToolbarVisibleAtom）不显示自己的浮出按钮：两个浮层叠在选区上就是
 *   用户反馈的「划词菜单冲突」，翻译入口已合并进引用浮层。
 *
 * 所有浮层都 portal 到 body：会话区有独立滚动容器/裁剪，挂在 App 树里会被裁掉；
 * z 用 --z-popover（与 Radix 弹层同层：工具栏内下拉/Tooltip 后挂载，自然叠在工具栏之上）。
 */
export function SelectionToolHost({ onSendToSession }: SelectionToolHostProps) {
	const selection = useSelectionTool();
	const quoteToolbarVisible = useAtomValue(quoteToolbarVisibleAtom);
	const inlineRequest = useAtomValue(selectionInlineRequestAtom);
	const clearInlineRequest = useSetAtom(clearSelectionInlineAtom);
	const agents = useAtomValue(agentProfilesAtom);
	const settings = useAtomValue(agentMarketSettingsAtom);
	const defaultAgent = useMemo(() => resolveDefaultSelectionAgent(agents, settings), [agents, settings]);
	const defaultAgentId = defaultAgent?.id ?? null;

	const dismissSelection = selection.dismiss;
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const [buttonSize, setButtonSize] = useState(BUTTON_SIZE_FALLBACK);
	const [toolbar, setToolbar] = useState<InlineToolbarRequest | null>(null);
	const requestIdRef = useRef(0);
	/** 打开前的焦点元素：关闭后把焦点还给页面（浮出按钮不抢焦点，mousedown 已 preventDefault）。 */
	const restoreFocusRef = useRef<HTMLElement | null>(null);

	// 按钮真实尺寸参与水平夹紧；每次渲染重测（浮层刚挂载时 ref 才可用），相等则不 setState。
	useLayoutEffect(() => {
		const element = buttonRef.current;
		if (!element) return;
		const width = element.offsetWidth;
		const height = element.offsetHeight;
		if (width > 0 && (width !== buttonSize.width || height !== buttonSize.height)) setButtonSize({ width, height });
	});

	const buttonPosition = useMemo(() => {
		if (!selection.anchorRect) return null;
		return clampFloatingPosition({
			anchor: selection.anchorRect,
			viewport: { width: window.innerWidth, height: window.innerHeight },
			size: buttonSize,
			gap: 6,
			margin: 8,
		});
	}, [buttonSize, selection.anchorRect]);

	// 引用浮层里的「翻译」：原子是单次事件，读取后立刻清空，避免重复打开/重放上一次请求。
	useEffect(() => {
		if (!inlineRequest) return;
		restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		requestIdRef.current += 1;
		setToolbar({ requestId: requestIdRef.current, anchorRect: toSelectionAnchorRect(inlineRequest.rect), text: inlineRequest.text, agentId: defaultAgentId });
		clearInlineRequest();
	}, [clearInlineRequest, defaultAgentId, inlineRequest]);

	const openToolbarFromSelection = useCallback(() => {
		if (!selection.anchorRect) return;
		restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		requestIdRef.current += 1;
		setToolbar({ requestId: requestIdRef.current, anchorRect: selection.anchorRect, text: selection.text, agentId: defaultAgentId });
	}, [defaultAgentId, selection.anchorRect, selection.text]);

	const closeToolbar = useCallback(() => {
		setToolbar(null);
		dismissSelection();
		const target = restoreFocusRef.current;
		restoreFocusRef.current = null;
		if (target && target.isConnected) target.focus({ preventScroll: true });
		else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
	}, [dismissSelection]);

	const toolbarTitle = defaultAgent ? t("selectionTool.toolbarTitle", { name: defaultAgent.name }) : t("selectionTool.toolbarGeneric");
	const showButton = selection.active && !toolbar && !quoteToolbarVisible && buttonPosition !== null;

	// 没有选区、工具栏也关着：不往 body 里挂任何节点（全局监听仍由 useSelectionTool 持有）。
	if (!selection.active && !toolbar) return null;

	return createPortal(
		<>
			{showButton && buttonPosition ? (
				<div data-selection-tool-ui="" className="fixed z-(--z-popover)" style={{ left: buttonPosition.left, top: buttonPosition.top }}>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								ref={buttonRef}
								type="button"
								onMouseDown={(event) => event.preventDefault()}
								onClick={openToolbarFromSelection}
								aria-label={toolbarTitle}
								className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-border bg-popover px-3 text-xs font-medium text-popover-foreground shadow-md transition-colors hover:bg-accent-soft"
							>
								{defaultAgent?.icon ? (
									<span className="text-sm leading-none" aria-hidden="true">
										{defaultAgent.icon}
									</span>
								) : (
									<Bot size={13} className="text-muted-foreground" aria-hidden="true" />
								)}
								<span>{t("selectionTool.toolbarLabel")}</span>
							</button>
						</TooltipTrigger>
						<TooltipContent side="top" sideOffset={6}>
							{toolbarTitle}
						</TooltipContent>
					</Tooltip>
				</div>
			) : null}
			{toolbar ? <SelectionInlineToolbar key={toolbar.requestId} anchorRect={toolbar.anchorRect} sourceText={toolbar.text} initialAgentId={toolbar.agentId} onClose={closeToolbar} onSendToSession={onSendToSession} /> : null}
		</>,
		document.body,
	);
}
