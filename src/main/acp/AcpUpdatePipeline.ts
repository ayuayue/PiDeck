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
import { agentEventTags } from "../../shared/ipc";
import type { AgentTab } from "../../shared/types/agent";
import type { AcpConfigOption, AcpRpcNotification, AcpSessionUpdate, AcpToolCallUpdate } from "./acpProtocol";
import type { AcpAgentRuntime } from "./acpAgentRuntime";
import { projectAcpSessionUpdate } from "./AcpEventProjector";
import { resolveAcpWindowStart } from "./acpReplayWindow";
import { emitAgentMessageMeasured } from "../perf/messageFlushMeter";
import type { AcpMessageSnapshotStore } from "./AcpMessageSnapshotStore";

/** 流式消息 flush 节流:每 chunk 都 emit 会打爆 IPC(与 DSH 实测同因)。 */
const FLUSH_THROTTLE_MS = 80;
/**
 * 重放分批投递（Phase 3，见 docs/acp-replay-batching-plan.md §0.1 实测）。
 *
 * session/load 重放是「一次性全量」：实测 1076 条 / 4251KB 会让渲染进程出现一个
 * 236ms 的长任务（主进程 emit 只占 15ms，成本在渲染侧）。这里按条数切块、每块隔
 * 一帧投递，把一次长任务摊成若干短任务；协议复用既有的 upsertFrom / totalLength
 * 增量合并，渲染层零改动。
 *
 * 为什么不按「尾部 N 轮」窗口化（原 Phase 2）：ACP 一轮里每次工具调用都是一条
 * 消息，9 轮窗口在 40 条真实会话上仍有 31 条超 256KB；且渲染层的「加载更早」
 * 只对磁盘页生效，ACP 没有磁盘页，窗口化会让更早历史无法翻回来。
 */
