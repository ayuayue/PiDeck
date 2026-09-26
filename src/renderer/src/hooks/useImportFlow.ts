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
	Project,
} from "../../../shared/types";
import { useImportSource, type ImportController } from "./useImportSource";

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
	codexImportController: ImportController<CodexSessionSummary, CodexImportReport>;
	claudeImportController: ImportController<ClaudeSessionSummary, ClaudeImportReport>;
	qoderImportController: ImportController<QoderSessionSummary, QoderImportReport>;
	openCodeImportController: ImportController<OpenCodeSessionSummary, OpenCodeImportReport>;
	zcodeImportController: ImportController<ZCodeSessionSummary, ZCodeImportReport>;
	workbuddyImportController: ImportController<WorkBuddySessionSummary, WorkBuddyImportReport>;
	cursorImportController: ImportController<CursorSessionSummary, CursorImportReport>;
	openCodexImport: (project: Project) => Promise<void>;
	openClaudeImport: (project: Project) => Promise<void>;
	openQoderImport: (project: Project) => Promise<void>;
	openOpenCodeImport: (project: Project) => Promise<void>;
	openZCodeImport: (project: Project) => Promise<void>;
	openWorkBuddyImport: (project: Project) => Promise<void>;
	openCursorImport: (project: Project) => Promise<void>;
}

/**
 * 汇总导入源（Codex / Claude / Qoder / OpenCode / ZCode / WorkBuddy / Cursor）的会话导入流程。
 * 每个源的状态机由 useImportSource 提供，本 hook 只负责把 API 与文案前缀装配进来。
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
		codexImportController: codex.controller,
		claudeImportController: claude.controller,
		qoderImportController: qoder.controller,
		openCodeImportController: openCode.controller,
		zcodeImportController: zcode.controller,
		workbuddyImportController: workbuddy.controller,
		cursorImportController: cursor.controller,
		openCodexImport: codex.open,
		openClaudeImport: claude.open,
		openQoderImport: qoder.open,
		openOpenCodeImport: openCode.open,
		openZCodeImport: zcode.open,
		openWorkBuddyImport: workbuddy.open,
		openCursorImport: cursor.open,
	};
}
