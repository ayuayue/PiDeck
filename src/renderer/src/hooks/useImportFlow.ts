import type {
	CodexImportReport,
	CodexSessionSummary,
	ClaudeImportReport,
	ClaudeSessionSummary,
	QoderImportReport,
	QoderSessionSummary,
	OpenCodeImportReport,
	OpenCodeSessionSummary,
	ZCodeImportReport,
	ZCodeSessionSummary,
	WorkBuddyImportReport,
	WorkBuddySessionSummary,
	CursorImportReport,
	CursorSessionSummary,
	KimiImportReport,
	KimiSessionSummary,
	KimiWorkImportReport,
	KimiWorkSessionSummary,
	KimiWorkShareRootInfo,
	MinimaxImportReport,
	MinimaxSessionSummary,
	Project,
} from "../../../shared/types";
import { useImportSource, type ImportController } from "./useImportSource";
import { useKimiWorkImport, type KimiWorkImportController } from "./useKimiWorkImport";

function getSelectableCodexImportPaths(sessions: CodexSessionSummary[]) {
	return sessions.filter((session) => session.threadSource !== "subagent").map((session) => session.sourcePath);
}

export type { ImportController };

export interface UseImportFlowInput {
	setProjectMenu: (menu: null) => void;
	refreshProjectSessions: (projectId: string) => Promise<unknown>;
	showToast: (message: string, duration?: number) => void;
	/** API: scan Codex sessions */
	scanCodexSessions: (projectId: string) => Promise<CodexSessionSummary[]>;
	/** API: import Codex sessions */
	importCodexSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<CodexImportReport>;
	/** API: scan Claude sessions */
	scanClaudeSessions: (projectId: string) => Promise<ClaudeSessionSummary[]>;
	/** API: import Claude sessions */
	importClaudeSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<ClaudeImportReport>;
	/** API: scan Qoder sessions */
	scanQoderSessions: (projectId: string) => Promise<QoderSessionSummary[]>;
	/** API: import Qoder sessions */
	importQoderSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<QoderImportReport>;
	/** API: scan OpenCode sessions */
	scanOpenCodeSessions: (projectId: string) => Promise<OpenCodeSessionSummary[]>;
	/** API: import OpenCode sessions */
	importOpenCodeSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<OpenCodeImportReport>;
	/** API: scan ZCode sessions */
	scanZCodeSessions: (projectId: string) => Promise<ZCodeSessionSummary[]>;
	/** API: import ZCode sessions */
	importZCodeSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<ZCodeImportReport>;
	/** API: scan WorkBuddy sessions */
	scanWorkBuddySessions: (projectId: string) => Promise<WorkBuddySessionSummary[]>;
	/** API: import WorkBuddy sessions */
	importWorkBuddySessionsApi: (projectId: string, sourcePaths: string[]) => Promise<WorkBuddyImportReport>;
	/** API: scan Cursor sessions */
	scanCursorSessions: (projectId: string) => Promise<CursorSessionSummary[]>;
	/** API: import Cursor sessions */
	importCursorSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<CursorImportReport>;
	/** API: scan Kimi Code sessions */
	scanKimiSessions: (projectId: string) => Promise<KimiSessionSummary[]>;
	/** API: import Kimi Code sessions */
	importKimiSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<KimiImportReport>;
	/** API: 探测 Kimi Work 数据目录（settings 手动指定 > daimon-storage.json > 默认位置） */
	describeKimiWorkShareRoot: () => Promise<KimiWorkShareRootInfo>;
	/** API: scan Kimi Work sessions */
	scanKimiWorkSessions: (projectId: string) => Promise<KimiWorkSessionSummary[]>;
	/** API: import Kimi Work sessions */
	importKimiWorkSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<KimiWorkImportReport>;
	/** API: 读取设置（kimiWorkShareRoot 手动指定目录） */
	getSettings: () => Promise<{ kimiWorkShareRoot?: string }>;
	/** API: 更新设置（kimiWorkShareRoot 手动指定目录） */
	updateSettings: (patch: { kimiWorkShareRoot?: string }) => Promise<unknown>;
	/** API: scan MinimaxCode sessions */
	scanMinimaxSessions: (projectId: string) => Promise<MinimaxSessionSummary[]>;
	/** API: import MinimaxCode sessions */
	importMinimaxSessionsApi: (projectId: string, sourcePaths: string[]) => Promise<MinimaxImportReport>;
	/** Translation function */
	t: Parameters<typeof useImportSource<CodexSessionSummary, CodexImportReport>>[0]["t"];
}

