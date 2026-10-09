import { clearTimeout, setTimeout } from "node:timers";
import { ipcChannels } from "../../shared/ipc";
import { stripBridgeAnsi } from "../../shared/bridgeText";
import { looksLikePiSessionFileStem } from "./agentUtils";

/** AgentManager 拆分 Wave 4B：宿主回调只暴露事件广播、runtime 访问与 abort 标记。 */
export interface ExtensionUiHost {
	/** 广播 agentsUiRequest（渲染层提问卡/toast/widget 通道）。 */
	emitUiRequest(payload: Record<string, unknown>): void;
	/** 取 agent 的 tab 身份（auto-title marker 需要 sessionId + runtimeGeneration 严格匹配）。 */
	getRuntimeTab(agentId: string): { sessionId?: string; runtimeGeneration?: number } | undefined;
	/** 取 agent 的 RPC client 写入口（extension_ui_response 直写 pi stdin）。 */
	getClient(agentId: string): { sendRaw(payload: unknown): void } | undefined;
	/** abort 期取消提问时标记（AgentManager.abortedDuringAsk，委托工具卡回放用）。 */
	markAbortedDuringAsk(agentId: string): void;
	/** 主进程 warn 日志（请求超时取消用）。 */
	warn(message: string, data?: Record<string, unknown>): void;
}

/** 自动命名 marker：扩展 setStatus(pideck:auto-title) 后紧随 setSessionName 才可领取（#266）。 */
export interface PendingAutomaticTitle {
	title: string;
	sessionId: string;
	runtimeGeneration: number;
}

/** 请求拥有自己的超时句柄，回答、取消、替换和 runtime 销毁时一并释放。 */
type PendingUiRequest = {
	method: string;
	title: string;
	raisedAt: number;
	timer?: ReturnType<typeof setTimeout>;
};

/**
 * 扩展 UI 请求闸（AgentManager 拆分 Wave 4B，2027-02 从 AgentManager 迁出，行为零变化）。
 *
 * 处理 pi 扩展发起的 UI 请求（extension_ui_request）：
 * 对话类请求（select/confirm/input/editor/batch_ask）写入消息流等待用户回答；
 * fire-and-forget 请求（notify/set_editor_text/setWidget/setStatus）只转发给渲染进程或忽略。
 *
 * **扩展文本在此统一剥 ANSI**：这些字段最终都渲染成 GUI 文本（toast / 输入框 /
 * 输入框上下方的 widget 卡 / 提问卡），而扩展常顺手 `ctx.ui.theme.fg()` 上色 ——
 * pi 的 `Theme.fg` 产的是真 ANSI，透传就是界面上的一行 `[38;2;…m` 乱码
 * （2026-09 事故，事故现场见 `shared/bridgeText.ts`）。用 `stripBridgeAnsi`
 * 而不是 `stripAnsi`：后者只认 CSI，OSC 超链接 / 字符集切换会残留。
 */
export class ExtensionUiGate {
	/**
	 * UI 请求兜底超时：pi 侧没有任何默认超时（createDialogPromise 只把 opts.timeout 原样透传，
	 * 扩展不传就是 undefined），pending 请求只在收到 extension_ui_response 时才 settle。
	 * 「扩展没传 timeout + PiDeck 没回包」会让 pi 永久阻塞在读取 stdin 上——表现为工具
	 * 返回后卡住、只有点「停止」才解开（abort → cancelPendingUIRequests 发 value:null）。
	 * 这里给一个足够宽松的上限兜底，保证 pi 不会被永久卡死；扩展显式指定的 timeout 优先。
	 * 30 分钟远大于正常人工思考时间，且定时器回调只在请求仍 pending 时才真正取消，
	 * 用户已作答/已取消的请求不受影响。
	 */
	private static readonly DEFAULT_UI_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

	/**
	 * 待处理的 Extension UI 请求。key 为 agentId，value 为 Map<requestId, { method, title, raisedAt }>。
	 * 用于在 abort 时及时发送 cancellation 防止 pi 等待超时；raisedAt 记录提问弹起时刻，
	 * 供 ask_question 工具耗时扣除用户等待时间（exclude_wait）使用。
	 */
	private readonly pendingUIRequests = new Map<string, Map<string, PendingUiRequest>>();
	/**
	 * 各 agent 已累计的 ask 用户等待毫秒数（raisedAt→回答时刻）。
	 * 工具耗时（durationMs）应只算 agent 实际处理时长，不含用户盯着问卷思考的时间；
	 * ask_question 工具结束时从中扣除并清零，工具开始新一轮时也清零防泄漏到后续工具。
	 */
	private readonly askWaitMsByAgent = new Map<string, number>();
	/** Extension marker recorded immediately before its own setSessionName call. */
	private readonly pendingAutomaticTitles = new Map<string, PendingAutomaticTitle>();

