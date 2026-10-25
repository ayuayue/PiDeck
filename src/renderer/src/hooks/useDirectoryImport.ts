import { useCallback, useMemo, useRef, useState } from "react";
import type { DirectoryImportReport, DirectorySessionSourceDir, DirectorySessionSummary, DirectorySourceKind, Project } from "../../../shared/types";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { toggleSelectedPaths } from "../utils/importSessionList";

export type DirectoryImportController = {
	sessions: DirectorySessionSummary[];
	selectedPaths: string[];
	loading: boolean;
	importing: boolean;
	report: DirectoryImportReport | null;
	/** 当前选定的来源目录（null = 还没选，弹窗显示「会话目录列表」首屏） */
	directory: string | null;
	/** 本次扫描的目录形态（ancestor = 选到了 ~/.pi 这类会话树祖先目录，需要提示改选） */
	scanKind: DirectorySourceKind | null;
	/** pi 现有会话目录列表（首屏点选入口；只含真有会话的目录） */
	sources: DirectorySessionSourceDir[];
	sourcesLoading: boolean;
	/** 只看「原目录已失效」的会话：目录被移动/改名后要找回的正是这批 */
	onlyMissingCwd: boolean;
	/** 被该过滤器隐藏的会话数（各导入弹窗据此给出「显示全部」出口） */
	hiddenByFilter: number;
	setOnlyMissingCwd: (value: boolean) => void;
	chooseDirectory: () => Promise<void>;
	/** 点选来源目录列表中的一项：立即扫描该目录 */
	chooseSourceDir: (dir: string) => void;
	/** 清除已选目录，回到「会话目录列表」首屏 */
	clearDirectory: () => void;
	refresh: () => Promise<void>;
	refreshSources: () => Promise<void>;
	toggle: (sourcePath: string) => void;
	/** 全选 / 取消全选；传 sourcePaths 时只在该子集内切换（搜索命中的行），缺省为当前可见（过滤器生效后的）会话。 */
	toggleAll: (sourcePaths?: string[]) => void;
	importSelected: () => Promise<DirectoryImportReport | null>;
};

export type UseDirectoryImportInput = {
	setProjectMenu: (menu: null) => void;
	refreshProjectSessions: (projectId: string) => Promise<unknown>;
	showToast: (message: string, duration?: number) => void;
};

export type UseDirectoryImportOutput = {
	project: Project | null;
	setProject: React.Dispatch<React.SetStateAction<Project | null>>;
	controller: DirectoryImportController;
	open: (project: Project) => void;
};

/**
 * 外置目录会话导入的状态机（侧栏「导入其他目录的会话」）。
 *
 * 与其它导入源（Codex/Claude/...）的差别：源目录不是固定位置，而是用户现选，
 * 所以流程是「选目录 → 扫描 → 勾选 → 挂到当前项目」。
 * 选目录有两条路：默认走「现有会话目录列表」（pi 的 encoded 分组目录名无法辨认，
 * 列表里给出解码后的原工作目录/会话数，点选即扫描）；也可以手选任意目录（旧项目目录本身）。
 * 默认只看原目录已失效的会话——这类才是「目录移动/改名后找不到的历史」；
 * 取消过滤后可以顺手把旧目录里还没入册的会话一起带进来。
 */
