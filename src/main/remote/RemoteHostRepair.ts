/**
 * Main-only repair primitives for a host store stuck in `needs-repair`
 * (`docs/remote-host-cross-store-design.md` §4.5 and §6).
 *
 * Three hard rules from §6.1 shape every primitive here:
 * 1. never delete a trust anchor: a pin may only go away when no profile claims it (orphan) or its
 *    profile is already retired;
 * 2. never trust a new endpoint silently: nothing here writes a `verifiedEndpoint` that was not
 *    re-authenticated against the bytes of an already published pin, and `forgetTrustAnchor` only
 *    ever lowers trust;
 * 3. the JSON files are never edited by hand: every mutation goes through the store (lock + CAS +
 *    codec validation), and the store's repair write path only permits the single reason class the
 *    primitive owns (§4.5 `HOST_REPAIR_STORE_NOT_READY` otherwise).
 *
 * Failure semantics: every failure leaves as a `HOST_REPAIR_*` code from `HOST_REPAIR_CODES`; store
 * codes are mapped onto that vocabulary so no errno, path or provider text can cross the boundary.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { currentBootId } from "./HostRebindJournal";
import type { SshDraftRoute } from "./SshCommandBuilder";
import type { SshDraftHostCandidate } from "./SshHostVerifier";
import { fingerprintSshHostKey, readBoundedHostKey } from "./SshHostVerifier";
import type { VerifiedSshEndpoint } from "./SshHostPinStore";
import type { RemoteHostProfile } from "./RemoteHostStoreCodec";
import { isRemoteHostStoreCode } from "./RemoteHostStore";

export type RepairConfirmation = { readonly requestId: string; readonly senderId: number };

/** Compact, non-sensitive projection of a profile (id/label are already user-visible identity). */
export type HostProfileSummary = { readonly id: string; readonly label: string; readonly verified: boolean; readonly disabled: boolean; readonly revision: number };

export type HostRepairClassification = "orphan-pin" | "anchor-invalid" | "lock" | "snapshot" | "write-uncertain" | "unknown";

export type HostRepairAction = "complete-activation-from-pin" | "discard-orphan-pin" | "clear-stale-lock" | "rebuild-target-and-rebind" | "forget-trust-anchor" | "inspect-snapshot-pair" | "refresh-then-recheck" | "fix-filesystem-permissions" | "human-review";

/** Diagnosis output: reason → classification → the actions that are legal for it. Never writes. */
export type HostRepairFinding = { readonly reason: string; readonly classification: HostRepairClassification; readonly hostIds: readonly string[]; readonly actions: readonly HostRepairAction[] };

/** Structural view of the host store; `RemoteHostStore` satisfies it without extra glue. */
export type HostRepairStorePort = {
	getSnapshot(): { readonly status: "ready" | "needs-repair"; readonly reasons: readonly string[]; readonly revision: number; readonly profiles: readonly RemoteHostProfile[]; readonly retiredHostIds: readonly string[] };
	getProfile(hostId: string): RemoteHostProfile | undefined;
	refresh(): Promise<unknown>;
	/** Repair write A1: commit the verified endpoint of an activation whose pin was already published. */
	completeActivationFromPin(hostId: string, expectedRevision: number, endpoint: VerifiedSshEndpoint): Promise<RemoteHostProfile>;
	/** Repair write B: drop an unusable anchor, keeping the identity as a disabled tombstone. */
	forgetTrustAnchor(hostId: string, expectedRevision: number): Promise<RemoteHostProfile>;
};

/** Pin access. `verifyRoute` is the re-authentication the A1 path needs (the pin store keeps its verifier private). */
export type HostRepairPinPort = {
	verifyRoute(route: SshDraftRoute, pinAlias: string): Promise<SshDraftHostCandidate>;
	/** Validate an existing pin against a verified endpoint; throws `SSH_HOST_PIN_INVALID` when unusable. */
	readPin(hostId: string, endpoint: VerifiedSshEndpoint): Promise<unknown>;
	/** Delete a pin that no profile claims any more. */
	deletePin(hostId: string): Promise<void>;
};

