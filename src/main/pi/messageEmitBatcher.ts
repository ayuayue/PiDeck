import type { ChatMessage } from "../../shared/types";
import { buildMessageFlushPayload, stripToolResultForDelivery } from "./agentUtils";

/** flush 批处理器需要的宿主能力（AgentManager 注入：消息存储、窗口数学、发射通道）。 */
export interface MessageEmitHost {
	/** agent 的当前消息数组（AgentManager.messages 投影）。 */
	getMessages(agentId: string): ChatMessage[];
	/** 激活显示窗口起点（尾部 N 轮，口径与 loadMessages/trimRuntimeCache 一致）。 */
	computeDisplayWindowStart(messages: ChatMessage[]): number;
	/** 渲染层「加载更多」的数值游标（windowStart 对应的会话文件位置）。 */
	computeWindowStartFilePos(agentId: string, messages: ChatMessage[], windowStart: number): number | undefined;
	/** 会话文件版本（mtime:size）；渲染层据此检测压缩改写并丢弃 disk 前缀。 */
	sessionFileVersion(agentId: string): string | undefined;
	/** 发送 agents:message payload（AgentManager.emit）。 */
	emitMessageFlush(payload: ReturnType<typeof buildMessageFlushPayload>): void;
	/** flush 后同步本地流式标志（isStreaming 等，无 RPC 的轻量 patch）。 */
	emitStreamingStatePatch(agentId: string): void;
}

/**
 * agents:message 的节流批处理与显示窗口推进（从 AgentManager 迁出，行为零变化）。
 *
 * 职责：50ms 节流合批、immediate 终态全量 flush、dirtyFrom 增量标记、
 * 尾部 9 轮窗口右移检测与 slideOut 队列。消息数组本体与投影仍在 AgentManager
 * （flush 只读取快照）；窗口数学经宿主回调保持三处口径一致
 * （loadMessages / flush / trimRuntimeCache，见 computeDisplayWindowStart 契约）。
 *
 * 注：Map 字段保留 public——行为测试（agentManagerRuntimeCache）直接注入
 * windowStart / 读取 pendingSlideOut 验证滑出协议，是既定测试缝。
 */
export class MessageEmitBatcher {
	/** 节流定时器（per agent）。 */
	public readonly flushTimers = new Map<string, NodeJS.Timeout>();
	/** 已进入待 flush 集合的 agent。 */
	public readonly pendingAgents = new Set<string>();
	/** 消息数组自 index 起变脏（多次标记取最小值），供增量 flush 使用。 */
	public readonly dirtyFromByAgent = new Map<string, number>();
	/** 激活显示窗口起点（全量 payload 的 slice 锚点）。 */
	public readonly displayWindowStartByAgent = new Map<string, number>();
	/** displayWindowStartByAgent 最近一次重算时的数组长度（长度不变则跳过重算）。 */
	public readonly displayWindowComputedLengthByAgent = new Map<string, number>();
	/** 窗口右移滑出的旧窗口头部轮次；仅在全量 flush 时随 payload 下发。 */
	public readonly pendingSlideOutByAgent = new Map<string, ChatMessage[]>();
	/** 流式高频事件节流间隔：同一 agent 50ms 内多次调用只 emit 一次最新数组。 */
	private static readonly MESSAGE_FLUSH_INTERVAL_MS = 50;

	constructor(private readonly host: MessageEmitHost) {}

	/**
	 * 安排一次消息 emit。流式高频事件走节流合并（同一 agent 50ms 内多次调用只 emit 一次最新数组）；
	 * immediate=true 时跳过节流立即 flush，用于 message_end/tool_execution_end 等终态事件，确保最终状态不丢。
	 */
	schedule(agentId: string, immediate = false): void {
		if (immediate) {
			// 终态 immediate flush 永远全量：作为渲染层增量合并的天然校准点，
			// 丢弃的增量（长度不连续）由这里的全量纠正（message_end/tool 结束/加载完成）。
			this.dirtyFromByAgent.delete(agentId);
			this.flush(agentId);
			return;
		}
		if (this.pendingAgents.has(agentId)) return;
		this.pendingAgents.add(agentId);
		const timer = setTimeout(() => this.flush(agentId), MessageEmitBatcher.MESSAGE_FLUSH_INTERVAL_MS);
		// 节流定时器不应阻止进程退出
		timer.unref?.();
		this.flushTimers.set(agentId, timer);
	}

