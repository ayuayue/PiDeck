/**
 * pi-deck-gui-bridge —— 通路（§9）。
 *
 * **方向**：PiDeck 监听，pi 连接。桥**不起服务**，只做 HTTP 客户端
 * → 无端口冲突、无陈旧发现文件、无 fs.watch（§9.2）。
 *
 * **多会话天然隔离**：URL 是每次 spawn 独享的，PiDeck 自己知道是哪个会话。
 *
 * **fail-safe 高于一切**（§14.5）：URL/TOKEN 缺失、网络失败、超时、
 * 响应体非法 —— 一律静默降级，**绝不影响 pi 会话**。
 * 纯终端跑 pi（没有 PIDECK_BRIDGE_URL）时，桥整体不工作，pi 行为不变。
 */

import type { UIBridgeEvent, UIBridgeResponse, UIBridgeUpdate } from "./pi-deck-gui-bridge-types";

/** 通路接口（与具体实现解耦，§9.3）。 */
export type UIBridgeTransport = {
	/** 推一帧更新；内部做批量合并。 */
	push(update: UIBridgeUpdate): void;
	/** 注册事件处理器（PiDeck 回灌的交互事件）。 */
	onEvent(handler: (event: UIBridgeEvent) => void): void;
	/**
	 * 注册「全量重推」处理器：PiDeck 在响应体里回 `resync: true` 时触发（§9.4）。
	 *
	 * 用于 PiDeck 渲染层丢失桥状态后要一次快照 —— 落点是一次性推送，
	 * 不主动要就不会回来。多个处理器互不影响。
	 *
	 * **可选方法**（§14.5 fail-safe）：自定义/旧版 transport 没实现时，
	 * 桥只是收不到重同步请求，**不得因此抛错影响 pi 会话**。
	 */
	onResync?(handler: () => void): void;
	/** 关闭（停轮询、清 pending）。 */
	close(): void;
	/** 通路是否可用（env 缺失时为 false，桥据此整体静默）。 */
	readonly available: boolean;
};

/** 轮询间隔：有更新立刻发；空闲时也发空包取事件（§9.2）。 */
const ACTIVE_INTERVAL_MS = 100;
/** 空闲降频（§13.5）：连续若干轮无更新后降到 2Hz。 */
const IDLE_INTERVAL_MS = 500;
const IDLE_AFTER_TICKS = 20;
/** 单次请求超时：本地回环，超过即认为 PiDeck 不可用。 */
const REQUEST_TIMEOUT_MS = 2_000;
/** 一批最多合并多少条更新（防单帧过大）。 */
const MAX_BATCH = 200;

type Logger = (message: string) => void;

/**
 * 创建基于环境变量的 HTTP 客户端通路。
 *
 * 读 `PIDECK_BRIDGE_URL` / `PIDECK_BRIDGE_TOKEN`（由 PiDeck 在 spawn pi 时注入）。
 * 任一缺失 → 返回一个 `available: false` 的空实现，桥据此不启动任何工作。
 */
export function createHttpTransport(log: Logger): UIBridgeTransport {
	const url = process.env.PIDECK_BRIDGE_URL?.trim();
	const token = process.env.PIDECK_BRIDGE_TOKEN?.trim();

	if (!url) {
		// 纯终端跑 pi：静默不工作（§12.4）
		return createNullTransport();
	}

	const endpoint = `${url.replace(/\/+$/, "")}/ui`;
	const pending: UIBridgeUpdate[] = [];
	let handlers: ((event: UIBridgeEvent) => void)[] = [];
	let resyncHandlers: (() => void)[] = [];
	let timer: NodeJS.Timeout | null = null;
	let closed = false;
	let inFlight = false;
	let idleTicks = 0;
	/** 连续失败计数：达到阈值后停轮询（避免无限重试刷日志）。 */
	let failureCount = 0;
	const MAX_FAILURES = 30;

	function schedule(delay: number): void {
		if (closed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void tick();
		}, delay);
		// 不阻止进程退出（pi 退出时不应被桥的 timer 挂住）
		timer.unref?.();
	}

	async function tick(): Promise<void> {
		if (closed || inFlight) return;
		inFlight = true;
		const batch = pending.splice(0, MAX_BATCH);
		const hadWork = batch.length > 0;
		try {
			const response = await postJson(endpoint, token, { updates: batch });
			failureCount = 0;
			if (response?.events?.length) {
				for (const event of response.events) {
					for (const handler of handlers) {
						try {
							handler(event);
						} catch {
							// 单个 handler 抛错不影响其他
						}
					}
				}
			}
			idleTicks = hadWork || response?.events?.length ? 0 : idleTicks + 1;
			// PiDeck 要求全量重推（§9.4）：在事件回灌之后、下一轮之前重推快照。
			// 单个处理器抛错不影响其他，也不影响后续轮询。
			if (response?.resync) {
				for (const handler of resyncHandlers) {
					try {
						handler();
					} catch (error) {
						log(`全量重推处理器抛错（已吞）: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}
			schedule(idleTicks >= IDLE_AFTER_TICKS ? IDLE_INTERVAL_MS : ACTIVE_INTERVAL_MS);
		} catch (error) {
			failureCount += 1;
			// 失败时把本批更新放回队首（下一轮重试），但不超过上限
			if (batch.length > 0) pending.unshift(...batch.slice(0, MAX_BATCH));
			if (failureCount === 1) {
				log(`通路请求失败（将重试）: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (failureCount >= MAX_FAILURES) {
				log(`通路连续失败 ${failureCount} 次，停止轮询（桥静默退出，pi 不受影响）`);
				closed = true;
				return;
			}
			schedule(IDLE_INTERVAL_MS);
		} finally {
			inFlight = false;
		}
	}

	return {
		available: true,
		push(update) {
			if (closed) return;
			pending.push(update);
			// 有更新时立刻发（不等下一个 tick）
			if (!inFlight && pending.length > 0) schedule(0);
		},
		onEvent(handler) {
			handlers.push(handler);
		},
		onResync(handler) {
			resyncHandlers.push(handler);
		},
		close() {
			closed = true;
			if (timer) clearTimeout(timer);
			timer = null;
			pending.length = 0;
			handlers = [];
			resyncHandlers = [];
		},
	};
}

/** 空通路：env 缺失时使用，所有操作都是 no-op。 */
export function createNullTransport(): UIBridgeTransport {
	return {
		available: false,
		push() {},
		onEvent() {},
		onResync() {},
		close() {},
	};
}

/**
 * 发一次 POST，返回解析后的响应体。
 *
 * 用 node 内置 `fetch`（Node 18+）。任何非 2xx、超时、JSON 解析失败都抛错，
 * 由调用方决定重试或降级。
 */
async function postJson(endpoint: string, token: string | undefined, body: unknown): Promise<UIBridgeResponse | null> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	timeout.unref?.();
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { "x-pideck-bridge-token": token } : {}),
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const text = await response.text();
		if (!text.trim()) return null;
		try {
			return JSON.parse(text) as UIBridgeResponse;
		} catch {
			// 响应体不是 JSON：当作没有事件（PiDeck 版本不匹配等）
			return null;
		}
	} finally {
		clearTimeout(timeout);
	}
}