export type RemoteHostRepairOptions = {
	userDataDir: string;
	store: HostRepairStorePort;
	pins: HostRepairPinPort;
	/** Path overrides; defaults mirror `SshHostPinStore` (`<userDataDir>/ssh-host-keys`) and `RemoteHostStore` (`<userDataDir>/remote-hosts.json.lock`). */
	paths?: { readonly pinRoot?: string; readonly hostLockFile?: string };
	/** A lock file without owner metadata may only be cleared once it is at least this old. */
	lockAgeMs?: number;
	now?: () => number;
	isProcessAlive?: (pid: number) => boolean;
	/** Current boot identity; an owner from another boot proves pid reuse (design §5.1 R6). */
	bootId?: string;
};

/** Stable codes owned by this module. Nothing else may leave it. */
export const HOST_REPAIR_CODES = [
	"HOST_REPAIR_CONFIRMATION_REQUIRED",
	"HOST_REPAIR_NOT_APPLICABLE",
	"HOST_REPAIR_ANCHOR_STILL_VALID",
	"HOST_REPAIR_ANCHOR_UNREADABLE",
	"HOST_REPAIR_ANCHOR_MISMATCH",
	"HOST_REPAIR_ROUTE_UNVERIFIED",
	"HOST_REPAIR_LOCK_HELD",
	"HOST_REPAIR_LOCK_UNREADABLE",
	"HOST_REPAIR_STORE_NOT_READY",
	"HOST_REPAIR_REVISION_CONFLICT",
	"HOST_REPAIR_WRITE_UNCERTAIN",
	"HOST_REPAIR_WRITE_FAILED",
	"HOST_REPAIR_PIN_CLEANUP_FAILED",
	"HOST_REPAIR_HOST_ID_INVALID",
	"HOST_REPAIR_REVISION_INVALID",
	"HOST_REPAIR_OBSERVER_PID_INVALID",
] as const;

export type HostRepairCode = (typeof HOST_REPAIR_CODES)[number];

const HOST_REPAIR_CODE_SET: ReadonlySet<string> = new Set(HOST_REPAIR_CODES);

export function isHostRepairCode(code: string): code is HostRepairCode {
	return HOST_REPAIR_CODE_SET.has(code);
}

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_LOCK_AGE_MS = 120_000;
const MAX_PIN_NAMES = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function defaultIsProcessAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM still proves the pid exists; only ESRCH proves it is gone.
		return errorCode(error) !== "ESRCH";
	}
}

/**
 * Map store/pin failures onto this module's vocabulary. Store codes keep their meaning; anything else
 * (errno text, provider messages) collapses into one of our own codes.
 */
function mapStoreFailure(error: unknown): string {
	// Structural read of `message`: this module is loaded into its own VM realm by the Node test
	// harness, so `instanceof Error` would reject errors built by the caller's realm.
	const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : undefined;
	if (message === undefined) return "HOST_REPAIR_WRITE_FAILED";
	if (isHostRepairCode(message)) return message;
	if (!isRemoteHostStoreCode(message)) return "HOST_REPAIR_WRITE_FAILED";
	switch (message) {
		case "REMOTE_HOST_STORE_NEEDS_REPAIR":
			return "HOST_REPAIR_STORE_NOT_READY";
		case "REMOTE_HOST_STORE_BUSY":
			return "HOST_REPAIR_LOCK_HELD";
		case "REMOTE_HOST_REVISION_CONFLICT":
			return "HOST_REPAIR_REVISION_CONFLICT";
		case "REMOTE_HOST_WRITE_UNCERTAIN":
			return "HOST_REPAIR_WRITE_UNCERTAIN";
		case "REMOTE_HOST_ACTIVATION_INVALID":
			return "HOST_REPAIR_NOT_APPLICABLE";
		case "REMOTE_HOST_ANCHOR_STILL_VALID":
			return "HOST_REPAIR_ANCHOR_STILL_VALID";
		case "REMOTE_HOST_PIN_INVALID":
		case "SSH_HOST_PIN_INVALID":
			return "HOST_REPAIR_ANCHOR_UNREADABLE";
		default:
			return "HOST_REPAIR_WRITE_FAILED";
	}
}

type PinInspection = { readonly exists: boolean; readonly bytes?: Buffer };

/** Does the pin file still certify exactly the endpoint we are about to stop claiming? */
function pinCertifiesAnchor(bytes: Buffer, endpoint: VerifiedSshEndpoint): boolean {
	try {
		if (createHash("sha256").update(bytes).digest("hex") !== endpoint.knownHostsSha256) return false;
		return fingerprintSshHostKey(bytes, endpoint.pinAlias) === endpoint.hostKeyFingerprints[0];
	} catch {
		return false;
	}
}

