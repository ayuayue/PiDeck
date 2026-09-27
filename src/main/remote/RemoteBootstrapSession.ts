import { buildPinnedSshInvocation, type PinnedSshInvocation } from "./SshVerifiedConnection";
import { frozenHelperBundleManifest, deployFrozenHelperBundle, type PreparedBundleResult } from "./RemoteBootstrapDeployment";
import { decodeBootstrapResult, type BootstrapReadyFrame } from "./RemoteBootstrapTransfer";
import { assertSupportedRemoteNodeVersion, buildRemoteNodeVersionCommand, REMOTE_BOOTSTRAP_ENTRY_ERROR_CODES } from "./RemoteBootstrapContract";
import { REMOTE_BOOTSTRAP_PROTOCOL_VERSION } from "./RemoteHelperContract";
import type { SshLauncherHandle, SshProcessExit, SshProcessLauncher } from "./RemoteHostConnectionTypes";
import type { SshClientRuntime, SshCommandResult } from "./SshClientRuntime";

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/;
const READY_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 300_000; // ready (30s) + upload (120s) + finalize (120s) + cleanup margin

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

/** Wait for the frozen entry to acknowledge the exact bundle and nonce before allowing upload. */
function awaitBootstrapReady(session: SshLauncherHandle, expected: { bundleSha256: string; nonce: string }): Promise<BootstrapReadyFrame> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stderrSeen = false;
		let offLine: (() => void) | undefined;
		let offStderr: (() => void) | undefined;
		let offExit: (() => void) | undefined;
		const timer = setTimeout(() => fail(new BootstrapReadyUnconfirmedError("deadline", null, stderrSeen)), READY_TIMEOUT_MS);
		const clear = (): void => {
			clearTimeout(timer);
			offLine?.();
			offStderr?.();
			offExit?.();
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
		try {
			// Both backlogged stdout and an already-settled exit replay in microtasks. Register stdout first
			// so the entry's final error frame cannot be lost when the exit callback tears down listeners.
			offLine = session.onStdoutLine((line) => {
				const frame = decodeBootstrapResult(line);
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
	sshConnection: PinnedSshInvocation;
	scpConnection: PinnedSshInvocation;
	launcher: SshProcessLauncher;
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
	if (!HOST_ID.test(input?.hostId) || !Number.isSafeInteger(input.generation) || input.generation < 0 || !NONCE.test(input.nonce) || !SHA256.test(input.expectedBundleSha256) || typeof input.launcher?.start !== "function") throw new Error("BOOTSTRAP_INPUT_INVALID");
	if (input.expectedBundleSha256 !== frozenHelperBundleManifest().bundleSha256) throw new Error("BOOTSTRAP_INPUT_INVALID");
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
		const ready = await awaitBootstrapReady(session, { bundleSha256: input.expectedBundleSha256, nonce: input.nonce });
		const result = await deployFrozenHelperBundle({ connection: input.scpConnection, ready, launcher: input.launcher, session, hostId: input.hostId, generation: input.generation });
		confirmed = true;
		return result;
	} finally {
		await session.stop(confirmed ? "shutdown" : "abort");
	}
}

/** Re-preflight both commands against the persisted pin, then run the frozen one-file bootstrap. */
export async function bootstrapPinnedHost(input: { userDataDir: string; hostId: string; generation: number; nonce: string; nodePath: string; client: SshClientRuntime; launcher: SshProcessLauncher }): Promise<PreparedBundleResult> {
	const manifest = frozenHelperBundleManifest();
	const versionCommand = buildRemoteNodeVersionCommand(input.nodePath);
	const versionInvocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand: versionCommand });
	let nodeVersion: SshCommandResult;
	try {
		nodeVersion = await input.client.run(versionInvocation.executable, versionInvocation.args);
	} catch {
		throw new Error("REMOTE_NODE_PROBE_FAILED");
	}
	if (nodeVersion.exitCode !== 0) throw new Error("REMOTE_NODE_PROBE_FAILED");
	assertSupportedRemoteNodeVersion(nodeVersion.stdout);
	const sshConnection = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, bootstrap: { nodeExecutable: input.nodePath, protocolVersion: REMOTE_BOOTSTRAP_PROTOCOL_VERSION, bundleSha256: manifest.bundleSha256, nonce: input.nonce } });
	const scpConnection = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "scp", { client: input.client });
	return runPreparedBootstrap({ hostId: input.hostId, generation: input.generation, nonce: input.nonce, expectedBundleSha256: manifest.bundleSha256, sshConnection, scpConnection, launcher: input.launcher });
}
