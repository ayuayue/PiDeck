import { useEffect, useEffectEvent } from "react";
import { useStore } from "jotai";
import { activeWorkspacePageAtom, currentSessionIdAtom, sessionRuntimeByIdAtom, settingsDirtyForWindowCloseAtom } from "../atoms";
import { sessionDraftByIdAtom, sessionSendStateByIdAtom } from "../atoms/composer-atoms";
import { toSessionRuntimeTarget } from "../utils/sessionCommands";
import { isSessionRuntimeBusy } from "./session/timeline/timelineSurfacePolicy";
import { CLOSE_CONFIRMATION, CLOSE_LAYER, CLOSE_SCOPE, createCloseShortcutGate, localCloseActions, resolveCloseScope } from "../utils/closeShortcut";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import type { useOverlayActions } from "./useOverlayActions";

type CloseOverlays = Pick<ReturnType<typeof useOverlayActions>, "showConfirm" | "clearConfirm" | "confirmDialog" | "trustRequest">;

export function closeEditorWithConfirmation(tab: { id: string; label?: string; filePath: string } | undefined, isDirty: (id: string) => boolean, close: (id: string) => void, overlays: CloseOverlays) {
	if (!tab) return;
	const scope = document.activeElement?.closest(CLOSE_SCOPE);
	const closeFile = () => {
		close(tab.id);
		focusRemainingTab(scope);
	};
	if (!isDirty(tab.id)) {
		closeFile();
		return;
	}
	overlays.showConfirm({
		title: t("editor.dirtyCloseTitle"),
		message: t("editor.dirtyCloseMessage", { file: tab.label ?? tab.filePath.split(/[/\\]/).pop() ?? tab.id }),
		confirmLabel: t("config.discardChanges"),
		danger: true,
		onConfirm: () => {
			overlays.clearConfirm();
			closeFile();
		},
	});
}

interface CloseWorkspaceShortcutDeps {
	closeTab: (sessionId: string) => void;
	abortAgent: (agentId: string) => Promise<void>;
	sessionTabIds: readonly string[];
	pageTabs: readonly { id: string; onClose: () => void }[];
	closeEditor: (id: string) => void;
	activeEditorId?: string;
	pluginClose?: () => void;
	dirtyEditorCount: number;
	overlays: CloseOverlays;
	showToast: (message: string) => void;
}

/** Keep focus in the workbench when the focused tab or its page is removed. */
function focusRemainingTab(closedScope?: Element | null) {
	requestAnimationFrame(() => {
		const active = document.activeElement;
		if ((active !== document.body && !closedScope?.contains(active)) || document.querySelector(CLOSE_CONFIRMATION)) return;
		const tabs = Array.from(document.querySelectorAll<HTMLElement>('.session-tabs-scroll [role="tab"][aria-selected="true"], .simple-file-tabs [role="tab"][aria-selected="true"]'));
		const next = tabs.find((tab) => !closedScope?.contains(tab) && tab.getClientRects().length > 0) ?? document.querySelector<HTMLElement>(".workbench-stage [data-close-focus-fallback]");
		next?.focus({ preventScroll: true });
	});
}

function isBusy(runtime: { status?: string; state?: Parameters<typeof isSessionRuntimeBusy>[1] } | undefined, sending: string | undefined) {
	return sending === "activating" || sending === "sending" || isSessionRuntimeBusy(runtime?.status, runtime?.state);
}

