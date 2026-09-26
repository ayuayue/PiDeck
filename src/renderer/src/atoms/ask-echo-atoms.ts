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
 * 失效判据由消费端（SessionAskEcho）负责：runtime 换代、新的 pending ask、
 * 或用户又发了新消息（userMessageCount 增长）即不再展示。
 */
export type AskEchoEntry = {
	echo: AskEcho;
	/** 应答发生时的 runtime 绑定：换代（重启/重绑）后回显作废 */
	agentId: string;
	runtimeGeneration: number;
	/** 写入时刻会话内 user 消息数：用户开始下一轮发言即回显过期 */
	userMessageCount: number;
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
	let userMessageCount = 0;
	for (const message of messages) {
		if (message.role === "user") userMessageCount += 1;
	}
	set(askEchoBySessionAtom, {
		...get(askEchoBySessionAtom),
		[input.sessionId]: { echo, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration, userMessageCount },
	});
});
