/**
 * 时间线消息右键菜单（状态 + DOM 动作）。
 *
 * 职责边界：
 * - 纯规则（复制来源派生、文本清理、选择器契约）在 components/session/timeline/messageContextMenuPolicy；
 * - 视图（Radix DropdownMenu 坐标菜单）在 components/session/timeline/MessageContextMenu；
 * - 这里只做 DOM 胶水：右键按下时锁存选区、contextmenu 时解析命中对象、执行复制 / 全选。
 *
 * 选区为什么必须在 pointerdown 锁存：Chromium 在选区外按右键会把选区塌陷成光标，
 * contextmenu 事件到达时 window.getSelection() 已经是空串，「复制」就复制不到用户实际选中的文本。
 * 反过来，右键按在选区内时浏览器会保留选区，锁存同样不亏。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { ChatMessage, FavoriteRole } from "../../../shared/types";
import { useFavorites } from "./useFavorites";
import { t } from "../i18n";
import { writeClipboard } from "../utils/clipboard";
import { showNotice } from "../utils/notice";
import { stripMarkdown } from "../components/session/SurfaceParts";
import { favoriteMessageKey } from "../components/favorites/favoriteIdentity";
import { CONTEXT_MENU_IGNORE_SELECTOR, LIVE_ANSWER_SELECTOR, MESSAGE_BODY_SELECTOR, cleanMessageCopyText, hasMessageContextMenuCopy, isPointInsideRects, planMessageContextMenu, type MessageContextMenuCopyKind } from "../components/session/timeline/messageContextMenuPolicy";

// 复制来源类型与「一次只给一组复制项」的纯策略同源（单个真相源在 policy，避免类型与菜单项漂移）
export type { MessageContextMenuCopyKind } from "../components/session/timeline/messageContextMenuPolicy";

export type MessageFavoriteContext = {
	/** 来源会话（收藏快照的元信息；会话标题用于收藏列表展示）。 */
	sessionId: string | null;
	sessionTitle: string | null;
	projectId: string | null;
};

export type MessageContextMenuState = {
	/** 右键坐标（视口坐标，供 fixed 定位的虚拟 Trigger 使用）。 */
	x: number;
	y: number;
	/** 选区快照文本；空串 = 不显示「复制」项。 */
	selectionText: string;
	/** 命中消息的原文（markdown 源码）；空串 = 不显示「复制为文本 / 复制为 Markdown」。 */
	messageText: string;
	/** live 流式正文的 DOM 文本回退；非空时提供 live 的「复制为文本」。 */
	liveText: string;
	/** 命中可全选的正文宿主（live 正文 / markdown 正文 / 气泡 / 消息块锚点）。 */
	canSelectAll: boolean;
	/** 收藏用的来源消息元信息（命中消息才有 id/角色；live 正文没有 id）。 */
	messageId: string | null;
	messageRole: FavoriteRole | null;
	messageModel: string | null;
	/** 右键落在 live 流式正文内：收藏的是屏幕纯文本，需标记 partial。 */
	partial: boolean;
	/** 命中的整条消息是否已在收藏里：菜单项据此显示「收藏」还是「取消收藏」。 */
	messageFavorited: boolean;
};

export type MessageContextMenuController = {
	state: MessageContextMenuState | null;
	/** 挂在消息列表容器的 onContextMenu 上。 */
	handleContextMenu: (event: MouseEvent<HTMLElement>) => void;
	close: () => void;
	copy: (kind: MessageContextMenuCopyKind) => void;
	selectAll: () => void;
	/** 收藏当前选区 / 命中的整条消息（消息快照走 Markdown 源码，live 正文按纯文本 + partial）。 */
	favorite: (kind: "message" | "selection") => void;
};

/** 当前实时选区文本（折叠 / 无选区返回空串）。 */
function readLiveSelectionText(): string {
	const selection = window.getSelection();
	return selection && !selection.isCollapsed ? selection.toString() : "";
}

/**
 * 按 id 找一条消息。
 * 刻意不用「渲染期 useMemo 建 Map」：流式期间 messages 每 50ms 换一次引用，长会话会被反复
 * 整表重建；右键是低频用户动作，单次线性扫描（最多几千条）远低于一次渲染开销。
 */
function resolveMessageById(messages: readonly ChatMessage[], messageId: string): ChatMessage | undefined {
	for (const message of messages) {
		if (message.id === messageId) return message;
	}
	return undefined;
}

