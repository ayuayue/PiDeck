import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { buildVerifiedSshArgv, type VerifiedSshArgvInput, type VerifiedSshCommandKind } from "./SshCommandBuilder";
import { runSshClientSelfCheck, type SshClientRuntime } from "./SshClientRuntime";
import { assertNoForwardedEnvironment, querySshDraftRoute } from "./SshHostVerifier";
import { SshHostPinStore } from "./SshHostPinStore";
import { RemoteHostStore, type RemoteHostStoreState } from "./RemoteHostStore";
import type { RemoteHostProfile } from "./RemoteHostStoreCodec";
import { parseSshResolvedRoute, sshRouteDigest } from "./SshRouteDigest";

export type PinnedSshInvocation = {
	/** Absolute path resolved by the runtime context; never a bare name that PATH could redirect. */
	readonly executable: string;
	readonly destination: string;
	readonly args: string[];
	/** Sanitized environment the launcher must use for this process. */
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly openSshVersion: string;
	/**
	 * Optional working directory for a transfer: scp reads "host:path" from a colon before the first
	 * separator, so a Windows drive path (C:\...) as a source operand would be sent to the wrong place.
	 * Running from the bundle directory lets scp receive bare file names instead.
	 */
	readonly cwd?: string;
};

function activeProfile(state: RemoteHostStoreState, hostId: string): RemoteHostProfile & { verifiedEndpoint: NonNullable<RemoteHostProfile["verifiedEndpoint"]> } {
	if (state.status !== "ready") throw new Error("SSH_HOST_NOT_READY");
	const profile = state.profiles.find((item) => item.id === hostId);
	if (!profile || profile.disabledAt || !profile.verifiedEndpoint) throw new Error("SSH_HOST_NOT_READY");
	return { ...profile, verifiedEndpoint: profile.verifiedEndpoint };
}

function assertSavedRoute(hostName: string, user: string, port: number, routeDigest: string, expected: RemoteHostProfile & { verifiedEndpoint: NonNullable<RemoteHostProfile["verifiedEndpoint"]> }): void {
	if (hostName !== expected.verifiedEndpoint.hostName || user !== expected.verifiedEndpoint.user || port !== expected.verifiedEndpoint.port || routeDigest !== expected.verifiedEndpoint.routeDigest) throw new Error("SSH_HOST_ROUTE_CHANGED");
}

function assertStrictConfig(stdout: string, target: VerifiedSshArgvInput): void {
	assertNoForwardedEnvironment(stdout);
	const values = new Map<string, string[]>();
	for (const rawLine of stdout.split(/\r?\n/)) {
		if (!rawLine) continue;
		const match = /^([a-z][a-z0-9]*)(?:[ \t]+(.*))?$/.exec(rawLine);
		if (!match) throw new Error("SSH_HOST_STRICT_CONFIG_INVALID");
		const entries = values.get(match[1]) ?? [];
		entries.push(match[2] ?? "");
		values.set(match[1], entries);
	}
	const one = (key: string): string => {
		const entries = values.get(key);
		if (!entries || entries.length !== 1) throw new Error("SSH_HOST_STRICT_CONFIG_INVALID");
		return entries[0];
	};
	const requireOne = (key: string, expected: string): void => {
		if (one(key) !== expected) throw new Error("SSH_HOST_STRICT_CONFIG_INVALID");
	};
	const requireBoolean = (key: string, enabled: boolean): void => {
		if (!(enabled ? ["yes", "true"] : ["no", "false"]).includes(one(key))) throw new Error("SSH_HOST_STRICT_CONFIG_INVALID");
	};
	const allowOnlyNone = (key: string): void => {
		const entries = values.get(key);
		if (entries && (entries.length !== 1 || entries[0] !== "none")) throw new Error("SSH_HOST_STRICT_CONFIG_INVALID");
	};
	requireOne("hostkeyalias", target.pinAlias);
	requireOne("userknownhostsfile", target.pinFile);
	requireOne("globalknownhostsfile", process.platform === "win32" ? "NUL" : "/dev/null");
	requireOne("hostkeyalgorithms", "ssh-ed25519");
	requireBoolean("stricthostkeychecking", true);
	requireBoolean("controlmaster", false);
	requireBoolean("forwardagent", false);
	requireBoolean("forwardx11", false);
	requireBoolean("clearallforwardings", true);
	requireBoolean("permitlocalcommand", false);
	requireBoolean("verifyhostkeydns", false);
	requireBoolean("updatehostkeys", false);
	requireBoolean("batchmode", true);
	requireOne("numberofpasswordprompts", "0");
	requireOne("connecttimeout", String(Math.ceil(target.connectTimeoutMs / 1000)));
	requireOne("connectionattempts", "1");
	requireOne("serveraliveinterval", "15");
	requireOne("serveralivecountmax", "3");
	// OpenSSH omits some effective "none" options from -G output.
	for (const key of ["controlpath", "knownhostscommand", "remotecommand"]) allowOnlyNone(key);
	for (const key of ["hashknownhosts", "checkhostip"]) if (values.has(key)) requireBoolean(key, false);
	if (target.identityFile !== undefined) {
		requireBoolean("identitiesonly", true);
		if (!values.get("identityfile")?.includes(target.identityFile)) throw new Error("SSH_HOST_STRICT_CONFIG_INVALID");
	}
}

