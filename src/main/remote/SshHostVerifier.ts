import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSshConfigQueryArgs, type SshDraftRoute } from "./SshCommandBuilder";
import { runSshClientSelfCheck, type SshClientRuntime, type SshCommandResult, type SshCommandRunner } from "./SshClientRuntime";
import { parseSshResolvedRoute, sshRouteDigest, type SshResolvedRoute } from "./SshRouteDigest";

export type { SshClientRuntime, SshCommandResult, SshCommandRunner };

export type SshDraftHostCandidate = {
	hostName: string;
	user: string;
	port: number;
	pinAlias: string;
	routeDigest: string;
	knownHostsBase64: string;
	knownHostsSha256: string;
	hostKeyFingerprints: string[];
};

const MAX_PIN_BYTES = 16 * 1024;

function invalidKey(): never {
	throw new Error("SSH_HOST_KEY_INVALID");
}

export async function readBoundedHostKey(filePath: string): Promise<Buffer> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const pathStats = await lstat(filePath);
		if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.size > MAX_PIN_BYTES) invalidKey();
		handle = await open(filePath, process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
		const stats = await handle.stat();
		if (!stats.isFile() || stats.size > MAX_PIN_BYTES) invalidKey();
		const buffer = Buffer.alloc(MAX_PIN_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length === 0 || length > MAX_PIN_BYTES) invalidKey();
		return Buffer.from(buffer.subarray(0, length));
	} catch {
		throw new Error("SSH_HOST_KEY_INVALID");
	} finally {
		try {
			await handle?.close();
		} catch {
			throw new Error("SSH_HOST_KEY_INVALID");
		}
	}
}

export function fingerprintSshHostKey(bytes: Buffer, pinAlias: string): string {
	if (bytes.length === 0 || bytes.length > MAX_PIN_BYTES) invalidKey();
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes) || !text.endsWith("\n")) invalidKey();
	const line = text.endsWith("\r\n") ? text.slice(0, -2) : text.slice(0, -1);
	const match = /^([^\s]+) ([^\s]+) ([A-Za-z0-9+/]+={0,2})$/.exec(line);
	if (!match || match[1] !== pinAlias || match[2] !== "ssh-ed25519") invalidKey();
	const key = Buffer.from(match[3], "base64");
	if (key.length < 8 || key.toString("base64").replace(/=+$/, "") !== match[3].replace(/=+$/, "")) invalidKey();
	const nameLength = key.readUInt32BE(0);
	if (nameLength === 0 || nameLength > 128 || key.length <= nameLength + 4 || key.subarray(4, nameLength + 4).toString("utf8") !== match[2]) invalidKey();
	if (key.length !== nameLength + 4 + 4 + 32 || key.readUInt32BE(nameLength + 4) !== 32) invalidKey();
	return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function assertNoForwardedEnvironment(stdout: string): void {
	if (stdout.split(/\r?\n/).some((line) => /^(?:sendenv|setenv)(?:[ \t]|$)/.test(line))) throw new Error("SSH_HOST_ENV_UNVERIFIED");
}

/**
 * 把 OpenSSH 探针的 stderr 归纳成稳定失败码（不把 stderr 原文跨 IPC 传）。
 *
 * “添加连接”失败时用户只能看到 SSH_HOST_AUTHENTICATION_FAILED，分不清是钥被拒、
 * 私钥路径错了、钥有口令，还是根本连不到主机；这几类的修复动作完全不同。
 * 分类依据是 OpenSSH 的固定输出句式（不同语言环境下 stderr 仍为英文）。
 */
