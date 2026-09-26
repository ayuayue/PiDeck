import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { SshHostPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts");
const { parseSshResolvedRoute, sshRouteDigest } = loadTsCommonJs("src/main/remote/SshRouteDigest.ts");

export const fakeSshPath = process.platform === "win32" ? "C:\\Program Files\\OpenSSH\\ssh.exe" : "/usr/bin/ssh";
export const fakeScpPath = process.platform === "win32" ? "C:\\Program Files\\OpenSSH\\scp.exe" : "/usr/bin/scp";
export const fakeEnv = { PATH: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\Tester" };
export const fakeVersion = "OpenSSH_for_Windows_9.5p2";

export function sshString(value) {
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(bytes.length);
	return Buffer.concat([size, bytes]);
}

export function candidateConfig(id, extra = "") {
	return `hostname server.example.invalid\nuser alice\nport 2222\nhostkeyalias pideck-${id}\ncanonicalizehostname false\n${extra}`;
}

export function candidate(id, proxyJump) {
	const alias = `pideck-${id}`;
	const key = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 23))]);
	const bytes = Buffer.from(`${alias} ssh-ed25519 ${key.toString("base64")}\n`);
	return {
		hostName: "server.example.invalid",
		user: "alice",
		port: 2222,
		pinAlias: alias,
		routeDigest: sshRouteDigest(parseSshResolvedRoute({ exitCode: 0, stdout: candidateConfig(id, proxyJump ? `proxyjump ${proxyJump}\n` : "") })),
		knownHostsBase64: bytes.toString("base64"),
		knownHostsSha256: createHash("sha256").update(bytes).digest("hex"),
		hostKeyFingerprints: [`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`],
	};
}

export function option(args, name) {
	return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function strictConfig(id, args, extra = "") {
	const globalFile = process.platform === "win32" ? "NUL" : "/dev/null";
	const identityIndex = args.indexOf("-i");
	const identity = identityIndex === -1 ? "" : `identityfile ${args[identityIndex + 1]}\nidentitiesonly yes\n`;
	return `${candidateConfig(id)}userknownhostsfile ${option(args, "UserKnownHostsFile")}\nglobalknownhostsfile ${globalFile}\nstricthostkeychecking true\ncontrolmaster false\nforwardagent no\nforwardx11 no\nclearallforwardings yes\npermitlocalcommand no\nverifyhostkeydns false\nupdatehostkeys false\nhostkeyalgorithms ssh-ed25519\nbatchmode yes\nnumberofpasswordprompts 0\nconnecttimeout 15\nconnectionattempts 1\nserveraliveinterval 15\nserveralivecountmax 3\n${identity}${extra}`;
}

/** Creates a temporary userData directory holding one ready, pin-verified host profile. */
export async function createPinnedHostFixture(t, extra = {}, prefix = "pideck pinned host-") {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const pinStore = new SshHostPinStore(directory, { verifier: async (route, alias) => candidate(alias.slice("pideck-".length), route.proxyJump) });
	t.after(() => pinStore.dispose());
	const store = await RemoteHostStore.open(directory, { pinStore });
	const profile = await store.createDraft({ label: "Build Pi", sshHost: "work", user: "alice", port: 2222, connectTimeoutMs: 15000, ...extra }, 0);
	const offer = await store.offerPin(profile.id, 7, 1);
	await store.confirmPin({ hostId: profile.id, senderId: 7, requestId: offer.requestId, choice: "approve" }, 1);
	return { directory, profile };
}

/**
 * Fake SshClientRuntime bound to a mock runner. The `-V` self-check is answered centrally so callers
 * only model route queries.
 */
export function createPinnedClient(id, mutate = () => undefined) {
	const calls = [];
	const run = async (executable, args) => {
		assert.equal(executable, fakeSshPath, "commands must use the bound ssh path");
		if (args.length === 1 && args[0] === "-V") return { exitCode: 0, stdout: "", stderr: `${fakeVersion}, LibreSSL 3.8.2` };
		calls.push({ executable, args });
		const strict = option(args, "UserKnownHostsFile") !== undefined;
		const result = await mutate({ executable, args, strict, call: calls.length });
		return result ?? { exitCode: 0, stdout: strict ? strictConfig(id, args) : candidateConfig(id) };
	};
	return { calls, run, client: { sshPath: fakeSshPath, scpPath: fakeScpPath, env: fakeEnv, run } };
}

/** Manual timer port: reconnect schedules are captured instead of waited for. */
export function createManualTimers() {
	const pending = [];
	return {
		pending,
		timers: {
			setTimeout(handler, delayMs) {
				const handle = { handler, delayMs, cancelled: false };
				pending.push(handle);
				return handle;
			},
			clearTimeout(handle) {
				if (handle) handle.cancelled = true;
			},
		},
		/** Runs the oldest still-pending timer, returning the delay it was armed with. */
		async fireNext() {
			while (pending.length) {
				const handle = pending.shift();
				if (handle.cancelled) continue;
				handle.handler();
				await settle();
				return handle.delayMs;
			}
			return undefined;
		},
		live() {
			return pending.filter((handle) => !handle.cancelled);
		},
	};
}

export async function flushMicrotasks() {
	for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

/**
 * Lets real I/O (the host store is read on every preflight) and the follow-up promise chain progress.
 * Microtask flushing alone is not enough once a code path touches the filesystem.
 */
export async function settle(rounds = 12) {
	for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Polls a condition instead of guessing how many turns a filesystem-backed chain needs. */
export async function waitFor(predicate, { timeoutMs = 3000, label = "condition" } = {}) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error(`timed out waiting for ${label}`);
}
