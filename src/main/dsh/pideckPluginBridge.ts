/**
 * pideck-plugin-bridge：PiDeck ↔ DSH host 的动态 Cordis 插件管理桥（G13 深化）。
 *
 * 挂在 DSH host 组合内（hostEntry patches insert，经绝对路径加载本产物），把
 * cordis 动态插件运行器（ctx.dynamicCordisRunner）与静态 Loader 清单
 * （ctx.pluginInventory）暴露成一个主进程可经 fetch 桥调用的服务
 * （ctx.pideckPluginBridge，协议见 pluginBridgeRpc）。
 *
 * 语义与 dsh-tool-cordis 完全一致（本文件只是把同一服务对象暴露给 PiDeck 面板）：
 * - 动态插件是**进程内临时扩展**：define 不落盘、不写仓库/配置，重启即失；
 * - 插件按会话归属（sessionId），生命周期方法要求该会话有 live Agent；
 * - 面板手势（run/stop/uninstall）走 requestId=null 的 direct gesture 路径，无需审批；
 * - 宿主侧执行任意代码——运行器明示「不是安全边界」，UI 必须提示用户。
 *
 * 静态清单（ctx.pluginInventory）只读：展示当前 Loader 条目（moduleName/enabled/
 * fiberPhase），不做写入（cordis.yml 写回会 bake patch 行，见 gap 文档）。
 */

import type {
	DshPluginBridgeResponse,
	DshPluginInstallInput,
	DshPluginLifecycleInput,
	DshPluginView,
	DshStaticPluginView,
} from "../../shared/types";

/** 桥服务键（hostEntry 路由与主进程协议共用）。 */
export const PIDECK_PLUGIN_BRIDGE_SERVICE = "pideckPluginBridge";

/** 桥 RPC 路径前缀（hostEntry 的 fetch 路由拦截用）。 */
export const PIDECK_PLUGIN_BRIDGE_PATH = "/pideck-plugin/rpc";

/** 安装输入的源码单侧上限（防超大 IPC 载荷；运行器本身无限制）。 */
export const PLUGIN_SOURCE_MAX_CHARS = 1_000_000;

/** 结构化桥结果：方法永不向桥外抛异常，错误一律包成 { ok: false, error }。 */
export type PluginBridgeResult<T> = DshPluginBridgeResponse<T>;

/** 安装（define）入参。 */
export type PluginBridgeInstallInput = DshPluginInstallInput;

/** 生命周期操作入参（run/stop/uninstall）。 */
export type PluginBridgeLifecycleInput = DshPluginLifecycleInput;

/** 动态插件清单行（inventory 的安全 JSON 视图，剥离内部对象）。 */
export type DynamicPluginView = DshPluginView;

/** 静态 Loader 条目视图（pluginInventory 的安全 JSON 视图）。 */
export type StaticPluginView = DshStaticPluginView;

/** 桥插件可见的 ctx 形状（结构类型，避免运行时依赖 @deepseek-ai/cordis）。 */
export type PluginBridgeCtx = {
	get?(key: string): unknown;
	provide?(key: string, value: unknown): unknown;
};

