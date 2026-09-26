import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { AgentUiRequest, AgentUiResponse } from "../../../shared/types";
import { sessionMessageCacheBySessionIdAtomFamily } from "./session-atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "./session-selectors";
import { buildAskEcho, type AskEcho } from "../utils/askUi";

/**
 * DSH 已作答提问的回显条目（按会话存最新一条）。
 *
 * 为什么在渲染层而不是主进程：pi 路径的回显来自工具消息 meta._askCard（pi 自己落会话文件）；
 * DSH 的提问是带外 server-request，历史由 host 全量折叠投影，任何合成消息都会在下次
 * 投影同步时被冲掉，落盘既做不到也不该做。所以回显只活到「本页会话切走/重开」，
 * 承担「答案已送达」的即时反馈，不承担历史留痕。
 *
 * 展示位置由 anchorMessageId 决定：应答时刻时间线的最后一条消息即提问阻塞处，
 * 消费端（SessionMessageTimeline 分组前）把回显合成为 ask_question 工具消息
 * 插在该锚点之后，与 pi 的 _askCard 走同一渲染路径（工具调用处内联，而非钉尾部）。
 * 失效判据：runtime 换代即作废；锚点被投影/压缩改写找不到时同样不显示（宁缺不错位）。
 */
export type AskEchoEntry = {
	echo: AskEcho;
	/** 应答发生时的 runtime 绑定：换代（重启/重绑）后回显作废 */
	agentId: string;
	runtimeGeneration: number;
	/** 应答时刻时间线最后一条消息 id（内联插入锚点）；当时无消息则 undefined（插头部） */
	anchorMessageId?: string;
	/** 应答时刻（合成工具消息的展示时间戳） */
	answeredAt: number;
};

const askEchoBySessionAtom = atom<Record<string, AskEchoEntry>>({});

export const askEchoBySessionIdAtomFamily = atomFamily((sessionId: string) => atom((get) => get(askEchoBySessionAtom)[sessionId]));

/**
 * 记录一次已 accepted 的 ask 应答为回显。
 * 只服务 DSH 后端（pi 已有 _askCard 静态卡，双份会重复）；判据收在 atom 内部，
 * 调用点（SessionRuntimeInjector / AskPanelOverlay 的 responder.onAccepted）无须各自门控。
 */
export const recordAskEchoAtom = atom(null, (get, set, input: { sessionId: string; request: AgentUiRequest; response: AgentUiResponse }) => {
	const runtime = get(sessionRuntimeBySessionIdAtomFamily(input.sessionId));
	if (!runtime?.agentId || runtime.backend !== "dsh") return;
	const echo = buildAskEcho(input.request, input.response);
	if (!echo) return;
	const messages = get(sessionMessageCacheBySessionIdAtomFamily(input.sessionId))?.messages ?? [];
	// 应答瞬间时间线尾部即提问阻塞的工具调用位置：以最后一条消息 id 作内联锚点
	const anchorMessageId = messages[messages.length - 1]?.id;
	set(askEchoBySessionAtom, {
		...get(askEchoBySessionAtom),
		[input.sessionId]: { echo, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration, anchorMessageId, answeredAt: Date.now() },
	});
});
