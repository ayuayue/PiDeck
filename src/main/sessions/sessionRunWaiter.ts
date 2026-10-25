/**
 * 后端无差别的「回合等待器」——IM 桥接判断「这一轮跑完没、成没成」的唯一入口。
 *
 * 为什么不能继续用 pi 的 agent_end：微信/飞书桥原先挂在 pi 本地事件上
 * （`AgentManager.addLocalEventListener` + `pickAgentEndError`），这不是通用契约——
 * DSH 不产生 agent_end（回合结束走 turn/end，控制态回落 idle），ACP 连流式事件都没有。
 * 通道要支持换后端，终态判定就必须收口到「会话运行时事件」这一层。
 *
 * 终态契约照抄自动化运行协调器（AutomationRunCoordinator.handleTrackerEvent，那边已在
 * pi/DSH 双后端跑过）：
 *   - 终态只认 agents:state（AgentTab 全量快照）：
 *       running → 回合开始过（DSH 控制态只有 idle/running，turn/start 时必发快照）
 *       idle + 回合开始过 → 完成
 *       error → 失败（payload.error）
 *       closed → 失败（进程在回合结束前退出）
 *   - pi 的回合开始证据来自 agents:runtime-state 的 `isTurnActive === true`
 *     （agent_start 边沿；pi 只在 settled/error/退出时发 agents:state，不一定有 running 快照）。
 *   - `isTurnActive === false` 与其它局部补丁都不作完成信号：那些补丁只有流式/工具字段时
 *     不代表回合结束，提前收口会让上游以为跑完了（自动化协调器有事故记录：会杀掉进程、
 *     会话文件来不及落盘）。
 *
 * DSH 的失败不带 error 快照：它在 turn/end 时往时间线追加一条 `role: "error"` 消息
 * （dshEventProjector）。因此 idle 收口时再看一眼本回合新增的消息——最后一条
 * assistant/error 消息如果是 error，这一轮就是失败（pi 没有这种消息，扫描对它恒为 no-op）。
 */

import { clearTimeout as clearNodeTimeout, setTimeout as nodeSetTimeout } from "node:timers";
import type { ChatMessage, SessionRuntimeEvent } from "../../shared/types";

export type SessionRunOutcome = { kind: "ended"; failed: boolean; errorMessage?: string } | { kind: "timeout" };

export interface SessionRunWaitInput {
	sessionId: string;
	/** 本轮开始前时间线的条数：收口时只扫这个下标之后的新消息（DSH 失败检测）。 */
	sinceIndex: number;
	timeoutMs: number;
}

export interface SessionRunWaiterDeps {
	/** 订阅会话运行时事件；返回退订函数（必须幂等调用）。 */
	subscribe(listener: (event: SessionRuntimeEvent) => void): () => void;
	/** 会话当前 runtime 的消息（无 runtime 返回空数组）。 */
	getMessages(sessionId: string): ChatMessage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 等一个回合收口。调用方必须在提交 prompt **之前**登记等待器，否则起跑瞬间的
 * 终态事件会落在注册之前（原先的 endedAgents/lateRuns 兜底就是为这个竞态打的补丁；
 * 先注册后提交就不需要它们）。
 */
export function waitForSessionRunEnd(deps: SessionRunWaiterDeps, input: SessionRunWaitInput): Promise<SessionRunOutcome> {
	return new Promise<SessionRunOutcome>((resolve) => {
		let settled = false;
		let turnStarted = false;
		let unsubscribe: (() => void) | undefined;
		let timer: NodeJS.Timeout | undefined;

		const finish = (outcome: SessionRunOutcome): void => {
			if (settled) return;
			settled = true;
			if (timer) clearNodeTimeout(timer);
			timer = undefined;
			unsubscribe?.();
			unsubscribe = undefined;
			resolve(outcome);
		};

		/**
		 * 收口时读一手时间线：本回合最后一条 assistant/error 消息决定成败
		 * （最后一条不是 error 而是 assistant = 中途报错后重试成功）。
		 *
		 * 为什么先扫消息再回退 payload.error：两家的失败文本都落在 role="error" 消息里
		 * （pi 的 addDetailedErrorMessage / addMessage(...,"error",...)；DSH 的 dshEventProjector），
		 * 而 AgentTab.error 实际上没人在回合失败时写——不回消息文本的话用户只能看到一句「Runtime error」。
		 *
		 * statusFailed 是 error 快照带来的：那种情况已经确定失败，消息只负责让文本更具体；
		 * 时间线上什么都没有也必须报失败，不能因为「没找到错误消息」被判成成功。
		 */
		const finishFromMessages = (statusErrorMessage?: string, statusFailed = false): void => {
			const finishFailed = (text?: string): void => {
				finish(text ? { kind: "ended", failed: true, errorMessage: text } : { kind: "ended", failed: true });
			};
			let messages: ChatMessage[] = [];
			try {
				messages = deps.getMessages(input.sessionId);
			} catch {
				// 读消息失败不该让等待器悬挂：按状态收口（交付阶段会再读一次）。
				if (statusFailed) finishFailed(statusErrorMessage);
				else finish({ kind: "ended", failed: false });
				return;
			}
			for (let index = messages.length - 1; index >= input.sinceIndex && index >= 0; index -= 1) {
				const message = messages[index];
				if (!message) continue;
				if (message.role === "error") {
					const text = typeof message.text === "string" ? message.text.trim() : "";
					finishFailed(text || statusErrorMessage);
					return;
				}
				if (message.role === "assistant") break;
			}
			if (statusFailed) finishFailed(statusErrorMessage);
			else finish({ kind: "ended", failed: false });
		};

		const handleEvent = (event: SessionRuntimeEvent): void => {
			if (settled || event.sessionId !== input.sessionId) return;
			const payload = isRecord(event.payload) ? event.payload : undefined;
			if (!payload) return;
			const channel = typeof event.sourceChannel === "string" ? event.sourceChannel : "";
			// agents:runtime-state：只认显式 isTurnActive === true 作为「回合开始过」的证据。
			if (channel.includes("runtime-state")) {
				const state = isRecord(payload.state) ? payload.state : undefined;
				if (state?.isTurnActive === true) turnStarted = true;
				return;
			}
			// agents:state 快照（全量 tab）：终态判定唯一依据。
			if (!channel.includes("state")) return;
			const status = payload.status;
			if (status === "running") {
				turnStarted = true;
				return;
			}
			if (status === "error") {
				const errorMessage = typeof payload.error === "string" && payload.error.trim() ? payload.error : undefined;
				finishFromMessages(errorMessage, true);
				return;
			}
			if (status === "closed") {
				finish({ kind: "ended", failed: true, errorMessage: "Runtime process exited before the run finished" });
				return;
			}
			// 必须确认回合真的开始过：否则提交前残留的空闲快照会把这一轮直接判成完成。
			if (status === "idle" && turnStarted) finishFromMessages();
		};

		unsubscribe = deps.subscribe(handleEvent);
		timer = nodeSetTimeout(() => finish({ kind: "timeout" }), input.timeoutMs);
		// 主进程常驻、测试进程短命：不 unref 的话一个挂着等超时的等待器会拖住 node --test 退出。
		timer.unref?.();
	});
}