/** 校验安装入参（渲染层数据不可信，校验在边界；idPrefix 语义与 cordis 提示一致）。 */
export function validatePluginInstallInput(input: unknown): PluginBridgeResult<PluginBridgeInstallInput> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, error: "invalid install payload" };
	}
	const record = input as Record<string, unknown>;
	const sessionId = record.sessionId;
	const idPrefix = record.idPrefix;
	const name = record.name;
	const purpose = record.purpose;
	const hostCode = record.hostCode;
	const clientCode = record.clientCode;
	if (typeof sessionId !== "string" || !sessionId) {
		return { ok: false, error: "sessionId is required" };
	}
	if (typeof idPrefix !== "string" || !/^[a-z]{3,6}$/.test(idPrefix)) {
		return { ok: false, error: "idPrefix must be 3-6 lowercase English letters" };
	}
	if (typeof name !== "string" || !name.trim()) {
		return { ok: false, error: "name is required" };
	}
	if (typeof purpose !== "string" || !purpose.trim()) {
		return { ok: false, error: "purpose is required" };
	}
	const clean = (value: unknown): string | undefined =>
		typeof value === "string" && value.length > 0 ? value : undefined;
	const host = clean(hostCode);
	const client = clean(clientCode);
	if (!host && !client) {
		return { ok: false, error: "at least one of hostCode/clientCode is required" };
	}
	if (host && host.length > PLUGIN_SOURCE_MAX_CHARS) {
		return { ok: false, error: "hostCode exceeds size limit" };
	}
	if (client && client.length > PLUGIN_SOURCE_MAX_CHARS) {
		return { ok: false, error: "clientCode exceeds size limit" };
	}
	return {
		ok: true,
		value: { sessionId, idPrefix, name: name.trim(), purpose: purpose.trim(), hostCode: host, clientCode: client },
	};
}

/** 校验生命周期入参（sessionId/pluginId 必填，packageId 可选——stop/uninstall 不需要）。 */
export function validatePluginLifecycleInput(input: unknown): PluginBridgeResult<PluginBridgeLifecycleInput> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, error: "invalid lifecycle payload" };
	}
	const record = input as Record<string, unknown>;
	const sessionId = record.sessionId;
	const pluginId = record.pluginId;
	const packageId = record.packageId;
	const mode = record.mode;
	if (typeof sessionId !== "string" || !sessionId) {
		return { ok: false, error: "sessionId is required" };
	}
	if (typeof pluginId !== "string" || !pluginId) {
		return { ok: false, error: "pluginId is required" };
	}
	if (packageId !== undefined && (typeof packageId !== "string" || !packageId)) {
		return { ok: false, error: "packageId must be a non-empty string" };
	}
	if (mode !== undefined && mode !== "run" && mode !== "update") {
		return { ok: false, error: "mode must be 'run' or 'update'" };
	}
	return { ok: true, value: { sessionId, pluginId, packageId, mode } };
}

/** 把 host 的 inventory 行映射成安全 JSON 视图（只取叶子字段，不序列化 live 对象）。 */
export function toDynamicPluginView(row: unknown): DynamicPluginView | undefined {
	if (typeof row !== "object" || row === null) return undefined;
	const record = row as Record<string, unknown>;
	const pluginId = record.pluginId;
	const agentId = record.agentId;
	if (typeof pluginId !== "string" || typeof agentId !== "string") return undefined;
	const packages = Array.isArray(record.packages)
		? record.packages
			.map((pkg): DynamicPluginView["packages"][number] | undefined => {
				if (typeof pkg !== "object" || pkg === null) return undefined;
				const p = pkg as Record<string, unknown>;
				if (typeof p.packageId !== "string") return undefined;
				return {
					packageId: p.packageId,
					name: typeof p.name === "string" ? p.name : "",
					purpose: typeof p.purpose === "string" ? p.purpose : "",
					hasHostHalf: p.hasHostHalf === true,
					hasClientHalf: p.hasClientHalf === true,
				};
			})
			.filter((pkg): pkg is DynamicPluginView["packages"][number] => Boolean(pkg))
		: [];
	const activeRun = record.activeRun;
	const latestRun = record.latestRun;
	const view: DynamicPluginView = {
		pluginId,
		agentId,
		packages,
		...(typeof record.currentPackageId === "string" ? { currentPackageId: record.currentPackageId } : {}),
		...(typeof record.nextPackageId === "string" ? { nextPackageId: record.nextPackageId } : {}),
		...(typeof activeRun === "object" && activeRun !== null
			? {
				activeRun: {
					pluginRunId: typeof (activeRun as Record<string, unknown>).pluginRunId === "string"
						? (activeRun as Record<string, unknown>).pluginRunId as string
						: "",
					packageId: typeof (activeRun as Record<string, unknown>).packageId === "string"
						? (activeRun as Record<string, unknown>).packageId as string
						: "",
				},
			}
			: {}),
		...(typeof latestRun === "object" && latestRun !== null
			? {
				status: typeof (latestRun as Record<string, unknown>).status === "string"
					? (latestRun as Record<string, unknown>).status as string
					: undefined,
				mode: typeof (latestRun as Record<string, unknown>).mode === "string"
					? (latestRun as Record<string, unknown>).mode as string
					: undefined,
				error: (() => {
					const error = (latestRun as Record<string, unknown>).error;
					return typeof error === "object" && error !== null
						? typeof (error as Record<string, unknown>).message === "string"
							? (error as Record<string, unknown>).message as string
							: undefined
						: undefined;
				})(),
			}
			: {}),
	};
	return view;
}

