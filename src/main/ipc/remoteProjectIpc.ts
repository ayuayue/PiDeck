/**
 * 远端项目域的 IPC 注册（G1：按域从 remoteHostIpc.ts 拆出，纯搬迁）。
 *
 * 这里只放「连上一台主机之后，按 projectId 只读地看什么」：项目登记 + 确认回答 + 列表 + 读取 + 搜索
 * + 项目级 root 复核状态（第四批设计 (i)）。
 * hosts 域（连得上吗、诊断、修复）留在 remoteHostIpc.ts。拆分的动因是体量红线，域边界本来就在：
 * 两个域共用同一套窄依赖（enabled / service / userDataDir 与懒构建的连接服务），但 handler、校验
 * 与错误码各自独立。
 *
 * 两个域刻意互不 import：`HOST_ID`、`senderIdOf`、`codeOf` 在本文件按 hosts 域的同一判据重新声明
 * （仓库里 `HOST_ID` 本来就是每个远端模块各自持有的闭集判据）；若让项目域 import hosts 域，拆分
 * 只是把耦合换了个文件名。稳定码判据本身走 `shared/op`（全仓唯一一份实现）。
 *
 * 信封形状是 `Op<T>`（v5 §2「单信封」）：成功 `{ok:true, value}`，失败 `{ok:false, code, outcome}`。
 */

import { createHash } from "node:crypto";
import { createRemoteProjectTargetResolver } from "./remoteProjectTarget";
import { ipcMain, type WebContents } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { codeOf, opFailFromCode, opOk, type Op } from "../../shared/op";
import type { FileContentSearchResult } from "../../shared/types";
import type { ProjectDirectoryPageResult, ProjectPathsExistResult } from "../../shared/types/projectFiles";
import type { RemoteProjectDownloadResult, RemoteProjectUploadResult, RemoteProjectEnrollAnswerResult, RemoteProjectEnrollMode, RemoteProjectEnrollRequest, RemoteProjectEnrollResult, RemoteWorkspaceEntry } from "../../shared/types/remoteHost";
import { readRelativePath, readerPath, registerRemoteProjectReadIpc, sessionPort, type RemoteProjectDirSnapshot } from "./remoteProjectReadIpc";
import { projectDirectoryPage, projectDirectoryWatchDegradation, projectPathsExist } from "./remoteProjectDirectoryReads";
import { registerRemoteProjectCreateFlow } from "./remoteProjectCreateIpc";
import type { RemoteHostConnectionService, RemoteProjectSession } from "../remote/RemoteHostConnectionService";
import { REMOTE_PROJECT_TRASH_DIR } from "../remote/RemoteProjectEntryCommands";
import { isUserVisibleRemoteEntry } from "../remote/RemoteProjectNameRules";
import { REMOTE_UPLOAD_TEMP_NAME } from "../remote/RemoteProjectFileUpload";
import { resolveRemoteBrowseRoot } from "../remote/RemoteBrowseRoot";
import { createRemoteWorkspaceReader } from "../remote/RemoteWorkspaceReader";
import { createRemoteSearchReader } from "../remote/RemoteSearchReader";
import { REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT } from "../remote/RemoteHelperContract";
import { createFactCache, type FactCache } from "../remote/RemoteFactCache";
import { dirKeysAfterWrite, dirPathsAfterWrite } from "../remote/RemoteDirWatchRegistry";
import { createDeepDirWatch, type DeepDirWatchStatus } from "../remote/RemoteDeepDirWatch";
import { createProjectWatchKeepAlive } from "./remoteProjectWatchKeepAlive";
import { createRemoteFactsHub, type RemoteFactsHub } from "../remote/RemoteFactsNotifications";
import { PendingConfirmationBroker } from "../security/PendingConfirmationBroker";

