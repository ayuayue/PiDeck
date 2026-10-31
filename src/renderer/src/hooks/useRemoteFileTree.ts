import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { codeOf, opFail, opOk, type Op } from "../../../shared/op";
import type { FileTreeNode } from "../../../shared/types";
import type { RemoteProject } from "../../../shared/types/project";
import type { ProjectDirectoryEntry, ProjectDirectoryPage } from "../../../shared/types/projectFiles";
import { desktopApi } from "../desktopApi";
import type { ProjectServices } from "../services/projectServiceContracts";
import { acquireProjectFactSubscription } from "../services/projectServiceFactSubscription";
import { parseFileTreeKey, projectFileKey } from "../utils/fileTreeLazy";
import { createLazyDirTreeController, lazyDirTreeInitialState, type LazyDirTreeController, type LazyDirTreeState } from "../utils/lazyDirTree";
import { readRemoteDirectoryPageWithRetry } from "../utils/remoteDirectoryPageRetry";

/**
 * 远端项目的文件树（Phase B）：与本机文件抽屉共用 `lazyDirTree` 内核，数据入口统一走
 * `useProjectServices(project).files.listDirectory`，不再直接碰 preload 目录通道。
 *
 * 为什么不在渲染层一次拉全树：远端每次列目录都是一次 SSH 往返，真实项目会变成几十次。
 * 公共目录页自己带 revision/generation 与显式截断，这里只负责把条目映射成 `FileTreeNode`。
 *
 * 忽略规则与本机文件抽屉对齐（`FileSystemService` 的 ALWAYS_IGNORED_NAMES）：`.git` 与
 * `node_modules` 体量巨大且没有浏览价值，远端面板以前把它们当普通目录展示，`.git/objects`
 * 会直接铺满一屏。`ignored` 只是 Git 修饰，不在这里当过滤条件。
 *
 * 事实失效订阅走 `acquireProjectFactSubscription`（S 的引用计数入口），与 `useProjectServices` 的
 * runtime 共享同一份 preload 订阅：文件抽屉与其它面板同时挂载时，先卸载的一方不会退掉另一方的订阅。
 * 连接换代不在事实回调里重读——那一刻 servicesRef 还是旧代围栏，直接读会抛 GENERATION_STALE；
 * 换代统一由 `services.generation` 的 effect 在新实例就绪后触发。
 */
const IGNORED_NAMES = new Set([".git", "node_modules"]);

export type RemoteFileTree = LazyDirTreeState & {
	/** 按目录键（= 相对项目根的路径）展开/收起。 */
	toggle: (key: string) => void;
	collapseAll: () => void;
	/** 重新读取根层与所有已加载目录；显式刷新会越过暖事实。 */
	refresh: () => Promise<void>;
	/** 按需读取某一层（搜索结果展开祖先目录时用）。 */
	loadDir: (dir: string) => Promise<boolean>;
	/** 展开到指定目录（含全部祖先），并把当前目录切过去。 */
	reveal: (dir: string) => Promise<void>;
	setCurrentDir: (dir: string) => void;
};

function entryToNode(entry: ProjectDirectoryEntry): FileTreeNode {
	const relativePath = entry.relativePath;
	const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
	const isDirectory = entry.type === "directory";
	return {
		name,
		// 远端节点没有本机路径；这里放相对路径，让 fileTreeNodeKey 得到稳定的目录键。
		path: relativePath,
		relativePath,
		target: entry.target,
		type: entry.type,
		// 远端 `hasChildren` 只能是 "unknown"：不能把“没查过”伪装成“没有子项”。
		...(isDirectory ? { hasChildren: entry.hasChildren !== false } : {}),
	};
}

function remotePageNodes(projectId: string, entries: readonly ProjectDirectoryEntry[]): FileTreeNode[] {
	return entries
		.filter((entry) => !IGNORED_NAMES.has(entry.relativePath.slice(entry.relativePath.lastIndexOf("/") + 1)))
		.map((entry) => entryToNode(entry))
		.sort((left, right) => {
			// 与本机文件树同样的顺序：目录在前、同类按名字；远端返回顺序不作为展示契约。
			const byKind = Number(right.type === "directory") - Number(left.type === "directory");
			return byKind !== 0 ? byKind : left.name.localeCompare(right.name);
		});
}

/**
 * 服务异常 → 目录页 Op：controller 只认 `{ok, code}`；稳定码从 ProjectServiceError / IPC Error
 * 的消息里归一（service 层已经做过一次），这里不发明新码。
 */
async function readDirectoryPage(services: ProjectServices, projectId: string, dir: string, force: boolean): Promise<Op<ProjectDirectoryPage>> {
	try {
		return opOk(await services.files.listDirectory({ projectId, relativePath: dir }, { force }));
	} catch (error) {
		return opFail(codeOf(error, "REMOTE_FILE_REQUEST_FAILED"));
	}
}

