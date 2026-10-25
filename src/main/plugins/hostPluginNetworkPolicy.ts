/** Network declarations and request shapes fail closed; browser networking stays disabled. */
import { isIP } from "node:net";
import type { HostPluginNetworkPolicy, HostPluginNetworkRequest, HostPluginPermission } from "../../shared/types/hostPlugin";

export const HOST_PLUGIN_NETWORK_BODY_BYTES = 256 * 1024;
export const HOST_PLUGIN_NETWORK_RESPONSE_BYTES = 1024 * 1024;
export const HOST_PLUGIN_NETWORK_HEADER_BYTES = 16 * 1024;
export const HOST_PLUGIN_NETWORK_TIMEOUT_MS = 15_000;
export const HOST_PLUGIN_NETWORK_MAX_TIMEOUT_MS = 30_000;
export const HOST_PLUGIN_NETWORK_REDIRECTS = 3;

/** Conservative public-unicast policy: mapped, translated, tunnel and special-use IPs are not HTTPS destinations. */
export function isPublicPluginAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const [a, b, c] = address.split(".").map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
			(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
			(a === 203 && b === 0 && c === 113)
		);
	}
	if (isIP(address) !== 6 || address.includes("%")) return false;
	const [left, right = ""] = address.split("::");
	const first = left ? left.split(":") : [];
	const last = right ? right.split(":") : [];
	const parts = [...first, ...Array(Math.max(0, 8 - first.length - last.length)).fill("0"), ...last].map((part) => Number.parseInt(part, 16));
	const [a, b] = parts;
	return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && a !== 0x3fff && !(a === 0x2001 && (b <= 0x01ff || b === 0x0db8));
}

/** WHATWG normalizes shorthand IPv4; local grants intentionally accept only the literal, explicit-port spelling. */
export function parseHostPluginNetworkUrl(value: unknown): URL {
	if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[\s\u0000-\u001f\u007f\\]/.test(value)) throw new Error("invalid-network-request");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("invalid-network-request");
	}
	if (url.username || url.password || value.includes("#") || !url.hostname) throw new Error("invalid-network-request");
	if (url.protocol === "https:") return url;
	const local = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?:[/?]|$)/.exec(value);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !local || Number(local[1]) > 65535) throw new Error("invalid-network-request");
	return url;
}

/** Manifest and scaffold share this parser, so generated declarations cannot silently exceed consent. */
export function parseHostPluginNetworkPolicy(value: unknown, permissions: HostPluginPermission[]): HostPluginNetworkPolicy | undefined {
	const https = permissions.includes("network.https");
	const local = permissions.includes("network.local");
	if (value === undefined && !https && !local) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid-network");
	const fields = Object.entries(value);
	if (fields.some(([key]) => key !== "httpsOrigins" && key !== "localPorts")) throw new Error("invalid-network");
	const origins: unknown = fields.find(([key]) => key === "httpsOrigins")?.[1];
	const ports: unknown = fields.find(([key]) => key === "localPorts")?.[1];
	if ((origins !== undefined && !https) || (ports !== undefined && !local) || (!https && !local)) throw new Error("invalid-network");
	const policy: HostPluginNetworkPolicy = {};
	if (https) {
		if (!Array.isArray(origins) || origins.length < 1 || origins.length > 16) throw new Error("invalid-network");
		policy.httpsOrigins = origins.map((origin: unknown) => {
			let url: URL;
			try {
				url = parseHostPluginNetworkUrl(origin);
			} catch {
				throw new Error("invalid-network");
			}
			const hostname = url.hostname.replace(/^\[|\]$/g, "");
			if (url.protocol !== "https:" || url.pathname !== "/" || (typeof origin === "string" && /[?#*]/.test(origin)) || !/^[a-z0-9.:[\]-]+$/i.test(url.hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || (isIP(hostname) !== 0 && !isPublicPluginAddress(hostname)))
				throw new Error("invalid-network");
			return url.origin;
		});
		if (new Set(policy.httpsOrigins).size !== policy.httpsOrigins.length) throw new Error("invalid-network");
	}
	if (local) {
		if (!Array.isArray(ports) || ports.length < 1 || ports.length > 16 || !ports.every((port: unknown) => typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Error("invalid-network");
		policy.localPorts = ports.filter((port: unknown): port is number => typeof port === "number");
		if (new Set(policy.localPorts).size !== policy.localPorts.length) throw new Error("invalid-network");
	}
	return policy;
}

const BLOCKED_HEADERS = new Set(["cookie", "cookie2", "set-cookie", "host", "origin", "referer", "connection", "content-length", "transfer-encoding", "accept-encoding", "content-encoding", "expect", "upgrade", "te", "trailer", "keep-alive", "forwarded", "via"]);

/** Rebuild rather than forward arbitrary IPC objects, especially credentials and HTTP framing headers. */
export function parseHostPluginNetworkRequest(value: unknown): HostPluginNetworkRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid-network-request");
	const fields = new Map<string, unknown>(Object.entries(value));
	const rawUrl = fields.get("url");
	const url = parseHostPluginNetworkUrl(rawUrl);
	const method = fields.get("method") ?? "GET";
	const body = fields.get("body");
	const timeoutMs = fields.get("timeoutMs") ?? HOST_PLUGIN_NETWORK_TIMEOUT_MS;
	if (method !== "GET" && method !== "POST") throw new Error("invalid-network-request");
	if (body !== undefined && (method !== "POST" || typeof body !== "string" || Buffer.byteLength(body, "utf8") > HOST_PLUGIN_NETWORK_BODY_BYTES)) throw new Error("invalid-network-request");
	if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HOST_PLUGIN_NETWORK_MAX_TIMEOUT_MS) throw new Error("invalid-network-request");
	const rawHeaders = fields.get("headers");
	const headers = new Map<string, string>();
	let headerBytes = 0;
	if (rawHeaders !== undefined) {
		if (typeof rawHeaders !== "object" || rawHeaders === null || Array.isArray(rawHeaders)) throw new Error("invalid-network-request");
		const entries = Object.entries(rawHeaders);
		if (entries.length > 32) throw new Error("invalid-network-request");
		for (const [name, content] of entries) {
			const key = name.toLowerCase();
			if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) || BLOCKED_HEADERS.has(key) || /^(?:proxy-|sec-|x-forwarded-)/.test(key) || headers.has(key) || typeof content !== "string" || /[^\x20-\x7e]/.test(content)) throw new Error("invalid-network-request");
			headerBytes += Buffer.byteLength(name) + Buffer.byteLength(content) + 4;
			if (headerBytes > HOST_PLUGIN_NETWORK_HEADER_BYTES) throw new Error("invalid-network-request");
			headers.set(key, content);
		}
	}
	// Keep the explicit :80 spelling for local HTTP, which URL.toString() otherwise erases.
	return { url: url.protocol === "http:" && typeof rawUrl === "string" ? rawUrl : url.toString(), method, headers: Object.fromEntries(headers), body: typeof body === "string" ? body : undefined, timeoutMs };
}