const REPLAY_CHUNK_MESSAGES = 100;
/** 低于这个条数不值得切块（一次 flush 即可，避免多出无意义的中间态）。 */
const REPLAY_CHUNK_MIN_MESSAGES = 300;
/** 块间隔：一帧左右，让每块落在独立帧里，长任务才真正被摊开。 */
const REPLAY_CHUNK_INTERVAL_MS = 12;

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
		// 回合中收到任何 update 都刷新活跃时间：stall 看门狗只关心全静默；
		// 同时顺延回合兑底超时截止——有产出就证明 agent 还活着，长回合不应被总时长误杀。
		if (runtime.turnActive) {
			runtime.lastUpdateAt = Date.now();
			runtime.turnDeadlineRefresh?.();
		}
		const rawUpdate = notification.params.update;
		if (!rawUpdate || typeof rawUpdate !== "object" || !("sessionUpdate" in rawUpdate) || typeof rawUpdate.sessionUpdate !== "string") return;
		const update = rawUpdate as AcpSessionUpdate;
		// 诊断计数：空白回合要能说出「收到过哪些 update 类型」，否则只能笼统归咎 CLI。
		if (runtime.turnActive) runtime.turnUpdateKinds.set(update.sessionUpdate, (runtime.turnUpdateKinds.get(update.sessionUpdate) ?? 0) + 1);
		if (update.sessionUpdate === "config_option_update") {
			if (Array.isArray(update.configOptions)) {
				runtime.configOptions = update.configOptions;
				if (!runtime.reloading) this.host.onConfigOptionsChanged?.(runtime.tab, update.configOptions);
			}
			return;
		}
		// 实时 prompt 已在本地记录完整 user 消息；echo 仅用于历史恢复，不能重复追加。
		if (runtime.turnActive && update.sessionUpdate === "user_message_chunk") return;
		// TTFT：正文与思考分别记首次到达；结算时优先正文、无正文回退思考（与 pi 同语义）。
		// 工具调用不算「首字」。
		if (runtime.turnActive) {
			if (update.sessionUpdate === "agent_message_chunk" && runtime.turnFirstTextAt === undefined) runtime.turnFirstTextAt = Date.now();
			else if (update.sessionUpdate === "agent_thought_chunk" && runtime.turnFirstThoughtAt === undefined) runtime.turnFirstThoughtAt = Date.now();
		}
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

	/**
	 * 重放/首次回显的分批投递：把一次全量 flush 切成若干增量块，每块隔一帧发出。
	 *
	 * 首块走「全量」语义（无 upsertFrom，totalLength = 本块条数），让渲染层建立
	 * runtime 来源的缓存；后续块带 upsertFrom + 递增的 totalLength，走既有增量合并。
	 * 末块的 totalLength 等于真实总条数，缓存收敛到与一次性全量完全一致的状态。
	 *
	 * 中断规则：分块期间投影被改写（用户已经发消息、新一轮开始）就停止分块并补一次
	 * 常规全量 flush —— 绝不能留下「只投了前几百条」的残缺历史。
	 */
	flushMessagesChunked(runtime: AcpAgentRuntime): void {
		if (runtime.status === "closed" || !this.host.ownsRuntime(runtime)) return;
		const all = runtime.projection.messages;
		// 先定投递窗口：条数预算优先、轮边界对齐（见 acpReplayWindow）。
		// 窗口起点在会话期内固定，后续流式 flush 复用同一个 W。
		runtime.windowStart = resolveAcpWindowStart(all);
		const windowStart = runtime.windowStart;
		const windowMessages = all.slice(windowStart);
		if (windowMessages.length <= REPLAY_CHUNK_MIN_MESSAGES) {
			this.flushMessages(runtime, true, { replay: true });
			return;
		}
		// 内存快照一次写全量：分块只是投递节奏，快照始终是完整历史
		if (runtime.acpSessionId) this.snapshots.set(runtime.acpSessionId, all);
		let sent = 0;
		const emitNext = (): void => {
			if (runtime.status === "closed" || !this.host.ownsRuntime(runtime)) return;
			if (runtime.projection.messages !== all) {
				// 投影已被新一轮改写：停止分块，用常规全量把缓存校准到最新
				this.flushMessages(runtime, true);
				return;
			}
			const end = Math.min(windowMessages.length, sent + REPLAY_CHUNK_MESSAGES);
			const base = { agentId: runtime.tab.id, deckSessionId: runtime.tab.deckSessionId, ...(windowStart > 0 ? { windowStart } : {}) };
			// totalLength 按「已投递到的绝对下标」递增：渲染层按 totalLength - windowStart
			// 校验合并长度，末块自然收敛到真实总条数。
			const totalLength = windowStart + end;
			// replay：告诉订阅方（Web 事件流）这份窗口是激活重放的历史，不能当增量上屏；
			// turnActive：重放来自仍在跑的回合（握手期间就发了 prompt）时不能收口进行中的流。
			const payload = sent === 0 ? { ...base, messages: windowMessages.slice(0, end), totalLength, replay: true, turnActive: runtime.turnActive } : { ...base, messages: windowMessages.slice(sent, end), upsertFrom: windowStart + sent, totalLength, replay: true, turnActive: runtime.turnActive };
			emitAgentMessageMeasured("acp", runtime.tab.id, payload, (measured) => this.host.emit(agentEventTags.agentsMessage, measured));
			sent = end;
			if (sent < windowMessages.length) {
				const timer = setTimeout(emitNext, REPLAY_CHUNK_INTERVAL_MS);
				timer.unref?.();
			}
		};
		emitNext();
	}

	flushMessages(runtime: AcpAgentRuntime, force: boolean, options: { replay?: boolean } = {}): void {
		if (runtime.status === "closed" || !this.host.ownsRuntime(runtime)) return;
		if (force && runtime.flushTimer) {
			clearTimeout(runtime.flushTimer);
			runtime.flushTimer = null;
			runtime.flushPending = false;
		}
		const all = runtime.projection.messages;
		// 投递窗口：只发 [windowStart..]，更早的历史由「加载更多」按轮翻回来。
		// 窗口起点由重放时的 flushMessagesChunked 定下并在会话期内固定；这里直接复用，
		// 避免窗口右移牵动前缀去重协议（pi 的 slideOut 那套）。
		const windowStart = Math.min(Math.max(0, runtime.windowStart), all.length);
		emitAgentMessageMeasured(
			"acp",
			runtime.tab.id,
			{
				agentId: runtime.tab.id,
				deckSessionId: runtime.tab.deckSessionId,
				messages: all.slice(windowStart),
				totalLength: all.length,
				...(windowStart > 0 ? { windowStart } : {}),
				...(options.replay ? { replay: true, turnActive: runtime.turnActive } : {}),
			},
			(payload) => this.host.emit(agentEventTags.agentsMessage, payload),
		);
		// 内存快照：stop/升级强杀后 runtime 删除，重入会话时 readMessagesByAcpSessionId
		// 用它避免时间线空白；激活后 session/load 重放会覆盖为完整历史。
		if (runtime.acpSessionId) {
			this.snapshots.set(runtime.acpSessionId, runtime.projection.messages);
		}
	}
}

/**
 * 在途工具调用集合维护（stall 看门狗的豁免依据）：tool_call 开始入集；tool_call_update
 * 的 pending/in_progress 再入集（容忍重复帧），显式终态（completed/failed 及后续新枚举）
 * 出集——宁可提前解除豁免（回落全静默判定），也不让脏帧把豁免永久挂住。
 *
 * 省略 status 的 tool_call_update 必须保持原成员资格：ACP 规范里除 toolCallId 外字段
 * 全可选，工具流式输出就是「只带 content、不带 status」的补丁帧。把它当终态处理会让
 * 「先刷一段正文、随后长时间静默」的长命令重新被 stall 看门狗误杀（正是 #411 的形态）。
 * 真悬死（工具永不报终态）仍由回合兑底超时收口，不会永久豁免。
 * toolCallId 非法直接忽略（同投影器口径）；幂等无副作用，回合收口点统一 clear。
 */
function trackInFlightToolCall(runtime: AcpAgentRuntime, update: AcpSessionUpdate): void {
	if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
	const toolCallId = (update as AcpToolCallUpdate).toolCallId;
	if (typeof toolCallId !== "string" || !toolCallId) return;
	if (update.sessionUpdate === "tool_call") {
		runtime.inFlightToolCalls.add(toolCallId);
		return;
	}
	const status = (update as AcpToolCallUpdate).status;
	// undefined/null 都是「本次补丁没说生命周期」：不动集合（见上方注释）。
	if (status == null) return;
	if (status === "pending" || status === "in_progress") {
		runtime.inFlightToolCalls.add(toolCallId);
		return;
	}
	runtime.inFlightToolCalls.delete(toolCallId);
}