/** The four §6.2 repair primitives plus a read-only diagnosis. Every mutation needs a confirmation. */
export class RemoteHostRepair {
	private readonly store: HostRepairStorePort;
	private readonly pins: HostRepairPinPort;
	private readonly pinRoot: string;
	private readonly lockPath: string;
	private readonly userDataDir: string;
	private readonly lockAgeMs: number;
	private readonly now: () => number;
	private readonly isProcessAlive: (pid: number) => boolean;
	private readonly bootId: string;

	constructor(options: RemoteHostRepairOptions) {
		if (typeof options?.userDataDir !== "string" || !isAbsolute(options.userDataDir) || /[\x00-\x1f\x7f]/.test(options.userDataDir)) throw new Error("HOST_REPAIR_WRITE_FAILED");
		if (!options.store || typeof options.store.getSnapshot !== "function" || typeof options.store.getProfile !== "function") throw new Error("HOST_REPAIR_STORE_NOT_READY");
		if (!options.pins || typeof options.pins.readPin !== "function" || typeof options.pins.deletePin !== "function" || typeof options.pins.verifyRoute !== "function") throw new Error("HOST_REPAIR_ANCHOR_UNREADABLE");
		this.userDataDir = options.userDataDir;
		this.pinRoot = options.paths?.pinRoot ?? join(options.userDataDir, "ssh-host-keys");
		this.lockPath = options.paths?.hostLockFile ?? join(options.userDataDir, "remote-hosts.json.lock");
		this.store = options.store;
		this.pins = options.pins;
		this.lockAgeMs = options.lockAgeMs ?? DEFAULT_LOCK_AGE_MS;
		this.now = options.now ?? Date.now;
		this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
		// Same derivation as the rebind tx lock, so "different boot id" really means "pid was reused".
		this.bootId = options.bootId ?? currentBootId();
	}

	/** Read-only triage: map the store's `needs-repair` reasons to the legal next actions. */
	async diagnose(): Promise<readonly HostRepairFinding[]> {
		const snapshot = this.store.getSnapshot();
		const findings: HostRepairFinding[] = [];
		for (const reason of [...new Set(snapshot.reasons)]) {
			switch (reason) {
				case "REMOTE_HOST_PIN_ORPHAN":
					findings.push({ reason, classification: "orphan-pin", hostIds: await this.orphanPinHostIds(snapshot.profiles, snapshot.retiredHostIds), actions: ["complete-activation-from-pin", "discard-orphan-pin"] });
					break;
				case "REMOTE_HOST_PIN_INVALID":
					findings.push({ reason, classification: "anchor-invalid", hostIds: await this.brokenAnchorHostIds(snapshot.profiles), actions: ["rebuild-target-and-rebind", "forget-trust-anchor", "fix-filesystem-permissions"] });
					break;
				case "REMOTE_HOST_LOCK_PRESENT":
					findings.push({ reason, classification: "lock", hostIds: [], actions: ["clear-stale-lock"] });
					break;
				case "REMOTE_HOST_LOCK_UNREADABLE":
					findings.push({ reason, classification: "lock", hostIds: [], actions: ["fix-filesystem-permissions"] });
					break;
				case "REMOTE_HOST_WRITE_UNCERTAIN":
				case "REMOTE_HOST_STATE_UNCERTAIN":
					// "Threw" does not mean "did not commit": refresh first, then decide (§6.2 E).
					findings.push({ reason, classification: "write-uncertain", hostIds: [], actions: ["refresh-then-recheck"] });
					break;
				case "REMOTE_HOST_SNAPSHOT_INVALID":
				case "REMOTE_HOST_PRIMARY_INVALID":
				case "REMOTE_HOST_PRIMARY_MISSING":
				case "REMOTE_HOST_BACKUP_INVALID":
				case "REMOTE_HOST_BACKUP_SELECTED":
				case "REMOTE_HOST_SNAPSHOT_CONFLICT":
					findings.push({ reason, classification: "snapshot", hostIds: [], actions: ["inspect-snapshot-pair", "human-review"] });
					break;
				default:
					findings.push({ reason, classification: "unknown", hostIds: [], actions: ["human-review"] });
			}
		}
		return findings;
	}

