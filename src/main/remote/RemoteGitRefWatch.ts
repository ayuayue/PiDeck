/**
 * 远端 refs 变化订阅（`git:remote-watch-refs` / `git:remote-unwatch-refs`）：**只标脏，不装载**。
 *
 * 解决的是「AI 在终端里 commit/push 之后，远端 Git 面板要等到下一轮 5 s 轮询才变」这条延迟：主进程为
 * 一个仓库订阅 `.git` 目录族的 helper `fs.watch`，事件到达时经事实 hub 发一条
 * `{ kind: "status", repoPath }`，面板据此自己重读。事件**不触发任何远端读**——读仍由活跃的消费者决定。
 *
 * 几条硬约束（与目录订阅同一套，但登记独立）：
 *
 * 1. **一个仓库只占 1 个 watcher**：4 条路径（`.git` / `.git/refs` / `.git/refs/heads` /
 *    `.git/refs/tags`）放进**一次** `fs.watch`；helper 的预算是每会话 4 个 watchId × 32 路径，分四次订
 *    会把预算烧光。同一 `(projectId, repoPath)` 被多个面板/文件树重复订阅时按引用计数复用同一个
 *    watchId（React 双挂载、分屏、侧栏都各订一次），并发的同键请求也只发一次远端请求。
 * 2. **身份来自真实 helper 会话**：`sessionKey` = `RemoteProjectSession.connectionId`，它同时就是
 *    `generationFor` 的口径（`service.projectConnectionFacts(hostId, root)?.connectionId`）。事件按
 *    `(hostId, sessionKey, helperWatchId)` 查登记：别的 root 的会话、旧会话的同名 watchId 一律不认。
 * 3. **降级而不是抛错**：helper 未声明 `fs.watch`、`.git` 不存在（裸仓库）或不是目录（worktree/submodule
 *    的 `.git` 是文件）、watcher 预算触顶（`TOO_MANY_REQUESTS`）都返回 `{ ok: false, code }`，由面板退回
 *    5 s 轮询。订阅是加速能力，不是读的前置条件。
 * 4. **成对收尾**：sender 销毁 / 项目关闭 / 进程退出尽量 `fs.unwatch`；主机断开与 root 退休时该 helper
 *    已经不在了，只丢登记、不发退订。退订**不新开会话**（复用订阅时的会话包装），否则一次退订会拉起
 *    一次 SSH 握手。
 * 5. **池保活**：登记存在期间对该 root 会话 `retainProjectSessionWatch`，最后一条退掉时 release。否则
 *    没有目录读的仓库会话会被池 TTL 回收，watcher 静默消失、面板以为还订阅着。
 */
import type { RemoteProjectFactsChange } from "../../shared/types/remoteHost";
import { codeOf } from "../../shared/op";
import type { RemoteGitLocator } from "../git/RemoteGitService";
import type { RemoteFactsHub } from "./RemoteFactsNotifications";

/** 订阅路径（项目相对 POSIX；`repoPath` 作为前缀）。顺序固定：`.git` 在前，诊断时一眼能读。 */
export const GIT_REF_WATCH_SUBPATHS = [".git", ".git/refs", ".git/refs/heads", ".git/refs/tags"] as const;

/** 一个仓库的订阅路径：`repoPath` 为空表示项目根仓库。 */
export function gitRefWatchPaths(repoPath: string): string[] {
	const prefix = repoPath === "" ? "" : repoPath + "/";
	return GIT_REF_WATCH_SUBPATHS.map((path) => prefix + path);
}

/** helper 会话的最小端口（`request` 已绑定 manager；`connectionId` 是稳定会话身份）。 */
export type GitRefWatchSession = {
	readonly connectionId: string;
	request(method: string, params?: unknown): Promise<unknown>;
};

