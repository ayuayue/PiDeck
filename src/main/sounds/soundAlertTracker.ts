/**
 * 声音提醒事件跟踪器（纯逻辑，无 Electron 依赖，可单测）。
 *
 * 输入 Agent 状态变化/完成回调/UI 请求事件，输出「该不该响」的提醒事件；
 * 与 PetStateBridge 的口径保持一致（error 边沿 + 完成冷却 + waiting 按批去重），
 * 避免同一个完成动作被 agent_settled 与 get_state 兜底重复触发两次。
 *
 * 注意：本模块不读设置——开关/音量/音效引用由 SoundAlertService 在发出前判定，
 * 职责分离：这里只负责「什么时候算一个提醒事件」。
 */
import type { AgentStatus } from "../../shared/types/agent";
import type { AgentUiRequest } from "../../shared/types/agent";
import {
	DEFAULT_SOUND_BY_KIND,
	parseSoundAlertRef,
	type SoundAlertKind,
	type SoundAlertPlayEvent,
	type SoundAlertSettings,
} from "../../shared/types/soundAlert";

/** 触发提醒的交互方法白名单（与 PetStateBridge 的 WAITING_METHODS 一致）。 */
const WAITING_METHODS = new Set(["select", "confirm", "input", "editor", "batch_ask"]);

/** 同一 Agent 成功完成的提醒冷却：settled 与 get_state 兜底可能重复触发，8 秒内只提醒一次 */
export const DONE_COOLDOWN_MS = 8000;
/** 全局冷却：多个 Agent 同时完成时只响最近一次（error 除外，错误更紧急） */
export const GLOBAL_COOLDOWN_MS = 1500;

export type SoundAlertEvent = {
	kind: SoundAlertKind;
	agentId: string;
	title: string;
};

export type SoundAlertTrackerState = {
	/** 首帧基线：启动时已存在的 error 不触发「出错提醒」 */
	baselineBuilt: boolean;
	/** 上次看到的各 Agent 状态（error 边沿检测用） */
	lastStatusByAgent: Map<string, AgentStatus>;
	/** 各 Agent 完成提醒冷却截止时间 */
	doneCooldownUntil: Map<string, number>;
	/** 各 Agent 的待交互请求 id 集合（waiting 按批去重用） */
	pendingRequests: Map<string, Set<string>>;
	/** 本批 pending 已提醒过的 Agent（请求清空后重置，下次再提醒） */
	waitingNotified: Set<string>;
	/** 上次提醒时间（全局冷却） */
	lastPlayedAt: number;
};

export function createSoundAlertTrackerState(): SoundAlertTrackerState {
	return {
		baselineBuilt: false,
		lastStatusByAgent: new Map(),
		doneCooldownUntil: new Map(),
		pendingRequests: new Map(),
		waitingNotified: new Set(),
		lastPlayedAt: 0,
	};
}

/** 清理已消失 Agent 的残留状态（closed 或从列表移除）。 */
function pruneAgent(state: SoundAlertTrackerState, agentId: string) {
	state.lastStatusByAgent.delete(agentId);
	state.doneCooldownUntil.delete(agentId);
	state.pendingRequests.delete(agentId);
	state.waitingNotified.delete(agentId);
}

/**
 * 状态快照边沿检测：error 边沿（prev !== "error" && now === "error"）产出提醒。
 * 首帧只建基线不提醒（启动时已挂着的错误是历史状态，不是新事件）。
 * 同时清理已消失 Agent 的残留。
 */
export function trackAgentTabs(
	state: SoundAlertTrackerState,
	tabs: ReadonlyArray<{ id: string; status: AgentStatus; title: string }>,
	now: number,
): SoundAlertEvent[] {
	const events: SoundAlertEvent[] = [];
	const live = new Set<string>();
	for (const tab of tabs) {
		if (tab.status === "closed") continue;
		live.add(tab.id);
		const prev = state.lastStatusByAgent.get(tab.id);
		if (!state.baselineBuilt) {
			state.lastStatusByAgent.set(tab.id, tab.status);
			continue;
		}
		if (prev !== "error" && tab.status === "error") {
			events.push({ kind: "error", agentId: tab.id, title: tab.title || "Agent" });
		}
		state.lastStatusByAgent.set(tab.id, tab.status);
	}
	if (!state.baselineBuilt) {
		state.baselineBuilt = true;
		return events;
	}
	for (const agentId of [...state.lastStatusByAgent.keys()]) {
		if (!live.has(agentId)) pruneAgent(state, agentId);
	}
	return events;
}