	constructor(private readonly host: ExtensionUiHost) {}

	/** pi 事件入口：extension_ui_request 分发（原 AgentManager.handleUIRequest）。 */
	handleUIRequest(agentId: string, typed: Record<string, unknown>) {
		const method = String(typed.method ?? "");
		const requestId = String(typed.id ?? "");
		// pi RPC 协议将 setWidget / dialog 字段放在顶层，不嵌套 params
		if (method === "notify") {
			this.host.emitUiRequest({
				agentId,
				requestId,
				method,
				title: "",
				// 扩展的 notify 消息常带终端颜色转义（如 billion-context-pi 的更新通知
				// `\x1B[32m✔ ACP auto-updated ...\x1B[0m`），toast 不是终端，直接透传会显示乱码转义符，
				// 在进程边界统一清洗后再交给渲染层。
				message: stripBridgeAnsi(String(typed.message ?? "")),
				notifyType: typed.notifyType,
			});
			return;
		}

		if (method === "set_editor_text") {
			this.host.emitUiRequest({
				agentId,
				requestId,
				method,
				title: "",
				// 写进 composer 输入框的文本：同样不能带转义码
				text: stripBridgeAnsi(String(typed.text ?? "")),
			});
			return;
		}

		if (method === "setWidget") {
			// Plan Mode 等扩展会频繁刷新 widget；只走 IPC 状态，不落入会话消息，避免 JSONL 被进度噪声污染。
			// ★ 字符串形式保持原路（§14.4），因此**不过桥的出帧净化口** —— 渲染层会把这些行
			// 原样画进输入框上下方的 widget 卡（ComposerComponents.renderWidgetLine），
			// 带码就是乱码，所以在进程边界逐行剥掉。
			this.host.emitUiRequest({
				agentId,
				requestId,
				method,
				title: "",
				widgetKey: String(typed.widgetKey ?? requestId),
				widgetLines: Array.isArray(typed.widgetLines) ? typed.widgetLines.map((line) => stripBridgeAnsi(String(line))) : undefined,
				widgetPlacement: typed.widgetPlacement,
			});
			return;
		}
		if (method === "setStatus") {
			const statusKey = typeof typed.statusKey === "string" ? typed.statusKey : "";
			if (statusKey === "pideck:auto-title") {
				const title = typeof typed.statusText === "string" ? typed.statusText.replace(/\s+/g, " ").trim() : "";
				const tab = this.host.getRuntimeTab(agentId);
				if (title && !looksLikePiSessionFileStem(title) && tab?.sessionId && typeof tab.runtimeGeneration === "number") {
					this.pendingAutomaticTitles.set(agentId, {
						title,
						sessionId: tab.sessionId,
						runtimeGeneration: tab.runtimeGeneration,
					});
				}
			}
			return;
		}

		// 其他非对话 UI 方法暂不占用桌面 UI 空间。
		if (method === "setTitle") return;
		if (!["select", "confirm", "input", "editor"].includes(method)) return;

		// Batch ask_question sends its form as an input title envelope. Decode it at
		// the process boundary so no renderer can mistake the raw JSON for a prompt.
		const rawTitle = String(typed.title ?? typed.question ?? "");
		const batchEnvelope = this.tryParseBatchAskEnvelope(rawTitle);
		const rawOptions = Array.isArray(typed.options) ? typed.options.filter((option): option is string => typeof option === "string") : undefined;
		// The bundled extension appends this marker for non-desktop clients. Replace it
		// with the desktop's own inline field so selecting custom text never opens a
		// second request above the composer.
		const hasCustomOption = rawOptions?.some((option) => option.startsWith("✎")) ?? false;
		const effectiveOptions = hasCustomOption ? rawOptions?.filter((option) => !option.startsWith("✎")) : rawOptions;
		// select 无有效选项时降级为 input 而不是静默取消：ask_question 的 options 是
		// 可选的，模型经常只问问题不给选项——自动取消会让用户完全看不到提问 UI。
		// 降级后问题文本保留为标题，用户仍可输入文字回答。
		const effectiveMethod = method === "select" && (!effectiveOptions || effectiveOptions.length === 0) ? "input" : method;
		const request = batchEnvelope
			? {
					agentId,
					requestId,
					method: "batch_ask" as const,
					title: "",
					batchQuestions: batchEnvelope.questions,
					batchReview: batchEnvelope.review,
				}
			: {
					agentId,
					requestId,
					method: effectiveMethod,
					title: rawTitle,
					options: effectiveOptions,
					placeholder: typed.placeholder as string | undefined,
					prefill: typed.prefill as string | undefined,
					allowOther: typed.allowOther === true || hasCustomOption,
				};

		// 记录 pending UI 请求，用于 abort 时自动 cancel；raisedAt 同时作为用户等待计时起点
		if (!this.pendingUIRequests.has(agentId)) {
			this.pendingUIRequests.set(agentId, new Map());
		}
		const pending = this.pendingUIRequests.get(agentId)!;
		this.clearUIRequestTimeout(pending.get(requestId));
		pending.set(requestId, {
			method: effectiveMethod,
			title: request.title,
			raisedAt: Date.now(),
		});

		// 先武装再广播：宿主可能同步取消未绑定的提问，不能在取消后重新挂上 timer。
		this.scheduleUIRequestTimeout(agentId, requestId, typed.timeout);
		// The session runtime owns pending UI. Do not write an additional system
		// message, because that creates a second interactive card in the timeline.
		this.host.emitUiRequest(request);
		// 桌面通知由 SessionRuntimeCoordinator 统一触发（非聚焦会话才提醒，避免打扰正在看当前会话的用户）；
		// 此处不重复发，防止一条提问出现两条通知。
	}