export function useRemoteFileTree(project: RemoteProject, services: ProjectServices): RemoteFileTree {
	const projectId = project.id;
	const hostId = project.locator.hostId;
	const remotePath = project.locator.remotePath;
	const [state, setState] = useState<LazyDirTreeState>(() => lazyDirTreeInitialState());
	const controller = useRef<LazyDirTreeController | null>(null);
	// 组件重渲染后 loader 必须用当前代的 services；闭包里捕获旧实例会把正常换代读成 stale。
	const servicesRef = useRef(services);
	servicesRef.current = services;
	const projectRef = useRef(project);
	projectRef.current = project;
	/** 目录页自带的连接代（主进程事实）；用于判断事实通知是否仍是同一代。 */
	const pageGeneration = useRef("");
	const observedServicesGeneration = useRef(services.generation);
	/** 已成功读取的目录（相对路径）：换代时按需重读，保留用户展开/收起状态。 */
	const loadedDirs = useRef<Set<string>>(new Set());

	useEffect(() => {
		loadedDirs.current = new Set();
		pageGeneration.current = "";
		// 新 controller 已用当前 services 建好并会自行读根层；换代 effect 不必再重复一次。
		observedServicesGeneration.current = servicesRef.current.generation;
		const reads = createLazyDirTreeController(async (dir, force) => {
			const result = await readRemoteDirectoryPageWithRetry(() => readDirectoryPage(servicesRef.current, projectId, dir, force), { sleep: (attempt) => new Promise((resolve) => setTimeout(resolve, 300 * attempt)) });
			if (!result.ok) {
				loadedDirs.current.delete(dir);
				return { ok: false, code: result.code };
			}
			const page = result.value;
			if (page.generation.length > 0) pageGeneration.current = page.generation;
			loadedDirs.current.add(dir);
			return {
				ok: true,
				page: {
					nodes: remotePageNodes(projectId, page.entries),
					revision: page.revision,
					generation: page.generation,
					truncated: page.truncated,
					dirWatch: page.dirWatch,
				},
			};
		});
		controller.current = reads;
		setState(reads.getState());
		const unsubscribe = reads.subscribe(() => setState(reads.getState()));
		void reads.load("");
		// 事实失效：只重读已加载目录；换代留给下面的 services.generation effect。
		const releaseFacts = acquireProjectFactSubscription(projectRef.current, desktopApi, {
			onStateChange: () => undefined,
			onFactsChange: (change) => {
				if (change.projectId !== projectId) return;
				const active = controller.current;
				if (active === null) return;
				// 空代 = 主进程当时没有稳定身份：不能把它当成同代目录事件，交给换代 effect。
				if (change.generation.length === 0 || change.generation !== pageGeneration.current) return;
				active.applyFactsChange(change);
			},
		});
		return () => {
			releaseFacts();
			unsubscribe();
			reads.dispose();
			if (controller.current === reads) controller.current = null;
		};
		// 项目身份或 host/root 变化都必须换一棵树；generation 变化只做整树失效，不重建 controller。
	}, [projectId, hostId, remotePath]);

	// 连接代变化（状态事件/主进程事实换代）：services 已经是新实例，作废旧树并重读根层与全部已加载目录。
	// 不能只交给 applyFactsChange：首读可能在新实例就绪前被围栏拒绝，此时 controller 内部还没有页面代，
	// 只传 generation 会 no-op；而 refresh() 又会跳过仍在途（其实是旧代）的目录。这里显式 invalidateAll
	// 清掉在途与旧内容，再按「已成功读取的目录」用新实例重读，保留展开/收起意图。
	useEffect(() => {
		if (observedServicesGeneration.current === services.generation) return;
		observedServicesGeneration.current = services.generation;
		// 新一代页面落地前，旧代的目录事实通知一律不采用。
		pageGeneration.current = "";
		const reads = controller.current;
		if (reads === null) return;
		// 已成功读取的目录 + 用户展开中的目录（可能首读在途/刚失败）都要在新代恢复。
		const dirs = [...new Set(["", ...loadedDirs.current, ...reads.getState().expanded])];
		loadedDirs.current = new Set();
		reads.invalidateAll();
		void Promise.all(dirs.map((dir) => reads.load(dir, true)));
	}, [projectId, services.generation]);

	const toggle = useCallback((key: string) => {
		const relative = parseFileTreeKey(key)?.relativePath ?? key;
		controller.current?.toggle(relative);
	}, []);
	const collapseAll = useCallback(() => {
		controller.current?.collapseAll();
	}, []);
	const refresh = useCallback((): Promise<void> => controller.current?.refresh() ?? Promise.resolve(), []);
	const loadDir = useCallback((dir: string): Promise<boolean> => controller.current?.load(dir) ?? Promise.resolve(false), []);
	const reveal = useCallback((dir: string): Promise<void> => controller.current?.reveal(dir) ?? Promise.resolve(), []);
	const setCurrentDir = useCallback((dir: string) => {
		controller.current?.setCurrentDir(dir);
	}, []);

	// 行组件的展开身份是 projectFileKey；controller 内部只认项目相对路径。
	const expanded = useMemo(() => new Set([...state.expanded].map((dir) => projectFileKey({ projectId, relativePath: dir }))), [state.expanded, projectId]);
	return { ...state, expanded, toggle, collapseAll, refresh, loadDir, reveal, setCurrentDir };
}
