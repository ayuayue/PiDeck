import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";

const { createSshClientRuntime } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");
const { SshHostPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { buildPinnedSshInvocation } = loadTsCommonJs("src/main/remote/SshVerifiedConnection.ts");
const { fingerprintSshHostKey } = loadTsCommonJs("src/main/remote/SshHostVerifier.ts");
const { bootstrapPinnedHost, BootstrapReadyUnconfirmedError } = loadTsCommonJs("src/main/remote/RemoteBootstrapSession.ts");
const { assertSupportedRemoteNodeVersion, buildRemoteNodeVersionCommand } = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");
const { createSshProcessLauncher } = loadTsCommonJs("src/main/remote/SshProcessLauncher.ts");

/** Disposable real-host smoke: no profile or key is written to PiDeck's userData. */
async function verifyRemoteHost(host, user, fingerprint, bootstrap) {
	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || !/^[a-z_][a-z0-9_-]*$/.test(user) || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error("SMOKE_INPUT_INVALID");
	const directory = await mkdtemp(join(tmpdir(), "pideck-real-pinned-e2e-"));
	let pinStore;
	try {
		const client = createSshClientRuntime({ sshPath: "/usr/bin/ssh" });
		pinStore = new SshHostPinStore(directory, { client });
		const store = await RemoteHostStore.open(directory, { pinStore });
		const profile = await store.createDraft({ label: "remote-smoke", sshHost: host, user, port: 22, connectTimeoutMs: 10_000 }, 0);
		const scanned = execFileSync("/usr/bin/ssh-keyscan", ["-T", "8", "-t", "ed25519", host], { encoding: "utf8", timeout: 12_000, stdio: ["ignore", "pipe", "ignore"] });
		const lines = scanned
			.trim()
			.split("\n")
			.filter((line) => line && !line.startsWith("#"));
		if (lines.length !== 1) throw new Error("KEYSCAN_AMBIGUOUS");
		const [reportedHost, algorithm, blob] = lines[0].split(/\s+/);
		if (reportedHost !== host || algorithm !== "ssh-ed25519" || !blob) throw new Error("KEYSCAN_INVALID");
		const alias = `pideck-${profile.id}`;
		const trusted = { knownHostsBytes: Buffer.from(`${alias} ssh-ed25519 ${blob}\n`), fingerprint };
		if (fingerprintSshHostKey(trusted.knownHostsBytes, alias) !== fingerprint) throw new Error("HOST_FINGERPRINT_MISMATCH");
		const offer = await store.offerPin(profile.id, 1, 1, trusted);
		if (offer.hostKeyFingerprints.length !== 1 || offer.hostKeyFingerprints[0] !== fingerprint) throw new Error("HOST_OFFER_MISMATCH");
		await store.confirmPin({ requestId: offer.requestId, hostId: profile.id, senderId: 1, choice: "approve" }, 1);
		const invocation = await buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client, remoteCommand: "command -v node" });
		const result = await client.run(invocation.executable, invocation.args);
		if (result.exitCode !== 0 || !/^\/[\w/.-]+\n?$/.test(result.stdout)) throw new Error("REMOTE_NODE_PROBE_FAILED");
		const nodePath = result.stdout.trim();
		console.log("PINNED_PROFILE_OK", "NODE_PATH", nodePath, "VER", invocation.openSshVersion);
		// A well-formed absolute path says nothing about the version behind it: `node:` prefixed
		// require() (used by the frozen entry, outside its try) landed in 14.18, so an older node
		// dies at the entry's first statement with stderr and no frame, which is indistinguishable
		// from a broken entry. Gate on the version here, before any bootstrap work is attempted, so
		// an unsupported host fails as a precondition instead of a zero-frame exit. This probes the
		// same verified executable, never PATH, and reuses the contract's own 22.3 threshold.
		const versionInvocation = await buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client, remoteCommand: buildRemoteNodeVersionCommand(nodePath) });
		const versionResult = await client.run(versionInvocation.executable, versionInvocation.args);
		if (versionResult.exitCode !== 0) throw new Error("REMOTE_NODE_VERSION_PROBE_FAILED");
		try {
			assertSupportedRemoteNodeVersion(versionResult.stdout);
		} catch {
			throw new Error(`REMOTE_NODE_VERSION_UNSUPPORTED ${nodePath} ${versionResult.stdout.trim().slice(0, 32)}`);
		}
		console.log("REMOTE_NODE_VERSION_OK", versionResult.stdout.trim());
		if (bootstrap) {
			try {
				const activated = await bootstrapPinnedHost({ userDataDir: directory, hostId: profile.id, generation: 1, nonce: randomBytes(16).toString("hex"), nodePath, client, launcher: createSshProcessLauncher() });
				console.log("BOOTSTRAP_FINALIZED", activated.bundleSha256, activated.active);
			} catch (error) {
				if (error instanceof BootstrapReadyUnconfirmedError) console.error("BOOTSTRAP_NO_READY", error.exitKind, error.exitCode ?? "none", error.stderrSeen ? "stderr-present" : "no-stderr");
				throw error;
			}
		}
	} finally {
		pinStore?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

const [host, user, fingerprint, option] = process.argv.slice(2);
if (process.argv.length !== 5 && (process.argv.length !== 6 || option !== "--bootstrap")) throw new Error("Usage: node scripts/verify-remote-host.mjs <IPv4> <user> <independently-verified-ED25519-SHA256-fingerprint> [--bootstrap]");
await verifyRemoteHost(host, user, fingerprint, option === "--bootstrap");