/** host id 的闭集判据，与 hosts 域逐字相同；两个域各自持有，避免项目域 import hosts 域。 */
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The broker keys on a positive integer sender; `webContents.id` is exactly that. */
function senderIdOf(sender: WebContents): number | undefined {
	const id = sender?.id;
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * 远端项目 IPC：登记、确认回答、按 projectId 的列表/读取/搜索。
 *
 * `enabled` 关掉时每个通道都返回稳定码（渲染层连「有这条路」都不该知道）；`service` 可选，因此
 * 只读目录在没有任何连接服务时也返回稳定码而不是崩溃；`projects` 是装配层注入的持久化端口
 * （enroll / locator），未提供时项目相关通道返回稳定码。
 */
/** 事实层句柄：写面完成后按“我改了哪些路径”标脏，下一次读取自然重新装载。 */
export type RemoteProjectIpcHandle = {
	/** 失效矩阵：写到的路径 ⇒ 所在目录 + 其父目录（目录自身的元数据也变了）。 */
	afterWrite(projectId: string, paths: readonly string[]): void;
	/**
	 * 整树失效（远端 Git 写成功/结果未知）：子树条目可能整块变化，但这不是「根目录事件」——
	 * 只标脏、不装载；重读范围由活跃的文件树决定（收到 tree scope 后重读根与全部已加载目录）。
	 */
	invalidateTree(projectId: string): void;
	/**
	 * helper 变更事件（helper 1.24.0）的入口：把 watchId 换回「哪个项目的哪些目录」。
	 *
	 * 只做**失效**，不装载：事件是「你可能要重读」的提示，重读仍由读的人决定。
	 * 未注册的 watchId（旧会话、别的项目、已撤销）直接忽略——绝不猜。
	 */
	onHelperEvent(entry: { hostId: string; watchId: string; paths: readonly string[]; sessionKey: string }): void;
	/** 断连：helper 的 watcher 已随会话一起死，登记直接丢弃（不再发退订）。 */
	onHostDisconnected(hostId: string): void;
	onRootRetired(entry: { hostId: string; root: string; sessionKey: string }): void;
	/** 项目关闭：退订它在各 host 上的目录订阅，不影响别的项目。 */
	closeProject(projectId: string): Promise<void>;
	/** 立即冲刷深层订阅的合并窗口（测试/诊断；正常路径由 150–250ms 窗口自行冲刷）。 */
	flushDirWatch(): Promise<void>;
	/** 深层订阅的可断言状态：期望路径、已覆盖路径与降级原因（超预算时不假装覆盖）。 */
	dirWatchStatus(projectId: string): DeepDirWatchStatus;
	/** 公共目录页（T6）：与远端 list 共用同一份事实缓存，带 truncated/revision/generation。 */
	directoryPage(projectId: string, path: string, force?: boolean): Promise<ProjectDirectoryPageResult>;
	/**
	 * 远端内容搜索（helper 1.25.0）：按**连接握手声明的能力**路由，旧 helper 返回 `ok:true, value:null`
	 * （"这个位置不支持"），渲染层据此回退到仅文件名提示，而不是发一次注定失败的请求。
	 * 匹配里的 path 是项目相对路径（与文件名搜索同一身份）；文件正文永不回传，只有有界预览。
	 */
	searchContent(projectId: string, query: string): Promise<Op<FileContentSearchResult | null>>;
	/** 批量存在性/类型（只读 fs 面；64 路径/帧，全有或全无时按需逐项核对）。 */
	pathsExist(projectId: string, paths: readonly string[]): Promise<ProjectPathsExistResult>;
	/** 进程退出：成对退订后丢弃全部订阅登记。 */
	dispose(): Promise<void>;
	/** 只读诊断：一次会话内真实发生的目录装载次数。 */
	dirLoads(): number;
};

export function registerRemoteProjectIpc(input: {
	enabled: boolean;
	userDataDir: string;
	service?: () => RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>;
	/** 事实变化通知出口；装配层提供时由目录与 Git 共用同一个 hub。 */
	factsEvents?: RemoteFactsHub;
	/**
	 * 远端项目登记端口（Phase 3 第二段）。
	 *
	 * 只开一个狭窄入口：`enroll` 把已确认的 canonical root 写进项目库并返回 stable projectId；
	 * `locator` 按 projectId 取回 `{ hostId, remotePath }`。主进程持有校验后的 canonical 值，
	 * 远端路径不经由渲染层或本机 fs。未提供时（旧装配/正式包）登记与项目读取/搜索都返回稳定码。
	 */
	projects?: {
		enroll: (input: { hostId: string; canonicalRemotePath: string }) => Promise<{ projectId: string }>;
		locator: (projectId: string) => { kind: "ssh"; hostId: string; remotePath: string } | undefined;
	};
}): RemoteProjectIpcHandle {
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

	/**
	 * Remote project enrollment (Phase 3 第二段).
	 *
	 * A separate decision from browsing a root: this writes a **persistent project** (`ProjectStore`). It
	 * therefore has its own broker action, its own pending table and its own confirmation push channel, so
	 * a project-enrollment prompt can never arrive in the workspace panel or vice versa. The renderer submits
	 * only `{ hostId, candidatePath }`; the canonical value is resolved here and stays here.
	 */
	const enrollBroker = new PendingConfirmationBroker<{ hostId: string; canonicalPath: string }>({
		onRemoved: (requestId) => {
			enrollOffers.delete(requestId);
		},
	});
	const enrollOffers = new Map<string, { subjectId: string; digest: string }>();
	const enrollAction = "remote:project-enroll";
	/**
	 * 「新建空远端项目」确认：与「使用已有目录」是两个不同的用户决定。独立 broker/pending/推送通道
	 * 都在 remoteProjectCreateIpc 中，两者可同时挂起互不串扰。
	 */
	const createProjectFlow = registerRemoteProjectCreateFlow({
		enabled: input.enabled,
		userDataDir: input.userDataDir,
		projects: input.projects,
		resolveService: async () => {
			const service = await resolveService();
			return "code" in service ? { code: service.code } : { client: service.service.client };
		},
	});
	const enrollDigest = (hostId: string, canonicalPath: string): string =>
		createHash("sha256")
			.update(JSON.stringify(["pideck-project-enroll-v1", hostId, canonicalPath]), "utf8")
			.digest("hex");

	ipcMain.handle(ipcChannels.remoteProjectEnroll, async (event, hostIdValue: unknown, pathValue: unknown, modeValue: unknown): Promise<RemoteProjectEnrollResult> => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		if (input.projects === undefined) return opFailFromCode("REMOTE_PROJECT_ENROLL_UNAVAILABLE");
		if (typeof hostIdValue !== "string" || !HOST_ID.test(hostIdValue)) return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		if (typeof pathValue !== "string") return opFailFromCode("REMOTE_BROWSE_ROOT_INVALID");
		if (modeValue !== undefined && modeValue !== "existing" && modeValue !== "create") return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		const mode: RemoteProjectEnrollMode = modeValue === "create" ? "create" : "existing";
		// 「新建空目录」不是登记：它会在项目根之外执行一次写命令，因此必须先探针、再走独立确认 broker。
		if (mode === "create") {
			const createService = await resolveService();
			if ("code" in createService) return opFailFromCode(createService.code);
			return createProjectFlow.begin(event.sender, createService.service, hostIdValue, pathValue);
		}
		const resolvedService = await resolveService();
		if ("code" in resolvedService) return opFailFromCode(resolvedService.code);
		try {
			// Same pinned probe the workspace panel uses: the canonical value shown here is the one that will be
			// confined to, and a symlink that the handshake would reject can never be confirmed in the first place.
			const resolved = await resolveRemoteBrowseRoot({ userDataDir: input.userDataDir, hostId: hostIdValue, client: resolvedService.service.client, userPath: pathValue });
			const digest = enrollDigest(hostIdValue, resolved.canonicalPath);
			const { requestId, expiresAt } = enrollBroker.begin({ senderId, action: enrollAction, subjectId: hostIdValue, stateDigest: digest, payload: { hostId: hostIdValue, canonicalPath: resolved.canonicalPath } });
			enrollOffers.set(requestId, { subjectId: hostIdValue, digest });
			if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.remoteProjectEnrollConfirm, { requestId, expiresAt, hostId: hostIdValue, label: pathValue, requestedPath: pathValue, canonicalPath: resolved.canonicalPath } satisfies RemoteProjectEnrollRequest);
			return opOk({ status: "pending" as const, hostId: hostIdValue, canonicalPath: resolved.canonicalPath });
		} catch (error) {
			return opFailFromCode(codeOf(error, "REMOTE_PROJECT_TARGET_INVALID"));
		}
	});

	ipcMain.handle(ipcChannels.remoteProjectAnswer, async (event, requestId: unknown, choice: unknown): Promise<RemoteProjectEnrollAnswerResult> => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		if (input.projects === undefined) return opFailFromCode("REMOTE_PROJECT_ENROLL_UNAVAILABLE");
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		if (choice !== "approve" && choice !== "deny") return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return opFailFromCode("REMOTE_PROJECT_TARGET_INVALID");
		const offered = enrollOffers.get(requestId);
		if (offered === undefined) return opFailFromCode("REMOTE_PROJECT_ENROLL_CONFIRMATION_REQUIRED");
		try {
			const payload = enrollBroker.answer({ requestId, senderId, action: enrollAction, subjectId: offered.subjectId, stateDigest: offered.digest, choice });
			if (payload === null) return opOk({ enrolled: false });
			// The confirmation window is real time, and the world moves inside it: the directory can be deleted,
			// or a symlink along it can be re-pointed at something else. Writing the value the user was *shown*
			// is therefore not enough on its own — that value has to still resolve to itself right now, or the
			// user would be confirming a boundary that no longer exists (or no longer means what it did).
			//
			// Re-probing also re-runs the pinned preflight, so a host that was disabled or retired while the
			// prompt was open fails here instead of being enrolled. Nothing is persisted unless this passes,
			// and the broker already consumed the request, so the user re-enrolls rather than getting a
			// half-written record.
			const resolvedService = await resolveService();
			if ("code" in resolvedService) return opFailFromCode(resolvedService.code);
			try {
				const rechecked = await resolveRemoteBrowseRoot({ userDataDir: input.userDataDir, hostId: payload.hostId, client: resolvedService.service.client, userPath: payload.canonicalPath });
				if (rechecked.canonicalPath !== payload.canonicalPath) return opFailFromCode("REMOTE_PROJECT_ROOT_CHANGED");
			} catch (error) {
				return opFailFromCode(codeOf(error, "REMOTE_PROJECT_ROOT_UNRESOLVED"));
			}
			// Write the durable record only now, with the main-held canonical value. The renderer cannot supply
			// the path, the id or an "already confirmed" flag.
			const { projectId } = await input.projects.enroll({ hostId: payload.hostId, canonicalRemotePath: payload.canonicalPath });
			return opOk({ enrolled: true, projectId });
		} catch (error) {
			return opFailFromCode(codeOf(error, "REMOTE_PROJECT_TARGET_INVALID"));
		}
	});

	const projectReadTarget = createRemoteProjectTargetResolver({ service: input.service, locator: input.projects?.locator });

	/**
	 * 目录事实（W3 接线）：**一次内容变化只装载一次**。
	 *
	 * 树、搜索建议、Git 面板的“这个目录里有什么”过去各自问一遍远端；现在同一个 (projectId, 相对路径)
	 * 在同一个装载里合并，并带一个 revision——两个读者据此知道“我看到的是同一份事实”。
	 * 失效只在写面发生时标脏（`afterWrite`），装载成本由读的人决定，一次写不产生任何往返。
	 */
	const projectWatches = createProjectWatchKeepAlive();
	const watchRegistry = projectWatches.registry;

	/**
	 * 事实变化通知的出口（v5 T4）：事实层只标脏，通知由这里发。
	 * 订阅按 (sender, project) 绑定；退订/窗口销毁都清登记（见 `RemoteFactsNotifications`）。
	 */
	const factsEvents: RemoteFactsHub = input.factsEvents ?? createRemoteFactsHub(ipcChannels.remoteProjectFactsChanged);
	/** projectId → 最近一次装载所用的连接代（通知里带出去，渲染层跨代丢弃缓存）。 */
	const projectGenerations = new Map<string, string>();
	/** projectId → hostId（断连时把这一代标成已断开）。 */
	const projectHosts = new Map<string, string>();
	let disconnectedGeneration = 0;
	const generationOf = (projectId: string): string => projectGenerations.get(projectId) ?? "";

	/**
	 * 深层目录订阅（P0-4）：期望路径集 + 合并窗口 + 一次性 ensure/rewatch 在 RemoteDeepDirWatch。
	 *
	 * 这里只负责登记：目录读成功后把**项目相对路径**交给它；订阅失败/超预算是降级，不是读失败。
	 */
	const dirWatch = createDeepDirWatch({ registry: watchRegistry });

	const dirs: FactCache<RemoteWorkspaceEntry[]> = createFactCache<RemoteWorkspaceEntry[]>(async (key) => {
		const separator = key.indexOf("\u0000");
		const projectId = key.slice(0, separator);
		const relative = key.slice(separator + 1);
		const target = await projectReadTarget(projectId);
		if ("code" in target) return opFailFromCode(target.code);
		try {
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				// 连接代与 host 归属记在这里：事件/写面通知带去给渲染层，断连时据此换代。
				projectGenerations.set(projectId, session.connectionId);
				// 保活登记：这条会话的 watcher 活着时，池不能因为空闲把它回收掉。
				projectWatches.noteSession(session.connectionId, { service: target.service, hostId: target.hostId, root: target.remotePath });
				projectHosts.set(projectId, target.hostId);
				const reader = createRemoteWorkspaceReader({ port: sessionPort(session, target.hostId) });
				const listed = await reader.list(target.hostId, readerPath(relative));
				// 读成功后登记订阅：根目录立即 ensure，深层目录进合并窗口；之后 helper 的变更事件才能把
				// 这个项目的事实标脏。订阅不是读的前置条件（失败只降级到只读刷新）。
				await dirWatch.record(projectId, target.hostId, relative, session);
				return listed;
			});
			if (!outcome.ok) return opFailFromCode(outcome.code);
			// 两类条目不属于用户数据：回收站命名空间（只在根目录隐藏）与本通道自己的上传临时文件。
			return opOk(outcome.value.entries.filter((entry) => (relative !== "" || entry.name !== REMOTE_PROJECT_TRASH_DIR) && !REMOTE_UPLOAD_TEMP_NAME.test(entry.name)).map((entry) => ({ name: entry.name, kind: entry.kind, ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }) })));
		} catch (error) {
			return opFailFromCode(codeOf(error, "REMOTE_PROJECT_READ_FAILED"));
		}
	});

	/**
	 * 目录事实读（list 与公共目录页共用）：暖缓存命中也要逐次重解析当前项目/连接。
	 *
	 * `force` 只给显式刷新用：越过已完成缓存；在途同代装载仍可合并。
	 */
	async function readDirSnapshot(projectId: string, relative: string, force: boolean): Promise<RemoteProjectDirSnapshot> {
		const target = await projectReadTarget(projectId);
		if ("code" in target) return { ok: false, code: target.code };
		const key = projectId + "\u0000" + relative;
		// 只有暖事实才要求活的同代会话；首次打开目录必须允许正常建立会话。
		const existing = dirs.peek(key);
		const connection = target.service.projectConnectionFacts(target.hostId, target.remotePath);
		if (existing !== undefined && (connection === undefined || connection.state !== "ready")) return { ok: false, code: "SSH_HOST_NOT_READY" };
		const snapshot = await dirs.read(key, { ...(connection === undefined ? {} : { generation: connection.connectionId }), force });
		return snapshot.ok ? { ok: true, snapshot } : { ok: false, code: snapshot.code };
	}

	registerRemoteProjectReadIpc({
		enabled: input.enabled,
		projectReadTarget,
		factsEvents,
		readDirSnapshot,
	});

	return {
		afterWrite(projectId: string, paths: readonly string[]): void {
			const touched = dirPathsAfterWrite(paths);
			for (const key of dirKeysAfterWrite(projectId, paths)) dirs.invalidate(key);
			// 只标脏 + 通知：读仍由活跃的消费者决定（一次写不产生远端往返）。
			factsEvents.publish({ projectId, generation: generationOf(projectId), scopes: touched.map((path) => ({ kind: "dir" as const, path })) });
		},
		invalidateTree(projectId: string): void {
			// 前缀匹配 = 本项目全部目录键（项目 id 后紧跟真实的 NUL 分隔符，不会误命中同前缀的其它项目）。
			dirs.invalidateWhere((key) => key.startsWith(projectId + "\u0000"));
		},
		directoryPage: (projectId, path, force = false) =>
			projectDirectoryPage({
				projectId,
				path,
				force,
				readDirSnapshot,
				generationOf,
				// 监听降级是项目级事实：每个目录页都顺手带出去，渲染层不必再开一条诊断通道。
				dirWatch: (id) => projectDirectoryWatchDegradation(dirWatch.status(id)),
			}),
		pathsExist: (projectId, paths) => projectPathsExist({ projectId, paths, projectReadTarget }),
		async searchContent(projectId, query) {
			const target = await projectReadTarget(projectId);
			if ("code" in target) return opFailFromCode(target.code);
			try {
				// The capability is read after the session exists: a first read of a cold host establishes the
				// session inside withProjectSession, so the hello answer is already stored when this runs.
				const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
					const capabilities = target.service.projectHelperCapabilities(target.hostId, target.remotePath);
					if (capabilities === undefined || capabilities.includes(REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT) === false) return null;
					const reader = createRemoteSearchReader({ port: sessionPort(session, target.hostId) });
					const result = await reader.searchContent(target.hostId, ".", query);
					// Same identity rules as the filename search: the trash and upload temps are not user files.
					const hits = result.matches.filter((match) => isUserVisibleRemoteEntry(match.path)).map((match) => ({ name: match.name, path: match.path, relativePath: match.path, line: match.line, column: match.column, snippet: match.snippet }));
					return { hits, matchedFiles: result.matchedFiles, scannedFiles: result.scannedFiles, scannedBytes: result.scannedBytes, truncated: result.truncated };
				});
				if (!outcome.ok) return opFailFromCode(outcome.code);
				return opOk(outcome.value);
			} catch (error) {
				return opFailFromCode(codeOf(error, "REMOTE_PROJECT_READ_FAILED"));
			}
		},
		onHelperEvent(entry): void {
			const changed = projectWatches.registry.scopesForEvent(entry.hostId, entry.sessionKey, entry.watchId) ?? [];
			// 先发通知再标脏：两者都是同步的，读仍由活跃的消费者决定（事件不装载）。
			for (const scope of changed) factsEvents.publish({ projectId: scope.projectId, generation: generationOf(scope.projectId), scopes: scope.paths.map((path) => ({ kind: "dir" as const, path })) });
			for (const scope of changed) {
				for (const path of scope.paths) dirs.invalidate(scope.projectId + "\u0000" + path);
			}
		},
		dirLoads(): number {
			return dirs.stats().loads;
		},
		onHostDisconnected(hostId: string): void {
			// helper 已死：旧的 watchId 不可能再回来，登记直接丢弃，不发退订。
			dirWatch.forgetHost(hostId);
			projectWatches.forgetHost(hostId);
			// 断连换代：旧代缓存与渲染层持有的快照都不能再被当作“现在”。
			disconnectedGeneration += 1;
			for (const [projectId, projectHost] of projectHosts) if (projectHost === hostId) projectGenerations.set(projectId, `${hostId}#disconnected#${disconnectedGeneration}`);
		},
		// root 会话退休 ≠ 主机断连：只丢这一条会话的登记（helper 已不在，不发退订），邻居 root 不动。
		onRootRetired: (entry) => projectWatches.forgetSession(entry.hostId, entry.sessionKey),
		closeProject(projectId: string): Promise<void> {
			// 期望集合先丢（迟到的冲刷不得把它订回来），再成对退订该项目的 watcher。
			dirWatch.forgetProject(projectId);
			return projectWatches.registry.closeProject(projectId);
		},
		flushDirWatch(): Promise<void> {
			return dirWatch.flush();
		},
		dirWatchStatus: (projectId) => dirWatch.status(projectId),
		dispose(): Promise<void> {
			dirWatch.dispose();
			return projectWatches.registry.releaseAll();
		},
	};
}
