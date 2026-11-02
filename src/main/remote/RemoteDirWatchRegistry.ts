/**
 * 目录订阅登记表（helper 1.24.0 的 `fs.watch` → 事实失效）。
 *
 * 事件帧只带 `watchId`，不带项目：所以「哪个项目的哪些目录」必须由发起订阅的一方登记下来。这里就是
 * 那份登记表，只做三件事：
 *
 * 1. **身份来自真实 helper 生命周期**：`sessionKey` 由主进程给出（`RemoteProjectSession.connectionId`
 *    = `hostId#managerToken#generation`）。同一次 helper 会话里，每次读都会新建一个 session 包装对象，
 *    但它们必须映射到同一个 key；重连/换根/换 manager 必须映射到不同的 key。**不能用包装对象本身**，
 *    否则同一会话的每次读都会再订一个 watcher，直到 helper 的 4 个 watcher 上限把后来的订阅全拒掉。
 * 2. **同主机多会话互不相干**：登记表是 `hostId → sessionKey → 一代`。root 池让同一台主机同时存在
 *    多个 helper 会话（每个 root 一条），它们各自有 4 watcher × 32 路径预算；两个 helper 返回同一个
 *    `watchId` 也必须各自解析到自己的项目范围——所以查事件必须带会话身份
 *    （`scopesForEvent(hostId, sessionKey, watchId)`），`watchId` 不是全局键。
 * 3. **只算范围、不碰缓存**：它把 (host, session, watchId) 换回一组 `项目 + 目录` 范围，标脏由调用方
 *    完成，所以这个模块不依赖事实层，也不依赖 IPC。
 *
 * helper 的物理上限是**每个会话 4 个 watchId、每个最多 32 条路径**（不是 4 个目录），预算跟着会话走：
 * 别的 root 的会话占满预算不影响本会话。超限时拒绝而不是排队：订阅是降级能力，读成功不因订阅失败而
 * 报错，但也不能假装已经订阅成功。
 *
 * **订阅保活**（`keepAlive`）：池化后「watcher 还挂着」是会话不能被回收的唯一信号，而登记表是唯一
 * 知道「某会话现在有没有 watch」的地方。所以它负责在某会话 0→1 个 watch 时 `retain` 一次、1→0 时
 * `release` 一次；池的保活计数只是加减法，配对是硬要求，因此每条清空路径（释放项目/释放会话/清主机/
 * 全部释放）都必须走到 `release`。
 */

import { parentDirOf } from "./RemoteWorkspaceView";

export type DirWatchScope = { projectId: string; paths: readonly string[] };

/** 会话身份：`RemoteProjectSession.connectionId`（`hostId#managerToken#generation`）。 */
export type DirWatchSessionKey = string;

/** helper 契约里的真实上限（按会话计）；`remoteHelperEntry` 的方法测试与本表的策略都以它为准。 */
export const DIR_WATCH_LIMITS = { watchersPerSession: 4, pathsPerWatcher: 32 } as const;

/** 订阅保活端口：池化「这个会话还挂着 watcher，不能回收」的唯一入口。 */
export type DirWatchKeepAlive = {
	/** 会话从「0 个 watch」变成「有 watch」时调用一次。 */
	retain(sessionKey: DirWatchSessionKey): void;
	/** 会话的 watch 全部消失（退订/换项目/清理）时调用一次，与 retain 严格配对。 */
	release(sessionKey: DirWatchSessionKey): void;
};

export type DirWatchRegistryOptions = {
	/** 可选：把「会话现在有没有 watch」转成池的保活计数。缺省不保活（旧单会话路径）。 */
	keepAlive?: DirWatchKeepAlive;
};

