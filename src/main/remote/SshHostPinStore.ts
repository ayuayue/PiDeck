import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PendingConfirmationBroker } from "../security/PendingConfirmationBroker";
import { buildSshConfigQueryArgs, type SshDraftRoute } from "./SshCommandBuilder";
import { fingerprintSshHostKey, readBoundedHostKey, type SshDraftHostCandidate, verifyDraftSshHost } from "./SshHostVerifier";

export type VerifiedSshEndpoint = Omit<SshDraftHostCandidate, "knownHostsBase64">;

export type SshPinOffer = {
	requestId: string;
	expiresAt: number;
	hostId: string;
	hostName: string;
	user: string;
	port: number;
	pinAlias: string;
	routeDigest: string;
	hostKeyFingerprints: string[];
};

type PendingPin = { candidate: SshDraftHostCandidate; route: SshDraftRoute };
export type SshPinAnswer = { requestId: string; hostId: string; senderId: number; choice: "approve" | "deny" };
const ACTION = "ssh:fingerprint";
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PIN_BYTES = 16 * 1024;

function pinDigest(hostId: string, candidate: SshDraftHostCandidate): string {
	const identity = ["ssh-pin-confirm-v1", hostId, candidate.hostName, candidate.user, candidate.port, candidate.pinAlias, candidate.routeDigest, candidate.knownHostsSha256, ...candidate.hostKeyFingerprints];
	return createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
}

function candidateBytes(candidate: SshDraftHostCandidate, hostId: string): Buffer {
	try {
		if (!candidate || candidate.pinAlias !== `pideck-${hostId}` || typeof candidate.hostName !== "string" || !candidate.hostName || typeof candidate.user !== "string" || !candidate.user || !Number.isInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535) throw new Error("invalid endpoint");
		if (!/^[a-f0-9]{64}$/.test(candidate.routeDigest) || !/^[a-f0-9]{64}$/.test(candidate.knownHostsSha256)) throw new Error("invalid hash");
		if (typeof candidate.knownHostsBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(candidate.knownHostsBase64) || candidate.knownHostsBase64.length > Math.ceil(MAX_PIN_BYTES / 3) * 4 + 4) throw new Error("invalid bytes");
		const bytes = Buffer.from(candidate.knownHostsBase64, "base64");
		if (bytes.length === 0 || bytes.length > MAX_PIN_BYTES || bytes.toString("base64") !== candidate.knownHostsBase64 || createHash("sha256").update(bytes).digest("hex") !== candidate.knownHostsSha256) throw new Error("invalid bytes");
		if (!Array.isArray(candidate.hostKeyFingerprints) || candidate.hostKeyFingerprints.length !== 1 || fingerprintSshHostKey(bytes, candidate.pinAlias) !== candidate.hostKeyFingerprints[0]) throw new Error("invalid fingerprint");
		return bytes;
	} catch {
		throw new Error("SSH_HOST_CANDIDATE_INVALID");
	}
}

async function assertPinAbsent(filePath: string): Promise<void> {
	try {
		await lstat(filePath);
		throw new Error("SSH_HOST_PIN_EXISTS");
	} catch (error) {
		if (error instanceof Error && error.message === "SSH_HOST_PIN_EXISTS") throw error;
		if (errorCode(error) !== "ENOENT") throw new Error("SSH_HOST_PIN_INVALID");
	}
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(directory, "r");
		await handle.sync();
	} catch (error) {
		if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(errorCode(error) ?? "")) throw error;
	} finally {
		await handle?.close();
	}
}

/** Persist only broker-approved, reverified host pins; the caller must separately save endpoint metadata. */
export class SshHostPinStore {
	private readonly root: string;
	private readonly verifier: typeof verifyDraftSshHost;
	private readonly broker = new PendingConfirmationBroker<PendingPin>({
		onRemoved: (requestId) => {
			for (const [hostId, pending] of this.byHost) if (pending.requestId === requestId) this.byHost.delete(hostId);
		},
	});
	private readonly byHost = new Map<string, { requestId: string; senderId: number; digest: string }>();
	private readonly senderEpoch = new Map<number, number>();
	private closed = false;

	constructor(userDataDir: string, options: { verifier?: typeof verifyDraftSshHost } = {}) {
		if (typeof userDataDir !== "string" || !isAbsolute(userDataDir) || /[\x00-\x1f\x7f]/.test(userDataDir)) throw new Error("SSH_HOST_PIN_ROOT_INVALID");
		this.root = join(userDataDir, "ssh-host-keys");
		this.verifier = options.verifier ?? verifyDraftSshHost;
	}

