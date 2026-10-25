import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { desktopApi as api } from "../../desktopApi";
import { t } from "../../i18n";
import { FILE_TREE_ABSOLUTE_MAX_DEPTH } from "../../../../shared/fileTree";
import type { FileTreeNode } from "../../../../shared/types";
import { findLoadedDirectory, loadProjectFileTree, markFileTreeLoadFailed, mergeFileTreeChildren } from "../../utils/fileTreeLazy";
import { legacyAgentIdsForProject, loadExpandedDirsFromStorage, saveExpandedDirsToStorage } from "../../utils/expandedDirsPersistence";
import type { AgentTab } from "../../../../shared/types";

export interface ProjectFileTreeControllerDeps {
	files: FileTreeNode[];
	setFiles: React.Dispatch<React.SetStateAction<FileTreeNode[]>>;
	refreshFiles: (projectId?: string, silent?: boolean, expandedDirs?: Iterable<string>) => void | Promise<void>;
	beginFileTreeRequest: () => number;
	isFileTreeRequestCurrent: (generation: number, projectId: string) => boolean;
	activeProjectId: string | undefined;
	activeProjectIdRef: MutableRefObject<string | undefined>;
	compactMiddlePackagesEnabled: boolean;
	agentsRef: MutableRefObject<AgentTab[]>;
	refreshProjects: () => Promise<unknown>;
	showToast: (message: string, duration?: number) => void;
}

/**
 * 项目文件树域：展开目录持久化（含 legacy 迁移）、项目切换时的树加载/恢复、
 * 展开目录自愈（restoreExpandedDirs）、折叠中间包自动下钻（drillCompactChain）、
 * 手动展开/收起/全部收起与浅层刷新（refreshVisibleFiles）。
 *
 * - expandedDirs 状态的 owner 在这里；AppSidebar/drawer 只消费；
 * - setFiles/代次闸门（beginFileTreeRequest）由 useProjectSync 提供，经 deps 注入；
 * - 所有 setState updater 保持纯（StrictMode 双跑安全），副作用在 updater 外执行。
 */
