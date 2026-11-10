import { buildPinnedSshInvocation, type PinnedSshInvocation } from "./SshVerifiedConnection";
import { frozenHelperBundleManifest, deployFrozenHelperBundle, type PreparedBundleResult } from "./RemoteBootstrapDeployment";
import { maintainDeployedBundles, type RemoteBundleMaintenanceOutcome } from "./RemoteBundleMaintenance";
import { getAppLogger } from "../logging/sharedLogger";
import { decodeBootstrapResult, type BootstrapReadyFrame, type BootstrapSession } from "./RemoteBootstrapTransfer";
import { assertSupportedRemoteNodeVersion, buildRemoteNodeVersionCommand, REMOTE_BOOTSTRAP_ENTRY_ERROR_CODES, type RemoteBootstrapTarget } from "./RemoteBootstrapContract";
import { buildLoginShellPathCommands, listNodeCandidatesFromPath, parseLoginShellPath } from "./RemoteNodeDiscovery";
import { REMOTE_BOOTSTRAP_PROTOCOL_VERSION } from "./RemoteHelperContract";
import type { SshLauncherHandle, SshProcessExit, SshProcessLauncher } from "./RemoteHostConnectionTypes";
import type { SshClientRuntime, SshCommandResult } from "./SshClientRuntime";

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const READY_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 300_000; // ready (30s) + upload (120s) + finalize (120s) + cleanup margin
/**
 * How many PATH candidates may be probed before giving up. PATH can list many node installs and each
 * probe is a real round trip; an unbounded walk would let a hostile or careless PATH turn one connect
 * into an arbitrary number of remote commands. The login shell puts the user's own node first (nvm
 * prepends its bin directory), so the answer is essentially always the first candidate.
 */
const MAX_NODE_CANDIDATES = 3;

/** Bounded metadata for a bootstrap entry that exited without a protocol error frame. */
export class BootstrapReadyUnconfirmedError extends Error {
	constructor(
		readonly exitKind: SshProcessExit["kind"] | "deadline",
		readonly exitCode: number | null,
		readonly stderrSeen: boolean,
	) {
		super("BOOTSTRAP_READY_UNCONFIRMED");
	}
}

/**
 * Cancellation of one bootstrap attempt. It is a stable code and not free text: every caller (connect,
 * disconnect, dispose) flattens a thrown value into a code, and this one has to keep the meaning
 * "the user cancelled" all the way to the renderer instead of degrading to a generic failure.
 */
export const REMOTE_BOOTSTRAP_ABORTED = "BOOTSTRAP_ABORTED";

/** Throw the stable cancellation code when this attempt was already cancelled. */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw new Error(REMOTE_BOOTSTRAP_ABORTED);
}

/** Wait for the frozen entry to acknowledge the exact bundle and nonce before allowing upload. */
function awaitBootstrapReady(session: SshLauncherHandle, expected: { bundleSha256: string; nonce: string; target: RemoteBootstrapTarget }, signal?: AbortSignal): Promise<BootstrapReadyFrame> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stderrSeen = false;
		let offLine: (() => void) | undefined;
		let offStderr: (() => void) | undefined;
		let offExit: (() => void) | undefined;
		const timer = setTimeout(() => fail(new BootstrapReadyUnconfirmedError("deadline", null, stderrSeen)), READY_TIMEOUT_MS);
		const onAbort = (): void => fail(REMOTE_BOOTSTRAP_ABORTED);
		const clear = (): void => {
			clearTimeout(timer);
			offLine?.();
			offStderr?.();
			offExit?.();
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (reason: string | Error): void => {
			if (settled) return;
			settled = true;
			clear();
			reject(typeof reason === "string" ? new Error(reason) : reason);
		};
		const ready = (frame: BootstrapReadyFrame): void => {
			if (settled) return;
			settled = true;
			clear();
			resolve(frame);
		};
		if (signal?.aborted === true) {
			fail(REMOTE_BOOTSTRAP_ABORTED);
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			// Both backlogged stdout and an already-settled exit replay in microtasks. Register stdout first
			// so the entry's final error frame cannot be lost when the exit callback tears down listeners.
			offLine = session.onStdoutLine((line) => {
				const frame = decodeBootstrapResult(line, expected.target);
				if (frame?.op === "error") {
					fail(REMOTE_BOOTSTRAP_ENTRY_ERROR_CODES.some((code) => code === frame.code) ? frame.code : "BOOTSTRAP_READY_INVALID");
					return;
				}
				if (frame?.op !== "ready" || frame.bundleSha256 !== expected.bundleSha256 || frame.nonce !== expected.nonce) {
					fail("BOOTSTRAP_READY_INVALID");
					return;
				}
				ready(frame);
			});
			offStderr = session.onStderrLine(() => {
				stderrSeen = true;
				// Keep only a presence bit; further remote output stays subject to the launcher's backlog cap.
				offStderr?.();
				offStderr = undefined;
			});
			offExit = session.onExit((exit) => fail(new BootstrapReadyUnconfirmedError(exit.kind, exit.code, stderrSeen)));
			if (settled) clear();
		} catch {
			fail("BOOTSTRAP_READY_UNCONFIRMED");
		}
	});
}