/** The configured Electron shortcut is a single dispatch to the nearest focused close scope. */
export function useCloseSessionTabShortcut(deps: CloseWorkspaceShortcutDeps) {
	const store = useStore();
	const reportFailure = useEffectEvent(() => deps.showToast(t("tabs.closeShortcutFailed")));
	const finishWindowClose = useEffectEvent((terminalCount: number | null) => {
		const { overlays } = deps;
		if (overlays.confirmDialog || overlays.trustRequest || document.querySelector(`${CLOSE_CONFIRMATION}, ${CLOSE_LAYER}`)) return;
		const minimize = () => void desktopApi.app.minimizeWindow().catch(() => deps.showToast(t("tabs.minimizeFailed")));
		const runtimes = store.get(sessionRuntimeByIdAtom);
		const sendState = store.get(sessionSendStateByIdAtom);
		const sessionCount = [...new Set([...Object.keys(runtimes), ...Object.keys(sendState)])].filter((id) => isBusy(runtimes[id], sendState[id]?.status)).length;
		const draftCount = Object.values(store.get(sessionDraftByIdAtom)).filter(Boolean).length;
		const dirtySettings = store.get(settingsDirtyForWindowCloseAtom);
		const summary = [
			deps.dirtyEditorCount > 0 && t("tabs.minimizeDirtyFiles", { count: deps.dirtyEditorCount }),
			dirtySettings && t("tabs.minimizeDirtySettings"),
			draftCount > 0 && t("tabs.minimizeDrafts", { count: draftCount }),
			sessionCount > 0 && t("tabs.minimizeRunningSessions", { count: sessionCount }),
			terminalCount === null ? t("tabs.minimizeUnknownTerminals") : terminalCount > 0 && t("tabs.minimizeTerminals", { count: terminalCount }),
		].filter(Boolean);
		if (!summary.length) {
			minimize();
			return;
		}
		overlays.showConfirm({
			title: t("tabs.minimizeTitle"),
			message: `${summary.join(" ")} ${t("tabs.minimizePreserve")}`,
			confirmLabel: t("tabs.minimizeConfirm"),
			onConfirm: () => {
				overlays.clearConfirm();
				minimize();
			},
		});
	});
	const closeFocused = useEffectEvent(async (scope: Element | null) => {
		const { overlays } = deps;
		if (overlays.confirmDialog || overlays.trustRequest || document.querySelector(CLOSE_CONFIRMATION)) return;
		if (document.querySelector(CLOSE_LAYER)) {
			// Radix owns dismissal and focus restoration for menus, popovers and non-confirmation dialogs.
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			return;
		}
		const id = scope?.getAttribute("data-close-id") ?? undefined;
		switch (scope?.getAttribute("data-close-scope")) {
			case "local-tab":
			case "local": {
				const owner = scope.closest('[data-close-scope="local"]');
				if (owner) await localCloseActions.get(owner)?.(id);
				return;
			}
			case "panel": {
				const actions = scope.querySelectorAll<HTMLButtonElement>("[data-close-action]");
				// A panel's close control cannot belong to a child scope (e.g. a browser tab inside a drawer).
				Array.from(actions)
					.find((button) => button.closest(CLOSE_SCOPE) === scope)
					?.click();
				return;
			}
			case "plugin":
				deps.pluginClose?.();
				focusRemainingTab(scope);
				return;
			case "editor": {
				const editorId = id ?? deps.activeEditorId;
				if (editorId) deps.closeEditor(editorId);
				return;
			}
			case "page":
				deps.pageTabs.find((tab) => tab.id === id)?.onClose();
				focusRemainingTab(scope);
				return;
			case "session": {
				if (!id || !deps.sessionTabIds.includes(id)) return;
				const runtime = store.get(sessionRuntimeByIdAtom)[id];
				const running = isBusy(runtime, store.get(sessionSendStateByIdAtom)[id]?.status);
				const draft = Boolean(store.get(sessionDraftByIdAtom)[id]);
				const close = () => {
					deps.closeTab(id);
					focusRemainingTab(scope);
				};
				if (!running && !draft) {
					close();
					return;
				}
				overlays.showConfirm({
					title: t(running ? "tabs.closeRunningTitle" : "tabs.closeDraftTitle"),
					message: [running && t("tabs.closeRunningBody"), draft && t("tabs.closeDraftBody")].filter(Boolean).join(" "),
					confirmLabel: t(running ? "tabs.closeRunningConfirm" : "common.close"),
					danger: running,
					onConfirm: () => {
						overlays.clearConfirm();
						const liveRuntime = store.get(sessionRuntimeByIdAtom)[id];
						const sameRun = !runtime || (runtime.agentId === liveRuntime?.agentId && runtime.runtimeGeneration === liveRuntime.runtimeGeneration);
						const target = running && sameRun && toSessionRuntimeTarget(id, liveRuntime);
						if (running && !sameRun) return;
						if (target) void deps.abortAgent(target.agentId);
						close();
					},
				});
				return;
			}
		}

		finishWindowClose(await desktopApi.terminal.liveCount().catch(() => null));
	});

	useEffect(() => {
		const accept = createCloseShortcutGate();
		let pointed: Element | null = null;
		let dispatching = false;
		const rememberPointer = (event: PointerEvent) => {
			pointed = event.target instanceof Element ? event.target : null;
		};
		const clearPointer = () => {
			pointed = null;
		};
		document.addEventListener("pointerdown", rememberPointer, true);
		document.addEventListener("focusin", clearPointer, true);
		const unsubscribe = desktopApi.app.onShortcutTriggered((id) => {
			if (id !== "closeSessionTab" || !accept(performance.now()) || dispatching) return;
			const scope = resolveCloseScope(document.activeElement, pointed, document.body);
			dispatching = true;
			void closeFocused(scope)
				.catch(reportFailure)
				.finally(() => {
					dispatching = false;
				});
		});
		const unsubscribeFocus = store.sub(activeWorkspacePageAtom, () => {
			// Includes delayed Settings close after discard/save. The new page may focus itself first.
			if (store.get(activeWorkspacePageAtom) === null || !store.get(currentSessionIdAtom)) focusRemainingTab();
		});
		return () => {
			unsubscribe();
			unsubscribeFocus();
			document.removeEventListener("pointerdown", rememberPointer, true);
			document.removeEventListener("focusin", clearPointer, true);
		};
	}, [store]);
}