export type DirWatchEnsureOptions = {
	/** 要监听的目录（项目根相对；根目录是空串）。省略时只监听根目录。 */
	paths?: readonly string[];
	/** 成对退订：登记表在项目关闭/连接释放时调用它（helper 已死时调用会失败，忽略即可）。 */
	unwatch?: (watchId: string) => Promise<unknown>;
	/**
	 * 一次性 rewatch：先摘掉本项目在本会话的登记（helper 的 watcher 路径集不可扩展，只能整组重订），
	 * 再按请求路径分片订阅。摘掉的旧登记**不触发 keepAlive.release**——紧接着就会重新登记，订阅保活
	 * 不能在这段窗口里掉（否则池可能恰好回收这条会话，rewatch 就订到一条正在关闭的 helper 上）。
	 */
	replaceProject?: boolean;
};

/**
 * 一次 ensure 的结果：`rejected` 是因为 **4 watcher 上限**被拒的路径块数。
 *
 * 只有上限拒绝才计数：helper 不支持订阅（拿不到 watchId）不算「降级到上限」，调用方据此区分
 * 「订阅能力缺失」与「预算用满」——后者必须留下可断言的状态，不能假装覆盖。
 */
export type DirWatchEnsureResult = { rejected: number };

export type DirWatchRegistry = {
	/**
	 * 为 (连接, 项目) 建立订阅。`subscribe` 由调用方提供（它才知道怎么发请求），返回 `watchId`；
	 * 返回 undefined/空串表示 helper 不支持或不给 id（静默降级到只读刷新）。
	 */
	ensure(hostId: string, sessionKey: DirWatchSessionKey, projectId: string, subscribe: (paths: readonly string[]) => Promise<string | undefined>, options?: DirWatchEnsureOptions): Promise<DirWatchEnsureResult>;
	/**
	 * 事件 → 应标脏的范围；**必须带会话身份**：会话不匹配（别的 root 的会话、旧会话、已释放）返回
	 * undefined，绝不拿同主机别的会话的登记去猜项目。
	 */
	scopesForEvent(hostId: string, sessionKey: DirWatchSessionKey, watchId: string): DirWatchScope[] | undefined;
	/** 某个项目在该主机**全部会话**上已被覆盖的路径（去重）；诊断用。 */
	pathsOf(hostId: string, projectId: string): string[];
	/** 某个项目在**指定会话**上已被覆盖的路径（去重）。深层订阅据此判断「还要不要 rewatch」。 */
	pathsOfSession(hostId: string, sessionKey: DirWatchSessionKey, projectId: string): string[];
	/** 诊断/测试：该主机全部会话当前登记了几条订阅。 */
	sizeOf(hostId: string): number;
	/** 诊断/测试：指定会话当前登记了几条订阅（4 条上限按它判定）。 */
	sizeOfSession(hostId: string, sessionKey: DirWatchSessionKey): number;
	/** 诊断/测试：该主机全部会话的 watchId。 */
	watchIdsOf(hostId: string): string[];
	/** 诊断/测试：指定会话的 watchId。 */
	watchIdsOfSession(hostId: string, sessionKey: DirWatchSessionKey): string[];
	/** 释放一条会话（显式断开/root 退休）：只动这个会话，先成对退订再清登记。 */
	releaseHost(hostId: string, sessionKey: DirWatchSessionKey): Promise<void>;
	/** 丢弃一条会话且**不发退订**（该 helper 已死）：同主机其它会话不受影响。 */
	clearSession(hostId: string, sessionKey: DirWatchSessionKey): void;
	/** 项目关闭：退订该项目在该主机**全部会话**上的订阅，不影响别的项目。 */
	releaseProject(hostId: string, projectId: string): Promise<void>;
	/** 退订一个项目在**指定会话**里的订阅（换代时只清本项目在旧会话的登记）。 */
	releaseProjectInSession(hostId: string, sessionKey: DirWatchSessionKey, projectId: string): Promise<void>;
	/** 项目关闭（不知道 host 时）：扫全部 host 的全部会话，退订这个项目的订阅。 */
	closeProject(projectId: string): Promise<void>;
	/** helper 已死（断连/宿主销毁）：该主机的全部会话直接丢弃，不再发退订。 */
	clearHost(hostId: string): void;
	/** 全部成对退订后丢弃（进程退出）。 */
	releaseAll(): Promise<void>;
	/** 全部丢弃（不回退订）。 */
	clearAll(): void;
};

