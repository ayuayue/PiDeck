import { useEffect, useRef, useState, type RefObject } from "react";
import type { HostPluginBounds, HostPluginContext } from "../../../../shared/types/hostPlugin";
import { desktopApi } from "../../desktopApi";

const TOKEN_NAMES = ["--color-bg-app", "--color-bg-panel", "--color-bg-input", "--color-text-primary", "--color-text-secondary", "--color-border-default", "--color-accent", "--color-text-inverse"];

/** Measure only the allocated native surface; plugin content never enters the React DOM. */
function surfaceInput(element: HTMLElement, scope: { projectId?: string; sessionId?: string }): { context: HostPluginContext; bounds: HostPluginBounds; visible: boolean } {
	const root = document.documentElement;
	const style = getComputedStyle(root);
	const tokens = Object.fromEntries(TOKEN_NAMES.map((name) => [name, style.getPropertyValue(name).trim()]).filter(([, value]) => value));
	const rect = element.getBoundingClientRect();
	return {
		context: { ...scope, locale: root.lang.startsWith("zh") ? "zh-CN" : "en-US", theme: root.dataset.theme === "light" ? "light" : "dark", tokens },
		bounds: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(0, rect.width), height: Math.max(0, rect.height) },
		visible: document.visibilityState !== "hidden" && rect.width > 0 && rect.height > 0,
	};
}

/** Pairs native view lifetime with the panel, rejecting late mounts after close/switch/StrictMode cleanup. */
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
		let frame = 0;
		let mountTimer = 0;
		setLoading(true);
		setError(undefined);
		const fail = (code: string) => {
			if (!disposed) {
				setError(code);
				setLoading(false);
			}
		};
		const update = () => {
			if (disposed || !instanceId) return;
			const input = surfaceInput(target, scope.current);
			void desktopApi.hostPlugins
				.update(instanceId, input.context, input.bounds, input.visible)
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
		const resize = new ResizeObserver(schedule);
		resize.observe(target);
		const appearance = new MutationObserver(schedule);
		appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "data-appearance", "data-accent", "lang"] });
		window.addEventListener("resize", schedule);
		document.addEventListener("visibilitychange", schedule);
		// Native views cannot follow a CSS transform animation. Mount after the host dialog settles.
		mountTimer = window.setTimeout(() => {
			const input = surfaceInput(target, scope.current);
			void desktopApi.hostPlugins
				.mount({ pluginId, panelId, context: input.context, bounds: input.bounds })
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
					setLoading(false);
					schedule();
				})
				.catch(() => fail("plugin-host-unavailable"));
		}, 250);
		return () => {
			disposed = true;
			synchronize.current = undefined;
			clearTimeout(mountTimer);
			cancelAnimationFrame(frame);
			resize.disconnect();
			appearance.disconnect();
			window.removeEventListener("resize", schedule);
			document.removeEventListener("visibilitychange", schedule);
			if (instanceId) void desktopApi.hostPlugins.unmount(instanceId).catch(() => undefined);
		};
	}, [element, pluginId, panelId]);
	useEffect(() => synchronize.current?.(), [projectId, sessionId]);
	return { error, loading };
}
