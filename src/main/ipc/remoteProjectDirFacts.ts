/**
 * 远端工作区事实的**唯一 owner**（T4 收口；目录族与 Git 状态族同一份缓存主人）。
 *
 * 这里拥有五件事，避免项目域写面文件承载目录缓存细节、再次越过 400 行红线：
 * 1. 目录事实缓存（按 projectId + 相对目录键，一次装载只发一次远端请求）；
 * 2. Git 状态事实缓存（`SnapshotFactsCache`）：`remoteGitReadIpc` 只读写这份实例，不再自建第二份；
 * 3. 项目 generation / host / root 归属，以及关闭项目、root 退休、主机断连时的清理；
 * 4. 深层目录订阅（期望路径集 + 合并窗口 + 预算/失败降级）；
 * 5. helper 事件 / 写成功 / 结果未知 / 断连换代 / 项目关闭 → 只标脏与通知，不装载。
 *
 * 失效语义只有一份（五条路径都走这里，一次事件一条通知）：
 * - `afterWrite`（文件写成功或结果未知）：目录矩阵 + 本项目全部已缓存仓库的 status；
 * - `invalidateTree`（结果未知的整树）：全部目录 + 全部 status；
 * - `afterGitWrite`（Git 写成功或结果未知）：该仓库 status + 整树；
 * - `onHelperEvent`：只标脏事件覆盖的目录；
 * - `onHostDisconnected` / `onRootRetired` / `closeProject`：目录与 status 一起作废。
 *
 * IPC 层只负责登记与转发；读仍由活跃的消费者决定，一次写不产生远端往返。
 */
import { codeOf, opFailFromCode, opOk } from "../../shared/op";
import type { ProjectDirectoryPageResult } from "../../shared/types/projectFiles";
import type { RemoteProjectFactsScope, RemoteWorkspaceEntry } from "../../shared/types/remoteHost";
import { createSnapshotFactsCache, type SnapshotFactsCache } from "../git/RemoteGitSnapshotFacts";
import type { RemoteGitReadSnapshot } from "../git/RemoteGitService";
import { createFactCache, type FactCache } from "../remote/RemoteFactCache";
import type { DirectoryIgnoreProbe } from "../files/DirectoryIgnore";
import type { RemoteFactsHub } from "../remote/RemoteFactsNotifications";
import { createDeepDirWatch, type DeepDirWatchStatus } from "../remote/RemoteDeepDirWatch";
import { dirKeysAfterWrite, dirPathsAfterWrite } from "../remote/RemoteDirWatchRegistry";
import { REMOTE_PROJECT_TRASH_DIR } from "../remote/RemoteProjectEntryCommands";
import { REMOTE_UPLOAD_TEMP_NAME } from "../remote/RemoteProjectUploadNames";
import type { RemoteSftpDirectoryPort } from "../remote/RemoteSftpDirectoryReader";
import { projectDirectoryPage, projectDirectoryWatchDegradation } from "./remoteProjectDirectoryReads";
import type { RemoteProjectDirSnapshot } from "./remoteProjectReadIpc";
import type { RemoteProjectTargetResolver } from "./remoteProjectTarget";
import { createProjectWatchKeepAlive } from "./remoteProjectWatchKeepAlive";

