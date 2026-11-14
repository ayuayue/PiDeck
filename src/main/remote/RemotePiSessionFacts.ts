import { RemoteHostStore } from "./RemoteHostStore";
import { deployedRunnerPath } from "./RemoteBootstrapDeployment";
import { deployedExtensionSnapshotRoot } from "./RemoteExtensionDeployment";
import { maintainDeployedBundles } from "./RemoteBundleMaintenance";
import { readEffectiveExtensionSnapshot, remoteExtensionSnapshotFileNames } from "../extensions/remoteExtensionSnapshot";
import type { BuiltInExtensionPathRoots } from "../extensions/builtInExtensions";
import { HOST_ID, extensionDeployCodeOf } from "./remoteHostConnectionGuards";
import type { RemoteHostConnectionPorts } from "./RemoteHostConnectionService";
import type { SshClientRuntime } from "./SshClientRuntime";
import type { SshProcessLauncher } from "./RemoteHostConnectionTypes";

/**
 * 一台主机上「跑远端 pi 会话」所需的探测事实、手填 pi 路径的写库与内置扩展快照部署。
 *
 * 三个入口是同一条语义：先拿主机锁，没有 held session 就先 `connectLocked`，然后按
 * `revision + generation` 缓存（重连/rebind 换 held，缓存随之失效，所以不需要 TTL）。
 * 缓存字段仍在宿主的 `HostEntry` 上（`discard()` 一并清掉），这里只读写，不新增第二个写者。
 */

/**
 * 一次 pi 探测的结果，与产出它的 held bootstrap 同代缓存。
 */
export type PiProbeFacts = { readonly revision: number; readonly generation: number; readonly piPath: string; readonly version: string; readonly warning?: string };

/** 一台主机上「跑远端 pi 会话」所需的全部事实（P4.2 的启动准备消费它）。 */
export type RemotePiRuntimeFacts = {
	readonly nodePath: string;
	readonly piPath: string;
	readonly version: string;
	/** 高于已核验窗口时的提示码（放行但不冒充已核验组合）。 */
	readonly warning?: string;
	/** 远端 runner.mjs 的绝对路径（内容寻址部署包内，由 held bootstrap 推出）。 */
	readonly runnerPath: string;
	/** 部署根（`<home>/.pideck/remote-host`）：安全策略快照等固定路径的父目录。 */
	readonly deployRoot: string;
};

/**
 * 内置扩展快照的部署结果。失败带稳定码，不抛异常：扩展缺失是降级，不是会话启动失败。
 * `fileNames` 是本次激活目录里真实存在的文件名（来自整份校验的清单），注入侧按它过滤。
 */
export type RemoteExtensionSnapshotFacts = { readonly ok: true; readonly sha256: string; readonly root: string; readonly fileNames: readonly string[] } | { readonly ok: false; readonly code: string };

/**
 * 已部署的内置扩展快照（内容寻址），与 held bootstrap 同代缓存。
 *
 * 为什么缓存：快照每次会话都要用，而部署要一轮 ssh + scp；同一份 held session（同 revision/generation）
 * 里重复部署只会白付一次上传。重连/换根会换 held session，缓存随之失效（与 `piProbe` 同判据）。
 */
export type HeldExtensionSnapshot = {
	revision: number;
	generation: number;
	sha256: string;
	root: string;
	fileNames: readonly string[];
};

/** `connectLocked` 的结果里本域真正消费的两条：成功/失败码。 */
export type RemotePiConnectOutcome = { ok: true } | { ok: false; code: string };
/**
 * 宿主 `HostEntry` 的窄切片：本域只碰 held（读）、两个缓存（读写）与 attempt（只取取消信号）。
 * 结构上覆盖宿主的 `HostEntry`，所以宿主直接把自己的条目表入口传进来。
 */
export type RemotePiFactsEntry = {
	held?: {
		readonly revision: number;
		readonly generation: number;
		readonly session: { readonly nodePath: string; readonly deployRoot: string; readonly bundleSha256: string };
	};
	piProbe?: PiProbeFacts;
	extensionSnapshot?: HeldExtensionSnapshot;
	attempt?: { readonly controller: AbortController };
};

export type RemotePiSessionFactsDeps = {
	userDataDir: string;
	ports: RemoteHostConnectionPorts;
	launcher: SshProcessLauncher;
	builtInExtensionRoots: BuiltInExtensionPathRoots | undefined;
	/** 该主机的条目（不存在则创建：探测需要把结果缓存回去）。 */
	entryFor: (hostId: string) => RemotePiFactsEntry;
	/** 只查不建：写一次 pi 路径不得凭空造出一个主机条目。 */
	entryPeek: (hostId: string) => RemotePiFactsEntry | undefined;
	connectLocked: (hostId: string) => Promise<RemotePiConnectOutcome>;
	operationLock: { run<T>(hostId: string, work: () => Promise<T>): Promise<T> };
	clientFor: (hostId: string) => SshClientRuntime;
};

