import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { desktopApi as api } from "../../desktopApi";
import { t } from "../../i18n";
import { codeOf } from "../../../../shared/op";
import { FILE_TREE_ABSOLUTE_MAX_DEPTH, FILE_TREE_MAX_DIRECTORY_ENTRIES } from "../../../../shared/fileTree";
import type { ProjectServices } from "../../services/projectServiceContracts";
import type { FileTreeNode } from "../../../../shared/types";
import type { ProjectDirectoryEntry } from "../../../../shared/types/projectFiles";
import { migrateExpandedDirKeys } from "../../utils/fileTreeLazy";
import { localExpandedDirKey, localExpandedDirRelative } from "../../utils/localFileTreeKeys";
import { legacyAgentIdsForProject, loadExpandedDirsFromStorage, saveExpandedDirsToStorage } from "../../utils/expandedDirsPersistence";
import type { AgentTab } from "../../../../shared/types";
import { createLazyDirTreeController, type LazyDirTreeController } from "../../utils/lazyDirTree";

export interface ProjectFileTreeControllerDeps {
	setFiles: React.Dispatch<React.SetStateAction<FileTreeNode[]>>;
	activeProjectId: string | undefined;
	/** 当前项目的服务（本地项目才有本地树）；项目尚未解析出 Project 时为 null。 */
	services: ProjectServices | null;
	/** 该 projectId 是否本机项目：文件树只服务本机目录，远端项目一律不发起本地 files:list。 */
	isLocalProjectId: (projectId: string) => boolean;
	compactMiddlePackagesEnabled: boolean;
	agentsRef: MutableRefObject<AgentTab[]>;
	refreshProjects: () => Promise<unknown>;
	showToast: (message: string, duration?: number) => void;
}

/** 公共目录页条目 → 本机文件树节点：保留绝对路径与排序元数据，行为对齐旧的 files.list。 */
function directoryPageNode(entry: ProjectDirectoryEntry): FileTreeNode {
	const name = entry.relativePath.slice(entry.relativePath.lastIndexOf("/") + 1);
	const path = entry.path ?? entry.relativePath;
	const isDirectory = entry.type === "directory";
	return {
		name,
		path,
		displayPath: path,
		relativePath: entry.relativePath,
		target: entry.target,
		type: entry.type,
		...(isDirectory ? { hasChildren: entry.hasChildren !== false } : {}),
		...(entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs }),
		...(entry.ctimeMs === undefined ? {} : { ctimeMs: entry.ctimeMs }),
		...(entry.size === undefined ? {} : { size: entry.size }),
	};
}

/**
 * 项目文件树域：展开目录持久化（含 legacy 迁移）、项目切换时的树加载/恢复、
 * 展开目录自愈、折叠中间包自动下钻、手动展开/收起/全部收起与浅层刷新。
 *
 * v5 W5：本机树与远端树共用 `lazyDirTree` 内核（按目录代次、迟到结果丢弃、
 * 失败清空、显式 refresh、展开/收起）。`files` 仍是全局展示投影（Git 着色、
 * 搜索、文件链接都读它），但唯一写者是这里的 controller；不再用递归 merge
 * 维护第二份 children。展开键继续使用本机节点当前的 `relative:` 身份，controller 内部用项目相对路径；
 * legacy 绝对路径键在根层载入后逐层迁移。
 */