export interface UseImportFlowOutput {
	codexImportProject: Project | null;
	setCodexImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
	claudeImportProject: Project | null;
	setClaudeImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
	qoderImportProject: Project | null;
	setQoderImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
	openCodeImportProject: Project | null;
	setOpenCodeImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
	zcodeImportProject: Project | null;
	setZcodeImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
	workbuddyImportProject: Project | null;
	setWorkbuddyImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
	cursorImportProject: Project | null;
	setCursorImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
	kimiImportProject: Project | null;
	setKimiImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
	kimiWorkImportProject: Project | null;
	setKimiWorkImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
	minimaxImportProject: Project | null;
	setMinimaxImportProject: React.Dispatch<React.SetStateAction<Project | null>>;
	codexImportController: ImportController<CodexSessionSummary, CodexImportReport>;
	claudeImportController: ImportController<ClaudeSessionSummary, ClaudeImportReport>;
	qoderImportController: ImportController<QoderSessionSummary, QoderImportReport>;
	openCodeImportController: ImportController<OpenCodeSessionSummary, OpenCodeImportReport>;
	zcodeImportController: ImportController<ZCodeSessionSummary, ZCodeImportReport>;
	workbuddyImportController: ImportController<WorkBuddySessionSummary, WorkBuddyImportReport>;
	cursorImportController: ImportController<CursorSessionSummary, CursorImportReport>;
	kimiImportController: ImportController<KimiSessionSummary, KimiImportReport>;
	kimiWorkImportController: KimiWorkImportController;
	minimaxImportController: ImportController<MinimaxSessionSummary, MinimaxImportReport>;
	openCodexImport: (project: Project) => Promise<void>;
	openClaudeImport: (project: Project) => Promise<void>;
	openQoderImport: (project: Project) => Promise<void>;
	openOpenCodeImport: (project: Project) => Promise<void>;
	openZCodeImport: (project: Project) => Promise<void>;
	openWorkBuddyImport: (project: Project) => Promise<void>;
	openCursorImport: (project: Project) => Promise<void>;
	openKimiImport: (project: Project) => Promise<void>;
	openKimiWorkImport: (project: Project) => Promise<void>;
	openMinimaxImport: (project: Project) => Promise<void>;
}

/**
 * 汇总导入源（Codex / Claude / Qoder / OpenCode / ZCode / WorkBuddy / Cursor / Kimi / Kimi Work）的会话导入流程。
 * 每个源的状态机由 useImportSource 提供，本 hook 只负责把 API 与文案前缀装配进来。
 * Kimi Work（桌面版）额外叠加数据目录探测/手动指定（useKimiWorkImport）。
 */