export type PreparedBootstrapInput = {
	hostId: string;
	generation: number;
	nonce: string;
	expectedBundleSha256: string;
	/** 缺省 `helper`；扩展快照部署显式传 `extensions`。 */
	target?: RemoteBootstrapTarget;
	sshConnection: PinnedSshInvocation;
	scpConnection: PinnedSshInvocation;
	launcher: SshProcessLauncher;
	/**
	 * 部署另一半（写临时目录 + 上传 + finalize）。helper/runner 与扩展快照只在这里不同；
	 * 会话/握手/校验/清理必须在下面一个地方完成，否则两条部署路会各自漂移。
	 * 缺省 = helper 部署（历史调用点/测试的行为逐字不变）。
	 */
	deploy?(session: BootstrapSession, ready: BootstrapReadyFrame): Promise<PreparedBundleResult>;
	/**
	 * Cancels this attempt. Aborting settles ready/finalize waits immediately and ends the entry process in
	 * the finally below, so a caller never has to wait out the 30 s ready / 300 s session budgets.
	 */
	signal?: AbortSignal;
};

function hasPinnedAlias(args: readonly string[], alias: string): boolean {
	let matches = 0;
	for (let index = 0; index < args.length - 1; index += 1) {
		if (args[index] !== "-o" || typeof args[index + 1] !== "string" || !args[index + 1].startsWith("HostKeyAlias=")) continue;
		if (args[index + 1] !== `HostKeyAlias=${alias}`) return false;
		matches += 1;
	}
	return matches === 1;
}

