import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { writeDurableJsonFile } from "../persistence/durableJsonStore";
import { SshHostPinStore, type SshPinAnswer, type SshPinOffer } from "./SshHostPinStore";
import { decodeRemoteHostSnapshot, encodeRemoteHostSnapshot, type DecodedRemoteHostSnapshot, type RemoteHostProfile } from "./RemoteHostStoreCodec";

export type RemoteHostStoreState = DecodedRemoteHostSnapshot & { status: "ready" | "needs-repair"; reasons: string[] };
type SnapshotRead = { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; snapshot: DecodedRemoteHostSnapshot };
type PinEnrollment = Pick<SshHostPinStore, "offer" | "answer" | "readPin">;
type DraftInput = Pick<RemoteHostProfile, "label" | "sshHost" | "connectTimeoutMs"> & Partial<Pick<RemoteHostProfile, "user" | "port" | "proxyJump" | "identityFile" | "remotePiCommand" | "remoteNodeCommand">>;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

async function readSnapshot(filePath: string): Promise<SnapshotRead> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const pathStat = await lstat(filePath);
		if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > MAX_SNAPSHOT_BYTES) return { kind: "invalid" };
		handle = await open(filePath, "r");
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return { kind: "invalid" };
		const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (!length || length > MAX_SNAPSHOT_BYTES) return { kind: "invalid" };
		const content = buffer.subarray(0, length).toString("utf8");
		if (!Buffer.from(content, "utf8").equals(buffer.subarray(0, length))) return { kind: "invalid" };
		return { kind: "valid", snapshot: decodeRemoteHostSnapshot(JSON.parse(content)) };
	} catch (error) {
		return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
	} finally {
		await handle?.close();
	}
}