	async offer(input: { hostId: string; senderId: number; route: SshDraftRoute }): Promise<SshPinOffer> {
		if (this.closed) throw new Error("CONFIRMATION_CLOSED");
		this.checkHostId(input.hostId);
		if (!Number.isSafeInteger(input.senderId) || input.senderId < 1) throw new Error("CONFIRMATION_INVALID");
		const epoch = this.senderEpoch.get(input.senderId) ?? 0;
		const route: SshDraftRoute = { sshHost: input.route?.sshHost, ...(input.route?.user !== undefined ? { user: input.route.user } : {}), ...(input.route?.port !== undefined ? { port: input.route.port } : {}), ...(input.route?.proxyJump !== undefined ? { proxyJump: input.route.proxyJump } : {}) };
		buildSshConfigQueryArgs(route);
		const filePath = this.pathFor(input.hostId);
		await assertPinAbsent(filePath);
		const candidate = await this.verifier(route, `pideck-${input.hostId}`);
		candidateBytes(candidate, input.hostId);
		await assertPinAbsent(filePath);
		this.assertActive(input.senderId, epoch);
		const snapshot = { ...candidate, hostKeyFingerprints: [...candidate.hostKeyFingerprints] };
		const digest = pinDigest(input.hostId, snapshot);
		const previous = this.byHost.get(input.hostId);
		if (previous) this.broker.cancel(previous.requestId);
		const issued = this.broker.begin({ senderId: input.senderId, action: ACTION, subjectId: input.hostId, stateDigest: digest, payload: { candidate: snapshot, route } });
		this.byHost.set(input.hostId, { requestId: issued.requestId, senderId: input.senderId, digest });
		return { ...issued, hostId: input.hostId, hostName: snapshot.hostName, user: snapshot.user, port: snapshot.port, pinAlias: snapshot.pinAlias, routeDigest: snapshot.routeDigest, hostKeyFingerprints: [...snapshot.hostKeyFingerprints] };
	}

	async answer(input: SshPinAnswer): Promise<VerifiedSshEndpoint | null> {
		this.checkHostId(input.hostId);
		const pending = this.byHost.get(input.hostId);
		if (!pending || pending.requestId !== input.requestId) throw new Error("SSH_HOST_CONFIRMATION_INVALID");
		const epoch = this.senderEpoch.get(input.senderId) ?? 0;
		const authorized = this.broker.answer({ ...input, action: ACTION, subjectId: input.hostId, stateDigest: pending.digest });
		this.byHost.delete(input.hostId);
		if (!authorized) return null;
		const current = await this.verifier(authorized.route, authorized.candidate.pinAlias);
		const bytes = candidateBytes(current, input.hostId);
		if (pinDigest(input.hostId, current) !== pending.digest) throw new Error("SSH_HOST_CANDIDATE_CHANGED");
		this.assertActive(input.senderId, epoch);
		await this.writeNewPin(input.hostId, bytes, () => this.assertActive(input.senderId, epoch));
		return { hostName: current.hostName, user: current.user, port: current.port, pinAlias: current.pinAlias, routeDigest: current.routeDigest, knownHostsSha256: current.knownHostsSha256, hostKeyFingerprints: [...current.hostKeyFingerprints] };
	}

	async readPin(hostId: string, endpoint: VerifiedSshEndpoint): Promise<{ filePath: string; endpoint: VerifiedSshEndpoint }> {
		this.checkHostId(hostId);
		const filePath = this.pathFor(hostId);
		try {
			if (!endpoint || endpoint.pinAlias !== `pideck-${hostId}` || !/^[a-f0-9]{64}$/.test(endpoint.knownHostsSha256) || !/^[a-f0-9]{64}$/.test(endpoint.routeDigest) || !Array.isArray(endpoint.hostKeyFingerprints) || endpoint.hostKeyFingerprints.length !== 1) throw new Error("metadata");
			const bytes = await readBoundedHostKey(filePath);
			if (createHash("sha256").update(bytes).digest("hex") !== endpoint.knownHostsSha256 || fingerprintSshHostKey(bytes, endpoint.pinAlias) !== endpoint.hostKeyFingerprints[0]) throw new Error("mismatch");
			return { filePath, endpoint };
		} catch {
			throw new Error("SSH_HOST_PIN_INVALID");
		}
	}

	cancelSender(senderId: number): void {
		this.senderEpoch.set(senderId, (this.senderEpoch.get(senderId) ?? 0) + 1);
		this.broker.cancelSender(senderId);
		for (const [hostId, item] of this.byHost) if (item.senderId === senderId) this.byHost.delete(hostId);
	}

	dispose(): void {
		this.closed = true;
		this.broker.dispose();
		this.byHost.clear();
		this.senderEpoch.clear();
	}

	private assertActive(senderId: number, epoch: number): void {
		if (this.closed) throw new Error("CONFIRMATION_CLOSED");
		if ((this.senderEpoch.get(senderId) ?? 0) !== epoch) throw new Error("CONFIRMATION_CANCELLED");
	}

	private checkHostId(hostId: string): void {
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) throw new Error("INVALID_SSH_HOST_ID");
	}

	private pathFor(hostId: string): string {
		return join(this.root, hostId);
	}

	private async writeNewPin(hostId: string, bytes: Buffer, assertActive: () => void): Promise<void> {
		const filePath = this.pathFor(hostId);
		const tempPath = join(this.root, `.${hostId}.${randomUUID()}.tmp`);
		try {
			await mkdir(this.root, { recursive: true, mode: 0o700 });
			const rootStat = await lstat(this.root);
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid root");
			const handle = await open(tempPath, "wx", 0o600);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			// A hard link publishes the flushed pin atomically and refuses an existing hostId.
			assertActive();
			await link(tempPath, filePath);
			await syncDirectory(this.root);
		} catch (error) {
			if (error instanceof Error && (error.message === "CONFIRMATION_CANCELLED" || error.message === "CONFIRMATION_CLOSED")) throw error;
			if (errorCode(error) === "EEXIST") throw new Error("SSH_HOST_PIN_EXISTS");
			throw new Error("SSH_HOST_PIN_WRITE_FAILED");
		} finally {
			await unlink(tempPath).catch(() => undefined);
		}
	}
}