// OpenSSH can ignore an inaccessible -i and authenticate with another configured identity.
async function assertReadableIdentity(filePath?: string): Promise<void> {
	if (filePath === undefined) return;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const stat = await lstat(filePath);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
		handle = await open(filePath, process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
		if (!(await handle.stat()).isFile()) throw new Error("not a regular file");
	} catch {
		throw new Error("SSH_HOST_IDENTITY_UNAVAILABLE");
	} finally {
		try {
			await handle?.close();
		} catch {
			throw new Error("SSH_HOST_IDENTITY_UNAVAILABLE");
		}
	}
}

/** Build argv after fresh route/pin checks through the caller's client; ssh -G can evaluate Match exec or DNS. */
export async function buildPinnedSshInvocation(userDataDir: string, hostId: string, kind: VerifiedSshCommandKind, options: { client: SshClientRuntime }): Promise<PinnedSshInvocation> {
	if (typeof options?.client?.run !== "function" || typeof options.client.sshPath !== "string") throw new Error("SSH_HOST_CLIENT_CONTEXT_REQUIRED");
	const client = options.client;
	const { version } = await runSshClientSelfCheck(client);
	const initial = (await RemoteHostStore.open(userDataDir)).getSnapshot();
	const profile = activeProfile(initial, hostId);
	const pinStore = new SshHostPinStore(userDataDir);
	const pin = await pinStore.readPin(hostId, profile.verifiedEndpoint);
	const target: VerifiedSshArgvInput = {
		hostId,
		sshHost: profile.sshHost,
		hostName: profile.verifiedEndpoint.hostName,
		user: profile.verifiedEndpoint.user,
		port: profile.verifiedEndpoint.port,
		pinAlias: profile.verifiedEndpoint.pinAlias,
		pinFile: pin.filePath,
		connectTimeoutMs: profile.connectTimeoutMs,
		...(profile.proxyJump !== undefined ? { proxyJump: profile.proxyJump } : {}),
		...(profile.identityFile !== undefined ? { identityFile: profile.identityFile } : {}),
	};
	const requestedArgs = buildVerifiedSshArgv(target, kind);
	await assertReadableIdentity(target.identityFile);
	const candidate = await querySshDraftRoute(profile, target.pinAlias, { client });
	assertSavedRoute(candidate.hostName, candidate.user, candidate.port, sshRouteDigest(candidate), profile);
	const strictArgs = kind === "scp" ? ["-G", ...requestedArgs, "--", target.sshHost] : ["-G", ...requestedArgs.slice(1)];
	const strictQuery = await client.run(client.sshPath, strictArgs);
	const effective = parseSshResolvedRoute(strictQuery);
	assertSavedRoute(effective.hostName, effective.user, effective.port, sshRouteDigest(effective), profile);
	assertStrictConfig(strictQuery.stdout, target);
	const current = (await RemoteHostStore.open(userDataDir)).getSnapshot();
	const currentProfile = activeProfile(current, hostId);
	if (current.revision !== initial.revision || JSON.stringify(currentProfile) !== JSON.stringify(profile)) throw new Error("SSH_HOST_NOT_READY");
	const currentPin = await pinStore.readPin(hostId, currentProfile.verifiedEndpoint);
	if (currentPin.filePath !== target.pinFile) throw new Error("SSH_HOST_NOT_READY");
	await assertReadableIdentity(target.identityFile);
	return { executable: kind === "scp" ? client.scpPath : client.sshPath, destination: target.sshHost, args: requestedArgs, env: client.env, openSshVersion: version };
}