export function useDirectoryImport(input: UseDirectoryImportInput): UseDirectoryImportOutput {
	const { setProjectMenu, refreshProjectSessions, showToast } = input;
	const [project, setProject] = useState<Project | null>(null);
	const [directory, setDirectory] = useState<string | null>(null);
	const [sessions, setSessions] = useState<DirectorySessionSummary[]>([]);
	const [scanKind, setScanKind] = useState<DirectorySourceKind | null>(null);
	const [sources, setSources] = useState<DirectorySessionSourceDir[]>([]);
	const [sourcesLoading, setSourcesLoading] = useState(false);
	const [selected, setSelected] = useState<string[]>([]);
	const [onlyMissingCwd, setOnlyMissingCwd] = useState(true);
	const [loading, setLoading] = useState(false);
	const [importing, setImporting] = useState(false);
	const [report, setReport] = useState<DirectoryImportReport | null>(null);
	// 扫描请求序号：列表里连续点选不同目录时只认最后一次响应，防止旧响应把新结果盖回去。
	const scanSeq = useRef(0);

	const scan = useCallback(
		async (target: Project, dir: string, clearReport = true) => {
			const seq = (scanSeq.current += 1);
			setLoading(true);
			if (clearReport) setReport(null);
			try {
				const next = await desktopApi.directorySessions.scan(target.id, dir);
				if (seq !== scanSeq.current) return;
				setSessions(next.sessions);
				setScanKind(next.kind);
				setSelected([]);
			} catch (error) {
				if (seq !== scanSeq.current) return;
				setSessions([]);
				setScanKind(null);
				setSelected([]);
				showToast(
					t("directoryImport.scanFailed", {
						error: error instanceof Error ? error.message : String(error),
					}),
					4000,
				);
			} finally {
				if (seq === scanSeq.current) setLoading(false);
			}
		},
		[showToast],
	);

	const loadSources = useCallback(async () => {
		setSourcesLoading(true);
		try {
			setSources(await desktopApi.directorySessions.listSources());
		} catch (error) {
			setSources([]);
			showToast(
				t("directoryImport.sourcesFailed", {
					error: error instanceof Error ? error.message : String(error),
				}),
				4000,
			);
		} finally {
			setSourcesLoading(false);
		}
	}, [showToast]);

	const chooseDirectory = useCallback(async () => {
		const target = project;
		if (!target) return;
		const picked = await desktopApi.dialog.pickFiles({
			title: t("directoryImport.chooseTitle"),
			includeDirectories: true,
		});
		const dir = picked.find((path) => Boolean(path?.trim()));
		if (!dir) return;
		setDirectory(dir);
		await scan(target, dir);
	}, [project, scan]);

	const chooseSourceDir = useCallback(
		(dir: string) => {
			const target = project;
			if (!target) return;
			setDirectory(dir);
			void scan(target, dir);
		},
		[project, scan],
	);

	const clearDirectory = useCallback(() => {
		// 序号自增让在途扫描响应作废，避免清空后又被旧结果填上。
		scanSeq.current += 1;
		setDirectory(null);
		setSessions([]);
		setScanKind(null);
		setSelected([]);
		setReport(null);
		setLoading(false);
	}, []);

	const refresh = useCallback(async () => {
		if (!project || !directory) return;
		await scan(project, directory, false);
	}, [project, directory, scan]);

	// 过滤只影响展示与「全选」范围：隐藏的行不参与导入。
	const visible = useMemo(() => (onlyMissingCwd ? sessions.filter((session) => !session.projectPathExists) : sessions), [sessions, onlyMissingCwd]);

	const toggle = useCallback((sourcePath: string) => {
		setSelected((current) => (current.includes(sourcePath) ? current.filter((item) => item !== sourcePath) : [...current, sourcePath]));
	}, []);

	const toggleAll = useCallback(
		(sourcePaths?: string[]) => {
			const targets = sourcePaths ?? visible.map((session) => session.sourcePath);
			setSelected((current) => toggleSelectedPaths(current, targets));
		},
		[visible],
	);

	const importSelected = useCallback(async () => {
		if (!project || !directory || selected.length === 0) return null;
		setImporting(true);
		setReport(null);
		try {
			const next = await desktopApi.directorySessions.import(project.id, directory, selected);
			setReport(next);
			// 导入改变的是 catalog 归属：重扫 + 重拉项目会话，行状态（已入册）立即同步。
			await scan(project, directory, false);
			await refreshProjectSessions(project.id);
			showToast(
				t("directoryImport.importDone", {
					imported: next.imported,
					failed: next.failed,
				}),
			);
			return next;
		} catch (error) {
			showToast(
				t("directoryImport.importFailed", {
					error: error instanceof Error ? error.message : String(error),
				}),
				4000,
			);
			return null;
		} finally {
			setImporting(false);
		}
	}, [project, directory, selected, scan, refreshProjectSessions, showToast]);

	const open = useCallback(
		(next: Project) => {
			setProjectMenu(null);
			setProject(next);
			setDirectory(null);
			setSessions([]);
			setScanKind(null);
			setSelected([]);
			setReport(null);
			setOnlyMissingCwd(true);
			// 首屏就是「会话目录列表」，开弹窗即拉一次（列表来自扫描器缓存，成本低）。
			void loadSources();
		},
		[setProjectMenu, loadSources],
	);

	const controller = useMemo<DirectoryImportController>(
		() => ({
			sessions: visible,
			selectedPaths: selected,
			loading,
			importing,
			report,
			directory,
			scanKind,
			sources,
			sourcesLoading,
			onlyMissingCwd,
			hiddenByFilter: sessions.length - visible.length,
			setOnlyMissingCwd,
			chooseDirectory,
			chooseSourceDir,
			clearDirectory,
			refresh,
			refreshSources: loadSources,
			toggle,
			toggleAll,
			importSelected,
		}),
		[visible, sessions.length, selected, loading, importing, report, directory, scanKind, sources, sourcesLoading, onlyMissingCwd, chooseDirectory, chooseSourceDir, clearDirectory, refresh, loadSources, toggle, toggleAll, importSelected],
	);

	return { project, setProject, controller, open };
}
