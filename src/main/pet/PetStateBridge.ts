import type { BrowserWindow } from "electron";
import type { AgentStatus, AgentTab, AgentUiRequest, PetAggregateState, PetMode, PetNotification } from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";

/**
 * PetStateBridge —— 多 Agent 状态聚合为一个宠物动画状态，并驱动头顶提醒气泡。
 * 订阅 AgentManager 状态与事件，去抖后推送给宠物窗。
 *
 * 状态来源（全部为现有权威事实，不复刻 pi 行为）：
 * - 动画聚合：AgentTab.status（error > running > starting > idle）
 * - 等待操作：agents:ui-request（select/confirm/input/editor/batch_ask 的 pending 生命周期）
 * - 已完成：AgentManager 成功 settled 事件（带 Agent 身份与标题）
 * - 出现问题：AgentTab.status 首次进入 error 的边沿
 *
 * 过渡态：closed→waving→hidden，running→review→业务态，error→failed（错误持续期间保持，清除后回落真实状态）。
 */

const PRIORITY: AgentStatus[] = ["error", "running", "starting", "idle"];

/** 阻塞式交互 UI 方法：进入 pending 才显示「等待操作」；notify/setWidget/setStatus 等非阻塞方法不算。 */
const WAITING_METHODS = new Set(["select", "confirm", "input", "editor", "batch_ask"]);

/** 同一 Agent 成功完成的提醒冷却：settled 与 get_state 兜底可能重复触发，8 秒内只提醒一次 */
const DONE_COOLDOWN_MS = 8000;

export type PetStateCopyKey = "pet.doneNotification" | "pet.agentError" | "pet.waitingNotification" | "pet.doneSuffix" | "pet.errorSuffix" | "pet.waitingSuffix";

const defaultPetStateCopy: Record<PetStateCopyKey, string> = {
	"pet.doneNotification": "{title} completed",
	"pet.agentError": "{title} encountered a problem",
	"pet.waitingNotification": "{title} needs your input",
	"pet.doneSuffix": "completed",
	"pet.errorSuffix": "encountered a problem",
	"pet.waitingSuffix": "needs your input",
};

function defaultTranslate(key: PetStateCopyKey, params: Record<string, string> = {}): string {
	return defaultPetStateCopy[key].replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? params[name] : match));
}

function statusToMode(status: AgentStatus): PetMode | null {
	switch (status) {
		case "running":
			return "running";
		case "error":
			return "failed";
		case "starting":
			return "waiting";
		case "idle":
			return "idle";
		default:
			return null;
	}
}

function pickFocusAgent(active: AgentTab[], pendingRequests: Map<string, Set<string>>): string | null {
	if (active.length === 0) return null;
	const firstError = active.find((a) => a.status === "error");
	if (firstError) return firstError.id;
	// 最新登记的 pending 请求所属 Agent（Map 迭代序 = 插入序）
	for (const agentId of pendingRequests.keys()) {
		if (active.some((a) => a.id === agentId)) return agentId;
	}
	const running = active.filter((a) => a.status === "running").sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	if (running.length > 0) return running[0].id;
	return active.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0].id;
}

function aggregate(tabs: AgentTab[], pendingRequests: Map<string, Set<string>>): PetAggregateState {
	const active = tabs.filter((a) => a.status !== "closed");
	if (active.length === 0) {
		// 无活跃 Agent 时不隐藏宠物，保持 idle 待机，让用户知道宠物已启用。
		return { mode: "idle", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: Date.now() };
	}
	const errorCount = active.filter((a) => a.status === "error").length;
	const runningCount = active.filter((a) => a.status === "running").length;
	let mode: PetMode = "idle";
	if (errorCount > 0) {
		mode = "failed";
	} else if (pendingRequests.size > 0) {
		// 等待用户操作（ask_question 等）优先于 running：请求期间 pi 通常仍标 running
		mode = "waiting";
	} else {
		for (const status of PRIORITY) {
			if (active.some((a) => a.status === status)) {
				const mapped = statusToMode(status);
				if (mapped) {
					mode = mapped;
					break;
				}
			}
		}
	}
	return {
		mode,
		runningCount,
		errorCount,
		activeAgentId: pickFocusAgent(active, pendingRequests),
		timestamp: Date.now(),
	};
}

