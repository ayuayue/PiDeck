import { useCallback, useEffect, useReducer, useRef } from "react";
import { REMOTE_CONFIG_CODES, remotePiConfigCodeFromError, type PiConfigFileKey } from "../../../shared/piConfig";
import { desktopApi } from "../desktopApi";
import { initialRemoteConfigPanelState, parseMergePatchText, readRemoteConfigSnapshot, readRemoteConfigWriteReceipt, reduceRemoteConfigPanel, remoteConfigCanSave, remoteConfigPatchDirty } from "./remoteConfigModel";
import { remoteHostTone } from "./remoteHostConnectionModel";
import { useRemoteHostConnection } from "./useRemoteHostConnection";

/**
 * Owner of the remote config panel state (Batch B). Views only render state and forward events; every read and
 * write goes through an injectable port so tests can drive the state machine without Electron.
 *
 * Invariants kept here (not in the view):
 * - reads are generation-guarded: a late answer for an old host/file is ignored;
 * - a write always carries the version of the snapshot currently displayed, never a guessed/stale one;
 * - after a successful patch the panel re-reads to show the sanitized result of what actually landed;
 * - RESULT_UNCONFIRMED is terminal for this draft: only an explicit reload may continue;
 * - every read is preceded by “ensure this host is connected”: a selected ssh target is expected to be usable,
 *   not to answer REMOTE_CONFIG_HOST_NOT_READY (the automatic connect + its animation live in the renderer
 *   connection store, shared with the target selector); a host that drops between ensure and read is
 *   reconnected and read exactly once more, never retried in a loop.
 */

export type RemoteConfigPanelPorts = {
	read: (input: { hostId: string; file: PiConfigFileKey }) => Promise<unknown>;
	save: (input: { hostId: string; file: PiConfigFileKey; expectedVersion: string; patch: Record<string, unknown> }) => Promise<unknown>;
};

/** Production ports: the four existing config methods, now accepting the shared target options (no new channels). */
export const remoteConfigDesktopPorts: RemoteConfigPanelPorts = {
	read: ({ hostId, file }) => {
		const target = { kind: "ssh" as const, hostId };
		return file === "models" ? desktopApi.config.getModels({ target }) : desktopApi.config.getSettings({ target });
	},
	save: ({ hostId, file, expectedVersion, patch }) => {
		const options = { target: { kind: "ssh" as const, hostId }, expectedVersion, patch };
		// The legacy body argument is ignored on the ssh route (main routes before ConfigManager); it exists only
		// because Batch A kept the four channel signatures. Sending an empty artifact shape is deliberate: if the
		// remote route were ever absent, main fails closed instead of writing this body to the local file.
		return file === "models" ? desktopApi.config.saveModels({ providers: {} }, options) : desktopApi.config.saveSettings({}, options);
	},
};

export type RemoteConfigSaveOutcome = "saved" | "conflict" | "unconfirmed" | "failed" | "unsupported" | "blocked" | "invalid-patch";

function codeOf(error: unknown): string {
	return remotePiConfigCodeFromError(error) ?? REMOTE_CONFIG_CODES.unavailable;
}