/** Own one verified entry process from ready through upload, finalize and shutdown. */
export async function runPreparedBootstrap(input: PreparedBootstrapInput): Promise<PreparedBundleResult> {
	throwIfAborted(input?.signal);
	if (!HOST_ID.test(input?.hostId) || !Number.isSafeInteger(input.generation) || input.generation < 0 || !NONCE.test(input.nonce) || !SHA256.test(input.expectedBundleSha256) || typeof input.launcher?.start !== "function") throw new Error("BOOTSTRAP_INPUT_INVALID");
	const target = input.target ?? "helper";
	// 只有 helper target 有一个仓库内的权威 bundle 身份；扩展快照的 sha 由调用方按实际文件算出。
	if (target === "helper" && input.expectedBundleSha256 !== frozenHelperBundleManifest().bundleSha256) throw new Error("BOOTSTRAP_INPUT_INVALID");
	const deploy = input.deploy ?? ((deploySession, deployReady) => deployFrozenHelperBundle({ connection: input.scpConnection, ready: deployReady, launcher: input.launcher, session: deploySession, hostId: input.hostId, generation: input.generation }));
	const alias = `pideck-${input.hostId}`;
	if (
		input.sshConnection?.destination !== input.scpConnection?.destination ||
		input.sshConnection?.openSshVersion !== input.scpConnection?.openSshVersion ||
		!Array.isArray(input.sshConnection?.args) ||
		!Array.isArray(input.scpConnection?.args) ||
		!hasPinnedAlias(input.sshConnection.args, alias) ||
		!hasPinnedAlias(input.scpConnection.args, alias)
	)
		throw new Error("BOOTSTRAP_INPUT_INVALID");
	const session = await input.launcher.start({ hostId: input.hostId, generation: input.generation, invocation: input.sshConnection, stdin: true, timeoutMs: SESSION_TIMEOUT_MS, maxOutputBytes: 64 * 1024, maxLineBytes: 4096 });
	let confirmed = false;
	try {
		// A cancel that landed while the entry was spawning must not wait for its first frame.
		throwIfAborted(input.signal);
		const ready = await awaitBootstrapReady(session, { bundleSha256: input.expectedBundleSha256, nonce: input.nonce, target }, input.signal);
		// Re-check before the deployment half starts: a cancel after ready must not start an upload.
		throwIfAborted(input.signal);
		const result = await deploy(session, ready);
		confirmed = true;
		return result;
	} finally {
		await session.stop(confirmed ? "shutdown" : "abort");
	}
}

function stableCodeOf(error: unknown, fallback: string): string {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : fallback;
}

/**
 * Resolve the remote node the host's own user can run, the way that user's login shell would find it.
 *
 * Why not `command -v node`: non-interactive SSH does not load shell init, and nvm — the usual reason a
 * host has a usable node at all — is initialized there. On the real `serve` host that made the probe
 * report `/usr/bin/node` v12.22.9 while the same user's login shell had v24.11.0, and anything below
 * 14.18 dies at the frozen entry's first statement (`require("node:fs")`, outside its try) with stderr,
 * exit 1 and no protocol frame.
 *
 * Reads PATH rather than delegating the choice to the shell, so the decision stays here: candidates are
 * probed in PATH order and the first one that satisfies the contract's version gate wins. `sentinel` is
 * supplied by the caller (a local random value) so the answer can be told apart from shell init output.
 *
 * 每种 shell 方言（`buildLoginShellPathCommands`：bash → zsh → sh）都是一份独立的 PATH 答案，因此
 * 按序探测：nvm 装在 `~/.bashrc` 的主机只有交互 bash 看得到，Homebrew 装在 `~/.zprofile` 的 macOS
 * 只有 zsh 看得到；一个方言读不到或读到的候选全不合格时，下一个方言仍可能给出合格 node。全部方言
 * 耗尽才报错，且错误码取**第一个**方言的失败类别，避免多条命令的失败互相掩珉。
 */