export function classifySshProbeFailure(stderr: string | undefined, exitCode: number): string {
	const text = typeof stderr === "string" ? stderr.toLowerCase() : "";
	// 口令相关的必须先于 permission denied 判断：有口令的钥在 BatchMode 下报的也是 Permission denied。
	if (/(enter passphrase|incorrect passphrase|bad passphrase|passphrase required|loaded 0 keys)/.test(text)) return "SSH_AUTH_PASSPHRASE_REQUIRED";
	if (/(load key|no such identity|identity file .*not accessible|no such file or directory|invalid format|bad permissions|permissions .* are too open|permission denied \(.*\.ssh)/.test(text)) return "SSH_AUTH_KEY_UNREADABLE";
	if (/(connection timed out|connection refused|no route to host|network is unreachable|could not resolve hostname|could not resolve host|operation timed out)/.test(text)) return "SSH_HOST_UNREACHABLE";
	if (/permission denied|no more authentication methods|publickey,password|authentication failed|too many authentication failures/.test(text)) return "SSH_AUTH_KEY_REJECTED";
	if (exitCode === 255 && text.trim().length === 0) return "SSH_HOST_UNREACHABLE";
	return "SSH_HOST_AUTHENTICATION_FAILED";
}

function draftProbeArgs(routeArgs: string[], pinAlias: string, knownHostsFile: string, preverified: boolean): string[] {
	if (/[\x00-\x1f\x7f]/.test(knownHostsFile)) throw new Error("SSH_HOST_TEMP_PATH_INVALID");
	const globalHostsFile = process.platform === "win32" ? "NUL" : "/dev/null";
	return [
		"-T",
		"-o",
		`UserKnownHostsFile=${knownHostsFile}`,
		"-o",
		`GlobalKnownHostsFile=${globalHostsFile}`,
		"-o",
		`HostKeyAlias=${pinAlias}`,
		"-o",
		preverified ? "StrictHostKeyChecking=yes" : "StrictHostKeyChecking=accept-new",
		"-o",
		"KnownHostsCommand=none",
		"-o",
		"VerifyHostKeyDNS=no",
		"-o",
		"UpdateHostKeys=no",
		"-o",
		"HashKnownHosts=no",
		"-o",
		"CheckHostIP=no",
		"-o",
		"BatchMode=yes",
		"-o",
		"SendEnv=-*",
		"-o",
		"ForwardX11=no",
		"-o",
		"NumberOfPasswordPrompts=0",
		"-o",
		"ConnectTimeout=15",
		"-o",
		"ConnectionAttempts=1",
		"-o",
		"ForwardAgent=no",
		"-o",
		"ClearAllForwardings=yes",
		"-o",
		"PermitLocalCommand=no",
		"-o",
		"ControlMaster=no",
		"-o",
		"ControlPath=none",
		...routeArgs.slice(1, -1),
		"--",
		routeArgs[routeArgs.length - 1],
		"true",
	];
}

/** Resolve the candidate route through the caller's client; a missing context fails closed. */
export async function querySshDraftRoute(route: SshDraftRoute, pinAlias: string, options: { client: SshClientRuntime }): Promise<SshResolvedRoute> {
	if (typeof pinAlias !== "string" || !/^pideck-[a-z0-9-]{1,120}$/.test(pinAlias)) throw new Error("INVALID_SSH_PIN_ALIAS");
	const client = requireClient(options);
	const routeArgs = buildSshConfigQueryArgs(route);
	const queryArgs = ["-G", "-o", `HostKeyAlias=${pinAlias}`, "-o", "SendEnv=-*", "-o", "ForwardX11=no", ...routeArgs.slice(1)];
	const query = await client.run(client.sshPath, queryArgs);
	const resolved = parseSshResolvedRoute(query);
	assertNoForwardedEnvironment(query.stdout);
	if (resolved.hostKeyAlias !== pinAlias) throw new Error("SSH_HOST_ROUTE_CHANGED");
	return resolved;
}

function requireClient(options: { client: SshClientRuntime }): SshClientRuntime {
	if (typeof options?.client?.run !== "function" || typeof options.client.sshPath !== "string") throw new Error("SSH_CLIENT_CONTEXT_REQUIRED");
	return options.client;
}

export type PreverifiedSshHostKey = { knownHostsBytes: Buffer; fingerprint: string };

/** Return an in-memory candidate after SSH authentication; profile activation needs separate user confirmation. */
export async function verifyDraftSshHost(route: SshDraftRoute, pinAlias: string, options: { client: SshClientRuntime; preverifiedHostKey?: PreverifiedSshHostKey; allowUnauthenticatedHostKey?: boolean }): Promise<SshDraftHostCandidate> {
	const preverified = options?.preverifiedHostKey;
	const trustedBytes = preverified === undefined ? undefined : Buffer.isBuffer(preverified.knownHostsBytes) ? Buffer.from(preverified.knownHostsBytes) : undefined;
	if (preverified !== undefined && (trustedBytes === undefined || fingerprintSshHostKey(trustedBytes, pinAlias) !== preverified.fingerprint)) throw new Error("SSH_HOST_KEY_MISMATCH");
	const client = requireClient(options);
	await runSshClientSelfCheck(client);
	const resolvedRoute = await querySshDraftRoute(route, pinAlias, { client });
	const routeArgs = buildSshConfigQueryArgs(route);
	const routeDigest = sshRouteDigest(resolvedRoute);
	const directory = await mkdtemp(join(tmpdir(), "pideck-ssh-kh-"));
	try {
		const knownHostsFile = join(directory, "known_hosts");
		if (trustedBytes !== undefined) await writeFile(knownHostsFile, trustedBytes, { flag: "wx", mode: 0o600 });
		const auth = await client.run(client.sshPath, draftProbeArgs(routeArgs, pinAlias, knownHostsFile, trustedBytes !== undefined));
		// A password host cannot authenticate before its key is pinned, and OpenSSH writes the host key during
		// key exchange - before authentication starts. So a failed auth still leaves the exact bytes to pin;
		// anything on stdout is still refused (it means the probe was not a quiet handshake).
		if (auth.stdout !== "") throw new Error("SSH_HOST_AUTHENTICATION_FAILED");
		if (auth.exitCode !== 0 && options.allowUnauthenticatedHostKey !== true) throw new Error(classifySshProbeFailure(auth.stderr, auth.exitCode));
		const knownHostsBytes = await readBoundedHostKey(knownHostsFile);
		if (trustedBytes !== undefined && !knownHostsBytes.equals(trustedBytes)) throw new Error("SSH_HOST_KEY_MISMATCH");
		const fingerprint = fingerprintSshHostKey(knownHostsBytes, pinAlias);
		const afterAuth = await querySshDraftRoute(route, pinAlias, { client });
		if (sshRouteDigest(afterAuth) !== routeDigest) throw new Error("SSH_HOST_ROUTE_CHANGED");
		return {
			hostName: resolvedRoute.hostName,
			user: resolvedRoute.user,
			port: resolvedRoute.port,
			pinAlias,
			routeDigest,
			knownHostsBase64: knownHostsBytes.toString("base64"),
			knownHostsSha256: createHash("sha256").update(knownHostsBytes).digest("hex"),
			hostKeyFingerprints: [fingerprint],
		};
	} finally {
		try {
			await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
		} catch {
			throw new Error("SSH_HOST_TEMP_CLEANUP_FAILED");
		}
	}
}