/** 把静态 Loader 条目映射成安全 JSON 视图。 */
export function toStaticPluginView(entry: unknown): StaticPluginView | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const record = entry as Record<string, unknown>;
	const entryId = record.entryId;
	const moduleName = record.moduleName;
	if (typeof entryId !== "string" || typeof moduleName !== "string") return undefined;
	return {
		entryId,
		moduleName,
		enabled: record.enabled === true,
		fiberPhase: record.fiberPhase === null || typeof record.fiberPhase === "string" ? record.fiberPhase : null,
	};
}

/** 合并时 fiberPhase 的取用优先级（数字越大越值得展示：失败最该被看见）。 */
const FIBER_PHASE_RANK: Record<string, number> = {
	failed: 5,
	active: 4,
	loading: 3,
	pending: 2,
	unloading: 1,
};

/**
 * 把同 moduleName 的多个静态 Loader 条目合并成一行（只读清单去重）。
 *
 * 背景：cordis Loader 按「条目标识」管理条目，同一模块可因多个 group/fiber
 * 配置出现多条（entryId 不同、启停/阶段可能不一致），面板只读清单因此出现
 * 整块重复行。对用户而言模块才是关心的单位——合并后一模块一行：
 * enabled 取任一启用（模块有一个实例启用即算启用），fiberPhase 取优先级
 * 最高的一条（failed > active > loading > pending > unloading > null），
 * entryId 保留第一条以维持稳定 key；整体顺序按首次出现保持 Loader 序。
 */
export function mergeStaticPluginViews(views: StaticPluginView[]): StaticPluginView[] {
	const merged = new Map<string, StaticPluginView>();
	for (const view of views) {
		const existing = merged.get(view.moduleName);
		if (!existing) {
			merged.set(view.moduleName, { ...view });
			continue;
		}
		existing.enabled = existing.enabled || view.enabled;
		const existingRank = FIBER_PHASE_RANK[existing.fiberPhase ?? ""] ?? 0;
		const nextRank = FIBER_PHASE_RANK[view.fiberPhase ?? ""] ?? 0;
		if (nextRank > existingRank) existing.fiberPhase = view.fiberPhase;
	}
	return [...merged.values()];
}

/** 按 sessionId 解析 live Agent（运行器全部生命周期方法要求会话归属）。 */
export function resolveBridgeAgent(
	ctx: PluginBridgeCtx,
	sessionId: string,
): PluginBridgeResult<{ agent: unknown }> {
	const agents = ctx.get?.("agents") as { get?(id: string): unknown } | undefined;
	const agent = agents?.get?.(sessionId);
	if (!agent) {
		return { ok: false, error: `no live DSH agent for session ${sessionId}` };
	}
	return { ok: true, value: { agent } };
}