/** 连接服务的最小端口：与 Git 读同一套（`withProjectSession` + 能力/项目会话事实 + 池保活）。 */
export type GitRefWatchService = {
	withProjectSession<T>(hostId: string, root: string, task: (session: GitRefWatchSession) => Promise<T>, options?: { requireReady?: boolean; signal?: AbortSignal }): Promise<{ ok: true; value: T } | { ok: false; code: string }>;
	projectHelperCapabilities?(hostId: string, root: string): readonly string[] | undefined;
	projectConnectionFacts?(hostId: string, root: string): { connectionId: string; state: string } | undefined;
	retainProjectSessionWatch?(hostId: string, root: string, connectionId: string): void;
	releaseProjectSessionWatch?(hostId: string, root: string, connectionId: string): void;
};

export type GitRefWatchOutcome = { ok: true; watchId: string } | { ok: false; code: string };

/** helper 事件帧（无 id、带 watchId）：与目录订阅共用同一个出口。 */
export type GitRefWatchHelperEvent = { hostId: string; watchId: string; paths: readonly string[]; sessionKey: string };

export type RemoteGitRefWatchOptions = {
	enabled: boolean;
	/** 与 Git 读同一套授权：项目 → (host, canonical root)。 */
	locator(projectId: string): RemoteGitLocator | undefined;
	/** 与 Git 读同一套信任：未确认的项目不订阅。 */
	trusted(target: RemoteGitLocator): Promise<boolean>;
	service(): GitRefWatchService | undefined | Promise<GitRefWatchService | undefined>;
	/** 事实变化通知出口（与目录/写面共用同一个 hub）；缺省时不发通知。 */
	factsEvents?: Pick<RemoteFactsHub, "publish">;
	/** 单个窗口最多同时订阅几个仓库（防渲染层泄漏把登记表撑大）。 */
	maxWatchesPerSender?: number;
};

export type RemoteGitRefWatch = {
	/** 订阅一个仓库的 refs 变化；返回的 watchId 供渲染层配对退订（同键重复订阅得到同一个 id）。 */
	watch(request: { projectId: string; repoPath: string; senderId: number }): Promise<GitRefWatchOutcome>;
	/** 退订一次（幂等）：该窗口对该 id 的引用归零且没有别的订阅者时才真正 `fs.unwatch`。 */
	unwatch(watchId: string, senderId: number): Promise<void>;
	/** helper 事件 → 一条 status 标脏通知。未登记的事件（别的会话/旧会话/已退订）直接忽略。 */
	onHelperEvent(entry: GitRefWatchHelperEvent): void;
	/** 窗口销毁：该窗口的全部订阅一起退掉（helper 还活着时成对退订）。 */
	forgetSender(senderId: number): Promise<void>;
	/** 主机断开：helper 已随会话一起死，只丢登记、不发退订。 */
	forgetHost(hostId: string): void;
	/** 一个 root 会话退休（TTL/LRU/显式）：只丢这条会话的登记，兄弟 root 不受影响。 */
	forgetSession(hostId: string, sessionKey: string): void;
	/** 项目关闭：退订该项目的全部仓库订阅（不为已关闭的项目继续产生通知）。 */
	forgetProject(projectId: string): Promise<void>;
	/** 项目集变化后清理已消失项目的登记（项目关闭的确定性收尾，不依赖事件是否再来）。 */
	pruneClosed(): Promise<void>;
	/** 诊断/测试：当前登记了几个仓库订阅。 */
	size(): number;
	/** 进程退出：成对退订后丢弃全部登记。 */
	dispose(): Promise<void>;
};

