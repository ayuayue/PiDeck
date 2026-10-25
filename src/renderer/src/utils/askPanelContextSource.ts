import type { createStore } from "jotai";
import { sessionMessageCacheBySessionIdAtomFamily } from "../atoms/session-atoms";
import { t } from "../i18n";
import { buildAskContextBlock } from "./askPanelContext";

/**
 * 按发起会话的消息缓存生成并行问询上下文块。
 *
 * 队列面板与输入框拆分菜单的「并行发送」必须共用同一套口径：只要调用方给了
 * originSessionId，就按该会话发送瞬间的消息快照生成上下文；某条入口漏传时，
 * 侧边会话会看不到主会话前因（#210）。读 store 而不是订阅 atom，避免每条流式
 * 消息都触发使用方重渲染。
 */
export function buildAskContextForSession(store: Pick<ReturnType<typeof createStore>, "get">, sessionId: string | undefined): string | null {
	if (!sessionId) return null;
	const messages = store.get(sessionMessageCacheBySessionIdAtomFamily(sessionId))?.messages ?? [];
	return buildAskContextBlock(messages, {
		title: t("askPanel.contextTitle"),
		userLabel: t("askPanel.contextUser"),
		assistantLabel: t("askPanel.contextAssistant"),
	});
}
