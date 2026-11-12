import { useAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { idleScanStateFor, remoteSessionImportByHostAtom, remoteSessionScanByHostAtom, type RemoteSessionImportFeedback } from "../atoms/remote-sessions-atoms";
import { createRemoteSessionListController, readRegisterResponse, readScanResponse, type RemoteSessionEntryView, type RemoteSessionListState, type RemoteSessionScanOutcome } from "../components/session/remoteSessionListState";

/**
 * 远端会话列表与登记（渲染层 H2）。
 *
 * 状态机在 `remoteSessionListState`（纯函数，可离开 React 单测）；这里只做三件事：
 * 把主进程能力收窄成窄 port、按代次落地结果、在切主机/卸载时作废在途结果。
 *
 * port 的取值是**结构探测**而不是类型断言（与第二批搜索面板同一做法）：preload 未暴露
 * `remoteSessions` 时宁可报「未接线」稳定码，也不假装成功、也不崩溃；接线落地后同一调用点自然生效。
 *
 * 扫描结果按主机缓存在 Jotai atom 里：侧栏项目行会随折叠反复挂载卸载，重挂载不该丢掉已扫到的列表，
 * 也不该自动重扫（用户点刷新才重扫）。
 */

/** 未接线的稳定码：只在 preload 尚未暴露 remoteSessions 时出现。 */
export const REMOTE_SESSION_UNWIRED_CODE = "REMOTE_SESSION_UNWIRED";

export type RemoteSessionPort = {
	/** 项目级发现：同一主机上的两个项目不得看到彼此的会话（第二参数是本地项目 id）。 */
	scan: (hostId: string, projectId: string) => Promise<unknown>;
	register: (hostId: string, remoteSessionId: string) => Promise<unknown>;
};

function unwiredResult(): { ok: false; code: string } {
	return { ok: false, code: REMOTE_SESSION_UNWIRED_CODE };
}

const UNWIRED_PORT: RemoteSessionPort = { scan: async () => unwiredResult(), register: async () => unwiredResult() };

/**
 * 逐层结构收窄 `desktopApi.remoteSessions.scan/register`。
 * 用 `Reflect.get` 是为了在 api 是「未装载 preload」的抛错 Proxy 时不带断言地安全失败；任何一层不是
 * 预期函数就是「未接线」。
 */
export function createRemoteSessionPort(hostApi: unknown): RemoteSessionPort {
	try {
		if (typeof hostApi !== "object" || hostApi === null) return UNWIRED_PORT;
		const sessions: unknown = Reflect.get(hostApi, "remoteSessions");
		if (typeof sessions !== "object" || sessions === null) return UNWIRED_PORT;
		const scan: unknown = Reflect.get(sessions, "scan");
		const register: unknown = Reflect.get(sessions, "register");
		if (typeof scan !== "function" || typeof register !== "function") return UNWIRED_PORT;
		return {
			scan: (hostId, projectId) => Promise.resolve(scan.call(sessions, hostId, projectId)),
			register: (hostId, remoteSessionId) => Promise.resolve(register.call(sessions, hostId, remoteSessionId)),
		};
	} catch {
		return UNWIRED_PORT;
	}
}

export type RemoteSessionImportResult = { sessionId: string; created: boolean; remoteSessionId: string };

export type RemoteSessionsHandle = {
	state: RemoteSessionListState;
	/** 最近一次登记反馈（按主机记）：created=false 也必须能被用户看见。 */
	feedback: RemoteSessionImportFeedback | null;
	/** 正在登记的远端会话身份；null 表示没有登记在途。 */
	importingRemoteSessionId: string | null;
	/** 重新扫描当前主机（作废旧代次结果）。 */
	scan: () => Promise<void>;
	/** 登记一条远端会话；成功后通知宿主刷新并选中。 */
	importSession: (entry: RemoteSessionEntryView) => Promise<void>;
};

/**
 * 快照键：扫描是**项目级**的，同一主机上的两个项目各有一份列表结果，不能按 hostId 共用（否则项目 B
 * 会看到项目 A 的会话）。反馈仍按主机记（它只描述「刚刚那次点击」）。
 */
function scanSnapshotKey(hostId: string, projectId: string): string {
	return hostId + "::" + projectId;
}

export function useRemoteSessions(
	hostApi: unknown,
	options: {
		hostId: string;
		/** 该区块所属的本地项目：扫描只列这个项目的远端会话。 */
		projectId: string;
		/** 登记成功后的宿主动作：刷新本地会话列表并选中新会话（本 hook 不创建/不打开任何会话）。 */
		onImported: (result: RemoteSessionImportResult) => void | Promise<void>;
	},
): RemoteSessionsHandle {
	const [snapshots, setSnapshots] = useAtom(remoteSessionScanByHostAtom);
	const [feedbackByHost, setFeedbackByHost] = useAtom(remoteSessionImportByHostAtom);
	const [controller] = useState(() => createRemoteSessionListController());
	const [importingRemoteSessionId, setImportingRemoteSessionId] = useState<string | null>(null);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const snapshotsRef = useRef(snapshots);
	snapshotsRef.current = snapshots;
	const portRef = useRef<RemoteSessionPort>(createRemoteSessionPort(hostApi));
	portRef.current = createRemoteSessionPort(hostApi);
	const hostIdRef = useRef<string | null>(null);
	const scopeKeyRef = useRef<string | null>(null);

	// 切主机/切项目：作废在途扫描，并恢复该主机+项目自己的缓存快照（没有就回 idle）。
	useEffect(() => {
		const key = scanSnapshotKey(options.hostId, options.projectId);
		if (scopeKeyRef.current === key) return;
		const previousKey = scopeKeyRef.current;
		scopeKeyRef.current = key;
		hostIdRef.current = options.hostId;
		controller.restore(snapshotsRef.current[key]);
		// 离开的范围若停在 scanning（在途请求已随切换作废），atom 里的快照必须一并归一到 idle：
		// 否则切回来会看到一个永远转圈、却没有任何在途请求的列表。
		if (previousKey !== null && snapshotsRef.current[previousKey]?.phase === "scanning") {
			setSnapshots((previous) => ({ ...previous, [previousKey]: idleScanStateFor(options.hostId) }));
		}
	}, [options.hostId, options.projectId, controller, setSnapshots]);

	// 卸载：只作废在途结果，不再 setState（快照留在 atom 里）。
	useEffect(
		() => () => {
			controller.reset();
		},
		[controller],
	);

	const scan = useCallback(async () => {
		const hostId = optionsRef.current.hostId;
		const projectId = optionsRef.current.projectId;
		const key = scanSnapshotKey(hostId, projectId);
		const generation = controller.start(hostId);
		setSnapshots((previous) => ({ ...previous, [key]: controller.getState() }));
		let outcome: RemoteSessionScanOutcome;
		try {
			outcome = readScanResponse(await portRef.current.scan(hostId, projectId));
		} catch {
			// IPC reject：连失败形状都没有，只能报「请求失败」，不编造远端码。
			outcome = { kind: "rejected" };
		}
		// 代次已作废（切主机、重扫）时整体丢弃：迟到的结果绝不能覆盖新状态。
		if (!controller.settle(generation, outcome)) return;
		setSnapshots((previous) => ({ ...previous, [key]: controller.getState() }));
	}, [controller, setSnapshots]);

	const importSession = useCallback(
		async (entry: RemoteSessionEntryView) => {
			const hostId = optionsRef.current.hostId;
			// 反馈也按「主机 + 项目」记：同主机两个项目的区块各自显示自己那次点击的结果。
			const scope = scanSnapshotKey(hostId, optionsRef.current.projectId);
			setImportingRemoteSessionId(entry.remoteSessionId);
			setFeedbackByHost((previous) => ({ ...previous, [scope]: undefined }));
			try {
				let raw: unknown;
				try {
					raw = await portRef.current.register(hostId, entry.remoteSessionId);
				} catch {
					raw = undefined;
				}
				const outcome = readRegisterResponse(raw, entry.remoteSessionId);
				if (outcome.kind !== "ok") {
					setFeedbackByHost((previous) => ({ ...previous, [scope]: { remoteSessionId: entry.remoteSessionId, kind: "failed", code: outcome.kind === "failed" ? outcome.code : null } }));
					return;
				}
				// 登记写盘与清单刷新是两个阶段。刷新尚未完成时，不能提前宣称「已选中」。
				try {
					await optionsRef.current.onImported({ sessionId: outcome.sessionId, created: outcome.created, remoteSessionId: outcome.remoteSessionId });
					setFeedbackByHost((previous) => ({ ...previous, [scope]: { remoteSessionId: entry.remoteSessionId, kind: "imported", sessionId: outcome.sessionId, created: outcome.created } }));
				} catch {
					// 记录已保存，不把刷新失败误报为登记失败，也不透传异常中的本机路径。
					setFeedbackByHost((previous) => ({ ...previous, [scope]: { remoteSessionId: entry.remoteSessionId, kind: "refresh-failed", sessionId: outcome.sessionId, created: outcome.created } }));
				}
			} finally {
				setImportingRemoteSessionId(null);
			}
		},
		[setFeedbackByHost],
	);

	const scopeKey = scanSnapshotKey(options.hostId, options.projectId);
	return { state: snapshots[scopeKey] ?? idleScanStateFor(options.hostId), feedback: feedbackByHost[scopeKey] ?? null, importingRemoteSessionId, scan, importSession };
}