/**
 * 右键按下瞬间锁存选区。
 *
 * 只在「按在高亮选区上」时锁存：按在选区外（含同一段的空白处 / 选区末尾留白）等于开始新的
 * 光标动作，浏览器随后会收掉旧选区，此时保留旧选区会让「复制」复制到用户没在看的内容。
 * 判定走几何矩形（见 policy 的 isPointInsideRects）：右键事件 target 常是段落祖先，
 * Selection.containsNode 对祖先的返回值不稳定，且会把「段内远离选区的点」也算命中。
 */
function readSelectionSnapshotAtPointerDown(event: PointerEvent): string {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
	const rects = Array.from(selection.getRangeAt(0).getClientRects());
	if (!isPointInsideRects(rects, event.clientX, event.clientY)) return "";
	return selection.toString();
}

export function useMessageContextMenu(options: { messages: readonly ChatMessage[]; scopeKey: string; favoriteContext?: MessageFavoriteContext; favoritedMessageKeys?: ReadonlySet<string> }): MessageContextMenuController {
	const { messages, scopeKey } = options;
	const { addFavorite, toggleMessageFavorite } = useFavorites();
	const [state, setState] = useState<MessageContextMenuState | null>(null);
	/** 右键按下时锁存的选区文本（见 readSelectionSnapshotAtPointerDown）。 */
	const selectionSnapshotRef = useRef("");
	/** 「全选」目标正文宿主：只在菜单打开那一刻解析一次，避免流式 DOM 变化后选错节点。 */
	const selectAllTargetRef = useRef<HTMLElement | null>(null);
	/** 复制动作在 Radix 关闭菜单（state 置空）之后仍要拿到当时的内容，走 ref 同步快照。 */
	const stateRef = useRef<MessageContextMenuState | null>(null);
	stateRef.current = state;

	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			// 只处理右键：左键按下是新的拖选动作，不能复用旧快照。
			if (event.button !== 2) return;
			selectionSnapshotRef.current = readSelectionSnapshotAtPointerDown(event);
		};
		// capture：浏览器的选区塌陷发生在默认动作阶段，必须在捕获阶段（早于任何冒泡处理器）拍快照。
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => document.removeEventListener("pointerdown", onPointerDown, true);
	}, []);

	// 切会话 / 换时间线实例必须收起：旧坐标上的菜单只对当时那条消息有效，
	// 跨会话驻留会让复制落到另一条会话的文本上。
	useEffect(() => {
		setState(null);
		selectAllTargetRef.current = null;
	}, [scopeKey]);

	const close = useCallback(() => setState(null), []);

	const handleContextMenu = useCallback(
		(event: MouseEvent<HTMLElement>) => {
			// 子元素已有自己的坐标菜单（Markdown 文件链接、用户气泡里的文件 chip）：
			// 它们在原生 contextmenu 上 preventDefault 后事件仍会冒泡，这里靠 defaultPrevented 让位。
			if (event.defaultPrevented) return;
			const target = event.target;
			if (!(target instanceof Element)) return;
			// 输入 / 编辑控件保留原生右键语义（文本编辑菜单）。
			if (target.closest(CONTEXT_MENU_IGNORE_SELECTOR)) return;
			const liveHost = target.closest(LIVE_ANSWER_SELECTOR);
			// live 正文不按 data-message-id 解析（原因见 policy 的 planMessageContextMenu 注释）。
			const anchor = liveHost ? null : target.closest("[data-message-id]");
			const messageId = anchor instanceof Element ? anchor.getAttribute("data-message-id") : null;
			// data-message-id 可能命中 run id / 合成 id（不在 activeMessages 里）→ 找不到就只给选区/全选。
			const message = messageId ? resolveMessageById(messages, messageId) : undefined;
			const plan = planMessageContextMenu({
				selectionSnapshot: selectionSnapshotRef.current,
				liveSelection: readLiveSelectionText(),
				inLiveAnswer: Boolean(liveHost),
				liveText: liveHost ? (liveHost.textContent ?? "") : "",
				messageText: message?.text ?? null,
			});
			// 没有任何可复制内容（右键落在空白 / 无正文区域）不打开空菜单。
			if (!hasMessageContextMenuCopy(plan)) return;
			const body = target.closest(MESSAGE_BODY_SELECTOR);
			selectAllTargetRef.current = body instanceof HTMLElement ? body : null;
			// 让位系统默认右键行为（Windows 无默认菜单，但 webview / 输入法等环境可能有）。
			event.preventDefault();
			setState({
				x: event.clientX,
				y: event.clientY,
				selectionText: plan.selectionText,
				messageText: plan.messageText,
				liveText: plan.liveText,
				canSelectAll: Boolean(selectAllTargetRef.current),
				messageId: message?.id ?? null,
				// ChatRole 还含 error / toolResult 等非对话角色：收藏只认三种可读角色。
				messageRole: message?.role === "user" || message?.role === "assistant" || message?.role === "system" ? message.role : null,
				messageModel: message?.model ? `${message.model.provider}/${message.model.modelId}` : null,
				partial: Boolean(liveHost),
				// 已收藏态：只要这条消息（同会话 + messageId）在收藏表里，菜单就提供「取消收藏」。
				messageFavorited: Boolean(message && options.favoritedMessageKeys?.has(favoriteMessageKey(options.favoriteContext?.sessionId ?? null, message.id) ?? "")),
			});
		},
		[messages, options.favoriteContext?.sessionId, options.favoritedMessageKeys],
	);

	/** 写剪贴板并给统一反馈：失败绝不报「已复制」（与 CopyMenu 同口径）。 */
	const writeAndNotify = useCallback(async (value: string) => {
		if (!value.trim()) return;
		const ok = await writeClipboard(value);
		showNotice(ok ? t("copy.success") : t("copy.failed"), ok ? 1200 : 2000, ok ? undefined : "error");
	}, []);

	const copy = useCallback(
		(kind: MessageContextMenuCopyKind) => {
			// 同步取快照：Radix 选中后会立刻关闭菜单（state 置空），异步回调里再读 state 就晚了。
			const current = stateRef.current;
			if (!current) return;
			if (kind === "selection") {
				void writeAndNotify(current.selectionText);
				return;
			}
			if (kind === "liveText") {
				// live 正文只有屏幕上的 DOM 文本：原样复制，不能再 stripMarkdown（会把已渲染文本里的
				// 字面量符号当语法剥掉）。
				void writeAndNotify(current.liveText);
				return;
			}
			// 消息原文先做展示清理（引用块/思考/ANSI），再按菜单项决定是否剥 markdown 语法。
			const cleaned = cleanMessageCopyText(current.messageText);
			void writeAndNotify(kind === "messageText" ? stripMarkdown(cleaned) : cleaned);
		},
		[writeAndNotify],
	);

	/** 全选命中正文（live 流式正文同样可用：目标就是 [data-live-answer] 根节点）。 */
	const selectAll = useCallback(() => {
		const target = selectAllTargetRef.current;
		if (!target || !target.isConnected) return;
		const selection = window.getSelection();
		if (!selection) return;
		const range = document.createRange();
		range.selectNodeContents(target);
		selection.removeAllRanges();
		selection.addRange(range);
	}, []);

	/**
	 * 收藏：与复制共用同一份快照来源，但保留 Markdown 语法（复制为文本才 stripMarkdown）。
	 * - 选区：纯文本快照；
	 * - 命中消息：清理展示噪音后的 Markdown 源码；
	 * - live 正文：只有屏幕纯文本（没有 markdown / messageId），标 partial。
	 * 命中真实消息时是开关语义：已收藏就取消（同一条消息不会越点越多）。
	 */
	const favorite = useCallback(
		(kind: "message" | "selection") => {
			const current = stateRef.current;
			if (!current) return;
			const context = options.favoriteContext ?? { sessionId: null, sessionTitle: null, projectId: null };
			const base = { sessionId: context.sessionId, sessionTitle: context.sessionTitle, projectId: context.projectId };
			if (kind === "selection") {
				if (!current.selectionText) return;
				void addFavorite({ kind: "selection", text: current.selectionText, role: null, messageId: current.messageId, model: current.messageModel, ...base });
				return;
			}
			const text = current.messageText ? cleanMessageCopyText(current.messageText) : current.liveText;
			if (!text) return;
			const input = { kind: "message" as const, text, role: current.messageText ? current.messageRole : "assistant", messageId: current.messageId, model: current.messageText ? current.messageModel : null, partial: current.partial, ...base };
			// 真实消息（有 messageId）走开关；live 正文没有稳定身份，只能新增。
			if (current.messageId) void toggleMessageFavorite(input);
			else void addFavorite(input);
		},
		[addFavorite, options.favoriteContext, toggleMessageFavorite],
	);

	return { state, handleContextMenu, close, copy, selectAll, favorite };
}
