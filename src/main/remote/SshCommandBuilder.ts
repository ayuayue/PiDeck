import { isIP } from "node:net";
import { isAbsolute } from "node:path";

/** Fields allowed to influence the candidate SSH config route before host verification. */
export type SshDraftRoute = {
	sshHost: string;
	user?: string;
	port?: number;
	proxyJump?: string;
};

const SSH_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const SSH_JUMP = /^(?:([A-Za-z0-9_][A-Za-z0-9_.-]*)@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_][A-Za-z0-9_.-]*)(?::([0-9]{1,5}))?$/;

function validPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validHost(host: string): boolean {
	return host.length <= 253 && (SSH_NAME.test(host) || isIP(host) === 6);
}

function validJump(value: string): boolean {
	if (!value || value.length > 1024) return false;
	const hops = value.split(",");
	if (hops.length > 8) return false;
	return hops.every((hop) => {
		const match = SSH_JUMP.exec(hop);
		if (!match || match[2].toLowerCase() === "none") return false;
		const jumpHost = match[2];
		if (jumpHost.startsWith("[") ? isIP(jumpHost.slice(1, -1)) !== 6 : !validHost(jumpHost)) return false;
		return match[3] === undefined || validPort(Number(match[3]));
	});
}

/** Build argv only for `ssh -G` alias inspection, never for an authenticated connection. */
export function buildSshConfigQueryArgs(route: SshDraftRoute): string[] {
	if (!route || typeof route.sshHost !== "string" || !validHost(route.sshHost)) throw new Error("INVALID_SSH_HOST");
	if (route.user !== undefined && (typeof route.user !== "string" || !SSH_NAME.test(route.user))) throw new Error("INVALID_SSH_USER");
	if (route.port !== undefined && !validPort(route.port)) throw new Error("INVALID_SSH_PORT");
	if (route.proxyJump !== undefined && (typeof route.proxyJump !== "string" || !validJump(route.proxyJump))) throw new Error("INVALID_SSH_PROXY_JUMP");

	const args = ["-G", "-o", "BatchMode=yes", "-o", "PermitLocalCommand=no", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes"];
	if (route.user !== undefined) args.push("-l", route.user);
	if (route.port !== undefined) args.push("-p", String(route.port));
	if (route.proxyJump !== undefined) args.push("-J", route.proxyJump);
	args.push(route.sshHost);
	return args;
}

export type VerifiedSshArgvInput = {
	hostId: string;
	sshHost: string;
	hostName: string;
	user: string;
	port: number;
	pinAlias: string;
	pinFile: string;
	proxyJump?: string;
	identityFile?: string;
	connectTimeoutMs: number;
};

export type VerifiedSshCommandKind = "ssh-batch" | "ssh-terminal" | "scp";

function validLocalPath(path: unknown): path is string {
	return typeof path === "string" && path.length <= 4096 && isAbsolute(path) && !/[\x00-\x1f\x7f%]/.test(path);
}

/** Pure argv builder; callers must first revalidate persisted route and pin for this use. */
export function buildVerifiedSshArgv(target: VerifiedSshArgvInput, kind: VerifiedSshCommandKind): string[] {
	if (!target || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target.hostId) || target.pinAlias !== `pideck-${target.hostId}`) throw new Error("INVALID_SSH_VERIFIED_TARGET");
	buildSshConfigQueryArgs({ sshHost: target.sshHost, ...(target.proxyJump !== undefined ? { proxyJump: target.proxyJump } : {}) });
	if (typeof target.hostName !== "string" || !validHost(target.hostName) || typeof target.user !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(target.user) || !validPort(target.port)) throw new Error("INVALID_SSH_VERIFIED_TARGET");
	if (!validLocalPath(target.pinFile) || (target.identityFile !== undefined && !validLocalPath(target.identityFile))) throw new Error("INVALID_SSH_LOCAL_PATH");
	if (!Number.isSafeInteger(target.connectTimeoutMs) || target.connectTimeoutMs < 1000 || target.connectTimeoutMs > 120_000) throw new Error("INVALID_SSH_CONNECT_TIMEOUT");
	if (kind !== "ssh-batch" && kind !== "ssh-terminal" && kind !== "scp") throw new Error("INVALID_SSH_COMMAND_KIND");
	const globalHostsFile = process.platform === "win32" ? "NUL" : "/dev/null";
	const args = [
		...(kind === "ssh-batch" ? ["-T"] : kind === "ssh-terminal" ? ["-tt"] : []),
		"-o",
		`HostName=${target.hostName}`,
		"-o",
		`User=${target.user}`,
		"-o",
		`Port=${target.port}`,
		"-o",
		`UserKnownHostsFile=${target.pinFile}`,
		"-o",
		`GlobalKnownHostsFile=${globalHostsFile}`,
		"-o",
		`HostKeyAlias=${target.pinAlias}`,
		"-o",
		"StrictHostKeyChecking=yes",
		"-o",
		"HostKeyAlgorithms=ssh-ed25519",
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
		"ControlMaster=no",
		"-o",
		"ControlPath=none",
		"-o",
		"ForwardAgent=no",
		"-o",
		"ForwardX11=no",
		"-o",
		"ClearAllForwardings=yes",
		"-o",
		"PermitLocalCommand=no",
		"-o",
		"RemoteCommand=none",
		"-o",
		"BatchMode=yes",
		"-o",
		"NumberOfPasswordPrompts=0",
		"-o",
		"SendEnv=-*",
		"-o",
		`ConnectTimeout=${Math.ceil(target.connectTimeoutMs / 1000)}`,
		"-o",
		"ConnectionAttempts=1",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
	];
	if (target.proxyJump !== undefined) args.push("-J", target.proxyJump);
	if (target.identityFile !== undefined) args.push("-i", target.identityFile, "-o", "IdentitiesOnly=yes");
	if (kind !== "scp") args.push("--", target.sshHost);
	return args;
}
