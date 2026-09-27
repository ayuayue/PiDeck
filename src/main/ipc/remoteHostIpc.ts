import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { ipcMain, type WebContents } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type {
	RemoteHostAddInput,
	RemoteHostAddResult,
	RemoteHostConfigScanResult,
	RemoteHostConnectResult,
	RemoteHostDiagnosticEntry,
	RemoteHostDiagnosticsResult,
	RemoteHostDisconnectResult,
	RemoteHostListResult,
	RemoteHostPinAnswerResult,
	RemoteHostPinRequest,
	RemoteHostRepairSummary,
} from "../../shared/types/remoteHost";
import type { RemoteHostCatalogView } from "../remote/RemoteHostCatalogView";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import { parseSshConfig } from "../remote/SshConfigCandidates";
import { RemoteHostStore } from "../remote/RemoteHostStore";
import { SshHostPinStore } from "../remote/SshHostPinStore";

const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPAIR_REASON = /^REMOTE_HOST_[A-Z0-9_]{1,64}$/;
const REPAIR_CLASSIFICATIONS: ReadonlySet<string> = new Set(["orphan-pin", "anchor-invalid", "lock", "snapshot", "write-uncertain", "unknown"]);
// Diagnostics are re-validated at this boundary rather than trusted: the service already builds them
// from enumerable values, but the renderer must never be the place a path or command could appear.
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const DIAGNOSTIC_STATES: ReadonlySet<string> = new Set(["disconnected", "connecting", "probing", "bootstrapping", "ready", "degraded", "reconnecting", "offline", "needs-attention"]);
const DIAGNOSTIC_PHASES: ReadonlySet<string> = new Set(["openssh", "authenticate", "platform", "node", "helper", "pi"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Bounded per request: a host with a long history must not turn one IPC call into an unbounded payload. */
const MAX_DIAGNOSTIC_ENTRIES = 200;
/** ssh config is a small text file; anything larger is not the file we mean to read. */
const MAX_SSH_CONFIG_BYTES = 1024 * 1024;
/** Host label is user-facing text shown in the sidebar; keep it bounded and free of control bytes. */
const MAX_LABEL = 128;
const HOST_NAME = /^[A-Za-z0-9._:[\]-]+$/;
const SAFE_USER = /^[A-Za-z0-9._@-]+$/;

/** Expose only stable codes and valid ids; no repair commands, pin paths or trust metadata cross IPC. */
function repairSummary(view: RemoteHostCatalogView): RemoteHostRepairSummary[] {
	return view.findings.map((finding) => ({
		reason: REPAIR_REASON.test(finding.reason) ? finding.reason : "REMOTE_HOST_DIAGNOSTIC_UNKNOWN",
		classification: REPAIR_CLASSIFICATIONS.has(finding.classification) ? finding.classification : "unknown",
		hostIds: finding.hostIds.filter((id) => HOST_ID.test(id)).slice(0, 2000),
	}));
}

/** Re-validate a service diagnostic before it reaches the renderer; anything unreadable is dropped. */
function diagnosticEntry(value: unknown): RemoteHostDiagnosticEntry | null {
	if (typeof value !== "object" || value === null) return null;
	const entry = value as { state?: unknown; phase?: unknown; code?: unknown; at?: unknown; exitCode?: unknown };
	if (typeof entry.state !== "string" || !DIAGNOSTIC_STATES.has(entry.state)) return null;
	if (typeof entry.phase !== "string" || !DIAGNOSTIC_PHASES.has(entry.phase)) return null;
	if (typeof entry.code !== "string" || !DIAGNOSTIC_CODE.test(entry.code)) return null;
	if (typeof entry.at !== "string" || !ISO.test(entry.at)) return null;
	const exitCode = entry.exitCode;
	if (exitCode !== undefined && (!Number.isSafeInteger(exitCode) || (exitCode as number) < -1 || (exitCode as number) > 255)) return null;
	return { state: entry.state as RemoteHostDiagnosticEntry["state"], phase: entry.phase as RemoteHostDiagnosticEntry["phase"], code: entry.code, at: entry.at, ...(exitCode === undefined ? {} : { exitCode: exitCode as number }) };
}

/**
 * Read `~/.ssh/config` for the add-host picker.
 *
 * Missing file is not an error: plenty of users have no config and will type the host by hand. Anything
 * else (permissions, a directory in its place, a huge file) is reported as a stable code so the UI can
 * fall back to manual entry and say why.
 */
async function scanSshConfig(): Promise<RemoteHostConfigScanResult> {
	const currentUser = safeCurrentUser();
	const path = join(homedir(), ".ssh", "config");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return { ok: true, candidates: [], skipped: [], user: currentUser };
		return { ok: false, code: "REMOTE_HOST_CONFIG_UNREADABLE" };
	}
	if (text.length > MAX_SSH_CONFIG_BYTES) return { ok: false, code: "REMOTE_HOST_CONFIG_TOO_LARGE" };
	const parsed = parseSshConfig(text);
	return { ok: true, candidates: parsed.candidates, skipped: parsed.skipped, user: currentUser };
}

/** The login user, used only as the displayed default when a config entry omits `User`. */
function safeCurrentUser(): string {
	try {
		return userInfo().username;
	} catch {
		return "";
	}
}

/**
 * Validate a manual add. Every field becomes part of SSH argv or a known_hosts alias, so it is checked
 * here rather than trusted: the renderer's form is a convenience, not a guarantee.
 */
function readAddInput(value: unknown): { label: string; hostName: string; user?: string; port?: number; identityFile?: string } | null {
	if (typeof value !== "object" || value === null) return null;
	const input = value as Record<string, unknown>;
	const label = typeof input.label === "string" ? input.label.trim() : "";
	const hostName = typeof input.hostName === "string" ? input.hostName.trim() : "";
	if (label.length === 0 || label.length > MAX_LABEL || /[\x00-\x1f\x7f]/.test(label)) return null;
	if (hostName.length === 0 || hostName.length > 1024 || !HOST_NAME.test(hostName)) return null;
	const user = typeof input.user === "string" ? input.user.trim() : "";
	if (user.length > 0 && (user.length > 256 || !SAFE_USER.test(user))) return null;
	const rawPort = input.port;
	let port: number | undefined;
	if (rawPort !== undefined && rawPort !== null && rawPort !== "") {
		const parsed = typeof rawPort === "number" ? rawPort : Number(rawPort);
		// A bad port is rejected rather than defaulted: silently using 22 would connect somewhere else.
		if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) return null;
		port = parsed;
	}
	const identityFile = typeof input.identityFile === "string" && input.identityFile.trim().length > 0 ? input.identityFile.trim() : undefined;
	if (identityFile !== undefined && (identityFile.length > 4096 || /[\x00-\x1f\x7f]/.test(identityFile))) return null;
	// `null` and "absent" both mean "use the default"; the store models absence as undefined, so collapse here
	// rather than letting a null reach it and be written as a literal.
	return { label, hostName, ...(user.length > 0 ? { user } : {}), ...(port === undefined ? {} : { port }), ...(identityFile === undefined ? {} : { identityFile }) };
}

