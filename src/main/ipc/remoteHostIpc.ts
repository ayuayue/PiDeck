import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteHostConnectResult, RemoteHostDiagnosticEntry, RemoteHostDiagnosticsResult, RemoteHostDisconnectResult, RemoteHostListResult, RemoteHostRepairSummary } from "../../shared/types/remoteHost";
import type { RemoteHostCatalogView } from "../remote/RemoteHostCatalogView";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";

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
 * Remote host IPC: listing (read-only catalog) plus the connection switch.
 *
 * `enabled` gates every channel, not just listing: with the experiment off the renderer cannot even
 * learn that a host exists, so there is nothing for a disabled build to leak. Listing starts no
 * process; `connect` is the only channel here that launches real SSH, and it runs through the same
 * verified bootstrap path the service owns.
 *
 * `service` is optional so the read-only catalog stays usable without a connection service (the
 * current dev-only assembly, and the catalog view's own tests). When it is absent, connect/disconnect
 * answer with a stable code instead of throwing.
 */
export function registerRemoteHostIpc(input: { enabled: boolean; list: () => Promise<RemoteHostCatalogView>; service?: () => RemoteHostConnectionService | undefined }): void {
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
}
