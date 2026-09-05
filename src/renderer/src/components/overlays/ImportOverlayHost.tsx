import type { ReactNode } from "react";
import {
	ClaudeImportModal,
	CodexImportModal,
	OpenCodeImportModal,
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
  Project,
} from "../../../../shared/types";
import type { ImportController } from "../../hooks/useImportFlow";

export type ImportOverlayHostProps =
  | { kind: "codex"; project: Project; controller: ImportController<CodexSessionSummary, CodexImportReport>; onClose: () => void }
  | { kind: "claude"; project: Project; controller: ImportController<ClaudeSessionSummary, ClaudeImportReport>; onClose: () => void }
  | { kind: "opencode"; project: Project; controller: ImportController<OpenCodeSessionSummary, OpenCodeImportReport>; onClose: () => void }
  | { kind: "zcode"; project: Project; controller: ImportController<ZCodeSessionSummary, ZCodeImportReport>; onClose: () => void };

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
	if (props.kind === "codex") return <><CodexImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />{renderImportError(props.controller.error)}</>;
	if (props.kind === "claude") return <><ClaudeImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />{renderImportError(props.controller.error)}</>;
	if (props.kind === "opencode") return <><OpenCodeImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />{renderImportError(props.controller.error)}</>;
	return <><ZCodeImportModal project={props.project} {...props.controller} onClose={props.onClose} onRefresh={props.controller.refresh} onToggle={props.controller.toggle} onToggleAll={props.controller.toggleAll} onImport={() => void props.controller.importSelected()} />{renderImportError(props.controller.error)}</>;
}

export type ImportOverlayData = {
	codex: { sessions: CodexSessionSummary[]; report: CodexImportReport | null };
	claude: { sessions: ClaudeSessionSummary[]; report: ClaudeImportReport | null };
	opencode: { sessions: OpenCodeSessionSummary[]; report: OpenCodeImportReport | null };
	zcode: { sessions: ZCodeSessionSummary[]; report: ZCodeImportReport | null };
};
