import { createHash } from "node:crypto";

export type SshResolvedRoute = {
	hostName: string;
	user: string;
	port: number;
	proxyJump?: string;
	proxyCommand?: string;
	hostKeyAlias?: string;
	canonicalizeHostname?: string;
};

const ROUTE_KEYS = new Set(["hostname", "user", "port", "proxyjump", "proxycommand", "hostkeyalias", "canonicalizehostname"]);

function invalidRoute(): never {
	throw new Error("INVALID_SSH_ROUTE");
}

/** Parse effective endpoint fields from a successful `ssh -G` result; this does not authenticate a host. */
export function parseSshResolvedRoute(result: { exitCode: number; stdout: string }): SshResolvedRoute {
	if (!result || result.exitCode !== 0 || typeof result.stdout !== "string" || !result.stdout || result.stdout.length > 256 * 1024) invalidRoute();
	const fields = new Map<string, string>();
	const lines = result.stdout.split("\n");
	for (const [index, rawLine] of lines.entries()) {
		if (index === lines.length - 1 && rawLine === "") continue;
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		const match = /^([a-z][a-z0-9]*)(?:[ \t]+(.*))?$/.exec(line);
		if (!match || /[\x00-\x08\x0b-\x1f\x7f]/.test(line)) invalidRoute();
		const key = match[1];
		if (!ROUTE_KEYS.has(key)) continue;
		if (fields.has(key)) invalidRoute();
		fields.set(key, match[2] ?? "");
	}

	const hostName = fields.get("hostname");
	const user = fields.get("user");
	const portText = fields.get("port");
	if (!hostName || /\s/.test(hostName) || !user || /\s/.test(user) || !portText || !/^\d+$/.test(portText)) invalidRoute();
	const port = Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65535) invalidRoute();
	const proxyJump = fields.get("proxyjump");
	const proxyCommand = fields.get("proxycommand");
	const hostKeyAlias = fields.get("hostkeyalias");
	const canonicalizeHostname = fields.get("canonicalizehostname");
	return {
		hostName,
		user,
		port,
		...(proxyJump !== undefined ? { proxyJump } : {}),
		...(proxyCommand !== undefined ? { proxyCommand } : {}),
		...(hostKeyAlias !== undefined ? { hostKeyAlias } : {}),
		...(canonicalizeHostname !== undefined ? { canonicalizeHostname } : {}),
	};
}

/** Hash only the resolved endpoint route, not identity files or other rotating credentials. */
export function sshRouteDigest(route: SshResolvedRoute): string {
	const identity = ["pideck-ssh-route-v1", route.hostName, route.user, route.port, route.proxyJump ?? null, route.proxyCommand ?? null, route.hostKeyAlias ?? null, route.canonicalizeHostname ?? null];
	return createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
}
