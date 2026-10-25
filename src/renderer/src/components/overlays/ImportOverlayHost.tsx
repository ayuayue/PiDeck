import type { ReactNode } from "react";
import { ClaudeImportModal, CodexImportModal, CursorImportModal, DirectoryImportModal, KimiImportModal, KimiWorkImportModal, MinimaxImportModal, OpenCodeImportModal, QoderImportModal, WorkBuddyImportModal, ZCodeImportModal } from "../app/ImportModals";
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
	MinimaxImportReport,
	MinimaxSessionSummary,
	DirectoryImportReport,
	DirectorySessionSummary,
	Project,
} from "../../../../shared/types";
import type { ImportController } from "../../hooks/useImportFlow";
import type { KimiWorkImportController } from "../../hooks/useKimiWorkImport";
import type { DirectoryImportController } from "../../hooks/useDirectoryImport";

export type ImportOverlayHostProps =
	| { kind: "codex"; project: Project; controller: ImportController<CodexSessionSummary, CodexImportReport>; onClose: () => void }
	| { kind: "claude"; project: Project; controller: ImportController<ClaudeSessionSummary, ClaudeImportReport>; onClose: () => void }
	| { kind: "qoder"; project: Project; controller: ImportController<QoderSessionSummary, QoderImportReport>; onClose: () => void }
	| { kind: "opencode"; project: Project; controller: ImportController<OpenCodeSessionSummary, OpenCodeImportReport>; onClose: () => void }
	| { kind: "zcode"; project: Project; controller: ImportController<ZCodeSessionSummary, ZCodeImportReport>; onClose: () => void }
	| { kind: "workbuddy"; project: Project; controller: ImportController<WorkBuddySessionSummary, WorkBuddyImportReport>; onClose: () => void }
	| { kind: "cursor"; project: Project; controller: ImportController<CursorSessionSummary, CursorImportReport>; onClose: () => void }
	| { kind: "kimi"; project: Project; controller: ImportController<KimiSessionSummary, KimiImportReport>; onClose: () => void }
	| { kind: "minimax"; project: Project; controller: ImportController<MinimaxSessionSummary, MinimaxImportReport>; onClose: () => void }
	/** Kimi Work（桌面版）控制器多带数据目录探测结果与手动指定状态。 */
	| { kind: "kimiwork"; project: Project; controller: KimiWorkImportController; onClose: () => void }
	/** 目录导入源目录现选，控制器多带「已选目录 / 只看失效目录」两组状态。 */
	| { kind: "directory"; project: Project; controller: DirectoryImportController; onClose: () => void };

export function renderImportError(error: string | null): ReactNode {
	if (!error) return null;
	return (
		<div
			className="import-overlay-error-surface"
			role="alert"
			aria-live="assertive"
			style={{
				position: "fixed",
				top: "calc(var(--window-drag-height, 0px) + 16px)",
				left: "50%",
				transform: "translateX(-50%)",
				zIndex: 1100,
				maxWidth: "min(560px, calc(100vw - 32px))",
				padding: "10px 16px",
				border: "1px solid var(--color-danger)",
				borderRadius: "var(--radius-md)",
				background: "var(--color-danger-soft)",
				color: "var(--color-danger)",
				boxShadow: "var(--shadow-xl)",
				pointerEvents: "auto",
			}}
		>
			<strong>{error}</strong>
		</div>
	);
}

/** A provider switch lives here so Sidebar only chooses a provider/project. */
export function ImportOverlayHost(props: ImportOverlayHostProps) {
	if (props.kind === "directory")
		return (
			<DirectoryImportModal
				project={props.project}
				{...props.controller}
				onClose={props.onClose}
				onRefresh={props.controller.refresh}
				onToggle={props.controller.toggle}
				onToggleAll={props.controller.toggleAll}
				onImport={() => void props.controller.importSelected()}
				onChooseDirectory={() => void props.controller.chooseDirectory()}
				onChooseSourceDir={props.controller.chooseSourceDir}
				onClearDirectory={props.controller.clearDirectory}
				onRefreshSources={() => void props.controller.refreshSources()}
				onSetOnlyMissingCwd={props.controller.setOnlyMissingCwd}
				hiddenByFilter={props.controller.hiddenByFilter}
			/>
		);
	if (props.kind === "claude")
		return (
			<>
				<ClaudeImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />
				{renderImportError(props.controller.error)}
			</>
		);
	if (props.kind === "qoder")
		return (
			<>
				<QoderImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />
				{renderImportError(props.controller.error)}
			</>
		);
	if (props.kind === "opencode")
		return (
			<>
				<OpenCodeImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />
				{renderImportError(props.controller.error)}
			</>
		);
	if (props.kind === "zcode")
		return (
			<>
				<ZCodeImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />
				{renderImportError(props.controller.error)}
			</>
		);
	if (props.kind === "workbuddy")
		return (
			<>
				<WorkBuddyImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />
				{renderImportError(props.controller.error)}
			</>
		);
	if (props.kind === "cursor")
		return (
			<>
				<CursorImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />
				{renderImportError(props.controller.error)}
			</>
		);
	if (props.kind === "kimi")
		return (
			<>
				<KimiImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />
				{renderImportError(props.controller.error)}
			</>
		);
	if (props.kind === "minimax")
		return (
			<>
				<MinimaxImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />
				{renderImportError(props.controller.error)}
			</>
		);
	if (props.kind === "kimiwork")
		return (
			<>
				<KimiWorkImportModal
					project={props.project}
					{...props.controller}
					onClose={props.onClose}
					onRefresh={props.controller.refresh}
					onToggle={props.controller.toggle}
					onToggleAll={props.controller.toggleAll}
					onImport={() => void props.controller.importSelected()}
					onSetCustomRootDraft={props.controller.setCustomRootDraft}
					onApplyCustomRoot={() => void props.controller.applyCustomRoot()}
					onClearCustomRoot={() => void props.controller.clearCustomRoot()}
				/>
				{renderImportError(props.controller.error)}
			</>
		);
	// codex 走兜底分支：放在末尾可让 props 正确收窄（放前面会被其余分支收成 never）。
	return (
		<>
			<CodexImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />
			{renderImportError(props.controller.error)}
		</>
	);
}

export type ImportOverlayData = {
	codex: { sessions: CodexSessionSummary[]; report: CodexImportReport | null };
	claude: { sessions: ClaudeSessionSummary[]; report: ClaudeImportReport | null };
	qoder: { sessions: QoderSessionSummary[]; report: QoderImportReport | null };
	opencode: { sessions: OpenCodeSessionSummary[]; report: OpenCodeImportReport | null };
	zcode: { sessions: ZCodeSessionSummary[]; report: ZCodeImportReport | null };
	workbuddy: { sessions: WorkBuddySessionSummary[]; report: WorkBuddyImportReport | null };
	cursor: { sessions: CursorSessionSummary[]; report: CursorImportReport | null };
	kimi: { sessions: KimiSessionSummary[]; report: KimiImportReport | null };
	directory: { sessions: DirectorySessionSummary[]; report: DirectoryImportReport | null };
};