	/**
	 * 结算一次 ask 的用户等待时长（answer 时刻 - 提问弹起时刻），累加到该 agent 的
	 * 等待累计值（askWaitMsByAgent）。调用时机 = 用户回答 / 超时 / abort 取消，
	 * 与 pendingUIRequests 中该请求的删除成对，避免重复结算。
	 * 用途：ask_question 工具耗时（durationMs）要排除用户思考时间，只展示 agent 处理时长。
	 */
	private settleAskWait(agentId: string, requestId: string) {
		const entry = this.pendingUIRequests.get(agentId)?.get(requestId);
		if (!entry || typeof entry.raisedAt !== "number") return;
		const waitMs = Math.max(0, Date.now() - entry.raisedAt);
		this.askWaitMsByAgent.set(agentId, (this.askWaitMsByAgent.get(agentId) ?? 0) + waitMs);
	}

	/**
	 * 发送 Extension UI 响应（extension_ui_response）到 pi 的 stdin。
	 * 同时更新对应卡片消息的状态。
	 */
	sendUIResponse(agentId: string, requestId: string, response: { value?: string | boolean; cancelled?: boolean; confirmed?: boolean }) {
		const client = this.host.getClient(agentId);
		if (!client) return;

		// 写入 extension_ui_response 到 pi 的 stdin

		const extPayload: Record<string, unknown> = {
			type: "extension_ui_response",
			id: requestId,
			value: response.value,
		};
		// pi 的 ctx.ui.confirm() 检查 confirmed 字段，ctx.ui.select/input 检查 value
		if ("confirmed" in response) extPayload.confirmed = response.confirmed;
		// 取消时发 cancelled: true
		if (response.cancelled) extPayload.cancelled = true;
		client.sendRaw(extPayload);

		// 结算用户等待时长（回答时刻），供该 ask 所属工具耗时扣除
		this.settleAskWait(agentId, requestId);

		// 清理 pending 记录
		const pending = this.pendingUIRequests.get(agentId);
		if (pending) {
			this.clearUIRequestTimeout(pending.get(requestId));
			pending.delete(requestId);
			if (pending.size === 0) this.pendingUIRequests.delete(agentId);
		}

		// 通知渲染进程 UI 请求已完成
		this.host.emitUiRequest({ agentId, requestId, completed: true, ...response });
	}

	/**
	 * abort / 未作答直接发送新消息共用：向 pi 发 value:null 解除 extension_ui_response 阻塞。
	 * 语义与完整 abort 不同：不终止回合、不清流式状态，只解除提问阻塞。
	 * 发 value: null（不带 cancelled 标记），select parser 返回 null，
	 * 工具 result 的 answer = null、answered = false → 历史卡片显示"已取消"；
	 * 同时广播 completed+cancelled 让渲染层立即移除纯运行时交互。
	 */
	cancelPendingUIRequests(agentId: string): void {
		const pending = this.pendingUIRequests.get(agentId);
		if (!pending || pending.size === 0) return;
		const client = this.host.getClient(agentId);
		if (!client) return;
		this.host.markAbortedDuringAsk(agentId);
		for (const [requestId, request] of pending) {
			// 视作用户在此刻结束等待：结算等待时长，供该 ask 工具耗时扣除
			this.settleAskWait(agentId, requestId);
			client.sendRaw({
				type: "extension_ui_response",
				id: requestId,
				value: null,
			});
			this.clearUIRequestTimeout(request);
			// extension 收到 null 保持其取消语义；渲染层必须立即移除纯运行时交互
			this.host.emitUiRequest({
				agentId,
				requestId,
				completed: true,
				cancelled: true,
			});
		}
		// pending dialogs 是纯运行时状态，清空请求表即可
		this.pendingUIRequests.delete(agentId);
	}

