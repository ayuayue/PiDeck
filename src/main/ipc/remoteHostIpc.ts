import { readdir, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { BrowserWindow, dialog, ipcMain, type WebContents } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { codeOf, HOST_ID, HOST_NAME, MAX_LABEL, SAFE_USER, senderIdOf } from "./remoteHostInputValidation";
import { registerRemoteHostEditIpc } from "./remoteHostEditIpc";
import { registerRemoteHostScanIpc } from "./remoteHostScanIpc";
import type {
	RemoteHostAddInput,
	RemoteHostAddResult,
	RemoteHostConfigScanResult,
	RemoteHostConnectResult,
	RemoteHostDiagnosticEntry,
	RemoteHostDiagnosticsResult,
	RemoteHostDisconnectResult,
	RemoteHostListResult,
	RemoteHostPickIdentityFileResult,
	RemoteHostRepairAnswerResult,
	RemoteHostRepairDiagnosisResult,
	RemoteHostRepairFinding,
	RemoteHostRepairRequest,
	RemoteHostRepairRunResult,
	RemoteDirectoryListResult,
	RemoteHostRemoveResult,
	RemoteHostEditDraftResult,
	RemoteHostUpdateResult,
	RemoteHostRepairSummary,
} from "../../shared/types/remoteHost";
import { openRemoteHostStoreForRetire, type RemoteHostCatalogView } from "../remote/RemoteHostCatalogView";
import { listRemoteDirectories } from "../remote/RemoteDirectoryListing";
import { RemoteHostRepair, type HostRepairAction } from "../remote/RemoteHostRepair";
import { PendingConfirmationBroker } from "../security/PendingConfirmationBroker";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import { parseSshConfig } from "../remote/SshConfigCandidates";
import { normalizeRemoteHostIdentityFile, REMOTE_HOST_IDENTITY_FILE_INVALID } from "../remote/RemoteHostIdentityFile";
import { RemoteHostStore } from "../remote/RemoteHostStore";
import { SshHostPinStore } from "../remote/SshHostPinStore";

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
/** Repair actions the UI may request. Anything else is refused before it can reach the repair module. */
const REPAIR_ACTIONS: ReadonlySet<string> = new Set(["complete-activation-from-pin", "discard-orphan-pin", "clear-stale-lock", "clear-rebind-lock", "forget-trust-anchor"]);

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
/**
 * Validate a manual add. Every field becomes part of SSH argv or a known_hosts alias, so it is checked
 * here rather than trusted: the renderer's form is a convenience, not a guarantee.
 */
type AddInput = { label: string; hostName: string; user?: string; port?: number; identityFile?: string; authMethod?: "password" };
type AddInputRead = { ok: true; input: AddInput } | { ok: false; code: string };

function readAddInput(value: unknown): AddInputRead {
	const invalid = (): AddInputRead => ({ ok: false, code: "REMOTE_HOST_ADD_INVALID" });
	if (typeof value !== "object" || value === null) return invalid();
	const input = value as Record<string, unknown>;
	const label = typeof input.label === "string" ? input.label.trim() : "";
	const hostName = typeof input.hostName === "string" ? input.hostName.trim() : "";
	if (label.length === 0 || label.length > MAX_LABEL || /[\x00-\x1f\x7f]/.test(label)) return invalid();
	if (hostName.length === 0 || hostName.length > 1024 || !HOST_NAME.test(hostName)) return invalid();
	const user = typeof input.user === "string" ? input.user.trim() : "";
	if (user.length > 0 && (user.length > 256 || !SAFE_USER.test(user))) return invalid();
	const rawPort = input.port;
	let port: number | undefined;
	if (rawPort !== undefined && rawPort !== null && rawPort !== "") {
		const parsed = typeof rawPort === "number" ? rawPort : Number(rawPort);
		// A bad port is rejected rather than defaulted: silently using 22 would connect somewhere else.
		if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) return invalid();
		port = parsed;
	}
	// F4（security review）：SSH config 里 `IdentityFile ~/.ssh/id_*` 是最常见形态，而 store 只接受本机
	// 绝对路径（`-i` 实参，不经过 shell，`~` 不会被展开）。展开/规范化是 main 的职责，且必须发生在
	// `createDraft` 之前——否则失败会以不透明的 `REMOTE_HOST_STORE_INVALID` 冒出来。
	// 「路径本身不合法」用独立稳定码，与「表单其它字段不合法」区分：这是真实配置形态，用户需要知道原因。
	const authMethod = input.authMethod === "password" ? "password" : undefined;
	const rawIdentityFile = typeof input.identityFile === "string" && input.identityFile.trim().length > 0 ? input.identityFile : undefined;
	let identityFile: string | undefined;
	if (rawIdentityFile !== undefined) {
		identityFile = normalizeRemoteHostIdentityFile(rawIdentityFile);
		if (identityFile === undefined) return { ok: false, code: REMOTE_HOST_IDENTITY_FILE_INVALID };
	}
	// `null` and "absent" both mean "use the default"; the store models absence as undefined, so collapse here
	// rather than letting a null reach it and be written as a literal.
	return { ok: true, input: { label, hostName, ...(user.length > 0 ? { user } : {}), ...(port === undefined ? {} : { port }), ...(identityFile === undefined ? {} : { identityFile }), ...(authMethod === undefined ? {} : { authMethod }) } };
}