/** 桥服务方法签名（结构类型；host 侧由 DynamicCordisRunnerService 提供）。 */
export type PluginBridgeService = {
	inventory(): PluginBridgeResult<unknown>;
	/** 静态清单读取是异步的：dsh-host-plugin-inventory 的 list() 为 async（还要聚合
	 *  各 preset 的 compositionInventory），漏 await 会让快照变成 Promise，
	 *  entries 取不到 → UI 显示「暂无静态条目」（0 条）而不是报错。 */
	staticInventory(): PluginBridgeResult<unknown> | Promise<PluginBridgeResult<unknown>>;
	install(input: unknown): PluginBridgeResult<unknown>;
	run(input: unknown): PluginBridgeResult<unknown> | Promise<PluginBridgeResult<unknown>>;
	stop(input: unknown): PluginBridgeResult<unknown> | Promise<PluginBridgeResult<unknown>>;
	uninstall(input: unknown): PluginBridgeResult<unknown> | Promise<PluginBridgeResult<unknown>>;
};

/**
 * 桥 RPC 分发：method + params → 服务调用。纯函数（service 可注入替身），
 * 供 hostEntry 的 fetch 路由与单测共用。服务方法统一返回 PluginBridgeResult，
 * 分发器原样透传；未知方法返回结构化错误。
 */
export async function pluginBridgeRpc(
	service: PluginBridgeService | undefined,
	method: unknown,
	params: unknown,
): Promise<PluginBridgeResult<unknown>> {
	if (!service) return { ok: false, error: "plugin bridge service is not available" };
	switch (method) {
		case "inventory":
			return service.inventory();
		case "staticInventory":
			return service.staticInventory();
		case "install":
			return service.install(params);
		case "run":
			return service.run(params);
		case "stop":
			return service.stop(params);
		case "uninstall":
			return service.uninstall(params);
		default:
			return { ok: false, error: `unknown plugin bridge method: ${String(method)}` };
	}
}

/**
 * hostEntry fetch 路由的桥请求处理：POST JSON { method, params } → 结构化 JSON 响应。
 * 与主进程 DshHost 的 rawFetch 协议对齐；错误返回 400 + { ok: false, error }。
 */
