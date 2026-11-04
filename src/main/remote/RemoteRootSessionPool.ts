/**
 * 同主机多项目 root 会话池（main 私有；生产默认启用并已通过真实主机资源门禁）。
 *
 * 为什么需要它：helper 的 `--root` 在**进程生命周期内固定**，所以旧实现里「切到另一个项目」必然拆掉当前
 * helper 会话——重新发现 node、重新握手、全部 watcher 重建、事实缓存换代。池把「一台主机一条会话」升级为
 * 「(hostId, canonicalRoot) 一条会话」：同一项目复用同一条连接，不同项目互不拆连接。
 *
 * 本模块只承担**容量与生命周期**，不认识 SSH：建立与销毁由调用方注入。这样它能在完全没有远端的情况下被
 * 完整单测，也保证「池的策略」不会悄悄长成第二套连接状态机。
 *
 * 四个预算刻意分开（见 docs/remote-host-root-pooling-adr.md §5.2），因为它们回答的是不同问题：
 * - **活跃租约**（lease）：一次执行中的读/写各持一份。持租约的条目**永不淘汰**——在途写不能因为 LRU/TTL
 *   被中断，否则调用方会拿到一个「写了一半且结果未知」的会话，而这正是必须避免的。
 * - **订阅保活**（watch）：目录 watcher 仍登记在这条会话上时也不能回收，否则监听会静默断掉，而 UI 仍以为
 *   它在工作。
 * - **空闲保温**（idleCapacity / idleTtlMs / LRU）：只约束**既无租约也无订阅**的条目，所以它绝不是可登记/可
 *   打开项目数的上限——第 3、第 4 个项目照常打开，只是不会全部被保温。
 * - **总资源预算**（maxEntries）：唯一硬上限。满载时先淘汰空闲条目；仍无空位就进入**可取消、有超时**的
 *   等待，超时返回稳定码。绝不无限排队，也绝不为了腾位置悄悄改投另一个 root。
 */
import { setTimeout as delayTimer, clearTimeout as cancelTimer } from "node:timers";

export type RootPoolKey = { readonly hostId: string; readonly root: string };

/** 条目为什么被回收。调用方据此决定是否通知上层（显式退休要退订阅，TTL 只是省资源）。 */
export type RootPoolRetireReason = "lru" | "ttl" | "explicit" | "host" | "latched" | "dispose";

export type RootPoolPolicy = {
	/** 空闲保温候选容量。只约束空闲条目，与可登记项目数无关。 */
	readonly idleCapacity: number;
	/** 空闲条目保留多久（毫秒）。 */
	readonly idleTtlMs: number;
	/** 同时存活的会话总预算（活跃 + 空闲），唯一硬上限。 */
	readonly maxEntries: number;
	/** 满载时可取消等待的上限（毫秒）；超时返回稳定码而不是无限排队。 */
	readonly acquireTimeoutMs: number;
};

/** 生产策略：保温 2 / TTL 10 分钟；建立中与销毁中也占用总预算。 */
export const ROOT_POOL_DEFAULT_POLICY: RootPoolPolicy = Object.freeze({ idleCapacity: 2, idleTtlMs: 10 * 60_000, maxEntries: 6, acquireTimeoutMs: 30_000 });

/** 一份执行租约：`release()` 幂等，条目在租约存续期间不可被淘汰。 */
export type RootPoolLease<T> = {
	readonly hostId: string;
	readonly root: string;
	readonly connectionId: string;
	readonly value: T;
	release(): void;
};

export type RootPoolAcquireResult<T> = { ok: true; lease: RootPoolLease<T> } | { ok: false; code: string };

/** 只读视图：给事实/能力查询用，拿不到租约也就不会延长条目寿命。 */
export type RootPoolEntryView<T> = {
	readonly hostId: string;
	readonly root: string;
	readonly connectionId: string;
	readonly value: T;
	readonly leases: number;
	readonly watchers: number;
	readonly lastUsedAt: number;
};

