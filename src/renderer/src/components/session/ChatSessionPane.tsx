import React, { useEffect, useMemo, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { pendingMessageJumpAtom, requestSessionFindAtom, sessionFindOpenRequestsAtom, sessionRecordByIdAtomFamily } from "../../atoms";
import { useSessionTimelineController } from "../../hooks/useSessionTimelineController";
import { SessionRuntimeInjector } from "./SessionRuntimeInjector";
import { useSessionPaneServices } from "./SessionPaneServices";
import { SessionFindOverlay } from "./SessionFindOverlay";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { supportsSessionFind } from "../../utils/sessionFindSupport";

export type ChatSessionPaneProps = {
	sessionId: string;
	focused: boolean;
	onFocusPane: () => void;
	/** 分屏双栏时为 true（边框高亮）；单栏 Tab 外置时为 false */
	splitPane?: boolean;
};

/**
 * 单个会话聊天栏：自持 timeline + runtime 注入。
 * 共享服务来自 SessionPaneServices；Tab 栏由 App 外置统一挂载。
 */
export function ChatSessionPane(props: ChatSessionPaneProps) {
	const { sessionId, focused, onFocusPane, splitPane = false } = props;
	const services = useSessionPaneServices();
	const setPendingMessageJump = useSetAtom(pendingMessageJumpAtom);
	const pendingJump = useAtomValue(pendingMessageJumpAtom);

	const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const sessionTitle = record?.title?.trim() || t("app.chatProject");

	const sessionTimeline = useSessionTimelineController({ sessionId });

	// 会话内查找（Ctrl/Cmd+Shift+F）：openSignal 自增即请求浮层展开并聚焦输入框。
	// 打开请求按会话 id 计数（atoms/session-find-atoms.ts）：头部放大镜按钮与本栏快捷键
	// 写同一份信号，浮层只订阅本会话的那一格。
	// 只有聚焦栏响应快捷键——分屏时按键作用于用户正在看的那一栏。
	const findSignal = useAtomValue(sessionFindOpenRequestsAtom)[sessionId] ?? 0;
	const requestSessionFind = useSetAtom(requestSessionFindAtom);
	useEffect(() => {
		if (!focused) return;
		return desktopApi.app.onShortcutTriggered((id) => {
			if (id !== "findInSession") return;
			requestSessionFind(sessionId);
		});
	}, [focused, requestSessionFind, sessionId]);

	const localHeaderRef = useRef<HTMLDivElement | null>(null);
	const localComposerRef = useRef<HTMLElement | null>(null);
	const localQueuedTrackRef = useRef<HTMLElement | null>(null);

	const layoutRefs = services.layoutRefs;
	const chatHeaderRef = focused ? layoutRefs.chatHeaderRef : localHeaderRef;
	const composerRef = focused ? layoutRefs.composerRef : localComposerRef;

	// 会话内查找按后端有检索源才挂入口：pi 走会话 JSONL 索引，DSH 走 host 历史投影；
	// ACP/生图没有可检索历史、草稿会话（pi 未落盘 / DSH 未建 host 会话）还没有内容，
	// 都不挂入口（否则会出现一个永远「没有匹配」的搜索框、图标悬在欢迎页上）。
	// 判据与 SessionHeader 的放大镜入口共用（utils/sessionFindSupport），入口在就一定挂得上浮层。
	const findSupported = supportsSessionFind(record);

	const activeQueuedPrompts = services.queuedPromptsBySession[sessionId] ?? [];

	useEffect(() => {
		if (!focused) return;
		services.jumpToMessageRef.current = sessionTimeline.jumpToMessage;
		return () => {
			if (services.jumpToMessageRef.current === sessionTimeline.jumpToMessage) {
				services.jumpToMessageRef.current = null;
			}
		};
	}, [focused, services.jumpToMessageRef, sessionTimeline.jumpToMessage]);

	// 跨会话正文搜索的落地跳转：目标 pane 聚焦且 jump 挂好后消费一次。
	// 消息尚未加载（messages 空且未确认空会话）时先不消费：加载完成后
	// jumpToMessage 引用随 combinedMessages 更新，本 effect 重触发重试；
	// jumpToMessage 内部另有补页/扩窗挂起策略处理「目标在未加载历史页」的情况。
	useEffect(() => {
		if (!focused || !pendingJump || pendingJump.sessionId !== sessionId) return;
		if (sessionTimeline.messages.length === 0 && !sessionTimeline.knownEmpty) return;
		sessionTimeline.jumpToMessage(pendingJump.messageId);
		setPendingMessageJump(null);
	}, [focused, pendingJump, sessionId, sessionTimeline.jumpToMessage, sessionTimeline.messages, sessionTimeline.knownEmpty, setPendingMessageJump]);

	const layout = useMemo(
		() => ({
			chatHeaderRef,
			composerRef,
			composerOffsetHeight: focused ? layoutRefs.composerOffsetHeight : 0,
			terminalRowHeight: layoutRefs.terminalRowHeight,
		}),
		[chatHeaderRef, composerRef, focused, layoutRefs],
	);

	return (
		<>
			{findSupported && (
				<SessionFindOverlay
					// 会话切换必须重挂：单栏模式下 pane 实例跨会话复用（App.tsx 的 solo 分支没有 key），
					// 不重挂会把上一个会话的搜索框+关键词带过来，一切会话就自己搜起来。
					key={sessionId}
					// 传稳定会话 id（不是会话文件路径）：主进程按 catalog 的后端分派检索源，
					// pi/DSH 共用同一条 IPC，渲染层不感知后端差异。
					sessionId={sessionId}
					// 锚点是本栏消息区（时间线视口）而不是整栏聊天区：分屏时两栏各贴自己的右上角，
					// 单栏时也不会落到窗口控件那一行（理由见 sessionFindAnchor）。
					anchorRef={sessionTimeline.timelineRef}
					openSignal={findSignal}
					onJump={(messageId) => {
						sessionTimeline.jumpToMessage(messageId);
					}}
				/>
			)}
			<SessionRuntimeInjector
				currentSessionId={sessionId}
				sessionTitle={sessionTitle}
				sessionTimeline={sessionTimeline}
				splitPane={splitPane}
				focused={focused}
				onFocusPane={onFocusPane}
				chatHeaderRef={layout.chatHeaderRef}
				composerRef={layout.composerRef}
				composerOffsetHeight={layout.composerOffsetHeight}
				terminalRowHeight={layout.terminalRowHeight}
				activeQueuedPrompts={activeQueuedPrompts}
				queuedTrackRef={localQueuedTrackRef}
			/>
		</>
	);
}
