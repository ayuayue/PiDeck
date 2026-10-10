/** Pure policy shared by the view host and broker; failures never fall back to a broader capability. */
import type { HostPluginContext, HostPluginRequest } from "../../shared/types/hostPlugin";
import { isHostPluginAsset, isPluginRecord } from "./hostPluginManifest";
import { parseHostPluginNetworkRequest } from "./hostPluginNetworkPolicy";

export const HOST_PLUGIN_SCHEME = "pideck-plugin";
export const HOST_PLUGIN_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; worker-src 'self' blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

export function pluginAssetFromUrl(url: string, instanceId: string): string | undefined {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== `${HOST_PLUGIN_SCHEME}:` || parsed.hostname !== instanceId || parsed.username || parsed.password || parsed.port || parsed.search) return undefined;
		const asset = decodeURIComponent(parsed.pathname.slice(1));
		return isHostPluginAsset(asset) ? asset : undefined;
	} catch {
		return undefined;
	}
}

export function parsePluginContext(value: unknown): HostPluginContext {
	if (!isPluginRecord(value) || !["zh-CN", "en-US"].includes(String(value.locale)) || !["light", "dark"].includes(String(value.theme))) throw new Error("invalid-context");
	// 显示名与标题只当文本用：长度有界、不含控制字符，不参与任何路径或查询构造。
	for (const key of ["projectId", "sessionId"]) if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 160 || /[\u0000-\u001f]/.test(value[key]))) throw new Error("invalid-context");
	for (const key of ["projectName", "sessionTitle"]) if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 160 || /[\u0000-\u001f]/.test(value[key]))) throw new Error("invalid-context");
	const tokens: Record<string, string> = {};
	if (value.tokens !== undefined) {
		if (!isPluginRecord(value.tokens) || Object.keys(value.tokens).length > 40) throw new Error("invalid-context");
		for (const [key, token] of Object.entries(value.tokens)) {
			if (!/^--[a-z-]{1,60}$/.test(key) || typeof token !== "string" || token.length > 160 || /[;{}<>\u0000-\u001f]/.test(token)) throw new Error("invalid-context");
			tokens[key] = token;
		}
	}
	return {
		projectId: typeof value.projectId === "string" ? value.projectId : undefined,
		projectName: typeof value.projectName === "string" ? value.projectName : undefined,
		sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
		sessionTitle: typeof value.sessionTitle === "string" ? value.sessionTitle : undefined,
		locale: value.locale === "en-US" ? "en-US" : "zh-CN",
		theme: value.theme === "light" ? "light" : "dark",
		tokens,
	};
}

export function parsePluginRequest(value: unknown): HostPluginRequest {
	if (!isPluginRecord(value)) throw new Error("invalid-request");
	if (value.method === "context.get") return { method: value.method };
	if (value.method === "network.request") return { method: value.method, request: parseHostPluginNetworkRequest(value.request) };
	if (value.method === "sessions.list") {
		if (value.offset !== undefined && (typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 100_000)) throw new Error("invalid-request");
		return { method: value.method, offset: typeof value.offset === "number" ? value.offset : undefined };
	}
	if (value.method === "sessions.get") {
		if (typeof value.sessionId !== "string" || value.sessionId.length < 1 || value.sessionId.length > 160) throw new Error("invalid-request");
		return { method: value.method, sessionId: value.sessionId };
	}
	if (value.method === "sessions.search") {
		// 搜索只比对标题，不读历史文件：查询串长度有界，结果条数默认 20、上限 100。
		if (typeof value.query !== "string" || value.query.length < 1 || value.query.length > 80 || /[\u0000-\u001f]/.test(value.query)) throw new Error("invalid-request");
		if (value.limit !== undefined && (typeof value.limit !== "number" || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100)) throw new Error("invalid-request");
		return { method: value.method, query: value.query, limit: typeof value.limit === "number" ? value.limit : undefined };
	}
	if (value.method === "sessions.entries") {
		if (typeof value.sessionId !== "string" || value.sessionId.length < 1 || value.sessionId.length > 160) throw new Error("invalid-request");
		let cursor;
		if (value.cursor !== undefined) {
			if (!isPluginRecord(value.cursor) || typeof value.cursor.before !== "number" || !Number.isSafeInteger(value.cursor.before) || value.cursor.before < 0 || typeof value.cursor.version !== "string" || value.cursor.version.length > 4000) throw new Error("invalid-request");
			cursor = { before: value.cursor.before, version: value.cursor.version };
		}
		return { method: value.method, sessionId: value.sessionId, cursor };
	}
	if (value.method === "storage.get" || value.method === "storage.set") {
		if (typeof value.key !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(value.key)) throw new Error("invalid-request");
		if (value.method === "storage.get") return { method: value.method, key: value.key };
		let json;
		try {
			json = JSON.stringify(value.value);
		} catch {
			throw new Error("invalid-request");
		}
		if (!json || json.length > 64 * 1024) throw new Error("invalid-request");
		return { method: value.method, key: value.key, value: value.value };
	}
	if (value.method === "workbench.navigate") {
		if (typeof value.sessionId !== "string" || value.sessionId.length < 1 || value.sessionId.length > 160) throw new Error("invalid-request");
		if (value.entryId !== undefined && (typeof value.entryId !== "string" || value.entryId.length < 1 || value.entryId.length > 160 || /[\u0000-\u001f]/.test(value.entryId))) throw new Error("invalid-request");
		return { method: value.method, sessionId: value.sessionId, entryId: value.entryId === undefined ? undefined : value.entryId };
	}
	if (value.method === "storage.keys") return { method: value.method };
	if (value.method === "storage.delete") {
		if (typeof value.key !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(value.key)) throw new Error("invalid-request");
		return { method: value.method, key: value.key };
	}
	if (value.method === "workbench.openExternal") {
		// 外部链接只允许无凭据的 https 地址：http/file/自定义协议一律拒，开浏览器是这条 API 的全部权限。
		if (typeof value.url !== "string" || value.url.length > 2048 || /[\u0000-\u001f]/.test(value.url)) throw new Error("invalid-request");
		let parsed: URL;
		try {
			parsed = new URL(value.url);
		} catch {
			throw new Error("invalid-request");
		}
		if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) throw new Error("invalid-request");
		return { method: value.method, url: parsed.toString() };
	}
	throw new Error("unsupported-method");
}