export type RootPoolStats = {
	readonly entries: number;
	readonly creating: number;
	readonly retiring: number;
	readonly idle: number;
	readonly leased: number;
	readonly watched: number;
	readonly hits: number;
	readonly misses: number;
	readonly created: number;
	readonly retired: number;
	readonly evictedIdle: number;
	readonly waits: number;
	readonly waitCount: number;
	readonly waitTimeouts: number;
	readonly peakEntries: number;
};

export type RootSessionPoolOptions<T> = {
	policy?: Partial<RootPoolPolicy>;
	/**
	 * 同 key 并发共享建立；最后一位等待者取消或条目退休时触发 signal。
	 * 抛出的稳定码原样交给调用方（例如 `SSH_PROJECT_ROOT_CHANGED`），因此建立失败不会被伪装成池故障。
	 */
	establish: (key: RootPoolKey, signal: AbortSignal) => Promise<T>;
	/** 回收一个会话（agent: manager.dispose()）。只在下述时机调用：淘汰、退休、主机失效、服务关闭。 */
	retire: (entry: { key: RootPoolKey; value: T; connectionId: string }, reason: RootPoolRetireReason) => void | Promise<void>;
	/** 会话身份（`RemoteProjectSession.connectionId`）。事实缓存与渲染层按它换代。 */
	identity?: (value: T) => string;
	/** 条目被回收后的通知（root 退休 ≠ 主机断开，调用方据此只清这个 root 的订阅）。 */
	onRetired?: (event: { hostId: string; root: string; connectionId: string; reason: RootPoolRetireReason }) => void;
	/** Main-only lifecycle snapshots; never forwarded through renderer diagnostics. */
	onDiagnostic?: (event: { action: string; before?: RootPoolStats; stats: RootPoolStats; roots: readonly { hostId: string; root: string; connectionId: string; leases: number; watchers: number; state: "ready" | "retiring" }[]; creatingRoots: readonly RootPoolKey[] }) => void;
	now?: () => number;
};

export type RootSessionPool<T> = {
	/** 取得一份租约；命中直接复用，未命中在容量内建立，满载则可取消/有超时地等待。 */
	acquire(key: RootPoolKey, options?: { signal?: AbortSignal }): Promise<RootPoolAcquireResult<T>>;
	/** 只读查询：该 root 当前是否有存活会话。**不建立、不延长寿命**。 */
	peek(hostId: string, root: string): RootPoolEntryView<T> | undefined;
	entries(): readonly RootPoolEntryView<T>[];
	/** 订阅保活：登记该 root 还挂着 watcher。返回 false 表示当前没有会话可保活。 */
	retainWatch(hostId: string, root: string, connectionId: string): boolean;
	releaseWatch(hostId: string, root: string, connectionId: string): void;
	/** 退休一个 root（显式断开某个项目/条目被判定失效）：不影响同主机其它条目。 */
	retireRoot(hostId: string, root: string, reason: RootPoolRetireReason): Promise<void>;
	/** 主机级失效（显式断开/重绑/禁用/store 代数变化）：该主机全部条目一起退休。 */
	retireHost(hostId: string, reason: RootPoolRetireReason): Promise<void>;
	/** 按 TTL 与 LRU 回收空闲条目；空闲条目之外的任何条目都不会被这里动到。 */
	sweep(now?: number): Promise<void>;
	stats(): RootPoolStats;
	dispose(): Promise<void>;
};

type Entry<T> = {
	hostId: string;
	root: string;
	value: T;
	lastUsedAt: number;
	leases: number;
	watchers: Map<string, number>;
	live: boolean;
};

const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

/** 建立失败只交稳定码：把传输层的任意消息带到上层会把路径/命令泄进 UI。 */
function stableCodeOf(error: unknown): string {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return typeof message === "string" && STABLE_CODE.test(message) ? message : "SSH_HOST_NOT_READY";
}

type Creation = { key: RootPoolKey; controller: AbortController; users: number; task: Promise<{ ok: true } | { ok: false; code: string }> };
type Acquisition = { key: RootPoolKey; controller: AbortController; code: string };

