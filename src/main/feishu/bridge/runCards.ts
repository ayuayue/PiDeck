/**
 * bridge/runCards — 流式卡片的回放与回合等待。
 *
 * 从 FeishuBridge.ts 原样搬出的一域：卡片创建窗口内缓存的 Agent 事件回放、
 * 以及提前登记的 agent_end 等待器（返回是否超时）。
 *
 * Session Mirror 的开卡逻辑与 handleAgentEvent 的终态收尾仍留在宿主：它们是
 * 同一批注册表的读写方（卡片创建窗口、终态 flush 顺序都必须逐行可读）。
 */

import type { CardStream } from "../CardStream";
import { createInitialState, markInterrupted, reduceFromPiEvent, type RunState } from "../CardRunState";
import { renderRunCard } from "../CardRenderer";
import { feishuT, type FeishuLocale } from "../FeishuI18n";
import { log } from "./bridgeLog";

/** 协作者对宿主的最小依赖面：卡片注册表 + 事件订阅 + 思考块开关。 */
export type FeishuRunCardsHost = {
	locale: () => FeishuLocale;
	getShowThinking: () => boolean;
	streamingCards: Map<string, CardStream>;
	streamingRunStates: Map<string, RunState>;
	pendingCardEvents: Map<string, unknown[]>;
	addLocalEventListener: (handler: (agentId: string, event: unknown) => void) => () => void;
};

export class FeishuRunCards {
	constructor(private readonly host: FeishuRunCardsHost) {}

	/**
	 * 新建一次运行的状态机。showThinking 在建状态时就定下来：关闭时 reducer 连思考增量都不累积（#425）。
	 * resolver 抛错按「显示」处理，保持与历史行为一致 —— 卡片缺一块比整轮不推要好。
	 */
	newRunState(): RunState {
		let showThinking = true;
		try {
			showThinking = this.host.getShowThinking();
		} catch {
			showThinking = true;
		}
		return createInitialState({ showThinking });
	}

	/** 回放卡片创建期间缓存的 Agent 事件 */
	replayBufferedEvents(sessionId: string, cardStream: CardStream): void {
		const pending = this.host.pendingCardEvents.get(sessionId);
		if (!pending || pending.length === 0) {
			this.host.pendingCardEvents.delete(sessionId);
			return;
		}

		log(`[飞书 Bridge] 回放 ${pending.length} 个缓存事件到卡片`);
		let currentState = this.host.streamingRunStates.get(sessionId) ?? this.newRunState();
		for (const ev of pending) {
			const nextState = reduceFromPiEvent(currentState, ev as Record<string, unknown>, this.host.locale());
			if (nextState !== currentState) {
				currentState = nextState;
				this.host.streamingRunStates.set(sessionId, nextState);
				cardStream.update(
					renderRunCard(nextState, {
						locale: this.host.locale(),
						stopHint: nextState.terminal === "running" ? feishuT(this.host.locale(), "card.stopHint") : undefined,
					}),
				);
			}
		}
		this.host.pendingCardEvents.delete(sessionId);
	}

	waitForAgentEnd(sessionId: string, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				cleanup();
				resolve(true);
			}, timeoutMs);
			const handler = (agentId: string, event: unknown) => {
				if (agentId !== sessionId) return;
				if (!event || typeof event !== "object") return;
				if ((event as Record<string, unknown>).type === "agent_end") {
					cleanup();
					resolve(false);
				}
			};
			const unsub = this.host.addLocalEventListener(handler);
			const cleanup = () => {
				clearTimeout(timer);
				unsub();
			};
		});
	}

	stopSessionMirrorRun(agentId: string): void {
		const state = this.host.streamingRunStates.get(agentId);
		const card = this.host.streamingCards.get(agentId);
		if (state && card) {
			const finalState = markInterrupted(state);
			void card
				.flush(renderRunCard(finalState, { locale: this.host.locale() }))
				.then(() => card.close())
				.catch(() => {});
		}
		this.host.streamingCards.delete(agentId);
		this.host.streamingRunStates.delete(agentId);
		this.host.pendingCardEvents.delete(agentId);
	}
}
