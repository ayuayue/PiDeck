/**
 * DSH 运行态控制：把「回合是否还在跑 / 停止后是否还吃迟到流」收成纯函数。
 *
 * 根因：渲染层 sendPrompt 接受后会把 runtime.status 钉成 running；
 * DSH tab.status 一直是 idle，也不会在 turn/end 回写 idle。
 * abort 只清 isStreaming，迟到的 assistant/chunk / turn/start 又能把流拉起来，
 * composer 的 isBusy = status===running || isStreaming 就停不下来。
 */

export type DshControlStatus = "idle" | "running";

export type DshControlState = {
	status: DshControlStatus;
	isStreaming: boolean;
	/** 每次用户 abort 递增；mux 帧必须带着当时的世代，否则当迟到流丢掉。 */
	cancelGeneration: number;
	cancelled: boolean;
};

export type DshControlEventKind = "turn/start" | "turn/end" | "assistant/chunk" | "assistant/message" | "user/message" | "other";

export function classifyDshControlEvent(type: string | undefined): DshControlEventKind {
	if (type === "turn/start") return "turn/start";
	if (type === "turn/end") return "turn/end";
	if (type === "assistant/chunk") return "assistant/chunk";
	if (type === "assistant/message") return "assistant/message";
	if (type === "user/message") return "user/message";
	return "other";
}

/**
 * 用户点停止：抬世代、清流式，等 turn/end 再真正解除 cancelled。
 * 已 idle 且无流式时无事可取消：保持原状态（否则 cancelled 永远等不到 turn/end，
 * 后续 sendPrompt 的 waitForIdle 会被 cancelled 卡满超时）。
 */
export function beginDshCancel(prev: DshControlState): DshControlState {
	if (prev.status === "idle" && !prev.isStreaming) {
		return prev;
	}
	return {
		status: "idle",
		isStreaming: false,
		cancelGeneration: prev.cancelGeneration + 1,
		cancelled: true,
	};
}

/**
 * 一帧 mux 事件对控制态的影响。
 * `eventGeneration` 是泵在读到该帧时快照的 cancelGeneration。
 * `data` 为事件 data（assistant/message 需要检查内容块：带 tool-call 的消息不是
 * 回合终点，工具执行与后续 LLM 流仍在同一回合内，不能提前回 idle）。
 */
export function applyDshControlEvent(prev: DshControlState, type: string | undefined, eventGeneration: number, data?: unknown): { next: DshControlState; ignoreStream: boolean } {
	// 停止之后才到的旧帧：禁止重新点亮 streaming/running；turn/end 仍用来收口 cancelled。
	if (eventGeneration !== prev.cancelGeneration) {
		const kind = classifyDshControlEvent(type);
		if (kind === "turn/end" && prev.cancelled) {
			return {
				next: {
					...prev,
					status: "idle",
					isStreaming: false,
					cancelled: false,
				},
				ignoreStream: true,
			};
		}
		return { next: prev, ignoreStream: true };
	}

	const kind = classifyDshControlEvent(type);
	// 本回合已被取消、turn/end 尚未到达：旧回合的迟到事件一律丢弃，
	// 只放行两类——turn/end（收口 cancelled）与 user/message（用户消息文本不能丢）。
	// 若放行 assistant/message / chunk / tool 事件，停止后旧回合的终态回答、工具卡片
	// 与迟到 delta 会继续点亮 streaming（「停止了还在跑」），或被拼接进下一条消息
	// （「消息串台」）。host 侧 cancel 只中断 LLM phase、不中断运行中的工具，
	// 旧回合残留事件只能靠这里丢弃。
	if (prev.cancelled) {
		if (kind === "turn/end") {
			return {
				next: {
					...prev,
					status: "idle",
					isStreaming: false,
					cancelled: false,
				},
				ignoreStream: true,
			};
		}
		if (kind === "user/message") {
			return { next: prev, ignoreStream: false };
		}
		return { next: prev, ignoreStream: true };
	}

	if (kind === "turn/start") {
		return {
			next: {
				...prev,
				status: "running",
				isStreaming: true,
				cancelled: false,
			},
			ignoreStream: false,
		};
	}
	if (kind === "assistant/chunk") {
		return {
			next: { ...prev, status: "running", isStreaming: true },
			ignoreStream: false,
		};
	}
	if (kind === "assistant/message") {
		if (isAssistantMessageWithToolCalls(data)) {
			// DSH 事件顺序（dsh-agent-loop 实测）：LLM 流结束先落 assistant/message
			// （内容块含 tool-call），之后才是 tool/call → 工具执行 → tool/result →
			// 下一轮 LLM 流。带工具调用的消息只是「本轮模型输出」结束，回合仍在跑：
			// 保持 running（只收流式标记），否则工具执行期间 UI 提前回 idle——
			// 发送按钮变回「发送」、页面无运行动画，用户误以为会话已停止。
			return {
				next: { ...prev, isStreaming: false, cancelled: false },
				ignoreStream: false,
			};
		}
		return {
			next: {
				...prev,
				status: "idle",
				isStreaming: false,
				cancelled: false,
			},
			ignoreStream: false,
		};
	}
	if (kind === "turn/end") {
		return {
			next: {
				...prev,
				status: "idle",
				isStreaming: false,
				cancelled: false,
			},
			ignoreStream: false,
		};
	}
	return { next: prev, ignoreStream: false };
}

/** assistant/message 的内容块里是否含工具调用（type === "tool-call"）。 */
function isAssistantMessageWithToolCalls(data: unknown): boolean {
	if (!data || typeof data !== "object") return false;
	const message = (data as { message?: unknown }).message;
	if (!message || typeof message !== "object") return false;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	return content.some((block) => block !== null && typeof block === "object" && (block as { type?: unknown }).type === "tool-call");
}