export function createRootSessionPool<T>(options: RootSessionPoolOptions<T>): RootSessionPool<T> {
	const policy: RootPoolPolicy = { ...ROOT_POOL_DEFAULT_POLICY, ...options.policy };
	if (!Number.isInteger(policy.idleCapacity) || policy.idleCapacity < 0 || !Number.isFinite(policy.idleTtlMs) || policy.idleTtlMs <= 0 || !Number.isInteger(policy.maxEntries) || policy.maxEntries < 1 || !Number.isFinite(policy.acquireTimeoutMs) || policy.acquireTimeoutMs <= 0)
		throw new Error("REMOTE_ROOT_POOL_POLICY_INVALID");
	const now = options.now ?? Date.now;
	const entries = new Map<string, Entry<T>>();
	const creating = new Map<string, Creation>();
	const retiring = new Map<string, { entry: Entry<T>; task: Promise<void> }>();
	const acquisitions = new Set<Acquisition>();
	const waiters = new Set<() => void>();
	const counters = { hits: 0, misses: 0, created: 0, retired: 0, evictedIdle: 0, waits: 0, waitTimeouts: 0, peakEntries: 0 };
	let disposed = false;
	let disposing: Promise<void> | undefined;
	const keyOf = (hostId: string, root: string): string => hostId + "\u0000" + root;
	const identityOf = (value: T): string => options.identity?.(value) ?? "";
	const watchersOf = (entry: Entry<T>): number => [...entry.watchers.values()].reduce((sum, count) => sum + count, 0);
	// A freshly published entry is reserved until its awaiting acquirers receive their leases.
	const idle = (entry: Entry<T>): boolean => entry.live && entry.leases === 0 && watchersOf(entry) === 0 && ![...acquisitions].some((request) => !request.controller.signal.aborted && request.key.hostId === entry.hostId && request.key.root === entry.root);
	const idleEntries = (): Entry<T>[] => [...entries.values()].filter(idle).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
	const viewOf = (entry: Entry<T>): RootPoolEntryView<T> => ({ hostId: entry.hostId, root: entry.root, connectionId: identityOf(entry.value), value: entry.value, leases: entry.leases, watchers: watchersOf(entry), lastUsedAt: entry.lastUsedAt });
	const slots = (): number => entries.size + creating.size + retiring.size;
	function stats(): RootPoolStats {
		const all = [...entries.values()];
		return { entries: all.length, creating: creating.size, retiring: retiring.size, idle: all.filter(idle).length, leased: all.filter((e) => e.leases > 0).length, watched: all.filter((e) => watchersOf(e) > 0).length, ...counters, waitCount: waiters.size };
	}
	function diagnose(action: string, before?: RootPoolStats): void {
		try {
			options.onDiagnostic?.({
				action,
				...(before === undefined ? {} : { before }),
				stats: stats(),
				roots: [...entries.values(), ...[...retiring.values()].map((r) => r.entry)].map((e) => ({ hostId: e.hostId, root: e.root, connectionId: identityOf(e.value), leases: e.leases, watchers: watchersOf(e), state: e.live ? "ready" : "retiring" })),
				creatingRoots: [...creating.values()].map((pending) => pending.key),
			});
		} catch {
			// Observability must not break slot accounting or session teardown.
		}
	}
	function wake(): void {
		for (const notify of [...waiters]) notify();
	}
	function makeLease(entry: Entry<T>): RootPoolLease<T> {
		let released = false;
		entry.leases += 1;
		entry.lastUsedAt = now();
		return {
			hostId: entry.hostId,
			root: entry.root,
			connectionId: identityOf(entry.value),
			value: entry.value,
			release() {
				if (released) return;
				released = true;
				entry.leases -= 1;
				entry.lastUsedAt = now();
				if (entry.live) wake();
			},
		};
	}
	function retire(entry: Entry<T>, reason: RootPoolRetireReason): Promise<void> {
		const id = keyOf(entry.hostId, entry.root);
		if (!entry.live) return retiring.get(id)?.task ?? Promise.resolve();
		entry.live = false;
		entries.delete(id);
		counters.retired += 1;
		if (reason === "lru" || reason === "ttl") counters.evictedIdle += 1;
		const connectionId = identityOf(entry.value);
		// Fence consumers immediately, but reserve the physical slot until teardown settles.
		const task = Promise.resolve()
			.then(() => options.retire({ key: { hostId: entry.hostId, root: entry.root }, value: entry.value, connectionId }, reason))
			.catch(() => diagnose("retire-failed"))
			.then(() => {
				retiring.delete(id);
				diagnose("retired:" + reason);
				wake();
			});
		retiring.set(id, { entry, task });
		options.onRetired?.({ hostId: entry.hostId, root: entry.root, connectionId, reason });
		diagnose("retiring:" + reason);
		return task;
	}
	/** Every capacity wait has a deadline and cancellation; registering has no await gap. */
	function waitForSlot(deadline: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			const finish = (): void => {
				cancelTimer(timer);
				waiters.delete(finish);
				signal.removeEventListener("abort", finish);
				resolve();
			};
			const timer = delayTimer(finish, Math.max(0, deadline - now()));
			waiters.add(finish);
			signal.addEventListener("abort", finish, { once: true });
			if (signal.aborted) finish();
		});
	}
	/** Cancelling a consumer never cancels the shared producer while another consumer remains. */
	async function joinCreation(pending: Creation, request: Acquisition): Promise<{ ok: true } | { ok: false; code: string }> {
		pending.users += 1;
		try {
			return await new Promise((resolve) => {
				const finish = (result: { ok: true } | { ok: false; code: string }): void => {
					request.controller.signal.removeEventListener("abort", abort);
					resolve(result);
				};
				const abort = (): void => finish({ ok: false, code: request.code });
				request.controller.signal.addEventListener("abort", abort, { once: true });
				void pending.task.then(finish);
				if (request.controller.signal.aborted) abort();
			});
		} finally {
			pending.users -= 1;
			if (pending.users === 0 && request.controller.signal.aborted) pending.controller.abort();
		}
	}
	function createEntry(key: RootPoolKey): Creation {
		const id = keyOf(key.hostId, key.root);
		const controller = new AbortController();
		const task = Promise.resolve().then(async (): Promise<{ ok: true } | { ok: false; code: string }> => {
			try {
				if (controller.signal.aborted) return { ok: false, code: "REQUEST_CANCELLED" };
				const value = await options.establish(key, controller.signal);
				if (disposed || controller.signal.aborted) {
					await options.retire({ key, value, connectionId: identityOf(value) }, disposed ? "dispose" : "explicit");
					return { ok: false, code: disposed ? "REMOTE_CONNECTION_SERVICE_DISPOSED" : "SSH_HOST_NOT_READY" };
				}
				// Transfer the reservation atomically; creating must not double-count a ready entry.
				creating.delete(id);
				entries.set(id, { ...key, value, lastUsedAt: now(), leases: 0, watchers: new Map(), live: true });
				counters.created += 1;
				diagnose("created");
				return { ok: true };
			} catch (error) {
				return { ok: false, code: stableCodeOf(error) };
			} finally {
				creating.delete(id);
				wake();
			}
		});
		const pending = { key, controller, users: 0, task };
		creating.set(id, pending);
		counters.peakEntries = Math.max(counters.peakEntries, slots());
		return pending;
	}
	/** Invalidate both ready entries and queued/creating work before the first await. */
	async function retireMatching(matches: (key: RootPoolKey) => boolean, reason: RootPoolRetireReason): Promise<void> {
		for (const request of acquisitions)
			if (matches(request.key)) {
				request.code = disposed ? "REMOTE_CONNECTION_SERVICE_DISPOSED" : "SSH_HOST_NOT_READY";
				request.controller.abort();
			}
		const pending = [...creating.values()].filter((item) => matches(item.key));
		for (const item of pending) item.controller.abort();
		const tasks = [...entries.values()].filter(matches).map((entry) => retire(entry, reason));
		for (const [id, pendingRetirement] of retiring) {
			const [hostId, root] = id.split("\u0000");
			if (matches({ hostId, root })) tasks.push(pendingRetirement.task);
		}
		await Promise.all([...tasks, ...pending.map((item) => item.task)]);
	}
	return {
		async acquire(key, acquireOptions = {}) {
			const request: Acquisition = { key, controller: new AbortController(), code: "REQUEST_CANCELLED" };
			const signal = acquireOptions.signal;
			const abort = (): void => request.controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			acquisitions.add(request);
			const id = keyOf(key.hostId, key.root);
			const deadline = now() + policy.acquireTimeoutMs;
			let waited = false;
			try {
				for (;;) {
					if (disposed) return { ok: false, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
					if (request.controller.signal.aborted) return { ok: false, code: request.code };
					const existing = entries.get(id);
					if (existing !== undefined) {
						counters.hits += 1;
						return { ok: true, lease: makeLease(existing) };
					}
					const pending = creating.get(id);
					if (pending !== undefined) {
						const result = await joinCreation(pending, request);
						if (!result.ok) return result;
						continue;
					}
					if (retiring.has(id) || slots() >= policy.maxEntries) {
						if (now() >= deadline) {
							counters.waitTimeouts += 1;
							diagnose("wait-timeout");
							return { ok: false, code: "SSH_ROOT_POOL_BUSY" };
						}
						if (!waited) {
							counters.waits += 1;
							waited = true;
						}
						const victim = retiring.has(id) ? undefined : idleEntries()[0];
						if (victim) void retire(victim, "lru");
						await waitForSlot(deadline, request.controller.signal);
						continue;
					}
					counters.misses += 1;
					const result = await joinCreation(createEntry(key), request);
					if (!result.ok) return result;
					if (request.controller.signal.aborted) return { ok: false, code: request.code };
					const created = entries.get(id);
					if (created) return { ok: true, lease: makeLease(created) };
				}
			} finally {
				acquisitions.delete(request);
				signal?.removeEventListener("abort", abort);
				if (request.controller.signal.aborted) wake();
			}
		},
		peek(hostId, root) {
			const entry = entries.get(keyOf(hostId, root));
			return entry === undefined ? undefined : viewOf(entry);
		},
		entries: () => [...entries.values()].map(viewOf),
		retainWatch(hostId, root, connectionId) {
			const entry = entries.get(keyOf(hostId, root));
			if (entry === undefined || identityOf(entry.value) !== connectionId) return false;
			entry.watchers.set(connectionId, (entry.watchers.get(connectionId) ?? 0) + 1);
			entry.lastUsedAt = now();
			return true;
		},
		releaseWatch(hostId, root, connectionId) {
			const entry = entries.get(keyOf(hostId, root));
			if (entry === undefined || !entry.watchers.has(connectionId)) return;
			const remaining = (entry.watchers.get(connectionId) ?? 0) - 1;
			if (remaining > 0) entry.watchers.set(connectionId, remaining);
			else entry.watchers.delete(connectionId);
			entry.lastUsedAt = now();
			wake();
		},
		retireRoot: (hostId, root, reason) => retireMatching((key) => key.hostId === hostId && key.root === root, reason),
		retireHost: (hostId, reason) => retireMatching((key) => key.hostId === hostId, reason),
		async sweep(at = now()) {
			const before = stats();
			for (const entry of idleEntries()) if (idle(entry) && at - entry.lastUsedAt >= policy.idleTtlMs) await retire(entry, "ttl");
			// Recompute after every await: a candidate may have acquired a lease or watcher.
			for (;;) {
				const candidates = idleEntries();
				if (candidates.length <= policy.idleCapacity) break;
				await retire(candidates[0], "lru");
			}
			if (before.entries > 0 || before.creating > 0 || before.retiring > 0) diagnose("sweep", before);
		},
		stats,
		dispose() {
			disposing ??= (async () => {
				disposed = true;
				await retireMatching(() => true, "dispose");
				diagnose("dispose");
			})();
			return disposing;
		},
	};
}
