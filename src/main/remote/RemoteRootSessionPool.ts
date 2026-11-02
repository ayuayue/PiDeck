/**
 * 同主机多项目 root 会话池（main 私有；默认关闭，由连接服务的构造参数启用）。
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

/** ADR §5.2 的候选值：保温 2 / TTL 10 分钟；预算与等待是可配置的保守默认。 */
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
	readonly idle: number;
	readonly leased: number;
	readonly watched: number;
	readonly hits: number;
	readonly misses: number;
	readonly created: number;
	readonly retired: number;
	readonly evictedIdle: number;
	readonly waits: number;
	readonly waitTimeouts: number;
	readonly peakEntries: number;
};

export type RootSessionPoolOptions<T> = {
	policy?: Partial<RootPoolPolicy>;
	/**
	 * 建立一个新会话。同 key 并发只会调用一次；`signal` 在调用方取消时触发，实现应把它接到自己的等待上。
	 * 抛出的稳定码原样交给调用方（例如 `SSH_PROJECT_ROOT_CHANGED`），因此建立失败不会被伪装成池故障。
	 */
	establish: (key: RootPoolKey, signal: AbortSignal) => Promise<T>;
	/** 回收一个会话（agent: manager.dispose()）。只在下述时机调用：淘汰、退休、主机失效、服务关闭。 */
	retire: (entry: { key: RootPoolKey; value: T; connectionId: string }, reason: RootPoolRetireReason) => void | Promise<void>;
	/** 会话身份（`RemoteProjectSession.connectionId`）。事实缓存与渲染层按它换代。 */
	identity?: (value: T) => string;
	/** 条目被回收后的通知（root 退休 ≠ 主机断开，调用方据此只清这个 root 的订阅）。 */
	onRetired?: (event: { hostId: string; root: string; connectionId: string; reason: RootPoolRetireReason }) => void;
	now?: () => number;
};

export type RootSessionPool<T> = {
	/** 取得一份租约；命中直接复用，未命中在容量内建立，满载则可取消/有超时地等待。 */
	acquire(key: RootPoolKey, options?: { signal?: AbortSignal }): Promise<RootPoolAcquireResult<T>>;
	/** 只读查询：该 root 当前是否有存活会话。**不建立、不延长寿命**。 */
	peek(hostId: string, root: string): RootPoolEntryView<T> | undefined;
	entries(): readonly RootPoolEntryView<T>[];
	/** 订阅保活：登记该 root 还挂着 watcher。返回 false 表示当前没有会话可保活。 */
	retainWatch(hostId: string, root: string): boolean;
	releaseWatch(hostId: string, root: string): void;
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
	watchers: number;
	live: boolean;
};

const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

/** 建立失败只交稳定码：把传输层的任意消息带到上层会把路径/命令泄进 UI。 */
function stableCodeOf(error: unknown): string {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return typeof message === "string" && STABLE_CODE.test(message) ? message : "SSH_HOST_NOT_READY";
}