export type ProjectDirFacts = {
	/**
	 * 写面失效矩阵（写成功与结果未知共用）：写到的路径 ⇒ 所在目录 + 其父目录，加上本项目**全部已缓存
	 * 仓库的 status**；一次写只发一条通知（目录 scope 与 status scope 同一条）。
	 */
	afterWrite(projectId: string, paths: readonly string[]): void;
	/** 整树失效（结果未知的写）：全部目录 + 全部 status，只标脏、不装载。 */
	invalidateTree(projectId: string): void;
	/** Git 写成功/结果未知：该仓库 status + 整树一起标脏，只发一条通知（status + tree）。 */
	afterGitWrite(projectId: string, repoPath: string): void;
	/** 文件写后的 Git status 失效（兼容入口：`afterWrite` 已覆盖，单独调用不会重发目录事件）。 */
	invalidateStatuses(projectId: string): void;
	/**
	 * Git 状态事实族（同一 owner）：`remoteGitReadIpc` 的 snapshot/status 读的就是这份实例的现值。
	 * 读入口仍由 Git IPC 暴露，这里只提供缓存实例本身（不在别处再建第二份）。
	 */
	gitStatusFacts: SnapshotFactsCache<RemoteGitReadSnapshot>;
	/** 公共目录页：与远端 list 共用同一份事实缓存，带 truncated/revision/generation。 */
	directoryPage(projectId: string, path: string, force?: boolean): Promise<ProjectDirectoryPageResult>;
	/** 目录事实读（list 与公共目录页共用）。 */
	readDirSnapshot(projectId: string, relative: string, force: boolean): Promise<RemoteProjectDirSnapshot>;
	/**
	 * 目录页的 Git ignore 修饰端口（晚绑定：Git IPC 在本模块之后注册）。
	 * 未装配 / 判定失败都只是「没有修饰」，不影响目录页本身。
	 */
	setIgnoreProbe(probe: DirectoryIgnoreProbe | undefined): void;
	/** helper 变更事件：把 watchId 换回「哪个项目的哪些目录」，只标脏。 */
	onHelperEvent(entry: { hostId: string; watchId: string; paths: readonly string[]; sessionKey: string }): void;
	/** 断连：helper 的 watcher 已随会话一起死，登记直接丢弃（不再发退订）。 */
	onHostDisconnected(hostId: string): void;
	/** root 会话退休（TTL/LRU/latched/显式）：只清这个 root 的项目代与订阅，不碰兄弟 root。 */
	onRootRetired(entry: { hostId: string; root: string; sessionKey: string }): void;
	/** 项目关闭：清期望集合、运行期事实与目录缓存，再成对退订该项目的 watcher。 */
	closeProject(projectId: string): Promise<void>;
	/** 立即冲刷深层订阅的合并窗口（测试/诊断）。 */
	flushDirWatch(): Promise<void>;
	dirWatchStatus(projectId: string): DeepDirWatchStatus;
	/** 只读诊断：一次会话内真实发生的目录装载次数。 */
	dirLoads(): number;
	/** 进程退出：成对退订后丢弃全部订阅登记。 */
	dispose(): Promise<void>;
};

