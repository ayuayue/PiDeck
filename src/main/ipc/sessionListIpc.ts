/**
 * 会话列表与查找 IPC：sessions:list（磁盘扫描）/ 跨会话正文搜索 / 会话内查找 /
 * sessions:catalog:list（catalog 缓存先回显 + 后台扫描调度 + 冷启动里程碑）。
 * 从 sessionIpc.ts 按通道域拆出（纯搬迁：通道常量、入参校验、错误文案与注册顺序不变）。
 */
import { ipcMain } from "electron";
import { agentEventTags, ipcChannels } from "../../shared/ipc";
import { isLocalProject } from "../../shared/projectLocation";
import { resolveProjectWslIdentity } from "../wsl/WslProjectEnvironment";
import { sessionFileExistsCached } from "../sessions/sessionFileLiveness";
import type { SessionRecord, SessionSearchResult } from "../../shared/types";
import { isSessionSearchFilePath } from "../sessions/sessionSearchPath";
import { findSessionMatches } from "../sessions/sessionFindMatches";
import { BackgroundScanCoordinator } from "../sessions/BackgroundScanCoordinator";
import type { SessionCatalogEntry } from "../sessions/SessionCatalog";
import type { SessionIpcDeps, DshBackendIpcDeps } from "./sessionIpc";

/**
 * 已扫描过项目的集合（模块级）：决定 catalogList 走「首次同步扫描」还是
 * 「缓存先回显 + 后台扫描推送」。进程生命周期内单调增长，无需清理。
 */
const scannedProjects = new Set<string>();

/** 后台目录扫描协调器：同项目触发去重 + 冷却合并（3 秒轮询不会演变成并发重扫）。 */
const catalogScanCoordinator = new BackgroundScanCoordinator(5000);

/**
 * 供主进程装配层（启动预扫描）触发的后台扫描调度入口。
 * 标记项目为已扫描，保证预热后首次展开项目走缓存回显路径。
 */
export function scheduleCatalogBackgroundScan(projectId: string, task: () => Promise<void>): boolean {
	scannedProjects.add(projectId);
	return catalogScanCoordinator.schedule(projectId, task);
}

export type SessionListIpcDeps = Pick<
	SessionIpcDeps,
	"projectStore" | "settingsStore" | "sessionScanner" | "resolveWslSessionScanner" | "sessionCatalog" | "sessionRuntimeCoordinator" | "agentManager" | "appLogger" | "mainCopy" | "getMainWindow" | "emitSessionRuntimeEvent" | "sessionContentSearch" | "sessionMessageSearch"
> & {
	/** 本组用到的 DSH 后端读口（未装配 = 无 DSH 后端）。 */
	dshBackend?: Pick<DshBackendIpcDeps, "searchDshSessionMessages" | "resolveDshSessionFilePath" | "readAcpMessages">;
};