/**
 * Agent 成功空闲（onAgentSettled / get_state 兜底）→ 完成提醒。
 * 带 8 秒 per-Agent 冷却（settled 与兜底可能双触发）；同一时刻多个 Agent
 * 完成时全局 1.5 秒冷却只放行最近一次（避免叠音）。
 */
export function trackAgentSettled(
	state: SoundAlertTrackerState,
	agentId: string,
	title: string,
	now: number,
): SoundAlertEvent | null {
	const cooldownUntil = state.doneCooldownUntil.get(agentId) ?? 0;
	if (now < cooldownUntil) return null;
	// lastPlayedAt=0 表示从未播放：首事件不受全局冷却影响（测试/首次触发用小数时间戳也成立）
	if (state.lastPlayedAt > 0 && now - state.lastPlayedAt < GLOBAL_COOLDOWN_MS) return null;
	// 只有真正播放才写 per-Agent 冷却：被全局冷却吞掉的完成事件，
	// 其 get_state 兜底（几秒后）仍有机会在全局冷却结束后正常提醒，而不是被永久吞掉。
	state.doneCooldownUntil.set(agentId, now + DONE_COOLDOWN_MS);
	state.lastPlayedAt = now;
	return { kind: "done", agentId, title: title || "Agent" };
}

/**
 * 扩展 UI 请求 → waiting 提醒。
 * 只对阻塞式交互方法（select/confirm/input/editor/batch_ask）计数；
 * 同一 Agent 的一批 pending 只提醒一次，全部清空后重置，下次新批再提醒。
 */
export function trackUiRequest(
	state: SoundAlertTrackerState,
	payload: AgentUiRequest,
	now: number,
): SoundAlertEvent | null {
	const { agentId, requestId } = payload;
	if (!agentId || !requestId) return null;
	if (payload.completed === true) {
		const set = state.pendingRequests.get(agentId);
		if (!set || !set.delete(requestId)) return null;
		if (set.size === 0) {
			state.pendingRequests.delete(agentId);
			state.waitingNotified.delete(agentId);
		}
		return null;
	}
	if (!WAITING_METHODS.has(payload.method)) return null;
	if (!state.pendingRequests.has(agentId)) state.pendingRequests.set(agentId, new Set());
	state.pendingRequests.get(agentId)!.add(requestId);
	if (state.waitingNotified.has(agentId)) return null;
	// lastPlayedAt=0 表示从未播放：首事件不受全局冷却影响
	if (state.lastPlayedAt > 0 && now - state.lastPlayedAt < GLOBAL_COOLDOWN_MS) return null;
	state.waitingNotified.add(agentId);
	state.lastPlayedAt = now;
	return { kind: "waiting", agentId, title: payload.title || "Agent" };
}

/** 音量钳制：非有限数/越界一律回落 0–1 区间（默认 0.6）。 */
export function clampSoundVolume(value: number): number {
	if (!Number.isFinite(value)) return 0.6;
	return Math.min(1, Math.max(0, value));
}

/**
 * 设置门控 → 播放载荷（纯函数，可单测）：
 * - 总开关/分事件开关关闭 → null（不播放）；
 * - 音效引用非法/为空 → 回落到该事件的默认预设（保证「开了就一定能响」）；
 * - 返回音量已钳制的 SoundAlertPlayEvent，渲染层直接播放。
 */
export function resolveSoundPlayback(
	kind: SoundAlertKind,
	title: string,
	settings: SoundAlertSettings | undefined,
): SoundAlertPlayEvent | null {
	if (!settings || !settings.enabled) return null;
	const eventConfig = settings[kind];
	if (!eventConfig || !eventConfig.enabled) return null;
	const ref = eventConfig.sound ?? "";
	const soundId = parseSoundAlertRef(ref) ? ref : DEFAULT_SOUND_BY_KIND[kind];
	return {
		kind,
		title,
		soundId,
		volume: clampSoundVolume(settings.volume),
	};
}
