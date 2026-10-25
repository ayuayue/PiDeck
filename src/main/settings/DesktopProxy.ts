import { app, session } from "electron";
import type { AppSettings } from "../../shared/types";
import { getAppLogger } from "../logging/sharedLogger";

type DesktopProxySettings = Pick<AppSettings, "desktopProxyEnabled" | "desktopProxyUrl" | "desktopProxyBypass">;

export async function applyDesktopProxy(settings: DesktopProxySettings) {
	const config = buildDesktopProxyConfig(settings);
	try {
		await session.defaultSession.setProxy(config);
		await app.setProxy(config);
		// 桌面代理属全局网络配置：只记 mode，不记 proxyRules（URL 可能内嵌凭据）
		void getAppLogger()?.info("settings", "Desktop proxy applied", { mode: config.mode });
	} catch (error) {
		void getAppLogger()?.error("settings", "Desktop proxy apply failed", {
			mode: config.mode,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

/**
 * 组装 Electron 代理配置。
 *
 * 关键业务规则（2026-09 修复「第三方中转站拉不到模型」）：
 * 桌面代理开关关闭时**不能**显式下发 `direct`。
 * - `direct` 是「强制绕过一切代理」，会连同用户操作系统/企业环境里已配置的代理一起屏蔽；
 *   实测本机 (a) 直连 anyrouter.top 触发 `net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH`（TLS 被中间设备干扰），
 *       (b) 直连 agentrouter.org 直接 `ERR_CONNECTION_TIMED_OUT` —— 两者经代理均可建立连接。
 * - 而 Chromium 的 `system` 模式（= Electron 默认值）表示「沿用系统代理设置」，语义是
 *   「PiDeck 不表态」，用户环境本来能通的站就不会被我们弄不通。
 * 因此关闭开关 = 交还系统决定，而不是主动切断网络出口。
 *
 * 导出供单测（tests/desktopProxyFallback.test.mjs）验证「关闭开关 == system」。
 */
export function buildDesktopProxyConfig(settings: DesktopProxySettings) {
	// 未启用：交还系统代理设置，绝不写死 direct（否则等于替用户封掉所有代理）。
	if (!settings.desktopProxyEnabled) return { mode: "system" as const };

	const proxyRules = normalizeProxyRules(settings.desktopProxyUrl);
	// 开关打开但地址非法：同样退回 system，而不是退化成 direct（同一条理由）。
	if (!proxyRules) return { mode: "system" as const };

	return {
		mode: "fixed_servers" as const,
		proxyRules,
		proxyBypassRules: normalizeBypassRules(settings.desktopProxyBypass),
	};
}

function normalizeProxyRules(value: string) {
	const trimmed = value.trim();
	if (!trimmed) return "";
	const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

	try {
		const url = new URL(normalized);
		if (!url.hostname) return "";
		return url.href.replace(/\/$/, "");
	} catch {
		return "";
	}
}

function normalizeBypassRules(value: string) {
	return value
		.split(/[,\n;]/)
		.map((item) => item.trim())
		.filter(Boolean)
		.join(";");
}