	/**
	 * A1 (§6.2 A): finish an interrupted activation using the pin that was already published. The live
	 * host is re-authenticated for the profile's current route and the candidate must equal the stored
	 * pin bytes, so the trust source stays the user's original host key confirmation.
	 */
	async completeActivationFromPin(hostId: string, expectedRevision: number, confirmation: RepairConfirmation): Promise<void> {
		assertHostId(hostId);
		assertRevision(expectedRevision);
		assertConfirmation(confirmation);
		this.assertCurrentRevision(expectedRevision);
		const profile = this.requireDraft(hostId);
		const pin = await this.inspectPin(hostId);
		if (!pin.exists || pin.bytes === undefined) throw new Error("HOST_REPAIR_NOT_APPLICABLE");
		const pinAlias = `pideck-${hostId}`;
		let candidate: SshDraftHostCandidate;
		try {
			candidate = await this.pins.verifyRoute(routeOf(profile), pinAlias);
		} catch {
			// Re-authentication failed: without a live candidate there is nothing to certify.
			throw new Error("HOST_REPAIR_ROUTE_UNVERIFIED");
		}
		if (candidate.pinAlias !== pinAlias || candidate.hostKeyFingerprints.length !== 1 || !pinCertifiesCandidate(pin.bytes, candidate)) throw new Error("HOST_REPAIR_ANCHOR_MISMATCH");
		const endpoint: VerifiedSshEndpoint = {
			hostName: candidate.hostName,
			user: candidate.user,
			port: candidate.port,
			pinAlias,
			routeDigest: candidate.routeDigest,
			knownHostsSha256: candidate.knownHostsSha256,
			hostKeyFingerprints: [...candidate.hostKeyFingerprints],
		};
		await this.writeStore(() => this.store.completeActivationFromPin(hostId, expectedRevision, endpoint));
		await this.refresh();
	}

	/**
	 * A2 (§6.2 A): delete the pin of an interrupted activation. Only legal when the profile is a draft
	 * that has never been verified — such a pin is not any profile's trust anchor, and re-activation
	 * still has to go through a fresh offer/confirm.
	 */
	async discardOrphanPin(hostId: string, confirmation: RepairConfirmation): Promise<void> {
		assertHostId(hostId);
		assertConfirmation(confirmation);
		this.requireDraft(hostId);
		const pin = await this.inspectPin(hostId);
		if (!pin.exists || pin.bytes === undefined) throw new Error("HOST_REPAIR_NOT_APPLICABLE");
		await this.deletePin(hostId);
		const after = await this.inspectPin(hostId);
		if (after.exists) throw new Error("HOST_REPAIR_PIN_CLEANUP_FAILED");
		await this.refresh();
	}

	/**
	 * C (§6.2 C): clear a host directory lock left behind by a crash. Only a provably dead owner (or a
	 * legacy lock that is old and shows no active write) may be removed; a live or unreadable owner is
	 * refused, because deleting a lock under an active writer creates two writers.
	 */
	async clearStaleHostLock(observerPid: number, confirmation: RepairConfirmation): Promise<void> {
		assertObserverPid(observerPid);
		assertConfirmation(confirmation);
		let stats: Awaited<ReturnType<typeof lstat>>;
		try {
			stats = await lstat(this.lockPath);
		} catch (error) {
			if (errorCode(error) === "ENOENT") throw new Error("HOST_REPAIR_NOT_APPLICABLE");
			throw new Error("HOST_REPAIR_LOCK_UNREADABLE");
		}
		const owner = await this.readLockOwner();
		if (owner !== undefined) {
			// Our own process obviously still runs; and an owner from this boot that is alive still holds it.
			if (owner.pid === observerPid) throw new Error("HOST_REPAIR_LOCK_HELD");
			if (owner.bootId === this.bootId && this.isProcessAlive(owner.pid)) throw new Error("HOST_REPAIR_LOCK_HELD");
		} else {
			// No owner metadata: fall back to age plus "is somebody writing right now" signals.
			if (await this.hasActiveWriteTemp()) throw new Error("HOST_REPAIR_LOCK_HELD");
			if (this.now() - stats.mtimeMs < this.lockAgeMs) throw new Error("HOST_REPAIR_LOCK_HELD");
		}
		try {
			await unlink(this.lockPath);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw new Error("HOST_REPAIR_WRITE_FAILED");
		}
		await this.refresh();
	}

