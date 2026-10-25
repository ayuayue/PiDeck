/**
 * Web 服务访问 URL 拼接工具：处理 IPv6 方括号、token URL 编码与通配绑定回退。
 */
import type { WebNetworkAddress } from "../../../../../shared/types";

/** 只展示运行中监听地址覆盖的网卡；枚举到 IPv6 并不表示 IPv4 listener 可接收它。 */
export function webAddressesForBinding(addresses: WebNetworkAddress[], host: string): WebNetworkAddress[] {
	const binding = host.trim().replace(/^\[|\]$/g, "");
	if (binding === "::") return addresses;
	if (binding === "0.0.0.0") return addresses.filter((item) => item.family === "IPv4");
	return addresses.filter((item) => item.address === binding);
}

export function bracketIpv6Host(host: string): string {
	if (host.includes(":") && !host.startsWith("[")) {
		return `[${host}]`;
	}
	return host;
}

export function buildWebAccessUrl(host: string, port: number, token: string, requiresAuth: boolean): string {
	const displayHost = bracketIpv6Host(host);
	let url = `http://${displayHost}:${port}`;
	if (requiresAuth && token) {
		url += `?token=${encodeURIComponent(token)}`;
	}
	return url;
}

export function previewHostFromBinding(host: string): string {
	if (host === "0.0.0.0" || host === "::") {
		return "127.0.0.1";
	}
	return host;
}

/** 给已成形的绝对 URL（隧道/serve 入口）追加 token 查询参数；未开鉴权时原样返回。 */
export function appendTokenToUrl(url: string, token: string, requiresAuth: boolean): string {
	if (!url || !requiresAuth || !token) return url;
	return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}
