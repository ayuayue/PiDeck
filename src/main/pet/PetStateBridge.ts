import type { BrowserWindow } from "electron";
import type { AgentStatus, AgentTab, PetAggregateState, PetMode, PetNotification } from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";

/**
 * PetStateBridge —— 全局聚合状态机（设计文档第 3 节核心）。
 *
 * 多个 Agent 的状态聚合成「一只宠物」的一个动画状态，避免跟随单个 Agent 造成杂乱。
 * 订阅 AgentManager.addStateListener（主进程内部钩子），去抖后推送给宠物窗 webContents。
 *
 * 为什么不用 ipcMain.on("agents:state")：AgentManager.emit() 走 webContents.send，
 * 是主进程→渲染层单向通道，ipcMain 收不到主进程自己发出的消息。故改用对称的
 * addStateListener 钩子（与 FeishuBridge 用的 addLocalEventListener 同一模式）。
 *
 * waving 过渡态：所有 Agent 进入 closed 时，宠物先短暂挥手（行3）再隐藏，
 * 而非直接消失，符合设计文档第 3.2 节「closed 过渡态（短暂挥手后隐藏）」。
 */

/** 聚合优先级：error > running > starting > idle；closed 单独处理为 hidden */
const PRIORITY: AgentStatus[] = ["error", "running", "starting", "idle"];

/** AgentStatus → 宠物动画行（PetMode）映射，沿用 petdex 9 行约定 */
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
			return null; // closed
	}
}

/** 选取点击宠物时应跳转的 Agent：error 优先，次选 running，最后取最近创建的 */
function pickFocusAgent(active: AgentTab[]): string | null {
	if (active.length === 0) return null;
	const firstError = active.find((a) => a.status === "error");
	if (firstError) return firstError.id;
	const running = active
		.filter((a) => a.status === "running")
		.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	if (running.length > 0) return running[0].id;
	// 没有运行/出错时跳到最近创建的活跃 Agent
	return active.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0].id;
}

/** 聚合：遍历所有非 closed 的 Agent，按优先级取首个命中作为全局状态 */
function aggregate(tabs: AgentTab[]): PetAggregateState {
	const active = tabs.filter((a) => a.status !== "closed");
	if (active.length === 0) {
		return { mode: "hidden", runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: Date.now() };
	}

	let mode: PetMode = "idle";
	for (const status of PRIORITY) {
		if (active.some((a) => a.status === status)) {
			const mapped = statusToMode(status);
			if (mapped) {
				mode = mapped;
				break;
			}
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
	/** 去抖定时器句柄 */
	private debounceTimer: NodeJS.Timeout | null = null;
	/** 当前已推送的最近聚合状态（含 activeAgentId，供点击宠物跳转使用） */
	private lastState: PetAggregateState | null = null;
	/** 上次状态变更时间戳，用于动画完成锁 */
	private lastChangeAt = 0;
	/** waving 过渡定时器：hidden 前先挥手 N ms */
	private wavingTimer: NodeJS.Timeout | null = null;
	/** 当前 AgentTab 列表，用于通知气泡中获取出错 Agent 名称 */
	private currentTabs: AgentTab[] = [];
	/** 通知气泡冷却倒数，抑制高频重发（0 表示可发送） */
	private notifyCooldown = 0;
	/** AgentManager 状态监听取消函数 */
	private unsubscribe: (() => void) | null = null;

	/** 去抖窗口：多 Agent 同时启停时避免聚合状态在 running↔idle 间快速跳动 */
	private readonly debounceMs = 150;
	/** 动画完成锁：进入新状态后至少保持一个动画周期，避免半帧切换 */
	private readonly minStateHoldMs = 600;
	/** waving 过渡持续时长：所有 Agent 关闭后先挥手再隐藏 */
	private readonly waveDurationMs = 1500;

	constructor(
		private readonly getPetWindow: () => BrowserWindow | null,
	) {}

	/** 最近一次聚合状态；点击宠物跳转时取 activeAgentId */
	get currentState(): PetAggregateState | null {
		return this.lastState;
	}

	/** 订阅 AgentManager 状态变更 */
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
		if (this.wavingTimer) {
			clearTimeout(this.wavingTimer);
			this.wavingTimer = null;
		}
	}

	/** 接收最新 AgentTab[]，去抖后聚合推送 */
	update(tabs: AgentTab[]) {
		this.currentTabs = tabs;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.push(aggregate(tabs));
		}, this.debounceMs);
	}

	/** 立即推送一次（宠物窗创建后或开关切换时调用，避免等待去抖） */
	pushNow(tabs: AgentTab[]) {
		this.currentTabs = tabs;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.push(aggregate(tabs));
	}

	private push(state: PetAggregateState) {
		const prev = this.lastState;
		const target = state.mode;

		// hidden 过渡：所有 Agent 关闭时先挥手再隐藏，而非直接消失
		if (target === "hidden") {
			// 已在挥手过渡中：由定时器负责切 hidden，忽略重复 hidden 推送
			if (prev?.mode === "waving") return;
			// 从非 hidden 进入 hidden：先挥手
			if (prev && prev.mode !== "hidden") {
				this.applyState({ ...state, mode: "waving" });
				if (this.wavingTimer) clearTimeout(this.wavingTimer);
				this.wavingTimer = setTimeout(() => {
					this.wavingTimer = null;
					this.applyState({ ...state, mode: "hidden" });
				}, this.waveDurationMs);
				return;
			}
			// 之前就是 hidden（或首次无活跃 Agent），直接隐藏
			this.applyState(state);
			return;
		}

		// 非 hidden：若正在挥手过渡则取消（又有 Agent 活跃了），切回实态
		if (this.wavingTimer) {
			clearTimeout(this.wavingTimer);
			this.wavingTimer = null;
		}

		// 动画完成锁：避免 running↔idle 抖动导致半帧切换（hidden/waving 间自由切换不受限）
		const now = Date.now();
		if (
			prev &&
			prev.mode !== "hidden" &&
			prev.mode !== "waving" &&
			target !== prev.mode &&
			now - this.lastChangeAt < this.minStateHoldMs
		) {
			return;
		}
		if (prev?.mode === target) return; // 模式未变不重复推送

		this.applyState(state);
		this.detectNotification(prev);
	}

	/** 通知气泡：出错/完成时在宠物头顶弹窗 */
	private detectNotification(prev: PetAggregateState | null) {
		const cur = this.lastState;
		if (!cur) return;
		// 冷却中抑制重复通知（单次通知后 3s 内不再发送同类通知）
		const now = Date.now();
		if (this.notifyCooldown > now) return;
		if (cur.mode === "failed" && prev?.mode !== "failed") {
			const errored = this.currentTabs.find(t => t.status === "error");
			if (errored) {
				this.sendNotification({ type: "error", text: `${errored.title} 出错了`, agentId: errored.id, timestamp: now });
				this.notifyCooldown = now + 3000;
			}
		} else if (cur.mode === "idle" && (prev?.mode === "running" || prev?.mode === "failed")) {
			this.sendNotification({ type: "done", text: "所有任务完成", timestamp: now });
			this.notifyCooldown = now + 3000;
		}
	}

	private sendNotification(n: PetNotification) {
		const win = this.getPetWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(ipcChannels.petNotify, n);
		}
	}

	/** 实际发送状态给宠物窗并更新 lastState */
	private applyState(state: PetAggregateState) {
		this.lastState = state;
		this.lastChangeAt = Date.now();
		const win = this.getPetWindow();
		if (!win || win.isDestroyed()) return;
		win.webContents.send(ipcChannels.petState, state);
	}
}