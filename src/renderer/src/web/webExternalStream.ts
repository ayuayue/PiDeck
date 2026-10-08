/**
 * webExternalStream — 订阅「别处发起」的回复流，在 Web 端实时渲染。
 *
 * 背景：/api/chat 的 SSE 是 useChat 自己 POST 建立的一次性流，只覆盖「本端发送」。
 * 桌面端（或另一台设备）发起的回复，Web 端过去只能靠轮询追赶（1s state 轮询发现
 * runtime busy → 5s 防抖拉磁盘快照）。本模块复用已存在的按会话订阅端点
 * GET /api/sessions/:id/stream（A1 兜底页同源；服务端 WebEventStreamRouter 支持
 * 同 session 多订阅者），把 UIMessageStream 帧合并成一条 UIMessage 打字机渲染，
 * 与桌面端 IPC 推送同等的实时性。
 *
 * 与 useChat 的协作：
 * - useChat 活跃（本端发送）时由调用方置 enabled=false，关流防止双路渲染同一轮；
 * - 流结束（finish / [DONE] / runtime 转 idle 兜底）后由调用方磁盘重拉权威终态。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { getWebToken } from "./webApi";

/** AI SDK UIMessageStream 单帧（与服务端 WebEventStream 产出的形状一致）。 */
export type ExternalStreamFrame = Record<string, unknown>;

/** 合并器维护的一条外部流式消息的形态（UIMessage parts 形状对齐 WebTimeline 的消费口径）。 */
export type ExternalReplyPart =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string; state: "streaming" | "done" }
	| { type: "tool-invocation"; toolCallId: string; toolName: string; state: "input-streaming" | "input-available" | "output-available" | "output-error"; input?: unknown; output?: unknown; errorText?: string };

/** 合并结果快照：null = 尚无帧到达。 */
export type ExternalReplySnapshot = { message: UIMessage; finished: boolean; errorText: string | null };

/**
 * ExternalReplyMerger — UIMessageStream 帧 → 单条 UIMessage 的合并纯函数。
 *
 * 只处理展示所需的最小子集（text / reasoning / tool / start / start-step / finish / error），
 * 分帧语义与服务端 PiEventToUiMessageStream 一一对应；tool 帧的双路径去重服务端已做，
 * 这里再防一层（重放/重连时的 input 重发会把已 settle 的工具卡拍回 running）。
 */
export class ExternalReplyMerger {
	private messageId: string | null = null;
	private parts: ExternalReplyPart[] = [];
	private finished = false;
	private errorText: string | null = null;
	private inputSentToolCallIds = new Set<string>();
	private settledToolCallIds = new Set<string>();

	/** 是否已收到任何帧（用于区分「订阅已建立但别处没在跑」与「流进行中」）。 */
	hasContent(): boolean {
		return this.messageId !== null;
	}

	isFinished(): boolean {
		return this.finished;
	}

	/** 当前快照；未收到任何帧时返回 null。内部可变 part 映射成 SDK 的严格判别联合（state 与必填字段绑定）。 */
	snapshot(): ExternalReplySnapshot | null {
		if (this.messageId === null) return null;
		const parts: UIMessage["parts"] = [];
		for (const part of this.parts) {
			if (part.type === "text") {
				parts.push({ type: "text", text: part.text });
			} else if (part.type === "reasoning") {
				parts.push({ type: "reasoning", text: part.text, state: part.state });
			} else if (part.state === "output-available") {
				parts.push({ type: "dynamic-tool", toolCallId: part.toolCallId, toolName: part.toolName, state: "output-available", input: part.input, output: part.output });
			} else if (part.state === "output-error") {
				parts.push({ type: "dynamic-tool", toolCallId: part.toolCallId, toolName: part.toolName, state: "output-error", input: part.input, errorText: part.errorText ?? "Tool failed" });
			} else {
				parts.push({ type: "dynamic-tool", toolCallId: part.toolCallId, toolName: part.toolName, state: part.state, input: part.input });
			}
		}
		return {
			message: { id: this.messageId, role: "assistant", parts },
			finished: this.finished,
			errorText: this.errorText,
		};
	}

