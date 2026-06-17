/**
 * TaskStatusCard — 飞书任务状态流式卡片
 *
 * 参考 pi-feishu-lark 的 TaskStatusCard 实现：
 * 1. 先发一张"处理中"骨架卡片
 * 2. Agent 事件驱动实时更新卡片（400ms 节流）
 * 3. 终态强制 flush
 *
 * 利用飞书 CardKit 2.0 的 update_multi + v1.message.patch API
 * 实现流式输出效果，而非等待完成后一次性弹出卡片。
 */

import type { LarkClient } from "./types";

export type TaskStatus = "running" | "done" | "failed" | "stopped" | "inactive";

const MAX_PHASE_CHARS = 96;
const STILL_RUNNING_MS = 25_000;
const RUNNING_UPDATE_INTERVAL_MS = 3_000;

export class TaskStatusCard {
	private cardMessageId: string | undefined;
	private phase = "开始处理";
	private status: TaskStatus = "running";
	private heartbeat: NodeJS.Timeout | undefined;
	private lastUpdateAt = 0;
	private lastRunningUpdateAt = 0;
	private pendingRunningTimer: NodeJS.Timeout | undefined;
	private pendingRunningPhase: string | undefined;
	private runningUpdateInFlight = false;
	private patchQueue: Promise<void> = Promise.resolve();
	private accumulatedText = "";

	constructor(
		private readonly key: string,
		private readonly replyToMessageId: string | undefined,
		private readonly chatId: string,
		private readonly client: LarkClient,
	) {}

	async start() {
		try {
			this.cardMessageId = await this.sendCard(
				buildTaskStatusCard({ key: this.key, status: "running", phase: this.phase }),
			);
			this.lastUpdateAt = Date.now();
			this.lastRunningUpdateAt = this.lastUpdateAt;
			this.startHeartbeat();
		} catch (e) {
			// 卡片发送失败不致命
			console.error("[飞书 TaskStatusCard] start 失败:", e);
		}
	}

	/** 从 Agent 事件更新当前阶段描述 */
	updateFromEvent(event: unknown) {
		if (this.status !== "running") return;
		const phase = describePiEvent(event);
		if (!phase) return;
		void this.updateRunningPhase(phase);
	}

	/** 累积 assistant 文本增量（用于流式展示） */
	accumulateText(delta: string) {
		if (this.status !== "running") return;
		this.accumulatedText += delta;
		void this.updateRunningPhase(
			this.accumulatedText.length > 200
				? this.accumulatedText.slice(0, 200) + "…"
				: this.accumulatedText,
		);
	}

	/** 设置累积文本（agent_end 时用完整内容替换） */
	setFullText(text: string) {
		this.accumulatedText = text;
	}

	async stopImmediately(phase = "用户已停止任务") {
		await this.finishFinal("stopped", phase);
	}

	async finish(status: Exclude<TaskStatus, "running" | "inactive">, phase?: string) {
		await this.finishFinal(status, phase);
	}

	private async finishFinal(status: Exclude<TaskStatus, "running" | "inactive">, phase: string | undefined) {
		if (this.status !== "running") return;
		this.status = status;
		this.stopHeartbeat();
		this.clearPendingRunningUpdate();
		const finalPhase = phase ? normalizePhase(phase) : defaultFinalPhase(status);
		await this.patch(buildTaskStatusCard({ key: this.key, status, phase: finalPhase }), { final: true, force: true });
	}

	private updateRunningPhase(phase: string) {
		const next = normalizePhase(phase);
		if (!next || next === this.phase || next === this.pendingRunningPhase) return;
		this.pendingRunningPhase = next;
		this.scheduleRunningUpdate();
	}

	private scheduleRunningUpdate() {
		if (this.status !== "running" || this.runningUpdateInFlight || this.pendingRunningTimer) return;
		const now = Date.now();
		const waitMs = Math.max(0, RUNNING_UPDATE_INTERVAL_MS - (now - this.lastRunningUpdateAt));
		if (waitMs > 0) {
			this.pendingRunningTimer = setTimeout(() => {
				this.pendingRunningTimer = undefined;
				void this.flushRunningUpdate();
			}, waitMs);
			this.pendingRunningTimer.unref?.();
			return;
		}
		void this.flushRunningUpdate();
	}

	private async flushRunningUpdate() {
		if (this.status !== "running" || this.runningUpdateInFlight) return;
		const next = this.pendingRunningPhase;
		this.pendingRunningPhase = undefined;
		if (!next || next === this.phase) return;

		this.runningUpdateInFlight = true;
		this.phase = next;
		this.lastRunningUpdateAt = Date.now();
		try {
			await this.patch(buildTaskStatusCard({ key: this.key, status: "running", phase: this.phase }));
		} finally {
			this.runningUpdateInFlight = false;
		}
		if (this.pendingRunningPhase) this.scheduleRunningUpdate();
	}

	private async patch(card: object, options: { final?: boolean; force?: boolean } = {}) {
		if (!this.cardMessageId) return;
		const messageId = this.cardMessageId;
		const next = this.patchQueue
			.catch(() => undefined)
			.then(async () => {
				if (!options.final && !options.force && this.status !== "running") return;
				try {
					await this.client.im.v1.message.patch({
						path: { message_id: messageId },
						data: { content: JSON.stringify(card) },
					});
					this.lastUpdateAt = Date.now();
				} catch (e) {
					// 更新失败不致命
					console.error("[飞书 TaskStatusCard] patch 失败:", e);
					if (options.final) {
						await sleep(RUNNING_UPDATE_INTERVAL_MS);
						try {
							await this.client.im.v1.message.patch({
								path: { message_id: messageId },
								data: { content: JSON.stringify(card) },
							});
						} catch { /* 最终重试也失败就放弃了 */ }
					}
				}
			});
		this.patchQueue = next;
		await next;
	}