/**
 * 一次写要让哪些目录事实失效：写到的路径所在目录 + 它的父目录（目录自身的 mtime/子项数也变了）。
 * 返回去重后的**项目相对目录路径**（根层是空串）。
 */
export function dirPathsAfterWrite(paths: readonly string[]): string[] {
	const touched = new Set<string>();
	for (const path of paths) {
		const parent = parentDirOf(path);
		touched.add(parent);
		if (parent !== "") touched.add(parentDirOf(parent));
	}
	return [...touched];
}

/**
 * 同上，直接返回事实缓存的 `项目 + 目录` 键（调用方不用自己拼分隔符）。
 */
export function dirKeysAfterWrite(projectId: string, paths: readonly string[]): string[] {
	return dirPathsAfterWrite(paths).map((path) => projectId + "\u0000" + path);
}

/** 登记表里的一条 helper 会话（一个 root 一条；同主机可以同时有多条）。 */
type SessionRecord = {
	readonly hostId: string;
	readonly sessionKey: DirWatchSessionKey;
	unwatch?: (watchId: string) => Promise<unknown>;
	/** watchId → 它监听的范围。 */
	watches: Map<string, DirWatchScope>;
	/** 「项目 + 路径组」签名 → 在途订阅（同 key 并发 ensure 只发一次请求）。 */
	pending: Map<string, Promise<void>>;
	/** keepAlive 是否已 retain：保证 0→1 只 retain 一次、1→0 只 release 一次。 */
	leased: boolean;
};

