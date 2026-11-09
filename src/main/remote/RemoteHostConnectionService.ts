import { buildPinnedSshInvocation, type PinnedSshInvocation } from "./SshVerifiedConnection";
import { createRootSessionPool, type RootPoolPolicy, type RootSessionPool } from "./RemoteRootSessionPool";
import { logRootPoolDiagnostic } from "./RemoteRootPoolDiagnostics";
import { clearInterval as cancelSweepTimer, setInterval as intervalTimer } from "node:timers";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { RemoteHostStore } from "./RemoteHostStore";
import { createRemoteHostOperationLock } from "./RemoteHostOperationLock";
import { resolveRemoteBrowseRoot } from "./RemoteBrowseRoot";
import { buildReadHomeCommand } from "./RemoteDirectoryListing";
import { bootstrapPinnedHost, resolveRemoteNodeExecutable } from "./RemoteBootstrapSession";
import { resolveRemotePiExecutable } from "./RemotePiDiscovery";
import { deployedRunnerPath } from "./RemoteBootstrapDeployment";
import { writeRemoteSecurityPolicySnapshot } from "./RemoteSecurityPolicyArtifact";
import { getAppLogger } from "../logging/sharedLogger";
import { maintainDeployedBundles } from "./RemoteBundleMaintenance";
import { deployRemoteExtensionSnapshot, deployedExtensionSnapshotRoot } from "./RemoteExtensionDeployment";
import { readEffectiveExtensionSnapshot, remoteExtensionSnapshotFileNames } from "../extensions/remoteExtensionSnapshot";
import type { BuiltInExtensionPathRoots } from "../extensions/builtInExtensions";
import { createSshPiRuntimeLauncher } from "./SshPiRuntimeLauncher";
import type { PiRuntimeLauncher } from "../pi/PiSpawnHandle";
import { createSshConnectionManager, type SshConnectionManager, type SshHelperSession } from "./SshConnectionManager";
import { createSshProcessLauncher } from "./SshProcessLauncher";
import { diagnosticCodeFromError } from "./SshConnectionDiagnostics";
import { withClientEnv, type SshClientRuntime } from "./SshClientRuntime";
import { createSshAskpassBridge, type SshAskpassBridge } from "./SshAskpass";
import { RemoteHostCredentialStore } from "./RemoteHostCredentialStore";
import type { SshProcessLauncher } from "./RemoteHostConnectionTypes";
import type { ConnectionMachineState } from "./RemoteHostConnectionState";
import type { RemoteHostConnectionState } from "./RemoteHostConnectionTypes";

/**
 * The verified bootstrap result of one host, held for exactly as long as the store revision it was
 * produced under. A rebind, a disable or a re-verification bumps that revision, and a helper session
 * from a superseded revision may point at a retired deploy root, so it must never be reused.
 */
type HeldBootstrap = {
	revision: number;
	session: SshHelperSession;
	generation: number;
};
/**
 * 池化的一个 root 会话：自己的 manager（helper 进程 + SSH 连接）+ 该主机的已验证部署事实。
 *
 * held 是**主机级**的（node、部署根、bundle sha 与 root 无关），所以在同一 held 上可以并存多个 manager——
 * 每个 manager 只差启动 argv 里的 --root。这正是池化不改 helper 协议就能成立的原因。
 */
type PooledRootSession = {
	hostId: string;
	root: string;
	manager: SshConnectionManager;
	held: HeldBootstrap;
};

/**
 * 已部署的内置扩展快照（内容寻址），与 held bootstrap 同代缓存。
 *
 * 为什么缓存：快照每次会话都要用，而部署要一轮 ssh + scp；同一份 held session（同 revision/generation）
 * 里重复部署只会白付一次上传。重连/换根会换 held session，缓存随之失效（与 `piProbe` 同判据）。
 */
type HeldExtensionSnapshot = {
	revision: number;
	generation: number;
	sha256: string;
	root: string;
	fileNames: readonly string[];
};

/** Narrow, injectable view of the coordinator so tests never touch a real SSH process. */
export type RemoteHostConnectionPorts = {
	/** Re-preflight both commands against the persisted pin, then run the frozen one-file bootstrap. */
	bootstrap: typeof bootstrapPinnedHost;
	/** Resolve the host user's own node through their login shell. */
	resolveNode: typeof resolveRemoteNodeExecutable;
	/** Resolve the host user's own pi (login-shell PATH + 解释器形态 + 版本窗口) —— P4.1 的只读探测。 */
	resolvePi: typeof resolveRemotePiExecutable;
	/** Build the per-host connection manager. The manager itself owns attempt lifecycles. */
	createManager: (options: { userDataDir: string; client: SshClientRuntime; launcher: SshProcessLauncher; helperSession: SshHelperSession; onStateChange?: (entry: { hostId: string; state: ConnectionMachineState }) => void }) => SshConnectionManager;
	/** Mint the bootstrap nonce; injected so tests are deterministic. */
	createNonce: () => string;
	/** Mint the login-shell probe sentinel; injected so tests are deterministic. */
	createSentinel: () => string;
	/**
	 * Re-prove that a project's boundary still canonicalizes to itself (a pinned `readlink -f`). Injected so
	 * tests never probe a real host; the default is the same resolver the enrollment flow already uses.
	 */
	verifyRoot: (input: { userDataDir: string; hostId: string; client: SshClientRuntime; userPath: string }) => Promise<{ canonicalPath: string }>;
	/** 部署内置扩展快照（与 helper 部署同一个冻结入口，target=extensions）。 */
	deployExtensions: typeof deployRemoteExtensionSnapshot;
};

export type RemoteHostConnectionServiceOptions = {
	userDataDir: string;
	client: SshClientRuntime;
	launcher?: SshProcessLauncher;
	/**
	 * Absolute remote Node binary, overriding discovery. Optional on purpose: the path can only be known
	 * by asking the host, so requiring it here would invert the real order of events — a caller would have
	 * to produce the answer before the connection that discovers it. Supply it only to pin a specific
	 * binary; otherwise the service resolves the host user's own node via their login shell.
	 */
	nodePath?: string;
	/** Verified workspace root the helper confines `fs.*` to. Omitted is the legal host-only session. */
	root?: string;
	/**
	 * Forwarded to each manager so the owner learns about transitions that happen after `connect()`
	 * returns — a later degradation, a reconnect, or the shutdown that follows a successful ready.
	 */
	onStateChange?: (entry: { hostId: string; state: ConnectionMachineState }) => void;
	/**
	 * 变更事件（helper 1.24.0）：无 id 事件帧的出口。只报 watchId 与请求时的路径标签，
	 * 订阅方按自己的注册表把它换成「哪个项目的哪些目录变了」，再标脏事实。
	 */
	onHelperEvent?: (entry: { hostId: string; watchId: string; paths: readonly string[]; sessionKey: string }) => void;
	/** Explicit disconnect closes independent terminal PTYs, not ordinary helper root switches. */
	onDisconnect?: (hostId: string) => void;
	/**
	 * 一个 root 会话退休（淘汰/失效/显式退休）——不是主机断开。
	 *
	 * 两者刻意分开：真正断开一台主机时用户还看到它的终端；而单个项目 root 的会话被回收/重建时，
	 * 关掉该主机的终端或清掉邻居项目的监听都是错的。订阅方按 sessionKey 只释放这个 root 的登记。
	 */
	onRootRetired?: (entry: { hostId: string; root: string; sessionKey: string }) => void;
	/**
	 * 同主机多项目 root 池。生产装配使用 ROOT_POOL_DEFAULT_POLICY；false/省略保留隔离单测路径。
	 *
	 * 关闭时走原来的「每主机一条会话、换 root 即重建」路径，行为逐字节保持；开启后按
	 * (hostId, canonicalRoot) 复用 helper 会话，容量与 TTL 由这里给出的策略决定（见 RemoteRootSessionPool）。
	 * 首版开关只在构造时选择：运行期拆池会牵动在途写，必须另立设计。
	 */
	rootPooling?: Partial<RootPoolPolicy> | false;
	/**
	 * 本机内置扩展根（`resolveBuiltInExtensionRoots()` 的同一份）。缺省时远端快照能力关闭：
	 * 没有经过整份校验的字节就绝不往远端传。
	 */
	builtInExtensionRoots?: BuiltInExtensionPathRoots;
	ports?: Partial<RemoteHostConnectionPorts>;
};

/** Redacted outcome of one connect request: stable codes only, never pins or paths. */
export type RemoteHostConnectResult = { ok: true; hostId: string; state: ConnectionMachineState } | { ok: false; hostId: string; code: string };

/**
 * One helper session held for the whole duration of a read-only operation.
 *
 * `request`/`cancel` are already bound to the manager this session was established on, so the caller never
 * names a host or a manager: it cannot accidentally address a session that replaced this one mid-read.
 */
export type RemoteProjectSession = {
	readonly hostId: string;
	/** 已验证且与本次会话同代的Node/主机版本，仅供main受控文件命令使用。 */
	readonly nodePath: string;
	/** The confirmed content address of the active bundle: the ticket and the runner path both name it. */
	readonly deployRoot: string;
	readonly bundleSha256: string;
	/** The pin-confirmed route digest of this host revision; the ticket binds it, main never guesses it. */
	readonly hostRouteDigest: string;
	readonly hostRevision: number;
	/**
	 * 主进程持有的稳定 helper 会话身份：manager 实例 + 连接 generation。
	 *
	 * 一次会话里每次读都会新建一个 session 包装对象（这是有意的：包装绑定到当时的 manager），但它们
	 * 代表同一个 helper，所以这个值不变。重连（manager 的 generation 前进）、换根或换 manager 都会
	 * 换值。��阅类登记（目录 watcher）必须用它作 key：用包装对象会把同一次会话的每次读当成新会话。
	 */
	readonly connectionId: string;
	runCommand(remoteCommand: string): Promise<{ exitCode: number; stdout: string }>;
	/** Build and consume an interactive invocation under the host lock; no escaped stale spawn plan. */
	withTerminalInvocation<T>(remoteCommand: string, launch: (invocation: PinnedSshInvocation, assertCurrent: () => Promise<void>) => T): Promise<T>;
	/** Build and consume one SFTP subsystem invocation; renderer never supplies SSH flags or paths. */
	withSftpInvocation<T>(launch: (invocation: PinnedSshInvocation, assertCurrent: () => Promise<void>) => T): Promise<T>;
	request(method: string, params?: unknown, options?: { timeoutMs?: number; onRequestId?: (requestId: string) => void; repo?: string }): Promise<unknown>;
	cancel(requestId: string, options?: { timeoutMs?: number }): Promise<unknown>;
};

/**
 * States in which the host is already working on its own connection: an attempt is in flight or the manager
 * is healing itself. A read must report them rather than rebuild — a rebuild would race that attempt.
 */
const TRANSIENT_SESSION_STATES: ReadonlySet<string> = new Set(["connecting", "probing", "bootstrapping", "reconnecting", "degraded", "needs-attention"]);

/**
 * Which generation number a connect attempt receives. The manager fences attempts by its own
 * generation; this counter names the bootstrap attempt and the nonce lineage only, so the two
 * fences stay independent and neither module has to know the other's numbering.
 */
type PiProbeFacts = { readonly revision: number; readonly generation: number; readonly piPath: string; readonly version: string; readonly warning?: string };

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