export class PetStateBridge {
	private debounceTimer: NodeJS.Timeout | null = null;
	private lastState: PetAggregateState | null = null;
	private lastChangeAt = 0;

	/** 统一的过渡定时器（替代 waving/review/failed/tease 四个独立 timer） */
	private transTimer: NodeJS.Timeout | null = null;

	private currentTabs: AgentTab[] = [];
	private unsubscribe: (() => void) | null = null;

	/** agentId -> 未回应的交互请求 id 集合（select/confirm/input/editor/batch_ask） */
	private readonly pendingRequests = new Map<string, Set<string>>();
	/** agentId -> 最近一次快照 status，用于 error 边沿检测 */
	private readonly lastTabsByAgent = new Map<string, AgentStatus>();
	/** agentId -> 成功完成提醒冷却截止时间戳 */
	private readonly doneCooldownUntil = new Map<string, number>();
	/** 首帧基线：启动时已存在的 error 不触发「出现问题」提醒 */
	private baselineBuilt = false;

	private readonly debounceMs = 150;
	private readonly minStateHoldMs = 600;

	constructor(
		private readonly getPetWindow: () => BrowserWindow | null,
		private readonly patrol: { start: () => void; stop: () => void; active: boolean; setDragging: (d: boolean) => void } | null = null,
		private readonly isPatrolEnabled: () => boolean = () => true,
		private readonly translate: (key: PetStateCopyKey, params?: Record<string, string>) => string = defaultTranslate,
		/** 通知出口：由 PetSystem 负责窗口扩展、4 秒计时与 null 清理；null 表示清空当前提醒 */
		private readonly notify: (n: PetNotification | null) => void = () => {},
	) {}

	get currentState(): PetAggregateState | null {
		return this.lastState;
	}

	attach(agentManager: { addStateListener: (cb: (tabs: AgentTab[]) => void) => () => void }) {
		this.unsubscribe = agentManager.addStateListener((tabs) => this.update(tabs));
	}

	detach() {
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.clearTransition();
		this.patrol?.stop();
	}