export async function resolveRemoteNodeExecutable(input: { userDataDir: string; hostId: string; client: SshClientRuntime; sentinel: string; signal?: AbortSignal }): Promise<{ nodePath: string; version: string; probed: number }> {
	let probed = 0;
	let lastVersion = "";
	let firstCandidate: string | undefined;
	let sawCandidates = false;
	// 每个方言的失败码，按方言顺序；探测结束时有候选就报版本门，没候选就报首个方言的失败码。
	const failureCodes: string[] = [];
	for (const remoteCommand of buildLoginShellPathCommands(input.sentinel)) {
		throwIfAborted(input.signal);
		const pathInvocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand });
		throwIfAborted(input.signal);
		let pathResult: SshCommandResult;
		try {
			pathResult = await input.client.run(pathInvocation.executable, pathInvocation.args, { signal: input.signal });
		} catch (error) {
			throwIfAborted(input.signal);
			failureCodes.push("REMOTE_NODE_SHELL_PROBE_FAILED");
			continue;
		}
		throwIfAborted(input.signal);
		if (pathResult.exitCode !== 0) {
			failureCodes.push("REMOTE_NODE_SHELL_PROBE_FAILED");
			continue;
		}
		let candidates: string[];
		try {
			// Throws REMOTE_NODE_SHELL_PATH_UNREADABLE / _EMPTY when the sentinel or the value is missing or
			// duplicated. It must not fall back to the non-interactive PATH: that fallback is exactly how an
			// unusable node got admitted.
			candidates = listNodeCandidatesFromPath(parseLoginShellPath(pathResult.stdout, input.sentinel));
		} catch (error) {
			// 保留解析层给的具体码（空 PATH ≠ 哨兵缺失），首个方言的失败类别就是对外结论。
			failureCodes.push(stableCodeOf(error, "REMOTE_NODE_SHELL_PATH_UNREADABLE"));
			continue;
		}
		if (candidates.length === 0) continue;
		sawCandidates = true;
		firstCandidate ??= candidates[0];
		// 预算按方言各算：每种壳是一份**不同的** PATH 答案，一个方言里那些根本不存在、全 127 的
		// 候选不能吃掉下一个方言的名额（macOS 真实形态：bash 侧无 node，zsh 侧才有 brew 的 node）。
		// 最坏情况 3 方言 × 3 候选 = 9 次版本探测，仍与 PATH 长度无关。
		for (const candidate of candidates.slice(0, MAX_NODE_CANDIDATES)) {
			// Every candidate is another round trip, so a cancel has to be honoured between probes and never
			// spent on the remaining PATH candidates.
			throwIfAborted(input.signal);
			const versionCommand = buildRemoteNodeVersionCommand(candidate);
			const invocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand: versionCommand });
			throwIfAborted(input.signal);
			let result: SshCommandResult;
			probed += 1;
			try {
				result = await input.client.run(invocation.executable, invocation.args, { signal: input.signal });
			} catch {
				throwIfAborted(input.signal);
				continue; // A candidate that cannot even be executed is not the answer; try the next one.
			}
			throwIfAborted(input.signal);
			if (result.exitCode !== 0) continue;
			try {
				assertSupportedRemoteNodeVersion(result.stdout);
			} catch {
				lastVersion = typeof result.stdout === "string" ? result.stdout.trim().slice(0, 32) : "";
				continue;
			}
			return { nodePath: candidate, version: String(result.stdout).trim(), probed };
		}
	}
	// 有候选但全不合格：这才是「版本太旧」。诊断码必须是裸常量（`diagnosticCodeFromError` 只承认
	// 「消息即码」），路径与版本拼进消息会把这个最常被用户撞到的失败退化成笼统的 SSH_CONNECTION_FAILED。
	if (sawCandidates) {
		const unsupported = new Error("REMOTE_NODE_VERSION_UNSUPPORTED") as Error & { nodePath?: string; observedVersion?: string };
		unsupported.nodePath = firstCandidate;
		unsupported.observedVersion = lastVersion || "unprobed";
		throw unsupported;
	}
	// 一份可信 PATH 都没拿到：报告第一个方言的失败类别；两个方言都读到了 PATH 却没候选则是「没装 node」。
	throw new Error(failureCodes[0] ?? "REMOTE_NODE_NOT_FOUND");
}

/**
 * Fold a thrown value into a bare stable code for logging: messages that are not already codes could carry a
 * path or command line, and the log must stay on the "stable codes only" discipline shared by this domain.
 */
function maintenanceCodeOf(error: unknown): string {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : "REMOTE_MAINTENANCE_SWEEP_FAILED";
}

/**
 * Run the host-side retention sweep after a **confirmed** activation（plan §4.2 / security review F2）。
 *
 * 非致命是构造性的：部署已经激活并验证过，清理跑不了不能把一次成功部署判成失败。日志只带 hostId 与稳定码
 * （不含远端路径/命令），失败也只记 warn；sweep 内部自己的输出已折叠成稳定码。
 */
