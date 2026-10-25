/**
 * pideck-command-bridge：PiDeck ↔ DSH host 的会话命令枚举桥（D15）。
 *
 * 背景：官方 ApiProxy wire 没有命令列表方法（dsh-web 的命令补全走浏览器端
 * Typert Remote `commands.list`，PiDeck 只有 api-proxy RPC 通道拿不到）。
 * 本插件把 host 进程内的命令注册表（`ctx.commands.list(agent)`，CommandDescriptor）
 * 暴露成一个主进程可经 fetch 桥调用的服务（`ctx.pideckCommandsBridge`），
 * 与 pideckPluginBridge 同构：前缀路由 + POST JSON + { ok, value|error } 信封。
 *
 * 语义：
 * - 只读枚举：list(sessionId) 返回该会话 live Agent 生效的命令描述符（含
 *   用户/插件注册的命令，名称按注册表排序），不执行任何命令；
 * - 执行仍走既有 slash 桥（/permission /plan /compact 等，见 hostEntry 的
 *   pideck-slash-bridge 生成脚本），本桥不做执行，不引入第二执行路径；
 * - 会话必须有 live Agent（懒启动 host 且已激活），否则返回结构化错误，
 *   渲染层按能力降级为静态建议列表（DSH_COMMAND_SUGGESTIONS）。
 */

import type { DshCommandView, DshPluginBridgeResponse } from "../../shared/types";

/** 桥服务键（hostEntry 路由与主进程协议共用）。 */
export const PIDECK_COMMANDS_BRIDGE_SERVICE = "pideckCommandsBridge";

/** 桥 RPC 路径前缀（hostEntry 的 fetch 路由拦截用）。 */
export const PIDECK_COMMANDS_BRIDGE_PATH = "/pideck-command/rpc";

/** 结构化桥结果：方法永不向桥外抛异常，错误一律包成 { ok: false, error }。 */
export type CommandsBridgeResult<T> = DshPluginBridgeResponse<T>;

/** 命令枚举入参（渲染层数据不可信，校验在边界）。 */
export type CommandsBridgeListParams = {
	sessionId: string;
};

/** 桥插件可见的 ctx 形状（结构类型，避免运行时依赖 @deepseek-ai/cordis）。 */
export type CommandsBridgeCtx = {
	get?(key: string): unknown;
	provide?(key: string, value: unknown): unknown;
};

/** 校验 list 入参（sessionId 必填；其余字段忽略）。 */
export function validateListParams(input: unknown): CommandsBridgeResult<CommandsBridgeListParams> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, error: "invalid list payload" };
	}
	const sessionId = (input as Record<string, unknown>).sessionId;
	if (typeof sessionId !== "string" || !sessionId) {
		return { ok: false, error: "sessionId is required" };
	}
	return { ok: true, value: { sessionId } };
}

/** 把 host 的 CommandDescriptor 映射成安全 JSON 视图（只取叶子字段）。 */
export function toCommandView(descriptor: unknown): DshCommandView | undefined {
	if (typeof descriptor !== "object" || descriptor === null) return undefined;
	const record = descriptor as Record<string, unknown>;
	const name = record.name;
	const description = record.description;
	if (typeof name !== "string" || !name || typeof description !== "string") return undefined;
	const input = record.input;
	const hint = typeof input === "object" && input !== null ? (input as Record<string, unknown>).hint : undefined;
	return {
		name,
		description,
		...(typeof hint === "string" && hint ? { inputHint: hint } : {}),
	};
}

/** 桥服务方法签名（结构类型；host 侧由 CommandRuntime 提供能力）。 */
export type CommandsBridgeService = {
	list(input: unknown): CommandsBridgeResult<unknown>;
};

/**
 * 桥 RPC 分发：method + params → 服务调用。纯函数（service 可注入替身），
 * 供 hostEntry 的 fetch 路由与单测共用。当前只有只读 list；未知方法返回结构化错误。
 */
export async function commandsBridgeRpc(service: CommandsBridgeService | undefined, method: unknown, params: unknown): Promise<CommandsBridgeResult<unknown>> {
	if (!service) return { ok: false, error: "command bridge service is not available" };
	switch (method) {
		case "list":
			return service.list(params);
		default:
			return { ok: false, error: `unknown command bridge method: ${String(method)}` };
	}
}

/**
 * hostEntry fetch 路由的桥请求处理：POST JSON { method, params } → 结构化 JSON 响应。
 * 与主进程 DshHost.bridgeRpc 的 rawFetch 协议对齐；错误返回 400 + { ok: false, error }。
 */
export async function handleCommandsBridgeFetch(ctx: CommandsBridgeCtx, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
	const result = await (async (): Promise<CommandsBridgeResult<unknown>> => {
		if ((init?.method ?? "GET").toUpperCase() !== "POST") {
			return { ok: false, error: "command bridge requires POST" };
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
		const service = ctx.get?.(PIDECK_COMMANDS_BRIDGE_SERVICE) as CommandsBridgeService | undefined;
		return commandsBridgeRpc(service, payload?.method, payload?.params);
	})();
	return new Response(JSON.stringify(result), {
		status: result.ok ? 200 : 400,
		headers: { "content-type": "application/json" },
	});
}

/** 桥插件（cordis 插件形状，命名导出与 pideckPluginBridge 一致）。 */
export const name = "pideck-command-bridge";

export function apply(ctx: CommandsBridgeCtx): void {
	const service: CommandsBridgeService = {
		list(input) {
			const validated = validateListParams(input);
			if (!validated.ok) return validated;
			const agents = ctx.get?.("agents") as { get?(id: string): unknown } | undefined;
			const agent = agents?.get?.(validated.value.sessionId);
			if (!agent) {
				return { ok: false, error: `no live DSH agent for session ${validated.value.sessionId}` };
			}
			const commands = ctx.get?.("commands") as { list?(agent: unknown): unknown[] } | undefined;
			if (!commands?.list) return { ok: false, error: "commands registry is not mounted" };
			const descriptors = commands.list(agent);
			const views = Array.isArray(descriptors) ? descriptors.map(toCommandView).filter((view): view is DshCommandView => Boolean(view)) : [];
			return { ok: true, value: views };
		},
	};
	ctx.provide?.(PIDECK_COMMANDS_BRIDGE_SERVICE, service);
}
