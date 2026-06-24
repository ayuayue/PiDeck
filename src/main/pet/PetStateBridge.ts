import type { BrowserWindow } from "electron";
import type { AgentStatus, AgentTab, PetAggregateState, PetMode } from "../../shared/types";
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
	/** 当前已推送的最近状态，用于跳过无变化推送 */
	private lastMode: PetMode | null = null;
	/** AgentManager 状态监听取消函数 */
	private unsubscribe: (() => void) | null = null;
	/** 上次状态变更时间戳，用于动画完成锁（至少 minStateHoldMs 才允许切下一个状态） */
	private lastChangeAt = 0;

	/** 去抖窗口：多 Agent 同时启停时避免聚合状态在 running↔idle 间快速跳动 */
	private readonly debounceMs = 150;
	/** 动画完成锁：进入新状态后至少保持一个动画周期，避免半帧切换 */
	private readonly minStateHoldMs = 600;

	constructor(
		private readonly getPetWindow: () => BrowserWindow | null,
	) {}

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
	}

	/** 接收最新 AgentTab[]，去抖后聚合推送 */
	update(tabs: AgentTab[]) {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.push(aggregate(tabs));
		}, this.debounceMs);
	}

	/** 立即推送一次（宠物窗创建后或开关切换时调用，避免等待去抖） */
	pushNow(tabs: AgentTab[]) {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.push(aggregate(tabs));
	}

	private push(state: PetAggregateState) {
		// hidden 与非 hidden 之间必须自由切换；非 hidden 之间受动画完成锁约束，
		// 避免 running↔idle 抖动导致宠物动画抽搐。
		const now = Date.now();
		if (
			state.mode !== "hidden" &&
			this.lastMode !== null &&
			this.lastMode !== "hidden" &&
			state.mode !== this.lastMode &&
			now - this.lastChangeAt < this.minStateHoldMs
		) {
			return;
		}
		if (state.mode === this.lastMode) return; // 模式未变则不重复推送

		this.lastMode = state.mode;
		this.lastChangeAt = now;

		const win = this.getPetWindow();
		if (!win || win.isDestroyed()) return;
		win.webContents.send(ipcChannels.petState, state);
	}
}