export function useProjectFileTreeController({ setFiles, activeProjectId, services, isLocalProjectId, compactMiddlePackagesEnabled, agentsRef, refreshProjects, showToast }: ProjectFileTreeControllerDeps) {
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
	const controllerRef = useRef<LazyDirTreeController | null>(null);
	// 本地树只消费 ProjectServices；服务实例随项目解析变化，loader 必须读最新一份。
	const servicesRef = useRef(services);
	servicesRef.current = services;
	// 这两个回调由 App 每次渲染重建；放进 deps 会让项目树 effect 反复重跑，只能经 ref 取最新值。
	const refreshProjectsRef = useRef(refreshProjects);
	refreshProjectsRef.current = refreshProjects;
	const showToastRef = useRef(showToast);
	showToastRef.current = showToast;
	const saveExpandedDirs = useCallback((projectId: string, dirs: Set<string>) => saveExpandedDirsToStorage(projectId, dirs), []);
	const loadExpandedDirs = useCallback((projectId: string) => loadExpandedDirsFromStorage(projectId, legacyAgentIdsForProject(agentsRef.current, projectId)), [agentsRef]);

	const reportError = useCallback((code: string) => {
		const tooLarge = code.match(/FILE_TREE_DIRECTORY_TOO_LARGE:(\d+):(\d+)/);
		const projectDirectoryMissing = code.includes("PROJECT_DIRECTORY_MISSING");
		if (projectDirectoryMissing) void refreshProjectsRef.current().catch(() => undefined);
		showToastRef.current(tooLarge ? t("app.filesDirectoryTooLarge", { count: tooLarge[1], max: tooLarge[2] }) : projectDirectoryMissing ? t("app.projectDirectoryMissing") : t("app.filesRefreshFailed", { error: code }), 4000);
	}, []);

	useEffect(() => {
		const projectId = activeProjectId;
		if (!projectId || servicesRef.current === null || !isLocalProjectId(projectId)) {
			controllerRef.current = null;
			setFiles((current) => (current.length === 0 ? current : []));
			setExpandedDirs((current) => (current.size === 0 ? current : new Set()));
			return;
		}

		// 项目切换：先清空旧树，再由 controller 读根层，避免大仓库扫描期间显示上一个项目。
		setFiles((current) => (current.length === 0 ? current : []));
		setExpandedDirs((current) => (current.size === 0 ? current : new Set()));
		const stored = loadExpandedDirs(projectId);
		const controller = createLazyDirTreeController(async (dir, force) => {
			const active = servicesRef.current;
			if (active === null) return { ok: false, code: "PROJECT_FILE_SERVICE_UNAVAILABLE" };
			try {
				// 与远端同一份公共目录页：本机条目额外带绝对路径与排序元数据（ProjectDirectoryEntry.path）。
				const page = await active.files.listDirectory({ projectId, relativePath: dir }, { force });
				// 本机旧路径对超大目录是硬拒绝（不返回半棵树）：保持同一提示口径。
				if (page.truncated) return { ok: false, code: `FILE_TREE_DIRECTORY_TOO_LARGE:${page.totalEntries ?? page.entries.length}:${FILE_TREE_MAX_DIRECTORY_ENTRIES}` };
				return { ok: true, page: { nodes: page.entries.map(directoryPageNode), revision: page.revision, generation: page.generation } };
			} catch (error) {
				// 服务层已把 IPC 失败归一成稳定码；刷新入口只按稳定码归类提示。
				return { ok: false, code: codeOf(error, "PROJECT_FILE_READ_FAILED") };
			}
		});
		controllerRef.current = controller;

		let reportedError: string | null = null;
		const noteError = () => {
			const error = controller.getState().error;
			if (error === null || error === reportedError) return;
			reportedError = error;
			reportError(error);
		};
		let lastMirrored = controller.getState().nodes;
		let lastExpanded = new Set<string>();
		let hydrated = false;
		const sync = () => {
			const state = controller.getState();
			// nodes 只有在子项/展开集变化时才换引用：加载态/错误不会推进文件内容代次。
			if (state.nodes !== lastMirrored) {
				lastMirrored = state.nodes;
				setFiles(state.nodes);
			}
			const next = new Set<string>();
			for (const dir of state.expanded) next.add(localExpandedDirKey(projectId, dir));
			let changed = next.size !== lastExpanded.size;
			if (!changed) {
				for (const key of next) {
					if (!lastExpanded.has(key)) {
						changed = true;
						break;
					}
				}
			}
			if (!changed) return;
			lastExpanded = next;
			setExpandedDirs(next);
			if (hydrated) saveExpandedDirs(projectId, next);
		};
		const unsubscribe = controller.subscribe(sync);

		void (async () => {
			await controller.load("");
			if (controllerRef.current !== controller) return;
			noteError();

			// 旧版展开集是绝对路径：逐层把当前树里看得见的别名换成项目键，读完父层后再迁移更深一层。
			let keys = stored;
			let includeRoot = false;
			for (let depth = 0; depth <= FILE_TREE_ABSOLUTE_MAX_DEPTH; depth += 1) {
				if (controllerRef.current !== controller) return;
				const migrated = migrateExpandedDirKeys(controller.getState().nodes, keys);
				keys = migrated.keys;
				const dirs: string[] = [];
				for (const key of keys) {
					const relative = localExpandedDirRelative(key, controller.getState().nodes);
					if (relative !== undefined) dirs.push(relative);
				}
				await controller.hydrate(dirs, includeRoot);
				includeRoot = false;
				if (!migrated.changed) break;
			}

			if (controllerRef.current !== controller) return;
			hydrated = true;
			noteError();
			sync();
			// 初始加载期间用户也可能展开目录；以当前展开集为准落盘，未迁移的旧键保留。
			saveExpandedDirs(projectId, new Set([...keys, ...lastExpanded]));
		})();

		return () => {
			unsubscribe();
			controller.dispose();
			if (controllerRef.current === controller) controllerRef.current = null;
		};
	}, [activeProjectId, isLocalProjectId, loadExpandedDirs, reportError, saveExpandedDirs, services?.projectId, setFiles]);

	/** 手动刷新/增删改后：重读根层与全部已加载目录；错误统一走与项目切换相同的文案。 */
	const refreshVisibleFiles = useCallback(
		(projectId?: string, silent?: boolean) => {
			const controller = controllerRef.current;
			if (!controller) return;
			if (projectId !== undefined && projectId !== activeProjectId) return;
			return controller.refresh().then(() => {
				const error = controller.getState().error;
				if (error !== null) reportError(error);
				else if (!silent) showToastRef.current(t("app.filesRefreshed", {}), 1800);
			});
		},
		[activeProjectId, reportError],
	);

	// 订阅只挂一次（deps 只看项目），回调里必须经 ref 取最新的刷新函数：
	// refreshVisibleFiles 的引用随展开目录变化，闭包旧版会按旧目录集重扫。
	const refreshVisibleFilesRef = useRef(refreshVisibleFiles);
	refreshVisibleFilesRef.current = refreshVisibleFiles;
	// git refs 变了（commit / checkout / reset / fetch）通常意味着工作区内容也换了：
	// 静默重载文件树，让树与文件树着色保持同一节奏。登记走主进程 GitRefsWatcher，
	// 按 (projectId, repoPath) 复用同一份签名轮询，与分支徽标订阅共用计数，不额外 spawn git。
	useEffect(() => {
		const projectId = activeProjectId;
		if (!projectId || !isLocalProjectId(projectId)) return;
		let stopped = false;
		let watchId: string | null = null;
		const offRefsChanged = api.git.onRefsChanged((changedWatchId) => {
			if (stopped || changedWatchId !== watchId) return;
			void refreshVisibleFilesRef.current(projectId, true);
		});
		// 订阅失败静默降级（非 git 项目 / git 未安装）：文件树照常可用，只是不跟随 refs。
		const watchPromise = api.git.watchRefs(projectId).catch(() => null);
		void watchPromise.then((id) => {
			watchId = id;
		});
		return () => {
			stopped = true;
			offRefsChanged();
			// 竞态安全：卸载时 watch 可能尚未 resolve，退订等它落地后执行。
			void watchPromise.then((id) => {
				if (id) void api.git.unwatchRefs(id);
			});
		};
	}, [activeProjectId, isLocalProjectId]);

	/** 文件链接/搜索 reveal 前的自愈：只补读已展开但尚未落地的目录。 */
	const restoreExpandedDirs = useCallback(
		async (projectId: string): Promise<boolean> => {
			const controller = controllerRef.current;
			if (!controller || projectId !== activeProjectId || !isLocalProjectId(projectId)) return false;
			return controller.loadMissing([...controller.getState().expanded]);
		},
		[activeProjectId, isLocalProjectId],
	);

	/** 折叠中间包：只有单子目录且无文件时继续下钻，整条链一次展开。 */
	const drillCompactChain = useCallback(
		async (projectId: string, startPath: string) => {
			const controller = controllerRef.current;
			if (!controller || projectId !== activeProjectId || !isLocalProjectId(projectId)) return;
			const start = localExpandedDirRelative(startPath, controller.getState().nodes);
			if (start === undefined) return;
			await controller.drill(start, (entries) => (entries.length === 1 && entries[0].type === "directory" ? entries[0].relativePath : null), FILE_TREE_ABSOLUTE_MAX_DEPTH);
		},
		[activeProjectId, isLocalProjectId],
	);

	const toggleDirectory = useCallback(
		(path: string) => {
			const controller = controllerRef.current;
			if (!controller || !activeProjectId || !isLocalProjectId(activeProjectId)) return;
			const relative = localExpandedDirRelative(path, controller.getState().nodes);
			if (relative === undefined) return;
			const expanding = !controller.getState().expanded.has(relative);
			// 收起永远只改动这一层；折叠模式下只有“首次展开”才自动下钻整条包链。
			if (compactMiddlePackagesEnabled && expanding) {
				void drillCompactChain(activeProjectId, path);
				return;
			}
			controller.toggle(relative);
		},
		[activeProjectId, compactMiddlePackagesEnabled, drillCompactChain, isLocalProjectId],
	);

	const collapseAllDirectories = useCallback(() => {
		controllerRef.current?.collapseAll();
		if (activeProjectId) saveExpandedDirs(activeProjectId, new Set());
	}, [activeProjectId, saveExpandedDirs]);

	return {
		expandedDirs,
		refreshVisibleFiles,
		restoreExpandedDirs,
		drillCompactChain,
		toggleDirectory,
		collapseAllDirectories,
	};
}
