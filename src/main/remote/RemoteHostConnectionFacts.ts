import type { RootPoolEntryView } from "./RemoteRootSessionPool";
import type { SshConnectionManager } from "./SshConnectionManager";
import { managerToken, pooledConnectionId } from "./remoteHostConnectionGuards";
import type { ConnectionMachineState } from "./RemoteHostConnectionState";
import type { RemoteHostConnectionState } from "./RemoteHostConnectionTypes";

/**
 * 远端主机的**只读事实投影**：状态回放、连接身份、helper 能力、项目级连接事实、诊断序列。
 *
 * 这些方法全部只读：不连接、不建会话、不持锁（`states` / `listDiagnostics` 只遍历已有 manager）。
 * 状态都归宿主所有，这里拿的是只读视图 + 两个访问器（`disposed()` 与 `pooledManager`），
 * 所以搬出来不会让「谁改状态」多出一个写者。
 */

/** 宿主 `HostEntry` 的只读切片：事实查询只碰这两项。 */
export type RemoteHostFactsEntry = {
	readonly manager?: SshConnectionManager;
	readonly held?: { readonly revision: number };
};

/** 池条目的只读切片：`RemoteHostConnectionService` 的池值是 `PooledRootSession`，结构上覆盖它。 */
export type RemoteHostFactsPoolValue = {
	readonly manager: SshConnectionManager;
	readonly held: { readonly revision: number };
};

/** 池的只读面：`peek`（单 root）与 `entries`（全部 root），都不建立也不延长寿命。 */
export type RemoteHostFactsPool = {
	peek(hostId: string, root: string): RootPoolEntryView<RemoteHostFactsPoolValue> | undefined;
	entries(): readonly RootPoolEntryView<RemoteHostFactsPoolValue>[];
};

export type RemoteHostFactsSources = {
	/** 服务持有的主机表（只读遍历）。 */
	hosts: ReadonlyMap<string, RemoteHostFactsEntry>;
	/** 同主机多项目 root 池；未开启池化时为 undefined（那条路径只认主机当前 manager）。 */
	pool: RemoteHostFactsPool | undefined;
	/** 显式 connect 证明过的池化主机状态。 */
	pooledHostStates: ReadonlyMap<string, ConnectionMachineState>;
	/** 任一已就绪 root 的 manager（主机级事实用；由宿主实现，因为它还服务于读路径）。 */
	pooledManager: (hostId: string) => SshConnectionManager | undefined;
	rootFailures: ReadonlyMap<string, ReadonlyMap<string, string>>;
	workspaceRoots: ReadonlyMap<string, string>;
	/** 构造时给的 root（`workspaceRoots` 未覆盖时的缺省值）。 */
	configuredRoot: string | undefined;
	explicitlyDisconnected: ReadonlySet<string>;
	disposed: () => boolean;
};

