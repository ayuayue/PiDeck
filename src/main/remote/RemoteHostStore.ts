import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { writeDurableJsonFile } from "../persistence/durableJsonStore";
import { isHostReferenceRegistryCode } from "./RemoteHostReferenceRegistry";
import { buildSshConfigQueryArgs, type SshDraftRoute } from "./SshCommandBuilder";
import { SshHostPinStore, type SshPinAnswer, type SshPinOffer, type VerifiedSshEndpoint } from "./SshHostPinStore";
import { decodeRemoteHostSnapshot, encodeRemoteHostSnapshot, type DecodedRemoteHostSnapshot, type RemoteHostProfile } from "./RemoteHostStoreCodec";

export type RemoteHostStoreState = DecodedRemoteHostSnapshot & { status: "ready" | "needs-repair"; reasons: string[] };
type SnapshotRead = { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; snapshot: DecodedRemoteHostSnapshot };
type PinEnrollment = Pick<SshHostPinStore, "offer" | "answer" | "readPin"> & Partial<Pick<SshHostPinStore, "deletePin" | "hasPendingOffer" | "pendingRoute">>;

/** Main-owned view of which host ids are still referenced by projects/sessions. */
export type RemoteHostReferences = { referencedHostIds(): Promise<ReadonlySet<string>> };

/** Structural view of the reference registry (design §4.1): the store only needs the store-facing view. */
export type RemoteHostReferenceRegistryView = { asStoreReferences(): RemoteHostReferences };

/**
 * Every stable code this store may hand out. Reference-scan codes are pass-through values owned by
 * `RemoteHostReferenceRegistry`, so the two vocabularies are checked together before an exception is
 * allowed to cross a module boundary (no errno, no provider text).
 */
export const REMOTE_HOST_STORE_CODES = [
	"REMOTE_HOST_STORE_PATH_INVALID",
	"REMOTE_HOST_STORE_INVALID",
	"REMOTE_HOST_STORE_NEEDS_REPAIR",
	"REMOTE_HOST_STORE_BUSY",
	"REMOTE_HOST_REVISION_CONFLICT",
	"REMOTE_HOST_REFERENCES_UNAVAILABLE",
	"REMOTE_HOST_REFERENCED",
	"REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE",
	"REMOTE_HOST_EDIT_INVALID",
	"REMOTE_HOST_ID_REUSED",
	"REMOTE_HOST_ACTIVATION_INVALID",
	"REMOTE_HOST_DISABLE_INVALID",
	"REMOTE_HOST_RETIRE_INVALID",
	"REMOTE_HOST_PIN_INVALID",
	"REMOTE_HOST_PIN_CLEANUP_FAILED",
	"REMOTE_HOST_WRITE_UNCERTAIN",
	"REMOTE_HOST_ANCHOR_STILL_VALID",
	"SSH_HOST_PIN_INVALID",
] as const;

export type RemoteHostStoreCode = (typeof REMOTE_HOST_STORE_CODES)[number];

const REMOTE_HOST_STORE_CODE_SET: ReadonlySet<string> = new Set(REMOTE_HOST_STORE_CODES);

export function isRemoteHostStoreCode(code: string): code is RemoteHostStoreCode {
	return REMOTE_HOST_STORE_CODE_SET.has(code);
}

/** Editable fields of a never-verified draft; absent keys keep their current value. */
export type RemoteHostDraftPatch = Partial<Pick<RemoteHostProfile, "label" | "sshHost" | "user" | "port" | "proxyJump" | "identityFile" | "connectTimeoutMs">>;
type DraftInput = Pick<RemoteHostProfile, "label" | "sshHost" | "connectTimeoutMs"> & Partial<Pick<RemoteHostProfile, "user" | "port" | "proxyJump" | "identityFile" | "remotePiCommand" | "remoteNodeCommand">>;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

