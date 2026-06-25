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
	/** review 完成定时器：成功完成时展示 review(行8) → idle */
	private reviewTimer: NodeJS.Timeout | null = null;
	/** failed 过渡定时器：出错后自动切 idle */
	private failedTimer: NodeJS.Timeout | null = null;
	/** tease 逗弄定时器：双击注入 jumping(行4) 后恢复真实态 */
	private teaseTimer: NodeJS.Timeout | null = null;
	/** 错误状态展示冷却：展示过一次 error 后 N ms 内抑制重复推送 */
	private errorCooldownUntil = 0;
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
	/** review 庆祝持续时长：成功后展示 review → idle */
	private readonly reviewDurationMs = 4000;
	/** failed 展示持续时长：出错动画播放后自动切 idle */
	private readonly failedDisplayDurationMs = 4000;
	/** 错误状态抑制窗口：展示过一次 error 后 10s 内不重复推送 */
	private readonly errorSuppressDurationMs = 10000;
	/** 逗弄持续时长：双击注入 jumping 后恢复真实态 */
	private readonly teaseDurationMs = 2500;

	constructor(
		private readonly getPetWindow: () => BrowserWindow | null,
		/** 巡游引擎：idle 时自动沿屏幕底部走动，业务态/临时态出现即让位 */
		private readonly patrol: { start: () => void; stop: () => void; active: boolean } | null = null,
		/** 巡游开关读取：返回是否启用 idle 巡游（受设置面板控制） */
		private readonly isPatrolEnabled: () => boolean = () => true,
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
		if (this.reviewTimer) {
			clearTimeout(this.reviewTimer);
			this.reviewTimer = null;
		}
		if (this.failedTimer) {
			clearTimeout(this.failedTimer);
			this.failedTimer = null;
		}
		if (this.teaseTimer) {
			clearTimeout(this.teaseTimer);
			this.teaseTimer = null;
		}
		this.patrol?.stop();
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

		// review 完成过渡：从 running 完成时先展示 review(行8)，再切 idle。
		// 原完成动画用 jumping，本期 jumping 让位给「逗弄」，完成语义改由 review 承担。
		if (target === "idle" && prev?.mode === "running") {
			this.applyState({ ...state, mode: "review" });
			this.sendNotification({ type: "done", text: "任务完成，记得 Review", timestamp: Date.now() });
			this.notifyCooldown = Date.now() + 3000;
			this.lastChangeAt = Date.now();
			if (this.reviewTimer) clearTimeout(this.reviewTimer);
			this.reviewTimer = setTimeout(() => {
				this.reviewTimer = null;
				this.applyState({ ...state, mode: "idle" });
				// review 结束回 idle：若开关开则自动续上巡游，体验连贯
				this.maybeStartPatrol();
			}, this.reviewDurationMs);
			return;
		}

		// review 进行中：忽略重叠的 idle 推送，等待 reviewTimer 自然回到 idle
		if (target === "idle" && prev?.mode === "review") {
			return;
		}

		// failed 过渡：出错后展示 failed + 通知，N ms 后自动切 idle；
		// 切 idle 后若 Agent 仍报 error，由 errorCooldown 抑制重复推送。
		if (target === "failed") {
			const now = Date.now();
			if (this.errorCooldownUntil > now) return;
			this.errorCooldownUntil = now + this.errorSuppressDurationMs;
			if (prev?.mode !== "failed") {
				this.applyState(state);
				const errored = this.currentTabs.find(t => t.status === "error");
				if (errored) {
					this.sendNotification({
						type: "error",
						text: `${errored.title} 出错了`,
						agentId: errored.id,
						timestamp: now,
					});
					this.notifyCooldown = now + 3000;
				}
				if (this.failedTimer) clearTimeout(this.failedTimer);
				this.failedTimer = setTimeout(() => {
					this.failedTimer = null;
					this.applyState({ ...state, mode: "idle" });
					this.maybeStartPatrol();
				}, this.failedDisplayDurationMs);
			}
			return;
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

		// 业务态分流：running/waiting 等出现即停巡游；稳定 idle 则启动巡游（受开关控制）
		if (target === "idle") {
			this.maybeStartPatrol();
		} else if (target === "running" || target === "waiting") {
			this.patrol?.stop();
		}
	}

	/** 在满足条件时启动巡游：开关开 + 当前确为 idle + 未被 review/tease 临时态占用 */
	private maybeStartPatrol() {
		if (!this.patrol) return;
		if (!this.isPatrolEnabled()) return;
		const m = this.lastState?.mode;
		// 仅在真实 idle 启动；review/jumping 等临时态由各自定时器结束后回调启动
		if (m !== "idle") return;
		this.patrol.start();
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

	/**
	 * 逗弄（双击宠物触发）：注入一次 jumping(行4)，结束后恢复真实聚合态。
	 *
	 * 优先级：高于 patrol/review，低于 running/failed/waiting——任务真在跑时
	 * 不接受逗弄打断，避免工作/庆祝动画被随手一点盖掉。逗弄期间停巡游，
	 * 结束后若仍 idle 则由 push() 自然续上巡游。
	 */
	tease() {
		// 业务态优先：运行中/出错/启动中不打断真实工作动画
		const cur = this.lastState?.mode;
		if (cur && ["running", "failed", "waiting", "hidden", "waving"].includes(cur)) return;
		if (cur === "review") return; // review 庆祝也不打断，让用户看清完成动画

		// 记住真实聚合态，逗弄结束后恢复它（而非直接写死 idle，避免覆盖并发状态变化）
		const saved = aggregate(this.currentTabs);
		if (this.teaseTimer) clearTimeout(this.teaseTimer);
		this.patrol?.stop(); // 逗弄优先级高于巡游，先停巡游

		// 保存逗弄前的真实态用于恢复；activeAgentId 取最新聚合结果，保证点击跳转仍有效
		this.applyState({ ...saved, mode: "jumping" });
		this.teaseTimer = setTimeout(() => {
			this.teaseTimer = null;
			// 恢复真实聚合态：push 会依据目标态决定是否重启巡游
			this.push(aggregate(this.currentTabs));
		}, this.teaseDurationMs);
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