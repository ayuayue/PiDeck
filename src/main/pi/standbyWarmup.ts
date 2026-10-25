/**
 * standby 预热状态机（纯逻辑：无 electron / 进程依赖，可被 node --test 直接加载）。
 *
 * 单槽位池只登记「握手完成」的进程，而一次 pi 冷启动实测 8~25s（几乎全耗在 pi 加载用户
 * 扩展）。新建会话后马上发送（尤其引导页首条消息）时，认领方看不到池条目就会自己再
 * spawn 一个，与后台预热并行起两个 pi——又慢又费内存（线上实测 26.5s 的真会话 spawn
 * 与 12.1s 的 standby spawn 并行）。本类把「进行中的预热」显式建模，供 AgentManager 三处使用：
 *
 * 1. ensureStandbyAgent：同一时刻只允许一次预热；请求目标（项目+指纹）变了先记「最新期望
 *    目标」，当前预热 settle（无论成败/取消）后接力补热；
 * 2. claimStandbyAgent：池里没有但同项目+同指纹的预热在跑 → 等它 settle 后直接认领，
 *    等待期间绝不再发起第二次 spawn；
 * 3. releaseStandbyAgent / stopAll：标记取消，预热完成时由调用方 stop 掉进程，绝不入池
 *    （否则 TTL 到期前会泄漏一个不可见的 pi 进程）。
 *
 * 定时器显式取自 node:timers：测试沙箱（tests/helpers/createTsSandbox.mjs 等）不注入
 * Node 全局，直接用 setTimeout 会在测试内 ReferenceError。
 */
import { clearTimeout, setTimeout } from "node:timers";

/** claim 等待进行中预热的默认上限：覆盖一次正常冷启动（8~25s），超时就地回退普通 spawn。 */
export const STANDBY_CLAIM_WAIT_MS = 30_000;

/** 一次预热的 spawn 输入身份（项目 + 指纹），与 StandbyAgentPool 条目的判定字段同源。 */
export interface StandbyWarmupTarget {
	projectId: string;
	fingerprint: string;
}

/** 预热结算结果：ok=false 表示失败或取消（认领等待者应回退普通 spawn）。 */
export interface StandbyWarmupSettlement extends StandbyWarmupTarget {
	ok: boolean;
	cancelled: boolean;
}

interface StandbyWarmupPending {
	target: StandbyWarmupTarget;
	cancelled: boolean;
}

interface StandbyWarmupWaiter {
	projectId: string;
	fingerprint: string;
	resolve: (settlement: StandbyWarmupSettlement | null) => void;
	timer?: ReturnType<typeof setTimeout>;
}

export class StandbyWarmupTracker {
	private pending: StandbyWarmupPending | null = null;
	private requested: StandbyWarmupTarget | null = null;
	private readonly waiters = new Set<StandbyWarmupWaiter>();

	/**
	 * 登记一次新的后台预热（幂等）：已有进行中的预热时不覆盖目标并返回 false。
	 * 调用方发现目标不同应改用 requestProject 记录接力目标，而不是并行再起一个预热。
	 */
	begin(projectId: string, fingerprint: string): boolean {
		if (this.pending) return false;
		this.pending = { target: { projectId, fingerprint }, cancelled: false };
		return true;
	}

	/**
	 * 结算当前预热并唤醒认领等待者，返回本次预热是否已被取消。
	 * 时序契约：成功路径调用方必须先把进程 put 进池、再 settle（等待者醒来会立即 take）；
	 * 取消路径先 settle(null) 再 stop 进程（等待者先拿到失败结果，不会等一个已被丢掉的进程）。
	 */
	settle(agentId: string | null): boolean {
		const pending = this.pending;
		if (!pending) return false;
		this.pending = null;
		const settlement: StandbyWarmupSettlement = { ...pending.target, ok: agentId !== null, cancelled: pending.cancelled };
		for (const waiter of [...this.waiters]) this.finishWaiter(waiter, settlement);
		return pending.cancelled;
	}

	hasPending(): boolean {
		return this.pending !== null;
	}

	/** 进行中的预热是否正是该 spawn 输入（项目与指纹都一致）。 */
	matches(projectId: string, fingerprint: string): boolean {
		return this.pending !== null && this.pending.target.projectId === projectId && this.pending.target.fingerprint === fingerprint;
	}

	/** 当前进行中的预热是否已被取消（完成时必须 stop，绝不 put 进池）。 */
	isCancelled(): boolean {
		return this.pending !== null && this.pending.cancelled;
	}

	/**
	 * 等待匹配的进行中预热 settle（只读：不消费 pending / 接力目标，池条目仍由调用方 take）。
	 * 匹配的预热不存在 / 已取消 → 立即 null（取消的预热注定不入池，等它只会白拖用户首条消息）；
	 * 超时 → null 且移除等待者（不泄漏 promise/定时器）；否则返回结算结果。
	 */
	waitForClaim(projectId: string, fingerprint: string, timeoutMs: number): Promise<StandbyWarmupSettlement | null> {
		const pending = this.pending;
		if (!pending || pending.cancelled || !this.matches(projectId, fingerprint)) return Promise.resolve(null);
		return new Promise((resolve) => {
			const waiter: StandbyWarmupWaiter = { projectId, fingerprint, resolve };
			waiter.timer = setTimeout(() => {
				// 超时清理等待者：预热卡死时不能让 claim 永远挂着（也避免闭包/定时器泄漏）。
				this.finishWaiter(waiter, null);
			}, timeoutMs);
			if (typeof waiter.timer.unref === "function") waiter.timer.unref();
			this.waiters.add(waiter);
		});
	}

	/** 记录「最新期望目标」用于接力：进行中的预热 settle 后自动为它补热。 */
	requestProject(projectId: string, fingerprint: string): void {
		this.requested = { projectId, fingerprint };
	}

	/** 取走接力目标（只取一次）；没有排队请求返回 null。 */
	takeRequestedProject(): StandbyWarmupTarget | null {
		const requested = this.requested;
		this.requested = null;
		return requested === null ? null : { ...requested };
	}

	/** 退出清理：丢弃接力目标，防止 stopAll 之后又补热出一个无人认领的进程。 */
	clearRequestedProject(): void {
		this.requested = null;
	}

	/**
	 * 取消进行中的预热（传 projectId 只取消该项目；stopAll 不传则取消全部）。
	 * 取消后立即唤醒认领等待者：它们等的是一个注定不会入池的进程，继续等只会让用户更慢。
	 * settle 仍会返回 true（调用方据此在预热完成时 stop 掉进程）。
	 */
	cancelPending(projectId?: string): boolean {
		const pending = this.pending;
		if (!pending) return false;
		if (projectId !== undefined && pending.target.projectId !== projectId) return false;
		pending.cancelled = true;
		for (const waiter of [...this.waiters]) this.finishWaiter(waiter, null);
		return true;
	}

	/** 唤醒一次等待者（幂等：settle/取消/超时可能竞争，先到先得）。 */
	private finishWaiter(waiter: StandbyWarmupWaiter, settlement: StandbyWarmupSettlement | null): void {
		if (!this.waiters.delete(waiter)) return;
		if (waiter.timer) clearTimeout(waiter.timer);
		waiter.resolve(settlement);
	}
}