export function createDirWatchRegistry(options: DirWatchRegistryOptions = {}): DirWatchRegistry {
	const keepAlive = options.keepAlive;
	/** hostId → (sessionKey → 该 helper 会话的登记)。 */
	const byHost = new Map<string, Map<string, SessionRecord>>();

	const sessionOf = (hostId: string, sessionKey: DirWatchSessionKey): SessionRecord | undefined => byHost.get(hostId)?.get(sessionKey);
	const sessionsOf = (hostId: string): SessionRecord[] => [...(byHost.get(hostId)?.values() ?? [])];

	const retainLease = (record: SessionRecord): void => {
		if (record.leased) return;
		record.leased = true;
		keepAlive?.retain(record.sessionKey);
	};

	const releaseLease = (record: SessionRecord): void => {
		if (!record.leased) return;
		record.leased = false;
		keepAlive?.release(record.sessionKey);
	};

	/** 摘掉一条会话的登记（只摘自己：同 key 若已被新记录顶替，不动新记录）。 */
	const forgetSession = (record: SessionRecord): void => {
		const sessions = byHost.get(record.hostId);
		if (sessions === undefined || sessions.get(record.sessionKey) !== record) return;
		sessions.delete(record.sessionKey);
		if (sessions.size === 0) byHost.delete(record.hostId);
	};

	/**
	 * 空会话不留登记：没有 watch、也没有在途订阅的记录再也不可能被事件命中，留着只会让「换代」累积。
	 * 在途订阅还在时不摘（它完成后要按记录身份判断是否登记），由那条路径自己收尾。
	 */
	const pruneIfIdle = (record: SessionRecord): void => {
		if (record.watches.size > 0 || record.pending.size > 0) return;
		forgetSession(record);
	};

	const watchedPathsOf = (record: SessionRecord, projectId: string): Set<string> => {
		const watched = new Set<string>();
		for (const scope of record.watches.values()) if (scope.projectId === projectId) for (const path of scope.paths) watched.add(path);
		return watched;
	};

	const unwatchOne = async (record: SessionRecord, watchId: string): Promise<void> => {
		const unwatch = record.unwatch;
		if (unwatch === undefined) return;
		try {
			await unwatch(watchId);
		} catch {
			// 退订是清理动作，不是读的前置条件：会话已死/已换代时失败即可，不向上抛。
		}
	};

	const unwatchAll = async (record: SessionRecord, watchIds: readonly string[]): Promise<void> => {
		for (const watchId of watchIds) await unwatchOne(record, watchId);
	};

	/**
	 * 退订一条会话里匹配的范围。**先摘登记再发退订**：移除是同步的，池的保活计数与事件路由立刻回到
	 * 「没有 watch」这一事实；退订失败（helper 已死）也不会留下仍被认作有效的 watchId。
	 */
	const dropWatches = async (record: SessionRecord, matches: (scope: DirWatchScope) => boolean): Promise<void> => {
		const victims = [...record.watches].filter(([, scope]) => matches(scope)).map(([watchId]) => watchId);
		for (const watchId of victims) record.watches.delete(watchId);
		if (record.watches.size === 0) {
			releaseLease(record);
			pruneIfIdle(record);
		}
		await unwatchAll(record, victims);
	};

	return {
		async ensure(hostId, sessionKey, projectId, subscribe, options = {}) {
			let sessions = byHost.get(hostId);
			let record = sessions?.get(sessionKey);
			if (record === undefined) {
				record = { hostId, sessionKey, watches: new Map(), pending: new Map(), leased: false, ...(options.unwatch === undefined ? {} : { unwatch: options.unwatch }) };
				if (sessions === undefined) {
					sessions = new Map();
					byHost.set(hostId, sessions);
				}
				sessions.set(sessionKey, record);
			} else if (record.unwatch === undefined && options.unwatch !== undefined) {
				record.unwatch = options.unwatch;
			}

			/** 收尾：会话没有 watch 了才还保活租约（replaceProject 的中间态不算「变空」）。 */
			const finalize = (): void => {
				if (record.watches.size === 0) releaseLease(record);
				pruneIfIdle(record);
			};

			const requested = [...new Set(options.paths ?? [""])];
			if (options.replaceProject === true) {
				// 旧 watcher 的路径集不可扩展：先成对退订本项目的旧集合，再按全量分片。
				// 退订先于新订阅：helper 的 4 watcher 上限是远端事实，旧 watcher 不摘掉新请求会被拒。
				const victims = [...record.watches].filter(([, scope]) => scope.projectId === projectId).map(([watchId]) => watchId);
				for (const watchId of victims) record.watches.delete(watchId);
				await unwatchAll(record, victims);
			}
			const watched = watchedPathsOf(record, projectId);
			const missing = requested.filter((path) => !watched.has(path));
			if (missing.length === 0) {
				finalize();
				return { rejected: 0 };
			}
			let rejected = 0;
			// helper 每个 watcher 最多 32 条路径；多出来的路径只能靠下一个 watcher，绝不一次性发超限请求。
			for (let offset = 0; offset < missing.length; offset += DIR_WATCH_LIMITS.pathsPerWatcher) {
				// 上一块期间这条会话被释放：后面的块不再发请求（这个会话已经没有身份）。
				if (byHost.get(hostId)?.get(sessionKey) !== record) break;
				const chunk = missing.slice(offset, offset + DIR_WATCH_LIMITS.pathsPerWatcher);
				const signature = projectId + "\u0000" + chunk.join("\u0000");
				const running = record.pending.get(signature);
				if (running !== undefined) {
					await running;
					continue;
				}
				const task = (async () => {
					// 上限在发请求前就要判：这条会话的第 5 个 watcher 一定是拒绝，不是排队。
					if (record.watches.size >= DIR_WATCH_LIMITS.watchersPerSession) {
						rejected += 1;
						return;
					}
					const watchId = await subscribe([...chunk]);
					if (watchId === undefined || watchId === "") return;
					// 订阅在途时会话被释放/被替换：这个 id 不属于任何仍登记的身份，成对收回，不登记。
					if (byHost.get(hostId)?.get(sessionKey) !== record) {
						await unwatchOne(record, watchId);
						return;
					}
					// 等待期间配额被别的项目用完：退掉这个刚建好的，别偷偷超限。
					if (record.watches.size >= DIR_WATCH_LIMITS.watchersPerSession) {
						await unwatchOne(record, watchId);
						rejected += 1;
						return;
					}
					const wasEmpty = record.watches.size === 0;
					record.watches.set(watchId, { projectId, paths: [...chunk] });
					// 0→1 才 retain：同一会话的第 2、3 个 watcher 不再加保活计数。
					if (wasEmpty) retainLease(record);
				})();
				record.pending.set(signature, task);
				try {
					await task;
				} finally {
					if (record.pending.get(signature) === task) record.pending.delete(signature);
				}
			}
			finalize();
			return { rejected };
		},
		scopesForEvent(hostId, sessionKey, watchId) {
			const scope = sessionOf(hostId, sessionKey)?.watches.get(watchId);
			// 未登记 = 不是这个会话发起的（别的 root 的会话、旧会话、已撤销）：忽略比猜更安全。
			return scope === undefined ? undefined : [scope];
		},
		pathsOf(hostId, projectId) {
			const paths = new Set<string>();
			for (const record of sessionsOf(hostId)) for (const path of watchedPathsOf(record, projectId)) paths.add(path);
			return [...paths];
		},
		pathsOfSession(hostId, sessionKey, projectId) {
			const record = sessionOf(hostId, sessionKey);
			return record === undefined ? [] : [...watchedPathsOf(record, projectId)];
		},
		sizeOf(hostId) {
			let size = 0;
			for (const record of sessionsOf(hostId)) size += record.watches.size;
			return size;
		},
		sizeOfSession: (hostId, sessionKey) => sessionOf(hostId, sessionKey)?.watches.size ?? 0,
		watchIdsOf(hostId) {
			const ids: string[] = [];
			for (const record of sessionsOf(hostId)) ids.push(...record.watches.keys());
			return ids;
		},
		watchIdsOfSession: (hostId, sessionKey) => [...(sessionOf(hostId, sessionKey)?.watches.keys() ?? [])],
		async releaseHost(hostId, sessionKey) {
			const record = sessionOf(hostId, sessionKey);
			// 只释放自己这条会话：迟到的清理不能把同主机别的 root 的 watcher 关掉。
			if (record === undefined) return;
			forgetSession(record);
			releaseLease(record);
			const victims = [...record.watches.keys()];
			record.watches.clear();
			await unwatchAll(record, victims);
		},
		clearSession(hostId, sessionKey) {
			const record = sessionOf(hostId, sessionKey);
			// helper 已死：退订请求只会失败，直接丢弃登记；同主机其它会话不受影响。
			if (record === undefined) return;
			forgetSession(record);
			releaseLease(record);
			record.watches.clear();
		},
		async releaseProject(hostId, projectId) {
			for (const record of sessionsOf(hostId)) await dropWatches(record, (scope) => scope.projectId === projectId);
		},
		async releaseProjectInSession(hostId, sessionKey, projectId) {
			const record = sessionOf(hostId, sessionKey);
			if (record === undefined) return;
			await dropWatches(record, (scope) => scope.projectId === projectId);
		},
		async closeProject(projectId) {
			for (const [hostId] of [...byHost]) for (const record of sessionsOf(hostId)) await dropWatches(record, (scope) => scope.projectId === projectId);
		},
		clearHost(hostId) {
			const sessions = byHost.get(hostId);
			if (sessions === undefined) return;
			byHost.delete(hostId);
			for (const record of sessions.values()) {
				releaseLease(record);
				record.watches.clear();
			}
		},
		async releaseAll() {
			const records: SessionRecord[] = [];
			for (const sessions of byHost.values()) records.push(...sessions.values());
			byHost.clear();
			const victims: [SessionRecord, string[]][] = [];
			for (const record of records) {
				releaseLease(record);
				victims.push([record, [...record.watches.keys()]]);
				record.watches.clear();
			}
			for (const [record, watchIds] of victims) await unwatchAll(record, watchIds);
		},
		clearAll() {
			for (const sessions of byHost.values()) {
				for (const record of sessions.values()) {
					releaseLease(record);
					record.watches.clear();
				}
			}
			byHost.clear();
		},
	};
}
