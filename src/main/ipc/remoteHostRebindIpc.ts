/**
 * Rebind IPC (design `docs/rebind-ui-design.md` §3.2 / §4, step 3 of the appendix A order).
 *
 * Four channels, no generic bridge:
 * - `remote:rebind-plan`    read-only pre-check; returns counts + a one-shot confirmation id;
 * - `remote:rebind-answer`  approves (runs) or denies that confirmation; never runs without it;
 * - `remote:rebind-describe` read-only journal banner state;
 * - `remote:rebind-resume`  idempotent convergence of a leftover journal.
 *
 * Boundaries enforced here, not in the renderer:
 * - only stable codes cross the wire; journal `txId`, record ids, locators and paths never do;
 * - the approved state digest is recomputed from the *current* plan, so a host edit between preview
 *   and approval surfaces as `CONFIRMATION_CHANGED` instead of running on a state nobody saw;
 * - the confirmation is main-only and single-use (`PendingConfirmationBroker`, 60s TTL);
 * - a denied or expired confirmation runs nothing (F2: there is no cancel after approval).
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteHostRebindAnswerResult, RemoteHostRebindDescribeResult, RemoteHostRebindOutcome, RemoteHostRebindPlanResult, RemoteHostRebindResumeResult } from "../../shared/types/remoteHost";
import { HostRebindJournal, type HostRebindStorePort, type RebindJournal, type RebindOutcome } from "../remote/HostRebindJournal";
import { createHostRebindCoordinator } from "../remote/HostRebindCoordinator";
import { createRemoteHostRebindPorts } from "../remote/RemoteHostRebindPorts";
import { createRemoteHostReferenceRegistry } from "../remote/RemoteHostReferenceSources";
import { acquireRebindTxLock, classifyRebindTxLockOwner, currentBootId, defaultIsProcessAlive } from "../remote/HostRebindTxLock";
import type { RemoteHostStore } from "../remote/RemoteHostStore";
import type { SshHostPinStore } from "../remote/SshHostPinStore";
import { readStoreFileLockState } from "../persistence/StoreFileLock";
import { PendingConfirmationBroker } from "../security/PendingConfirmationBroker";
import { HOST_ID, codeOf, senderIdOf } from "./remoteHostInputValidation";

const CONFIRMATION_TTL_MS = 60_000;

/** The digest binds the preview the user saw: pair + host revision + every record's current locator. */
function rebindDigest(journal: RebindJournal): string {
	const canonical = JSON.stringify({
		source: journal.source.hostId,
		target: journal.target.hostId,
		revision: journal.expectedHostRevision,
		records: journal.records.map((record) => [record.store, record.recordId, record.beforeLocator]),
	});
	return createHash("sha256").update(canonical).digest("hex");
}

/** Terminal outcome projection: stable fields only (the journal's txId and record ids stay in main). */
function projectOutcome(outcome: RebindOutcome): RemoteHostRebindOutcome {
	return {
		code: outcome.code,
		stage: outcome.stage,
		migratedProjects: outcome.migratedProjects,
		migratedSessions: outcome.migratedSessions,
		sourceRetired: outcome.sourceRetired,
		warnings: [...outcome.warnings],
	};
}

function hostIdOf(value: unknown): string | undefined {
	return typeof value === "string" && HOST_ID.test(value) ? value : undefined;
}

export type RemoteHostRebindIpcInput = {
	enabled: boolean;
	userDataDir: string;
	/** The host store/pin pair `remoteHostIpc` already owns; opening a second one would be two writers. */
	openStores: () => Promise<{ store: RemoteHostStore; pinStore: SshHostPinStore }>;
	/** Durable reference stores; `undefined` means the app has not opened them yet (fail closed). */
	projectStore: () => HostRebindStorePort | undefined;
	sessionCatalog: () => HostRebindStorePort | undefined;
	/** §5.5: disconnect the source before the tx starts; failures are the caller's problem, not a silent skip. */
	disconnect?: (hostId: string) => Promise<void>;
	registerCleanup?: (cleanup: () => Promise<void>) => void;
};

