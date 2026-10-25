/**
 * /api/events 的 SSE 状态推送（从 WebServiceManager 按域迁出）。
 *
 * 主进程没有统一的「state 变更」emitter（推送点散落在 emitSessionRuntimeEvent 各调用处），
 * 所以这里用「事件驱动 + 低频兜底」的变化检测：pi/通道事件到达时去抖 400ms 比对一次快照，
 * 另有 5s tick 兜底桌面端发起的目录变更；快照与上次广播一致则不推（流式期间事件高频但
 * state 载荷几乎不变，靠 JSON 比对免推）。快照内容本身由宿主注入 loadState 提供。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { serializePublicWebPayload } from "./WebHttpResponders";

type StateEventClient = { writeRaw: (wire: string) => boolean };

export class WebStateEventHub {
	/** 订阅者集合；写失败（连接断开）时在推送循环里剔除。 */
	private readonly stateEventClients = new Set<StateEventClient>();
	/** 变化检测去抖定时器：pi 事件风暴（流式期间每秒数十条）合并成一次快照比对。 */
	private statePushTimer: ReturnType<typeof setTimeout> | null = null;
	/** 最近一次广播的载荷；快照与它一致则跳过推送（流式期间 state 多数字段不变）。 */
	private lastStatePushJson: string | null = null;
	/** 低频兜底 tick：捕捉不经 pi 事件的目录变更（桌面端改名/删除/导入）。 */
	private stateTickTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly deps: { loadState: () => Promise<unknown>; stateRevision?: () => string }) {}

	/**
	 * 廉价版本键（2027-02 性能审计）：流式期间每条 delta 都会 schedule 一次 400ms
	 * 去抖推送，而 runtime status/generation 并不随 delta 变化——此前每次都要构建
	 * 整快照 + ~100KB JSON 序列化，只为字符串比对出「无变化」（纯浪费占绝大多数）。
	 * 键 = runtimes 身份/状态/代数 + pendingUi 摘要（这些正是 pi 事件能驱动的变化面）；
	 * catalog/项目变更不随 pi 事件变化，由 5s tick 的全量比对兜底，不进键。
	 * 键未变时直接跳过构建；force（新连接首推）不受此门。
	 */
	public lastStateRevision: string | null = null;

	/**
	 * /api/events SSE：把项目/会话/运行态快照推给 Web 端，替代 1s/3s 轮询。
	 *
	 * 主进程没有统一的「state 变更」emitter（桌面端的推送点散落在 emitSessionRuntimeEvent
	 * 各调用处），因此这里用「事件驱动 + 低频兑底」的变化检测：pi agent 事件（runtime
	 * 状态翻转 / ask 待确认等的源头）到达时去抖 400ms 比对一次快照，另有 5s tick 兑底
	 * 捕捉桌面端发起的目录变更（改名/删除/导入）。快照与上次广播一致则不推——流式期间
	 * pi 事件高频但 state 载荷几乎不变，靠 JSON 比对免推。
	 */
	handle(request: IncomingMessage, response: ServerResponse): void {
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
			"access-control-allow-origin": "*",
		});
		response.flushHeaders?.();

		const client = {
			writeRaw: (wire: string): boolean => {
				if (response.writableEnded || response.destroyed) return false;
				try {
					response.write(wire);
					return true;
				} catch {
					return false;
				}
			},
		};
		this.stateEventClients.add(client);
		// 连接即推当前快照：前端订阅成功后不再需要首拉 /api/state。
		void this.push([client], true);

		// 心跳：防代理/浏览器空闲断连（与会话流同节奏）。
		const heartbeat = setInterval(() => {
			if (response.writableEnded || response.destroyed) {
				cleanup();
				return;
			}
			try {
				response.write(": ping\n\n");
			} catch {
				cleanup();
			}
		}, 15_000);
		const cleanup = () => {
			clearInterval(heartbeat);
			this.stateEventClients.delete(client);
			if (!response.writableEnded) {
				try {
					response.end();
				} catch {
					// 已销毁的连接 end() 抛错可忽略
				}
			}
		};
		response.once("close", cleanup);
		request.once("close", cleanup);
	}

	/** 去抖调度一次快照广播；已有待发定时器时静默合并（事件风暴防抖）。 */
	schedule(): void {
		if (this.statePushTimer) return;
		this.statePushTimer = setTimeout(() => {
			this.statePushTimer = null;
			void this.push();
		}, 400);
	}

	/**
	 * 构建快照并推给目标订阅者（缺省全部）。
	 * force=true 时无视「与上次一致」门控（新连接的初始快照必须下发）。
	 */
	async push(targetClients: Array<{ writeRaw: (wire: string) => boolean }> = [...this.stateEventClients], force = false): Promise<void> {
		if (targetClients.length === 0) return;
		const revision = this.deps.stateRevision?.();
		if (!force && revision !== undefined && this.lastStateRevision !== null && revision === this.lastStateRevision && this.lastStatePushJson !== null) {
			return;
		}
		let json: string;
		try {
			json = serializePublicWebPayload(await this.deps.loadState());
		} catch {
			// 快照构建失败不广播（订阅者保留旧状态，兑底 tick / 轮询会重试）
			return;
		}
		if (!force && json === this.lastStatePushJson) {
			// 内容未变也要推进版本键：真实变化曾发生过又回到同键（罕见），键与 json 对齐防漏推
			this.lastStateRevision = revision ?? this.lastStateRevision;
			return;
		}
		this.lastStatePushJson = json;
		this.lastStateRevision = revision ?? this.lastStateRevision;
		const wire = `event: state\ndata: ${json}\n\n`;
		for (const client of targetClients) {
			if (!client.writeRaw(wire)) this.stateEventClients.delete(client);
		}
	}

	/** 服务停止：停定时器、断开全部订阅者（避免向已关服务的 socket 写数据）、清掉快照缓存。 */
	dispose(): void {
		if (this.statePushTimer) {
			clearTimeout(this.statePushTimer);
			this.statePushTimer = null;
		}
		if (this.stateTickTimer) {
			clearInterval(this.stateTickTimer);
			this.stateTickTimer = null;
		}
		for (const client of this.stateEventClients) {
			try {
				client.writeRaw(": service stopping\n\n");
			} catch {
				// 连接已失效则忽略
			}
		}
		this.stateEventClients.clear();
		this.lastStatePushJson = null;
		this.lastStateRevision = null;
	}

	/** 5s 兜底 tick：捕捉不经 pi 事件的目录变更（桌面端改名/删除/导入等）。 */
	startTick(): void {
		this.stateTickTimer = setInterval(() => this.schedule(), 5_000);
	}
}