/**
 * Remote host IPC: listing, the connection switch, and adding a host.
 *
 * `enabled` gates every channel: with the experiment off the renderer cannot even learn that a host
 * exists, so there is nothing for a disabled build to leak. Only `connect` launches SSH.
 *
 * `service` is optional so the read-only catalog stays usable without a connection service.
 */
export function registerRemoteHostIpc(input: {
	enabled: boolean;
	list: () => Promise<RemoteHostCatalogView>;
	service?: () => RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>;
	userDataDir: string;
	registerCleanup?: (cleanup: () => Promise<void>) => void;
	onHostRetired?: (hostId: string) => Promise<void>;
}): void {
	const guard = <T>(fallback: () => T): T | undefined => (input.enabled ? undefined : fallback());

	/**
	 * Long-lived pin store + host store pair, shared by the add and answer channels.
	 *
	 * These cannot be per-call: the fingerprint confirmation lives in the pin store's in-memory broker,
	 * so a store created for `remote:add` and disposed when that call returns loses the pending request
	 * before the user can answer it. Answering then failed with SSH_HOST_CONFIRMATION_INVALID even from
	 * the window that was shown the fingerprint. One instance for the process fixes that, and disposal
	 * moves to app quit alongside the other long-lived services.
	 */
	let stores: Promise<{ store: Awaited<ReturnType<typeof RemoteHostStore.open>>; pinStore: SshHostPinStore }> | undefined;
	const openStores = () => {
		stores ??= (async () => {
			const pinStore = new SshHostPinStore(input.userDataDir);
			const store = await RemoteHostStore.open(input.userDataDir, { pinStore });
			return { store, pinStore };
		})();
		// A failed open must not be cached: a store stuck in needs-repair can be fixed by hand, and the
		// next attempt should re-read rather than reuse the failure.
		stores.catch(() => {
			stores = undefined;
		});
		return stores;
	};
	/** Release the shared stores; called from the quit path so the broker's timers do not outlive the app. */
	const disposeStores = async (): Promise<void> => {
		const current = stores;
		stores = undefined;
		if (current === undefined) return;
		try {
			(await current).pinStore.dispose();
		} catch {
			// Nothing to clean up if the open itself failed.
		}
	};
	input.registerCleanup?.(disposeStores);

	/**
	 * Resolve the connection service, turning a discovery failure into a stable code.
	 *
	 * Building the service can fail on purpose: the SSH client is probed before it is trusted, and a
	 * missing or incapable client is a reportable condition rather than a crash. Letting that rejection
	 * escape produced an unhandled "Error invoking remote method" in the renderer, so every caller goes
	 * through here instead of awaiting the factory directly.
	 */
	const resolveService = async (): Promise<{ service: RemoteHostConnectionService } | { code: string }> => {
		try {
			const service = await input.service?.();
			return service === undefined ? { code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" } : { service };
		} catch (error) {
			return { code: codeOf(error, "REMOTE_CONNECTION_SERVICE_UNAVAILABLE") };
		}
	};

	// 扫描域只读 ~/.ssh，与 store/service 无关，独立注册。
	registerRemoteHostScanIpc({ enabled: input.enabled });
	// 编辑域与连接域共用同一份 store/service：拆分只影响文件大小，不影响实例数量。
	registerRemoteHostEditIpc({ enabled: input.enabled, openStores, resolveService });

	/**
	 * 移除连接：先中止/断开本次连接，再走 store 的 disable → retire。
	 *
	 * - retire 自带引用扫描：仍有项目/会话指向该主机时返回 REMOTE_HOST_REFERENCED，绝不硬删；
	 * - 远端数据一律不动（这里只退役本机 profile 与 host key pin）；
	 * - 关闭连接失败不拦移除：profile 退役后它也无法再被寻址。
	 */
	ipcMain.handle(ipcChannels.remoteHostRemove, async (_event, rawHostId: unknown): Promise<RemoteHostRemoveResult> => {
		const hostId = typeof rawHostId === "string" ? rawHostId : "";
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		if (!HOST_ID.test(hostId)) return { ok: false, hostId, code: "REMOTE_HOST_ID_INVALID" };
		const resolved = await resolveService();
		if ("service" in resolved) await resolved.service.disconnect(hostId, "shutdown").catch(() => undefined);
		let opened: Awaited<ReturnType<typeof openRemoteHostStoreForRetire>>;
		try {
			opened = await openRemoteHostStoreForRetire(input.userDataDir, input.onHostRetired === undefined ? {} : { onHostRetired: input.onHostRetired });
		} catch {
			return { ok: false, hostId, code: "REMOTE_HOST_STORE_UNAVAILABLE" };
		}
		try {
			let snapshot = opened.store.getSnapshot();
			if (snapshot.status !== "ready") return { ok: false, hostId, code: "REMOTE_HOST_STORE_NEEDS_REPAIR" };
			const profile = snapshot.profiles.find((item) => item.id === hostId);
			if (profile === undefined) return { ok: false, hostId, code: "REMOTE_HOST_NOT_FOUND" };
			if (profile.disabledAt === undefined) {
				await opened.store.disable(hostId, snapshot.revision);
				snapshot = opened.store.getSnapshot();
			}
			await opened.store.retire(hostId, snapshot.revision);
			// The stored secret belongs to the retired host id; a retired id is never reused, so drop it with it.
			if ("service" in resolved) await resolved.service.forgetHost(hostId).catch(() => undefined);
			return { ok: true, hostId };
		} catch (error) {
			return { ok: false, hostId, code: codeOf(error, "REMOTE_HOST_REMOVE_FAILED") };
		} finally {
			opened.dispose();
		}
	});

	/**
	 * 只读目录浏览（项目登记用）：`path` 缺省时从远端 `$HOME` 开始。
	 * 走与 canonical 探测同一套 pinned ssh 调用，不经过 helper 的 `--root`，也不返回任何文件内容。
	 */
	ipcMain.handle(ipcChannels.remoteHostListDirs, async (_event, rawHostId: unknown, rawPath: unknown): Promise<RemoteDirectoryListResult> => {
		const hostId = typeof rawHostId === "string" ? rawHostId : "";
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		if (!HOST_ID.test(hostId)) return { ok: false, hostId, code: "REMOTE_HOST_ID_INVALID" };
		if (rawPath !== undefined && typeof rawPath !== "string") return { ok: false, hostId, code: "REMOTE_LIST_DIRS_PATH_INVALID" };
		const resolved = await resolveService();
		if ("code" in resolved) return { ok: false, hostId, code: resolved.code };
		return listRemoteDirectories({ userDataDir: input.userDataDir, hostId, client: resolved.service.clientForHost(hostId), ...(rawPath === undefined ? {} : { path: rawPath }) });
	});

	ipcMain.handle(ipcChannels.remoteHostsList, async (): Promise<RemoteHostListResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		try {
			const view = await input.list();
			const snapshot = view.snapshot;
			// A view that remounts has no pushed events to replay, so the list carries the current state.
			// Resolving the service must not fail the list: without it every row simply falls back to
			// "disconnected", which is exactly what a host with no live manager is.
			const resolved = await resolveService().catch(() => ({ code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" }) as const);
			const states = "service" in resolved ? resolved.service.states() : {};
			return {
				ok: true,
				status: snapshot.status,
				hosts: snapshot.profiles.map(({ id, label, sshHost, verifiedEndpoint, disabledAt }) => ({ id, label, sshHost, verified: verifiedEndpoint !== undefined, disabled: disabledAt !== undefined })),
				...(Object.keys(states).length > 0 ? { states } : {}),
				...(snapshot.status === "needs-repair" ? { repair: repairSummary(view) } : {}),
			};
		} catch {
			return { ok: false, code: "REMOTE_HOST_LIST_UNAVAILABLE" };
		}
	});

	/**
	 * Native file picker for a private key. Only the absolute path crosses back to the renderer: nothing is read
	 * here and no passphrase is involved, so a cancelled dialog is an ordinary `ok: false` answer.
	 */
	/**
	 * Private keys a user is likely to pick, from the same `~/.ssh` directory on every platform.
	 *
	 * Only names are listed - files are never opened, so this cannot read a key or a passphrase. The filter is
	 * the convention shared by OpenSSH (`id_*`) and the common PEM/PPK exports; everything else (`*.pub`,
	 * `config`, `known_hosts*`, `authorized_keys*`) is not a private key a picker should offer.
	 */
	async function scanSshIdentityFiles(): Promise<string[]> {
		const directory = join(homedir(), ".ssh");
		const excluded = new Set(["config", "known_hosts", "known_hosts.old", "authorized_keys", "authorized_keys2", "environment", "rc"]);
		const found: string[] = [];
		try {
			const entries = await readdir(directory, { withFileTypes: true });
			for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
				const name = entry.name;
				if (!entry.isFile() || name.startsWith(".") || excluded.has(name) || name.endsWith(".pub")) continue;
				if (!name.startsWith("id_") && !/\.(pem|key|ppk)$/i.test(name)) continue;
				found.push(join(directory, name));
				if (found.length >= 32) break;
			}
		} catch {
			// No ~/.ssh (or it is unreadable): the config candidates and manual entry still work.
		}
		return found;
	}

	ipcMain.handle(ipcChannels.remoteHostPickIdentityFile, async (event): Promise<RemoteHostPickIdentityFileResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const window = BrowserWindow.fromWebContents(event.sender);
		const options = { title: "SSH 私钥", defaultPath: join(homedir(), ".ssh"), properties: ["openFile" as const] };
		const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
		const picked = result.filePaths[0];
		if (result.canceled || picked === undefined) return { ok: false, code: "REMOTE_HOST_IDENTITY_FILE_CANCELLED" };
		// The store only accepts a local absolute path; reject anything else at the boundary.
		if (!isAbsolute(picked) || /[ -]/.test(picked)) return { ok: false, code: "REMOTE_HOST_IDENTITY_FILE_INVALID" };
		return { ok: true, path: picked };
	});

	ipcMain.handle(ipcChannels.remoteHostConnect, async (_event, hostId: unknown, password?: unknown): Promise<RemoteHostConnectResult> => {
		// Renderer input is never trusted: validate at the boundary before any process can start.
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return { ok: false, hostId: typeof hostId === "string" ? hostId : "", code: "REMOTE_CONNECTION_HOST_ID_INVALID" };
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		if (password !== undefined && (typeof password !== "string" || password.length === 0 || password.length > 4096 || password.includes(String.fromCharCode(0)))) return { ok: false, hostId, code: "SSH_PASSWORD_INVALID" };
		const resolved = await resolveService();
		if ("code" in resolved) return { ok: false, hostId, code: resolved.code };
		try {
			// The service already converts every failure into a stable code; it never throws here.
			const result = await resolved.service.connect(hostId, password === undefined ? undefined : { password });
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
		const resolved = await resolveService();
		if ("code" in resolved) return { ok: false, hostId, code: resolved.code };
		try {
			await resolved.service.disconnect(hostId, "shutdown");
			return { ok: true, hostId };
		} catch {
			return { ok: false, hostId, code: "REMOTE_CONNECTION_FAILED" };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostDiagnostics, async (_event, hostId: unknown): Promise<RemoteHostDiagnosticsResult> => {
		if (typeof hostId !== "string" || !HOST_ID.test(hostId)) return { ok: false, hostId: typeof hostId === "string" ? hostId : "", code: "REMOTE_CONNECTION_HOST_ID_INVALID" };
		if (!input.enabled) return { ok: false, hostId, code: "REMOTE_FEATURE_DISABLED" };
		const resolved = await resolveService();
		if ("code" in resolved) return { ok: false, hostId, code: resolved.code };
		try {
			const entries = resolved.service
				.listDiagnostics(hostId)
				.slice(-MAX_DIAGNOSTIC_ENTRIES)
				.map(diagnosticEntry)
				.filter((entry): entry is RemoteHostDiagnosticEntry => entry !== null);
			return { ok: true, hostId, entries };
		} catch {
			return { ok: false, hostId, code: "REMOTE_CONNECTION_FAILED" };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostAdd, async (event, value: unknown): Promise<RemoteHostAddResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const parsed = readAddInput(value);
		if (!parsed.ok) return { ok: false, code: parsed.code };
		const add = parsed.input;
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_HOST_ADD_INVALID" };
		try {
			const { store } = await openStores();
			const revision = store.getSnapshot().revision;
			const profile = await store.createDraft(
				{
					label: add.label,
					sshHost: add.hostName,
					connectTimeoutMs: 10_000,
					...(add.user === undefined ? {} : { user: add.user }),
					...(add.port === undefined ? {} : { port: add.port }),
					...(add.identityFile === undefined ? {} : { identityFile: add.identityFile }),
					...(add.authMethod === undefined ? {} : { authMethod: add.authMethod }),
				},
				revision,
			);
			// `createDraft` is a CAS write, so the revision it committed under is already stale here.
			// `offerPin` validates against the *current* revision, so it has to be re-read after the write;
			// passing the pre-write value always fails as REMOTE_HOST_REVISION_CONFLICT. Same discipline the
			// connection service follows: read the revision after a write, never before one.
			const currentRevision = store.getSnapshot().revision;
			let offer: Awaited<ReturnType<typeof store.offerPin>>;
			try {
				offer = await store.offerPin(profile.id, senderId, currentRevision);
			} catch (error) {
				// The offer is where the real host verification happens (reachability, key mismatch), so it
				// is the step that actually fails in practice. The draft was created moments ago and holds no
				// trust anchor, so roll it back: leaving it behind is what produced a growing list of
				// unremovable "unverified" rows, one per failed attempt.
				await rollbackDraft(store, profile.id);
				throw error;
			}
			// 首次信任（TOFU）：主机密钥在这台机器上没有先例，`offerPin` 已经完成了真实握手并把候选
			// 密钥指纹算出来——再让用户逐字比对一串 SHA256 只是仪式，产品上等于「添加主机」多一步必点
			// 确认。这里直接按首次信任落盘（同 VSCode Remote / Codex 的默认策略），主机密钥**变化**
			// 时不走这条路径：已验证主机不再进 add，运行时连接由 pin 文件 + StrictHostKeyChecking=yes
			// 校验，密钥不符会以连接失败呈现，不会被静默接受。
			// 仍用 confirmPin（而不是直接写盘），因为 endpoint 的 route digest / known_hosts 校验都在它里面。
			const offerRevision = store.getSnapshot().revision;
			// confirmPin 失败（offer 过期/被取消/revision 冲突）和返回 null 同一个后果：没有信任锚。
			// 两种情况都必须回滚草稿，否则每失败一次就多一行永远未验证的空壳。
			let confirmed: unknown;
			try {
				confirmed = await store.confirmPin({ requestId: offer.requestId, hostId: profile.id, senderId, choice: "approve" }, offerRevision);
			} catch (error) {
				await rollbackDraft(store, profile.id);
				throw error;
			}
			if (!confirmed) {
				await rollbackDraft(store, profile.id);
				return { ok: false, code: "REMOTE_HOST_PIN_ANSWER_FAILED" };
			}
			return { ok: true, hostId: profile.id, status: "verified" };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_ADD_FAILED") };
		}
	});

	/**
	 * Repair confirmation state.
	 *
	 * The broker validates requestId + sender, but it does not hand the caller's own binding back on
	 * lookup, so the subject and the revision the user actually approved live here — the same pattern
	 * `SshHostPinStore` uses for the fingerprint flow. `onRemoved` keeps both in step when a request
	 * expires or is cancelled, so a stale entry cannot be answered later.
	 */
	const repairPending = new Map<string, { subjectId: string; digest: string; revision: number }>();
	const repairBroker = new PendingConfirmationBroker<{ action: HostRepairAction; hostId?: string }>({
		onRemoved: (requestId) => {
			repairPending.delete(requestId);
		},
	});
	const repairAction = "remote:host-repair";
	const repairDigest = (action: string, hostId: string | undefined, revision: number): string =>
		createHash("sha256")
			.update(JSON.stringify(["pideck-repair-v1", action, hostId ?? null, revision]), "utf8")
			.digest("hex");

	/** Build a write-capable repair facade over the shared stores. */
	const openRepair = async () => {
		const { store, pinStore } = await openStores();
		return {
			repair: new RemoteHostRepair({
				userDataDir: input.userDataDir,
				store,
				pins: {
					readPin: (hostId, endpoint) => pinStore.readPin(hostId, endpoint),
					deletePin: (hostId) => pinStore.deletePin(hostId),
					// The pin store keeps its verifier private; this is the re-authentication the A1 path needs.
					verifyRoute: (route, pinAlias) => pinStore.reverifyRoute(route, pinAlias),
				},
			}),
			store,
		};
	};

	ipcMain.handle(ipcChannels.remoteHostRepairDiagnose, async (): Promise<RemoteHostRepairDiagnosisResult> => {
		const disabled = guard<RemoteHostRepairDiagnosisResult>(() => ({ ok: false, code: "REMOTE_FEATURE_DISABLED" }));
		if (disabled !== undefined) return disabled;
		try {
			const { repair, store } = await openRepair();
			// A healthy store has nothing to diagnose: report an empty list rather than an error.
			if (store.getSnapshot().status === "ready") return { ok: true, findings: [] };
			const findings = await repair.diagnose();
			return { ok: true, findings: findings.map(findingFrom) };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_REPAIR_UNAVAILABLE") };
		}
	});

	/**
	 * Ask to run a repair. Validates, then publishes a confirmation instead of running: repairing writes
	 * the store or deletes a trust anchor, so it needs the user's explicit approval first.
	 */
	ipcMain.handle(ipcChannels.remoteHostRepairRun, async (event, action: unknown, hostIdValue: unknown): Promise<RemoteHostRepairRunResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		if (typeof action !== "string" || !REPAIR_ACTIONS.has(action)) return { ok: false, code: "REMOTE_HOST_REPAIR_ACTION_INVALID" };
		// Lock repair is host-independent by nature; every other action names exactly one host.
		let hostId: string | undefined;
		if (action !== "clear-stale-lock" && action !== "clear-rebind-lock") {
			if (typeof hostIdValue !== "string" || !HOST_ID.test(hostIdValue)) return { ok: false, code: "REMOTE_HOST_REPAIR_ACTION_INVALID" };
			hostId = hostIdValue;
		}
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_HOST_REPAIR_ACTION_INVALID" };
		try {
			const { repair, store } = await openRepair();
			const snapshot = store.getSnapshot();
			// Only actions the diagnosis actually authorised may be requested: the UI must not be able to
			// invent one, and a stale button must not run something the current state no longer allows.
			const findings = snapshot.status === "ready" ? [] : await repair.diagnose();
			const allowed = findings.some((finding) => finding.actions.includes(action as HostRepairAction) && (hostId === undefined || finding.hostIds.length === 0 || finding.hostIds.includes(hostId)));
			if (!allowed) return { ok: false, code: "HOST_REPAIR_NOT_APPLICABLE" };
			const requested = action as HostRepairAction;
			const subjectId = hostId ?? "lock";
			const digest = repairDigest(requested, hostId, snapshot.revision);
			const label = hostId === undefined ? "" : String(store.getProfile(hostId)?.label ?? "");
			const { requestId, expiresAt } = repairBroker.begin({ senderId, action: repairAction, subjectId, stateDigest: digest, payload: { action: requested, ...(hostId === undefined ? {} : { hostId }) } });
			repairPending.set(requestId, { subjectId, digest, revision: snapshot.revision });
			if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.remoteHostRepairConfirm, { requestId, expiresAt, action: requested, ...(hostId === undefined ? {} : { hostId }), label } satisfies RemoteHostRepairRequest);
			return { ok: true, status: "pending" };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_REPAIR_FAILED") };
		}
	});

	/**
	 * Answer a repair confirmation and, when approved, run it.
	 *
	 * `broker.answer` returns the payload only when the requestId and sender still match, so a replayed,
	 * expired or foreign answer runs nothing. The revision passed to each action is the one the user
	 * approved — the repair module re-checks it under the store lock, so a state change in between is
	 * refused rather than applied to a state nobody looked at.
	 */
	ipcMain.handle(ipcChannels.remoteHostRepairAnswer, async (event, requestId: unknown, choice: unknown): Promise<RemoteHostRepairAnswerResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return { ok: false, code: "REMOTE_HOST_REPAIR_ANSWER_INVALID" };
		if (choice !== "approve" && choice !== "deny") return { ok: false, code: "REMOTE_HOST_REPAIR_ANSWER_INVALID" };
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return { ok: false, code: "REMOTE_HOST_REPAIR_ANSWER_INVALID" };
		try {
			const offered = repairPending.get(requestId);
			if (offered === undefined) return { ok: false, code: "HOST_REPAIR_CONFIRMATION_REQUIRED" };
			const { repair } = await openRepair();
			const payload = repairBroker.answer({ requestId, senderId, action: repairAction, subjectId: offered.subjectId, stateDigest: offered.digest, choice });
			if (payload === null) return { ok: true, ran: false };
			const confirmation = { requestId, senderId };
			switch (payload.action) {
				case "complete-activation-from-pin":
					await repair.completeActivationFromPin(payload.hostId as string, offered.revision, confirmation);
					break;
				case "discard-orphan-pin":
					await repair.discardOrphanPin(payload.hostId as string, confirmation);
					break;
				case "forget-trust-anchor":
					await repair.forgetTrustAnchor(payload.hostId as string, offered.revision, confirmation);
					break;
				case "clear-stale-lock":
					await repair.clearStaleHostLock(process.pid, confirmation);
					break;
				case "clear-rebind-lock":
					await repair.clearStaleRebindLock(process.pid, confirmation);
					break;
				default:
					return { ok: false, code: "REMOTE_HOST_REPAIR_ACTION_INVALID" };
			}
			return { ok: true, ran: true };
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_HOST_REPAIR_FAILED") };
		}
	});
}

/** Project a diagnosis finding onto the renderer contract, dropping anything not on the allowlist. */
function findingFrom(finding: { reason: string; classification: string; hostIds: readonly string[]; actions: readonly string[] }): RemoteHostRepairFinding {
	return {
		reason: REPAIR_REASON.test(finding.reason) ? finding.reason : "REMOTE_HOST_DIAGNOSTIC_UNKNOWN",
		classification: REPAIR_CLASSIFICATIONS.has(finding.classification) ? (finding.classification as RemoteHostRepairFinding["classification"]) : "unknown",
		hostIds: finding.hostIds.filter((id) => HOST_ID.test(id)).slice(0, 2000),
		actions: finding.actions.filter((action) => REPAIR_ACTIONS.has(action)) as RemoteHostRepairFinding["actions"],
	};
}

/**
 * Best-effort rollback of a draft whose offer failed.
 *
 * Deliberately swallows its own failure: the caller is already reporting the offer error, and losing
 * that in favour of a cleanup error would hide the reason the add did not work. A draft that survives
 * a failed rollback is still visible and still unremovable, so this is a real (if unlikely) residue
 * rather than something to pretend about.
 */
async function rollbackDraft(store: { getSnapshot: () => { revision: number }; discardUnverifiedDraft: (hostId: string, revision: number) => Promise<string> }, hostId: string): Promise<void> {
	try {
		await store.discardUnverifiedDraft(hostId, store.getSnapshot().revision);
	} catch {
		// Residue is preferable to masking the original failure.
	}
}

/** The broker keys on a positive integer sender; `webContents.id` is exactly that. */