export function registerRemoteHostRebindIpc(input: RemoteHostRebindIpcInput): { resumePendingAtStartup: () => Promise<void> } {
	const journal = new HostRebindJournal({ userDataDir: input.userDataDir });
	const registry = createRemoteHostReferenceRegistry(join(input.userDataDir, "session-catalog.json"), join(input.userDataDir, "projects.json"));
	const broker = new PendingConfirmationBroker<{ sourceHostId: string; targetHostId: string }>({ ttlMs: CONFIRMATION_TTL_MS });
	const pending = new Map<string, { sourceHostId: string; targetHostId: string }>();
	input.registerCleanup?.(async () => {
		broker.dispose();
		pending.clear();
	});

	const probe = () => ({ pid: process.pid, bootId: currentBootId(), isProcessAlive: defaultIsProcessAlive });

	/** Coordinator over the live stores. Built per call: the stores are opened lazily by `remoteHostIpc`. */
	const coordinatorFor = async () => {
		const { store, pinStore } = await input.openStores();
		const ports = createRemoteHostRebindPorts({ store, pinStore, registry, projects: input.projectStore(), sessions: input.sessionCatalog() });
		return createHostRebindCoordinator({
			host: ports.host,
			projects: ports.projects,
			sessions: ports.sessions,
			listHostRecords: ports.listHostRecords,
			acquireLock: () =>
				acquireRebindTxLock({
					userDataDir: input.userDataDir,
					lockPath: journal.lockFilePath(),
					bootId: currentBootId(),
					isProcessAlive: defaultIsProcessAlive,
					now: Date.now,
				}),
			lockState: async () => {
				const state = await readStoreFileLockState(journal.lockFilePath());
				if (state.kind === "missing") return "missing";
				if (state.kind === "unreadable") return "unreadable";
				return classifyRebindTxLockOwner(state.owner, probe()) === "live" ? "live" : "stale";
			},
			readJournal: () => journal.read(),
			writeJournal: (next) => journal.write(next),
			removeJournal: () => journal.remove(),
			resumePending: (portsArg) => journal.resume(portsArg),
		});
	};

	ipcMain.handle(ipcChannels.remoteHostRebindPlan, async (event, sourceValue: unknown, targetValue: unknown): Promise<RemoteHostRebindPlanResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const senderId = senderIdOf(event.sender);
		const sourceHostId = hostIdOf(sourceValue);
		const targetHostId = hostIdOf(targetValue);
		if (senderId === undefined || sourceHostId === undefined || targetHostId === undefined) return { ok: false, code: "REMOTE_HOST_REBIND_INPUT_INVALID" };
		try {
			const coordinator = await coordinatorFor();
			const { summary, journal: planned } = await coordinator.plan(sourceHostId, targetHostId);
			const { requestId, expiresAt } = broker.begin({
				senderId,
				action: "rebind",
				// The pair is the subject: a confirmation for A→B must not answer A→C.
				subjectId: `${sourceHostId}:${targetHostId}`,
				stateDigest: rebindDigest(planned),
				payload: { sourceHostId, targetHostId },
			});
			pending.set(requestId, { sourceHostId, targetHostId });
			return {
				ok: true,
				summary: {
					sourceHostId: summary.source.hostId,
					targetHostId: summary.target.hostId,
					records: summary.records,
					referenceScan: summary.referenceScan,
					warnings: [...summary.warnings],
					tx: summary.tx,
				},
				requestId,
				expiresAt,
			};
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME") };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostRebindAnswer, async (event, requestId: unknown, choice: unknown): Promise<RemoteHostRebindAnswerResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined || typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return { ok: false, code: "REMOTE_HOST_REBIND_ANSWER_INVALID" };
		if (choice !== "approve" && choice !== "deny") return { ok: false, code: "REMOTE_HOST_REBIND_ANSWER_INVALID" };
		const offered = pending.get(requestId);
		if (offered === undefined) return { ok: false, code: "HOST_REBIND_CONFIRMATION_REQUIRED" };
		try {
			const coordinator = await coordinatorFor();
			// Re-plan first: the digest handed to the broker is the *current* state. If the pair moved
			// (revision, records, anchors) the broker reports CONFIRMATION_CHANGED and nothing runs.
			const { journal: current } = await coordinator.plan(offered.sourceHostId, offered.targetHostId);
			const payload = broker.answer({
				requestId,
				senderId,
				action: "rebind",
				subjectId: `${offered.sourceHostId}:${offered.targetHostId}`,
				stateDigest: rebindDigest(current),
				choice,
			});
			pending.delete(requestId);
			if (payload === null) return { ok: true, ran: false };
			// §5.5: the source must not stay connected while its references move. Disconnect failures are
			// surfaced (the tx has not written anything yet), never swallowed.
			if (input.disconnect !== undefined) await input.disconnect(payload.sourceHostId);
			const outcome = await coordinator.rebind(payload.sourceHostId, payload.targetHostId);
			return { ok: true, ran: true, outcome: projectOutcome(outcome) };
		} catch (error) {
			pending.delete(requestId);
			return { ok: false, code: codeOf(error, "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME") };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostRebindDescribe, async (): Promise<RemoteHostRebindDescribeResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		try {
			const coordinator = await coordinatorFor();
			const described = await coordinator.describePending();
			if (!described.present) return { ok: true, pending: { present: false, tx: described.tx } };
			return {
				ok: true,
				pending: {
					present: true,
					tx: described.tx,
					stage: described.stage,
					sourceHostId: described.sourceHostId,
					targetHostId: described.targetHostId,
					records: described.records,
					referenceScan: described.referenceScan,
				},
			};
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME") };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostRebindResume, async (): Promise<RemoteHostRebindResumeResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		try {
			const coordinator = await coordinatorFor();
			const outcome = await coordinator.resumePendingRebind();
			return outcome === undefined ? { ok: true, resumed: false } : { ok: true, resumed: true, outcome: projectOutcome(outcome) };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_REBIND_UNKNOWN_OUTCOME") };
		}
	});

	return {
		/**
		 * 启动时自动收敛一次（设计 Q8）。失败不抛：journal 还在，横幅会继续显示，
		 * 用户可以在设置页手动「继续收敛」；启动路径不该被一笔未完成的迁移挡住。
		 */
		async resumePendingAtStartup(): Promise<void> {
			if (!input.enabled) return;
			try {
				const coordinator = await coordinatorFor();
				await coordinator.resumePendingRebind();
			} catch {
				// 留待横幅 + 手动收敛。
			}
		},
	};
}