async function sweepDeployedBundles(input: { userDataDir: string; hostId: string; client: SshClientRuntime; nodePath: string; deployRoot: string; activeBundleSha256: string }): Promise<void> {
	let outcome: RemoteBundleMaintenanceOutcome;
	try {
		outcome = await maintainDeployedBundles(input);
	} catch (error) {
		getAppLogger()?.warn("remote", "REMOTE_MAINTENANCE_SWEEP_FAILED", { hostId: input.hostId, code: maintenanceCodeOf(error) });
		return;
	}
	getAppLogger()?.debug("remote", "REMOTE_MAINTENANCE_SWEEP", { hostId: input.hostId, removedBundles: outcome.removedBundles, removedStaging: outcome.removedStaging, removedStaleLock: outcome.removedStaleLock, skipped: outcome.skipped });
}

/**
 * Re-preflight both commands against the persisted pin, then run the frozen one-file bootstrap.
 *
 * `nodeVersion` is the version discovery already asserted for this exact `nodePath`. Passing it skips a
 * second `node --version` round trip for a value that cannot have changed in between; without it (the
 * explicit `nodePath` override path) the probe still runs. Either way the same version gate applies.
 */
export async function bootstrapPinnedHost(input: { userDataDir: string; hostId: string; generation: number; nonce: string; nodePath: string; nodeVersion?: string; client: SshClientRuntime; launcher: SshProcessLauncher; signal?: AbortSignal }): Promise<PreparedBundleResult> {
	throwIfAborted(input.signal);
	const manifest = frozenHelperBundleManifest();
	if (input.nodeVersion !== undefined) {
		assertSupportedRemoteNodeVersion(input.nodeVersion);
	} else {
		const versionCommand = buildRemoteNodeVersionCommand(input.nodePath);
		const versionInvocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand: versionCommand });
		throwIfAborted(input.signal);
		let nodeVersion: SshCommandResult;
		try {
			nodeVersion = await input.client.run(versionInvocation.executable, versionInvocation.args, { signal: input.signal });
		} catch (error) {
			throwIfAborted(input.signal);
			throw new Error("REMOTE_NODE_PROBE_FAILED");
		}
		throwIfAborted(input.signal);
		if (nodeVersion.exitCode !== 0) throw new Error("REMOTE_NODE_PROBE_FAILED");
		assertSupportedRemoteNodeVersion(nodeVersion.stdout);
	}
	const sshConnection = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, bootstrap: { nodeExecutable: input.nodePath, protocolVersion: REMOTE_BOOTSTRAP_PROTOCOL_VERSION, bundleSha256: manifest.bundleSha256, nonce: input.nonce, target: "helper" } });
	const scpConnection = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "scp", { client: input.client });
	throwIfAborted(input.signal);
	const deployed = await runPreparedBootstrap({
		hostId: input.hostId,
		generation: input.generation,
		nonce: input.nonce,
		expectedBundleSha256: manifest.bundleSha256,
		target: "helper",
		sshConnection,
		scpConnection,
		launcher: input.launcher,
		...(input.signal === undefined ? {} : { signal: input.signal }),
		deploy: (session, ready) => deployFrozenHelperBundle({ connection: scpConnection, ready, launcher: input.launcher, session, hostId: input.hostId, generation: input.generation, ...(input.signal === undefined ? {} : { signal: input.signal }) }),
	});
	// 只在**已确认激活**之后清理（plan §4.2「清理与激活判据」；F2）。sweep 失败不影响本次部署的结果。
	// 取消发生在激活之后时部署已成立：清理只是回收，不再为一个已取消的 attempt 多跑一轮远端命令。
	// 复用（`reused`）意味着本次没有激活任何东西：可回收的快照都由某次激活产生，而那次激活已经扫过；
	// 再连一次 SSH 只为一个空清理，会把普通连接白白拖慢一个握手。
	if (deployed.reused !== true && input.signal?.aborted !== true) await sweepDeployedBundles({ userDataDir: input.userDataDir, hostId: input.hostId, client: input.client, nodePath: input.nodePath, deployRoot: deployed.deployRoot, activeBundleSha256: deployed.bundleSha256 });
	return deployed;
}