	/** 立即 flush：清 pending 定时器，按 dirtyFrom/窗口推进构造 payload 并发射。 */
	flush(agentId: string): void {
		const timer = this.flushTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.flushTimers.delete(agentId);
		}
		this.pendingAgents.delete(agentId);
		const all = this.host.getMessages(agentId);
		let dirtyFrom = this.dirtyFromByAgent.get(agentId);
		this.dirtyFromByAgent.delete(agentId);
		// 新一轮进入尾部后，窗口起点必须右移到最近 9 轮；坐标变化时升级为
		// 全量快照，并把滑出的完整轮次交给 renderer history 保存。
		const currentWindowStart = this.displayWindowStartByAgent.get(agentId) ?? 0;
		const lastComputedLength = this.displayWindowComputedLengthByAgent.get(agentId) ?? -1;
		let nextWindowStart = currentWindowStart;
		if (all.length !== lastComputedLength) {
			nextWindowStart = this.host.computeDisplayWindowStart(all);
			this.displayWindowComputedLengthByAgent.set(agentId, all.length);
		}
		if (nextWindowStart > currentWindowStart) {
			const slideOut = all.slice(currentWindowStart, nextWindowStart);
			if (slideOut.length > 0) {
				const pending = this.pendingSlideOutByAgent.get(agentId) ?? [];
				this.pendingSlideOutByAgent.set(agentId, [...pending, ...slideOut]);
			}
			dirtyFrom = undefined;
		}
		this.displayWindowStartByAgent.set(agentId, nextWindowStart);
		const windowStart = nextWindowStart;
		const payload = buildMessageFlushPayload(agentId, all, dirtyFrom, windowStart, this.host.sessionFileVersion(agentId), this.host.computeWindowStartFilePos(agentId, all, windowStart));
		// trim 窗口右移滑出的旧窗口头部轮次随全量 flush 下发（渲染层并入历史前缀）；
		// 增量 flush 不携带（新轮还在写），等终态全量校准。
		if (payload.upsertFrom === undefined) {
			const slideOut = this.pendingSlideOutByAgent.get(agentId);
			if (slideOut && slideOut.length > 0) {
				// 与窗口段同口径脱敏（删 tool result 大载荷），避免前缀持有未脱敏副本
				payload.slideOut = stripToolResultForDelivery(slideOut);
				this.pendingSlideOutByAgent.delete(agentId);
			}
		}
		this.host.emitMessageFlush(payload);
		// 消息 flush 时顺带同步本地流式标志：text_delta 置位 streamingAgents 后，
		// 渲染进程必须及时拿到 isStreaming=true 才会走逐字渐显；此路径 50ms 节流、
		// 无 RPC（不发 get_state），不会像 emitRuntimeState 那样在高频 delta 下过重。
		this.host.emitStreamingStatePatch(agentId);
	}

	/** 取消节流中的消息推送（不触发 emit），用于 abort/关闭时丢弃 pending 的旧内容。 */
	cancel(agentId: string): void {
		const timer = this.flushTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.flushTimers.delete(agentId);
		}
		this.pendingAgents.delete(agentId);
	}

	/** 标记 agent 消息数组自 index 起变脏（多次标记取最小值），供增量 flush 使用。 */
	markDirtyFrom(agentId: string, index: number): void {
		const prev = this.dirtyFromByAgent.get(agentId);
		if (prev === undefined || index < prev) {
			this.dirtyFromByAgent.set(agentId, Math.max(0, index));
		}
	}

	/** 当前激活显示窗口起点（loadMessages 窗口快照与游标计算用）。 */
	windowStart(agentId: string): number {
		return this.displayWindowStartByAgent.get(agentId) ?? 0;
	}

	/** 直接设置窗口起点（loadMessages 装载后的窗口校准）。 */
	setWindowStart(agentId: string, start: number): void {
		this.displayWindowStartByAgent.set(agentId, start);
	}

	/** 把滑出窗口的轮次排入待发队列（trimRuntimeCache 裁剪/窗口推进时）。 */
	enqueueSlideOut(agentId: string, slideOut: ChatMessage[]): void {
		if (slideOut.length === 0) return;
		const pending = this.pendingSlideOutByAgent.get(agentId) ?? [];
		this.pendingSlideOutByAgent.set(agentId, [...pending, ...slideOut]);
	}

	/** agent 终态清理（clearAgentState）：脏标记与窗口游标随生命周期清空。 */
	clearAgent(agentId: string): void {
		this.dirtyFromByAgent.delete(agentId);
		this.displayWindowStartByAgent.delete(agentId);
		this.displayWindowComputedLengthByAgent.delete(agentId);
	}

	/** agent 停止/删除（stop 路径）：额外丢弃待发滑出轮次。 */
	clearAll(agentId: string): void {
		this.clearAgent(agentId);
		this.pendingSlideOutByAgent.delete(agentId);
		this.cancel(agentId);
	}
}