	private tryParseBatchAskEnvelope(title: string):
		| {
				review: boolean;
				questions: Array<Record<string, unknown>>;
		  }
		| undefined {
		const raw = title.trim();
		if (!raw.startsWith("{")) return undefined;
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			if (parsed.__piDeckBatchAsk !== 1 || !Array.isArray(parsed.questions)) {
				return undefined;
			}
			const questions = parsed.questions.filter((question): question is Record<string, unknown> => {
				if (!question || typeof question !== "object") return false;
				const typed = question as Record<string, unknown>;
				return typeof typed.id === "string" && typeof typed.question === "string" && ["select", "multi_select", "confirm", "input", "editor"].includes(String(typed.type));
			});
			return questions.length > 0 ? { review: parsed.review === true, questions } : undefined;
		} catch {
			return undefined;
		}
	}

	/** 释放请求的超时资源；重复清理和已自然到期的请求都安全。 */
	private clearUIRequestTimeout(request: PendingUiRequest | undefined): void {
		if (!request?.timer) return;
		clearTimeout(request.timer);
		delete request.timer;
	}

	private scheduleUIRequestTimeout(agentId: string, requestId: string, timeout: unknown) {
		const pending = this.pendingUIRequests.get(agentId)?.get(requestId);
		if (!pending) return;
		// 扩展显式指定且合法时优先用它；否则退回兜底上限，避免 pi 永久阻塞（见常量注释）。
		const explicitTimeout = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : undefined;
		const effectiveTimeout = explicitTimeout ?? ExtensionUiGate.DEFAULT_UI_REQUEST_TIMEOUT_MS;

		const timer = setTimeout(() => {
			// 同名请求可被替换：旧回调只能结算它原本拥有的请求，不能取消后来者。
			if (this.pendingUIRequests.get(agentId)?.get(requestId) !== pending) return;
			this.clearUIRequestTimeout(pending);
			// A timeout must close both ends of the protocol. Merely hiding the
			// renderer form leaves Pi blocked on extension_ui_response indefinitely.
			this.host.warn("Extension UI request timed out; cancelling to unblock pi", {
				agentId,
				requestId,
				timeoutMs: effectiveTimeout,
				explicitTimeout: explicitTimeout != null,
			});
			this.sendUIResponse(agentId, requestId, { cancelled: true });
		}, effectiveTimeout);
		pending.timer = timer;
		timer.unref?.();
	}

	// ---- AgentManager 编排面的窄访问器 ----

	/** 空闲判定用：该 agent 是否还有未回答的提问（markIdleIfPiReportsNoWork 否决条件）。 */
	hasPendingUIRequests(agentId: string): boolean {
		return (this.pendingUIRequests.get(agentId)?.size ?? 0) > 0;
	}

	/** ask_question 工具结束：取走累计等待毫秒数并清零（durationMs 扣除用户思考时间）。 */
	consumeAskWaitMs(agentId: string): number {
		const askWaitMs = this.askWaitMsByAgent.get(agentId) ?? 0;
		if (askWaitMs > 0) this.askWaitMsByAgent.delete(agentId);
		return askWaitMs;
	}

	/** 新工具轮次开始：清空旧等待累计（防止算进后续工具耗时）。 */
	clearAskWait(agentId: string): void {
		this.askWaitMsByAgent.delete(agentId);
	}

	/** session_info_changed：取走 auto-title marker（get+delete 原子形态保持）。 */
	takeAutomaticTitle(agentId: string): PendingAutomaticTitle | undefined {
		const marker = this.pendingAutomaticTitles.get(agentId);
		this.pendingAutomaticTitles.delete(agentId);
		return marker;
	}

	/** 会话替换（fork/编辑后重绑）：旧 runtime 的 auto-title marker 不得授权新 catalog 记录。 */
	clearAutomaticTitle(agentId: string): void {
		this.pendingAutomaticTitles.delete(agentId);
	}

	/** 生命周期清理：clearAgentState 路径（提问表 + auto-title marker）。 */
	clearAgent(agentId: string): void {
		for (const request of this.pendingUIRequests.get(agentId)?.values() ?? []) {
			this.clearUIRequestTimeout(request);
		}
		this.pendingUIRequests.delete(agentId);
		this.pendingAutomaticTitles.delete(agentId);
	}
}