export async function handlePluginBridgeFetch(
	ctx: PluginBridgeCtx,
	init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response> {
	const result = (await (async (): Promise<PluginBridgeResult<unknown>> => {
		if ((init?.method ?? "GET").toUpperCase() !== "POST") {
			return { ok: false, error: "plugin bridge requires POST" };
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
		const service = ctx.get?.(PIDECK_PLUGIN_BRIDGE_SERVICE) as PluginBridgeService | undefined;
		return pluginBridgeRpc(service, payload?.method, payload?.params);
	})());
	return new Response(JSON.stringify(result), {
		status: result.ok ? 200 : 400,
		headers: { "content-type": "application/json" },
	});
}

/** 桥插件（cordis 插件形状：name + apply）。 */
export const name = "pideck-plugin-bridge";

export function apply(ctx: PluginBridgeCtx): void {
	const service: PluginBridgeService = {
		inventory() {
			const runner = ctx.get?.("dynamicCordisRunner") as { inventory?(): unknown } | undefined;
			if (!runner?.inventory) return { ok: false, error: "dynamicCordisRunner is not mounted" };
			const rows = runner.inventory();
			const views = Array.isArray(rows)
				? rows.map(toDynamicPluginView).filter((view): view is DynamicPluginView => Boolean(view))
				: [];
			return { ok: true, value: views };
		},
		async staticInventory() {
			const inventory = ctx.get?.("pluginInventory") as { list?(): Promise<{ entries?: unknown }> | { entries?: unknown } } | undefined;
			if (!inventory?.list) return { ok: false, error: "pluginInventory is not mounted" };
			// 必须 await：该服务的 list() 是 async（见 runtime dsh-host-plugin-inventory）。
			const snapshot = await inventory.list();
			const entries = snapshot?.entries;
			const views = Array.isArray(entries)
				? entries.map(toStaticPluginView).filter((view): view is StaticPluginView => Boolean(view))
				: [];
			// 同模块的多条 Loader 条目（不同 group/fiber 各一条）合并成一行，
			// 桌面配置页与 dsh-web 面板拿到的都是去重后的模块清单。
			return { ok: true, value: mergeStaticPluginViews(views) };
		},
		install(input) {
			const validated = validatePluginInstallInput(input);
			if (!validated.ok) return validated;
			const runner = ctx.get?.("dynamicCordisRunner") as {
				define?(request: {
					sessionId: string;
					plugin: { kind: "new"; idPrefix: string };
					name: string;
					purpose: string;
					code: { host?: string; client?: string };
				}): unknown;
			} | undefined;
			if (!runner?.define) return { ok: false, error: "dynamicCordisRunner is not mounted" };
			const receipt = runner.define({
				sessionId: validated.value.sessionId,
				plugin: { kind: "new", idPrefix: validated.value.idPrefix },
				name: validated.value.name,
				purpose: validated.value.purpose,
				code: {
					...(validated.value.hostCode !== undefined ? { host: validated.value.hostCode } : {}),
					...(validated.value.clientCode !== undefined ? { client: validated.value.clientCode } : {}),
				},
			});
			return { ok: true, value: receipt };
		},
		run(input) {
			const validated = validatePluginLifecycleInput(input);
			if (!validated.ok) return validated;
			const { sessionId, pluginId, packageId, mode } = validated.value;
			if (!packageId) return { ok: false, error: "packageId is required to run a plugin" };
			const agentResult = resolveBridgeAgent(ctx, sessionId);
			if (!agentResult.ok) return agentResult;
			const runner = ctx.get?.("dynamicCordisRunner") as {
				runHostHalf?(
					agent: unknown,
					pluginId: string,
					packageId: string,
					mode: "run" | "update",
					requestId: null,
					approveFutureVersions: boolean,
				): Promise<unknown>;
			} | undefined;
			if (!runner?.runHostHalf) return { ok: false, error: "dynamicCordisRunner is not mounted" };
			// 面板手势：requestId=null（direct gesture，无需审批），不预授权未来版本。
			return runner.runHostHalf(agentResult.value.agent, pluginId, packageId, mode ?? "run", null, false)
				.then((value) => ({ ok: true as const, value }))
				.catch((error: unknown) => ({
					ok: false as const,
					error: error instanceof Error ? error.message : String(error),
				}));
		},
		stop(input) {
			const validated = validatePluginLifecycleInput(input);
			if (!validated.ok) return validated;
			const agentResult = resolveBridgeAgent(ctx, validated.value.sessionId);
			if (!agentResult.ok) return agentResult;
			const runner = ctx.get?.("dynamicCordisRunner") as {
				stop?(agent: unknown, pluginId: string): Promise<unknown>;
			} | undefined;
			if (!runner?.stop) return { ok: false, error: "dynamicCordisRunner is not mounted" };
			return runner.stop(agentResult.value.agent, validated.value.pluginId)
				.then((value) => ({ ok: true as const, value }))
				.catch((error: unknown) => ({
					ok: false as const,
					error: error instanceof Error ? error.message : String(error),
				}));
		},
		uninstall(input) {
			const validated = validatePluginLifecycleInput(input);
			if (!validated.ok) return validated;
			const agentResult = resolveBridgeAgent(ctx, validated.value.sessionId);
			if (!agentResult.ok) return agentResult;
			const runner = ctx.get?.("dynamicCordisRunner") as {
				undefine?(agent: unknown, pluginId: string): Promise<unknown>;
			} | undefined;
			if (!runner?.undefine) return { ok: false, error: "dynamicCordisRunner is not mounted" };
			return runner.undefine(agentResult.value.agent, validated.value.pluginId)
				.then((value) => ({ ok: true as const, value }))
				.catch((error: unknown) => ({
					ok: false as const,
					error: error instanceof Error ? error.message : String(error),
				}));
		},
	};
	ctx.provide?.(PIDECK_PLUGIN_BRIDGE_SERVICE, service);
}