export function createRemotePiSessionFacts(deps: RemotePiSessionFactsDeps) {
	const { userDataDir, ports, launcher, builtInExtensionRoots, entryFor, entryPeek, connectLocked, operationLock, clientFor } = deps;

	/**
	 * 这台主机档案里手填的远端 pi 路径（缺省 = 自动探测）。
	 *
	 * 读不到 store / 档案不在时返回 undefined：此时探测自己会报 `SSH_HOST_NOT_READY`，不应该让
	 * 一个读失败先变成一个看起来「用户没配」的事实。
	 */
	async function readPiCommand(hostId: string): Promise<string | undefined> {
		try {
			const snapshot = (await RemoteHostStore.open(userDataDir)).getSnapshot();
			if (snapshot.status !== "ready") return undefined;
			const command = snapshot.profiles.find((item) => item.id === hostId)?.remotePiCommand;
			return typeof command === "string" && command.length > 0 ? command : undefined;
		} catch {
			return undefined;
		}
	}

	return {
		async remotePiRuntimeFacts(hostId: string): Promise<RemotePiRuntimeFacts> {
			if (typeof hostId !== "string" || !HOST_ID.test(hostId)) throw new Error("SSH_HOST_ID_INVALID");
			// 池化：按 (host, root) 租用会话，操作期间持租约（在途写不会被 TTL/LRU 回收）。
			return operationLock.run(hostId, async () => {
				const entry = entryFor(hostId);
				if (entry.held === undefined) {
					const result = await connectLocked(hostId);
					if (!result.ok) throw new Error("SSH_HOST_NOT_READY");
				}
				const held = entry.held;
				if (held === undefined) throw new Error("SSH_HOST_NOT_READY");
				const cached = entry.piProbe;
				const probe =
					cached !== undefined && cached.revision === held.revision && cached.generation === held.generation
						? cached
						: await (async (): Promise<PiProbeFacts> => {
								// 手填路径优先：用户已经明确说了 pi 在哪，不再扫登录 shell 的 PATH。
								const piPath = await readPiCommand(hostId);
								const observation = await ports.resolvePi({ userDataDir, hostId, client: clientFor(hostId), sentinel: ports.createSentinel(), nodePath: held.session.nodePath, ...(piPath === undefined ? {} : { piPath }) });
								const facts: PiProbeFacts = { revision: held.revision, generation: held.generation, piPath: observation.piPath, version: observation.version, ...(observation.warning === undefined ? {} : { warning: observation.warning }) };
								entry.piProbe = facts;
								return facts;
							})();
				return {
					nodePath: held.session.nodePath,
					piPath: probe.piPath,
					version: probe.version,
					...(probe.warning === undefined ? {} : { warning: probe.warning }),
					runnerPath: deployedRunnerPath({ bundleSha256: held.session.bundleSha256, deployRoot: held.session.deployRoot, active: `./bundles/${held.session.bundleSha256}` }),
					deployRoot: held.session.deployRoot,
				};
			});
		},
		async setRemotePiCommand(hostId: string, command: string | undefined): Promise<void> {
			if (typeof hostId !== "string" || !HOST_ID.test(hostId)) throw new Error("SSH_HOST_ID_INVALID");
			return operationLock.run(hostId, async () => {
				const store = await RemoteHostStore.open(userDataDir);
				const snapshot = store.getSnapshot();
				if (snapshot.status !== "ready") throw new Error("REMOTE_HOST_STORE_NEEDS_REPAIR");
				if (!snapshot.profiles.some((profile) => profile.id === hostId)) throw new Error("REMOTE_HOST_NOT_FOUND");
				await store.updateProfile(hostId, { remotePiCommand: command }, snapshot.revision);
				const entry = entryPeek(hostId);
				if (entry !== undefined) entry.piProbe = undefined;
			});
		},
		async ensureRemoteExtensionSnapshot(hostId: string): Promise<RemoteExtensionSnapshotFacts> {
			if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return { ok: false, code: "SSH_HOST_ID_INVALID" };
			const roots = builtInExtensionRoots;
			if (roots === undefined) return { ok: false, code: "REMOTE_EXTENSIONS_UNAVAILABLE" };
			const snapshot = readEffectiveExtensionSnapshot(roots);
			if (snapshot === undefined) return { ok: false, code: "REMOTE_EXTENSIONS_UNAVAILABLE" };
			const fileNames = remoteExtensionSnapshotFileNames(snapshot.manifest);
			if (fileNames.length === 0) return { ok: false, code: "REMOTE_EXTENSIONS_UNAVAILABLE" };
			return operationLock.run(hostId, async (): Promise<RemoteExtensionSnapshotFacts> => {
				const entry = entryFor(hostId);
				if (entry.held === undefined) {
					const result = await connectLocked(hostId);
					if (!result.ok) return { ok: false, code: result.code };
				}
				const held = entry.held;
				if (held === undefined) return { ok: false, code: "SSH_HOST_NOT_READY" };
				const cached = entry.extensionSnapshot;
				if (cached !== undefined && cached.revision === held.revision && cached.generation === held.generation) return { ok: true, sha256: cached.sha256, root: cached.root, fileNames: cached.fileNames };
				try {
					const deployed = await ports.deployExtensions({
						userDataDir,
						hostId,
						generation: held.generation,
						nonce: ports.createNonce(),
						nodePath: held.session.nodePath,
						client: clientFor(hostId),
						launcher,
						snapshot: { dir: snapshot.dir, names: fileNames },
						// An explicit disconnect/dispose during the upload cancels this attempt too; the cache is then
						// not written, and the next session redeploys instead of trusting a half-finished result.
						...(entry.attempt === undefined ? {} : { signal: entry.attempt.controller.signal }),
					});
					const root = deployedExtensionSnapshotRoot(deployed);
					entry.extensionSnapshot = { revision: held.revision, generation: held.generation, sha256: deployed.bundleSha256, root, fileNames };
					// 非致命回收：这一轮刚确认了两个 active（helper + 扩展），sweep 可以清旧快照；失败只记日志。
					void maintainDeployedBundles({
						userDataDir,
						hostId,
						client: clientFor(hostId),
						nodePath: held.session.nodePath,
						deployRoot: deployed.deployRoot,
						activeBundleSha256: held.session.bundleSha256,
						activeExtensionSha256: deployed.bundleSha256,
					}).catch(() => undefined);
					return { ok: true, sha256: deployed.bundleSha256, root, fileNames };
				} catch (error) {
					return { ok: false, code: extensionDeployCodeOf(error) };
				}
			});
		},
	};
}