	/**
	 * B (§6.2 B): declare an endpoint's trust anchor unusable and keep the identity as a disabled
	 * tombstone. Strictly a downgrade: no `verifiedEndpoint` is written, the profile and its id stay,
	 * and the pin file is never removed while it still certifies the anchor we are dropping.
	 */
	async forgetTrustAnchor(hostId: string, expectedRevision: number, confirmation: RepairConfirmation): Promise<HostProfileSummary> {
		assertHostId(hostId);
		assertRevision(expectedRevision);
		assertConfirmation(confirmation);
		this.assertCurrentRevision(expectedRevision);
		const snapshot = this.store.getSnapshot();
		const profile = snapshot.profiles.find((item) => item.id === hostId);
		const endpoint = profile?.verifiedEndpoint;
		if (!profile || !endpoint) throw new Error("HOST_REPAIR_NOT_APPLICABLE");
		let anchorUsable = true;
		try {
			await this.pins.readPin(hostId, endpoint);
		} catch {
			anchorUsable = false;
		}
		if (anchorUsable) throw new Error("HOST_REPAIR_ANCHOR_STILL_VALID");
		await this.writeStore(() => this.store.forgetTrustAnchor(hostId, expectedRevision));
		// After the downgrade no profile claims this pin. If it is readable and provably does not
		// certify the anchor we just dropped, leaving it behind would keep reporting PIN_ORPHAN and
		// block the retire step of the same repair path (§6.3 item 3). Unreadable pins are left alone:
		// without proof there is no safe deletion (INV-4).
		const pin = await this.inspectPin(hostId);
		if (pin.exists && pin.bytes !== undefined && !pinCertifiesAnchor(pin.bytes, endpoint)) await this.deletePin(hostId);
		await this.refresh();
		const fresh = this.store.getSnapshot();
		const updated = fresh.profiles.find((item) => item.id === hostId);
		if (!updated || updated.verifiedEndpoint !== undefined) throw new Error("HOST_REPAIR_WRITE_FAILED");
		return { id: updated.id, label: updated.label, verified: updated.verifiedEndpoint !== undefined, disabled: updated.disabledAt !== undefined, revision: fresh.revision };
	}

	/** A never-verified draft is the only profile shape the pin-only primitives may act on. */
	private requireDraft(hostId: string): RemoteHostProfile {
		const profile = this.store.getProfile(hostId);
		if (!profile || profile.verifiedEndpoint !== undefined || profile.disabledAt !== undefined) throw new Error("HOST_REPAIR_NOT_APPLICABLE");
		return profile;
	}

	/**
	 * Fail fast on a stale caller view. The store re-checks the revision under its lock (that check is
	 * the authoritative one); this only avoids re-authenticating a host for a write that cannot land.
	 */
	private assertCurrentRevision(expectedRevision: number): void {
		if (this.store.getSnapshot().revision !== expectedRevision) throw new Error("HOST_REPAIR_REVISION_CONFLICT");
	}