export function registerSessionListIpc(deps: SessionListIpcDeps): void {
	const { projectStore, settingsStore, sessionScanner, resolveWslSessionScanner, sessionCatalog, sessionRuntimeCoordinator, agentManager, appLogger, mainCopy, getMainWindow, emitSessionRuntimeEvent, dshBackend } = deps;
	const { searchDshSessionMessages, resolveDshSessionFilePath, readAcpMessages } = dshBackend ?? {};
	/**
	 * 冷启动里程碑（3/3）：首个会话列表返回。前两个里程碑（app ready / first window shown）
	 * 记在 index.ts，但用户真正看到内容要等这次扫描结束；scanMs 单独拆出来，才能区分
	 * 「窗口起得慢」和「会话扫描慢」（侧栏扫描是唯一未进 sidecar 的机械成本，见
	 * docs/archive/plans/session-data-plane-plan.md §7）。只在首个请求记录一次，切项目不再刷屏。
	 */
	let firstSessionListMilestoneLogged = false;
	ipcMain.handle(ipcChannels.sessionsList, async (_event, projectId?: string) => {
		const project = projectId ? projectStore.get(projectId) : undefined;
		const projectWsl = resolveProjectWslIdentity(project, settingsStore.get());
		let projectPath = project?.path;
		// WSL 项目：把 Windows 项目路径转为 WSL /mnt/ 格式，使 CWD=/mnt/... 的会话能匹配。
		if (projectPath && projectWsl !== undefined) {
			projectPath = projectPath.replace(/^([A-Za-z]):\\/, (_: string, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
		}
		const startedAt = Date.now();
		const scanner = projectWsl !== undefined && resolveWslSessionScanner !== undefined ? await resolveWslSessionScanner(projectWsl) : sessionScanner;
		const sessions = await scanner.list(projectPath);
		if (!firstSessionListMilestoneLogged) {
			firstSessionListMilestoneLogged = true;
			void appLogger.info("app", "Cold start milestone: first session list", {
				scanMs: Date.now() - startedAt,
				sessions: sessions.length,
				projectId: projectId ?? null,
				processUptimeMs: Math.round(process.uptime() * 1000),
			});
		}
		return sessions;
	});
	// 跨会话正文搜索：sidecar 不可用/boot 中/失败一律返回 null，渲染层回退标题过滤
	ipcMain.handle(ipcChannels.sessionsSearchContent, async (_event, query: unknown) => {
		const searcher = deps.sessionContentSearch;
		if (!searcher) return null;
		if (typeof query !== "string") return null;
		const trimmed = query.trim();
		if (!trimmed || trimmed.length > 256) return null;
		try {
			return await searcher(trimmed);
		} catch (error) {
			void appLogger.warn("session", "Content search failed", { error: error instanceof Error ? error.message : String(error) });
			return null;
		}
	});

	/**
	 * DSH 会话内查找：host 历史投影 → 词元匹配，包成跨会话搜索的同形信封——
	 * 渲染层浮层只读 sessions[0].matches / hitCount，形状一致才能共用 hook 与浮层。
	 * filePath 给出 host 会话日志路径（排查用；推不出来时退化成 dsh:<id>）。
	 */
	const searchDshSessionInSession = async (entry: SessionCatalogEntry, query: string): Promise<SessionSearchResult | null> => {
		const searcher = dshBackend?.searchDshSessionMessages;
		const dshSessionId = entry.dshSessionId;
		if (!searcher || !dshSessionId) return null;
		try {
			const found = await searcher(dshSessionId, query);
			if (found.hitCount === 0) return { sessions: [], totalHitSessions: 0, truncated: false };
			let logPath: string | undefined;
			if (resolveDshSessionFilePath) {
				try {
					logPath = await resolveDshSessionFilePath(entry.id);
				} catch {
					logPath = undefined;
				}
			}
			return {
				sessions: [
					{
						filePath: logPath ?? `dsh:${dshSessionId}`,
						updatedAtMs: entry.updatedAt,
						matches: found.matches,
						hitCount: found.hitCount,
					},
				],
				totalHitSessions: 1,
				truncated: found.hitCount > found.matches.length,
			};
		} catch (error) {
			void appLogger.warn("session", "DSH in-session search failed", {
				sessionId: entry.id,
				dshSessionId,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	};

	/**
	 * ACP 会话内查找：历史来自运行时投影 + deck 侧归档（readAcpMessages 异步读口），
	 * 匹配复用与 pi/DSH 同一套词元规则（findSessionMatches，见 sessions/sessionFindMatches）。
	 * 信封形状与 DSH 分支一致——浮层只读 sessions[0].matches / hitCount，形状一致才能
	 * 共用 hook 与浮层。filePath 给 `acp:<acpSessionId>`：ACP 没有 pi JSONL，这个标识只
	 * 用于排查，不参与跳转（命中 id 就是投影消息 id，jumpToMessage 直接按 id 定位）。
	 * 无 acpSessionId（草稿还没握过手）或未装配读口返回 null（渲染层显示「暂时读不到」）；
	 * 有会话但归档/投影为空时返回空命中（「没有匹配」）。
	 */
	const searchAcpSessionInSession = async (entry: SessionCatalogEntry, query: string): Promise<SessionSearchResult | null> => {
		const reader = readAcpMessages;
		const acpSessionId = entry.acpSessionId;
		if (!reader || !acpSessionId) return null;
		try {
			const found = findSessionMatches(await reader(acpSessionId), query);
			if (found.hitCount === 0) return { sessions: [], totalHitSessions: 0, truncated: false };
			return {
				sessions: [{ filePath: `acp:${acpSessionId}`, updatedAtMs: entry.updatedAt, matches: found.matches, hitCount: found.hitCount }],
				totalHitSessions: 1,
				truncated: found.hitCount > found.matches.length,
			};
		} catch (error) {
			void appLogger.warn("session", "ACP in-session search failed", { sessionId: entry.id, acpSessionId, error: error instanceof Error ? error.message : String(error) });
			return null;
		}
	};

	// 会话内查找（Ctrl/Cmd+Shift+F）：入参是 **SessionRecord.id**（不是路径）。
	// 路径/后端身份一律由主进程从 catalog 解析，渲染层传什么路径都不生效：
	// - pi：sidecar 只索引会话文件（.jsonl），路径再兜一道 isSessionSearchFilePath；
	// - DSH：没有 pi JSONL，整段 host 历史投影后本地匹配（命中 id = 投影消息 id）；
	// - ACP：没有 pi JSONL，运行时投影/内存快照/deck 侧归档任一可用即可匹配
	//   （命中 id 同样是投影消息 id）。
	// 命中按时间线顺序返回（上一条/下一条导航）；未装配/后端不可用返回 null
	// （渲染层显示「暂时读不到」而不是「没有匹配」）。
	ipcMain.handle(ipcChannels.sessionsSearchInSession, async (_event, sessionId: unknown, query: unknown) => {
		if (typeof sessionId !== "string" || typeof query !== "string") return null;
		const trimmed = query.trim();
		if (!trimmed || trimmed.length > 256) return null;
		const entry = sessionCatalog.get(sessionId.trim());
		if (!entry) return null;
		if (entry.backend === "dsh") return searchDshSessionInSession(entry, trimmed);
		if (entry.backend === "acp") return searchAcpSessionInSession(entry, trimmed);
		const searcher = deps.sessionMessageSearch;
		// 路径必须像会话文件（无歧义绝对路径 + .jsonl）：sidecar 只索引真实会话文件，
		// 这里再兜一道，避免把任意路径透传给子进程。判定收口在 sessionSearchPath，
		// Windows 反斜杠路径与 POSIX 正斜杠路径都放行（旧实现只认 `/`，Windows 全被拒）。
		if (!searcher || !entry.filePath || !isSessionSearchFilePath(entry.filePath)) return null;
		try {
			return await searcher(entry.filePath, trimmed);
		} catch (error) {
			void appLogger.warn("session", "In-session search failed", { error: error instanceof Error ? error.message : String(error) });
			return null;
		}
	});

	ipcMain.handle(ipcChannels.sessionsCatalogList, async (_event, projectId: string, options?: { scan?: boolean }) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(mainCopy("project.notFound"));
		// 已登记的目录元数据是本机 catalog，远端项目也必须能读取：导入后刷新依赖这条通道。
		// 读取这些记录不等于扫描远端文件；远端分支必须在本地 scanner / WSL 转换前返回。
		if (!isLocalProject(project)) {
			// 目录缓存中的现有记录（上次扫描/运行时创建的合并结果，启动时从磁盘加载）。
			// 这里刻意不用下方本地路径的死链过滤与排序：远端会话的 filePath 是远端绝对路径
			// （如 /home/u/.pi/...），宿主 existsSync 恒 false，套用本地过滤会把整组远端会话滤空。
			const remoteCachedRecords = sessionCatalog
				.listEntries()
				.filter((entry) => entry.projectId === projectId)
				.map((entry) => sessionCatalog.getRecord(entry.id))
				.filter((record): record is SessionRecord => Boolean(record));
			// 远端项目只有目录缓存可读，没有本机扫描可调度。渲染层靠「catalog 已刷新」推送揭开 loading，
			// 所以这里必须主动补一次推送，否则空缓存的远端项目会一直停在「正在加载历史会话…」直到看门狗兜底。
			// scan:false 是渲染层收到推送后的静默回拉（见 useProjectSync 的 onCatalogRefreshed），
			// 对它再推送一次就会自激成环。
			if (options?.scan !== false) {
				const window = getMainWindow();
				if (window && !window.isDestroyed()) {
					setImmediate(() => {
						if (!window.isDestroyed()) window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
					});
				}
			}
			return remoteCachedRecords;
		}
		let projectPath = project.path;
		const settings = settingsStore.get();
		// 第 12 步：扫描按项目身份解析；缺字段的旧项目回退全局设置。
		const projectWsl = resolveProjectWslIdentity(project, settings);
		if (projectWsl !== undefined) {
			projectPath = projectPath.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");
		}
		// 扫描 + 合并 + 运行时绑定（首次同步路径与后台路径共用）
		const runScanAndMerge = async (): Promise<SessionRecord[]> => {
			const scanner = projectWsl !== undefined && resolveWslSessionScanner !== undefined ? await resolveWslSessionScanner(projectWsl) : sessionScanner;
			const summaries = await scanner.list(projectPath);
			const records = await sessionCatalog.mergeScanned(projectId, summaries, projectWsl !== undefined ? { wslDistro: projectWsl.distro, wslUser: projectWsl.user } : {});
			// 重发/编辑 fork 化替换：被子会话接替的旧记录不出现在列表（文件保留可恢复，
			// 用户要求 fork 后历史会话不重复）
			const visibleRecords = records.filter((record) => !record.supersededBy);
			const bindings = sessionRuntimeCoordinator.attachCatalogRuntimes(visibleRecords);
			for (const binding of bindings) {
				const tab = agentManager.list().find((candidate) => candidate.id === binding.agentId);
				if (tab) emitSessionRuntimeEvent(tab.id, agentEventTags.agentsState, tab);
			}
			return visibleRecords;
		};

		// 目录缓存中的现有记录（上次扫描/运行时创建的合并结果，启动时从磁盘加载）
		const cachedRecords = sessionCatalog
			.listEntries()
			// 与扫描路径同口径：替换标记记录直接跳过（都不必走 getRecord）
			.filter((entry) => entry.projectId === projectId && !entry.supersededBy)
			.map((entry) => sessionCatalog.getRecord(entry.id))
			.filter((record): record is SessionRecord => Boolean(record))
			// 与 mergeScanned 同口径排序：小窗项目选择器直接取 sessions[0]，
			// 乱序会把陈旧记录顶到最前（陈旧子代理记录曾因此在小窗报 ENOENT）。
			.sort((left, right) => right.updatedAt - left.updatedAt)
			// 死链过滤：文件已删但清理闸还没跑到（mergeScanned 在后台异步调度）时，
			// 别让「最近会话」落到一个必然 ENOENT 的记录上。
			// 豁免：无文件记录（imagegen/草稿）、dsh（filePath 由 host 侧解析，
			// 本地路径可能不存在）、UNC/WSL 路径（发行版停机时 existsSync
			// 恒 false，不能误藏整组会话）、活绑定运行时（standby 预分配的
			// sessionPath 在 pi 首条消息前不落盘，existsSync 恒 false；若按死链
			// 隐藏，catalog 刷新会把当前选中的草稿剔出列表 → 渲染层
			// replaceProjectSessionsAtom 清空焦点 → 闪回引导页、输入丢失、
			// 引导页重发另建会话留下孤儿空闲 Agent——2026-10-06 事故，与
			// mergeScanned 的 liveness 豁免同口径）。
			.filter((record) => {
				// 跨环境记录不进本机项目的列表（2026-11-05 反馈）：项目在本机模式下运行，条目却
				// 记在 WSL 执行上下文里（filePath 是 /mnt/c/... 这类 Linux 侧路径）。这些路径宿主
				// existsSync 恒 false，读历史必然 ENOENT，豁免死链过滤后就是成片的「点开永远是
				// 空会话」幽灵行——执行环境来回切换一次，同一批会话会各自再抄一份。
				// 与 docs/project-location-architecture.md 同口径：本机与 WSL 是两套执行作用域。
				// 只隐藏不清理：翻回 WSL 时条目原样复现（保 pinned / 手工标题），不做破坏性归并。
				// 反方向（WSL 项目里的本机记录）不隐藏：盘符路径本机能读，时间线可正常打开。
				if (record.environment === "wsl" && projectWsl === undefined) return false;
				if (!record.filePath || record.backend === "dsh" || record.backend === "acp" || record.filePath.startsWith("\\\\")) return true;
				// WSL 条目豁免：catalog 存的是 Linux 侧路径（/home/...），宿主 existsSync 恒
				// false，按死链滤掉会把 WSL 用户的全部会话从列表里抹掉（2026-10-07 升级
				// 0.7.9 反馈：58 条会话一条不少躺在 catalog，列表却全空）。
				// 与 mergeScanned 清理闸（environment=wsl 跳过）同口径。
				if (record.environment === "wsl") return true;
				if (sessionRuntimeCoordinator.hasLiveRuntime(record.id)) return true;
				// TTL 缓存（2027-02 性能审计）：几百条记录逐条同步 stat 是每次 5-30ms 的
				// 固定税（切项目/catalog 刷新都会重拉这条 handler）；存在性 2s 陈旧无害，
				// 清理闸（mergeScanned）仍是权威。
				return sessionFileExistsCached(record.filePath);
			});

		// 纯读路径：事件回调/订阅刷新专用，不再触发扫描（防止推送-拉取循环触发）
		if (options?.scan === false) return cachedRecords;

		// 一律先回磁盘 catalog：打包正式 userData 的历史 JSONL 远多于 dev，
		// 首次 await 全量扫描会让侧栏「正在加载历史会话」卡住整窗。
		// 无缓存时回 []，渲染层保持 loading，等 catalog-refreshed 再揭开。
		scannedProjects.add(projectId);
		catalogScanCoordinator.schedule(projectId, async () => {
			try {
				await runScanAndMerge();
			} catch (error) {
				void appLogger.warn("session", "Background catalog scan failed", {
					projectId,
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				// 成功/失败都通知渲染层：空项目不能永远转圈，失败也要让 UI 可操作。
				const window = getMainWindow();
				if (window && !window.isDestroyed()) {
					window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
				}
			}
		});
		return cachedRecords;
	});
}
