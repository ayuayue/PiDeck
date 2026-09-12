/**
 * pideck-session-bridge：PiDeck ↔ DSH host 的会话冷读元数据桥。
 *
 * 背景（0.1.5 Typert Remote 契约，见 docs/dsh-0.1.5-typert-migration.md）：
 * `session/page` 的 `throughSeq` 是「包含式日志切点」，必须 ≤ 该会话当前
 * cursor，超出直接 `gateway/bad-request`；官方约定这个值来自 `session/follow`
 * 的开帧快照（官方 client 的 SessionEventStream 就是「先 open follow、再拿快照
 * cursor 往回翻页」）。
 *
 * PiDeck 的历史浏览是**冷读**路径：点击历史 DSH 会话时 runtime 尚未激活。
 * 不能开 follow 拿 cursor——follow 对 cold 会话会走 promote() 真正激活 Agent
 * （resolveObservedAgent，见 dsh-api-session-controller 的 `promote` 实现），
 * 浏览历史不该拉起会话。因此这里把 host 内 sessionQuery 的 observation cursor
 * 暴露给主进程：与 session/page 内部 sourceFor 用的是**同一数据源**
 * （ctx.sessionQuery.observeSession），冷读、不激活、不计算投影
 * （projectionMode: 'none' 不写投影缓存）。TOCTOU 分析：取 cursor 与后续
 * page 调用之间日志只可能增长（append-only），旧 cursor 仍是合法切点，
 * 无需重试。
 *
 * 与 pideckPluginBridge / pideckCommandsBridge 同构：前缀路由 + POST JSON +
 * { ok, value|error } 信封。方法永不向桥外抛异常。
 */

import type { DshPluginBridgeResponse } from "../../shared/types";

/** 桥服务键（hostEntry 路由与主进程协议共用）。 */
export const PIDECK_SESSION_BRIDGE_SERVICE = "pideckSessionBridge";

/** 桥 RPC 路径前缀（hostEntry 的 fetch 路由拦截用）。 */
export const PIDECK_SESSION_BRIDGE_PATH = "/pideck-session/rpc";

/** 结构化桥结果：方法永不向桥外抛异常，错误一律包成 { ok: false, error }。 */
export type SessionBridgeResult<T> = DshPluginBridgeResponse<T>;

/** cursor 入参（渲染层数据不可信，校验在边界）。 */
export type SessionCursorParams = {
	sessionId: string;
};

/** cursor 返回值：会话日志最后一条事件 seq，空日志为 -1。 */
export type SessionCursorValue = {
	cursor: number;
};

/** 桥插件可见的 ctx 形状（结构类型，避免运行时依赖 @deepseek-ai/cordis）。 */
export type SessionBridgeCtx = {
	get?(key: string): unknown;
	provide?(key: string, value: unknown): unknown;
};

/** 校验 cursor 入参（sessionId 必填，非空字符串）。 */
export function validateSessionCursorParams(input: unknown): SessionBridgeResult<SessionCursorParams> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, error: "invalid cursor payload" };
	}
	const sessionId = (input as Record<string, unknown>).sessionId;
	if (typeof sessionId !== "string" || !sessionId.trim()) {
		return { ok: false, error: "sessionId is required" };
	}
	return { ok: true, value: { sessionId: sessionId.trim() } };
}

/** 桥服务方法签名（结构类型；host 侧由 sessionQuery 提供能力）。 */
export type SessionBridgeService = {
	cursor(input: unknown): SessionBridgeResult<SessionCursorValue> | Promise<SessionBridgeResult<SessionCursorValue>>;
};

/**
 * 桥 RPC 分发：method + params → 服务调用。纯函数（service 可注入替身），
 * 供 hostEntry 的 fetch 路由与单测共用。未知方法返回结构化错误。
 */
export async function sessionBridgeRpc(
	service: SessionBridgeService | undefined,
	method: unknown,
	params: unknown,
): Promise<SessionBridgeResult<unknown>> {
	if (!service) return { ok: false, error: "session bridge service is not available" };
	switch (method) {
		case "cursor":
			return service.cursor(params);
		default:
			return { ok: false, error: `unknown session bridge method: ${String(method)}` };
	}
}

/**
 * hostEntry fetch 路由的桥请求处理：POST JSON { method, params } → 结构化 JSON 响应。
 * 与主进程 DshHost.bridgeRpc 的 rawFetch 协议对齐；错误返回 400 + { ok: false, error }。
 */
export async function handleSessionBridgeFetch(
	ctx: SessionBridgeCtx,
	init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response> {
	const result = await (async (): Promise<SessionBridgeResult<unknown>> => {
		if ((init?.method ?? "GET").toUpperCase() !== "POST") {
			return { ok: false, error: "session bridge requires POST" };
		}
		let payload: { method?: unknown; params?: unknown } | null = null;
		if (init?.body !== undefined && init.body !== "") {
			try {
				const parsed = JSON.parse(init.body) as unknown;
				if (typeof parsed !== "object" || parsed === null) {
					return { ok: false, error: "invalid JSON body" };
				}
				payload = parsed as { method?: unknown; params?: unknown };
			} catch {
				return { ok: false, error: "invalid JSON body" };
			}
		}
		const service = ctx.get?.(PIDECK_SESSION_BRIDGE_SERVICE) as SessionBridgeService | undefined;
		return sessionBridgeRpc(service, payload?.method, payload?.params);
	})();
	return new Response(JSON.stringify(result), {
		status: result.ok ? 200 : 400,
		headers: { "content-type": "application/json" },
	});
}

/** 桥插件（cordis 插件形状，命名导出与 pideckPluginBridge 一致）。 */
export const name = "pideck-session-bridge";

export function apply(ctx: SessionBridgeCtx): void {
	const service: SessionBridgeService = {
		async cursor(input) {
			const validated = validateSessionCursorParams(input);
			if (!validated.ok) return validated;
			const query = ctx.get?.("sessionQuery") as
				| {
					observeSession?(sessionId: string, options?: { projectionMode?: "all" | "none" }): Promise<{
						cursor: unknown;
						[Symbol.dispose]?(): unknown;
					} | undefined>;
				}
				| undefined;
			if (!query?.observeSession) return { ok: false, error: "sessionQuery service is not mounted" };
			try {
				// projectionMode: 'none'——与应用官方 session/page 的读取姿势一致，
				// 冷读不计算/不写投影缓存；dispose 及时释放 observation lease。
				const observation = await query.observeSession(validated.value.sessionId, {
					projectionMode: "none",
				});
				try {
					const cursor = observation?.cursor;
					// cursor 语义与 SessionObservation 一致：最后一条事件 seq，空日志为 -1。
					if (typeof cursor !== "number" || !Number.isSafeInteger(cursor)) {
						return { ok: false, error: "session observation returned an invalid cursor" };
					}
					return { ok: true, value: { cursor } };
				} finally {
					observation?.[Symbol.dispose]?.();
				}
			} catch (error) {
				// 老日志迁移拒绝（subagent/descriptor 版本不兼容等）会在这里变成
				// SessionFormatUnsupportedError；原样回传主进程，由调用方决定提示。
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
	ctx.provide?.(PIDECK_SESSION_BRIDGE_SERVICE, service);
}