	/** 应用一帧；返回更新后的快照。 */
	applyFrame(frame: ExternalStreamFrame): ExternalReplySnapshot | null {
		const type = String(frame.type ?? "");
		if (this.finished) return this.snapshot();

		if (type === "start") {
			if (this.messageId === null) this.messageId = typeof frame.messageId === "string" && frame.messageId ? frame.messageId : `external_${Date.now()}`;
			// start-step：同一条消息内的下一跳（工具循环），不再拆消息。
			return this.snapshot();
		}

		if (type === "text-start") {
			this.ensureMessage();
			this.parts.push({ type: "text", text: "" });
			return this.snapshot();
		}
		if (type === "text-delta") {
			this.ensureMessage();
			const delta = typeof frame.delta === "string" ? frame.delta : "";
			const last = this.parts.at(-1);
			if (last?.type === "text") {
				last.text += delta;
			} else {
				this.parts.push({ type: "text", text: delta });
			}
			return this.snapshot();
		}
		if (type === "text-end") {
			return this.snapshot();
		}

		if (type === "reasoning-start") {
			this.ensureMessage();
			this.parts.push({ type: "reasoning", text: "", state: "streaming" });
			return this.snapshot();
		}
		if (type === "reasoning-delta") {
			this.ensureMessage();
			const delta = typeof frame.delta === "string" ? frame.delta : "";
			const last = this.parts.at(-1);
			if (last?.type === "reasoning") {
				last.text += delta;
			} else {
				this.parts.push({ type: "reasoning", text: delta, state: "streaming" });
			}
			return this.snapshot();
		}
		if (type === "reasoning-end") {
			// 关闭最后一个开着的 reasoning 块（thinking_end 兜底补全量文本的场景服务端已并入 delta）。
			for (let index = this.parts.length - 1; index >= 0; index -= 1) {
				const part = this.parts[index];
				if (part.type === "reasoning") {
					if (part.state === "streaming") part.state = "done";
					break;
				}
			}
			return this.snapshot();
		}

		if (type === "tool-input-start" || type === "tool-input-available") {
			const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
			const toolName = typeof frame.toolName === "string" ? frame.toolName : "tool";
			if (!toolCallId || this.settledToolCallIds.has(toolCallId)) return this.snapshot();
			this.ensureMessage();
			const existing = this.parts.find((candidate): candidate is Extract<ExternalReplyPart, { type: "tool-invocation" }> => candidate.type === "tool-invocation" && candidate.toolCallId === toolCallId);
			if (existing) {
				// input-start → input-available 是同一张卡的输入阶段收口：更新状态与完整入参，不建新卡。
				if (type === "tool-input-available") {
					existing.state = "input-available";
					existing.input = frame.input;
				}
				return this.snapshot();
			}
			this.inputSentToolCallIds.add(toolCallId);
			this.parts.push({
				type: "tool-invocation",
				toolCallId,
				toolName,
				state: type === "tool-input-available" ? "input-available" : "input-streaming",
				input: frame.input,
			});
			return this.snapshot();
		}
		if (type === "tool-output-available" || type === "tool-output-error") {
			const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
			if (!toolCallId || !this.inputSentToolCallIds.has(toolCallId) || this.settledToolCallIds.has(toolCallId)) return this.snapshot();
			this.settledToolCallIds.add(toolCallId);
			this.inputSentToolCallIds.delete(toolCallId);
			const part = this.parts.find((candidate): candidate is Extract<ExternalReplyPart, { type: "tool-invocation" }> => candidate.type === "tool-invocation" && candidate.toolCallId === toolCallId);
			if (part) {
				part.state = type === "tool-output-error" ? "output-error" : "output-available";
				if (type === "tool-output-available") part.output = frame.output;
				else part.errorText = typeof frame.errorText === "string" ? frame.errorText : "Tool failed";
			}
			return this.snapshot();
		}

		if (type === "error") {
			this.errorText = typeof frame.errorText === "string" ? frame.errorText : "Agent 运行失败";
			return this.finish();
		}
		if (type === "finish") {
			return this.finish();
		}
		return this.snapshot();
	}

	/** 主动收尾（[DONE] / runtime 转 idle 兜底）：关闭所有开着的块。 */
	finish(): ExternalReplySnapshot | null {
		this.finished = true;
		for (const part of this.parts) {
			if (part.type === "reasoning" && part.state === "streaming") part.state = "done";
		}
		return this.snapshot();
	}

	/** 重置（新的一轮外部回复）：断线重连且上一轮已结束时由调用方触发。 */
	reset(): void {
		this.messageId = null;
		this.parts = [];
		this.finished = false;
		this.errorText = null;
		this.inputSentToolCallIds.clear();
		this.settledToolCallIds.clear();
	}

	private ensureMessage(): void {
		if (this.messageId === null) this.messageId = `external_${Date.now()}`;
	}
}

