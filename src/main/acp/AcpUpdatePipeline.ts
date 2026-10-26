/**
 * ACP 会话更新管线：session/update 摄入 → 投影 → 图片物化 → 标题/用量发布 → 节流 flush。
 *
 * 从 AcpAgentManager 抽出的协作者（无自持状态，全部状态在 runtime 上）：
 * - enqueueSessionUpdate：通知进串行链（物化回写 projection 前不能让下一个 update 先投影）。
 * - handleSessionUpdate：过滤/去重/投影/物化，再按 reloading 分支发布。
 * - scheduleFlush/flushMessages：80ms 节流发布 agents:message，并写内存快照。
 * 发布通道（emit/emitRuntimeState）与外部回调（标题/配置）经 host 回到 manager，
 * 保证 agentsState/agentsRuntimeState 仍由 manager 统一编排。
 */
import { ipcChannels } from "../../shared/ipc";
import type { AgentTab } from "../../shared/types/agent";
import type { AcpConfigOption, AcpRpcNotification, AcpSessionUpdate, AcpToolCallUpdate } from "./acpProtocol";
import type { AcpAgentRuntime } from "./acpAgentRuntime";
import { projectAcpSessionUpdate } from "./AcpEventProjector";
import type { AcpMessageSnapshotStore } from "./AcpMessageSnapshotStore";

/** 流式消息 flush 节流:每 chunk 都 emit 会打爆 IPC(与 DSH 实测同因)。 */
const FLUSH_THROTTLE_MS = 80;

export type AcpUpdatePipelineHost = {
	/** runtime 归属校验（stop/重建后旧链上的在途步骤不得再作用于新 runtime）。 */
	ownsRuntime(runtime: AcpAgentRuntime): boolean;
	/** runtime 仍被跟踪（不含身份校验，用于通知过滤）。 */
	isTracked(tabId: string): boolean;
	/** 通道发布（agents:message 等）。 */
	emit(channel: string, payload: unknown): void;
	/** usage/todos 变更主动推 runtime state（agentsRuntimeState 通道）。 */
	emitRuntimeState(agentId: string): void;
	onTitleChanged?(deckSessionId: string, title: string): void;
	onConfigOptionsChanged?(tab: AgentTab, options: AcpConfigOption[]): void;
	/** 图片落盘(base64→内容寻址 ref);缺省时跳过物化(内联形态只是内存开销)。 */
	imageStore?: { put(data: string, mimeType: string): Promise<string | null> };
};

export class AcpUpdatePipeline {
	constructor(
		private readonly host: AcpUpdatePipelineHost,
		private readonly snapshots: AcpMessageSnapshotStore,
	) {}

	/** session/update 等通知进串行链：物化(异步落盘)回写 projection 前不能让下一个
	 * update 先投影，否则旧快照覆盖新消息；链兜 catch，单条失败不断链。 */
	enqueueSessionUpdate(runtime: AcpAgentRuntime, notification: AcpRpcNotification): void {
		runtime.updateChain = runtime.updateChain
			.then(() => this.handleSessionUpdate(runtime, notification))
			.catch(() => {
				// handleSessionUpdate 自身已对物化降级,这里只兜 unexpected 异常
			});
	}

	async handleSessionUpdate(runtime: AcpAgentRuntime, notification: AcpRpcNotification): Promise<void> {
		if (runtime.status === "closed" || !this.host.isTracked(runtime.tab.id) || notification.method !== "session/update") return;
		if (notification.params?.sessionId !== runtime.acpSessionId) return;
		// 回合中收到任何 update 都刷新活跃时间：stall 看门狗只关心全静默。
		if (runtime.turnActive) runtime.lastUpdateAt = Date.now();
		const rawUpdate = notification.params.update;
		if (!rawUpdate || typeof rawUpdate !== "object" || !("sessionUpdate" in rawUpdate) || typeof rawUpdate.sessionUpdate !== "string") return;
		const update = rawUpdate as AcpSessionUpdate;
		if (update.sessionUpdate === "config_option_update") {
			if (Array.isArray(update.configOptions)) {
				runtime.configOptions = update.configOptions;
				if (!runtime.reloading) this.host.onConfigOptionsChanged?.(runtime.tab, update.configOptions);
			}
			return;
		}
		// 实时 prompt 已在本地记录完整 user 消息；echo 仅用于历史恢复，不能重复追加。
		if (runtime.turnActive && update.sessionUpdate === "user_message_chunk") return;
		// 在途工具调用跟踪（stall 看门狗豁免依据）：tool_call 开始入集，终态出集。
		// 长命令 started→completed 之间常无任何流式输出，是合法静默，与挂起审批同等对待。
		trackInFlightToolCall(runtime, update);
		runtime.projection = projectAcpSessionUpdate(runtime.projection, update, runtime.tab.id);
		// 图片物化:投影器产出的 base64 图在进消息缓存前落盘成 ref(同生图「base64 不进历史」契约);
		// 失败保留 data 形态展示(ACP 不写 JSONL,内联形态只是内存开销,不违反存储约束)。
		await this.materializeTouchedImages(runtime);
		if (!this.host.ownsRuntime(runtime)) return;
		// catalog 重载中：标题只回写投影状态，不动 tab/catalog（避免旧目录扫描与投影竞争）。
		if (runtime.reloading) {
			runtime.title = runtime.projection.title ?? runtime.title;
			return;
		}
		// plan/todos 与 usage 变更不走 messages 通道，主动 emit 才能让待办列表/上下文仪表即时刷新。
		if (runtime.projection.todos || update.sessionUpdate === "usage_update") this.host.emitRuntimeState(runtime.tab.id);
		this.applyProjectionTitle(runtime);
		this.scheduleFlush(runtime);
	}

