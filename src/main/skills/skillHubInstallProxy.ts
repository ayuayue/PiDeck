/**
 * 技能商店安装子进程的代理环境变量（纯函数，可单测）。
 *
 * 为什么需要：`npx skills add` 内部会 `git clone https://github.com/...`，而 **git 不读 npm 的
 * 代理配置**（npm_config_proxy/https_proxy 都是 npm 自己的键），也不看 Chromium/Electron 的
 * session 代理——实测本机 git clone GitHub 直接 `Connection was reset` 失败，同一个 URL 走
 * 代理可通。主进程自己用 net.fetch 已经走桌面代理，子进程只能靠 env 传递，否则「商店能搜到、
 * 一点安装就失败」。
 *
 * 语义与 DesktopProxy.buildDesktopProxyConfig 保持一致：
 * - 桌面代理开启且地址合法 → 用固定代理；
 * - 关闭或地址非法 → 交还系统（此处解析 Electron 的系统代理解析结果）；
 * - 两者都拿不到代理 → 返回 undefined「不表态」，既不注入也不剥离继承环境里的代理键。
 */

import { NODE_USE_ENV_PROXY, PROXY_BYPASS_ENV_KEYS, PROXY_ENV_KEYS } from "../sessions/sessionProxyPolicy";

export type DesktopProxyInput = {
	enabled: boolean;
	url: string;
	bypass: string;
};

/** 桌面代理设置里的地址：允许 `127.0.0.1:7890` 这类不带协议的写法（与 DesktopProxy 同规则） */
function normalizeProxyUrl(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	try {
		const url = new URL(normalized);
		if (!url.hostname) return undefined;
		return url.href.replace(/\/$/, "");
	} catch {
		return undefined;
	}
}

/**
 * 解析 Electron `session.resolveProxy()` 的规则串，取首条可用代理。
 * 形如 `PROXY 127.0.0.1:7890` / `SOCKS5 127.0.0.1:1080` / `DIRECT`（可能多条以 `;` 分隔）。
 * 返回值可直接作为 HTTP(S)_PROXY/ALL_PROXY 的值：socks 系工具链按 `socks5://` 识别。
 */
export function parseElectronProxyRules(rules: string | null | undefined): string | undefined {
	for (const raw of (rules ?? "").split(/[;\n]/)) {
		const entry = raw.trim();
		if (!entry || /^direct$/i.test(entry)) continue;
		const match = /^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(.+)$/i.exec(entry);
		const scheme = (match?.[1] ?? "PROXY").toUpperCase();
		const host = (match?.[2] ?? entry).trim();
		if (!host) continue;
		if (scheme === "SOCKS4") return `socks4://${host}`;
		if (scheme === "SOCKS" || scheme === "SOCKS5") return `socks5://${host}`;
		return /^[a-z][a-z\d+.-]*:\/\//i.test(host) ? host : `http://${host}`;
	}
	return undefined;
}

/**
 * 组装安装子进程要注入的代理 env；返回 undefined 表示「不表态」（保持继承环境原样）。
 * 只覆盖标准代理键 + NODE_USE_ENV_PROXY（npx 里的 Node 进程是 undici，不设开关不认 env 代理）。
 */
export function buildSkillInstallProxyEnv(desktop: DesktopProxyInput, systemRules?: string | null): Record<string, string> | undefined {
	const desktopUrl = desktop.enabled ? normalizeProxyUrl(desktop.url) : undefined;
	const url = desktopUrl ?? parseElectronProxyRules(systemRules);
	if (!url) return undefined;

	const env: Record<string, string> = {};
	for (const key of PROXY_ENV_KEYS) env[key] = url;
	const bypass = desktop.enabled ? desktop.bypass.trim() : "";
	if (bypass) {
		for (const key of PROXY_BYPASS_ENV_KEYS) env[key] = bypass;
	}
	env[NODE_USE_ENV_PROXY] = "1";
	return env;
}
