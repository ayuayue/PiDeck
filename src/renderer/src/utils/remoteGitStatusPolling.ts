/**
 * 远端 Git 面板的 5 秒静默 status 轮询（P0-3）。
 *
 * 本机面板有 5 秒 status 轮询（`useGitAutoRefresh` 的 statusPoll 能力位），远端过去只在挂载时读一次、
 * 之后靠写面通知：远程终端/Agent 里 commit/checkout 后面板一直旧。这里只补**读**的节奏，不引入 fetch、
 * 不引入事件流：每次 tick 就是一次 `git:remote-snapshot` 的静默读。
 *
 * 静默的含义（`createRemoteGitStatusRefresher`）：只换 snapshot/errorCode，不置 loading、不动
 * diff/history/refs/选中行、不 bump 那些 epoch；单飞；停止（隐藏/卸载/闸门关闭）后在途答案不得发布。
 * 闸门（任一关闭就不起一次读）：document 可见、host ready、非变更中、非读中。
 */
import type { GitReadSnapshot, GitReadSnapshotResult } from "../../../shared/types/git";
import { createGitOperationGate } from "./gitOperationGate";
import { startRemoteGitRefsPolling, type RemoteGitRefsPollingTimer } from "./remoteGitRefsPolling";

/** 5 秒：与本机 Git 面板同一节奏；再快会把 SSH 往返变成常态开销。 */
export const REMOTE_GIT_STATUS_POLL_INTERVAL_MS = 5_000;

/** 一次 tick 的全部前置条件；任何一条关闭都不读。 */
export type RemoteGitStatusPollingGates = {
	/** document.visibilityState === "visible"：隐藏的窗口不该轮询。 */
	pageVisible: boolean;
	/** 宿主被观察到离开 ready 后暂停（乐观初值只覆盖首个 host 事件之前的窗口）。 */
	hostReady: boolean;
	/** 变更中的写会让中间态被读成「新事实」：跳过这一轮。 */
	mutating: boolean;
	/** 正在读快照（首次读/显式刷新）时不叠加。 */
	loading: boolean;
	/** diff 在途时跳过：一次静默刷新不该和用户正在等的 diff 抢往返。 */
	diffLoading: boolean;
};

export function remoteGitStatusPollingEnabled(gates: RemoteGitStatusPollingGates): boolean {
	return gates.pageVisible && gates.hostReady && !gates.mutating && !gates.loading && !gates.diffLoading;
}

export type RemoteGitStatusPollingOptions = {
	/** 每次 tick 现求值：effect 之外的 gate 变化（例如宿主事件）也能关掉下一次读。 */
	isEnabled: () => boolean;
	/** 控制器的静默读；单飞与代次围栏都在控制器里。 */
	poll: () => Promise<void> | void;
	timer: RemoteGitRefsPollingTimer;
};

/** 有闸门 + 单飞 + 可停止的定时策略只有一份（refs 轮询先立的那份）；status 只换节奏。 */
export function startRemoteGitStatusPolling(options: RemoteGitStatusPollingOptions): () => void {
	return startRemoteGitRefsPolling({ ...options, intervalMs: REMOTE_GIT_STATUS_POLL_INTERVAL_MS });
}

/** 控制器里静默刷新需要看到的最小状态面（其余字段原样带过去）。 */
export type RemoteGitStatusRefreshState = {
	loading: boolean;
	diffLoading: boolean;
	mutating?: boolean;
	snapshot?: GitReadSnapshot;
	errorCode?: string;
};

export type RemoteGitStatusRefreshPort<TState extends RemoteGitStatusRefreshState> = {
	/** 控制器是否还能发布（dispose 之后为 false）。 */
	isActive(): boolean;
	/** 当前状态：既是闸门判据，也是下一次发布的底稿。 */
	current(): TState;
	/** 事实代次：显式刷新/写动作/换代都会推进；跨代的静默答案一律丢弃。 */
	factGeneration(): number;
	/** 发布下一次状态（控制器自己负责 sticky 字段）。 */
	publish(state: TState): void;
	/** 一次快照读：优先越过主进程已完成缓存（外部 commit/checkout 不会让主进程标脏）。 */
	readSnapshot(): Promise<GitReadSnapshotResult>;
	/** 异常 ⇒ 稳定码（与 refresh 同一套归一）。 */
	codeOf(error: unknown): string;
};

/**
 * 静默刷新：只有「发布什么」与 refresh() 不同——不置 loading、不动 diff/history/refs/选中行。
 *
 * 状态机只有一份：闸门在本模块，事实代次在控制器；停止只是推进自己的代次，让在途答案过期。
 */
export function createRemoteGitStatusRefresher<TState extends RemoteGitStatusRefreshState>(port: RemoteGitStatusRefreshPort<TState>) {
	// 取消 / 互斥（不重叠）/ 迟到读 三条规则走共用闸门：本地 GitPanel 用同一份实现。
	const gate = createGitOperationGate();
	/**
	 * 连接失效后的暂停位：断开/重连本身不能自己把事实读回来（显式重连绝不重放一次读）。
	 * 解除判据在控制器：只有一次**成功的显式 refresh()** 才 resume，失败的刷新不解除。
	 */
	let paused = false;
	const blocked = (state: TState) => paused || !port.isActive() || state.loading || state.diffLoading || state.mutating === true;
	/** 两个维度都要对：闸门代（取消/写）与控制器事实代（显式刷新/写动作）。 */
	const stale = (generation: number, factGeneration: number) => !port.isActive() || !gate.isCurrent(generation) || factGeneration !== port.factGeneration();
	return {
		async refreshStatus(): Promise<void> {
			const state = port.current();
			if (blocked(state)) return;
			// exclusive：前一次静默读还在途就跳过这一拍（不与它重叠，也不把它顶掉）。
			const generation = gate.beginRead({ exclusive: true });
			if (generation === undefined) return;
			const factGeneration = port.factGeneration();
			try {
				const result = await port.readSnapshot();
				if (stale(generation, factGeneration)) return;
				const current = port.current();
				// 一次成功的新事实正好是「结果未知」要求用户做的核对：它解除那条警告。失败只报码，保留现有事实。
				if (result.ok) port.publish({ ...current, snapshot: result.snapshot, errorCode: undefined });
				else port.publish({ ...current, errorCode: current.errorCode === "GIT_WRITE_RESULT_UNCONFIRMED" ? "GIT_WRITE_RESULT_UNCONFIRMED" : result.code });
			} catch (error) {
				if (stale(generation, factGeneration)) return;
				const current = port.current();
				port.publish({ ...current, errorCode: current.errorCode === "GIT_WRITE_RESULT_UNCONFIRMED" ? "GIT_WRITE_RESULT_UNCONFIRMED" : port.codeOf(error) });
			} finally {
				gate.endRead(generation);
			}
		},
		/** 连接失效：暂停自动轮询，并退休在途的静默答案。 */
		pause(): void {
			paused = true;
			gate.retire();
		},
		/** 一次成功的显式刷新之后恢复轮询（失败的刷新不解除暂停）。 */
		resume(): void {
			paused = false;
		},
		/** 隐藏/卸载/闸门关闭：退休在途结果。 */
		stop(): void {
			gate.retire();
		},
	};
}
