import { useEffect, useRef, useState, type RefObject } from "react";
import type { HostPluginContext } from "../../../../shared/types/hostPlugin";
import { desktopApi } from "../../desktopApi";

const TOKEN_NAMES = ["--color-bg-app", "--color-bg-panel", "--color-bg-input", "--color-text-primary", "--color-text-secondary", "--color-border-default", "--color-accent", "--color-text-inverse"];

/** 创建型 API 需要的额外属性：全局 WebviewElement（types.d.ts）只声明了方法面。 */
type CreatableWebview = WebviewElement & { src: string; partition: string };

/** 插件面板是页面内 <webview>（与内置浏览器同层叠模型，可被弹层正常覆盖），布局跟随 DOM 天然同步。 */
function contextInput(scope: { projectId?: string; sessionId?: string }): HostPluginContext {
	const root = document.documentElement;
	const style = getComputedStyle(root);
	const tokens = Object.fromEntries(TOKEN_NAMES.map((name) => [name, style.getPropertyValue(name).trim()]).filter(([, value]) => value));
	return { ...scope, locale: root.lang.startsWith("zh") ? "zh-CN" : "en-US", theme: root.dataset.theme === "light" ? "light" : "dark", tokens };
}

/** Pairs guest lifetime with the panel host element, rejecting late mounts after close/switch/StrictMode cleanup. */
export function useHostPluginView(element: RefObject<HTMLDivElement | null>, pluginId: string, panelId: string, projectId?: string, sessionId?: string) {
	const scope = useRef({ projectId, sessionId });
	scope.current = { projectId, sessionId };
	const synchronize = useRef<(() => void) | undefined>(undefined);
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(true);
	useEffect(() => {
		const target = element.current;
		if (!target) return;
		let disposed = false;
		let instanceId: string | undefined;
		let guest: WebviewElement | undefined;
		let frame = 0;
		const fail = (code: string) => {
			if (!disposed) {
				setError(code);
				setLoading(false);
			}
		};
		const update = () => {
			if (disposed || !instanceId) return;
			void desktopApi.hostPlugins
				.update(instanceId, contextInput(scope.current))
				.then((result) => {
					if (!result.ok) fail(result.code);
				})
				.catch(() => fail("plugin-host-unavailable"));
		};
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(update);
		};
		synchronize.current = schedule;
		const appearance = new MutationObserver(schedule);
		appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "data-appearance", "data-accent", "lang"] });
		void desktopApi.hostPlugins
			.mount({ pluginId, panelId, context: contextInput(scope.current) })
			.then(async (result) => {
				if (!result.ok) {
					fail(result.code);
					return;
				}
				if (disposed) {
					await desktopApi.hostPlugins.unmount(result.value.instanceId);
					return;
				}
				instanceId = result.value.instanceId;
				// 必须先 mount 成功再创建 webview：窗口 attach 策略只放行指向活实例的 host-plugin:<id> partition。
				const view = document.createElement("webview") as CreatableWebview;
				view.src = result.value.entryUrl;
				view.partition = `host-plugin:${instanceId}`;
				view.className = "h-full w-full";
				view.addEventListener("dom-ready", () => {
					if (!disposed) setLoading(false);
				});
				view.addEventListener("did-fail-load", () => fail("plugin-load-failed"));
				view.addEventListener("destroyed", () => {
					if (!disposed) fail("plugin-load-failed");
				});
				guest = view;
				target.appendChild(view);
			})
			.catch(() => fail("plugin-host-unavailable"));
		return () => {
			disposed = true;
			synchronize.current = undefined;
			cancelAnimationFrame(frame);
			appearance.disconnect();
			guest?.remove();
			if (instanceId) void desktopApi.hostPlugins.unmount(instanceId).catch(() => undefined);
		};
	}, [element, pluginId, panelId]);
	useEffect(() => synchronize.current?.(), [projectId, sessionId]);
	return { error, loading };
}