export function useProjectFileTreeController({ files, setFiles, refreshFiles, beginFileTreeRequest, isFileTreeRequestCurrent, activeProjectId, activeProjectIdRef, compactMiddlePackagesEnabled, agentsRef, refreshProjects, showToast }: ProjectFileTreeControllerDeps) {
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	// 展开目录镜像：restoreExpandedDirs 在异步回调里读取，避免闭包拿到旧 state。
	const expandedDirsRef = useRef<Set<string>>(expandedDirs);
	expandedDirsRef.current = expandedDirs;
	// 手动刷新/增删改后仍只拉浅层 + 当前展开目录，避免再走整棵 12 层 IPC。
	const refreshVisibleFiles = useCallback((projectId?: string, silent?: boolean) => refreshFiles(projectId, silent, expandedDirs), [expandedDirs, refreshFiles]);
	// 订阅只挂一次（deps 只看项目），回调里必须经 ref 取最新的刷新函数：
	// refreshVisibleFiles 的引用随展开目录变化，闭包旧版会按旧目录集重扫，
	// 把新展开的目录落回「未加载」态（界面显示加载占位）。
	const refreshVisibleFilesRef = useRef(refreshVisibleFiles);
	refreshVisibleFilesRef.current = refreshVisibleFiles;

	// git refs 变了（commit / checkout / reset / fetch）通常意味着工作区内容也换了：
	// 顺手静默重载文件树，让它和文件树着色保持同一节奏——否则会出现「颜色已更新、
	// 列表还列着旧分支文件」的错位（着色由文件树内容变化驱动）。
	// 登记走主进程 GitRefsWatcher，按 (projectId, repoPath) 复用同一份签名轮询，
	// 与 App 的分支徽标订阅共用计数，不额外 spawn git。
	useEffect(() => {
		const projectId = activeProjectId;
		if (!projectId) return;
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
	}, [activeProjectId]);
	// 文件树镜像：restoreExpandedDirs 等异步回调读取当前树，不依赖渲染闭包。
	const filesRef = useRef(files);
	filesRef.current = files;

	const saveExpandedDirs = useCallback((projectId: string, dirs: Set<string>) => saveExpandedDirsToStorage(projectId, dirs), []);
	const loadExpandedDirs = useCallback((projectId: string) => loadExpandedDirsFromStorage(projectId, legacyAgentIdsForProject(agentsRef.current, projectId)), [agentsRef]);

	// 只跟项目：切 tab / agent 数量变化不得清空展开目录，也不得整棵重扫文件树。
	// 先立刻清空旧树，并抬高代次，避免大仓库扫描期间右侧仍显示上一个项目（#159）。
	useEffect(() => {
		if (!activeProjectId) {
			beginFileTreeRequest();
			setFiles((current) => (current.length === 0 ? current : []));
			return;
		}
		const projectId = activeProjectId;
		const generation = beginFileTreeRequest();
		// 空树复用原数组，避免 effect 误触发时用新 [] 把 React 更新打满。
		setFiles((current) => (current.length === 0 ? current : []));
		const dirs = loadExpandedDirs(projectId);
		setExpandedDirs(dirs);
		let cancelled = false;
		void (async () => {
			try {
				const hydrated = await loadProjectFileTree(
					() => api.files.list(projectId, { maxDepth: 0 }),
					dirs,
					() => !cancelled && isFileTreeRequestCurrent(generation, projectId),
					(directory) => api.files.list(projectId, { maxDepth: 0, directory }),
				);
				if (!cancelled && hydrated) setFiles(hydrated);
			} catch (error) {
				if (cancelled) return;
				console.error("[Files] refresh failed", error);
				const message = error instanceof Error ? error.message : String(error);
				const tooLarge = message.match(/FILE_TREE_DIRECTORY_TOO_LARGE:(\d+):(\d+)/);
				const projectDirectoryMissing = message.includes("PROJECT_DIRECTORY_MISSING");
				if (projectDirectoryMissing) {
					// 项目在启动/切换期间被外部删除：清空树后重扫项目 presence，侧栏马上标出失效目录。
					void refreshProjects().catch(() => undefined);
				}
				showToast(tooLarge ? t("app.filesDirectoryTooLarge", { count: tooLarge[1], max: tooLarge[2] }) : projectDirectoryMissing ? t("app.projectDirectoryMissing") : t("app.filesRefreshFailed", { error: message }), 4000);
			}
		})();
		return () => {
			cancelled = true;
		};
		// 该 effect 只应由项目身份切换触发；refreshProjects 是 hook 每次渲染返回的命令，
		// 放入依赖会让 setFiles 后再次触发扫描，形成文件树刷新循环。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeProjectId, beginFileTreeRequest, isFileTreeRequestCurrent, loadExpandedDirs]);

	/**
	 * 展开目录自愈：扫描当前树里「已展开但 children 缺失、hasChildren 仍为 true」
	 * 的目录并按需补拉。修复两类残留场景：
	 * 1. 目录 listing 被代次/切项目丢弃（#159 兜底路径、旧代次 IPC）后，展开态还在；
	 * 2. 历史版本失败未打标（hasChildren=true + 无 children）留下的永久占位。
	 * 返回是否有目录需要修复（含拉取成功/失败）；无目录需要修复时返回 false。
	 */
	const restoreExpandedDirs = useCallback(
		async (projectId: string): Promise<boolean> => {
			// 从镜像 ref 读当前树：本函数在抽屉打开回调里调用，闭包里的 files 可能是旧渲染帧。
			const pending: string[] = [];
			const collectPending = (nodes: FileTreeNode[]) => {
				for (const node of nodes) {
					if (node.type !== "directory") continue;
					// 「已展开 + 无 children + 未标失败」= 占位正在展示或即将展示的目录，需要补拉。
					if (expandedDirsRef.current.has(node.path) && !Array.isArray(node.children) && node.hasChildren !== false) {
						pending.push(node.path);
					}
					if (node.children?.length) collectPending(node.children);
				}
			};
			collectPending(filesRef.current);
			if (pending.length === 0) return false;
			const generation = beginFileTreeRequest();
			// 父目录先补：子目录 listing 依赖父层先 merge 出节点才能写入。
			pending.sort((left, right) => left.length - right.length);
			for (const directory of pending) {
				try {
					const children = await api.files.list(projectId, { maxDepth: 0, directory });
					if (!isFileTreeRequestCurrent(generation, projectId)) return true;
					setFiles((tree) => mergeFileTreeChildren(tree, directory, children));
				} catch (error) {
					console.error("[Files] restore expand failed", directory, error);
					if (!isFileTreeRequestCurrent(generation, projectId)) return true;
					setFiles((tree) => markFileTreeLoadFailed(tree, directory));
				}
			}
			return true;
		},
		[beginFileTreeRequest, isFileTreeRequestCurrent],
	);

	/**
	 * 折叠中间包模式下的「自动下钻」：展开一个目录时，若它是一条
	 * 「单子目录且无文件」的链（Java/Maven、NestJS 等深包结构），
	 * 一次把它加载到链尾，让折叠后的点分节点直接展开到真实内容，
	 * 避免用户逐层点 11 次。
	 */
	async function drillCompactChain(projectId: string, startPath: string) {
		let current = startPath;
		const chain = new Set<string>([startPath]);
		for (let i = 0; i < FILE_TREE_ABSOLUTE_MAX_DEPTH; i++) {
			let children: FileTreeNode[];
			try {
				children = await api.files.list(projectId, { maxDepth: 0, directory: current });
			} catch {
				// 超大目录 / 权限问题：标记当前层「加载失败」，避免展开占位「加载中...」永久盖住文件名；
				// 保留已加载部分（已 merge 的上层不受影响），用户重新点开可自然重试。
				setFiles((tree) => markFileTreeLoadFailed(tree, current));
				break;
			}
			if (activeProjectIdRef.current !== projectId) return;
			setFiles((tree) => mergeFileTreeChildren(tree, current, children));
			// 恰 1 个子目录且无文件 → 继续沿链下钻，并把该子目录也标记展开。
			if (children.length === 1 && children[0].type === "directory") {
				current = children[0].path;
				chain.add(current);
				continue;
			}
			break;
		}
		// 整条链（含链尾）一次性并入展开集合：折叠模式下只有链尾 path 可见，
		// 但关闭折叠后整条链仍需保持展开；持久化保证重新打开项目能重建。
		// setState updater 必须纯（StrictMode 会双跑）：用 ref 镜像同步算 next，副作用放在外面。
		const nextChain = new Set(expandedDirsRef.current);
		for (const p of chain) nextChain.add(p);
		expandedDirsRef.current = nextChain;
		setExpandedDirs(nextChain);
		if (activeProjectIdRef.current === projectId) saveExpandedDirs(projectId, nextChain);
	}

	function toggleDirectory(path: string) {
		// 文件树默认折叠,只有用户显式展开目录才显示子项,避免大仓库一打开就产生视觉噪音。
		// updater 必须纯：next 在外面用 ref 镜像算，持久化副作用与 expanding 判定同源。
		const next = new Set(expandedDirsRef.current);
		const expanding = !next.has(path);
		if (expanding) next.add(path);
		else next.delete(path);
		expandedDirsRef.current = next;
		setExpandedDirs(next);
		// 持久化展开状态到 localStorage，切换回此项目时恢复
		if (activeProjectId) saveExpandedDirs(activeProjectId, next);
		// 首次展开时按需拉这一层；收起或已有 children 只改展开态，避免重复 IPC。
		if (!expanding || !activeProjectId) return;
		const projectId = activeProjectId;
		if (compactMiddlePackagesEnabled) {
			// 折叠模式下沿单子目录链自动下钻，一次展开整条包链
			void drillCompactChain(projectId, path);
			return;
		}
		// 「已加载就跳过」的判据必须在 updater 之外：updater 必须是纯函数（StrictMode 会跑两遍），
		// 把判据 + IPC 写进 updater 会让 dev 下一次展开发两次 files:list。直接读当前树的 files
		//（hook 每次渲染都拿到最新值）；拉取回来的 merge 本身幂等（无变化返回原数组）。
		if (findLoadedDirectory(files, path)) return;
		void api.files
			.list(projectId, { maxDepth: 0, directory: path })
			.then((children) => {
				if (activeProjectIdRef.current !== projectId) return;
				setFiles((tree) => mergeFileTreeChildren(tree, path, children));
			})
			.catch((error) => {
				// 拉取失败（目录被删/无权限/超上限）：不打标的话该目录会永远停在
				// 「加载中...」占位。标记 hasChildren=false 让占位立刻消失；重新点开
				// 目录时 findLoadedDirectory 未命中会再次拉取，形成重试入口。
				// console.error 在这里属于异步回调，不是 setState updater 副作用，保留。
				console.error("[Files] expand failed", error);
				if (activeProjectIdRef.current !== projectId) return;
				setFiles((tree) => markFileTreeLoadFailed(tree, path));
			});
	}

	function collapseAllDirectories() {
		const collapsedDirs = new Set<string>();
		setExpandedDirs(collapsedDirs);
		// 全部收起同样持久化，避免用户切换项目后又恢复此前展开的目录。
		if (activeProjectId) saveExpandedDirs(activeProjectId, collapsedDirs);
	}

	return {
		expandedDirs,
		refreshVisibleFiles,
		restoreExpandedDirs,
		drillCompactChain,
		toggleDirectory,
		collapseAllDirectories,
	};
}
