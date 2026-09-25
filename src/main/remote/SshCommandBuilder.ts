import { isIP } from "node:net";

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
