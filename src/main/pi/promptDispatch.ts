import { parseBusySendDelivery } from "../../shared/busySendDelivery";
import { PI_DECK_MODE_MARKER_EXTENSIONS } from "../../shared/composerModeMarkers";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { AgentTab, ChatMessage, I18nParams, ImageContent, SendPromptInput, SendPromptResult } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";
import type { ExtensionUiGate } from "./extensionUiGate";
import type { MessagePerfTracker } from "./messagePerfTracker";
import type { PiProcess } from "./PiProcess";
import type { RpcResponse } from "./PiRpcClient";

/** 派发域读到的运行时切片（宿主 agents map 的值类型 `AgentRuntime`）。 */
type PromptRuntime = { tab: AgentTab; process: PiProcess };

/**
 * prompt 派发域的窄接口：只列 sendPrompt 真正用到的读取器与回调，不新增状态。
 *
 * `!`/`!!` 命令执行（`executeBashCommand`）与「pi 接受 prompt 后的收尾」
 * （`settleAcceptedPrompt`）仍属宿主的 bash 展示 / 空闲恢复域，按引用注入。
 */
export interface PromptDispatchHost {
	readonly settingsStore: SettingsStore;
	readonly appLogger?: AppLogger;
	readonly uiGate: ExtensionUiGate;
	readonly messagePerf: MessagePerfTracker;
	readonly translate: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	requireRuntime(agentId: string): PromptRuntime;
	piMightStillBeStreaming(agentId: string): boolean;
	settleAcceptedPrompt(agentId: string, runtime: PromptRuntime, agentMessage: string, responseData: unknown, alreadyBusy: boolean): Promise<void>;
	addMessage(agentId: string, role: ChatMessage["role"], text: string, meta?: Record<string, unknown>, images?: ImageContent[]): void;
	addLocalizedMessage(agentId: string, role: ChatMessage["role"], i18nKey: string, fallbackText: string, options?: { params?: I18nParams; debugDetails?: string; meta?: Record<string, unknown> }): void;
	executeBashCommand(agentId: string, command: string, excludeFromContext: boolean): Promise<SendPromptResult>;
	emitState(): void;
}

/**
 * pi 的忙碌拒收文案（Issue #371）：pi 侧 isStreaming 为 true 时，prompt 不带
 * streamingBehavior 会被直接拒收。PiDeck 本地状态在 abort 超时后已复位 idle，
 * 只有拿到这条错误才能确认 pi 的真实忙碌——据此补一次带 streamingBehavior 的重发。
 * 与 src/main/ipc/gitIpc.ts 的 GIT_COMMIT_BUSY 判据同款。
 */
function isPiBusyRejection(message: string): boolean {
	return /Agent is already processing/i.test(message);
}

/** prompt 派发域（拆分第十刀 · 第二刀）：sendPrompt 编排 + 发送边界的隐藏标记降级。 */
export class PromptDispatch {
	constructor(private readonly host: PromptDispatchHost) {}

	/** 宿主字段别名：搬出的实现保持 `this.<字段>` 原样（契约测试按此形态断言）。 */
	private get settingsStore() {
		return this.host.settingsStore;
	}

	private get appLogger() {
		return this.host.appLogger;
	}

	private get uiGate() {
		return this.host.uiGate;
	}

	private get messagePerf() {
		return this.host.messagePerf;
	}

	private get translate() {
		return this.host.translate;
	}

	private get requireRuntime() {
		return this.host.requireRuntime;
	}

	private get piMightStillBeStreaming() {
		return this.host.piMightStillBeStreaming;
	}

	private get settleAcceptedPrompt() {
		return this.host.settleAcceptedPrompt;
	}

	private get addMessage() {
		return this.host.addMessage;
	}

	private get addLocalizedMessage() {
		return this.host.addLocalizedMessage;
	}

	private get executeBashCommand() {
		return this.host.executeBashCommand;
	}

	private get emitState() {
		return this.host.emitState;
	}