export function createProjectDirFacts(input: { projectReadTarget: RemoteProjectTargetResolver; factsEvents: RemoteFactsHub; directoryReader?: RemoteSftpDirectoryPort; ignoreProbe?: DirectoryIgnoreProbe }): ProjectDirFacts {
	const factsEvents = input.factsEvents;
	/**
	 * 目录页 ignore 修饰的判定端口（T6 收尾）：由装配层在 Git IPC 建好后接到这里。
	 * 保持 `undefined` = 旧装配/无 Git：目录页不带 `ignored`，不猜。
	 */
	let ignoreProbe: DirectoryIgnoreProbe | undefined = input.ignoreProbe;
	const projectWatches = createProjectWatchKeepAlive();
	const watchRegistry = projectWatches.registry;
	const dirWatch = createDeepDirWatch({ registry: watchRegistry });

	/** projectId → 最近一次装载所用的连接代（通知里带出去，渲染层跨代丢弃缓存）。 */
	const projectGenerations = new Map<string, string>();
	/** projectId → hostId（断连时把这一代标成已断开）。 */
	const projectHosts = new Map<string, string>();
	/** projectId → 最近一次装载使用的 canonical root（root 退休时精确判断归属，不误伤兄弟 root）。 */
	const projectRoots = new Map<string, string>();
	/**
	 * projectId → 生命周期清理代数（关闭项目/root 退休/主机断连时前进）。
	 *
	 * 目录装载是异步的：清理之后，先前发出的读仍可能回来。没有这个代数，它会把
	 * `projectGenerations` / `projectHosts` / `dirs` 重新写回，下次打开就看到一份「已清理但仍有主」
	 * 的旧缓存。装载回调在每次写入项目级状态前核对捕获的代数，不一致就按取消收尾。
	 */
	const projectEpochs = new Map<string, number>();
	let disconnectedGeneration = 0;
	const generationOf = (projectId: string): string => projectGenerations.get(projectId) ?? "";
	/**
	 * Git 状态事实族：与目录族同一个 owner、同一张连接代表（`projectGenerations`）。
	 * `remoteGitReadIpc` 通过 handle 拿这份实例，不再自建缓存——否则一次写要失效两处、发两条通知。
	 */
	const gitStatusFacts: SnapshotFactsCache<RemoteGitReadSnapshot> = createSnapshotFactsCache<RemoteGitReadSnapshot>();
	/** 本项目**已缓存事实**的仓库路径（只有占位标脏、没有现值的键不算：不发空事件）。 */
	const statusScopesOf = (projectId: string): RemoteProjectFactsScope[] => gitStatusFacts.reposOf(projectId).map((repoPath) => ({ kind: "status" as const, repoPath }));
	/** 本项目的 status 标脏；返回被标脏的 scope（通知用）。 */
	const invalidateStatuses = (projectId: string): RemoteProjectFactsScope[] => {
		const scopes = statusScopesOf(projectId);
		gitStatusFacts.invalidateProject(projectId);
		return scopes;
	};
	/** 本项目全部目录键（含在途、尚无现值的那些）。 */
	const invalidateAllDirs = (projectId: string): void => dirs.invalidateWhere((key) => key.startsWith(projectId + "\u0000"));
	/** 一次失效一条通知：同一份 owner 不按 scope 拆成多条事件。 */
	const publish = (projectId: string, scopes: readonly RemoteProjectFactsScope[]): void => {
		if (scopes.length === 0) return;
		factsEvents.publish({ projectId, generation: generationOf(projectId), scopes: [...scopes] });
	};
	const epochOf = (projectId: string): number => projectEpochs.get(projectId) ?? 0;
	const bumpEpoch = (projectId: string): void => {
		projectEpochs.set(projectId, epochOf(projectId) + 1);
	};
	/**
	 * 丢弃一个项目的运行期事实并推进代数：连接代、host/root 归属与目录缓存必须一起清。
	 * 只删本项目键（前缀含 NUL，不会误命中同前缀项目）；`clearWhere` 同时退休在途装载。
	 */
	const forgetProjectFacts = (projectId: string): void => {
		bumpEpoch(projectId);
		projectGenerations.delete(projectId);
		projectHosts.delete(projectId);
		projectRoots.delete(projectId);
		dirs.clearWhere((key) => key.startsWith(projectId + "\u0000"));
	};

	type DirectoryFact = { entries: RemoteWorkspaceEntry[]; truncated: boolean; scanned: number };
	const dirs: FactCache<DirectoryFact> = createFactCache<DirectoryFact>(async (key) => {
		const separator = key.indexOf("\u0000");
		const projectId = key.slice(0, separator);
		const relative = key.slice(separator + 1);
		// 代数在解析 target 之前捕获：解析本身也是 await，期间可能已经发生一次关闭。
		const epoch = epochOf(projectId);
		const target = await input.projectReadTarget(projectId);
		if ("code" in target) return opFailFromCode(target.code);
		const stillCurrent = (): boolean => epochOf(projectId) === epoch;
		try {
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				// 关闭项目后，先前发出的读仍可能建立/返回会话：在写入任何项目级状态前先核对代数。
				if (!stillCurrent()) throw new Error("REQUEST_CANCELLED");
				// 连接代与 host/root 归属记在这里：事件/写面通知带去给渲染层，断连时据此换代。
				projectGenerations.set(projectId, session.connectionId);
				// 保活登记：这条会话的 watcher 活着时，池不能因为空闲把它回收掉。
				projectWatches.noteSession(session.connectionId, { service: target.service, hostId: target.hostId, root: target.remotePath });
				projectHosts.set(projectId, target.hostId);
				projectRoots.set(projectId, target.remotePath);
				// Ordinary directory reads are SFTP-only. The helper remains responsible for watch
				// registration below, but its fs.list path must never be a silent fallback.
				if (input.directoryReader === undefined) throw new Error("REMOTE_SFTP_DIRECTORY_READ_FAILED");
				const listed = await input.directoryReader.read({ session, canonicalRoot: target.remotePath, relative });
				if (!listed.ok) throw new Error(listed.code);
				// 读期间项目被关闭/root 退休：这份结果不属于任何还活着的项目，不能再登记 watcher。
				if (!stillCurrent()) throw new Error("REQUEST_CANCELLED");
				// 读成功后登记订阅：根目录立即 ensure，深层目录进合并窗口；之后 helper 的变更事件才能把
				// 这个项目的事实标脏。订阅不是读的前置条件（失败只降级到只读刷新）。
				await dirWatch.record(projectId, target.hostId, relative, session);
				return {
					entries: listed.value.entries.filter((entry) => (relative !== "" || entry.name !== REMOTE_PROJECT_TRASH_DIR) && !REMOTE_UPLOAD_TEMP_NAME.test(entry.name)).map((entry) => ({ name: entry.name, kind: entry.kind, ...(entry.kind === "file" && entry.bytes !== undefined ? { bytes: entry.bytes } : {}) })),
					truncated: listed.value.truncated,
					scanned: listed.value.scanned,
				};
			});
			if (!outcome.ok) return opFailFromCode(outcome.code);
			// 结果 settle 与关闭可能交错：缓存发布前再核对一次，避免旧代写回。
			if (!stillCurrent()) return opFailFromCode("REQUEST_CANCELLED");
			return opOk(outcome.value);
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
		// 解析 target 也是一次 await：若关闭项目恰好落在这个窗口，不能等到解析完成再开始一次「新」装载，
		// 否则装载回调捕获的是清理后的代数，会把已清掉的 generation/缓存写回来。
		const epoch = epochOf(projectId);
		const target = await input.projectReadTarget(projectId);
		if ("code" in target) return { ok: false, code: target.code };
		if (epochOf(projectId) !== epoch) return { ok: false, code: "REQUEST_CANCELLED" };
		const key = projectId + "\u0000" + relative;
		// 只有暖事实才要求活的同代会话；首次打开目录必须允许正常建立会话。
		const existing = dirs.peek(key);
		const connection = target.service.projectConnectionFacts(target.hostId, target.remotePath);
		// 只有「未被标脏」的暖事实才要求活的同代会话。断连 / 失效后的 stale 暖值如果也走这条守卫，
		// 目录读会被永久挡在 SSH_HOST_NOT_READY（池化重连后无池会话时尤其明显），真实错误码或重连后的
		// 新会话都进不来。stale 值放行一次装载：仍然不会把旧事实当现状返回，只是把拒绝/重载交给装载层。
		if (existing !== undefined && existing.ok === true && existing.stale === false && (connection === undefined || connection.state !== "ready")) return { ok: false, code: "SSH_HOST_NOT_READY" };
		const snapshot = await dirs.read(key, { ...(connection === undefined ? {} : { generation: connection.connectionId }), force });
		return snapshot.ok
			? {
					ok: true,
					snapshot: {
						value: snapshot.value.entries,
						revision: snapshot.revision,
						truncated: snapshot.value.truncated,
						scanned: snapshot.value.scanned,
					},
				}
			: { ok: false, code: snapshot.code };
	}

	return {
		gitStatusFacts,
		afterWrite(projectId, paths) {
			const scopes: RemoteProjectFactsScope[] = [];
			// 没有活着的项目代 = 写面在关闭之后才回来：不得为已清理的项目重新制造目录事实/通知。
			// 首次目录读尚未落地时也没有代，但那时同样没有可失效的目录事实。
			if (projectGenerations.has(projectId)) {
				for (const path of dirPathsAfterWrite(paths)) scopes.push({ kind: "dir", path });
				for (const key of dirKeysAfterWrite(projectId, paths)) dirs.invalidate(key);
			}
			// 写也会改变工作树状态：本项目已缓存仓库的 status 与目录一起标脏（同一条通知）。
			// 只标脏 + 通知：读仍由活跃的消费者决定（一次写不产生远端往返）。
			scopes.push(...invalidateStatuses(projectId));
			publish(projectId, scopes);
		},
		invalidateTree(projectId) {
			// 前缀匹配 = 本项目全部目录键（项目 id 后紧跟真实的 NUL 分隔符，不会误命中同前缀的其它项目）。
			if (projectGenerations.has(projectId)) invalidateAllDirs(projectId);
			// 与改动前的组合语义一致：目录静默标脏，status 发通知（不装载）。
			publish(projectId, invalidateStatuses(projectId));
		},
		afterGitWrite(projectId, repoPath) {
			gitStatusFacts.invalidate(projectId, repoPath);
			// 写可能让工作树的条目整块变化（切分支/discard/恢复）：整树一起标脏，但这不是根目录事件。
			if (projectGenerations.has(projectId)) invalidateAllDirs(projectId);
			publish(projectId, [{ kind: "status", repoPath }, { kind: "tree" }]);
		},
		invalidateStatuses(projectId) {
			publish(projectId, invalidateStatuses(projectId));
		},
		setIgnoreProbe(probe) {
			ignoreProbe = probe;
		},
		directoryPage: (projectId, path, force = false) =>
			projectDirectoryPage({
				projectId,
				path,
				force,
				readDirSnapshot,
				...(ignoreProbe === undefined ? {} : { ignoreProbe }),
				generationOf,
				// 监听降级是项目级事实：每个目录页都顺手带出去，渲染层不必再开一条诊断通道。
				dirWatch: (id) => projectDirectoryWatchDegradation(dirWatch.status(id)),
			}),
		readDirSnapshot,
		onHelperEvent(entry) {
			const changed = watchRegistry.scopesForEvent(entry.hostId, entry.sessionKey, entry.watchId) ?? [];
			// 先发通知再标脏：两者都是同步的，读仍由活跃的消费者决定（事件不装载）。
			for (const scope of changed) factsEvents.publish({ projectId: scope.projectId, generation: generationOf(scope.projectId), scopes: scope.paths.map((path) => ({ kind: "dir" as const, path })) });
			for (const scope of changed) {
				for (const path of scope.paths) dirs.invalidate(scope.projectId + "\u0000" + path);
			}
		},
		onHostDisconnected(hostId) {
			// helper 已死：旧的 watchId 不可能再回来，登记直接丢弃，不发退订。
			dirWatch.forgetHost(hostId);
			projectWatches.forgetHost(hostId);
			// 断连换代：旧代缓存与渲染层持有的快照都不能再被当作“现在”。
			disconnectedGeneration += 1;
			for (const [projectId, projectHost] of [...projectHosts]) {
				if (projectHost !== hostId) continue;
				projectGenerations.set(projectId, `${hostId}#disconnected#${disconnectedGeneration}`);
				// 断连时在途的目录读可能在之后才 settle：推进代数并退休在途装载，
				// 否则它会用旧 helper 的事实覆盖刚写下的“已断开”代。
				bumpEpoch(projectId);
				invalidateAllDirs(projectId);
				// Git 状态与目录同代：断开后它们都不能再代表现状（下一次读重新装载）。
				gitStatusFacts.invalidateProject(projectId);
			}
		},
		onRootRetired(entry) {
			projectWatches.forgetSession(entry.hostId, entry.sessionKey);
			// TTL/LRU/latched 都是「这条 root 的 helper 已不在」，不是用户断开主机。使用过这条会话的项目
			// 必须丢掉旧代与旧目录事实，否则下一次读会拿暖缓存去要求一条不存在的会话（SSH_HOST_NOT_READY），
			// 永远开不回来。只按 sessionKey+host+root 精确匹配，兄弟 root 保持原样。
			for (const [projectId, generation] of [...projectGenerations]) {
				if (generation !== entry.sessionKey) continue;
				if (projectHosts.get(projectId) !== entry.hostId) continue;
				if (projectRoots.get(projectId) !== entry.root) continue;
				dirWatch.forgetProject(projectId);
				forgetProjectFacts(projectId);
				// 这条 root 的 helper 已经不在了：Git 状态事实同样作废（下一次读重新装载）。
				gitStatusFacts.invalidateProject(projectId);
			}
		},
		closeProject(projectId) {
			// 期望集合先丢（迟到的冲刷不得把它订回来），再清运行期事实并成对退订该项目的 watcher。
			// 清缓存同时退休在途装载：关闭之后才回来的读不得把 generation/host/目录缓存写回。
			dirWatch.forgetProject(projectId);
			forgetProjectFacts(projectId);
			gitStatusFacts.invalidateProject(projectId);
			return watchRegistry.closeProject(projectId);
		},
		flushDirWatch: () => dirWatch.flush(),
		dirWatchStatus: (projectId) => dirWatch.status(projectId),
		dirLoads: () => dirs.stats().loads,
		dispose() {
			dirWatch.dispose();
			gitStatusFacts.clear();
			return watchRegistry.releaseAll();
		},
	};
}