	/**
	 * 投影标题 → runtime / tab / catalog 同步。
	 * 两个来源：agent 的 session_info_update（last-wins）与首条 prompt 的兜底标题
	 * （见 appendAcpUserPrompt）；catalog 回写由 host.onTitleChanged 完成。
	 */
	applyProjectionTitle(runtime: AcpAgentRuntime): void {
		const title = runtime.projection.title;
		if (!title || title === runtime.title) return;
		runtime.title = title;
		runtime.tab.title = title;
		if (runtime.tab.deckSessionId) this.host.onTitleChanged?.(runtime.tab.deckSessionId, title);
	}

	/** 把本轮投影 touched 消息里的 data 形态图片替换成落盘 ref;仅替换成功项,失败保留原样。 */
	async materializeTouchedImages(runtime: AcpAgentRuntime): Promise<void> {
		const store = this.host.imageStore;
		const touched = runtime.projection.lastTouched;
		if (!store || !touched || touched.length === 0) return;
		let messages = runtime.projection.messages;
		let mutated = false;
		for (const index of touched) {
			const message = messages[index];
			if (!message?.images?.length) continue;
			const images = await Promise.all(
				message.images.map(async (image) => {
					if (image.type !== "image" || image.ref || typeof image.data !== "string") return image;
					try {
						const ref = await store.put(image.data, image.mimeType);
						return ref ? { type: "image" as const, mimeType: image.mimeType, ref } : image;
					} catch {
						return image;
					}
				}),
			);
			if (mutated || images.some((image, i) => image !== message.images?.[i])) {
				messages = [...messages];
				messages[index] = { ...message, images };
				mutated = true;
			}
		}
		if (mutated) runtime.projection = { ...runtime.projection, messages };
	}

	/** 节流 flush:流式 chunk 80ms 合并一次;force 立即全量(session 结算)。 */
	scheduleFlush(runtime: AcpAgentRuntime): void {
		if (runtime.status === "closed" || !this.host.ownsRuntime(runtime)) return;
		if (runtime.flushTimer) {
			runtime.flushPending = true;
			return;
		}
		runtime.flushTimer = setTimeout(() => {
			runtime.flushTimer = null;
			const pending = runtime.flushPending;
			runtime.flushPending = false;
			this.flushMessages(runtime, !pending);
			if (pending) this.scheduleFlush(runtime);
		}, FLUSH_THROTTLE_MS);
		runtime.flushTimer.unref?.();
	}

	flushMessages(runtime: AcpAgentRuntime, force: boolean): void {
		if (runtime.status === "closed" || !this.host.ownsRuntime(runtime)) return;
		if (force && runtime.flushTimer) {
			clearTimeout(runtime.flushTimer);
			runtime.flushTimer = null;
			runtime.flushPending = false;
		}
		this.host.emit(ipcChannels.agentsMessage, {
			agentId: runtime.tab.id,
			deckSessionId: runtime.tab.deckSessionId,
			messages: runtime.projection.messages,
			totalLength: runtime.projection.messages.length,
		});
		// 内存快照：stop/升级强杀后 runtime 删除，重入会话时 readMessagesByAcpSessionId
		// 用它避免时间线空白；激活后 session/load 重放会覆盖为完整历史。
		if (runtime.acpSessionId) {
			this.snapshots.set(runtime.acpSessionId, runtime.projection.messages);
		}
	}
}

/**
 * 在途工具调用集合维护（stall 看门狗的豁免依据）：tool_call 开始入集；tool_call_update
 * 的 pending/in_progress 再入集（容忍重复帧），其余状态（completed 及未来可能的 failed）
 * 一律按终态出集——宁可提前解除豁免（回落全静默判定），也不让脏帧把豁免永久挂住。
 * toolCallId 非法直接忽略（同投影器口径）；幂等无副作用，回合收口点统一 clear。
 */
function trackInFlightToolCall(runtime: AcpAgentRuntime, update: AcpSessionUpdate): void {
	if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
	const toolCallId = (update as AcpToolCallUpdate).toolCallId;
	if (typeof toolCallId !== "string" || !toolCallId) return;
	const status = (update as AcpToolCallUpdate).status;
	if (update.sessionUpdate === "tool_call_update" && status !== "pending" && status !== "in_progress") {
		runtime.inFlightToolCalls.delete(toolCallId);
		return;
	}
	runtime.inFlightToolCalls.add(toolCallId);
}