	/**
	 * 发送边界的隐藏标记守卫（P4.4 扩展面）。
	 *
	 * plan/goal 的实现载体是 `agentMessage` 里的隐藏标记：远端没注入对应扩展时没人识别它，
	 * 标记会**原样进 prompt** 且只读工具集不生效——比“入口消失”更糟（用户以为模式生效了）。
	 * 所以这里做一道与 UI 无关的兜底：`applied` 里没有该扩展 ⇒ 退回用户可见原文。
	 *
	 * 只对“已上报注入面”的会话生效（远端）；本机/DSH 的 `remoteExtensions` 是 undefined，行为不变。
	 */
	/**
	 * 解析实际发给 pi 的 prompt 文本（远端扩展降级 / 智能体隐藏通道 / 纯图片发送共用的唯一入口）。
	 *
	 * 优先级：智能体隐藏通道 agentMessage > 用户输入；两者都空时（纯图片发送，Issue #404）
	 * 保持空串——禁止注入 "Describe this image." 之类的兜底文案，那是用户没写过的指令。
	 */
	private resolveSendAgentMessage(runtime: PromptRuntime, input: SendPromptInput): string {
		const fallback = input.message.trim();
		const raw = input.agentMessage?.trim() || fallback;
		const extensions = runtime.tab.remoteExtensions;
		if (extensions === undefined) return raw;
		const applied = new Set(extensions.applied);
		for (const entry of PI_DECK_MODE_MARKER_EXTENSIONS) {
			if (!raw.includes(entry.marker) || applied.has(entry.extension)) continue;
			void this.appLogger?.warn("agent", "Dropped composer mode marker: extension not injected", {
				agentId: runtime.tab.id,
				mode: entry.mode,
				extension: entry.extension,
				applied: extensions.applied,
			});
			return fallback || raw;
		}
		return raw;
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.requireRuntime(input.agentId);
		const trimmed = input.message.trim();
		const hasImages = input.images && input.images.length > 0;
		// 纯图片发送（无文字）时 message 就是空字符串：pi 会把空文本与图片一起写进用户
		// 消息，各 provider 自行丢弃空 text block（anthropic / openai 均按 text.trim()
		// 过滤），模型只看到图片。禁止注入 "Describe this image." 之类的兜底文案
		// （Issue #404）——那是用户没写过的指令，会让模型改按「描述图片」回答。
		const agentMessage = this.resolveSendAgentMessage(runtime, input);
		// 允许只有图片没有文字的情况发送
		if (!trimmed && !hasImages) {
			return {
				accepted: false,
				error: "消息不能为空",
				i18nKey: "diagnostic.messageRequired",
			};
		}

		// 解析 !/!! 前缀：与 pi 终端行为一致
		// !command  → 执行命令并将输出发送给 LLM（excludeFromContext: false）
		// !!command → 执行命令但不将输出发送给 LLM（excludeFromContext: true）
		const isBashExcluded = trimmed.startsWith("!!");
		const isBashNormal = !isBashExcluded && trimmed.startsWith("!");

		if (isBashExcluded || isBashNormal) {
			const command = isBashExcluded ? trimmed.slice(2).trim() : trimmed.slice(1).trim();
			if (command) {
				return this.executeBashCommand(input.agentId, command, isBashExcluded);
			}
		}

		// 判断 agent 是否已在忙碌中；运行中继续发送时必须带 streamingBehavior，
		// 否则 pi RPC 会拒绝请求。该值也用于给用户消息打上投递语义标记。
		// 除本地 tab 状态外并入 pi 侧权威信号（Issue #371）：abort RPC 超时后本地已被
		// 复位 idle，而 pi 仍在流式，只信本地状态会漏传 streamingBehavior 被直接拒收。
		const alreadyBusy = runtime.tab.status === "running" || this.piMightStillBeStreaming(input.agentId);

		const statusBeforePrompt = runtime.tab.status;
		const promptDeliveryBehavior = input.streamingBehavior ?? (alreadyBusy ? "steer" : undefined);

		// 在设置状态为 running 之前检查进程是否还活着，避免进程崩溃后状态不一致
		if (!runtime.process.isRunning()) {
			const errorMessage = "Agent 进程已停止，请重启 Agent 后重试";
			runtime.tab.status = "error";
			this.addLocalizedMessage(input.agentId, "error", "diagnostic.agentStopped", errorMessage);
			// 进程已退出但 tab 仍是旧状态：用户发送被拒是「状态非正常」的触发点之一。
			// 进程 exit 事件另有「Pi process exit」日志，这里补记录发送动作被拒时的
			// 状态快照与退出码，便于确认置 error 的确切时机与原因。
			const diag = runtime.process.getDiagnostics() ?? null;
			void this.appLogger?.warn("agent", "Prompt rejected: process not running", {
				agentId: input.agentId,
				statusBeforeReject: runtime.tab.status,
				exitCode: diag?.exitCode ?? null,
				exitSignal: diag?.exitSignal ?? null,
			});
			this.emitState();
			return { accepted: false, error: errorMessage, i18nKey: "diagnostic.agentStopped" };
		}

		runtime.tab.status = "running";
		this.emitState();

		// 用户未回答挂起的 Ask 提问却直接发送新消息：先取消所有挂起 UI 请求（见
		// cancelPendingUIRequests）。否则 pi 事件循环仍阻塞在 extension_ui_response 上，
		// 新 prompt 进入 steer 队列也永远不会被消费，悬浮 Ask 卡片也不会消失。
		this.uiGate.cancelPendingUIRequests(input.agentId);

		// 乐观更新：在等待 RPC 返回前先把用户消息写入会话，让用户立即看到自己的消息。
		// 只展示用户原文；agentMessage 里的宿主指令不进 UI 气泡。
		// 如果后续 RPC 失败，再追加错误消息；用户消息本身仍保留在聊天中（用户确已发送）。
		const optimisticMeta = {
			...(promptDeliveryBehavior ? { streamingBehavior: promptDeliveryBehavior } : {}),
			// 与渲染层乐观气泡共用 requestId：发送完成立刻中断再删时，
			// 删除按钮仍拿着乐观 id，不能再另起 UUID 导致 Message not found。
			...(input.requestId ? { requestId: input.requestId } : {}),
		};
		this.addMessage(input.agentId, "user", trimmed || this.translate("session.imagePlaceholder"), Object.keys(optimisticMeta).length > 0 ? optimisticMeta : undefined, input.images);

		// streamingBehavior 只在 agent 忙碌时需要；UI 可以显式传 steer/followUp 以复用 pi 队列语义。
		// 当前端排队 flush 连续发送多条消息时，第一条会触发 agent_start 使 agent 变忙碌，
		// 后续消息必须带 streamingBehavior 否则 pi 直接返回 error。这里自动兜底。
		// images 用于传递粘贴/拖拽的图片，pi 会将 base64 图片直接传给支持视觉的模型。
		try {
			// prompt 前不再发 get_commands 预检：pi 0.99 起 prompt 成功响应自带
			// data.disposition（CHANGELOG 0.99.0 #9098），"handled" 即「被扩展命令 /
			// input handler 消费、没有启动运行」的权威信号，且省掉一次 RPC 往返。
			// 老版本 pi 没有该字段 → 回退到 get_commands 启发式（见下方 undefined 分支）。
			const requestPayload: Record<string, unknown> = {
				type: "prompt",
				message: agentMessage,
				...(input.description ? { description: input.description } : {}),
				...(hasImages ? { images: input.images } : {}),
			};
			// 如果 agent 已经忙碌且调用方没指定 streamingBehavior，默认用 steer；
			// 与上方用户消息 meta 保持同一个计算结果，避免 UI 标记和实际 RPC 语义不一致。
			if (promptDeliveryBehavior) {
				requestPayload.streamingBehavior = promptDeliveryBehavior;
			}
			// 使用用户配置的 RPC 超时时间，因为用户提示词可能触发长时间运行的命令或复杂操作
			const rpcStartedAt = Date.now();
			// 空闲会话首轮从 RPC 发出计时；运行中提交的 steer/follow-up 到实际
			// turn_start 才起表，避免队列等待或上一轮工具耗时污染下一次模型调用。
			if (!alreadyBusy) this.messagePerf.notePromptRequested(input.agentId, rpcStartedAt);
			void this.appLogger?.info("session-perf", "Prompt RPC request started", {
				agentId: input.agentId,
				requestId: input.requestId,
			});
			const response = await runtime.process.client.request(requestPayload, this.settingsStore.get().rpcTimeout);
			void this.appLogger?.info("session-perf", "Prompt RPC response received", {
				agentId: input.agentId,
				requestId: input.requestId,
				success: response.success,
				rpcMs: Date.now() - rpcStartedAt,
			});
			if (!response.success) {
				const rejectionText = response.error ?? "图片消息发送失败";
				// 兜底重发（Issue #371）：本地判定空闲但 pi 实际仍在流式时，prompt 被
				// "Agent is already processing" 拒收。用户点的是发送，不该收到 SDK 原文
				// toast——按设置项 busySendDelivery 补一次带语义的 prompt（默认 steer）。
				const busyRetryBehavior = !promptDeliveryBehavior && isPiBusyRejection(rejectionText) ? parseBusySendDelivery(this.settingsStore.get().busySendDelivery) : undefined;
				let busyRetryResponse: RpcResponse | undefined;
				if (busyRetryBehavior) {
					const retryPayload = { ...requestPayload, streamingBehavior: busyRetryBehavior };
					void this.appLogger?.warn("agent", "Prompt rejected as busy; retrying with streamingBehavior", {
						agentId: input.agentId,
						requestId: input.requestId,
						streamingBehavior: busyRetryBehavior,
					});
					const retry = await runtime.process.client.request(retryPayload, this.settingsStore.get().rpcTimeout);
					busyRetryResponse = retry;
					if (retry.success) {
						// 重发成功：用户消息已按队列语义投递，走与正常发送相同的收尾。
						await this.settleAcceptedPrompt(input.agentId, runtime, agentMessage, retry.data, alreadyBusy);
						return { accepted: true };
					}
				}
				if (!alreadyBusy) this.messagePerf.discardInFlight(input.agentId);
				// pi RPC 会把不支持图片、忙碌队列参数缺失等前置错误作为 success:false 返回；
				// 必须显式显示出来，否则 UI 会停在"已发送但无响应"的状态。
				// 忙碌拒收的重发也失败时，用重发的错误原文（更能反映 pi 当前状态）。
				const errorMessage = busyRetryBehavior ? (busyRetryResponse?.error ?? rejectionText) : rejectionText;
				runtime.tab.status = statusBeforePrompt === "running" ? "running" : "idle";
				this.addLocalizedMessage(input.agentId, "error", "diagnostic.promptRejected", "消息发送失败。", { debugDetails: errorMessage });
				// pi 侧前置校验拒绝（模型不支持图片/队列参数缺失等）：气泡只展示给用户，
				// 记一条 warn 便于核对「同一消息反复被拒」是否与 RPC 参数/模型能力相关。
				void this.appLogger?.warn("agent", "Prompt rejected by pi RPC", {
					agentId: input.agentId,
					requestId: input.requestId,
					error: errorMessage,
				});
				this.emitState();
				return {
					accepted: false,
					error: errorMessage,
					i18nKey: "diagnostic.promptRejected",
					debugDetails: errorMessage,
				};
			}

			await this.settleAcceptedPrompt(input.agentId, runtime, agentMessage, response.data, alreadyBusy);
			return { accepted: true };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// prompt RPC 调用前已通过同步 write() 写入 pi stdin；此处所有异常都只说明
			// preflight 响应未到达，无法证明 pi 没有接收。返回 unknown，renderer 会永久禁用
			// 该快照的重试/编辑/取消，防止用户把同一条消息提交两次。
			runtime.tab.status = statusBeforePrompt === "running" ? "running" : "error";
			this.addLocalizedMessage(input.agentId, "error", "diagnostic.promptDeliveryUnknown", "消息接收结果未知。请先检查当前会话，避免重复发送；必要时重启 Agent。", { debugDetails: errorMessage });
			// prompt RPC 抛异常（超时/连接断开/响应丢失）：状态可能被置 error，必须留痕，
			// 与 session-perf 的 request started 配对才能还原「请求发出→无响应」链路。
			void this.appLogger?.error("agent", "Prompt RPC threw", {
				agentId: input.agentId,
				requestId: input.requestId,
				error: errorMessage,
			});
			this.emitState();
			return {
				accepted: false,
				error: errorMessage,
				delivery: "unknown",
				i18nKey: "diagnostic.promptDeliveryUnknown",
				debugDetails: errorMessage,
			};
		}
	}
}