	private async sendCard(card: object): Promise<string | undefined> {
		try {
			// 优先 replyToMessageId（回复用户消息），否则 send 到 chatId
			if (this.replyToMessageId) {
				const res = await this.client.im.message.reply({
					path: { message_id: this.replyToMessageId },
					data: { msg_type: "interactive", content: JSON.stringify(card) },
				});
				return (res as { data?: { message_id?: string } })?.data?.message_id;
			}
			const res = await this.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: { receive_id: this.chatId, msg_type: "interactive", content: JSON.stringify(card) },
			});
			return (res as { data?: { message_id?: string } })?.data?.message_id;
		} catch (e) {
			console.error("[飞书 TaskStatusCard] sendCard 失败:", e);
			return undefined;
		}
	}

	private startHeartbeat() {
		this.stopHeartbeat();
		this.heartbeat = setInterval(() => {
			if (this.status !== "running") return;
			if (Date.now() - this.lastUpdateAt < STILL_RUNNING_MS) return;
			void this.updateRunningPhase("仍在处理…");
		}, STILL_RUNNING_MS);
		this.heartbeat.unref?.();
	}

	private stopHeartbeat() {
		if (!this.heartbeat) return;
		clearInterval(this.heartbeat);
		this.heartbeat = undefined;
	}

	private clearPendingRunningUpdate() {
		if (this.pendingRunningTimer) {
			clearTimeout(this.pendingRunningTimer);
			this.pendingRunningTimer = undefined;
		}
		this.pendingRunningPhase = undefined;
	}
}

// ===== 卡片构建 =====

export function buildTaskStatusCard(input: { key: string; status: TaskStatus; phase?: string }) {
	const running = input.status === "running";
	return {
		config: { wide_screen_mode: true, update_multi: true },
		header: {
			template: headerTemplate(input.status),
			title: { tag: "plain_text", content: titleForStatus(input.status) },
		},
		elements: [
			...(input.phase ? [{
				tag: "div" as const,
				text: {
					tag: "lark_md" as const,
					content: `当前阶段：${normalizePhase(input.phase)}`,
				},
			}] : []),
			...(running ? [{
				tag: "action" as const,
				actions: [{
					tag: "button" as const,
					text: { tag: "plain_text" as const, content: "停止任务" },
					type: "danger" as const,
					value: { action: "pi_feishu_stop_task", key: input.key },
				}],
			}] : []),
		],
	};
}

// ===== 事件描述 =====

export function describePiEvent(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const raw = event as Record<string, unknown>;
	switch (raw.type) {
		case "agent_start":
			return "agent 启动";
		case "turn_start":
			return typeof raw.turnIndex === "number" ? `第 ${Number(raw.turnIndex) + 1} 轮对话` : "turn_start";
		case "message_start": {
			const msg = raw.message as Record<string, unknown> | undefined;
			return msg?.role ? `消息开始: ${msg.role}` : "message_start";
		}
		case "message_update": {
			const assistantEvent = raw.assistantMessageEvent as Record<string, unknown> | undefined;
			return describeAssistantEvent(assistantEvent);
		}
		case "tool_execution_start":
			return `工具调用: ${raw.toolName || "tool"}`;
		case "tool_execution_end":
			return `工具完成: ${raw.toolName || "tool"} ${raw.isError ? "错误" : "成功"}`;
		case "compaction_start":
			return raw.reason ? `上下文压缩: ${raw.reason}` : "上下文压缩";
		case "auto_retry_start":
			return typeof raw.attempt === "number" ? `自动重试: ${raw.attempt}/${raw.maxAttempts || "?"}` : "自动重试";
		case "auto_retry_end":
			return raw.success === false ? "自动重试失败" : "自动重试完成";
		default:
			return undefined;
	}
}

function describeAssistantEvent(event: Record<string, unknown> | undefined) {
	if (!event?.type) return "消息更新";
	if (event.type === "toolcall_end" && (event.toolCall as Record<string, unknown>)?.name)
		return `工具完成: ${(event.toolCall as Record<string, unknown>).name}`;
	if (event.type === "done" && event.reason) return `消息完成: ${event.reason}`;
	if (event.type === "error" && event.reason) return `消息错误: ${event.reason}`;
	if (String(event.type).endsWith("_delta")) return undefined; // 忽略增量 delta
	return `消息更新: ${event.type}`;
}

function normalizePhase(text: string) {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= MAX_PHASE_CHARS) return compact;
	return `${compact.slice(0, MAX_PHASE_CHARS - 1)}…`;
}

function titleForStatus(status: TaskStatus) {
	if (status === "done") return "✅ 任务完成";
	if (status === "failed") return "❌ 任务失败";
	if (status === "stopped") return "⏹ 任务已停止";
	if (status === "inactive") return "任务已结束";
	return "🔄 任务进行中";
}

function headerTemplate(status: TaskStatus) {
	if (status === "done") return "green";
	if (status === "failed") return "red";
	if (status === "stopped") return "grey";
	if (status === "inactive") return "grey";
	return "blue";
}

function defaultFinalPhase(status: Exclude<TaskStatus, "running" | "inactive">): string | undefined {
	if (status === "done") return undefined;
	if (status === "failed") return "处理失败";
	return "用户已停止任务";
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