/** 会话流订阅 URL（带可选 token：EventSource 无法携带 Authorization header）。 */
export function externalStreamUrl(sessionId: string): string {
	const token = getWebToken();
	const base = `/api/sessions/${encodeURIComponent(sessionId)}/stream`;
	return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/**
 * useExternalSessionStream — 活跃会话的常驻流订阅。
 *
 * 生命周期：
 * - 开流条件：enabled（= 有活跃会话且 useChat 空闲）且页面可见；切会话/不可见/禁用时关流；
 * - 帧到达 → 合并器更新 → liveMessage 状态驱动时间线打字机渲染；
 * - 收尾三路：finish 帧 + [DONE]（正常）、EventSource error（网络断，浏览器自动重连，
 *   合并器保留已收内容继续追加）、runtimeBusy=false 兜底（收尾帧丢失时由状态通道收口）。
 *
 * @param onSettled 一轮外部回复结束（含兜底收口）后回调；调用方负责磁盘重拉权威终态。
 */
export function useExternalSessionStream(options: { sessionId: string; enabled: boolean; runtimeBusy: boolean; onSettled: (sessionId: string) => void }) {
	const { sessionId, enabled, runtimeBusy, onSettled } = options;
	const [liveMessage, setLiveMessage] = useState<UIMessage | null>(null);
	const [externalStreaming, setExternalStreaming] = useState(false);
	const mergerRef = useRef<ExternalReplyMerger | null>(null);
	const esRef = useRef<EventSource | null>(null);
	const settledFiredRef = useRef(false);
	const onSettledRef = useRef(onSettled);
	onSettledRef.current = onSettled;

	// runtimeBusy 镜像：兜底收口需要捕获 busy→idle 边沿，不能只看当前值。
	const runtimeBusyRef = useRef(runtimeBusy);
	runtimeBusyRef.current = runtimeBusy;

	const closeStream = () => {
		esRef.current?.close();
		esRef.current = null;
	};
	const clearLive = () => {
		mergerRef.current = null;
		setLiveMessage(null);
		setExternalStreaming(false);
	};

	/** 一轮结束：关流、清打字机状态；磁盘重拉落地后再清除 liveMessage（避免终态重复或闪断）。 */
	const settle = (withReload: boolean) => {
		if (settledFiredRef.current) return;
		settledFiredRef.current = true;
		closeStream();
		setExternalStreaming(false);
		if (!withReload || !sessionId) {
			clearLive();
			return;
		}
		// onSettled（磁盘重拉）成功落地后原子清除 live：终态直接从磁盘消息无缝接管。
		// 重拉失败则保留 live（至少有最后一帧内容），下次会话切换/刷新再收敛。
		void Promise.resolve(onSettledRef.current(sessionId))
			.then(() => clearLive())
			.catch(() => {});
	};

	useEffect(() => {
		if (!enabled || !sessionId || typeof document === "undefined" || document.visibilityState !== "visible") {
			closeStream();
			return;
		}
		mergerRef.current ??= new ExternalReplyMerger();
		settledFiredRef.current = false;
		// 每次开流重置合并器：防止上一轮残留（服务端每条连接的翻译器也是全新实例）。
		mergerRef.current.reset();
		setLiveMessage(null);
		setExternalStreaming(false);

		const es = new EventSource(externalStreamUrl(sessionId));
		esRef.current = es;
		es.onopen = () => {
			// 重连场景：上一轮已收尾但收尾帧丢失时，新连接帧属于新一轮 → 重置合并。
			if (mergerRef.current?.isFinished()) {
				mergerRef.current.reset();
				setLiveMessage(null);
			}
		};
		es.onmessage = (event: MessageEvent<string>) => {
			const merger = mergerRef.current;
			if (!merger) return;
			if (event.data === "[DONE]") {
				settle(true);
				return;
			}
			let frame: ExternalStreamFrame;
			try {
				frame = JSON.parse(event.data) as ExternalStreamFrame;
			} catch {
				return;
			}
			const snapshot = merger.applyFrame(frame);
			if (snapshot) {
				setLiveMessage(snapshot.message);
				setExternalStreaming(!snapshot.finished);
			}
			if (merger.isFinished()) settle(true);
		};
		// 网络断开：浏览器自动重连；本地保留已合并内容（重连后继续追加）。
		// enabled 变化（useChat 起流/切会话）时由清理函数主动关流。
		return () => {
			closeStream();
		};
		// runtimeBusy 不在依赖里：它只通过下方边沿 effect 参与收口，不重建连接。
	}, [enabled, sessionId]);

	// 页面不可见关流（省电/省连接额度），回前台重开。
	useEffect(() => {
		const onVisibility = () => {
			if (document.visibilityState !== "visible") {
				closeStream();
				// 打字机内容保留：回前台重开流后继续追加或由收尾路径清理。
			}
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, []);

	// runtimeBusy→false 边沿兜底：收尾帧在断线间隙丢失时（finish 没送达但 pi 已跑完），
	// 由状态通道的 idle 信号收口这轮打字机；短轮（busy 翻转极快）也由这里统一清理。
	useEffect(() => {
		if (runtimeBusy) return;
		if (!externalStreaming && !liveMessage) return;
		// 等一个宏任务再收口：正常路径的 [DONE] 可能紧随其后到达，优先走带磁盘重拉的 settle。
		const timer = setTimeout(() => {
			if (settledFiredRef.current) return;
			mergerRef.current?.finish();
			settle(true);
		}, 600);
		return () => clearTimeout(timer);
	}, [runtimeBusy, externalStreaming, liveMessage]);

	// 切会话/禁用时清打字机状态（closeStream 由主 effect 清理函数完成）。
	useEffect(() => {
		if (!enabled || !sessionId) clearLive();
	}, [enabled, sessionId]);

	return { liveMessage, externalStreaming, clearLive };
}
