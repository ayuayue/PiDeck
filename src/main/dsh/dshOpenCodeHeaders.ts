/** DSH 请求级 OpenCode 兼容层：仅补传输元数据，不修改供应商配置或会话内容。 */
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ProviderHeaders } from "@earendil-works/pi-ai";

type OpenCodeRoute = { provider: string; baseUrl?: string };
type RequestOptions = { sessionId?: string; headers?: ProviderHeaders };
type AppliedAuthResult = { requestModel: OpenCodeRoute; requestOptions: RequestOptions };
// applyAuth 不是公开类型契约；入参与结果保持 unknown，只有验证后的返回结构才能补头。
type RuntimeApplyAuth = (this: RuntimeModels, model: unknown, options?: unknown) => Promise<unknown>;
type RuntimeModels = { applyAuth: RuntimeApplyAuth };
type Installation = { users: number; restore: () => void };
const installations = new WeakMap<object, Installation>();

/** 兼容目录供应商和用户改名的官方端点；不对 URL 子串/子域做模糊匹配。 */
export function isOpenCodeRoute(model: OpenCodeRoute): boolean {
	if (model.provider === "opencode" || model.provider === "opencode-go") return true;
	try {
		const url = new URL(model.baseUrl ?? "");
		return (url.protocol === "https:" || url.protocol === "http:") && url.hostname === "opencode.ai";
	} catch {
		return false;
	}
}

/** 显式头（包括空串/null）按大小写不敏感优先；无会话 ID 时绝不伪造随机 ID。 */
export function addOpenCodeHeaders(headers: ProviderHeaders, sessionId?: string): ProviderHeaders {
	const names = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
	const next = { ...headers };
	if (sessionId && !names.has("x-opencode-session")) next["x-opencode-session"] = sessionId;
	if (!names.has("x-opencode-client")) next["x-opencode-client"] = "pideck";
	return next;
}

/** 动态依赖先检查 runtime seam；不假定 app 内置 pi-ai 与 DSH runtime 是同一份。 */
function hasApplyAuth(value: unknown): value is RuntimeModels {
	return typeof value === "object" && value !== null && "applyAuth" in value && typeof value.applyAuth === "function";
}

/** runtime 升级若改变结果结构，原样透传而不是让可选兼容头阻断请求。 */
function isAppliedAuthResult(value: unknown): value is AppliedAuthResult {
	if (!isRecord(value) || !isRecord(value.requestModel) || !isRecord(value.requestOptions)) return false;
	const { provider, baseUrl } = value.requestModel;
	const { sessionId, headers } = value.requestOptions;
	return typeof provider === "string" && (baseUrl === undefined || typeof baseUrl === "string") && (sessionId === undefined || typeof sessionId === "string") && (headers === undefined || (isRecord(headers) && Object.values(headers).every((header) => typeof header === "string" || header === null)));
}

/**
 * pi-ai 1.4.0 起自行注入 `x-opencode-session`，但只按主机名匹配（不校验协议），
 * 于是 `file://opencode.ai/...` 这类非 OpenCode 路由也会带出会话 ID。
 * 非 OpenCode 路由上，把与我们本层注入值完全一致的键剔除；用户显式配置的其它值保持原样。
 */
function stripLeakedOpenCodeHeaders(headers: ProviderHeaders, sessionId?: string): ProviderHeaders | undefined {
	const leaked: string[] = [];
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		const ours = lower === "x-opencode-client" ? "pideck" : lower === "x-opencode-session" ? sessionId : undefined;
		if (ours !== undefined && value === ours) leaked.push(name);
	}
	if (leaked.length === 0) return undefined;
	const next: ProviderHeaders = { ...headers };
	for (const name of leaked) delete next[name];
	return next;
}

/**
 * 在 pi-ai 完成鉴权后、调用供应商前补头。
 * public transformHeaders 拿不到鉴权后的目标地址；这里必须以最终 requestModel 判断，
 * 避免把 OpenCode 元数据发送给已被鉴权切换到其它地址的别名路由，同时保留已合并的显式头。
 */
