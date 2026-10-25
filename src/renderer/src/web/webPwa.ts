/**
 * Web 端 PWA 支持（第二批）：
 * - Service Worker 注册（public/sw.js；SW 只缓存静态 GET，不碰 /api/* 与 SSE）；
 * - beforeinstallprompt 捕获 + 手动安装入口（浏览器自动横幅之外的稳定触发点）；
 * - standalone 检测（已安装的 PWA 中隐藏安装按钮）。
 */
import { useCallback, useEffect, useState } from "react";

type InstallPromptEvent = Event & {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function registerWebServiceWorker(): void {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
	window.addEventListener("load", () => {
		navigator.serviceWorker.register("/sw.js").catch(() => {
			// SW 失败不影响页面功能（缓存只是增强），静默降级
		});
	});
}

export function usePwaInstall(): { canInstall: boolean; installed: boolean; install: () => Promise<boolean> } {
	const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null);
	const [installed, setInstalled] = useState(false);

	useEffect(() => {
		const media = window.matchMedia("(display-mode: standalone)");
		const sync = () => setInstalled(media.matches || (navigator as { standalone?: boolean }).standalone === true);
		sync();
		media.addEventListener("change", sync);
		const onPrompt = (event: Event) => {
			event.preventDefault(); // 拦截浏览器自动横幅，改由头部按钮手动触发
			setPromptEvent(event as InstallPromptEvent);
		};
		const onInstalled = () => {
			setInstalled(true);
			setPromptEvent(null);
		};
		window.addEventListener("beforeinstallprompt", onPrompt);
		window.addEventListener("appinstalled", onInstalled);
		return () => {
			media.removeEventListener("change", sync);
			window.removeEventListener("beforeinstallprompt", onPrompt);
			window.removeEventListener("appinstalled", onInstalled);
		};
	}, []);

	const install = useCallback(async () => {
		if (!promptEvent) return false;
		await promptEvent.prompt();
		const choice = await promptEvent.userChoice;
		if (choice.outcome === "accepted") setPromptEvent(null);
		return choice.outcome === "accepted";
	}, [promptEvent]);

	return { canInstall: promptEvent !== null && !installed, installed, install };
}
