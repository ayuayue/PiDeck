import type { BrowserWindow } from "electron";
import type { AgentStatus, AgentTab, PetAggregateState, PetMode, PetNotification } from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";

/**
 * PetStateBridge —— 多 Agent 状态聚合为一个宠物动画状态。
 * 订阅 AgentManager，去抖后推送给宠物窗。
 * 过渡态：closed→waving→hidden，running→review→idle，error→failed→idle。
 */

const PRIORITY: AgentStatus[] = ["error", "running", "starting", "idle"];

function statusToMode(status: AgentStatus): PetMode | null {
	switch (status) {
		case "running": return "running";
		case "error": return "failed";
		case "starting": return "waiting";
		case "idle": return "idle";
		default: return null;
	}
}

function pickFocusAgent(active: AgentTab[]): string | null {
	if (active.length === 0) return null;
	const firstError = active.find((a) => a.status === "error");
	if (firstError) return firstError.id;
	const running = active.filter((a) => a.status === "running").sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	if (running.length > 0) return running[0].id;
	return active.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0].id;
}

function aggregate(tabs: AgentTab[]): PetAggregateState {
	const active = tabs.filter((a) => a.status !== "closed");
	if (active.length === 0) {
		// 无活跃 Agent 时不隐藏宠物，保持 idle 待机，让用户知道宠物已启用。
		// 原设计隐去宠物以减少桌面干扰，但用户期待启动后即见。
		return { mode: "idle", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: Date.now() };
	}
	let mode: PetMode = "idle";
	for (const status of PRIORITY) {
		if (active.some((a) => a.status === status)) {
			const mapped = statusToMode(status);
			if (mapped) { mode = mapped; break; }
		}
	}
	return {
		mode,
		runningCount: active.filter((a) => a.status === "running").length,
		errorCount: active.filter((a) => a.status === "error").length,
		activeAgentId: pickFocusAgent(active),
		timestamp: Date.now(),
	};
}

export class PetStateBridge {
	private debounceTimer: NodeJS.Timeout | null = null;
	private lastState: PetAggregateState | null = null;
	private lastChangeAt = 0;

	/** 统一的过渡定时器（替代 waving/review/failed/tease 四个独立 timer） */
	private transTimer: NodeJS.Timeout | null = null;
	/** 错误状态冷却：展示后 N ms 内抑制重复推送 */
	private errorCooldownUntil = 0;

	private currentTabs: AgentTab[] = [];
	private unsubscribe: (() => void) | null = null;

	private readonly debounceMs = 150;
	private readonly minStateHoldMs = 600;

	constructor(
		private readonly getPetWindow: () => BrowserWindow | null,
		private readonly patrol: { start: () => void; stop: () => void; active: boolean; setDragging: (d: boolean) => void } | null = null,
		private readonly isPatrolEnabled: () => boolean = () => true,
	) {}

	get currentState(): PetAggregateState | null { return this.lastState; }

	attach(agentManager: { addStateListener: (cb: (tabs: AgentTab[]) => void) => () => void }) {
		this.unsubscribe = agentManager.addStateListener((tabs) => this.update(tabs));
	}

	detach() {
		this.unsubscribe?.(); this.unsubscribe = null;
		if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
		this.clearTransition();
		this.patrol?.stop();
	}

	update(tabs: AgentTab[]) {
		this.currentTabs = tabs;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => { this.debounceTimer = null; this.push(aggregate(tabs)); }, this.debounceMs);
	}

	pushNow(tabs: AgentTab[]) {
		this.currentTabs = tabs;
		if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
		this.push(aggregate(tabs));
	}

	// ── 过渡管理 ──

	/** 设置统一过渡定时器，自动清除上一个 */
	private setTransition(ms: number, fn: () => void) {
		this.clearTransition();
		this.transTimer = setTimeout(() => { this.transTimer = null; fn(); }, ms);
	}

	private clearTransition() {
		if (this.transTimer) { clearTimeout(this.transTimer); this.transTimer = null; }
	}

	// ── 状态推送核心 ──

	private push(state: PetAggregateState) {
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

		// ⚠️ 过渡恢复定时器（review→idle / failed→idle / tease 恢复）只能在「确定要落地新状态」时取消。
		// 原实现在此无条件 clearTransition()，而下方冷却/锁/重叠检查又会提前 return：
		// 恢复定时器被取消、状态却不变 → 宠物永远卡在 review/failed/jumping
		// （用户反馈：成功后一直跳舞、一直重复一个动作不停下来，根因在此）。

		// ── running→review→idle ──
		if (target === "idle" && prev?.mode === "running") {
			this.applyState({ ...state, mode: "review" });
			this.sendNotif({ type: "done", text: "任务完成，记得 Review", timestamp: Date.now() });
			this.lastChangeAt = Date.now();
			this.setTransition(4000, () => {
				// 双保险：定时器触发时若状态已被其它推送切走，不强行归位
				if (this.lastState?.mode !== "review") return;
				this.applyState({ ...state, mode: "idle" });
				this.maybeStartPatrol();
			});
			return;
		}

		// review 进行中忽略重叠 idle 推送（恢复定时器会把它带回 idle，绝不能取消）
		if (target === "idle" && prev?.mode === "review") return;

		// ── failed 过渡 ──
		if (target === "failed") {
			const now = Date.now();
			// 冷却期内的重复 error 推送：忽略且保留恢复定时器（否则会永远卡在 failed）
			if (this.errorCooldownUntil > now) return;
			this.errorCooldownUntil = now + 10000;
			if (prev?.mode !== "failed") {
				this.applyState(state);
				const errored = this.currentTabs.find(t => t.status === "error");
				if (errored) this.sendNotif({ type: "error", text: `${errored.title} 出错了`, agentId: errored.id, timestamp: now });
				this.setTransition(4000, () => {
					if (this.lastState?.mode !== "failed") return;
					this.applyState({ ...state, mode: "idle" });
					this.maybeStartPatrol();
				});
			}
			return;
		}

		// ── 动画完成锁：避免 running↔idle 抖动 ──
		const now = Date.now();
		if (prev && prev.mode !== "hidden" && prev.mode !== "waving" && target !== prev.mode && now - this.lastChangeAt < this.minStateHoldMs) return;
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
		const saved = aggregate(this.currentTabs);
		this.patrol?.stop();
		this.applyState({ ...saved, mode: "jumping" });
		this.setTransition(2500, () => this.push(aggregate(this.currentTabs)));
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
				const real = aggregate(this.currentTabs);
				// 巡游态下业务侧必然是 idle（否则巡游不会启动），归位为 idle
				this.applyState({ ...real, mode: "idle" });
			}
			return;
		}
		this.maybeStartPatrol();
	}

	// ── 工具 ──

	private sendNotif(n: PetNotification) {
		const win = this.getPetWindow();
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.petNotify, n);
	}

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