async function pinIssues(userDataDir: string, snapshot: DecodedRemoteHostSnapshot, pinStore: PinEnrollment, pendingActivationHostId?: string): Promise<string[]> {
	const issues: string[] = [];
	const root = join(userDataDir, "ssh-host-keys");
	let names: string[] = [];
	try {
		const stat = await lstat(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return ["REMOTE_HOST_PIN_INVALID"];
		names = await readdir(root);
		if (names.length > 2000) return ["REMOTE_HOST_PIN_ORPHAN"];
	} catch (error) {
		if (errorCode(error) !== "ENOENT") return ["REMOTE_HOST_PIN_INVALID"];
	}
	const byId = new Map(snapshot.profiles.map((profile) => [profile.id, profile]));
	for (const name of names) {
		const profile = byId.get(name);
		if (name === pendingActivationHostId && profile && !profile.verifiedEndpoint && !profile.disabledAt) continue;
		if (!profile?.verifiedEndpoint) issues.push("REMOTE_HOST_PIN_ORPHAN");
	}
	for (const profile of snapshot.profiles) {
		if (!profile.verifiedEndpoint) continue;
		try {
			await pinStore.readPin(profile.id, profile.verifiedEndpoint);
		} catch {
			issues.push("REMOTE_HOST_PIN_INVALID");
		}
	}
	return issues;
}

async function loadState(userDataDir: string, pinStore: PinEnrollment, pendingActivationHostId?: string): Promise<RemoteHostStoreState> {
	const filePath = join(userDataDir, "remote-hosts.json");
	const [primary, backup] = await Promise.all([readSnapshot(filePath), readSnapshot(`${filePath}.bak`)]);
	const reasons: string[] = [];
	let snapshot: DecodedRemoteHostSnapshot = { revision: 0, profiles: [], retiredHostIds: [] };
	if (primary.kind === "valid" && backup.kind === "valid") {
		if (backup.snapshot.revision > primary.snapshot.revision) {
			snapshot = backup.snapshot;
			reasons.push("REMOTE_HOST_BACKUP_SELECTED");
		} else {
			snapshot = primary.snapshot;
			if (backup.snapshot.revision === primary.snapshot.revision && JSON.stringify(backup.snapshot) !== JSON.stringify(primary.snapshot)) reasons.push("REMOTE_HOST_SNAPSHOT_CONFLICT");
		}
	} else if (primary.kind === "valid") {
		snapshot = primary.snapshot;
		if (backup.kind === "invalid") reasons.push("REMOTE_HOST_BACKUP_INVALID");
	} else if (backup.kind === "valid") {
		snapshot = backup.snapshot;
		reasons.push(primary.kind === "invalid" ? "REMOTE_HOST_PRIMARY_INVALID" : "REMOTE_HOST_PRIMARY_MISSING");
	} else if (primary.kind !== "missing" || backup.kind !== "missing") {
		reasons.push("REMOTE_HOST_SNAPSHOT_INVALID");
	}
	reasons.push(...(await pinIssues(userDataDir, snapshot, pinStore, pendingActivationHostId)));
	return { ...snapshot, status: reasons.length ? "needs-repair" : "ready", reasons: [...new Set(reasons)] };
}

/** Versioned, fail-closed profile catalog. Cross-store rebind/retirement require a later shared transaction. */
export class RemoteHostStore {
	private state: RemoteHostStoreState;
	private readonly userDataDir: string;
	private readonly filePath: string;
	private readonly pinStore: PinEnrollment;

	private constructor(userDataDir: string, pinStore: PinEnrollment, state: RemoteHostStoreState) {
		this.userDataDir = userDataDir;
		this.filePath = join(userDataDir, "remote-hosts.json");
		this.pinStore = pinStore;
		this.state = state;
	}

	static async open(userDataDir: string, options: { pinStore?: PinEnrollment } = {}): Promise<RemoteHostStore> {
		if (typeof userDataDir !== "string" || !isAbsolute(userDataDir) || /[\x00-\x1f\x7f]/.test(userDataDir)) throw new Error("REMOTE_HOST_STORE_PATH_INVALID");
		const pinStore = options.pinStore ?? new SshHostPinStore(userDataDir);
		const state = await loadState(userDataDir, pinStore);
		try {
			await lstat(join(userDataDir, "remote-hosts.json.lock"));
			state.status = "needs-repair";
			state.reasons.push("REMOTE_HOST_LOCK_PRESENT");
		} catch (error) {
			if (errorCode(error) !== "ENOENT") {
				state.status = "needs-repair";
				state.reasons.push("REMOTE_HOST_LOCK_UNREADABLE");
			}
		}
		return new RemoteHostStore(userDataDir, pinStore, state);
	}

	getSnapshot(): RemoteHostStoreState {
		const decoded = decodeRemoteHostSnapshot({ schemaVersion: 1, revision: this.state.revision, profiles: this.state.profiles, retiredHostIds: this.state.retiredHostIds });
		return { ...decoded, status: this.state.status, reasons: [...this.state.reasons] };
	}

	async createDraft(input: DraftInput, expectedRevision: number): Promise<RemoteHostProfile> {
		const now = new Date().toISOString();
		const id = randomUUID();
		const profile: RemoteHostProfile = {
			id,
			label: input.label,
			sshHost: input.sshHost,
			connectTimeoutMs: input.connectTimeoutMs,
			createdAt: now,
			updatedAt: now,
			...(input.user !== undefined ? { user: input.user } : {}),
			...(input.port !== undefined ? { port: input.port } : {}),
			...(input.proxyJump !== undefined ? { proxyJump: input.proxyJump } : {}),
			...(input.identityFile !== undefined ? { identityFile: input.identityFile } : {}),
			...(input.remotePiCommand !== undefined ? { remotePiCommand: input.remotePiCommand } : {}),
			...(input.remoteNodeCommand !== undefined ? { remoteNodeCommand: input.remoteNodeCommand } : {}),
		};
		return this.mutate(expectedRevision, async (snapshot) => {
			if (snapshot.profiles.some((existing) => existing.id === id) || snapshot.retiredHostIds.includes(id)) throw new Error("REMOTE_HOST_ID_REUSED");
			return { next: { ...snapshot, profiles: [...snapshot.profiles, profile] }, result: profile };
		});
	}

	/** Generate the prompt from the stored draft; caller never supplies host identity fields. */
	async offerPin(hostId: string, senderId: number, expectedRevision: number): Promise<SshPinOffer> {
		if (this.state.status !== "ready") throw new Error("REMOTE_HOST_STORE_NEEDS_REPAIR");
		if (expectedRevision !== this.state.revision) throw new Error("REMOTE_HOST_REVISION_CONFLICT");
		const profile = this.state.profiles.find((item) => item.id === hostId);
		if (!profile || profile.disabledAt || profile.verifiedEndpoint) throw new Error("REMOTE_HOST_ACTIVATION_INVALID");
		return this.pinStore.offer({ hostId, senderId, route: { sshHost: profile.sshHost, ...(profile.user !== undefined ? { user: profile.user } : {}), ...(profile.port !== undefined ? { port: profile.port } : {}), ...(profile.proxyJump !== undefined ? { proxyJump: profile.proxyJump } : {}) } });
	}

	/** Consume the main-owned proof under the profile lock before saving the verified endpoint. */
	async confirmPin(answer: SshPinAnswer, expectedRevision: number): Promise<RemoteHostProfile | null> {
		return this.mutate(
			expectedRevision,
			async (snapshot) => {
				const profile = snapshot.profiles.find((item) => item.id === answer.hostId);
				if (!profile || profile.disabledAt || profile.verifiedEndpoint) throw new Error("REMOTE_HOST_ACTIVATION_INVALID");
				const endpoint = await this.pinStore.answer(answer);
				if (!endpoint) return { next: snapshot, result: null, write: false };
				try {
					await this.pinStore.readPin(answer.hostId, endpoint);
				} catch {
					throw new Error("REMOTE_HOST_PIN_INVALID");
				}
				const now = new Date().toISOString();
				const verified: RemoteHostProfile = {
					...profile,
					verifiedEndpoint: { hostName: endpoint.hostName, user: endpoint.user, port: endpoint.port, pinAlias: endpoint.pinAlias, routeDigest: endpoint.routeDigest, knownHostsSha256: endpoint.knownHostsSha256, hostKeyFingerprints: [...endpoint.hostKeyFingerprints] },
					verifiedAt: now,
					updatedAt: now,
				};
				return { next: { ...snapshot, profiles: snapshot.profiles.map((item) => (item.id === answer.hostId ? verified : item)) }, result: verified };
			},
			answer.hostId,
		);
	}

	async disable(hostId: string, expectedRevision: number): Promise<RemoteHostProfile> {
		return this.mutate(expectedRevision, async (snapshot) => {
			const profile = snapshot.profiles.find((item) => item.id === hostId);
			if (!profile || profile.disabledAt) throw new Error("REMOTE_HOST_DISABLE_INVALID");
			const now = new Date().toISOString();
			const disabled: RemoteHostProfile = { ...profile, disabledAt: now, updatedAt: now };
			return { next: { ...snapshot, profiles: snapshot.profiles.map((item) => (item.id === hostId ? disabled : item)) }, result: disabled };
		});
	}

	private async mutate<T>(expectedRevision: number, change: (snapshot: DecodedRemoteHostSnapshot) => Promise<{ next: DecodedRemoteHostSnapshot; result: T; write?: boolean }>, pendingActivationHostId?: string): Promise<T> {
		if (this.state.status !== "ready") throw new Error("REMOTE_HOST_STORE_NEEDS_REPAIR");
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.state.revision) throw new Error("REMOTE_HOST_REVISION_CONFLICT");
		await mkdir(this.userDataDir, { recursive: true });
		const lockPath = `${this.filePath}.lock`;
		let lock: Awaited<ReturnType<typeof open>>;
		try {
			lock = await open(lockPath, "wx", 0o600);
		} catch (error) {
			throw new Error(errorCode(error) === "EEXIST" ? "REMOTE_HOST_STORE_BUSY" : "REMOTE_HOST_STORE_NEEDS_REPAIR");
		}
		let writeStarted = false;
		try {
			const disk = await loadState(this.userDataDir, this.pinStore, pendingActivationHostId);
			if (disk.status !== "ready") throw new Error("REMOTE_HOST_STORE_NEEDS_REPAIR");
			if (disk.revision !== expectedRevision || JSON.stringify(disk.profiles) !== JSON.stringify(this.state.profiles) || JSON.stringify(disk.retiredHostIds) !== JSON.stringify(this.state.retiredHostIds)) throw new Error("REMOTE_HOST_REVISION_CONFLICT");
			const { next, result, write } = await change(disk);
			if (write === false) return result;
			const encoded = encodeRemoteHostSnapshot(next.profiles, next.retiredHostIds, expectedRevision + 1);
			writeStarted = true;
			await writeDurableJsonFile(this.filePath, `${JSON.stringify(encoded, null, 2)}\n`, { backupPath: `${this.filePath}.bak`, backupFailurePolicy: "throw" });
			const checked = await loadState(this.userDataDir, this.pinStore);
			if (checked.status !== "ready" || checked.revision !== expectedRevision + 1) throw new Error("REMOTE_HOST_STORE_NEEDS_REPAIR");
			this.state = checked;
			return result;
		} catch (error) {
			if (writeStarted) {
				this.state = { ...this.state, status: "needs-repair", reasons: ["REMOTE_HOST_WRITE_UNCERTAIN"] };
				throw new Error("REMOTE_HOST_STORE_NEEDS_REPAIR");
			}
			if (pendingActivationHostId) {
				try {
					const checked = await loadState(this.userDataDir, this.pinStore);
					if (checked.status === "needs-repair") this.state = checked;
				} catch {
					this.state = { ...this.state, status: "needs-repair", reasons: ["REMOTE_HOST_STATE_UNCERTAIN"] };
				}
			}
			throw error;
		} finally {
			try {
				await lock.close();
				await unlink(lockPath);
			} catch {
				this.state = { ...this.state, status: "needs-repair", reasons: ["REMOTE_HOST_LOCK_PRESENT"] };
				throw new Error("REMOTE_HOST_STORE_NEEDS_REPAIR");
			}
		}
	}
}