	update(tabs: AgentTab[]) {
		this.currentTabs = tabs;
		this.detectErrorEdges(tabs);
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.push(aggregate(tabs, this.pendingRequests));
		}, this.debounceMs);
	}

	pushNow(tabs: AgentTab[], force = true) {
		this.currentTabs = tabs;
		this.detectErrorEdges(tabs);
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.push(aggregate(tabs, this.pendingRequests), force);
	}

	// ── 等待操作（agents:ui-request） ──

	/**
	 * 接收已规范化的扩展 UI 请求事件（PetSystem 从 agentManager.onOutput 转发）。
	 * 只有阻塞式交互方法进入 waiting；completed 事件（回应/取消/超时/abort 统一路径）清除。
	 */
	updateUIRequest(payload: AgentUiRequest) {
		const { agentId, requestId } = payload;
		if (!agentId || !requestId) return;
		if (payload.completed === true) {
			this.removePending(agentId, requestId);
			return;
		}
		if (!WAITING_METHODS.has(payload.method)) return;
		if (!this.pendingRequests.has(agentId)) this.pendingRequests.set(agentId, new Set());
		this.pendingRequests.get(agentId)!.add(requestId);
		// 立即推送 waiting 态与提醒，不等 debounce
		this.pushNow(this.currentTabs);
		this.sendWaitingNotif();
	}

	/** 重新推送当前 waiting 提醒（PetSystem 在非持久化提醒展示结束后排队恢复时调用） */
	pushWaitingNow() {
		if (this.pendingRequests.size === 0) return;
		this.sendWaitingNotif();
	}

	/** 当前是否有等待用户操作的请求（PetSystem 排队逻辑用） */
	hasPendingAction(): boolean {
		return this.pendingRequests.size > 0;
	}

	private removePending(agentId: string, requestId: string) {
		const set = this.pendingRequests.get(agentId);
		if (!set || !set.delete(requestId)) return;
		if (set.size === 0) this.pendingRequests.delete(agentId);
		this.pushNow(this.currentTabs);
		if (this.pendingRequests.size === 0) this.notify(null);
	}

	/** 最新登记的 pending 请求所属 Agent；无则 null */
	private latestPendingAgentId(): string | null {
		let last: string | null = null;
		for (const agentId of this.pendingRequests.keys()) last = agentId;
		return last;
	}

	private sendWaitingNotif() {
		const agentId = this.latestPendingAgentId();
		const title = agentId ? this.currentTabs.find((t) => t.id === agentId)?.title : undefined;
		this.notify({
			type: "waiting",
			text: this.translate("pet.waitingNotification", { title: title || "Agent" }),
			agentId: agentId ?? undefined,
			timestamp: Date.now(),
			persistent: true,
			title: title || "Agent",
			status: this.translate("pet.waitingSuffix"),
		});
	}

	/** AgentManager 确认成功空闲（agent_settled / 兜底无工作）后调用，携带完成者身份。 */
	onAgentSettled(info: { agentId: string; title: string }) {
		// Agent 已不存在（settled 后立刻被关闭）时不打扰
		if (!this.currentTabs.some((t) => t.id === info.agentId)) return;
		// 有待操作或错误时，不被另一 Agent 的完成提醒打扰
		if (this.pendingRequests.size > 0) return;
		if (this.currentTabs.some((t) => t.status === "error")) return;
		const now = Date.now();
		if (now < (this.doneCooldownUntil.get(info.agentId) ?? 0)) return;
		this.doneCooldownUntil.set(info.agentId, now + DONE_COOLDOWN_MS);
		this.notify({
			type: "done",
			text: this.translate("pet.doneNotification", { title: info.title || "Agent" }),
			agentId: info.agentId,
			timestamp: now,
			title: info.title || "Agent",
			status: this.translate("pet.doneSuffix"),
		});
	}

	/** per-Agent 首次进入 error 时发「出现问题」提醒；首帧基线不提醒 */
	private detectErrorEdges(tabs: AgentTab[]) {
		const seen = new Set<string>();
		// closed 视为已消失：不参与基线/边沿，残留 pending 与冷却一并清理
		const live = tabs.filter((t) => t.status !== "closed");
		if (!this.baselineBuilt) {
			this.baselineBuilt = true;
			for (const tab of live) this.lastTabsByAgent.set(tab.id, tab.status);
			return;
		}
		for (const tab of live) {
			seen.add(tab.id);
			const prev = this.lastTabsByAgent.get(tab.id);
			if (prev !== "error" && tab.status === "error") {
				this.notify({
					type: "error",
					text: this.translate("pet.agentError", { title: tab.title || "Agent" }),
					agentId: tab.id,
					timestamp: Date.now(),
					title: tab.title || "Agent",
					status: this.translate("pet.errorSuffix"),
				});
			}
			this.lastTabsByAgent.set(tab.id, tab.status);
		}
		// 清理已消失/关闭 Agent 的残留状态；残留 pending 全部清空后收起 waiting 提醒
		let pendingChanged = false;
		for (const id of [...this.lastTabsByAgent.keys()]) {
			if (seen.has(id)) continue;
			this.lastTabsByAgent.delete(id);
			this.doneCooldownUntil.delete(id);
			if (this.pendingRequests.delete(id)) pendingChanged = true;
		}
		if (pendingChanged && this.pendingRequests.size === 0) this.notify(null);
	}

	// ── 过渡管理 ──

	/** 设置统一过渡定时器，自动清除上一个 */
	private setTransition(ms: number, fn: () => void) {
		this.clearTransition();
		this.transTimer = setTimeout(() => {
			this.transTimer = null;
			fn();
		}, ms);
	}

	private clearTransition() {
		if (this.transTimer) {
			clearTimeout(this.transTimer);
			this.transTimer = null;
		}
	}

	// ── 状态推送核心 ──

	private push(state: PetAggregateState, force = false) {
		const prev = this.lastState;
		const target = state.mode;

		// ── hidden 过渡：先 waving 再 hidden ──
		if (target === "hidden") {
			if (prev?.mode === "waving") return;
			// 所有 Agent 关闭 → 隐藏：立即停巡游，避免挥手/隐藏期间仍在走动
			this.patrol?.stop();
			if (prev && prev.mode !== "hidden") {
				this.applyState({ ...state, mode: "waving" });
				this.setTransition(1500, () => this.applyState({ ...state, mode: "hidden" }));
				return;
			}
			this.applyState(state);
			return;
		}

		// ⚠️ 过渡恢复定时器（review→业务态 / failed→业务态 / tease 恢复）只能在「确定要落地新状态」时取消。
		// 原实现在此无条件 clearTransition()，而下方动画锁/重叠检查又会提前 return：
		// 恢复定时器被取消、状态却不变 → 宠物永远卡在 review/failed/jumping
		// （用户反馈：成功后一直跳舞、一直重复一个动作不停下来，根因在此）。

		// ── running→review→业务态（完成动画；完成提醒由 onAgentSettled 事件驱动，带准确标题） ──
		if (target === "idle" && prev?.mode === "running") {
			this.applyState({ ...state, mode: "review" });
			this.lastChangeAt = Date.now();
			this.setTransition(4000, () => {
				// 双保险：定时器触发时若状态已被其它推送切走，不强行归位
				if (this.lastState?.mode !== "review") return;
				// 重新聚合当前业务状态：庆祝期间可能已有新任务启动，不能按旧快照强制回 idle
				this.settleFromOverlay();
			});
			return;
		}

		// review 进行中忽略重叠 idle 推送（恢复定时器会把它带回 idle，绝不能取消）
		if (target === "idle" && prev?.mode === "review") return;

		// ── failed（提醒由 detectErrorEdges 驱动，动画在此） ──
		if (target === "failed") {
			// 已在 failed：保持现状（错误持续期间宠物保持警示动画，不重复闪播）。
			// 注：早期实现用 10s 冷却整体吞掉重复错误推送，导致错误清除后再出错时
			// 宠物停留在 idle/巡游，与业务状态脱节（多任务并发场景），已移除。
			if (prev?.mode === "failed") return;
			// 巡游与业务态互斥：落地 failed 立即停巡游，防止散步帧每 50ms 覆盖错误动画
			this.patrol?.stop();
			this.applyState(state);
			this.setTransition(4000, () => {
				// 双保险：定时器触发时若状态已被其它推送切走，不强行归位
				if (this.lastState?.mode !== "failed") return;
				// 重新聚合当前业务状态：错误已清除 → 回落真实状态（running/idle）；
				// 错误仍存在 → push(failed) 因 prev 已是 failed 直接 return，保持 failed
				this.settleFromOverlay();
			});
			return;
		}

		// ── 动画完成锁：避免 running↔idle 抖动；force（pushNow：等待操作进入/退出等立即推送）绕过 ──
		const now = Date.now();
		if (!force && prev && prev.mode !== "hidden" && prev.mode !== "waving" && target !== prev.mode && now - this.lastChangeAt < this.minStateHoldMs) return;
		if (prev?.mode === target) return;

		// 走到这里说明确实要落地新状态：取消 pending 过渡（如 waving→hidden、tease 恢复）
		this.clearTransition();
		this.applyState(state);

		// 巡游：业务态停，idle 启
		if (target === "idle") this.maybeStartPatrol();
		else if (target === "running" || target === "waiting") this.patrol?.stop();
	}

	// ── 逗弄 ──

	tease() {
		const cur = this.lastState?.mode;
		if (cur && ["running", "failed", "waiting", "hidden", "waving", "review"].includes(cur)) return;
		const saved = aggregate(this.currentTabs, this.pendingRequests);
		this.patrol?.stop();
		this.applyState({ ...saved, mode: "jumping" });
		this.setTransition(2500, () => this.push(aggregate(this.currentTabs, this.pendingRequests)));
	}

	/**
	 * 过渡动画（review/failed）到期后的归位：按当前业务聚合状态重新落地，
	 * 而不是回旧快照——过渡期间任务可能已恢复/新启动，强制回 idle 会造成宠物与业务脱节
	 * （多任务场景：A 在跑、B 出错时，failed 闪播后宠物不能闲下来散步）。
	 */
	private settleFromOverlay() {
		const real = aggregate(this.currentTabs, this.pendingRequests);
		if (real.mode === "idle" && this.lastState?.mode === "review") {
			// review 的「重叠 idle 忽略」只放行过渡自身归位，这里直接落地并恢复巡游
			this.applyState(real);
			this.maybeStartPatrol();
			return;
		}
		this.push(real, true);
	}

	/** 当前业务聚合模式（不含 review/failed 等过渡 overlay）。巡游据此判断是否该走：
	 *  业务非 idle（有任务运行/出错/待输入）时，巡逻帧不得抢占动画通道。 */
	businessMode(): PetMode {
		return aggregate(this.currentTabs, this.pendingRequests).mode;
	}

	// ── 巡游 ──

	private maybeStartPatrol() {
		if (!this.patrol || !this.isPatrolEnabled()) return;
		if (this.lastState?.mode === "idle") this.patrol.start();
	}

	/**
	 * 拖拽起止：开始时立刻停巡游并置 dragging 标志（阻塞后续 start）；
	 * 结束时清标志，若仍处于 idle（巡游允许）则从新位置重新起巡。
	 * 标志位是关键——拖拽期间 Agent 状态更新会异步触发 maybeStartPatrol，
	 * 没有标志位拦截就会在拖拽中重新起巡游，与手动移动争抢窗口位置。
	 *
	 * 额外：拖拽开始时若 pet 正在巡游奔跑（running-left/right，由 PetPatrol 直推），
	 * 立刻切回 idle 待机精灵，避免拖拽过程中仍显示「卡住的奔跑帧」。
	 */
	onDragState(dragging: boolean) {
		if (!this.patrol) return;
		// 巡游奔跑态（running-left/right）由 PetPatrol 绕过 bridge 直推渲染端，
		// bridge.lastState 仍停留在巡游启动前的 idle，无法据此判断。
		// 因此用 patrol.active 判定：正在 tick（奔跑中）被抓取 → 归位 idle 待机。
		const wasWalking = this.patrol.active;
		this.patrol.setDragging(dragging);
		if (dragging) {
			if (wasWalking) {
				const real = aggregate(this.currentTabs, this.pendingRequests);
				// 巡游态下业务侧必然是 idle（否则巡游不会启动），归位为 idle
				this.applyState({ ...real, mode: "idle" });
			}
			return;
		}
		this.maybeStartPatrol();
	}

	// ── 工具 ──

	private applyState(state: PetAggregateState) {
		this.lastState = state;
		this.lastChangeAt = Date.now();
		const win = this.getPetWindow();
		if (!win || win.isDestroyed()) return;
		// 隐藏时期望鼠标穿透下层应用，避免透明窗口在上层拦截点击却看不见。
		// 显示时恢复正常事件捕获（允许拖拽、逗弄等交互）。
		const hidden = state.mode === "hidden";
		win.setIgnoreMouseEvents(hidden, hidden ? { forward: true } : undefined);
		win.webContents.send(ipcChannels.petState, state);
	}
}