export function createRootSessionPool<T>(options: RootSessionPoolOptions<T>): RootSessionPool<T> {
	const policy: RootPoolPolicy = { ...ROOT_POOL_DEFAULT_POLICY, ...options.policy };
	if (!Number.isInteger(policy.idleCapacity) || policy.idleCapacity < 0) throw new Error("REMOTE_ROOT_POOL_POLICY_INVALID");
	if (!Number.isFinite(policy.idleTtlMs) || policy.idleTtlMs <= 0) throw new Error("REMOTE_ROOT_POOL_POLICY_INVALID");
	if (!Number.isInteger(policy.maxEntries) || policy.maxEntries < 1) throw new Error("REMOTE_ROOT_POOL_POLICY_INVALID");
	if (!Number.isFinite(policy.acquireTimeoutMs) || policy.acquireTimeoutMs <= 0) throw new Error("REMOTE_ROOT_POOL_POLICY_INVALID");
	const now = options.now ?? Date.now;
	const entries = new Map<string, Entry<T>>();
	/** 同 key 的在途建立：并发 acquire 共享同一次 bootstrap，而不是各建一条 helper。 */
	const creating = new Map<string, Promise<{ ok: true } | { ok: false; code: string }>>();
	/** 满载时的有界等待队列（FIFO）；每个等待者有自己的超时与取消。 */
	const waiters: (() => void)[] = [];
	const counters = { hits: 0, misses: 0, created: 0, retired: 0, evictedIdle: 0, waits: 0, waitTimeouts: 0, peakEntries: 0 };
	let disposed = false;
	let disposing: Promise<void> | undefined;
	const keyOf = (hostId: string, root: string): string => hostId + "\u0000" + root;
	const identityOf = (value: T): string => options.identity?.(value) ?? "";
	const viewOf = (entry: Entry<T>): RootPoolEntryView<T> => ({ hostId: entry.hostId, root: entry.root, connectionId: identityOf(entry.value), value: entry.value, leases: entry.leases, watchers: entry.watchers, lastUsedAt: entry.lastUsedAt });
	/** 唤醒一个等待者：腾出的位置按到达顺序给最早等待的人。 */
	function wakeSlot(): void {
		const next = waiters.shift();
		next?.();
	}
	function makeLease(entry: Entry<T>): RootPoolLease<T> {
		let released = false;
		return {
			hostId: entry.hostId,
			root: entry.root,
			get connectionId() {
				return identityOf(entry.value);
			},
			value: entry.value,
			release() {
				if (released) return;
				released = true;
				entry.leases = Math.max(0, entry.leases - 1);
				entry.lastUsedAt = now();
				// 只有仍活着的条目才值得唤醒等待者：已退休的条目早就把位置让出来了。
				if (entry.live) wakeSlot();
			},
		};
	}
	async function retire(entry: Entry<T>, reason: RootPoolRetireReason): Promise<void> {
		if (!entry.live) return;
		entry.live = false;
		entries.delete(keyOf(entry.hostId, entry.root));
		counters.retired += 1;
		if (reason === "lru") counters.evictedIdle += 1;
		// 先让出位置再等待销毁：销毁是异步的（manager.dispose），不该让同主机其它项目的等待者排在它后面。
		wakeSlot();
		try {
			await options.retire({ key: { hostId: entry.hostId, root: entry.root }, value: entry.value, connectionId: identityOf(entry.value) }, reason);
		} catch {
			// 销毁失败不改变「已退休」这一事实：条目已从登记表移除，旧会话不会再被复用；残留进程由退出清理兜底。
		}
		// 退休通知在销毁之后：调用方要退的是「已经决定不再使用」的订阅，而不是一条正在被优雅关闭的会话。
		options.onRetired?.({ hostId: entry.hostId, root: entry.root, connectionId: identityOf(entry.value), reason });
	}
	/** 满载时挑一个**既无租约也无订阅**的条目按 LRU 淘汰；没有可淘汰的就返回 false。 */
	async function evictOneIdle(): Promise<boolean> {
		let victim: Entry<T> | undefined;
		for (const entry of entries.values()) {
			if (!entry.live || entry.leases > 0 || entry.watchers > 0) continue;
			if (victim === undefined || entry.lastUsedAt < victim.lastUsedAt) victim = entry;
		}
		if (victim === undefined) return false;
		await retire(victim, "lru");
		return true;
	}
	/** 等一个位置；`true` = 有人让位，`false` = 超时或调用方取消。 */
	function waitForSlot(deadline: number, signal: AbortSignal | undefined): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let done = false;
			const waiter = (): void => finish(true);
			const finish = (freed: boolean): void => {
				if (done) return;
				done = true;
				remove();
				resolve(freed);
			};
			const remove = (): void => {
				cancelTimer(timer);
				signal?.removeEventListener("abort", onAbort);
				const index = waiters.indexOf(waiter);
				if (index >= 0) waiters.splice(index, 1);
			};
			const timer = delayTimer(() => finish(false), Math.max(0, deadline - now()));
			const onAbort = (): void => finish(false);
			waiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	async function createEntry(key: RootPoolKey, signal: AbortSignal | undefined): Promise<{ ok: true } | { ok: false; code: string }> {
		const id = keyOf(key.hostId, key.root);
		const controller = new AbortController();
		const onAbort = (): void => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted === true) controller.abort();
		const task = (async (): Promise<{ ok: true } | { ok: false; code: string }> => {
			try {
				const value = await options.establish(key, controller.signal);
				// 建立期间服务被关闭：不能把一个没人拥有的会话留在池里。
				if (disposed) {
					await Promise.resolve(options.retire({ key, value, connectionId: identityOf(value) }, "dispose")).catch(() => undefined);
					return { ok: false, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
				}
				const existing = entries.get(id);
				if (existing !== undefined && existing.live) {
					// 同 key 的另一条创建路径赢了这个位置（例如被上一次超时放弃的建立最终成功）：只保留一个条目。
					await Promise.resolve(options.retire({ key, value, connectionId: identityOf(value) }, "explicit")).catch(() => undefined);
					return { ok: true };
				}
				entries.set(id, { hostId: key.hostId, root: key.root, value, lastUsedAt: now(), leases: 0, watchers: 0, live: true });
				counters.created += 1;
				counters.peakEntries = Math.max(counters.peakEntries, entries.size);
				return { ok: true };
			} catch (error) {
				return { ok: false, code: stableCodeOf(error) };
			}
		})();
		creating.set(id, task);
		try {
			return await task;
		} finally {
			if (creating.get(id) === task) creating.delete(id);
			signal?.removeEventListener("abort", onAbort);
			// 建立失败也意味着这个「创建中」的位置结束了，等待者应当重新尝试而不是干等超时。
			wakeSlot();
		}
	}
	return {
		async acquire(key, acquireOptions = {}) {
			if (disposed) return { ok: false, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
			const signal = acquireOptions.signal;
			// 每次检查都重新读一次：把 bus/abort 的判定集中成一个入口，避免在循环里被 TS 的常量窄化误导。
			const isAborted = (): boolean => signal?.aborted === true;
			if (isAborted()) return { ok: false, code: "REQUEST_CANCELLED" };
			const id = keyOf(key.hostId, key.root);
			const deadline = now() + policy.acquireTimeoutMs;
			for (;;) {
				if (disposed) return { ok: false, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
				if (isAborted()) return { ok: false, code: "REQUEST_CANCELLED" };
				const existing = entries.get(id);
				if (existing !== undefined && existing.live) {
					counters.hits += 1;
					existing.leases += 1;
					existing.lastUsedAt = now();
					return { ok: true, lease: makeLease(existing) };
				}
				const pending = creating.get(id);
				if (pending !== undefined) {
					// 同 key 并发：等那一次建立，合并成一条会话（绝不各建一条 helper）。
					const settled = await pending;
					if (!settled.ok) return settled;
					const shared = entries.get(id);
					if (shared !== undefined && shared.live) {
						counters.hits += 1;
						shared.leases += 1;
						shared.lastUsedAt = now();
						return { ok: true, lease: makeLease(shared) };
					}
					continue;
				}
				// 在途建立也占预算：它们各会变成一条真实 helper，若不计数，满载时会被静默超额。
				if (entries.size + creating.size >= policy.maxEntries) {
					counters.waits += 1;
					if (await evictOneIdle()) continue;
					const freed = await waitForSlot(deadline, signal);
					if (!freed) {
						counters.waitTimeouts += 1;
						return { ok: false, code: isAborted() ? "REQUEST_CANCELLED" : "SSH_ROOT_POOL_BUSY" };
					}
					continue;
				}
				counters.misses += 1;
				const createdResult = await createEntry(key, signal);
				if (!createdResult.ok) return createdResult;
				// 这一次调用自己建立的条目：发租约但不记 hit（hit 只统计「复用了别人建立/已有的会话」）。
				const createdEntry = entries.get(id);
				if (createdEntry === undefined || !createdEntry.live) continue;
				createdEntry.leases += 1;
				createdEntry.lastUsedAt = now();
				return { ok: true, lease: makeLease(createdEntry) };
			}
		},
		peek(hostId, root) {
			const entry = entries.get(keyOf(hostId, root));
			return entry === undefined || !entry.live ? undefined : viewOf(entry);
		},
		entries() {
			return [...entries.values()].filter((entry) => entry.live).map(viewOf);
		},
		retainWatch(hostId, root) {
			const entry = entries.get(keyOf(hostId, root));
			if (entry === undefined || !entry.live) return false;
			entry.watchers += 1;
			entry.lastUsedAt = now();
			return true;
		},
		releaseWatch(hostId, root) {
			const entry = entries.get(keyOf(hostId, root));
			if (entry === undefined) return;
			entry.watchers = Math.max(0, entry.watchers - 1);
			entry.lastUsedAt = now();
		},
		async retireRoot(hostId, root, reason) {
			const entry = entries.get(keyOf(hostId, root));
			if (entry !== undefined) await retire(entry, reason);
		},
		async retireHost(hostId, reason) {
			const victims = [...entries.values()].filter((entry) => entry.hostId === hostId);
			for (const entry of victims) await retire(entry, reason);
		},
		async sweep(at = now()) {
			// 只有「既无租约也无订阅」的条目才进入候选：活跃操作与在挂监听都不会被这里回收。
			const idle = [...entries.values()].filter((entry) => entry.live && entry.leases === 0 && entry.watchers === 0);
			for (const entry of idle) if (at - entry.lastUsedAt >= policy.idleTtlMs) await retire(entry, "ttl");
			const remaining = [...entries.values()].filter((entry) => entry.live && entry.leases === 0 && entry.watchers === 0).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
			let over = remaining.length - policy.idleCapacity;
			for (const entry of remaining) {
				if (over <= 0) break;
				over -= 1;
				await retire(entry, "lru");
			}
		},
		stats() {
			const all = [...entries.values()].filter((entry) => entry.live);
			return {
				entries: all.length,
				idle: all.filter((entry) => entry.leases === 0 && entry.watchers === 0).length,
				leased: all.filter((entry) => entry.leases > 0).length,
				watched: all.filter((entry) => entry.watchers > 0).length,
				hits: counters.hits,
				misses: counters.misses,
				created: counters.created,
				retired: counters.retired,
				evictedIdle: counters.evictedIdle,
				waits: counters.waits,
				waitTimeouts: counters.waitTimeouts,
				peakEntries: counters.peakEntries,
			};
		},
		dispose() {
			disposing ??= (async () => {
				disposed = true;
				for (const waiter of waiters.splice(0, waiters.length)) waiter();
				const victims = [...entries.values()];
				await Promise.all(victims.map((entry) => retire(entry, "dispose")));
			})();
			return disposing;
		},
	};
}
