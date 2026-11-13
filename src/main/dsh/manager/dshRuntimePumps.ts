import { getAppLogger } from "../../logging/sharedLogger";
import type { DshControlState } from "../dshRuntimeControl";
import type { DshRemoteClient } from "../dshRemoteClient";
import type { DshHost } from "../DshHost";
import type { DshAgentRuntime } from "./dshAgentRuntime";

/**
 * 三条共享流的宿主出口：会话 map、host 就绪探测与帧分发留在 DshAgentManager，
 * 泵只经这里回读状态、补帧与推状态（不持有一份自己的会话副本）。
 */
export type DshRuntimePumpHost = {
	readonly runtimes: ReadonlyMap<string, DshAgentRuntime>;
	readonly dshHost: DshHost;
	requireClient(): DshRemoteClient;
	/** 帧分发（实现见 manager/dshMuxFrames）。 */
	dispatchMuxFrame(frame: { rpcId?: unknown; payload?: unknown }): void;
	/** mux 断连重连后的历史补帧（D6）。 */
	backfillHistory(runtime: DshAgentRuntime): Promise<void>;
	/** 运行态推给渲染层（agents:runtime-state）。 */
	emitRuntimeState(agentId: string): void;
};

/**
 * DSH 的进程级共享流泵：共享 mux（$events 审批/提问瀑布）、Host 级投影控制流
 * （session/control）与每会话 journal 流（session/follow）。
 *
 * 为什么泵与其状态单独成域：三条流都是「长连接 + 指数退避重连」的同构循环，
 * 共享一份「谁还在跑」的簿记（AbortController + promise）与首次订阅标记；
 * 宿主只需要 startMux / stopSharedMux / stopFollowPump 三个动作，不关心重连细节。
 * 每个 runtime 再各开一条共享流会互相打断（第二个会话 create/attach 失败）。
 */
export class DshRuntimePumps {
	/** 进程级共享 mux：host 的 events.mux 是全会话聚合流，每开一条都会占订阅。
	 *  每个 runtime 各自订阅时，第二个会话 create/attach 会把第一条流打断或被 host 拒绝，
	 *  表现为「运行中切不了会话 / 停了也切不了 / 换模型失败」。 */
	private muxAbort?: AbortController;
	private muxPump?: Promise<void>;
	private muxFirstSubscription = true;
	/** Host 级投影控制流（session/control）泵：投影变更广播的唯一来源。 */
	private controlAbort?: AbortController;
	private controlPump?: Promise<void>;
	/** 0.1.5：每会话 session/follow 泵（journal 事件流；取代旧聚合 mux 的会话事件）。
	 *  共享 mux（$events）只剩审批/提问瀑布；journal 事件按会话各开一条。 */
	private readonly followPumps = new Map<string, { controller: AbortController; promise: Promise<void> }>();

	constructor(private readonly host: DshRuntimePumpHost) {}

