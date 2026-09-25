import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSshConfigQueryArgs, type SshDraftRoute } from "./SshCommandBuilder";
import { parseSshResolvedRoute, sshRouteDigest } from "./SshRouteDigest";

export type SshCommandResult = { exitCode: number; stdout: string };
export type SshCommandRunner = (executable: string, args: string[]) => Promise<SshCommandResult>;

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

async function runSsh(executable: string, args: string[]): Promise<SshCommandResult> {
	return new Promise((resolve, reject) => {
		execFile(executable, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true, shell: false }, (error, stdout) => {
			if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new Error("SSH_HOST_COMMAND_OUTPUT_TOO_LARGE"));
			if (error?.code === "ETIMEDOUT" || error?.killed) return reject(new Error("SSH_HOST_COMMAND_TIMEOUT"));
			if (error?.code === "ENOENT" || error?.code === "EACCES") return reject(new Error("SSH_CLIENT_UNAVAILABLE"));
			resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout });
		});
	});
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

function assertNoForwardedEnvironment(stdout: string): void {
	if (stdout.split(/\r?\n/).some((line) => /^(?:sendenv|setenv)(?:[ \t]|$)/.test(line))) throw new Error("SSH_HOST_ENV_UNVERIFIED");
}

function draftProbeArgs(routeArgs: string[], pinAlias: string, knownHostsFile: string): string[] {
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
		"StrictHostKeyChecking=accept-new",
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

/** Return an in-memory candidate after SSH authentication; profile activation needs separate user confirmation. */
export async function verifyDraftSshHost(route: SshDraftRoute, pinAlias: string, options: { run?: SshCommandRunner } = {}): Promise<SshDraftHostCandidate> {
	if (typeof pinAlias !== "string" || !/^pideck-[a-z0-9-]{1,120}$/.test(pinAlias)) throw new Error("INVALID_SSH_PIN_ALIAS");
	const routeArgs = buildSshConfigQueryArgs(route);
	const queryArgs = ["-G", "-o", `HostKeyAlias=${pinAlias}`, "-o", "SendEnv=-*", "-o", "ForwardX11=no", ...routeArgs.slice(1)];
	const run = options.run ?? runSsh;
	const query = await run("ssh", queryArgs);
	const resolvedRoute = parseSshResolvedRoute(query);
	assertNoForwardedEnvironment(query.stdout);
	if (resolvedRoute.hostKeyAlias !== pinAlias) throw new Error("SSH_HOST_ROUTE_CHANGED");
	const routeDigest = sshRouteDigest(resolvedRoute);
	const directory = await mkdtemp(join(tmpdir(), "pideck-ssh-kh-"));
	try {
		const knownHostsFile = join(directory, "known_hosts");
		const auth = await run("ssh", draftProbeArgs(routeArgs, pinAlias, knownHostsFile));
		if (auth.exitCode !== 0 || auth.stdout !== "") throw new Error("SSH_HOST_AUTHENTICATION_FAILED");
		const knownHostsBytes = await readBoundedHostKey(knownHostsFile);
		const fingerprint = fingerprintSshHostKey(knownHostsBytes, pinAlias);
		const afterQuery = await run("ssh", queryArgs);
		const afterAuth = parseSshResolvedRoute(afterQuery);
		assertNoForwardedEnvironment(afterQuery.stdout);
		if (afterAuth.hostKeyAlias !== pinAlias || sshRouteDigest(afterAuth) !== routeDigest) throw new Error("SSH_HOST_ROUTE_CHANGED");
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