/** 一路登记的引用计数：同一仓库被多个面板/多次挂载订阅时只占一个 helper watcher。 */
type WatchEntry = {
	readonly watchId: string;
	readonly projectId: string;
	readonly repoPath: string;
	readonly hostId: string;
	/** 创建订阅时的 canonical root（池保活按 (host, root) 记账）。 */
	readonly root: string;
	/** helper 侧 watchId：`fs.unwatch` 要的就是它。 */
	readonly helperWatchId: string;
	/** 会话身份（= `generationFor`）：事件路由与通知里的 generation 都用它。 */
	readonly sessionKey: string;
	/** 订阅时的会话包装：退订直接复用，绝不为一次退订再建一条会话。 */
	readonly session: GitRefWatchSession;
	/** 订阅时的服务实例：池保活的 release 要它。 */
	readonly service: GitRefWatchService;
	/** senderId → 该窗口对这个 id 的引用次数。 */
	readonly refs: Map<number, number>;
};

type Established = { ok: true; entry: WatchEntry } | { ok: false; code: string };

const SEPARATOR = "\u0000";
const fail = (code: string): GitRefWatchOutcome => ({ ok: false, code });

export function createRemoteGitRefWatch(input: RemoteGitRefWatchOptions): RemoteGitRefWatch {
	const maxPerSender = Math.max(1, Math.trunc(input.maxWatchesPerSender ?? 8));
	/** `projectId\0repoPath` → 登记（一个仓库一条）。 */
	const entries = new Map<string, WatchEntry>();
	/** `watchId` → 登记（渲染层只拿得到这个不透明 id）。 */
	const byWatchId = new Map<string, WatchEntry>();
	/** `hostId\0sessionKey\0helperWatchId` → 登记（事件帧只有这些）。 */
	const byHelper = new Map<string, WatchEntry>();
	/** 同键在途订阅：并发 acquire 合并成一次远端请求（helper 预算只有 4 个 watcher）。 */
	const pending = new Map<string, Promise<Established>>();
	let sequence = 0;
	let disposed = false;

	const keyOf = (projectId: string, repoPath: string): string => projectId + SEPARATOR + repoPath;
	const helperKeyOf = (hostId: string, sessionKey: string, helperWatchId: string): string => hostId + SEPARATOR + sessionKey + SEPARATOR + helperWatchId;
	const senderCount = (senderId: number): number => [...entries.values()].filter((entry) => entry.refs.has(senderId)).length;

	/** 摘掉一条登记（同步）并按需成对 `fs.unwatch`；退订失败只是「helper 已经不在」，不影响本机登记。 */
	async function drop(entry: WatchEntry, unwatch: boolean): Promise<void> {
		const key = keyOf(entry.projectId, entry.repoPath);
		if (entries.get(key) === entry) entries.delete(key);
		if (byWatchId.get(entry.watchId) === entry) byWatchId.delete(entry.watchId);
		const helperKey = helperKeyOf(entry.hostId, entry.sessionKey, entry.helperWatchId);
		if (byHelper.get(helperKey) === entry) byHelper.delete(helperKey);
		entry.refs.clear();
		// 池保活：最后一条订阅消失才 release，与创建时的 retain 严格配对。
		try {
			entry.service.releaseProjectSessionWatch?.(entry.hostId, entry.root, entry.sessionKey);
		} catch {
			// 池已回收/服务已销毁：保活记账失败不影响退订与登记。
		}
		if (!unwatch) return;
		try {
			await entry.session.request("fs.unwatch", { watchId: entry.helperWatchId });
		} catch {
			// helper 已死/已换代：退订请求只会失败，登记已经摘掉就够了。
		}
	}

	function retain(entry: WatchEntry, senderId: number): void {
		entry.refs.set(senderId, (entry.refs.get(senderId) ?? 0) + 1);
	}

	/** 项目关闭：该项目全部仓库的订阅成对退订（不要用 `this`，这些方法会被装配层解引用转发）。 */
	async function forgetProjectEntries(projectId: string): Promise<void> {
		for (const entry of [...byWatchId.values()]) if (entry.projectId === projectId) await drop(entry, true);
	}

	/** 建立一条新订阅：一次 `fs.watch` 带 4 条路径。失败折成稳定码，绝不向上抛。 */
	async function establish(request: { projectId: string; repoPath: string; locator: RemoteGitLocator; service: GitRefWatchService }): Promise<Established> {
		const { projectId, repoPath, locator, service } = request;
		const paths = gitRefWatchPaths(repoPath);
		let established: { helperWatchId: string; session: GitRefWatchSession } | undefined;
		let code = "";
		try {
			const outcome = await service.withProjectSession(
				locator.hostId,
				locator.remotePath,
				async (session) => {
					const answer: unknown = await session.request("fs.watch", { paths });
					const helperWatchId = typeof answer === "object" && answer !== null && typeof (answer as { watchId?: unknown }).watchId === "string" ? (answer as { watchId: string }).watchId : "";
					// helper 声称成功却没有 id：这条订阅没有可路由的身份，等同失败（与目录订阅同一判据）。
					if (helperWatchId === "") throw new Error("GIT_REF_WATCH_UNAVAILABLE");
					return { helperWatchId, session };
				},
				{ requireReady: true },
			);
			if (!outcome.ok) code = outcome.code;
			else established = outcome.value;
		} catch (error) {
			// 操作本身失败（helper 拒绝/路径不存在/预算触顶）保留它自己的稳定码，面板据此退回轮询。
			code = codeOf(error, "GIT_REF_WATCH_FAILED");
		}
		if (established === undefined) return { ok: false, code: code === "" ? "GIT_REF_WATCH_FAILED" : code };
		if (disposed) {
			// 订阅在途期间进程已退出：这条 watch 不属于任何活着的登记，成对收回。
			try {
				await established.session.request("fs.unwatch", { watchId: established.helperWatchId });
			} catch {
				// helper 已随退出一起结束。
			}
			return { ok: false, code: "REQUEST_CANCELLED" };
		}
		const entry: WatchEntry = {
			watchId: "gitref-" + String(++sequence),
			projectId,
			repoPath,
			hostId: locator.hostId,
			root: locator.remotePath,
			helperWatchId: established.helperWatchId,
			sessionKey: established.session.connectionId,
			session: established.session,
			service,
			refs: new Map(),
		};
		entries.set(keyOf(projectId, repoPath), entry);
		byWatchId.set(entry.watchId, entry);
		byHelper.set(helperKeyOf(entry.hostId, entry.sessionKey, entry.helperWatchId), entry);
		try {
			service.retainProjectSessionWatch?.(entry.hostId, entry.root, entry.sessionKey);
		} catch {
			// 保活不是订阅的前置条件：拿不到租约只意味着这条会话可能被池提前回收。
		}
		return { ok: true, entry };
	}

	return {
		async watch(request) {
			const { projectId, repoPath, senderId } = request;
			if (!input.enabled) return fail("REMOTE_FEATURE_DISABLED");
			if (disposed) return fail("REQUEST_CANCELLED");
			const locator = input.locator(projectId);
			if (locator === undefined) return fail("GIT_TARGET_CHANGED");
			if (!(await input.trusted(locator))) return fail("GIT_TRUST_REQUIRED");
			const service = await input.service();
			if (service === undefined) return fail("SSH_HOST_NOT_READY");
			if (disposed) return fail("REQUEST_CANCELLED");
			if (senderCount(senderId) >= maxPerSender) return fail("TOO_MANY_REQUESTS");
			// 能力缺失是确定的不支持：不必先建会话再让 helper 拒一次（METHOD_NOT_FOUND 与「预算用满」要分开）。
			const capabilities = service.projectHelperCapabilities?.(locator.hostId, locator.remotePath);
			if (capabilities !== undefined && !capabilities.includes("fs.watch")) return fail("GIT_REF_WATCH_UNAVAILABLE");
			const existing = entries.get(keyOf(projectId, repoPath));
			if (existing !== undefined) {
				// 只有能确认「会话已经换代」时才丢弃：端口缺该方法/暂时没有会话事实时按未换代处理，
				// 宁可复用也不能每次 acquire 都再烧一个 helper watcher（预算只有 4 个）。
				const facts = service.projectConnectionFacts?.(locator.hostId, locator.remotePath);
				if (facts === undefined || facts.connectionId === existing.sessionKey) {
					retain(existing, senderId);
					return { ok: true, watchId: existing.watchId };
				}
				// 换代：旧 helper 已经不在了，退订只会失败，登记直接丢弃。
				await drop(existing, false);
			}
			let attempt = pending.get(keyOf(projectId, repoPath));
			if (attempt === undefined) {
				attempt = establish({ projectId, repoPath, locator, service });
				pending.set(keyOf(projectId, repoPath), attempt);
				void attempt.finally(() => {
					if (pending.get(keyOf(projectId, repoPath)) === attempt) pending.delete(keyOf(projectId, repoPath));
				});
			}
			const outcome = await attempt;
			if (!outcome.ok) return outcome;
			// 订阅在途期间登记被清理（退出/项目关闭）：这个结果已经不属于任何活着的订阅。
			if (byWatchId.get(outcome.entry.watchId) !== outcome.entry) return fail("REQUEST_CANCELLED");
			retain(outcome.entry, senderId);
			return { ok: true, watchId: outcome.entry.watchId };
		},
		async unwatch(watchId, senderId) {
			const entry = byWatchId.get(watchId);
			// 幂等：未知/已退订/别的窗口的 id 静默忽略（退订永远不该失败）。
			if (entry === undefined) return;
			const mine = entry.refs.get(senderId) ?? 0;
			if (mine > 0) {
				if (mine === 1) entry.refs.delete(senderId);
				else entry.refs.set(senderId, mine - 1);
			}
			// 还有别的窗口订阅同一个仓库：保留 watcher，只减引用。
			if (entry.refs.size > 0) return;
			await drop(entry, true);
		},
		onHelperEvent(entry) {
			if (disposed) return;
			const watch = byHelper.get(helperKeyOf(entry.hostId, entry.sessionKey, entry.watchId));
			// 未登记 = 不是这次订阅发起的（别的 root 的会话、旧会话、已撤销）：忽略比猜更安全。
			if (watch === undefined) return;
			// 项目已经关闭但登记还没被清理：不发通知，顺手成对退订。
			if (input.locator(watch.projectId) === undefined) {
				void drop(watch, true);
				return;
			}
			const change: RemoteProjectFactsChange = {
				projectId: watch.projectId,
				// generation 与 `generationFor` 同一口径（会话身份即项目连接代）。
				generation: watch.sessionKey,
				scopes: [{ kind: "status", repoPath: watch.repoPath }],
			};
			// 只发通知：读仍由活跃的消费者决定（一次 refs 变化不产生远端往返）。
			input.factsEvents?.publish(change);
		},
		async forgetSender(senderId) {
			for (const entry of [...byWatchId.values()]) {
				if (!entry.refs.has(senderId)) continue;
				entry.refs.delete(senderId);
				if (entry.refs.size === 0) await drop(entry, true);
			}
		},
		forgetHost(hostId) {
			for (const entry of [...byWatchId.values()]) if (entry.hostId === hostId) void drop(entry, false);
		},
		forgetSession(hostId, sessionKey) {
			for (const entry of [...byWatchId.values()]) if (entry.hostId === hostId && entry.sessionKey === sessionKey) void drop(entry, false);
		},
		forgetProject: forgetProjectEntries,
		async pruneClosed() {
			const closed = new Set<string>();
			for (const entry of byWatchId.values()) if (input.locator(entry.projectId) === undefined) closed.add(entry.projectId);
			for (const projectId of closed) await forgetProjectEntries(projectId);
		},
		size: () => entries.size,
		async dispose() {
			disposed = true;
			for (const entry of [...byWatchId.values()]) await drop(entry, true);
			entries.clear();
			byWatchId.clear();
			byHelper.clear();
			pending.clear();
		},
	};
}
