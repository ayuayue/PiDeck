import { buildPinnedSshInvocation, type PinnedSshInvocation } from "./SshVerifiedConnection";
import { pooledConnectionId } from "./remoteHostConnectionGuards";
import type { SshClientRuntime } from "./SshClientRuntime";
import type { SshConnectionManager } from "./SshConnectionManager";

/**
 * 一条**绑定到某个 manager 的**项目会话包装（`RemoteProjectSession`）。
 *
 * 为什么单独成模块：整套读路径的价值都在这一层——每一帧先复核「这条会话仍是那个 manager、那个 root、
 * 那个 host store 代数」，否则 fail-closed。它只读宿主状态（`disposed` / `explicitlyDisconnected` /
 * store revision），不写任何状态，所以能整段搬出闭包。
 */

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

/** 会话建立所用的 held bootstrap 切片：包装只需内容地址与代数。 */
export type ProjectSessionHeld = {
	readonly revision: number;
	readonly session: { readonly nodePath: string; readonly deployRoot: string; readonly bundleSha256: string };
};

export type ProjectSessionBindingInput = {
	hostId: string;
	manager: SshConnectionManager;
	held: ProjectSessionHeld;
	connectionId: string;
	hostRouteDigest: string;
	isCurrent: () => boolean;
};

export type RemoteProjectSessionBuilderDeps = {
	userDataDir: string;
	clientFor: (hostId: string) => SshClientRuntime;
	/** 当前 host store 代数（写入前复核，防止拿旧 Node 路径向重绑后的主机写）。 */
	readRevision: () => Promise<number>;
	isDisposed: () => boolean;
	/** 用户显式断开过的主机：任何后台读都不得把它偷偷接回来。 */
	explicitlyDisconnected: ReadonlySet<string>;
};

export function createRemoteProjectSessionBuilder(deps: RemoteProjectSessionBuilderDeps) {
	const { userDataDir, clientFor, readRevision, isDisposed, explicitlyDisconnected } = deps;

	return {
		build(input: ProjectSessionBindingInput): RemoteProjectSession {
			const { hostId, manager: bound, held, connectionId, hostRouteDigest } = input;
			const isCurrent = (): boolean => !isDisposed() && !explicitlyDisconnected.has(hostId) && input.isCurrent() && pooledConnectionId(hostId, bound) === connectionId;
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
					const invocation = await buildPinnedSshInvocation(userDataDir, hostId, "ssh-batch", { client: clientFor(hostId), remoteCommand });
					// pin/route构造本身有await；必须在真正启动写命令前再次把host代数绑定到已验证Node。
					await assertBound();
					const result = await clientFor(hostId).run(invocation.executable, invocation.args);
					return { exitCode: result.exitCode, stdout: result.stdout };
				},
				async withTerminalInvocation(remoteCommand, launch) {
					await assertBound();
					const invocation = await buildPinnedSshInvocation(userDataDir, hostId, "ssh-terminal", { client: clientFor(hostId), remoteCommand });
					await assertBound();
					// The PTY outlives helper-root switches, but never a host rebind, explicit disconnect or disposal.
					const assertCurrent = async () => {
						if (isDisposed() || explicitlyDisconnected.has(hostId) || (await readRevision()) !== held.revision) throw new Error("SSH_HOST_NOT_READY");
					};
					return launch(invocation, assertCurrent);
				},
				async withSftpInvocation(launch) {
					await assertBound();
					const invocation = await buildPinnedSshInvocation(userDataDir, hostId, "ssh-sftp", { client: clientFor(hostId) });
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
		},
	};
}