export function useImportFlow(input: UseImportFlowInput): UseImportFlowOutput {
	const base = {
		setProjectMenu: input.setProjectMenu,
		refreshProjectSessions: input.refreshProjectSessions,
		showToast: input.showToast,
		t: input.t,
	};

	const codex = useImportSource<CodexSessionSummary, CodexImportReport>({
		...base,
		copyPrefix: "codex",
		scan: input.scanCodexSessions,
		importSessions: input.importCodexSessionsApi,
		selectablePaths: getSelectableCodexImportPaths,
		// Codex 会话量大且默认全部可导，扫描后预选可省一次全选点击。
		preselectOnScan: true,
	});

	const claude = useImportSource<ClaudeSessionSummary, ClaudeImportReport>({
		...base,
		copyPrefix: "claude",
		scan: input.scanClaudeSessions,
		importSessions: input.importClaudeSessionsApi,
	});

	const qoder = useImportSource<QoderSessionSummary, QoderImportReport>({
		...base,
		copyPrefix: "qoder",
		scan: input.scanQoderSessions,
		importSessions: input.importQoderSessionsApi,
	});

	const openCode = useImportSource<OpenCodeSessionSummary, OpenCodeImportReport>({
		...base,
		copyPrefix: "opencode",
		scan: input.scanOpenCodeSessions,
		importSessions: input.importOpenCodeSessionsApi,
	});

	const zcode = useImportSource<ZCodeSessionSummary, ZCodeImportReport>({
		...base,
		copyPrefix: "zcode",
		scan: input.scanZCodeSessions,
		importSessions: input.importZCodeSessionsApi,
	});

	const workbuddy = useImportSource<WorkBuddySessionSummary, WorkBuddyImportReport>({
		...base,
		copyPrefix: "workbuddy",
		scan: input.scanWorkBuddySessions,
		importSessions: input.importWorkBuddySessionsApi,
	});

	const cursor = useImportSource<CursorSessionSummary, CursorImportReport>({
		...base,
		copyPrefix: "cursor",
		scan: input.scanCursorSessions,
		importSessions: input.importCursorSessionsApi,
	});

	const kimi = useImportSource<KimiSessionSummary, KimiImportReport>({
		...base,
		copyPrefix: "kimi",
		scan: input.scanKimiSessions,
		importSessions: input.importKimiSessionsApi,
	});

	// Kimi Work 数据目录位置不固定，open 时先 describe 再 scan；弹窗头部展示探测结果。
	const kimiWork = useKimiWorkImport({
		...base,
		describeShareRoot: input.describeKimiWorkShareRoot,
		scanKimiWorkSessions: input.scanKimiWorkSessions,
		importKimiWorkSessionsApi: input.importKimiWorkSessionsApi,
		getSettings: input.getSettings,
		updateSettings: input.updateSettings,
	});

	// MinimaxCode 数据目录固定（~/.minimax），无 describe 步骤，与其他简单源同构
	const minimax = useImportSource<MinimaxSessionSummary, MinimaxImportReport>({
		...base,
		copyPrefix: "minimax",
		scan: input.scanMinimaxSessions,
		importSessions: input.importMinimaxSessionsApi,
	});

	return {
		codexImportProject: codex.project,
		setCodexImportProject: codex.setProject,
		claudeImportProject: claude.project,
		setClaudeImportProject: claude.setProject,
		qoderImportProject: qoder.project,
		setQoderImportProject: qoder.setProject,
		openCodeImportProject: openCode.project,
		setOpenCodeImportProject: openCode.setProject,
		zcodeImportProject: zcode.project,
		setZcodeImportProject: zcode.setProject,
		workbuddyImportProject: workbuddy.project,
		setWorkbuddyImportProject: workbuddy.setProject,
		cursorImportProject: cursor.project,
		setCursorImportProject: cursor.setProject,
		kimiImportProject: kimi.project,
		setKimiImportProject: kimi.setProject,
		kimiWorkImportProject: kimiWork.project,
		setKimiWorkImportProject: kimiWork.setProject,
		minimaxImportProject: minimax.project,
		setMinimaxImportProject: minimax.setProject,
		codexImportController: codex.controller,
		claudeImportController: claude.controller,
		qoderImportController: qoder.controller,
		openCodeImportController: openCode.controller,
		zcodeImportController: zcode.controller,
		workbuddyImportController: workbuddy.controller,
		cursorImportController: cursor.controller,
		kimiImportController: kimi.controller,
		kimiWorkImportController: kimiWork.controller,
		minimaxImportController: minimax.controller,
		openCodexImport: codex.open,
		openClaudeImport: claude.open,
		openQoderImport: qoder.open,
		openOpenCodeImport: openCode.open,
		openZCodeImport: zcode.open,
		openWorkBuddyImport: workbuddy.open,
		openCursorImport: cursor.open,
		openKimiImport: kimi.open,
		openKimiWorkImport: kimiWork.open,
		openMinimaxImport: minimax.open,
	};
}