	/**
	 * 确保某会话的 follow 泵在跑（0.1.5：journal 事件按会话订阅）。
	 * 断连退避重连；重连先 backfillHistory 补帧（D6 语义沿用）。
	 */
	ensureFollowPump(runtime: DshAgentRuntime): void {
		const agentId = runtime.tab.id;
		if (this.followPumps.has(agentId)) return;
		const controller = new AbortController();
		const pump = (async () => {
			let backoffMs = 250;
			let firstSubscription = true;
			while (!controller.signal.aborted && this.host.runtimes.has(agentId)) {
				if (!this.host.dshHost.isHostProcessRunning() || !this.host.dshHost.isHostReady()) {
					await delay(backoffMs, controller.signal);
					backoffMs = Math.min(backoffMs * 2, 2000);
					continue;
				}
				try {
					const client = this.host.requireClient();
					const current = this.host.runtimes.get(agentId);
					// D6：重连才补帧；首次订阅由 create/attach 的 history 拉取覆盖。
					if (!firstSubscription && current) await this.host.backfillHistory(current);
					firstSubscription = false;
					for await (const frame of client.sessionsFollow({ sessionId: String(runtime.sessionId) }, controller.signal)) {
						backoffMs = 250;
						this.host.dispatchMuxFrame(frame);
					}
				} catch {
					// 流错误（host 崩溃 / 会话销毁）：走退避重连。
				}
				if (controller.signal.aborted || !this.host.runtimes.has(agentId)) break;
				await delay(backoffMs, controller.signal);
				backoffMs = Math.min(backoffMs * 2, 2000);
			}
		})().catch((error) => {
			// pump 兜底错误也走统一日志：console.error 不进持久化日志，报障时取证缺失。
			if (!controller.signal.aborted) {
				getAppLogger()?.error("dsh-agent", `follow pump error (${agentId})`, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		this.followPumps.set(agentId, { controller, promise: pump });
	}

	/** 终止单会话的 follow 泵（stop() 移除 runtime 时调用，避免死会话空转重连）。 */
	stopFollowPump(agentId: string): void {
		const pump = this.followPumps.get(agentId);
		if (!pump) return;
		this.followPumps.delete(agentId);
		pump.controller.abort();
	}

	stopSharedMux(): void {
		this.muxAbort?.abort();
		this.muxAbort = undefined;
		this.muxPump = undefined;
		this.muxFirstSubscription = true;
		this.controlAbort?.abort();
		this.controlAbort = undefined;
		this.controlPump = undefined;
		for (const pump of this.followPumps.values()) pump.controller.abort();
		this.followPumps.clear();
	}

	/**
	 * 确保 Host 级投影控制流（session/control）在跑。
	 *
	 * 0.1.5 把旧 events.mux 的「投影变更广播」放在这条流上：session/follow 的
	 * snapshot 只在 attach 那一刻带一次投影基线，之后 sessionStats / tokenUsage /
	 * contextPressure / contextBreakdown / todos 的每次变更都只经
	 * sessionProjections.onChanged → session/control 下发。不订阅这条流，
	 * runtime 投影就永远停在 attach 初值（新建会话更是全空），
	 * deriveSessionStatsFallback 顶上 ⇒ 输入框底下只剩「N 轮 · M 步」，
	 * LLM/工具墙钟、平均首字、tok/s、累计 token、缓存命中率全部缺失。
	 *
	 * 与 mux 同款断连退避；重连后 host 重发 baseline，天然完成投影补齐
	 * （baseline 走 higher-seq-wins，不会把已到达的新值打回旧值）。
	 */
	startControlPump(): void {
		if (this.controlPump && this.controlAbort && !this.controlAbort.signal.aborted) return;
		const controller = new AbortController();
		this.controlAbort = controller;
		this.controlPump = (async () => {
			let backoffMs = 250;
			while (!controller.signal.aborted) {
				if (!this.host.dshHost.isHostProcessRunning() || !this.host.dshHost.isHostReady()) {
					await delay(backoffMs, controller.signal);
					backoffMs = Math.min(backoffMs * 2, 2000);
					continue;
				}
				try {
					const client = this.host.requireClient();
					for await (const frame of client.sessionControl(controller.signal)) {
						backoffMs = 250;
						this.host.dispatchMuxFrame(frame);
					}
				} catch {
					// 流错误（host 崩溃 abortAllPending）或 host 未启动：退避重连。
				}
				if (controller.signal.aborted) break;
				await delay(backoffMs, controller.signal);
				backoffMs = Math.min(backoffMs * 2, 2000);
			}
		})().catch((error) => {
			if (controller.signal.aborted) return;
			// 同 follow pump：兜底错误必须进统一日志，绕过 console 才能持久化取证。
			getAppLogger()?.error("dsh-agent", "control pump error", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	/**
	 * 确保进程级共享 mux 在跑。0.1.5 后 events.mux 已不存在：会话 journal 走
	 * 每会话 follow 泵，审批/提问瀑布走 $events，投影广播走 session/control。
	 * 三者都是进程级共享流（每个 runtime 再开一条会互相打断，第二个会话
	 * create/attach 失败）；断连自愈按指数退避重连。
	 */
	startMux(_runtime: DshAgentRuntime): void {
		// 0.1.5：会话 journal 事件走每会话 follow 泵（this.followPumps），共享 mux
		// （$events）只剩审批/提问瀑布。ensureFollowPump 必须对每个 runtime 都执行：
		// 之前放在共享 mux 的启动路径里，第二个会话 startMux 时 mux 已在跑、提前
		// return 把 follow 泵整个吞掉——表现为新会话发送后 host 正常执行完整回合
		// （journal 有 turn/end），但 PiDeck 收不到任何事件（无流式、无收口、无报错）。
		// ensureFollowPump 按 agentId 幂等，重复调用无害。
		this.ensureFollowPump(_runtime);
		// 投影控制流同理：必须早于下面的 mux 早退分支，否则第二个会话起就不再订阅
		// （startControlPump 自身幂等，重复调用无害）。
		this.startControlPump();
		if (this.muxPump && this.muxAbort && !this.muxAbort.signal.aborted) return;
		const controller = new AbortController();
		this.muxAbort = controller;
		this.muxPump = (async () => {
			let backoffMs = 250;
			while (!controller.signal.aborted) {
				if (!this.host.dshHost.isHostProcessRunning() || !this.host.dshHost.isHostReady()) {
					await delay(backoffMs, controller.signal);
					backoffMs = Math.min(backoffMs * 2, 2000);
					continue;
				}
				try {
					const client = this.host.requireClient();
					// D6：共享流重连后给每个仍活着的 runtime 补历史；首次订阅跳过
					// （各会话 create/attach 已拉过 history）。
					if (!this.muxFirstSubscription) {
						for (const runtime of this.host.runtimes.values()) {
							if (runtime.control.status === "running" || runtime.isStreaming || runtime.isCompacting) {
								runtime.isStreaming = false;
								runtime.isCompacting = false;
								runtime.executingTool = undefined;
								runtime.control = initialDshControl();
								runtime.thinkingId = undefined;
								runtime.thinkingStartedAt = undefined;
								this.host.emitRuntimeState(runtime.tab.id);
							}
							await this.host.backfillHistory(runtime);
						}
					}
					this.muxFirstSubscription = false;
					for await (const frame of client.openEvents(controller.signal)) {
						backoffMs = 250;
						this.host.dispatchMuxFrame(frame);
					}
				} catch {
					// 流错误（host 崩溃 abortAllPending）或 host 未启动：走退避重连。
				}
				if (controller.signal.aborted) break;
				await delay(backoffMs, controller.signal);
				backoffMs = Math.min(backoffMs * 2, 2000);
			}
		})().catch((error) => {
			if (controller.signal.aborted) return;
			// 同 follow pump：兜底错误必须进统一日志，绕过 console 才能持久化取证。
			getAppLogger()?.error("dsh-agent", "mux pump error", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}
}

/**
 * 控制态初值（每回合空闲基线）。
 *
 * 放在泵域是因为三个「流程起点」都从它复位：共享 mux 重连补历史、以及宿主侧
 * create / restart / host 崩溃恢复 / fork 换绑。泵与宿主共用同一份定义，避免两处漂移。
 */
export function initialDshControl(): DshControlState {
	return {
		status: "idle",
		isStreaming: false,
		cancelGeneration: 0,
		cancelled: false,
	};
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