function decorateAppliedAuth(result: AppliedAuthResult): AppliedAuthResult {
	if (!isOpenCodeRoute(result.requestModel)) {
		const headers = stripLeakedOpenCodeHeaders(result.requestOptions.headers ?? {}, result.requestOptions.sessionId);
		return headers === undefined ? result : { ...result, requestOptions: { ...result.requestOptions, headers } };
	}
	return {
		...result,
		requestOptions: {
			...result.requestOptions,
			headers: addOpenCodeHeaders(result.requestOptions.headers ?? {}, result.requestOptions.sessionId),
		},
	};
}

/**
 * 安装到实际 DSH runtime 的 Models.applyAuth 出口，覆盖其后创建的配置快照。
 * 这是唯一私有接入点：公开 transformHeaders 缺少最终路由，不能重复解析鉴权来猜测端点。
 * 只装饰已完成的结果，不重写鉴权/惰性流/取消；方法或返回形状变化时降级为不补头。
 * sessionId 来自本次请求，不能以共享 profile.headers 承载并发会话身份。
 */
export function installDshOpenCodeHeaders(piAiModule: unknown): () => void {
	if (typeof piAiModule !== "object" || piAiModule === null || !("createModels" in piAiModule) || typeof piAiModule.createModels !== "function") {
		throw new Error("DSH pi-ai does not expose createModels");
	}
	const models: unknown = piAiModule.createModels();
	if (!hasApplyAuth(models)) throw new Error("DSH pi-ai Models auth hook is unavailable");
	const prototype: unknown = Object.getPrototypeOf(models);
	if (!hasApplyAuth(prototype) || models.applyAuth !== prototype.applyAuth) {
		throw new Error("DSH pi-ai Models auth hook layout has changed");
	}
	let installation = installations.get(prototype);
	if (!installation) {
		const originalApplyAuth = prototype.applyAuth;
		let active = true;
		const applyAuth: RuntimeApplyAuth = async function (model, options) {
			const result = await originalApplyAuth.call(this, model, options);
			// await 后再检查，保证鉴权等待期间卸载也不会继续注入。
			return active && isAppliedAuthResult(result) ? decorateAppliedAuth(result) : result;
		};
		// 只写一个方法：若未来 runtime 冻结原型，安装失败也不会留下半安装状态。
		prototype.applyAuth = applyAuth;
		installation = {
			users: 0,
			restore: () => {
				// 先停用闭包，再尝试物理恢复；其它插件保留旧 wrapper 时也不能继续注入。
				active = false;
				if (prototype.applyAuth === applyAuth) prototype.applyAuth = originalApplyAuth;
			},
		};
		installations.set(prototype, installation);
	}
	installation.users += 1;
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		installation.users -= 1;
		if (installation.users === 0) {
			installation.restore();
			installations.delete(prototype);
		}
	};
}

/** 对包清单做最小收窄；未知 exports 形状留给调用方诊断，不猜内部路径。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 以 DSH adapter 为父模块解析其 pi-ai（可能是嵌套的旧版本）。该包只有 import export，
 * createRequire().resolve() 会报 ERR_PACKAGE_PATH_NOT_EXPORTED，不能退回 app 顶层同名包。
 * findPackageJSON 负责 Node 的就近查找，再读取声明的 import 入口；不硬编码 dist 路径。
 */
export function resolveDshPiAiEntry(adapterEntry: string): string {
	const manifestPath = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(adapterEntry));
	if (!manifestPath) throw new Error("DSH pi-ai package could not be resolved");
	const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
	const exports = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : undefined;
	const root = exports?.["."];
	const entry = typeof root === "string" ? root : isRecord(root) ? root.import : undefined;
	if (typeof entry !== "string" || !entry.startsWith("./")) throw new Error("DSH pi-ai import entry is unsupported");
	return fileURLToPath(new URL(entry, pathToFileURL(manifestPath)));
}

/** host 在 config-tree 挂载前调用；加载失败由 host 记录诊断并继续启动。 */
export async function loadDshOpenCodeHeaders(adapterEntry: string, loadModule: (url: string) => Promise<unknown> = (url) => import(url)): Promise<() => void> {
	const piAiModule = await loadModule(pathToFileURL(resolveDshPiAiEntry(adapterEntry)).href);
	return installDshOpenCodeHeaders(piAiModule);
}