export function createRemoteHostConnectionFacts(sources: RemoteHostFactsSources) {
	const { hosts, pool, pooledHostStates, pooledManager, rootFailures, workspaceRoots, configuredRoot, explicitlyDisconnected } = sources;
	const isDisposed = (): boolean => sources.disposed();

	return {
		states(): Record<string, RemoteHostConnectionState> {
			const current: Record<string, RemoteHostConnectionState> = {};
			for (const [hostId, entry] of hosts) {
				const state = entry.manager?.getState(hostId).state;
				if (state !== undefined) current[hostId] = state;
			}
			// 池化：一台主机的状态由它的各 root 会话聚合——任一条就绪即视为主机可用，显式 connect 的结论另记。
			for (const entry of pool?.entries() ?? []) {
				try {
					const state = entry.value.manager.getState(entry.hostId).state;
					if (current[entry.hostId] !== "ready") current[entry.hostId] = state;
				} catch {
					continue;
				}
			}
			for (const [hostId, state] of pooledHostStates) if (current[hostId] === undefined) current[hostId] = state.state;
			return current;
		},
		helperCapabilities(hostId: string): readonly string[] | undefined {
			if (isDisposed() || explicitlyDisconnected.has(hostId)) return undefined;
			// 池化：主机级能力取任一已就绪会话（能力与 root 无关）；项目级请用 projectHelperCapabilities。
			const manager = pooledManager(hostId) ?? hosts.get(hostId)?.manager;
			if (manager === undefined) return undefined;
			try {
				const state = manager.getState(hostId).state;
				if (state !== "ready" && state !== "degraded") return undefined;
				return manager.getCapabilities(hostId);
			} catch {
				return undefined;
			}
		},
		projectHelperCapabilities(hostId: string, canonicalRoot: string): readonly string[] | undefined {
			if (isDisposed() || explicitlyDisconnected.has(hostId)) return undefined;
			if (typeof canonicalRoot !== "string" || canonicalRoot.length === 0) return undefined;
			// 池化：能力属于声明它的那条 helper 会话，因此只从本 root 的会话回答。
			const pooledEntry = pool?.peek(hostId, canonicalRoot);
			if (pooledEntry !== undefined) {
				try {
					const state = pooledEntry.value.manager.getState(hostId).state;
					if (state !== "ready" && state !== "degraded") return undefined;
					return pooledEntry.value.manager.getCapabilities(hostId);
				} catch {
					return undefined;
				}
			}
			if (pool !== undefined) return undefined;
			const manager = hosts.get(hostId)?.manager;
			if (manager === undefined) return undefined;
			if ((workspaceRoots.get(hostId) ?? configuredRoot) !== canonicalRoot) return undefined;
			try {
				const state = manager.getState(hostId).state;
				if (state !== "ready" && state !== "degraded") return undefined;
				return manager.getCapabilities(hostId);
			} catch {
				return undefined;
			}
		},
		projectRootStatus(hostId: string, root: string): { status: "ok" } | { status: "needs-attention"; code: string } {
			const code = rootFailures.get(hostId)?.get(root);
			return code === undefined ? { status: "ok" } : { status: "needs-attention", code };
		},
		listDiagnostics(hostId?: string) {
			const fromHosts = hostId !== undefined ? (hosts.get(hostId)?.manager?.listDiagnostics(hostId) ?? []) : [...hosts.values()].flatMap((entry) => entry.manager?.listDiagnostics() ?? []);
			// 池化：每条 root 会话各有自己的诊断序列，全部并入（同主机多条会话不该互相遮盖）。
			const fromPool = (pool?.entries() ?? []).filter((entry) => hostId === undefined || entry.hostId === hostId).flatMap((entry) => entry.value.manager.listDiagnostics(entry.hostId));
			return [...fromHosts, ...fromPool];
		},
		connectionFacts(hostId: string): { connectionId: string; state: RemoteHostConnectionState } | undefined {
			if (isDisposed() || explicitlyDisconnected.has(hostId)) return undefined;
			const entry = hosts.get(hostId);
			// 池化：主机级事实取任一已就绪 root 会话的身份（项目级请用 projectConnectionFacts）。
			const pooledManagerForHost = pooledManager(hostId);
			if (pool !== undefined) {
				if (pooledManagerForHost === undefined) return undefined;
				try {
					const state = pooledManagerForHost.getState(hostId);
					return { connectionId: pooledConnectionId(hostId, pooledManagerForHost), state: state.state };
				} catch {
					return undefined;
				}
			}
			const manager = entry?.manager;
			if (manager === undefined) return undefined;
			try {
				const state = manager.getState(hostId);
				return { connectionId: `${hostId}#${managerToken(manager)}#${state.generation}`, state: state.state };
			} catch {
				return undefined;
			}
		},
		projectConnectionFacts(hostId: string, canonicalRoot: string): { connectionId: string; state: RemoteHostConnectionState } | undefined {
			if (isDisposed() || explicitlyDisconnected.has(hostId)) return undefined;
			if (typeof canonicalRoot !== "string" || canonicalRoot.length === 0) return undefined;
			const entry = hosts.get(hostId);
			// 池化：项目事实来自**这个 root 自己的会话**，绝不取主机当前 manager、也不回退兄弟 root。
			const pooled = pool?.peek(hostId, canonicalRoot);
			if (pooled !== undefined) {
				try {
					const state = pooled.value.manager.getState(hostId);
					return { connectionId: pooledConnectionId(hostId, pooled.value.manager), state: state.state };
				} catch {
					return undefined;
				}
			}
			if (pool !== undefined) return undefined;
			const manager = entry?.manager;
			if (manager === undefined) return undefined;
			// The root is the helper's `--root`: a session established for another boundary serves no path of this
			// one, so its identity must not be handed out as this project's generation.
			if ((workspaceRoots.get(hostId) ?? configuredRoot) !== canonicalRoot) return undefined;
			try {
				const state = manager.getState(hostId);
				return { connectionId: `${hostId}#${managerToken(manager)}#${state.generation}`, state: state.state };
			} catch {
				return undefined;
			}
		},
		projectTransferIdentity(hostId: string, canonicalRoot: string): { connectionId: string; hostRevision: number; state: RemoteHostConnectionState } | undefined {
			if (isDisposed() || explicitlyDisconnected.has(hostId)) return undefined;
			if (typeof canonicalRoot !== "string" || canonicalRoot.length === 0) return undefined;
			const pooled = pool?.peek(hostId, canonicalRoot);
			if (pooled !== undefined) {
				try {
					const state = pooled.value.manager.getState(hostId);
					return { connectionId: pooledConnectionId(hostId, pooled.value.manager), hostRevision: pooled.value.held.revision, state: state.state };
				} catch {
					return undefined;
				}
			}
			if (pool !== undefined) return undefined;
			const entry = hosts.get(hostId);
			const manager = entry?.manager;
			const held = entry?.held;
			if (manager === undefined || held === undefined) return undefined;
			if ((workspaceRoots.get(hostId) ?? configuredRoot) !== canonicalRoot) return undefined;
			try {
				const state = manager.getState(hostId);
				return { connectionId: `${hostId}#${managerToken(manager)}#${state.generation}`, hostRevision: held.revision, state: state.state };
			} catch {
				return undefined;
			}
		},
	};
}
