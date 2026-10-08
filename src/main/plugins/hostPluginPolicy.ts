/** Pure policy shared by the view host and broker; failures never fall back to a broader capability. */
import type { HostPluginBounds, HostPluginContext, HostPluginRequest } from "../../shared/types/hostPlugin";
import { isHostPluginAsset, isPluginRecord } from "./hostPluginManifest";

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
	for (const key of ["projectId", "sessionId"]) if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 160 || /[\u0000-\u001f]/.test(value[key]))) throw new Error("invalid-context");
	const tokens: Record<string, string> = {};
	if (value.tokens !== undefined) {
		if (!isPluginRecord(value.tokens) || Object.keys(value.tokens).length > 40) throw new Error("invalid-context");
		for (const [key, token] of Object.entries(value.tokens)) {
			if (!/^--[a-z-]{1,60}$/.test(key) || typeof token !== "string" || token.length > 160 || /[;{}<>\u0000-\u001f]/.test(token)) throw new Error("invalid-context");
			tokens[key] = token;
		}
	}
	return { projectId: typeof value.projectId === "string" ? value.projectId : undefined, sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined, locale: value.locale === "en-US" ? "en-US" : "zh-CN", theme: value.theme === "light" ? "light" : "dark", tokens };
}

export function parsePluginBounds(value: unknown): HostPluginBounds {
	if (!isPluginRecord(value)) throw new Error("invalid-bounds");
	for (const key of ["x", "y", "width", "height"]) if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 20_000) throw new Error("invalid-bounds");
	if (typeof value.x !== "number" || typeof value.y !== "number" || typeof value.width !== "number" || typeof value.height !== "number") throw new Error("invalid-bounds");
	return { x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height) };
}

export function parsePluginRequest(value: unknown): HostPluginRequest {
	if (!isPluginRecord(value)) throw new Error("invalid-request");
	if (value.method === "context.get") return { method: value.method };
	if (value.method === "sessions.list") {
		if (value.offset !== undefined && (typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 100_000)) throw new Error("invalid-request");
		return { method: value.method, offset: typeof value.offset === "number" ? value.offset : undefined };
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
	throw new Error("unsupported-method");
}
