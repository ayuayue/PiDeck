import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RemoteProject } from "../../../shared/types/project";
import { desktopApi } from "../desktopApi";
import { useDocumentPageVisible } from "../hooks/useRemoteGitRefsPolling";
import { useProjectServices } from "../hooks/useProjectServices";
import { acquireProjectFactSubscription } from "../services/projectServiceFactSubscription";
import { shouldRefreshRemoteGitOnFactsChange } from "../utils/remoteGitFactsScope";
import { createRemoteGitPanelApi } from "../utils/remoteGitPanelApi";
import { remoteGitStatusPollingEnabled, startRemoteGitStatusPolling } from "../utils/remoteGitStatusPolling";
import { createRemoteGitViewController, type RemoteGitViewState } from "../utils/remoteGitViewState";

/**
 * Writes that were still in flight when a controller retired (disconnect, rebind, root change) keep their "unconfirmed"
 * outcome across the new generation: the reply is gone, so a clean repository must not be shown before a fact read
 * succeeds. Keyed without the connection generation, because the generation is exactly what changes underneath it.
 * Entries are removed by a successful fact read (the refresh path already keeps the code while it loads).
 */
const uncertainWrites = new Set<string>();

/**
 * The read-only panel owns this state; neither currentSession atoms nor native Git polling are subscribed. `repoPath`
 * is the selected repository scope ("" is the project root): it is part of the identity key, so switching scope
 * disposes the old controller and resets the view instead of mixing two repositories' facts in one panel.
 *
 * G4a: the only data entry is `useProjectServices(project).git` (through the panel bridge); the only capability source
 * is `services.capabilities.git`. The hook never subscribes to preload facts/host state itself: the services runtime
 * owns those subscriptions and rebuilds the services (and therefore this controller) on every connection generation.
 * `services.generation` is part of the controller key, so a late answer of the retired generation can never publish.
 */