type HostEntry = {
	generation: number;
	held?: HeldBootstrap;
	/** 同主机的在途 bootstrap：并发的池建立共享这一次上传，而不是各传一份 bundle。 */
	heldPending?: Promise<HeldBootstrap>;
	/**
	 * Cached pi probe of this host, valid exactly as long as the held bootstrap it was taken under.
	 *
	 * The probe costs two remote round trips (login-shell PATH, then the version command), and every new
	 * remote session needs the answer; caching it per held session keeps session creation cheap without
	 * inventing a TTL (a reconnect or rebind drops the held session, which drops this with it).
	 */
	piProbe?: PiProbeFacts;
	/** Deployed built-in extension snapshot, valid exactly as long as the held bootstrap above. */
	extensionSnapshot?: HeldExtensionSnapshot;
	/** 上一次成功推送到该主机的安全策略 sha256（与 held 同代）；相同内容不重复写盘。 */
	securityPolicySha256?: string;
	manager?: SshConnectionManager;
	/** In-flight connect, so dispose can wait for it instead of racing the spawn. */
	inFlight?: Promise<RemoteHostConnectResult>;
	/**
	 * The connect attempt currently inside the host lock, reachable from *outside* it.
	 *
	 * The lock is held for the whole bootstrap (node probe, ready, upload, finalize), so a cancel that
	 * queued behind it would be waiting for the very work it is meant to stop. `disconnect()` and
	 * `dispose()` therefore abort this controller before they enter the lock; the attempt then settles its
	 * own waits and releases the lock promptly.
	 */
	attempt?: HostAttempt;
};

/** One connect attempt's identity and cancellation. `generation` names the attempt, not the pin. */
type HostAttempt = { generation: number; controller: AbortController };

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 16 random bytes base64url: matches the 15–63 character nonce the frozen entry accepts. */
const DEFAULT_NONCE_BYTES = 16;
/** Nonces must stay distinguishable between attempts of the same host. */
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;

/**
 * 生成一个**必定符合 NONCE 契约**的引导 nonce。
 *
 * 契约（与冻结的 helper bundle 共用）要求首字符是字母数字，而 `randomBytes(n).toString("base64url")`
 * 的首字符有 2/64 ≈ 3.1% 的概率是 `-` 或 `_` —— 曾经的实现正好用它，于是服务**自己生成、自己校验**
 * 时会偶发抛 `REMOTE_CONNECTION_NONCE_INVALID`，表现为「有时连得上、有时一按连接就失败」。
 * 真机 e2e 抓到了这一次（第 5 次运行卡在连接步骤）。hex 恒满足契约，且同样不透明、同样 128 位熵。
 * 不修契约是因为它同时约束远端 helper（改契约要 bump bundle 版本与 sha）。
 */
export function createBootstrapNonce(): string {
	return randomBytes(DEFAULT_NONCE_BYTES).toString("hex");
}
/** Control bytes must never survive in a path handed on to another module. */
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/;
/** Upper bound of a remote HOME, matching the helper contract's own ceiling. */
const MAX_REMOTE_HOME_LENGTH = 4096;

/**
 * Re-validate a remote HOME on the way out of this service.
 *
 * The manager stores only what its own shape check accepted, but this value is still remote input: it
 * arrives in a helper handshake, and callers join it into remote session paths. The egress check is
 * therefore repeated here (non-empty, absolute POSIX, no control bytes, bounded length) instead of trusting
 * an upstream filter, and a value that does not pass is reported as "unknown" rather than partially used.
 */
function readRemoteHome(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_HOME_LENGTH) return undefined;
	if (value.charAt(0) !== "/" || CONTROL_BYTES.test(value)) return undefined;
	return value;
}

/**
 * 扩展快照部署失败的稳定码。
 *
 * 只认「整条消息就是一个码」的错误（本域所有失败都是这么约定的），其它一律折成固定码：既不能把
 * 通用 SSH 失败伪装成「扩展问题」，也不能把半句路径/命令带进日志与 UI。
 */
function extensionDeployCodeOf(error: unknown): string {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : "REMOTE_EXTENSIONS_DEPLOY_FAILED";
}

/**
 * Stable code for "this attempt was cancelled". Reuses the existing disconnect code instead of minting a
 * new public one: the renderer already renders it as "not connected", which is exactly the outcome.
 */
function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw new Error("SSH_HOST_DISCONNECTED");
}

/**
 * Opaque identity for one live manager instance (see `RemoteProjectSession.connectionId`).
 *
 * A manager object is replaced on every root switch/rebind, so object identity already distinguishes those;
 * the caller appends the machine generation to distinguish a reconnect on the same manager. Kept as a
 * WeakMap so a discarded manager cannot be retained by this bookkeeping.
 */
const managerTokens = new WeakMap<object, number>();
let managerTokenCounter = 0;
function managerToken(manager: object): number {
	const existing = managerTokens.get(manager);
	if (existing !== undefined) return existing;
	managerTokenCounter += 1;
	managerTokens.set(manager, managerTokenCounter);
	return managerTokenCounter;
}

function defaultPorts(): RemoteHostConnectionPorts {
	return {
		bootstrap: bootstrapPinnedHost,
		resolveNode: resolveRemoteNodeExecutable,
		resolvePi: resolveRemotePiExecutable,
		createManager: (options) => createSshConnectionManager(options),
		createNonce: createBootstrapNonce,
		createSentinel: () => randomBytes(DEFAULT_NONCE_BYTES).toString("hex"),
		verifyRoot: (input) => resolveRemoteBrowseRoot(input),
		deployExtensions: deployRemoteExtensionSnapshot,
	};
}

/**
 * Own the wired connection lifecycle of remote hosts: one verified bootstrap per host, held until the
 * store revision it was produced under changes, plus the manager that consumes it.
 *
 * Bootstrap and connect are deliberately separate steps. Each attempt owns an `AbortController`:
 * `disconnect()`/`dispose()` abort it **before** entering the host lock, and the signal reaches node
 * discovery, the ready wait, the scp upload and the finalize wait, so the user's cancel settles those
 * waits instead of queueing behind them (or waiting out the 30 s/300 s budgets). Every await re-checks the
 * signal and the attempt identity too, so a late continuation of a cancelled attempt can only clean up its
 * own handle, nonce and staging - it never publishes or tears down whatever replaced it.
 * Both fences are re-checked at every step, so a host whose profile changed mid-flight never reaches the
 * manager with a stale helper location.
 *
 * Node discovery is deliberately owned here rather than required from the caller: the remote Node binary
 * can only be known by asking the host, so demanding it as construction input would force every caller to
 * produce the answer before the connection that finds it. `options.nodePath` remains as an override for
 * pinning a specific binary.
 */