/**
 * Remote host IPC: listing, the connection switch, and adding a host.
 *
 * `enabled` gates every channel: with the experiment off the renderer cannot even learn that a host
 * exists, so there is nothing for a disabled build to leak. Only `connect` launches SSH.
 *
 * `service` is optional so the read-only catalog stays usable without a connection service.
 */
export function registerRemoteHostIpc(input: { enabled: boolean; list: () => Promise<RemoteHostCatalogView>; service?: () => RemoteHostConnectionService | undefined; userDataDir: string }): void {
	const guard = <T>(fallback: () => T): T | undefined => (input.enabled ? undefined : fallback());

	ipcMain.handle(ipcChannels.remoteHostsList, async (): Promise<RemoteHostListResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		try {
			const view = await input.list();
			const snapshot = view.snapshot;
			return {
				ok: true,
				status: snapshot.status,
				hosts: snapshot.profiles.map(({ id, label, sshHost, verifiedEndpoint, disabledAt }) => ({ id, label, sshHost, verified: verifiedEndpoint !== undefined, disabled: disabledAt !== undefined })),
				...(snapshot.status === "needs-repair" ? { repair: repairSummary(view) } : {}),
			};
		} catch {
			return { ok: false, code: "REMOTE_HOST_LIST_UNAVAILABLE" };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostConnect, async (_event, hostId: unknown): Promise<RemoteHostConnectResult> => {
		// Renderer input is never trusted: validate at the boundary before any process can start.
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return { ok: false, hostId: typeof hostId === "string" ? hostId : "", code: "REMOTE_CONNECTION_HOST_ID_INVALID" };
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		const service = input.service?.();
		if (service === undefined) return { ok: false, hostId, code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" };
		try {
			// The service already converts every failure into a stable code; it never throws here.
			const result = await service.connect(hostId);
			// Reduce the machine snapshot to the state the UI actually renders: generation, attempts and the
			// latched flag are main-internal and would invite the renderer to reason about fencing it cannot
			// observe. Diagnostics carry the detail the UI is allowed to show.
			return result.ok ? { ok: true, hostId: result.hostId, state: result.state.state } : { ok: false, hostId: result.hostId, code: result.code };
		} catch {
			return { ok: false, hostId, code: "REMOTE_CONNECTION_FAILED" };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostDisconnect, async (_event, hostId: unknown): Promise<RemoteHostDisconnectResult> => {
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return { ok: false, hostId: typeof hostId === "string" ? hostId : "", code: "REMOTE_CONNECTION_HOST_ID_INVALID" };
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		const service = input.service?.();
		if (service === undefined) return { ok: false, hostId, code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" };
		try {
			await service.disconnect(hostId, "shutdown");
			return { ok: true, hostId };
		} catch {
			return { ok: false, hostId, code: "REMOTE_CONNECTION_FAILED" };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostDiagnostics, async (_event, hostId: unknown): Promise<RemoteHostDiagnosticsResult> => {
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return { ok: false, hostId: typeof hostId === "string" ? hostId : "", code: "REMOTE_CONNECTION_HOST_ID_INVALID" };
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		const service = input.service?.();
		if (service === undefined) return { ok: false, hostId, code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" };
		try {
			const entries = service
				.listDiagnostics(hostId)
				.slice(-MAX_DIAGNOSTIC_ENTRIES)
				.map(diagnosticEntry)
				.filter((entry): entry is RemoteHostDiagnosticEntry => entry !== null);
			return { ok: true, hostId, entries };
		} catch {
			return { ok: false, hostId, code: "REMOTE_CONNECTION_FAILED" };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostScanConfig, async (): Promise<RemoteHostConfigScanResult> => {
		const disabled = guard<RemoteHostConfigScanResult>(() => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }));
		if (disabled !== undefined) return disabled;
		try {
			return await scanSshConfig();
		} catch {
			return { ok: false, code: "REMOTE_HOST_CONFIG_UNREADABLE" };
		}
	});

	/**
	 * Add a host: create the draft, then publish a fingerprint confirmation for the user to answer.
	 *
	 * The pin offer is started from *this* handler using the caller's `webContents.id` as the broker's
	 * sender binding, never a renderer-supplied id. The draft is created first so the offer has a subject;
	 * if the offer then fails, the draft is left in place rather than deleted, because a partially written
	 * store is worse than an unverified draft the user can retry or retire.
	 */
	ipcMain.handle(ipcChannels.remoteHostAdd, async (event, value: unknown): Promise<RemoteHostAddResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const parsed = readAddInput(value);
		if (parsed === null) return { ok: false, code: "REMOTE_HOST_ADD_INVALID" };
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_HOST_ADD_INVALID" };
		let store: Awaited<ReturnType<typeof RemoteHostStore.open>> | undefined;
		let pinStore: SshHostPinStore | undefined;
		try {
			pinStore = new SshHostPinStore(input.userDataDir);
			store = await RemoteHostStore.open(input.userDataDir, { pinStore });
			const revision = store.getSnapshot().revision;
			const profile = await store.createDraft(
				{ label: parsed.label, sshHost: parsed.hostName, connectTimeoutMs: 10_000, ...(parsed.user === undefined ? {} : { user: parsed.user }), ...(parsed.port === undefined ? {} : { port: parsed.port }), ...(parsed.identityFile === undefined ? {} : { identityFile: parsed.identityFile }) },
				revision,
			);
			const offer = await store.offerPin(profile.id, senderId, revision);
			// Push the confirmation to the window that asked, so the dialog cannot be answered by another.
			if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.remoteHostPinRequest, pinRequestFrom(offer));
			return { ok: true, hostId: profile.id, status: "pending" };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_ADD_FAILED") };
		} finally {
			pinStore?.dispose();
		}
	});

	/**
	 * Answer a fingerprint confirmation.
	 *
	 * The `senderId` binding is what makes this safe: the broker only accepts an answer from the window
	 * that was shown the fingerprint, and the answer carries just a `choice` — the endpoint itself is
	 * main-owned payload the renderer never sees or supplies.
	 */
	ipcMain.handle(ipcChannels.remoteHostAnswerPin, async (event, requestId: unknown, hostId: unknown, choice: unknown): Promise<RemoteHostPinAnswerResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return { ok: false, code: "REMOTE_HOST_PIN_ANSWER_INVALID" };
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return { ok: false, code: "REMOTE_HOST_PIN_ANSWER_INVALID" };
		if (choice !== "approve" && choice !== "deny") return { ok: false, code: "REMOTE_HOST_PIN_ANSWER_INVALID" };
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_HOST_PIN_ANSWER_INVALID" };
		let pinStore: SshHostPinStore | undefined;
		try {
			pinStore = new SshHostPinStore(input.userDataDir);
			const store = await RemoteHostStore.open(input.userDataDir, { pinStore });
			const revision = store.getSnapshot().revision;
			const confirmed = await store.confirmPin({ requestId, hostId, senderId, choice }, revision);
			// `null` means the user denied: the pin is not saved and the draft stays unverified, which is a
			// deliberate outcome rather than a failure.
			return { ok: true, hostId, approved: confirmed !== null };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_PIN_ANSWER_FAILED") };
		} finally {
			pinStore?.dispose();
		}
	});
}

/** The broker keys on a positive integer sender; `webContents.id` is exactly that. */
function senderIdOf(sender: WebContents): number | undefined {
	const id = sender?.id;
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function pinRequestFrom(offer: { requestId: string; expiresAt: number; hostId: string; hostName: string; user: string; port: number; hostKeyFingerprints: string[] }): RemoteHostPinRequest {
	return { requestId: offer.requestId, expiresAt: offer.expiresAt, hostId: offer.hostId, hostName: offer.hostName, user: offer.user, port: offer.port, hostKeyFingerprints: [...offer.hostKeyFingerprints] };
}

/**
 * Map a thrown store/pin error to a stable code. Only messages that are already a bare code survive;
 * anything else collapses to the fallback so no path or command line can reach the renderer.
 */
function codeOf(error: unknown, fallback: string): string {
	const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
	return typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : fallback;
}