export function useRemotePiConfigPanel(input: { hostId: string; file: PiConfigFileKey; ports?: RemoteConfigPanelPorts; onDirtyChange?: (dirty: boolean) => void }) {
	const { hostId, file, onDirtyChange } = input;
	const ports = input.ports ?? remoteConfigDesktopPorts;
	const { snapshot: hostConnections, ensureConnected } = useRemoteHostConnection();
	const [state, dispatch] = useReducer(reduceRemoteConfigPanel, initialRemoteConfigPanelState);
	const generation = useRef(0);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			generation.current += 1;
		};
	}, []);

	const readOnce = useCallback(
		async (request: number): Promise<void> => {
			const response = await ports.read({ hostId, file });
			if (!mounted.current || request !== generation.current) return;
			const snapshot = readRemoteConfigSnapshot(response, { hostId, file });
			if (snapshot === "unsupported") dispatch({ type: "unsupported" });
			else if (snapshot === "invalid") dispatch({ type: "loadFailed", code: REMOTE_CONFIG_CODES.fileInvalid });
			else dispatch({ type: "loaded", snapshot });
		},
		[hostId, file, ports],
	);

	const load = useCallback(async () => {
		const request = generation.current + 1;
		generation.current = request;
		dispatch({ type: "reloadStarted" });
		// 先确保主机在线（已在线时是一次本地判断，不发 IPC）：用户选中 ssh 目标后看到的是「正在连接」，
		// 不是一条要求他自己去主机列表点连接的报错。
		const ready = await ensureConnected(hostId);
		if (!mounted.current || request !== generation.current) return;
		if (!ready.ok) {
			dispatch({ type: "loadFailed", code: REMOTE_CONFIG_CODES.hostNotReady });
			return;
		}
		try {
			await readOnce(request);
		} catch (error) {
			if (!mounted.current || request !== generation.current) return;
			const code = codeOf(error);
			if (code !== REMOTE_CONFIG_CODES.hostNotReady) {
				dispatch({ type: "loadFailed", code });
				return;
			}
			// 主机恰好在「确保在线」和读取之间掉了：重连一次、再读一次。仍失败就交回用户重试，
			// 不在这里循环重连（写操作有自己的「未确认」语义，读也不该假装无限可用）。
			const reconnected = await ensureConnected(hostId);
			if (!mounted.current || request !== generation.current) return;
			if (!reconnected.ok) {
				dispatch({ type: "loadFailed", code: REMOTE_CONFIG_CODES.hostNotReady });
				return;
			}
			try {
				await readOnce(request);
			} catch (second) {
				if (!mounted.current || request !== generation.current) return;
				dispatch({ type: "loadFailed", code: codeOf(second) });
			}
		}
	}, [hostId, ensureConnected, readOnce]);

	useEffect(() => {
		void load();
	}, [load]);

	const reload = useCallback(() => {
		void load();
	}, [load]);

	const setPatchText = useCallback((text: string) => dispatch({ type: "patchChanged", text }), []);
	const resetPatch = useCallback(() => dispatch({ type: "resetPatch" }), []);

	const save = useCallback(async (): Promise<RemoteConfigSaveOutcome> => {
		if (!remoteConfigCanSave(state) || state.snapshot === undefined) return "blocked";
		const parsed = parseMergePatchText(state.patchText);
		if (!parsed.ok) return "invalid-patch";
		dispatch({ type: "saveStarted" });
		// 写入前也只确保一次连接（不是重试）：连不上就不发写请求，避免把「断线」变成「结果未确认」。
		const ready = await ensureConnected(hostId);
		if (!mounted.current) return "blocked";
		if (!ready.ok) {
			dispatch({ type: "saveFailed", code: REMOTE_CONFIG_CODES.hostNotReady });
			return "failed";
		}
		try {
			const response = await ports.save({ hostId, file, expectedVersion: state.snapshot.version, patch: parsed.patch });
			if (!mounted.current) return "blocked";
			const receipt = readRemoteConfigWriteReceipt(response);
			if (receipt === "unsupported") {
				dispatch({ type: "saveFailed", code: REMOTE_CONFIG_CODES.unsupported });
				return "unsupported";
			}
			if (receipt === "invalid") {
				dispatch({ type: "saveFailed", code: REMOTE_CONFIG_CODES.fileInvalid });
				return "failed";
			}
			dispatch({ type: "saved" });
			// Re-read so the pane shows the sanitized bytes that actually landed, not a guessed local merge.
			void load();
			return "saved";
		} catch (error) {
			if (!mounted.current) return "blocked";
			const code = codeOf(error);
			if (code === REMOTE_CONFIG_CODES.versionConflict) dispatch({ type: "conflict", code });
			else if (code === REMOTE_CONFIG_CODES.resultUnconfirmed) dispatch({ type: "unconfirmed", code });
			else dispatch({ type: "saveFailed", code });
			return code === REMOTE_CONFIG_CODES.versionConflict ? "conflict" : code === REMOTE_CONFIG_CODES.resultUnconfirmed ? "unconfirmed" : "failed";
		}
	}, [hostId, file, ports, state, load, ensureConnected]);

	// 连接状态来自共享 store：面板据此画「正在连接」，并在「别处（目标条密码框/设置页）把主机连上」
	// 之后自动重读一次——用户刚补完密码，不该再点一下「重新读取」才看到内容。
	const connectionTone = remoteHostTone(hostConnections, hostId);
	const connectCode = hostConnections.errors[hostId];
	const previousTone = useRef(connectionTone);
	useEffect(() => {
		const previous = previousTone.current;
		previousTone.current = connectionTone;
		if (previous === "online" || connectionTone !== "online") return;
		if (state.phase !== "failed" || state.code !== REMOTE_CONFIG_CODES.hostNotReady) return;
		void load();
	}, [connectionTone, state.phase, state.code, load]);

	const dirty = remoteConfigPatchDirty(state.patchText);
	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);
	useEffect(
		() => () => {
			onDirtyChange?.(false);
		},
		[onDirtyChange],
	);

	return { state, dirty, reload, save, setPatchText, resetPatch, connectionTone, connectCode };
}