	private async writeStore<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			throw new Error(mapStoreFailure(error));
		}
	}

	private async refresh(): Promise<void> {
		try {
			await this.store.refresh();
		} catch {
			throw new Error("HOST_REPAIR_STORE_NOT_READY");
		}
	}

	private pinPath(hostId: string): string {
		return join(this.pinRoot, hostId);
	}

	/** Existence is checked separately from readability: "unreadable" must not look like "absent". */
	private async inspectPin(hostId: string): Promise<PinInspection> {
		try {
			const stats = await lstat(this.pinPath(hostId));
			if (!stats.isFile() || stats.isSymbolicLink()) return { exists: true };
		} catch (error) {
			if (errorCode(error) === "ENOENT") return { exists: false };
			throw new Error("HOST_REPAIR_ANCHOR_UNREADABLE");
		}
		try {
			return { exists: true, bytes: await readBoundedHostKey(this.pinPath(hostId)) };
		} catch {
			return { exists: true };
		}
	}

	private async deletePin(hostId: string): Promise<void> {
		try {
			await this.pins.deletePin(hostId);
		} catch (error) {
			const mapped = mapStoreFailure(error);
			throw new Error(mapped === "HOST_REPAIR_WRITE_FAILED" ? "HOST_REPAIR_PIN_CLEANUP_FAILED" : mapped);
		}
	}

	private async readLockOwner(): Promise<{ pid: number; bootId: string } | undefined> {
		let raw: string;
		try {
			const stats = await lstat(this.lockPath);
			if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0 || stats.size > 4096) return undefined;
			raw = await readFile(this.lockPath, "utf8");
		} catch {
			return undefined;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return undefined;
		}
		if (!isRecord(parsed) || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) < 1 || typeof parsed.bootId !== "string") return undefined;
		return { pid: Number(parsed.pid), bootId: parsed.bootId };
	}

	/** A recent `remote-hosts.json.<nonce>.tmp` means a writer is mid-commit right now. */
	private async hasActiveWriteTemp(): Promise<boolean> {
		let names: string[];
		try {
			names = await readdir(this.userDataDir);
		} catch {
			return true;
		}
		for (const name of names) {
			if (!/^remote-hosts\.json\..*\.tmp$/.test(name)) continue;
			try {
				const stats = await lstat(join(this.userDataDir, name));
				if (this.now() - stats.mtimeMs < this.lockAgeMs) return true;
			} catch {
				// Vanishing mid-scan is the normal cleanup path.
			}
		}
		return false;
	}

	private async orphanPinHostIds(profiles: readonly RemoteHostProfile[], retiredHostIds: readonly string[]): Promise<readonly string[]> {
		let names: string[];
		try {
			const stats = await lstat(this.pinRoot);
			if (!stats.isDirectory() || stats.isSymbolicLink()) return [];
			names = await readdir(this.pinRoot);
		} catch {
			return [];
		}
		if (names.length > MAX_PIN_NAMES) return [];
		const retired = new Set(retiredHostIds);
		const byId = new Map(profiles.map((profile) => [profile.id, profile]));
		const orphanIds: string[] = [];
		for (const name of names) {
			if (retired.has(name)) continue;
			if (byId.get(name)?.verifiedEndpoint !== undefined) continue;
			orphanIds.push(name);
		}
		return orphanIds.sort();
	}

	private async brokenAnchorHostIds(profiles: readonly RemoteHostProfile[]): Promise<readonly string[]> {
		const broken: string[] = [];
		for (const profile of profiles) {
			if (profile.verifiedEndpoint === undefined) continue;
			try {
				await this.pins.readPin(profile.id, profile.verifiedEndpoint);
			} catch {
				broken.push(profile.id);
			}
		}
		return broken.sort();
	}
}

function routeOf(profile: RemoteHostProfile): SshDraftRoute {
	return { sshHost: profile.sshHost, ...(profile.user !== undefined ? { user: profile.user } : {}), ...(profile.port !== undefined ? { port: profile.port } : {}), ...(profile.proxyJump !== undefined ? { proxyJump: profile.proxyJump } : {}) };
}

/** The candidate the live host just presented must equal the bytes of the already published pin. */
function pinCertifiesCandidate(bytes: Buffer, candidate: SshDraftHostCandidate): boolean {
	try {
		if (createHash("sha256").update(bytes).digest("hex") !== candidate.knownHostsSha256) return false;
		return fingerprintSshHostKey(bytes, candidate.pinAlias) === candidate.hostKeyFingerprints[0];
	} catch {
		return false;
	}
}

/**
 * Main-only confirmation gate (§4.5 / Q4). The broker binding (requestId ↔ digest ↔ sender) lives in
 * the caller; this primitive only refuses to run without a confirmation at all.
 */
function assertConfirmation(confirmation: RepairConfirmation): void {
	if (!isRecord(confirmation)) throw new Error("HOST_REPAIR_CONFIRMATION_REQUIRED");
	if (typeof confirmation.requestId !== "string" || confirmation.requestId.length === 0 || confirmation.requestId.length > 128 || /[\x00-\x1f\x7f]/.test(confirmation.requestId)) throw new Error("HOST_REPAIR_CONFIRMATION_REQUIRED");
	if (!Number.isSafeInteger(confirmation.senderId) || confirmation.senderId < 1) throw new Error("HOST_REPAIR_CONFIRMATION_REQUIRED");
}

/** Every primitive is name-scoped: none of them may touch a hostId other than the one given. */
function assertHostId(hostId: string): void {
	if (typeof hostId !== "string" || !HOST_ID.test(hostId)) throw new Error("HOST_REPAIR_HOST_ID_INVALID");
}

function assertRevision(expectedRevision: number): void {
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("HOST_REPAIR_REVISION_INVALID");
}

function assertObserverPid(observerPid: number): void {
	if (!Number.isSafeInteger(observerPid) || observerPid < 1) throw new Error("HOST_REPAIR_OBSERVER_PID_INVALID");
}