/** Endpoint identity comparison for the offer/confirm handshake (optional fields must match exactly). */
function sameRoute(route: SshDraftRoute, profile: RemoteHostProfile): boolean {
	return route.sshHost === profile.sshHost && route.user === profile.user && route.port === profile.port && route.proxyJump === profile.proxyJump;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasReferenceSetShape(value: unknown): value is ReadonlySet<string> {
	if (typeof value !== "object" || value === null) return false;
	if (!("has" in value) || !("size" in value)) return false;
	return typeof value.has === "function" && typeof value.size === "number";
}

function isReferenceView(value: unknown): value is RemoteHostReferences {
	return isRecord(value) && typeof value.referencedHostIds === "function";
}

function isRegistryView(value: unknown): value is RemoteHostReferenceRegistryView {
	return isRecord(value) && typeof value.asStoreReferences === "function";
}

/**
 * Resolve the injected reference provider. A registry (design §4.1) is used through its compatibility
 * view, and only lazily: opening the catalog must not fail just because the registry is empty — the
 * "cannot prove there is no reference" failure belongs to the mutation that needs that proof.
 */
function resolveReferences(options: { references?: RemoteHostReferences; referenceRegistry?: RemoteHostReferenceRegistryView }): RemoteHostReferences | undefined {
	// Ambiguous wiring is refused instead of silently picking one of the two providers.
	if (options.references !== undefined && options.referenceRegistry !== undefined) throw new Error("REMOTE_HOST_REFERENCES_UNAVAILABLE");
	if (options.referenceRegistry !== undefined) {
		if (!isRegistryView(options.referenceRegistry)) throw new Error("REMOTE_HOST_REFERENCES_UNAVAILABLE");
		const registry = options.referenceRegistry;
		return { referencedHostIds: async () => registry.asStoreReferences().referencedHostIds() };
	}
	if (options.references === undefined) return undefined;
	if (!isReferenceView(options.references)) throw new Error("REMOTE_HOST_REFERENCES_UNAVAILABLE");
	return options.references;
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
	const retired = new Set(snapshot.retiredHostIds);
	for (const name of names) {
		const profile = byId.get(name);
		if (name === pendingActivationHostId && profile && !profile.verifiedEndpoint && !profile.disabledAt) continue;
		// A pin whose host id is retired is leftover garbage from a retired host, not damage: the id can
		// never be reused, so it cannot be mistaken for a live trust anchor.
		if (retired.has(name)) continue;
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

/** A held lock is a transient condition (another instance is mutating), not proof of corruption. */
async function applyLockCheck(userDataDir: string, state: RemoteHostStoreState): Promise<void> {
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
}

/** Delete pins whose host id is retired; best effort, because the next load tolerates them anyway. */
async function pruneRetiredPins(userDataDir: string, snapshot: DecodedRemoteHostSnapshot, pinStore: PinEnrollment): Promise<void> {
	if (snapshot.retiredHostIds.length === 0 || typeof pinStore.deletePin !== "function") return;
	for (const hostId of snapshot.retiredHostIds) {
		try {
			await pinStore.deletePin(hostId);
		} catch {
			// Leftovers are ignored by pinIssues and retried on the next open.
		}
	}
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
	private readonly references?: RemoteHostReferences;

	private constructor(userDataDir: string, pinStore: PinEnrollment, state: RemoteHostStoreState, references?: RemoteHostReferences) {
		this.userDataDir = userDataDir;
		this.filePath = join(userDataDir, "remote-hosts.json");
		this.pinStore = pinStore;
		this.state = state;
		this.references = references;
	}

	static async open(userDataDir: string, options: { pinStore?: PinEnrollment; references?: RemoteHostReferences; referenceRegistry?: RemoteHostReferenceRegistryView } = {}): Promise<RemoteHostStore> {
		if (typeof userDataDir !== "string" || !isAbsolute(userDataDir) || /[\x00-\x1f\x7f]/.test(userDataDir)) throw new Error("REMOTE_HOST_STORE_PATH_INVALID");
		const pinStore = options.pinStore ?? new SshHostPinStore(userDataDir);
		const references = resolveReferences(options);
		const state = await loadState(userDataDir, pinStore);
		await applyLockCheck(userDataDir, state);
		await pruneRetiredPins(userDataDir, state, pinStore);
		return new RemoteHostStore(userDataDir, pinStore, state, references);
	}

	/**
	 * Re-read the catalog from disk. A lock that another instance held (or a pin cleanup that was
	 * interrupted) must not poison this instance forever: callers retry through refresh() instead of
	 * being stuck with a needs-repair snapshot for the rest of the process lifetime.
	 */
	async refresh(): Promise<RemoteHostStoreState> {
		const state = await loadState(this.userDataDir, this.pinStore);
		await applyLockCheck(this.userDataDir, state);
		await pruneRetiredPins(this.userDataDir, state, this.pinStore);
		this.state = state;
		return this.getSnapshot();
	}

	/** Deep copy: the nested endpoint identity is trust metadata and must not be mutable by consumers. */
	getProfile(hostId: string): RemoteHostProfile | undefined {
		const profile = this.state.profiles.find((item) => item.id === hostId);
		if (profile === undefined) return undefined;
		return decodeRemoteHostSnapshot({ schemaVersion: 1, revision: 1, profiles: [profile], retiredHostIds: [] }).profiles[0];
	}

	/**
	 * Edit a never-verified draft in place. Every field of a verified or disabled profile is frozen
	 * (stricter than the endpoint quartet alone): once a pin exists, changing anything would either
	 * re-point a saved route digest or require a confirmation the user already gave for other values,
	 * so those hosts are retired and re-created instead.
	 */
	async updateDraft(hostId: string, patch: RemoteHostDraftPatch, expectedRevision: number): Promise<RemoteHostProfile> {
		if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("REMOTE_HOST_EDIT_INVALID");
		// Fail closed without a provider (design §4.1): re-pointing a draft changes what an existing
		// reference resolves to, so "we cannot prove there is no reference" must refuse just like retire.
		if (!this.references) throw new Error("REMOTE_HOST_REFERENCES_UNAVAILABLE");
		return this.mutate(expectedRevision, async (snapshot) => {
			const profile = snapshot.profiles.find((item) => item.id === hostId);
			if (!profile || profile.disabledAt || profile.verifiedEndpoint) throw new Error("REMOTE_HOST_EDIT_INVALID");
			// An in-flight pin offer was made for the current route; re-pointing the draft now would make
			// the upcoming confirmation attach a verified endpoint to a route nobody authenticated.
			if (this.pinStore.hasPendingOffer?.(hostId)) throw new Error("REMOTE_HOST_EDIT_INVALID");
			if (await this.isReferenced(hostId)) throw new Error("REMOTE_HOST_REFERENCED");
			const pick = <K extends keyof RemoteHostDraftPatch>(key: K, fallback: RemoteHostDraftPatch[K]): RemoteHostDraftPatch[K] => (Object.hasOwn(patch, key) ? patch[key] : fallback);
			const label = pick("label", profile.label);
			const sshHost = pick("sshHost", profile.sshHost);
			const user = pick("user", profile.user);
			const port = pick("port", profile.port);
			const proxyJump = pick("proxyJump", profile.proxyJump);
			const identityFile = pick("identityFile", profile.identityFile);
			const connectTimeoutMs = pick("connectTimeoutMs", profile.connectTimeoutMs);
			if (typeof label !== "string" || !label.trim() || label.length > 128 || /[\x00-\x1f\x7f]/.test(label)) throw new Error("REMOTE_HOST_EDIT_INVALID");
			if (typeof sshHost !== "string") throw new Error("REMOTE_HOST_EDIT_INVALID");
			if (identityFile !== undefined && (typeof identityFile !== "string" || !isAbsolute(identityFile) || /[\x00-\x1f\x7f]/.test(identityFile))) throw new Error("REMOTE_HOST_EDIT_INVALID");
			if (typeof connectTimeoutMs !== "number" || !Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1000 || connectTimeoutMs > 120_000) throw new Error("REMOTE_HOST_EDIT_INVALID");
			try {
				buildSshConfigQueryArgs({ sshHost, ...(user !== undefined ? { user } : {}), ...(port !== undefined ? { port } : {}), ...(proxyJump !== undefined ? { proxyJump } : {}) });
			} catch {
				throw new Error("REMOTE_HOST_EDIT_INVALID");
			}
			// Optional endpoint fields are rebuilt from scratch so clearing one (key present, value
			// undefined) really removes it instead of leaving the previous value behind.
			const { user: _previousUser, port: _previousPort, proxyJump: _previousProxyJump, identityFile: _previousIdentityFile, ...rest } = profile;
			const updated: RemoteHostProfile = {
				...rest,
				label,
				sshHost,
				connectTimeoutMs,
				updatedAt: new Date().toISOString(),
				...(user !== undefined ? { user } : {}),
				...(port !== undefined ? { port } : {}),
				...(proxyJump !== undefined ? { proxyJump } : {}),
				...(identityFile !== undefined ? { identityFile } : {}),
			};
			return { next: { ...snapshot, profiles: snapshot.profiles.map((item) => (item.id === hostId ? updated : item)) }, result: updated };
		});
	}

	/**
	 * Compress a disabled tombstone into a retired id. Requires a reference provider: without one the
	 * store cannot prove that no project/session still points at the host, and a silent hard delete
	 * would break those locators without any way to detect it.
	 */
	async retire(hostId: string, expectedRevision: number): Promise<string> {
		if (!this.references) throw new Error("REMOTE_HOST_REFERENCES_UNAVAILABLE");
		if (typeof this.pinStore.deletePin !== "function") throw new Error("REMOTE_HOST_PIN_CLEANUP_FAILED");
		const retired = await this.mutate(expectedRevision, async (snapshot) => {
			const profile = snapshot.profiles.find((item) => item.id === hostId);
			if (!profile || !profile.disabledAt) throw new Error("REMOTE_HOST_RETIRE_INVALID");
			if (await this.isReferenced(hostId)) throw new Error("REMOTE_HOST_REFERENCED");
			return {
				next: { ...snapshot, profiles: snapshot.profiles.filter((item) => item.id !== hostId), retiredHostIds: [...snapshot.retiredHostIds.filter((id) => id !== hostId), hostId] },
				result: hostId,
			};
		});
		// The pin is removed only after the snapshot committed: deleting it first would destroy the trust
		// anchor of a host that still exists whenever the commit fails. A leftover pin for a retired id is
		// tolerated by the loader and pruned on the next open, so this order is recoverable either way.
		try {
			await this.pinStore.deletePin?.(hostId);
		} catch {
			// Best effort; pruneRetiredPins retries on the next load.
		}
		return retired;
	}

	private async isReferenced(hostId: string): Promise<boolean> {
		const references = this.references;
		if (!references) throw new Error("REMOTE_HOST_REFERENCES_UNAVAILABLE");
		let ids: unknown;
		try {
			ids = await references.referencedHostIds();
		} catch (error) {
			// "The scan failed" must never be reported as "nothing is referenced": the caller has to be
			// able to tell a scan failure from a business rejection, and a provider's own error text or
			// errno must not cross this boundary. Registry codes are already stable, so they pass through.
			const code = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : undefined;
			if (code !== undefined && isHostReferenceRegistryCode(code)) throw new Error(code);
			throw new Error("REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE");
		}
		if (!hasReferenceSetShape(ids)) throw new Error("REMOTE_HOST_REFERENCE_SCAN_INCOMPLETE");
		return ids.has(hostId);
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
				// The offered route is read before answer() consumes the pending entry. The profile has to
				// still match it, otherwise the saved endpoint would belong to a route nobody confirmed.
				const offered = this.pinStore.pendingRoute?.(answer.hostId);
				if (offered && !sameRoute(offered, profile)) throw new Error("REMOTE_HOST_ACTIVATION_INVALID");
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

	/**
	 * Main-only repair write (design §4.5 / §6.2 A1, "completeActivationFromPin"): finish an activation
	 * whose pin was already published but whose profile was never committed, so the user's original host
	 * key confirmation is preserved instead of being thrown away. The pin is re-read under the store
	 * lock, exactly like `confirmPin`, which is what proves the endpoint still matches the pinned bytes.
	 * Only a `REMOTE_HOST_PIN_ORPHAN` store (the interrupted activation) may be written from here.
	 */
	async completeActivationFromPin(hostId: string, expectedRevision: number, endpoint: VerifiedSshEndpoint): Promise<RemoteHostProfile> {
		return this.mutateRepair(expectedRevision, ["REMOTE_HOST_PIN_ORPHAN"], async (snapshot) => {
			const profile = snapshot.profiles.find((item) => item.id === hostId);
			if (!profile || profile.disabledAt || profile.verifiedEndpoint) throw new Error("REMOTE_HOST_ACTIVATION_INVALID");
			try {
				await this.pinStore.readPin(hostId, endpoint);
			} catch {
				// Metadata that cannot be certified against the pinned bytes is not a trust anchor.
				throw new Error("REMOTE_HOST_PIN_INVALID");
			}
			const now = new Date().toISOString();
			const verified: RemoteHostProfile = { ...profile, verifiedEndpoint: { ...endpoint, hostKeyFingerprints: [...endpoint.hostKeyFingerprints] }, verifiedAt: now, updatedAt: now };
			return { next: { ...snapshot, profiles: snapshot.profiles.map((item) => (item.id === hostId ? verified : item)) }, result: verified };
		});
	}

	/**
	 * Main-only repair write (design §4.5 / §6.2 B, "forgetTrustAnchor"): drop an anchor that can no
	 * longer be used and keep the identity as a disabled tombstone. This only ever *lowers* trust: it
	 * never writes a verified endpoint, never removes the profile and never deletes the pin file. If the
	 * stored anchor still certifies against the pin, dropping it is refused outright.
	 */
	async forgetTrustAnchor(hostId: string, expectedRevision: number): Promise<RemoteHostProfile> {
		return this.mutateRepair(expectedRevision, ["REMOTE_HOST_PIN_INVALID"], async (snapshot) => {
			const profile = snapshot.profiles.find((item) => item.id === hostId);
			const endpoint = profile?.verifiedEndpoint;
			if (!profile || !endpoint) throw new Error("REMOTE_HOST_ACTIVATION_INVALID");
			let anchorUsable = true;
			try {
				await this.pinStore.readPin(hostId, endpoint);
			} catch {
				anchorUsable = false;
			}
			if (anchorUsable) throw new Error("REMOTE_HOST_ANCHOR_STILL_VALID");
			// `verifiedEndpoint` and `verifiedAt` are dropped together: the codec rejects a half pair.
			const { verifiedEndpoint: _previousEndpoint, verifiedAt: _previousVerifiedAt, ...rest } = profile;
			const now = new Date().toISOString();
			const downgraded: RemoteHostProfile = { ...rest, ...(profile.disabledAt === undefined ? { disabledAt: now } : {}), updatedAt: now };
			return { next: { ...snapshot, profiles: snapshot.profiles.map((item) => (item.id === hostId ? downgraded : item)) }, result: downgraded };
		});
	}

	/**
	 * Repair-only write path. Ordinary mutators refuse to run while the store needs repair (I9); a
	 * repair primitive is the narrow exception: it may commit exactly the transformation that removes
	 * the reason class it owns and nothing else. The allowance is evaluated against freshly loaded disk
	 * reasons, so a store broken for any other reason stays read-only (design Q7).
	 */
	private async mutateRepair<T>(expectedRevision: number, allowedReasons: readonly string[], change: (snapshot: DecodedRemoteHostSnapshot) => Promise<{ next: DecodedRemoteHostSnapshot; result: T; write?: boolean }>): Promise<T> {
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
			const disk = await loadState(this.userDataDir, this.pinStore);
			if (disk.reasons.some((reason) => !allowedReasons.includes(reason))) throw new Error("REMOTE_HOST_STORE_NEEDS_REPAIR");
			if (disk.revision !== expectedRevision || JSON.stringify(disk.profiles) !== JSON.stringify(this.state.profiles) || JSON.stringify(disk.retiredHostIds) !== JSON.stringify(this.state.retiredHostIds)) throw new Error("REMOTE_HOST_REVISION_CONFLICT");
			const { next, result, write } = await change(disk);
			if (write === false) return result;
			const encoded = encodeRemoteHostSnapshot(next.profiles, next.retiredHostIds, expectedRevision + 1);
			writeStarted = true;
			await writeDurableJsonFile(this.filePath, `${JSON.stringify(encoded, null, 2)}\n`, { backupPath: `${this.filePath}.bak`, backupFailurePolicy: "throw" });
			const checked = await loadState(this.userDataDir, this.pinStore);
			// A repair may legitimately leave reasons it does not own, so only the write landing is
			// asserted here — claiming "ready" would be exactly the silent-trust failure mode.
			if (checked.revision !== expectedRevision + 1) throw new Error("REMOTE_HOST_WRITE_UNCERTAIN");
			this.state = checked;
			return result;
		} catch (error) {
			if (writeStarted) {
				this.state = { ...this.state, status: "needs-repair", reasons: ["REMOTE_HOST_WRITE_UNCERTAIN"] };
				throw new Error("REMOTE_HOST_WRITE_UNCERTAIN");
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