export function createRemoteHostConnectionService(options: RemoteHostConnectionServiceOptions) {
	if (typeof options?.userDataDir !== "string" || !isAbsolute(options.userDataDir) || typeof options.client?.run !== "function") throw new Error("REMOTE_CONNECTION_SERVICE_OPTIONS_INVALID");
	// An override must still look like an absolute path; a bad one is a wiring bug, not a host condition.
	if (options.nodePath !== undefined && (typeof options.nodePath !== "string" || options.nodePath.length === 0 || !isAbsolute(options.nodePath))) throw new Error("REMOTE_CONNECTION_SERVICE_OPTIONS_INVALID");
	const ports: RemoteHostConnectionPorts = { ...defaultPorts(), ...options.ports };
	const launcher = options.launcher ?? createSshProcessLauncher();
	const hosts = new Map<string, HostEntry>();
	/**
	 * Per-host workspace root, overriding the construction option.
	 *
	 * The root is not a read-time filter: it is the helper's `--root` at session start, so a session that
	 * started without one serves no path at all (`fs.*` is refused with PATH_OUTSIDE_ROOT). Confirming a
	 * browse root therefore has to reach the connection and invalidate any session that was established
	 * without it, which is why this lives here rather than only in the IPC layer that asked for it.
	 */
	const workspaceRoots = new Map<string, string>();
	/**
	 * Serializes every operation that needs a stable helper session on one host: a root switch, a whole
	 * listing or file read, an explicit connect, an explicit disconnect. One helper session exists per host
	 * and its `--root` is fixed for its lifetime, so operations of two projects on the same host must never
	 * interleave. Keyed per host, so different hosts still work in parallel.
	 */
	const operationLock = createRemoteHostOperationLock();
	/**
	 * Hosts the user explicitly disconnected. A background read must not undo that decision by quietly
	 * reconnecting, so the intent is remembered here instead of being re-derived from the root string
	 * (the root string matching proves nothing about whether a live session exists).
	 */
	const explicitlyDisconnected = new Set<string>();
	/**
	 * The most recent **failed** re-check of one confirmed root, keyed by host and then by root.
	 *
	 * This is the whole storage of design (i) and it is deliberately project-scoped: a moved directory is a
	 * property of *this project's persisted path*, not of the host's health, so nothing here may drive the
	 * host connection state. Moving project A's root must not block reads of project B on the same host -
	 * that is exactly why the drift is not routed into the host's needs-attention state.
	 *
	 * Only stable codes are stored (both producers below are stable), a later failure overwrites the earlier
	 * one for the same key, and a successful re-check of that key removes it. Nothing else clears a key: a
	 * query must never be able to make an unresolved boundary look healthy.
	 */
	const rootFailures = new Map<string, Map<string, string>>();
	let disposed = false;
	/** 主机失效推进代数；旧代异步建立只能自毁，不能把断开的主机复活。 */
	const hostEpochs = new Map<string, number>();
	const rootEpochs = new Map<string, number>();
	/** 池化模式下显式 connect 证明的主机就绪事实（不额外起一条没有 root 的 helper）。 */
	const pooledHostStates = new Map<string, ConnectionMachineState>();
	/** 正在建立中的池 manager：它们的状态/事件仍属于本服务，不能因为「还没入池」被身份围栏掉。 */
	const pooledPending = new Set<SshConnectionManager>();
	/** 同主机多项目 root 池；`rootPooling` 缺省/为 false 时整个模块走原来的单会话路径。 */
	const rootPool: RootSessionPool<PooledRootSession> | undefined =
		options.rootPooling === undefined || options.rootPooling === false
			? undefined
			: createRootSessionPool<PooledRootSession>({
					policy: options.rootPooling,
					onDiagnostic: logRootPoolDiagnostic,
					establish: (key, signal) => establishPooledRoot(key.hostId, key.root, signal),
					retire: async (entry) => {
						pooledPending.delete(entry.value.manager);
						await entry.value.manager.dispose();
					},
					identity: (session) => pooledConnectionId(session.hostId, session.manager),
					onRetired: (event) => options.onRootRetired?.({ hostId: event.hostId, root: event.root, sessionKey: event.connectionId }),
				});
	/** 无流量时也执行 TTL/LRU；定时器不阻止退出。 */
	const sweepTimer = rootPool === undefined ? undefined : intervalTimer(() => void rootPool.sweep(), 60_000);
	sweepTimer?.unref?.();

	/** Remember (or overwrite) the failure of one confirmed root, and answer the caller's failure shape. */
	function rememberRootFailure(hostId: string, root: string, code: string): { ok: false; code: string } {
		const byRoot = rootFailures.get(hostId) ?? new Map<string, string>();
		byRoot.set(root, code);
		rootFailures.set(hostId, byRoot);
		return { ok: false, code };
	}

	/** A re-check proved this boundary again: the key - and only this key - is cleared. */
	function forgetRootFailure(hostId: string, root: string): void {
		const byRoot = rootFailures.get(hostId);
		if (byRoot === undefined) return;
		byRoot.delete(root);
		if (byRoot.size === 0) rootFailures.delete(hostId);
	}
	let disposing: Promise<void> | undefined;

	/** Read the current store revision, so a held bootstrap can be tied to the profile it came from. */
	async function readRevision(): Promise<number> {
		return (await RemoteHostStore.open(options.userDataDir)).getSnapshot().revision;
	}

	/**
	 * 这台主机档案里手填的远端 pi 路径（缺省 = 自动探测）。
	 *
	 * 读不到 store / 档案不在时返回 undefined：此时探测自己会报 `SSH_HOST_NOT_READY`，不应该让
	 * 一个读失败先变成一个看起来「用户没配」的事实。
	 */
	async function readPiCommand(hostId: string): Promise<string | undefined> {
		try {
			const snapshot = (await RemoteHostStore.open(options.userDataDir)).getSnapshot();
			if (snapshot.status !== "ready") return undefined;
			const command = snapshot.profiles.find((item) => item.id === hostId)?.remotePiCommand;
			return typeof command === "string" && command.length > 0 ? command : undefined;
		} catch {
			return undefined;
		}
	}

	/** The revision and the pin-confirmed route digest of one host, read together so they cannot disagree. */
	async function readVerifiedRoute(hostId: string): Promise<{ revision: number; routeDigest: string } | null> {
		const snapshot = (await RemoteHostStore.open(options.userDataDir)).getSnapshot();
		if (snapshot.status !== "ready") return null;
		const profile = snapshot.profiles.find((item) => item.id === hostId);
		const endpoint = profile && profile.disabledAt === undefined ? profile.verifiedEndpoint : undefined;
		if (!endpoint || typeof endpoint.routeDigest !== "string" || !/^[0-9a-f]{64}$/.test(endpoint.routeDigest)) return null;
		return { revision: snapshot.revision, routeDigest: endpoint.routeDigest };
	}

	/**
	 * In-memory password material for hosts that authenticate with one.
	 *
	 * The secret never leaves this process: it is (a) not persisted, (b) not logged, (c) not passed to `ssh` as
	 * an argument or an environment value. Each host gets its own askpass bridge and its own client view, so
	 * `SSH_ASKPASS` is only inherited by the ssh processes of the host that actually holds a secret.
	 */
	const hostPasswords = new Map<string, string>();
	const askpassBridges = new Map<string, SshAskpassBridge>();
	const hostClients = new Map<string, SshClientRuntime>();
	const credentials = new RemoteHostCredentialStore(options.userDataDir);

	/** The client every pinned invocation of this host must use. */
	function hostClient(hostId: string): SshClientRuntime {
		return hostClients.get(hostId) ?? options.client;
	}

	async function releaseHostPassword(hostId: string): Promise<void> {
		hostPasswords.delete(hostId);
		hostClients.delete(hostId);
		const bridge = askpassBridges.get(hostId);
		askpassBridges.delete(hostId);
		await bridge?.dispose();
	}

	async function applyHostPassword(hostId: string, secret: string): Promise<void> {
		if (typeof secret !== "string" || secret.length === 0 || secret.length > 4096 || secret.includes(String.fromCharCode(0))) throw new Error("SSH_PASSWORD_INVALID");
		await releaseHostPassword(hostId);
		const bridge = await createSshAskpassBridge({ secret, executable: process.execPath });
		try {
			hostClients.set(hostId, withClientEnv(options.client, bridge.env));
		} catch (error) {
			await bridge.dispose();
			throw error;
		}
		askpassBridges.set(hostId, bridge);
		hostPasswords.set(hostId, secret);
		// Persist a copy (OS-encrypted) so the next run does not ask again. A platform that cannot encrypt
		// simply keeps the secret for this session; `set` returning false is not an error.
		await credentials.set(hostId, secret).catch(() => false);
	}

	/** Best-effort profile read used only to decide whether a secret is required before connecting. */
	async function readProfile(hostId: string) {
		try {
			const snapshot = (await RemoteHostStore.open(options.userDataDir)).getSnapshot();
			return snapshot.status === "ready" ? snapshot.profiles.find((item) => item.id === hostId) : undefined;
		} catch {
			return undefined;
		}
	}

	function entryFor(hostId: string): HostEntry {
		const existing = hosts.get(hostId);
		if (existing !== undefined) return existing;
		const created: HostEntry = { generation: 0 };
		hosts.set(hostId, created);
		return created;
	}

	/**
	 * Build a connection manager over one verified helper session.
	 *
	 * 池化让同一个 held 上并存多条 manager（每条一个 root），所以这里接受两个可选的运行时身份：
	 * `root` 覆盖 helper 启动 argv 里的 --root；`isCurrent` 说明「这条会话此刻是否仍属于调用方」——
	 * 事件与状态必须按它围栏，否则一条已被淘汰的会话迟到的状态会污染新会话。
	 */
	function managerFor(held: HeldBootstrap, hostId: string, runtime?: { root?: string; isCurrent?: () => boolean }): SshConnectionManager {
		let manager: SshConnectionManager | undefined;
		const { root: _configuredRoot, ...hostSession } = held.session;
		const helperSession = runtime?.root === undefined ? held.session : runtime.root === "" ? hostSession : { ...hostSession, root: runtime.root };
		let previousConnectionId: string | undefined;
		// 缺省围栏（未池化路径）：仍以「主机当前 manager 就是这条」为准，行为与之前逐字节一致。
		const isCurrent = runtime?.isCurrent ?? (() => manager !== undefined && hosts.get(hostId)?.manager === manager);
		manager = ports.createManager({
			userDataDir: options.userDataDir,
			client: hostClient(hostId),
			launcher,
			helperSession,
			...(options.onHelperEvent === undefined
				? {}
				: {
						onEvent: (eventHostId: string, event: { watchId: string; paths: readonly string[] }) => {
							// 只转述仍属于当前会话的事件：切根/淘汰旧会话后，它的事件不得再影响事实。
							// sessionKey 让下游按 helper 身份登记：两个 helper 返回同一个 watchId 时必须能分开。
							if (manager === undefined || !isCurrent()) return;
							options.onHelperEvent?.({ hostId: eventHostId, watchId: event.watchId, paths: event.paths, sessionKey: pooledConnectionId(eventHostId, manager) });
						},
					}),
			...(options.onStateChange === undefined && rootPool === undefined
				? {}
				: {
						onStateChange: (change: { hostId: string; state: ConnectionMachineState }) => {
							// Root switches dispose the old helper asynchronously. Its shutdown is not a new host outage.
							if (manager === undefined || !isCurrent()) return;
							if (rootPool === undefined) return options.onStateChange?.(change);
							// A root that has not entered the pool is a project-scoped establishment attempt. Its
							// connecting/failure/shutdown frames must not rewrite the host-level fact proved by an
							// explicit connect or by a healthy sibling. establishPooledRoot publishes the settled
							// ready transition; churn from a published root is still forwarded below.
							if (pooledPending.has(manager)) return;
							const connectionId = pooledConnectionId(hostId, manager);
							if (previousConnectionId !== undefined && previousConnectionId !== connectionId && runtime?.root !== undefined) options.onRootRetired?.({ hostId, root: runtime.root, sessionKey: previousConnectionId });
							previousConnectionId = connectionId;
							publishPooledState(change);
						},
					}),
		});
		return manager;
	}
	/** A sibling's cold start or retry is not a host outage for every project. */
	function publishPooledState(change: { hostId: string; state: ConnectionMachineState }): void {
		const previous = pooledHostStates.get(change.hostId);
		const ready = pooledManager(change.hostId)?.getState(change.hostId);
		const state = ready ?? (previous?.state === "ready" && ["connecting", "probing", "bootstrapping"].includes(change.state.state) ? previous : change.state);
		pooledHostStates.set(change.hostId, state);
		if (previous?.state !== state.state) {
			try {
				options.onStateChange?.({ hostId: change.hostId, state });
			} catch {
				// A renderer/window sink is an observer; it cannot fail a connection that already reached a state.
			}
		}
	}

	/** Drop every resource of one host. The manager owns its attempts, so it is disposed first. */
	function discard(hostId: string, entry: HostEntry): void {
		entry.held = undefined;
		entry.heldPending = undefined;
		// 同一个 held bootstrap 才代表同一台远端机器的同一份 pi 事实：一旦丢弃会话，缓存的探测与已部署
		// 扩展快照都必须丢弃，否则重连后会拿一台已退役/已重建主机的事实去启会话。
		entry.piProbe = undefined;
		entry.extensionSnapshot = undefined;
		// 远端策略文件仍在磁盘上，但新 held session 不再信任旧推送记录：下一次有会话时重推一次更稳。
		entry.securityPolicySha256 = undefined;
		const manager = entry.manager;
		entry.manager = undefined;
		if (manager !== undefined) void manager.dispose().catch(() => undefined);
		if (rootPool !== undefined) {
			// 每条 root 会话都建在这份 held 上（部署根与 bundle sha 随它换代），所以 held 作废 = 该主机整池作废。
			bumpHostEpoch(hostId);
			void rootPool.retireHost(hostId, "host");
		}
	}

	/**
	 * Produce (or reuse) the verified helper session of one host.
	 *
	 * The store revision is read *after* any bootstrap, never before one, and a held session is only
	 * reused when it still matches the revision on disk. Ordering it the other way round would make a
	 * rebind that lands between two connects look like ordinary progress: the caller would read the new
	 * revision first, find nothing held under it, and bootstrap a second time while the manager built
	 * on the previous deploy root stayed alive. Reading the revision first and comparing afterwards
	 * means any disagreement invalidates the held session instead of blessing it.
	 */
	async function ensureHeld(entry: HostEntry, hostId: string, signal?: AbortSignal): Promise<HeldBootstrap> {
		const current = await readRevision();
		throwIfCancelled(signal);
		if (entry.held !== undefined) {
			if (entry.held.revision === current) return entry.held;
			// A rebind/disable/re-verification superseded this helper location: the deploy root it names
			// may have been retired, so drop both the session and the manager that was built on it.
			discard(hostId, entry);
		}
		const generation = entry.generation;
		const nonce = ports.createNonce();
		if (!NONCE.test(nonce)) throw new Error("REMOTE_CONNECTION_NONCE_INVALID");
		// Resolve the node before bootstrapping. An explicit override skips discovery; otherwise the host
		// user's own node is found via their login shell. Only a fresh bootstrap pays for discovery — a
		// revision that already has a held session returns above without reaching here.
		const discovered = options.nodePath === undefined ? await ports.resolveNode({ userDataDir: options.userDataDir, hostId, client: hostClient(hostId), sentinel: ports.createSentinel(), ...(signal === undefined ? {} : { signal }) }) : undefined;
		const nodePath = discovered?.nodePath ?? options.nodePath;
		if (nodePath === undefined) throw new Error("REMOTE_NODE_NOT_FOUND");
		// A cancel between discovery and the entry spawn must not start an upload.
		throwIfCancelled(signal);
		// Discovery already asserted this version for this exact path; asking the host again costs a whole
		// SSH connection and cannot produce a different answer this soon.
		const prepared = await ports.bootstrap({ userDataDir: options.userDataDir, hostId, generation, nonce, nodePath, ...(discovered === undefined ? {} : { nodeVersion: discovered.version }), client: hostClient(hostId), launcher, ...(signal === undefined ? {} : { signal }) });
		// A cancelled attempt owns nothing: it must not publish a held session (or a deploy root) for the
		// next attempt to trust.
		throwIfCancelled(signal);
		// A newer attempt took this host over while the upload ran: its result is not this attempt's to publish.
		if (entry.generation !== generation) throw new Error("SSH_HOST_NOT_READY");
		// Re-read after the await: a rebind during the upload invalidates this result instead of
		// publishing a helper location that the profile no longer describes.
		const after = await readRevision();
		throwIfCancelled(signal);
		if (after !== current) throw new Error("SSH_HOST_NOT_READY");
		// Read the effective root after any await: a confirmation that landed while this bootstrap was in
		// flight must not be published under a session that started without it.
		const effectiveRoot = workspaceRoots.get(hostId) ?? options.root;
		const held: HeldBootstrap = {
			revision: after,
			generation,
			session: { nodePath, deployRoot: prepared.deployRoot, bundleSha256: prepared.bundleSha256, ...(effectiveRoot !== undefined ? { root: effectiveRoot } : {}) },
		};
		entry.held = held;
		return held;
	}

	/**
	 * Take this host's attempt slot for the duration of one operation that may bootstrap.
	 *
	 * The slot exists so `disconnect()`/`dispose()` can cancel work that owns the host lock *from outside
	 * it*; a read that has to bootstrap holds the lock exactly like a connect, so it must be cancellable the
	 * same way. Only one such operation runs at a time (all of them hold the host lock), which makes the slot
	 * exclusive by construction. `cancelWith` links a caller-owned signal to the same cancellation, so a read
	 * that named its own AbortSignal keeps reporting through it.
	 */
	async function withAttemptSlot<T>(entry: HostEntry, work: (signal: AbortSignal) => Promise<T>, cancelWith?: AbortSignal): Promise<T> {
		const existing = entry.attempt;
		const attempt: HostAttempt = existing ?? { generation: entry.generation, controller: new AbortController() };
		if (existing === undefined) entry.attempt = attempt;
		const onCancelWith = (): void => attempt.controller.abort();
		if (cancelWith?.aborted === true) attempt.controller.abort();
		cancelWith?.addEventListener("abort", onCancelWith, { once: true });
		try {
			return await work(attempt.controller.signal);
		} catch (error) {
			// A cancel that reached this slot owns the outcome: whatever the transport called the failure, the
			// fact the caller needs is that their operation was cancelled (withProjectSession maps this back
			// to REQUEST_CANCELLED when the caller's own signal was the cause).
			throwIfCancelled(attempt.controller.signal);
			throw error;
		} finally {
			cancelWith?.removeEventListener("abort", onCancelWith);
			// Only the operation that created the slot may clear it; an existing one belongs to its owner.
			if (existing === undefined && entry.attempt === attempt) entry.attempt = undefined;
		}
	}

	async function connectLocked(hostId: string): Promise<RemoteHostConnectResult> {
		if (disposed) return { ok: false, hostId, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
		if (!HOST_ID.test(hostId)) return { ok: false, hostId, code: "REMOTE_CONNECTION_HOST_ID_INVALID" };
		const entry = entryFor(hostId);
		if (explicitlyDisconnected.has(hostId)) return { ok: false, hostId, code: "SSH_HOST_DISCONNECTED" };
		entry.generation += 1;
		// Registered before the first await so disconnect()/dispose() can abort *this* attempt from outside
		// the host lock instead of queueing behind its upload.
		const attempt: HostAttempt = { generation: entry.generation, controller: new AbortController() };
		entry.attempt = attempt;

		const signal = attempt.controller.signal;
		// 池化模式：显式 connect 只证明「主机可达 + 部署包就绪」，不额外起一条没有 root 的 helper 进程。
		// 项目会话由第一次项目读按需建立；主机状态从这里记录，供 states()/requireReady 判断「主机是否在线」。
		if (rootPool !== undefined) {
			try {
				await ensureHeldShared(entry, hostId, signal);
				throwIfCancelled(signal);
				const ready: ConnectionMachineState = { hostId, generation: entry.generation, state: "ready", attempts: 0, latched: false };
				publishPooledState({ hostId, state: ready });
				return { ok: true, hostId, state: ready };
			} catch (error) {
				if (disposed) return { ok: false, hostId, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
				if (signal.aborted) return { ok: false, hostId, code: "SSH_HOST_DISCONNECTED" };
				const code = diagnosticCodeFromError(error);
				pooledHostStates.set(hostId, { hostId, generation: entry.generation, state: "offline", attempts: 0, latched: false, lastCode: code });
				return { ok: false, hostId, code };
			} finally {
				// 这条路径不建 manager，但 attempt 槽位属于本次调用：不清掉会让下一次 ensureHeldShared 复用一个已结束的 attempt。
				if (entry.attempt === attempt) entry.attempt = undefined;
			}
		}
		try {
			// A machine latched by an explicit disconnect can never be revived — the reducer drops every later
			// begin-attempt — so a latched manager is replaced instead of being reported as a live session.
			// Without this, the user's own "connect" after a disconnect succeeded on paper while the session
			// stayed dead, and every read kept failing with SSH_CONNECTION_NOT_READY.
			if (entry.manager !== undefined && entry.manager.getState(hostId).latched === true) discard(hostId, entry);
			const held = await ensureHeld(entry, hostId, signal);
			throwIfCancelled(signal);
			if (disposed) return { ok: false, hostId, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
			const manager = entry.manager ?? managerFor(held, hostId);
			entry.manager = manager;
			// needs-attention is terminal for the reducer: `begin-attempt` is dropped there, so a plain connect
			// would only report the terminal state back and the user's own "connect" could never leave it. The
			// reducer's one legal exit is `user-retry`, which is exactly what an explicit connect means here.
			const state = manager.getState(hostId).state === "needs-attention" ? await manager.retry(hostId) : await manager.connect(hostId);
			// A cancel that landed while the manager was connecting still settles this attempt as cancelled
			// rather than publishing "ready" for a user who walked away.
			throwIfCancelled(signal);
			return { ok: true, hostId, state };
		} catch (error) {
			// A failed/cancelled connect must not leave a helper session behind that the next attempt would trust.
			if (entry.attempt === attempt) discard(hostId, entry);
			if (disposed) return { ok: false, hostId, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
			if (signal.aborted) return { ok: false, hostId, code: "SSH_HOST_DISCONNECTED" };
			return { ok: false, hostId, code: diagnosticCodeFromError(error) };
		} finally {
			if (entry.attempt === attempt) entry.attempt = undefined;
		}
	}

	/**
	 * Establish (or revive) the ready session a project read needs, with the host's root applied.
	 *
	 * Split out of `withProjectSession` so that all of it runs *inside* the caller's lock, and so a thrown
	 * establish error can be translated into its own stable code instead of being flattened by the caller
	 * into a generic read failure. The returned session is bound to the manager it was established on.
	 */
	/**
	 * Re-prove that a project's boundary still canonicalizes to itself.
	 *
	 * A persisted `remotePath` is only a string from `ProjectStore`; nothing about it proves the directory is
	 * still the one the user confirmed. A path that was deleted, replaced, or whose symlink now points
	 * elsewhere would otherwise be read as if it were that boundary. Worth one pinned `readlink -f` per
	 * session establishment (drift is a low-frequency event); far too expensive on every read.
	 *
	 * This is also the only place a project's root status changes: a failure is recorded under (hostId, root)
	 * and a success clears that same key, so `projectRootStatus` answers from evidence instead of guessing.
	 */
	async function verifyProjectRoot(hostId: string, root: string): Promise<{ ok: true } | { ok: false; code: string }> {
		let canonicalPath: string;
		try {
			canonicalPath = (await ports.verifyRoot({ userDataDir: options.userDataDir, hostId, client: hostClient(hostId), userPath: root })).canonicalPath;
		} catch {
			// The probe's own code describes the probe, not the project boundary; callers act on the latter.
			return rememberRootFailure(hostId, root, "SSH_PROJECT_ROOT_UNRESOLVED");
		}
		if (canonicalPath !== root) return rememberRootFailure(hostId, root, "SSH_PROJECT_ROOT_CHANGED");
		// Only a proven boundary clears the record - and only its own key, so another project's unresolved
		// root on the same host stays visible.
		forgetRootFailure(hostId, root);
		return { ok: true };
	}

	async function establishProjectSession(hostId: string, root: string, signal?: AbortSignal): Promise<{ ok: true; session: RemoteProjectSession } | { ok: false; code: string }> {
		const entry = entryFor(hostId);
		// 保存令牌绑定host store代数；登记/重绑后不能一直复用旧held使所有重载永久失败。
		if (entry.held && entry.held.revision !== (await readRevision())) discard(hostId, entry);
		if ((workspaceRoots.get(hostId) ?? options.root) !== root) {
			// A different root means a different helper session: the running one was started with the old
			// `--root` (possibly none), so nothing about it can be reused.
			workspaceRoots.set(hostId, root);
			discard(hostId, entry);
		}
		let manager = entry.manager;
		// A ready session on the requested root is the only case that needs neither a probe nor a new session.
		let reestablish = true;
		if (manager !== undefined) {
			const current = manager.getState(hostId);
			if (current.latched === true) {
				// Latched is terminal for that machine; a fresh manager is the only way back.
				discard(hostId, entry);
				manager = undefined;
			} else if (TRANSIENT_SESSION_STATES.has(current.state)) {
				// An attempt is already in flight, or the manager is healing itself: rebuilding here would fight
				// it, so report the state's own code and let its owner finish.
				return { ok: false, code: current.lastCode ?? "SSH_HOST_NOT_READY" };
			} else if (current.state === "ready") {
				// A ready session normally skips the re-check: that is the hot-path promise, and a reuse must not pay
				// for a probe. The one exception is a key this service already marked failed - the record is then the
				// only thing making the project look broken, so re-verify before serving. It is also the only way such
				// a record can clear on a host whose session was re-established without a probe (an explicit connect
				// is not a boundary check), which would otherwise leave a permanent false warning while reads work.
				reestablish = rootFailures.get(hostId)?.has(root) === true;
			}
		}
		if (reestablish) {
			// Re-check the boundary before rebuilding or reconnecting on it. Runs here, inside the host's
			// operation lock: probing first and establishing outside it would leave a window in which the
			// verified path is not the path the session is actually confined to.
			const verified = await verifyProjectRoot(hostId, root);
			if (!verified.ok) {
				// Fail-closed read plus a per-project record (design (i), phase 4). The record is deliberately
				// project-scoped: a moved directory is a property of this confirmed path, not of the host's health,
				// so nothing here may drive the host connection state. Routing it into the host's needs-attention
				// would let one moved directory block every other project on that host - the exact outcome (i)
				// exists to avoid. Surfacing happens through `projectRootStatus`, which answers from this record
				// without touching the host: no connect, no probe, no session.
				//
				// Consequence, stated so it is not re-wired by accident: drift no longer calls
				// `manager.reportNeedsAttention` at all. That manager entry point and the reducer's newly opened
				// disconnected/offline sources stay as a general capability (the reachable needs-attention trigger
				// for root drift remains the helper handshake, SSH_HELPER_ROOT_MISMATCH, FATAL - covered end to end
				// in tests/sshConnectionManager.test.mjs), but they have no production caller for this condition.
				return verified;
			}
		}
		if (manager === undefined) {
			// A read that has to bootstrap holds the host lock for as long as a connect does, so it takes the
			// same attempt slot: an explicit disconnect/quit must be able to cancel *this* one too, instead of
			// waiting for the whole probe/upload budget it is supposed to stop.
			const created = await withAttemptSlot(
				entry,
				async (attemptSignal) => {
					const held = await ensureHeld(entry, hostId, attemptSignal);
					throwIfCancelled(attemptSignal);
					const built = managerFor(held, hostId);
					entry.manager = built;
					return { manager: built, connected: await built.connect(hostId) };
				},
				signal,
			);
			manager = created.manager;
			if (created.connected.state !== "ready") return { ok: false, code: created.connected.lastCode ?? "SSH_HOST_NOT_READY" };
		} else if (reestablish) {
			// disconnected/offline: the verified helper location is still valid, so revive in place instead of
			// paying for node discovery and another upload.
			const revived = await manager.connect(hostId);
			if (revived.state !== "ready") return { ok: false, code: revived.lastCode ?? "SSH_HOST_NOT_READY" };
		}
		const bound = manager;
		const held = entry.held;
		if (!held) return { ok: false, code: "SSH_HOST_NOT_READY" };
		// The launch ticket binds a host revision and its pin-confirmed route. A stale revision still fails closed, but a
		// store that cannot name the route must not disable ordinary reads: `hostRouteDigest: ""` makes the terminal
		// launcher refuse to mint (it requires 64 hex) while reads stay independent of the ticket surface.
		const route = await readVerifiedRoute(hostId);
		if (route !== null && route.revision !== held.revision) return { ok: false, code: "SSH_HOST_NOT_READY" };
		// 目录 watcher 的登记身份：同一个 manager、同一个连接代数 ⇒ 同一个 key；换根/重连/换 manager ⇒ 新 key。
		const connectionId = `${hostId}#${managerToken(bound)}#${bound.getState(hostId).generation}`;
		return {
			ok: true,
			session: buildProjectSession({
				hostId,
				manager: bound,
				held,
				connectionId,
				hostRouteDigest: route?.routeDigest ?? "",
				// 单会话路径的「我仍存在」判据：主机当前 manager 必须还是这一条。
				isCurrent: () => hosts.get(hostId)?.manager === bound,
			}),
		};
	}

	/** 两种模式共用身份、就绪与 revision 复验；差别仅在 manager 归属判据。 */
	function buildProjectSession(input: { hostId: string; manager: SshConnectionManager; held: HeldBootstrap; connectionId: string; hostRouteDigest: string; isCurrent: () => boolean }): RemoteProjectSession {
		const { hostId, manager: bound, held, connectionId, hostRouteDigest } = input;
		const isCurrent = (): boolean => !disposed && !explicitlyDisconnected.has(hostId) && input.isCurrent() && pooledConnectionId(hostId, bound) === connectionId;
		const assertBound = async (): Promise<void> => {
			if (!isCurrent() || bound.getState(hostId).state !== "ready" || (await readRevision()) !== held.revision) throw new Error("SSH_HOST_NOT_READY");
		};
		return {
			hostId,
			nodePath: held.session.nodePath,
			deployRoot: held.session.deployRoot,
			bundleSha256: held.session.bundleSha256,
			hostRouteDigest,
			hostRevision: held.revision,
			connectionId,
			async runCommand(remoteCommand) {
				// 每块重新校验pin和host store代数；不能拿旧Node路径向重绑后的主机发写命令。
				await assertBound();
				const invocation = await buildPinnedSshInvocation(options.userDataDir, hostId, "ssh-batch", { client: hostClient(hostId), remoteCommand });
				// pin/route构造本身有await；必须在真正启动写命令前再次把host代数绑定到已验证Node。
				await assertBound();
				const result = await hostClient(hostId).run(invocation.executable, invocation.args);
				return { exitCode: result.exitCode, stdout: result.stdout };
			},
			async withTerminalInvocation(remoteCommand, launch) {
				await assertBound();
				const invocation = await buildPinnedSshInvocation(options.userDataDir, hostId, "ssh-terminal", { client: hostClient(hostId), remoteCommand });
				await assertBound();
				// The PTY outlives helper-root switches, but never a host rebind, explicit disconnect or disposal.
				const assertCurrent = async () => {
					if (disposed || explicitlyDisconnected.has(hostId) || (await readRevision()) !== held.revision) throw new Error("SSH_HOST_NOT_READY");
				};
				return launch(invocation, assertCurrent);
			},
			async withSftpInvocation(launch) {
				await assertBound();
				const invocation = await buildPinnedSshInvocation(options.userDataDir, hostId, "ssh-sftp", { client: hostClient(hostId) });
				await assertBound();
				return launch(invocation, assertBound);
			},
			async request(method, params, requestOptions) {
				await assertBound();
				const result = await bound.request(hostId, method, params, requestOptions);
				await assertBound();
				return result;
			},
			cancel(requestId, requestOptions) {
				if (!isCurrent()) return Promise.reject(new Error("SSH_HOST_NOT_READY"));
				return bound.cancel(hostId, requestId, requestOptions);
			},
		};
	}

	/** 主机级代数：显式断开/重绑/换 held 都会推进它。池建立用它判断自己是否仍属于有效代。 */
	function hostEpochOf(hostId: string): number {
		return hostEpochs.get(hostId) ?? 0;
	}
	function bumpHostEpoch(hostId: string): void {
		hostEpochs.set(hostId, hostEpochOf(hostId) + 1);
	}

	/** 会话身份：manager 实例 + 连接代数；换 manager、重连、换代都会换值。 */
	function pooledConnectionId(hostId: string, manager: SshConnectionManager): string {
		return `${hostId}#${managerToken(manager)}#${manager.getState(hostId).generation}`;
	}

	/** 并发冷开共享主机 bootstrap；已就绪 root 的操作不经过此队列。 */
	async function ensureHeldShared(entry: HostEntry, hostId: string, signal?: AbortSignal): Promise<HeldBootstrap> {
		const pending = entry.heldPending;
		if (pending !== undefined) {
			const shared = await pending;
			throwIfCancelled(signal);
			return shared;
		}
		// Root cancellation must not abort the host bootstrap shared by other roots.
		const task = withAttemptSlot(entry, (attemptSignal) => ensureHeld(entry, hostId, attemptSignal));
		entry.heldPending = task;
		try {
			const held = await task;
			throwIfCancelled(signal);
			return held;
		} finally {
			if (entry.heldPending === task) entry.heldPending = undefined;
		}
	}

	/** 冷开复核 root，再复用主机 bootstrap 并建立独立 manager；失败只归本项目。 */
	async function establishPooledRoot(hostId: string, root: string, signal: AbortSignal): Promise<PooledRootSession> {
		if (disposed) throw new Error("REMOTE_CONNECTION_SERVICE_DISPOSED");
		if (explicitlyDisconnected.has(hostId)) throw new Error("SSH_HOST_DISCONNECTED");
		const epoch = hostEpochOf(hostId);
		const verified = root === "" ? { ok: true as const } : await verifyProjectRoot(hostId, root);
		if (!verified.ok) throw new Error(verified.code);
		throwIfCancelled(signal);
		const entry = entryFor(hostId);
		const held = await ensureHeldShared(entry, hostId, signal);
		throwIfCancelled(signal);
		if (disposed || explicitlyDisconnected.has(hostId) || hostEpochOf(hostId) !== epoch) throw new Error("SSH_HOST_NOT_READY");
		let built: SshConnectionManager | undefined;
		built = managerFor(held, hostId, { root, isCurrent: () => built !== undefined && (pooledPending.has(built) || rootPool?.peek(hostId, root)?.value.manager === built) });
		const manager = built;
		pooledPending.add(manager);
		const abort = (): void => {
			void manager.dispose().catch(() => undefined);
		};
		signal.addEventListener("abort", abort, { once: true });
		try {
			const connected = await manager.connect(hostId);
			throwIfCancelled(signal);
			if (connected.state !== "ready") throw new Error(connected.lastCode ?? "SSH_HOST_NOT_READY");
			// 建立过程中主机被显式断开/重绑：这条会话已不属于任何有效代，必须自毁而不是入池。
			if (disposed || explicitlyDisconnected.has(hostId) || hostEpochOf(hostId) !== epoch || (await readRevision()) !== held.revision) throw new Error(disposed ? "REMOTE_CONNECTION_SERVICE_DISPOSED" : "SSH_HOST_NOT_READY");
			// Transitions before publication are project-scoped; only a fully validated root may make the
			// host ready. Later failure/reconnect frames come from the published manager path above.
			publishPooledState({ hostId, state: connected });
			return { hostId, root, manager, held };
		} catch (error) {
			await manager.dispose().catch(() => undefined);
			throw error;
		} finally {
			pooledPending.delete(manager);
			signal.removeEventListener("abort", abort);
		}
	}

	/** requireReady 只认活会话或显式 connect 的证明；配置中的 root 不能证明在线。 */
	function hostOnline(hostId: string): boolean {
		if (pooledManager(hostId) !== undefined) return true;
		return pooledHostStates.get(hostId)?.state === "ready";
	}

	/** 租约覆盖整次项目操作；跨 root 不排队，在途条目不可被 TTL/LRU 回收。 */
	async function withPooledProjectSession<T>(hostId: string, root: string, task: (session: RemoteProjectSession) => Promise<T>, readOptions?: { requireReady?: boolean; signal?: AbortSignal }): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
		const pool = rootPool;
		const rootKey = hostId + "\u0000" + root;
		const rootEpoch = rootEpochs.get(rootKey);
		let hostEpoch = hostEpochOf(hostId);
		const isAborted = (): boolean => readOptions?.signal?.aborted === true;
		if (pool === undefined) return { ok: false, code: "SSH_HOST_NOT_READY" };
		// 用户的显式断开优先于后台读：一次读不能把主机偷偷连回来。
		if (explicitlyDisconnected.has(hostId)) return { ok: false, code: "SSH_HOST_DISCONNECTED" };
		if (isAborted()) return { ok: false, code: "REQUEST_CANCELLED" };
		// 重绑/禁用/重验会让 held 换代：池的热路径只做本地检查，所以这里用一次 store 快照把「主机身份变了」
		// 变成整池失效，而不是继续拿旧 deploy root 服务新项目。读的是已缓存的快照，不是远端往返。
		const hostEntry = hosts.get(hostId);
		if (hostEntry?.held !== undefined) {
			const revision = await readRevision();
			if (hostEpochOf(hostId) !== hostEpoch) return { ok: false, code: "SSH_HOST_NOT_READY" };
			if (hostEntry.held?.revision !== revision) {
				discard(hostId, hostEntry);
				hostEpoch = hostEpochOf(hostId);
			}
		}
		const existing = pool.peek(hostId, root);
		if (existing !== undefined) {
			const current = existing.value.manager.getState(hostId);
			if (current.latched === true) {
				// latched 对这台 root 的 manager 是终态：换一条新会话是唯一的回退路径。
				await pool.retireRoot(hostId, root, "latched");
			} else if (TRANSIENT_SESSION_STATES.has(current.state)) {
				// 已经在建立/自愈：重建只会和它抢，回报状态自己的码让持有者收尾。
				return { ok: false, code: current.lastCode ?? "SSH_HOST_NOT_READY" };
			}
		}
		if (existing === undefined && readOptions?.requireReady === true && !hostOnline(hostId)) return { ok: false, code: "SSH_HOST_NOT_READY" };
		if (rootEpochs.get(rootKey) !== rootEpoch || hostEpochOf(hostId) !== hostEpoch) return { ok: false, code: "SSH_HOST_NOT_READY" };
		let acquired;
		try {
			acquired = await pool.acquire({ hostId, root }, readOptions?.signal === undefined ? {} : { signal: readOptions.signal });
		} catch (error) {
			return { ok: false, code: diagnosticCodeFromError(error) };
		}
		if (!acquired.ok) return acquired;
		// acquire 与前面那次检查之间存在窗口：用户的显式断开可能刚好落在这一小段里。此时既不能把「断连之后
		// 才建好」的会话留在池里继续跑，也不能把它当成一次正常读。
		if (disposed || explicitlyDisconnected.has(hostId)) {
			acquired.lease.release();
			await pool.retireRoot(hostId, root, "explicit");
			return { ok: false, code: disposed ? "REMOTE_CONNECTION_SERVICE_DISPOSED" : "SSH_HOST_DISCONNECTED" };
		}
		if (isAborted()) {
			acquired.lease.release();
			return { ok: false, code: "REQUEST_CANCELLED" };
		}
		try {
			const bound = acquired.lease.value;
			// 启动票据绑定 host 代数与 pin 路线；读本身不依赖票据，但路线对不上说明这条会话已过期。
			const route = await readVerifiedRoute(hostId);
			if (route !== null && route.revision !== bound.held.revision) return { ok: false, code: "SSH_HOST_NOT_READY" };
			const isCurrent = (): boolean => pool.peek(hostId, root)?.value === bound && pooledConnectionId(hostId, bound.manager) === acquired.lease.connectionId;
			if (!isCurrent()) return { ok: false, code: "SSH_HOST_NOT_READY" };
			if (isAborted()) return { ok: false, code: "REQUEST_CANCELLED" };
			const session = buildProjectSession({
				hostId,
				manager: bound.manager,
				held: bound.held,
				connectionId: acquired.lease.connectionId,
				hostRouteDigest: route?.routeDigest ?? "",
				isCurrent,
			});
			const value = await task(session);
			if (!isCurrent() || (await readRevision()) !== bound.held.revision) return { ok: false, code: "SSH_HOST_NOT_READY" };
			return { ok: true, value };
		} catch (error) {
			if (readOptions?.signal?.aborted === true) return { ok: false, code: "REQUEST_CANCELLED" };
			throw error;
		} finally {
			acquired.lease.release();
		}
	}

	/** 只读缓存里的 home（`remoteHome` 的实现体；抽出来让「确保式」版本复用同一套校验）。 */
	const readCachedHome = async (hostId: string): Promise<string | undefined> => {
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return undefined;
		// HOME 是主机级事实：池化时任一已就绪 root 会话的握手结果都能回答它（与 root 无关）。
		const manager = pooledManager(hostId) ?? hosts.get(hostId)?.manager;
		if (manager === undefined) return undefined;
		try {
			// Only a live session whose handshake succeeded may name a home: reconnecting/offline (and a
			// terminal needs-attention) are not "connected", and a home recorded by an earlier ready session
			// must not outlive the session it was proven on.
			const state = manager.getState(hostId).state;
			if (state !== "ready" && state !== "degraded") return undefined;
			return readRemoteHome(manager.getHome(hostId));
		} catch {
			return undefined;
		}
	};

	/**
	 * 取一条**已就绪**的池会话 manager（HOME/主机能力这类事实与 root 无关，任一条都成立）。
	 * 只读：不建立、不租用、不延长条目寿命。
	 */
	function pooledManager(hostId: string): SshConnectionManager | undefined {
		if (rootPool === undefined) return undefined;
		for (const entry of rootPool.entries()) {
			if (entry.hostId !== hostId) continue;
			try {
				const state = entry.value.manager.getState(hostId).state;
				if (state === "ready" || state === "degraded") return entry.value.manager;
			} catch {
				continue;
			}
		}
		return undefined;
	}

	/**
	 * 池化 connect 只证明主机可达、刻意不建 root helper；此时没有 manager 可回答 HOME。
	 * 会话扫描仍然需要 HOME，因此用与 browse-root 同一条已验证的 pinned ssh 只读探针
	 * （固定命令、无 helper、不碰任何项目 root），把 HOME 作为主机级事实取回。
	 */
	const readHomeViaPinnedProbe = async (hostId: string): Promise<string | undefined> => {
		if (disposed || explicitlyDisconnected.has(hostId)) return undefined;
		const entry = entryFor(hostId);
		const held = entry.held;
		if (held === undefined) return undefined;
		const revision = held.revision;
		const invocation = await buildPinnedSshInvocation(options.userDataDir, hostId, "ssh-batch", { client: hostClient(hostId), remoteCommand: buildReadHomeCommand() });
		// pin 构造本身有 await：启动探针前再确认主机代数与断开状态都没变。
		if (disposed || explicitlyDisconnected.has(hostId) || entry.held?.revision !== revision) return undefined;
		const result = await hostClient(hostId).run(invocation.executable, invocation.args);
		if (result.exitCode !== 0) return undefined;
		return readRemoteHome(result.stdout.trim());
	};

	/**
	 * 解析某主机的已验证 HOME，**缓存状态读不到时按需建立会话**。
	 *
	 * `remoteHome` 是纯读：它只从「已经活着的会话」回答。这对会话扫描不够——扫描要用 HOME 推
	 * 会话根，而它通常紧跟在「登记/读取项目」之后执行，那些路径会在任务结束时收掉自己建立的临时
	 * 会话。于是扫描正好落进「没有缓存 manager/状态」的窗口，报「拿不到 home」，尽管那一刻完全
	 * 可以建立会话。真机 e2e 证据：前后状态都是 ready、同主机稍后再扫就成功。
	 *
	 * 这里 connect 不是额外开销：扫描本来就要做远端 I/O。**UI 用的 `remoteHome` 保持只读不变**。
	 */
	const readHomeEnsuring = async (hostId: string): Promise<string | undefined> => {
		if (disposed || explicitlyDisconnected.has(hostId)) return undefined;
		const cached = await readCachedHome(hostId);
		if (cached !== undefined) return cached;
		const entry = entryFor(hostId);
		const run = operationLock.run(hostId, () => connectLocked(hostId));
		entry.inFlight = run;
		try {
			const result = await run;
			if (!result.ok) return undefined;
		} catch {
			return undefined;
		} finally {
			if (entry.inFlight === run) entry.inFlight = undefined;
		}
		const afterConnect = await readCachedHome(hostId);
		if (afterConnect !== undefined) return afterConnect;
		// 池化路径没有 root helper：用 pinned 只读探针回答主机级 HOME。
		return rootPool === undefined ? undefined : readHomeViaPinnedProbe(hostId);
	};
	/**
	 * 写一份安全策略快照到该主机的部署根（原子替换）。
	 *
	 * 与 facts/扩展快照同一个 host 锁与同一种「按需建立 held session」语义：等级变更要能热推，
	 * 但推送本身不得与同主机的读取操作交错。失败抛稳定码，由调用方决定是否降级。
	 */
	const pushSnapshot = async (hostId: string, bytes: Buffer | Uint8Array): Promise<void> => {
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) throw new Error("SSH_HOST_ID_INVALID");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		await operationLock.run(hostId, async () => {
			const entry = entryFor(hostId);
			// 内容没变就不再来一轮 ssh（同一次 held session 内等级只变几次，但 spawn 可能很多次）。
			if (entry.securityPolicySha256 === sha256) return;
			if (entry.held === undefined) {
				const result = await connectLocked(hostId);
				if (!result.ok) throw new Error(result.code);
			}
			const held = entry.held;
			if (held === undefined) throw new Error("SSH_HOST_NOT_READY");
			await writeRemoteSecurityPolicySnapshot({
				userDataDir: options.userDataDir,
				hostId,
				generation: held.generation,
				nodePath: held.session.nodePath,
				deployRoot: held.session.deployRoot,
				bytes,
				client: hostClient(hostId),
				launcher,
				nonce: ports.createNonce(),
			});
			entry.securityPolicySha256 = sha256;
		});
	};
	/**
	 * 广播一份快照到当前仍有 held session 的主机（安全等级热更新）。
	 *
	 * 尽力而为：单台失败只记 warn（下一次 prepare 会在该主机重新推送），不把一次设置变更变成错误。
	 */
	const pushSnapshotToReadyHosts = async (bytes: Buffer | Uint8Array): Promise<void> => {
		const targets = [...hosts].filter(([, entry]) => entry.held !== undefined).map(([hostId]) => hostId);
		for (const hostId of targets) {
			try {
				await pushSnapshot(hostId, bytes);
			} catch (error) {
				const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
				void getAppLogger()?.warn("remote", "Remote security snapshot push failed", { hostId, code: typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : "SECURITY_SNAPSHOT_PUSH_FAILED" });
			}
		}
	};
	return {
		/**
		 * The verified client this service drives.
		 *
		 * Exposed to main-only consumers that must run their own pinned command against the same client the
		 * connection uses — resolving a browse root, for instance. Sharing the instance is the point: a second
		 * client could resolve through a different environment than the one the session was verified with.
		 */
		client: options.client,
		/**
		 * Replace this host's secret without opening a connection (the edit form's "save").
		 *
		 * Returns whether the value was also written to the encrypted store: a platform without an OS
		 * keyring keeps it for this session only, and the caller must not claim otherwise.
		 */
		async setHostSecret(hostId: string, secret: string): Promise<{ persisted: boolean }> {
			await applyHostPassword(hostId, secret);
			return { persisted: await credentials.available() };
		},
		/** The stored secret, decrypted for the edit form. Never crosses into a log or a host store file. */
		async readStoredSecret(hostId: string): Promise<string | undefined> {
			return credentials.get(hostId);
		},
		/** Drop this host's stored secret (host removal). A plain disconnect keeps it for the next connect. */
		async forgetHost(hostId: string): Promise<void> {
			await releaseHostPassword(hostId);
			await credentials.delete(hostId).catch(() => undefined);
		},
		/**
		 * Current machine state per host that has a live manager.
		 *
		 * State changes are pushed, so a view that unmounts (leaving settings) loses them and would render
		 * "disconnected" for a host that is still connected. This is the replay point for a fresh mount.
		 */
		states(): Record<string, RemoteHostConnectionState> {
			const current: Record<string, RemoteHostConnectionState> = {};
			for (const [hostId, entry] of hosts) {
				const state = entry.manager?.getState(hostId).state;
				if (state !== undefined) current[hostId] = state;
			}
			// 池化：一台主机的状态由它的各 root 会话聚合——任一条就绪即视为主机可用，显式 connect 的结论另记。
			for (const entry of rootPool?.entries() ?? []) {
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
		/** The client a pinned command for this host must use (a password host carries its askpass bridge). */
		clientForHost(hostId: string): SshClientRuntime {
			return hostClient(hostId);
		},
		/**
		 * 与会话配对的远端启动器：复用本服务**已验证的** client 与同一个 ssh launcher。
		 *
		 * 为什么在这里造而不是让调用方自己 new：第二条通道一旦用另一个 client 实例，就会用一套不同于会话
		 * 验证时的环境/路径去拉 ssh——那正是「连得上但行为不一样」的根源；而且 launcher 的生命周期本就属于本服务。
		 */
		createPiRuntimeLauncher(hostId: string): PiRuntimeLauncher {
			return createSshPiRuntimeLauncher({ userDataDir: options.userDataDir, client: hostClient(hostId), launcher });
		},
		/** Bootstrap-then-connect one host. Every failure is a stable code, never a thrown message. */
		async connect(hostId: string, input?: { password?: string }): Promise<RemoteHostConnectResult> {
			if (input?.password !== undefined) {
				try {
					await applyHostPassword(hostId, input.password);
				} catch {
					return { ok: false, hostId, code: "SSH_PASSWORD_INVALID" };
				}
			}
			// A password host can only be driven while a secret is held: without it every ssh child below would
			// start a password prompt that no bridge can answer, and the failure would surface as a generic timeout.
			const profile = await readProfile(hostId);
			if (profile?.authMethod === "password" && !hostClients.has(hostId)) {
				// A stored secret (encrypted at rest) is the normal path after the first connect; only when
				// none exists, or it cannot be decrypted on this machine, does the UI have to ask again.
				const stored = await credentials.get(hostId);
				if (stored !== undefined) await applyHostPassword(hostId, stored).catch(() => undefined);
				if (!hostClients.has(hostId)) return { ok: false, hostId, code: "SSH_PASSWORD_REQUIRED" };
			}
			const entry = entryFor(hostId);
			// Only this explicit user boundary may undo a disconnect; session scanning also uses connectLocked.
			const run = operationLock.run(hostId, () => {
				explicitlyDisconnected.delete(hostId);
				return connectLocked(hostId);
			});
			entry.inFlight = run;
			try {
				return await run;
			} finally {
				if (entry.inFlight === run) entry.inFlight = undefined;
			}
		},
		/**
		 * The verified remote HOME of one host, for readers that derive a remote session root from it.
		 *
		 * Narrow on purpose, and it never throws: an unknown host, a host with no manager, a host whose
		 * machine is not actually connected, and a home that does not look like an absolute POSIX path all
		 * answer `undefined`. Callers run across IPC, where "not connected yet" is an ordinary state, not an
		 * error. The value is remote input, so it is re-validated here rather than trusted because the
		 * manager already filtered it once.
		 */
		async remoteHome(hostId: string): Promise<string | undefined> {
			return readCachedHome(hostId);
		},
		/**
		 * The capability names the last successful hello declared for this host, or undefined when no live
		 * session proves any.
		 *
		 * Read-only and never connects: a project surface negotiates optional work (content search) from a
		 * session that already exists, and "no session" must answer "unknown/unsupported" instead of waking a
		 * host. Only a ready/degraded session may answer, for the same reason remoteHome refuses one.
		 */
		helperCapabilities(hostId: string): readonly string[] | undefined {
			if (disposed || explicitlyDisconnected.has(hostId)) return undefined;
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
		/**
		 * The capabilities **the session of this project's root** negotiated, never a sibling root's.
		 *
		 * Same rule as `projectConnectionFacts`, one layer lower: a capability is a property of the helper process
		 * that declared it. Answering a project from whatever session the host happens to hold now would advertise
		 * content search on a root whose helper never declared it (or deny it because a neighbouring project asked
		 * while the host was offline). Undefined means "unknown", and callers must treat it as unsupported instead
		 * of guessing.
		 */
		projectHelperCapabilities(hostId: string, canonicalRoot: string): readonly string[] | undefined {
			if (disposed || explicitlyDisconnected.has(hostId)) return undefined;
			if (typeof canonicalRoot !== "string" || canonicalRoot.length === 0) return undefined;
			// 池化：能力属于声明它的那条 helper 会话，因此只从本 root 的会话回答。
			const pooledEntry = rootPool?.peek(hostId, canonicalRoot);
			if (pooledEntry !== undefined) {
				try {
					const state = pooledEntry.value.manager.getState(hostId).state;
					if (state !== "ready" && state !== "degraded") return undefined;
					return pooledEntry.value.manager.getCapabilities(hostId);
				} catch {
					return undefined;
				}
			}
			if (rootPool !== undefined) return undefined;
			const manager = hosts.get(hostId)?.manager;
			if (manager === undefined) return undefined;
			if ((workspaceRoots.get(hostId) ?? options.root) !== canonicalRoot) return undefined;
			try {
				const state = manager.getState(hostId).state;
				if (state !== "ready" && state !== "degraded") return undefined;
				return manager.getCapabilities(hostId);
			} catch {
				return undefined;
			}
		},
		/** 按连接身份成对保活；单会话模式为空操作。 */
		retainProjectSessionWatch(hostId: string, root: string, connectionId: string): void {
			rootPool?.retainWatch(hostId, root, connectionId);
		},
		/** 成对释放保活（最后一条订阅退掉时必须调用，否则这条会话永远不会被回收）。 */
		releaseProjectSessionWatch(hostId: string, root: string, connectionId: string): void {
			rootPool?.releaseWatch(hostId, root, connectionId);
		},
		/** Main-only project removal: retire this boundary, including any unfinished acquire. */
		async retireProjectSession(hostId: string, root: string): Promise<void> {
			const key = hostId + "\u0000" + root;
			rootEpochs.set(key, (rootEpochs.get(key) ?? 0) + 1);
			await rootPool?.retireRoot(hostId, root, "explicit");
		},
		rootPoolStats: () => rootPool?.stats(),
		async remoteHomeEnsuring(hostId: string): Promise<string | undefined> {
			return readHomeEnsuring(hostId);
		},
		/**
		 * The last re-check outcome of one project's confirmed boundary, by (hostId, root).
		 *
		 * Read-only and side-effect free by construction: the answer comes from what previous re-checks
		 * recorded, so asking never connects, never probes and never opens a session - that is what lets the UI
		 * ask on every render without waking a host. A key this service never saw, or one whose re-check later
		 * succeeded, is "ok": the status says nothing is *known* to be wrong with this path, and knowing more
		 * requires a real re-check at session establishment, not a query.
		 *
		 * Project-scoped on purpose (design (i)): the same host can hold a drifted project and healthy ones,
		 * and each answers for its own root.
		 */
		projectRootStatus(hostId: string, root: string): { status: "ok" } | { status: "needs-attention"; code: string } {
			const code = rootFailures.get(hostId)?.get(root);
			return code === undefined ? { status: "ok" } : { status: "needs-attention", code };
		},
		/**
		 * Point this host's next session at a confirmed workspace root.
		 *
		 * Discards the held session and its manager: the running helper was started with a different `--root`
		 * (possibly none), and the root is fixed for the life of a helper process, so nothing about that
		 * session can be reused. The caller reconnects; the next bootstrap carries the new root.
		 */
		setWorkspaceRoot(hostId: string, root: string | undefined): void {
			if (root === undefined) workspaceRoots.delete(hostId);
			else workspaceRoots.set(hostId, root);
			const entry = hosts.get(hostId);
			if (entry !== undefined) discard(hostId, entry);
		},
		// 刻意不提供 getWorkspaceRoot()：它只能回答「配置里记着的 root」，永远证明不了 live helper 是否
		// ready。上一版正是用它的字符串相等当作「会话可用」的判据，于是同 root 的失败重试永远跳过重连。
		// 需要 root + 就绪判定时走 withProjectSession（或 IPC 的 projectReadTarget），不要在读路径上再问一次配置值。
		/**
		 * Release the live session of one host without forgetting its verified bootstrap.
		 *
		 * The user's decision is recorded here, not re-derived later: a background read of the same root must
		 * report "disconnected" instead of quietly reconnecting and undoing what the user asked for. Only an
		 * explicit `connect` clears it again.
		 */
		async disconnect(hostId: string, reason: "abort" | "shutdown"): Promise<void> {
			// The user's decision is recorded before anything waits, and the in-flight attempt is cancelled
			// *before* the lock is entered: that attempt holds the lock for its whole upload/finalize, so a
			// cancel queued behind the lock would wait for the very work it is meant to stop. A read that
			// starts between the two observations sees the intent and reports SSH_HOST_DISCONNECTED.
			if (HOST_ID.test(hostId)) {
				explicitlyDisconnected.add(hostId);
				hosts.get(hostId)?.attempt?.controller.abort();
			}
			await operationLock.run(hostId, async () => {
				if (HOST_ID.test(hostId)) explicitlyDisconnected.add(hostId);
				options.onDisconnect?.(hostId);
				const entry = hosts.get(hostId);
				const manager = entry?.manager;
				if (manager !== undefined) await manager.disconnect(hostId, reason).catch(() => undefined);
				// A disconnect ends the authenticated session, so the secret it needed must not outlive it.
				// 显式断开同样让该主机的整池作废：没有任何 root 会话可以活在被用户断开的连接上。
				if (rootPool !== undefined) {
					bumpHostEpoch(hostId);
					await rootPool.retireHost(hostId, "explicit");
				}
				pooledHostStates.delete(hostId);
				await releaseHostPassword(hostId);
			});
		},
		listDiagnostics(hostId?: string) {
			const fromHosts = hostId !== undefined ? (hosts.get(hostId)?.manager?.listDiagnostics(hostId) ?? []) : [...hosts.values()].flatMap((entry) => entry.manager?.listDiagnostics() ?? []);
			// 池化：每条 root 会话各有自己的诊断序列，全部并入（同主机多条会话不该互相遮盖）。
			const fromPool = (rootPool?.entries() ?? []).filter((entry) => hostId === undefined || entry.hostId === hostId).flatMap((entry) => entry.value.manager.listDiagnostics(entry.hostId));
			return [...fromHosts, ...fromPool];
		},
		/**
		 * 一台主机上「跑远端 pi 会话」所需的全部事实：解释器、pi 入口、runner 路径。
		 *
		 * 只读，但**按需建立受管会话**（与会话扫描的 `remoteHomeEnsuring` 同一立场：调用它的路径紧接着就要
		 * 起会话，先拿事实再单独连一次只会多一次往返）。`runnerPath` 由 held bootstrap 的
		 * `{deployRoot, bundleSha256}` 推出（内容寻址，不存在“路径漂移”）；pi 探测按 held bootstrap 缓存
		 * （重连/rebind 会丢掉 held，缓存随之失效——所以不需要 TTL）。
		 *
		 * 失败一律稳定码：`SSH_HOST_ID_INVALID`（入参）、`SSH_HOST_NOT_READY`（会话没建起来），
		 * 其余是探测自己的 `REMOTE_PI_*` 码原样透传（调用方据此给升级指引）。
		 */
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
								const observation = await ports.resolvePi({ userDataDir: options.userDataDir, hostId, client: hostClient(hostId), sentinel: ports.createSentinel(), nodePath: held.session.nodePath, ...(piPath === undefined ? {} : { piPath }) });
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
		/**
		 * 记住（或清除）这台主机手填的远端 pi 路径，并作废本代 held session 上缓存的探测结果。
		 *
		 * 只写 profile 的一个字段：不碰端点、不碰 pin、不换 generation（换一条 pi 路径不影响连接本身）。
		 * 缓存必须在这里清：缓存键是 held 的 `revision + generation`，而写库不会自动改这两个值——
		 * 不清就会让下一次探测拿旧路径的答案当新路径的事实。
		 *
		 * 形状校验在 IPC 边界与 store 各做一次：这里只负责写库与失效，不把业务规则再写一份。
		 */
		async setRemotePiCommand(hostId: string, command: string | undefined): Promise<void> {
			if (typeof hostId !== "string" || !HOST_ID.test(hostId)) throw new Error("SSH_HOST_ID_INVALID");
			return operationLock.run(hostId, async () => {
				const store = await RemoteHostStore.open(options.userDataDir);
				const snapshot = store.getSnapshot();
				if (snapshot.status !== "ready") throw new Error("REMOTE_HOST_STORE_NEEDS_REPAIR");
				if (!snapshot.profiles.some((profile) => profile.id === hostId)) throw new Error("REMOTE_HOST_NOT_FOUND");
				await store.updateProfile(hostId, { remotePiCommand: command }, snapshot.revision);
				const entry = hosts.get(hostId);
				if (entry !== undefined) entry.piProbe = undefined;
			});
		},
		/**
		 * 部署本机生效的内置扩展快照，返回内容寻址根（`-e` 的父路径）。
		 *
		 * 与 `remotePiRuntimeFacts` 同一个锁与同一种「按需建立 held session」语义；缓存键是
		 * revision + generation，所以重连/换根之后的第一次会话会重新部署（入口对已激活目录做只读复验，
		 * 内容一致时不会重复改写）。任何失败都折叠成稳定码返回——扩展缺失是降级，不能卡住会话。
		 */
		async ensureRemoteExtensionSnapshot(hostId: string): Promise<RemoteExtensionSnapshotFacts> {
			if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return { ok: false, code: "SSH_HOST_ID_INVALID" };
			const roots = options.builtInExtensionRoots;
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
						userDataDir: options.userDataDir,
						hostId,
						generation: held.generation,
						nonce: ports.createNonce(),
						nodePath: held.session.nodePath,
						client: hostClient(hostId),
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
						userDataDir: options.userDataDir,
						hostId,
						client: hostClient(hostId),
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
		async pushSecurityPolicySnapshot(hostId: string, bytes: Buffer | Uint8Array): Promise<void> {
			await pushSnapshot(hostId, bytes);
		},
		async pushSecurityPolicySnapshotToReadyHosts(bytes: Buffer | Uint8Array): Promise<void> {
			await pushSnapshotToReadyHosts(bytes);
		},
		/**
		 * Send one helper request on a ready host.
		 *
		 * **Not for project reads.** This resolves the host's *current* manager at call time, so a root switch
		 * between two calls of one operation would serve them from different sessions — the exact defect this
		 * batch removed. Read-only project surfaces must go through `withProjectSession`, which holds the
		 * host's operation lock for the whole operation and pins the session to one manager.
		 *
		 * Kept because it is the documented narrow transport-port shape (the reader owns the method-level
		 * contract; the service owns the session) and it is what main-only callers use for one-off pinned
		 * commands. The manager already refuses anything but a ready host with a live protocol client.
		 */
		request(hostId: string, method: string, params?: unknown, options?: { timeoutMs?: number; onRequestId?: (requestId: string) => void; repo?: string }): Promise<unknown> {
			// Host configuration has no project root. Its helper occupies the same bounded pool.
			if (rootPool !== undefined)
				return withPooledProjectSession(hostId, "", (session) => session.request(method, params, options), { requireReady: true }).then((result) => {
					if (!result.ok) throw new Error(result.code);
					return result.value;
				});
			const manager = hosts.get(hostId)?.manager;
			if (manager === undefined) return Promise.reject(new Error("SSH_HOST_NOT_READY"));
			return manager.request(hostId, method, params, options);
		},
		/** Withdraw a request a ready host is still holding, by the id `request` reported. */
		cancel(hostId: string, requestId: string, options?: { timeoutMs?: number }): Promise<unknown> {
			const manager = rootPool === undefined ? hosts.get(hostId)?.manager : rootPool.peek(hostId, "")?.value.manager;
			if (manager === undefined) return Promise.reject(new Error("SSH_HOST_NOT_READY"));
			return manager.cancel(hostId, requestId, options);
		},
		/**
		 * 只读当前连接事实：稳定 helper 身份 + 当前状态。**不连接、不建会话、不持锁**。
		 *
		 * 事实缓存用它做两件事：把跨调用缓存围栏到一代 helper（换根/重连 ⇒ 新身份）；缓存命中前
		 * 确认连接仍然可用（离线时不得返回暖缓存成功）。没有 manager 或已显式断开时返回 undefined。
		 */
		connectionFacts(hostId: string): { connectionId: string; state: RemoteHostConnectionState } | undefined {
			if (disposed || explicitlyDisconnected.has(hostId)) return undefined;
			const entry = hosts.get(hostId);
			// 池化：主机级事实取任一已就绪 root 会话的身份（项目级请用 projectConnectionFacts）。
			const pooledManagerForHost = pooledManager(hostId);
			if (rootPool !== undefined) {
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
		/**
		 * The connection facts of **one project's root**, or undefined when this service cannot prove them.
		 *
		 * The host-level `connectionFacts` answers "is this machine connected"; a project needs "is the session that
		 * serves *my* root connected", because one host can hold several roots. A project reader that fences its
		 * cache on the host's current manager would accept facts produced on a sibling root - the exact cross-root
		 * bleed the pooled path must not reintroduce. The answer is therefore only returned when the live session is
		 * confined to this canonical root; any other state (another root, no session, explicit disconnect) is
		 * "unknown" rather than "the host looks fine".
		 *
		 * Read-only by construction: it never connects, never probes and never creates a session, so a project
		 * surface may ask on every render, and an offline host is never woken by a cache check.
		 */
		projectConnectionFacts(hostId: string, canonicalRoot: string): { connectionId: string; state: RemoteHostConnectionState } | undefined {
			if (disposed || explicitlyDisconnected.has(hostId)) return undefined;
			if (typeof canonicalRoot !== "string" || canonicalRoot.length === 0) return undefined;
			const entry = hosts.get(hostId);
			// 池化：项目事实来自**这个 root 自己的会话**，绝不取主机当前 manager、也不回退兄弟 root。
			const pooled = rootPool?.peek(hostId, canonicalRoot);
			if (pooled !== undefined) {
				try {
					const state = pooled.value.manager.getState(hostId);
					return { connectionId: pooledConnectionId(hostId, pooled.value.manager), state: state.state };
				} catch {
					return undefined;
				}
			}
			if (rootPool !== undefined) return undefined;
			const manager = entry?.manager;
			if (manager === undefined) return undefined;
			// The root is the helper's `--root`: a session established for another boundary serves no path of this
			// one, so its identity must not be handed out as this project's generation.
			if ((workspaceRoots.get(hostId) ?? options.root) !== canonicalRoot) return undefined;
			try {
				const state = manager.getState(hostId);
				return { connectionId: `${hostId}#${managerToken(manager)}#${state.generation}`, state: state.state };
			} catch {
				return undefined;
			}
		},
		/**
		 * Stable project scope for a one-shot transfer job: the manager identity and the
		 * verified host-store revision that produced its deployment facts.
		 *
		 * Like `projectConnectionFacts`, this never connects and never accepts a sibling
		 * root. It additionally exposes the revision the job registry needs; callers
		 * still re-establish the session under `withProjectSession` before writing.
		 */
		projectTransferIdentity(hostId: string, canonicalRoot: string): { connectionId: string; hostRevision: number; state: RemoteHostConnectionState } | undefined {
			if (disposed || explicitlyDisconnected.has(hostId)) return undefined;
			if (typeof canonicalRoot !== "string" || canonicalRoot.length === 0) return undefined;
			const pooled = rootPool?.peek(hostId, canonicalRoot);
			if (pooled !== undefined) {
				try {
					const state = pooled.value.manager.getState(hostId);
					return { connectionId: pooledConnectionId(hostId, pooled.value.manager), hostRevision: pooled.value.held.revision, state: state.state };
				} catch {
					return undefined;
				}
			}
			if (rootPool !== undefined) return undefined;
			const entry = hosts.get(hostId);
			const manager = entry?.manager;
			const held = entry?.held;
			if (manager === undefined || held === undefined) return undefined;
			if ((workspaceRoots.get(hostId) ?? options.root) !== canonicalRoot) return undefined;
			try {
				const state = manager.getState(hostId);
				return { connectionId: `${hostId}#${managerToken(manager)}#${state.generation}`, hostRevision: held.revision, state: state.state };
			} catch {
				return undefined;
			}
		},
		/**
		 * Run one whole read-only operation against a host confined to `root`, with the session pinned.
		 *
		 * This is the single per-host boundary the whole batch exists for: switching the root, establishing the
		 * session and every frame of the operation that follows happen while holding the host's operation lock,
		 * so another project's switch queues behind instead of tearing the session down mid-read. The previous
		 * shape serialized only the switch and left the multi-chunk read outside the boundary.
		 *
		 * Beyond exclusion, the session handed to the task is *bound* to the manager it was established on: if
		 * anything ever replaces or discards that manager, the next frame fails closed with SSH_HOST_NOT_READY
		 * instead of being served by a session confined to a different root. Exclusion alone would leave that
		 * failure mode reachable the moment a future caller mutates the session outside the lock, and silently
		 * returning another project's file is the exact outcome worth a guard.
		 *
		 * Setup failures settle as `{ ok: false, code }`; a failure of the operation itself rejects so the
		 * caller keeps the reader's own stable codes.
		 */
		async withProjectSession<T>(hostId: string, root: string, task: (session: RemoteProjectSession) => Promise<T>, readOptions?: { requireReady?: boolean; signal?: AbortSignal }): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
			if (disposed) return { ok: false, code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
			if (!HOST_ID.test(hostId) || typeof root !== "string" || root.length === 0) return { ok: false, code: "SSH_HOST_NOT_READY" };
			// 池化：按 (host, root) 租用会话，操作期间持租约（在途写不会被 TTL/LRU 回收）。
			if (rootPool !== undefined) return withPooledProjectSession(hostId, root, task, readOptions);
			return operationLock.run(hostId, async () => {
				// The user's explicit disconnect outranks a background read: report it rather than reconnecting.
				if (explicitlyDisconnected.has(hostId)) return { ok: false, code: "SSH_HOST_DISCONNECTED" };
				// Git panel reads may switch a ready helper's project root, but never revive an offline host.
				// Apply this inside the same host lock, not just in a renderer/preflight state check.
				if (readOptions?.signal?.aborted) return { ok: false, code: "REQUEST_CANCELLED" };
				if (readOptions?.requireReady && hosts.get(hostId)?.manager?.getState(hostId).state !== "ready") return { ok: false, code: "SSH_HOST_NOT_READY" };
				let session: RemoteProjectSession;
				try {
					const established = await establishProjectSession(hostId, root, readOptions?.signal);
					if (!established.ok) return established;
					session = established.session;
				} catch (error) {
					// A cancel during establishment is the caller's own withdrawal, reported with the read channel's
					// code (the same one a cancel before or after establishment produces).
					if (readOptions?.signal?.aborted) return { ok: false, code: "REQUEST_CANCELLED" };
					// Establishing can fail in ways only the connection layer can name (a failed bootstrap, a
					// disposed manager). Relaying its own stable code keeps the UI's hint truthful; a thrown
					// surprise would otherwise be flattened into a generic read failure by the caller.
					return { ok: false, code: diagnosticCodeFromError(error) };
				}
				if (readOptions?.signal?.aborted) return { ok: false, code: "REQUEST_CANCELLED" };
				return { ok: true, value: await task(session) };
			});
		},
		/** Idempotent teardown waits for attempts and helpers; no late publication after disposal. */
		dispose(): Promise<void> {
			disposing ??= (async () => {
				disposed = true;
				// Abort every in-flight attempt before waiting for it: an upload that ignored the cancel would
				// otherwise hold quit open for its whole session budget. Each attempt settles its own waits and
				// releases the lock, so the awaits below converge promptly.
				for (const entry of hosts.values()) entry.attempt?.controller.abort();
				for (const hostId of hosts.keys()) options.onDisconnect?.(hostId);
				const entries = [...hosts.entries()];
				const pending = entries.flatMap(([, entry]) => (entry.inFlight === undefined ? [] : [entry.inFlight.catch(() => undefined)]));
				await Promise.all(pending);
				for (const [hostId, entry] of entries) discard(hostId, entry);
				// 池与 held 同源：先让池退役每条 root 会话，再清主机表，最后停掉保温回收定时器。
				if (rootPool !== undefined) await rootPool.dispose();
				if (sweepTimer !== undefined) cancelSweepTimer(sweepTimer);
				hosts.clear();
				await Promise.all([...askpassBridges.keys()].map((hostId) => releaseHostPassword(hostId)));
			})();
			return disposing;
		},
	};
}

export type RemoteHostConnectionService = ReturnType<typeof createRemoteHostConnectionService>;