export function useRemoteGitView(project: RemoteProject, repoPath = "") {
	const services = useProjectServices(project);
	const capabilities = services.capabilities.git;
	const blocked = services.capabilities.blocked;
	// 身份不含连接代：断线/重绑后同一个仓库仍是同一个“未知写”携带者；代的差异由 controller key 负责。
	const identityKey = JSON.stringify([project.id, project.locator.hostId, project.locator.remotePath, repoPath]);
	const projectKey = JSON.stringify([project.id, project.locator.hostId, project.locator.remotePath, repoPath, services.generation]);
	const [state, setState] = useState<RemoteGitViewState>({ projectKey, loading: true, diffLoading: false });
	// 最新已发布状态：effect cleanup 要据此判断“是否有写在进行中/有没有未确认的写”需要带到下一代。
	const stateRef = useRef(state);
	stateRef.current = state;
	/** Publish, and let a confirmed fact read retire the carried uncertainty (a failed read never does). */
	const publish = useCallback(
		(next: RemoteGitViewState): void => {
			if (next.projectKey === projectKey && next.loading === false && next.errorCode === undefined && next.snapshot !== undefined) uncertainWrites.delete(identityKey);
			setState(next);
		},
		[projectKey, identityKey],
	);
	// The bridge is the only place the preload API is still touched (three frozen-contract gaps); everything else is
	// delegated to the project-bound service, which owns the tokens.
	const api = useMemo(() => createRemoteGitPanelApi(services, desktopApi), [services]);
	// Host readiness is no longer read from host events: `git.write` is the capability that only opens for a host the
	// service facts really consider ready, trusted and writable. Read/write themselves are still gated per action.
	const hostReady = capabilities.write;
	// 隐藏的窗口不轮询：document 可见性只影响读的节奏，不影响已落地的事实。
	const pageVisible = useDocumentPageVisible();
	const controller = useRef<ReturnType<typeof createRemoteGitViewController> | null>(null);
	useEffect(() => {
		const reads = createRemoteGitViewController(project.id, projectKey, api, publish, repoPath, capabilities);
		controller.current = reads;
		// A closed read capability must not produce a read at all: publish the stable reason and stop.
		if (!capabilities.read) reads.setUnavailable(blocked["git.read"] ?? "PROJECT_CAPABILITY_HOST_NOT_READY");
		else {
			// A write that was in flight when the previous generation retired never loses its "unconfirmed" outcome:
			// the new controller adopts it before its first read, and only a successful fact read retires it.
			if (uncertainWrites.has(identityKey)) reads.setUncertain();
			// The sync facts belong to the project identity, not to a snapshot generation: they are read once after
			// the first repository read, and afterwards only when the user acts (refresh or a sync verb). No effect
			// watches the snapshot, so a refresh can never trigger a second, self-feeding load that moves the rows.
			void reads.refresh().then(() => reads.loadSync());
		}
		return () => {
			// Cleanup runs before the next effect: whatever the retired controller still owed the user travels with
			// the identity, never into the new controller's facts.
			const last = stateRef.current;
			if (last.projectKey === projectKey && (last.mutating === true || last.errorCode === "GIT_WRITE_RESULT_UNCONFIRMED")) uncertainWrites.add(identityKey);
			reads.dispose();
			if (controller.current === reads) controller.current = null;
		};
	}, [project.id, project.locator.hostId, projectKey, repoPath, api, capabilities, blocked, identityKey, publish]);
	/**
	 * 事实失效通知（主进程只标脏，面板自己决定重读）：
	 * runtime 对**同代**事实事件不会重建 services，所以 hook 必须自己订阅；否则写成功/未知写/文件写发出的
	 * status 标脏到不了面板，只剩轮询兜底（降级主机上轮询还会被关）。这里只处理本项目当前仓库的 status 范围，
	 * 换代与连接状态仍由 runtime 负责。
	 */
	useEffect(() => {
		const release = acquireProjectFactSubscription(project, desktopApi, {
			onStateChange: () => undefined,
			onFactsChange: (change) => {
				if (!shouldRefreshRemoteGitOnFactsChange(change, project.id, repoPath)) return;
				void controller.current?.refresh(true);
			},
		});
		return release;
	}, [project, repoPath]);
	/**
	 * 5 秒静默 status 轮询（P0-3）：外部 commit/checkout 不会让主进程标脏，只有轮询能发现。
	 *
	 * 闸门 = `git.statusPoll` 能力 + document 可见 + hostReady（由能力派生）+ 非变更中/非读中。
	 * 闸门关闭时立即清定时器并退休在途结果；打开时重建一个 interval（effect 只在闸门值变化时重跑）。
	 * 走 refreshStatus 而不是 refresh：后者置 loading 并清掉 diff/history/refs。不 fetch。
	 */
	const statusPolling = capabilities.statusPoll && remoteGitStatusPollingEnabled({ pageVisible, hostReady, mutating: state.mutating === true, loading: state.loading, diffLoading: state.diffLoading });
	useEffect(() => {
		if (!statusPolling) {
			controller.current?.stopStatusPolling();
			return;
		}
		const stop = startRemoteGitStatusPolling({
			isEnabled: () => true,
			poll: () => controller.current?.refreshStatus() ?? Promise.resolve(),
			timer: {
				set: (callback, intervalMs) => window.setInterval(callback, intervalMs),
				clear: (handle) => window.clearInterval(handle),
			},
		});
		return () => {
			stop();
			controller.current?.stopStatusPolling();
		};
	}, [statusPolling, projectKey]);
	const loadHistory = useCallback(() => {
		void controller.current?.loadHistory();
	}, []);
	const loadMoreHistory = useCallback(() => {
		void controller.current?.loadMoreHistory();
	}, []);
	const openCommitDetail = useCallback((oid: string) => {
		void controller.current?.openCommitDetail(oid);
	}, []);
	const loadRefs = useCallback(() => {
		void controller.current?.loadRefs();
	}, []);
	const loadRecovery = useCallback(() => {
		void controller.current?.loadRecovery();
	}, []);
	const restoreRecovery = useCallback((entry: Parameters<NonNullable<typeof controller.current>["restoreRecovery"]>[0]) => {
		void controller.current?.restoreRecovery(entry);
	}, []);
	const dropRecovery = useCallback((entry: Parameters<NonNullable<typeof controller.current>["dropRecovery"]>[0]) => {
		void controller.current?.dropRecovery(entry);
	}, []);
	const loadSync = useCallback(() => {
		void controller.current?.loadSync();
	}, []);
	const runCompare = useCallback((base: string, head: string) => {
		void controller.current?.runCompare(base, head);
	}, []);
	/**
	 * The panel decides when the refs section is expanded; the automatic poll itself stays behind `git.refsWatch`
	 * (second line of defence: a closed capability returns resolved, so the tick can never start a read).
	 */
	const pollRefs = useCallback((): Promise<void> => (capabilities.refsWatch ? (controller.current?.pollRefs() ?? Promise.resolve()) : Promise.resolve()), [capabilities.refsWatch]);
	const stopRefsPolling = useCallback(() => {
		controller.current?.stopRefsPolling();
	}, []);
	/**
	 * Explicit sync verbs only. No effect, poll or read path may call these: an automatic fetch is exactly what the
	 * capability table forbids (`git.autoFetch` is false for every remote provider).
	 */
	const fetchRemote = useCallback((remote: string) => {
		void controller.current?.fetch(remote);
	}, []);
	const pushRemote = useCallback((remote: string, branch: string) => {
		void controller.current?.push(remote, branch);
	}, []);
	const pullRemote = useCallback((remote: string, branch: string) => {
		void controller.current?.pull(remote, branch);
	}, []);
	const discard = useCallback((group: "workingTree" | "untracked", target: Parameters<NonNullable<typeof controller.current>["discard"]>[1]) => {
		void controller.current?.discard(group, target);
	}, []);
	const createBranch = useCallback((name: string) => {
		void controller.current?.createBranch(name);
	}, []);
	const initRepository = useCallback((): Promise<boolean> => controller.current?.initRepository() ?? Promise.resolve(false), []);
	const switchBranch = useCallback((name: string) => {
		void controller.current?.switchBranch(name);
	}, []);
	const openHistoryFileDiff = useCallback((base: string | null, head: string, target: Parameters<NonNullable<typeof controller.current>["openHistoryFileDiff"]>[2]) => {
		void controller.current?.openHistoryFileDiff(base, head, target);
	}, []);
	return {
		state: state.projectKey === projectKey ? state : { projectKey, loading: true, diffLoading: false },
		// Returning the promise lets an explicit refresh gesture sequence the sync-facts read after the snapshot
		// read; the snapshot update replaces the whole state and would wipe facts read concurrently.
		refresh: (force = false): Promise<void> => controller.current?.refresh(force) ?? Promise.resolve(),
		openDiff: (group: Parameters<NonNullable<typeof controller.current>["openDiff"]>[0], target: Parameters<NonNullable<typeof controller.current>["openDiff"]>[1]) => {
			void controller.current?.openDiff(group, target);
		},
		mutate: (operation: "stage" | "unstage", group: Parameters<NonNullable<typeof controller.current>["mutate"]>[1], target: Parameters<NonNullable<typeof controller.current>["mutate"]>[2]) => {
			void controller.current?.mutate(operation, group, target);
		},
		commit: (message: string) => {
			void controller.current?.commit(message);
		},
		closeDiff: () => controller.current?.closeDiff(),
		loadHistory,
		loadMoreHistory,
		openCommitDetail,
		loadRefs,
		openHistoryFileDiff,
		createBranch,
		initRepository,
		switchBranch,
		discard,
		loadRecovery,
		restoreRecovery,
		dropRecovery,
		loadSync,
		runCompare,
		pollRefs,
		stopRefsPolling,
		hostReady,
		// The panel's entries are gated by these two: capabilities decide what exists, blocked carries the stable reason.
		capabilities,
		blocked,
		fetchRemote,
		pushRemote,
		pullRemote,
	};
}
