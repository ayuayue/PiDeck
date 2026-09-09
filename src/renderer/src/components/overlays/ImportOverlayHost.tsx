import type { ReactNode } from "react";
import {
	ClaudeImportModal,
	CodexImportModal,
	OpenCodeImportModal,
	WorkBuddyImportModal,
	ZCodeImportModal,
} from "../app/ImportModals";
import type {
  CodexImportReport,
  CodexSessionSummary,
  ClaudeImportReport,
  ClaudeSessionSummary,
  OpenCodeImportReport,
  OpenCodeSessionSummary,
  ZCodeImportReport,
  ZCodeSessionSummary,
  WorkBuddyImportReport,
  WorkBuddySessionSummary,
  Project,
} from "../../../../shared/types";
import type { ImportController } from "../../hooks/useImportFlow";

export type ImportOverlayHostProps =
  | { kind: "codex"; project: Project; controller: ImportController<CodexSessionSummary, CodexImportReport>; onClose: () => void }
  | { kind: "claude"; project: Project; controller: ImportController<ClaudeSessionSummary, ClaudeImportReport>; onClose: () => void }
  | { kind: "opencode"; project: Project; controller: ImportController<OpenCodeSessionSummary, OpenCodeImportReport>; onClose: () => void }
  | { kind: "zcode"; project: Project; controller: ImportController<ZCodeSessionSummary, ZCodeImportReport>; onClose: () => void }
  | { kind: "workbuddy"; project: Project; controller: ImportController<WorkBuddySessionSummary, WorkBuddyImportReport>; onClose: () => void };

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
	if (props.kind === "claude") return <><ClaudeImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />{renderImportError(props.controller.error)}</>;
	if (props.kind === "opencode") return <><OpenCodeImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />{renderImportError(props.controller.error)}</>;
	if (props.kind === "zcode") return <><ZCodeImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />{renderImportError(props.controller.error)}</>;
	if (props.kind === "workbuddy") return <><WorkBuddyImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />{renderImportError(props.controller.error)}</>;
	// codex 走兜底分支：放在末尾可让 props 正确收窄（放前面会被其余分支收成 never）。
	return <><CodexImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />{renderImportError(props.controller.error)}</>;
}

export type ImportOverlayData = {
	codex: { sessions: CodexSessionSummary[]; report: CodexImportReport | null };
	claude: { sessions: ClaudeSessionSummary[]; report: ClaudeImportReport | null };
	opencode: { sessions: OpenCodeSessionSummary[]; report: OpenCodeImportReport | null };
	zcode: { sessions: ZCodeSessionSummary[]; report: ZCodeImportReport | null };
	workbuddy: { sessions: WorkBuddySessionSummary[]; report: WorkBuddyImportReport | null };
};
