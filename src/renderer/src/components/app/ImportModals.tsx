
import { useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import { X } from "lucide-react";
import { Check, RefreshCw, UploadCloud } from "lucide-react";
import { t } from "../../i18n";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import type {
	CodexSessionSummary,
	CodexImportReport,
	ClaudeSessionSummary,
	ClaudeImportReport,
	OpenCodeSessionSummary,
	OpenCodeImportReport,
	Project,
} from "../../../../shared/types";
import { Checkbox } from "../ui-shadcn/checkbox";
import { Label } from "../../components/ui-shadcn/label";

function displayPath(path?: string) {
	if (!path) return "";
	const normalized = path.replace(/\\/g, "/");
	const parts = normalized.split("/");
	if (parts.length <= 2) return normalized;
	return `.../${parts.slice(-2).join("/")}`;
}

function formatBytes(value: number) {
	if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
	if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${value} B`;
}

function formatCodexStatus(status: CodexSessionSummary["status"]) {
	if (status === "current") return t("codex.status.current");
	if (status === "outdated") return t("codex.status.outdated");
	return t("codex.status.new");
}

function groupCodexSessions(sessions: CodexSessionSummary[]) {
	const parentById = new Map(sessions.map((session) => [session.id, session]));
	const childrenByParent = new Map<string, CodexSessionSummary[]>();
	const orphanSubagents: CodexSessionSummary[] = [];
	const parents = sessions.filter((session) => session.threadSource !== "subagent");

	for (const session of sessions) {
		if (session.threadSource !== "subagent") continue;
		const parentId = session.parentThreadId;
		if (parentId && parentById.has(parentId)) {
			const children = childrenByParent.get(parentId) ?? [];
			children.push(session);
			childrenByParent.set(parentId, children);
		} else {
			orphanSubagents.push(session);
		}
	}

	return { parents, childrenByParent, orphanSubagents };
}

function codexSubagentLabel(session: CodexSessionSummary) {
	const parts = [session.agentNickname, session.agentRole].filter(Boolean);
	return parts.length ? parts.join(" · ") : t("codex.subagent");
}

function formatClaudeStatus(status: ClaudeSessionSummary["status"]) {
	if (status === "current") return t("claude.status.current");
	if (status === "outdated") return t("claude.status.outdated");
	return t("claude.status.new");
}

function formatOpenCodeStatus(status: OpenCodeSessionSummary["status"]) {
	if (status === "current") return t("opencode.status.current");
	if (status === "outdated") return t("opencode.status.outdated");
	return t("opencode.status.new");
}

export function CodexImportModal(props: {
	project: Project;
	sessions: CodexSessionSummary[];
	selectedPaths: string[];
	loading: boolean;
	importing: boolean;
	report: CodexImportReport | null;
	onClose: () => void;
	onRefresh: () => void;
	onToggle: (sourcePath: string) => void;
	onToggleAll: () => void;
	onImport: () => void;
}) {
	const [expandedSubagents, setExpandedSubagents] = useState<Set<string>>(() => new Set());
	const [showOrphanSubagents, setShowOrphanSubagents] = useState(false);
	const selected = new Set(props.selectedPaths);
	const grouped = groupCodexSessions(props.sessions);
	const selectableParents = grouped.parents;
	const allSelected =
		selectableParents.length > 0 &&
		selectableParents.every((session) => selected.has(session.sourcePath));
	const toggleSubagents = (parentId: string) => {
		setExpandedSubagents((current) => {
			const next = new Set(current);
			if (next.has(parentId)) next.delete(parentId);
			else next.add(parentId);
			return next;
		});
	};
	const renderRow = (session: CodexSessionSummary, className = "codex-session-row") => (
		<Label key={session.sourcePath} className={className}>
			<Checkbox
				checked={selected.has(session.sourcePath)}
				onChange={() => props.onToggle(session.sourcePath)}
			/>
			<div className="codex-session-main">
				<div className="codex-session-title">
					<strong>{session.title}</strong>
					{session.threadSource === "subagent" && (
						<span className="codex-status subagent">{codexSubagentLabel(session)}</span>
					)}
					<span className={`codex-status ${session.status}`}>
						{formatCodexStatus(session.status)}
					</span>
				</div>
				<p>{session.preview}</p>
				<small>
					{new Date(session.updatedAt).toLocaleString()} ·{" "}
					{t("drawer.sessionMessages", {
						count: session.messageCount,
					})} ·{" "}
					{formatBytes(session.sourceSize)}
				</small>
			</div>
		</Label>
	);
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))]", "codex-import-modal")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("codex.title")}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="modal-header-sub">
					<small>{props.project.name}</small>
				</div>
				<div className="codex-import-toolbar">
					<div>
						<strong>{t("codex.importCount", { count: props.sessions.length })}</strong>
						<span>{displayPath(props.project.path)}</span>
					</div>
					<div className="codex-import-actions">
						<Button variant="outline" size="sm" className="h-7 px-2.5 text-xs shadow-none rounded-lg gap-1.5" onClick={props.onRefresh} disabled={props.loading || props.importing}>
							<RefreshCw size={14} />
							{t("common.refresh")}
						</Button>
						<Button variant="outline" size="sm" className="h-7 px-2.5 text-xs shadow-none rounded-lg gap-1.5" onClick={props.onToggleAll} disabled={props.sessions.length === 0}>
							<Check size={14} />
							{allSelected ? t("codex.selectNone") : t("common.selectAll")}
						</Button>
						<Button
							variant="default" size="sm" className="primary-action h-7 px-2.5 text-xs shadow-none rounded-lg gap-1.5"
							onClick={props.onImport}
							disabled={props.importing || props.selectedPaths.length === 0}
						>
							<UploadCloud size={14} />
							{props.importing
								? t("codex.importing")
								: t("codex.importSelected", {
										count: props.selectedPaths.length,
									})}
						</Button>
					</div>
				</div>
				<div className="codex-import-body">
					{props.loading ? (
						<div className="history-loading">
							<div className="loader" />
							<span>{t("codex.scanning")}</span>
						</div>
					) : props.sessions.length === 0 ? (
						<div className="codex-import-empty">
							<strong>{t("codex.emptyTitle")}</strong>
							<span>{t("codex.emptyDesc")}</span>
						</div>
					) : (
						<div className="codex-session-list">
							{grouped.parents.map((session) => {
								const children = grouped.childrenByParent.get(session.id) ?? [];
								const expanded = expandedSubagents.has(session.id);
								return (
									<div key={session.sourcePath} className="codex-session-group">
										{renderRow(session)}
										{children.length > 0 && (
											<Button
												type="button"
												variant="ghost" size="sm" className="codex-subagent-toggle h-auto px-1.5 text-xs"
												onClick={() => toggleSubagents(session.id)}
											>
												{expanded
													? t("codex.hideSubagents", { count: children.length })
													: t("codex.showSubagents", { count: children.length })}
											</Button>
										)}
										{expanded && children.length > 0 && (
											<div className="codex-subagent-list">
												{children.map((child) => renderRow(child, "codex-session-row codex-subagent-row"))}
											</div>
										)}
									</div>
								);
							})}
							{grouped.orphanSubagents.length > 0 && (
								<div className="codex-session-group">
									<Button
										type="button"
										variant="ghost" size="sm" className="codex-subagent-toggle h-auto px-1.5 text-xs codex-orphan-subagents-title"
										onClick={() => setShowOrphanSubagents((current) => !current)}
									>
										{t("codex.orphanSubagents", { count: grouped.orphanSubagents.length })}
									</Button>
									{showOrphanSubagents && (
										<div className="codex-subagent-list">
											{grouped.orphanSubagents.map((session) =>
												renderRow(session, "codex-session-row codex-subagent-row"),
											)}
										</div>
									)}
								</div>
							)}
						</div>
					)}
				</div>
				{props.report && (
					<div className="codex-import-report">
						<strong>
							{t("codex.importDone", {
								imported: props.report.imported,
								failed: props.report.failed,
							})}
						</strong>
						<div>
							{props.report.results.map((result) => (
								<span
									key={result.sourcePath}
									className={result.success ? "success" : "error"}
									title={result.error || result.targetPath}
								>
									{result.success ? "✓" : "✗"} {result.title || result.sourcePath}
								</span>
							))}
						</div>
					</div>
				)}
		
			</DialogContent>
		</Dialog>
	);
}

export function ClaudeImportModal(props: {
	project: Project;
	sessions: ClaudeSessionSummary[];
	selectedPaths: string[];
	loading: boolean;
	importing: boolean;
	report: ClaudeImportReport | null;
	onClose: () => void;
	onRefresh: () => void;
	onToggle: (sourcePath: string) => void;
	onToggleAll: () => void;
	onImport: () => void;
}) {
	const selected = new Set(props.selectedPaths);
	const allSelected =
		props.sessions.length > 0 &&
		props.sessions.every((session) => selected.has(session.sourcePath));
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))]", "codex-import-modal")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("claude.title")}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="modal-header-sub">
					<small>{props.project.name}</small>
				</div>
				<div className="codex-import-toolbar">
					<div>
						<strong>{t("claude.importCount", { count: props.sessions.length })}</strong>
						<span>{displayPath(props.project.path)}</span>
					</div>
					<div className="codex-import-actions">
						<Button variant="outline" size="sm" className="h-7 px-2.5 text-xs shadow-none rounded-lg gap-1.5" onClick={props.onRefresh} disabled={props.loading || props.importing}>
							<RefreshCw size={14} />
							{t("common.refresh")}
						</Button>
						<Button variant="outline" size="sm" className="h-7 px-2.5 text-xs shadow-none rounded-lg gap-1.5" onClick={props.onToggleAll} disabled={props.sessions.length === 0}>
							<Check size={14} />
							{allSelected ? t("claude.selectNone") : t("common.selectAll")}
						</Button>
						<Button
							variant="default" size="sm" className="primary-action h-7 px-2.5 text-xs shadow-none rounded-lg gap-1.5"
							onClick={props.onImport}
							disabled={props.importing || props.selectedPaths.length === 0}
						>
							<UploadCloud size={14} />
							{props.importing
								? t("claude.importing")
								: t("claude.importSelected", {
										count: props.selectedPaths.length,
									})}
						</Button>
					</div>
				</div>
				<div className="codex-import-body">
					{props.loading ? (
						<div className="history-loading">
							<div className="loader" />
							<span>{t("claude.scanning")}</span>
						</div>
					) : props.sessions.length === 0 ? (
						<div className="codex-import-empty">
							<strong>{t("claude.emptyTitle")}</strong>
							<span>{t("claude.emptyDesc")}</span>
						</div>
					) : (
						<div className="codex-session-list">
							{props.sessions.map((session) => (
								<Label key={session.sourcePath} className="codex-session-row">
									<Checkbox
										checked={selected.has(session.sourcePath)}
										onChange={() => props.onToggle(session.sourcePath)}
									/>
									<div className="codex-session-main">
										<div className="codex-session-title">
											<strong>{session.title}</strong>
											<span className={`codex-status ${session.status}`}>
												{formatClaudeStatus(session.status)}
											</span>
										</div>
										<p>{session.preview}</p>
										<small>
											{new Date(session.updatedAt).toLocaleString()} ·{" "}
											{t("drawer.sessionMessages", {
												count: session.messageCount,
											})} ·{" "}
											{formatBytes(session.sourceSize)}
										</small>
									</div>
								</Label>
							))}
						</div>
					)}
				</div>
				{props.report && (
					<div className="codex-import-report">
						<strong>
							{t("claude.importDone", {
								imported: props.report.imported,
								failed: props.report.failed,
							})}
						</strong>
						<div>
							{props.report.results.map((result) => (
								<span
									key={result.sourcePath}
									className={result.success ? "success" : "error"}
									title={result.error || result.targetPath}
								>
									{result.success ? "✓" : "✗"} {result.title || result.sourcePath}
								</span>
							))}
						</div>
					</div>
				)}
		
			</DialogContent>
		</Dialog>
	);
}

export function OpenCodeImportModal(props: {
	project: Project;
	sessions: OpenCodeSessionSummary[];
	selectedPaths: string[];
	loading: boolean;
	importing: boolean;
	report: OpenCodeImportReport | null;
	onClose: () => void;
	onRefresh: () => void;
	onToggle: (sourcePath: string) => void;
	onToggleAll: () => void;
	onImport: () => void;
}) {
	const selected = new Set(props.selectedPaths);
	const allSelected =
		props.sessions.length > 0 &&
		props.sessions.every((session) => selected.has(session.sourcePath));
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))]", "codex-import-modal")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("opencode.title")}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="modal-header-sub">
					<small>{props.project.name}</small>
				</div>
				<div className="codex-import-toolbar">
					<div>
						<strong>
							{t("opencode.importCount", {
								count: props.sessions.length,
							})}
						</strong>
						<span>{displayPath(props.project.path)}</span>
					</div>
					<div className="codex-import-actions">
						<Button variant="outline" size="sm" className="h-7 px-2.5 text-xs shadow-none rounded-lg gap-1.5" onClick={props.onRefresh} disabled={props.loading || props.importing}>
							<RefreshCw size={14} />
							{t("common.refresh")}
						</Button>
						<Button variant="outline" size="sm" className="h-7 px-2.5 text-xs shadow-none rounded-lg gap-1.5" onClick={props.onToggleAll} disabled={props.sessions.length === 0}>
							<Check size={14} />
							{allSelected ? t("opencode.selectNone") : t("common.selectAll")}
						</Button>
						<Button
							variant="default" size="sm" className="primary-action h-7 px-2.5 text-xs shadow-none rounded-lg gap-1.5"
							onClick={props.onImport}
							disabled={props.importing || props.selectedPaths.length === 0}
						>
							<UploadCloud size={14} />
							{props.importing
								? t("opencode.importing")
								: t("opencode.importSelected", {
										count: props.selectedPaths.length,
									})}
						</Button>
					</div>
				</div>
				<div className="codex-import-body">
					{props.loading ? (
						<div className="history-loading">
							<div className="loader" />
							<span>{t("opencode.scanning")}</span>
						</div>
					) : props.sessions.length === 0 ? (
						<div className="codex-import-empty">
							<strong>{t("opencode.emptyTitle")}</strong>
							<span>{t("opencode.emptyDesc")}</span>
						</div>
					) : (
						<div className="codex-session-list">
							{props.sessions.map((session) => (
								<Label key={session.sourcePath} className="codex-session-row">
									<Checkbox
										checked={selected.has(session.sourcePath)}
										onChange={() => props.onToggle(session.sourcePath)}
									/>
									<div className="codex-session-main">
										<div className="codex-session-title">
											<strong>{session.title}</strong>
											<span className={`codex-status ${session.status}`}>
												{formatOpenCodeStatus(session.status)}
											</span>
										</div>
										<p>{session.preview}</p>
										<small>
											{new Date(session.updatedAt).toLocaleString()} ·{" "}
											{t("drawer.sessionMessages", {
												count: session.messageCount,
											})} ·{" "}
											{formatBytes(session.sourceSize)}
										</small>
									</div>
								</Label>
							))}
						</div>
					)}
				</div>
				{props.report && (
					<div className="codex-import-report">
						<strong>
							{t("opencode.importDone", {
								imported: props.report.imported,
								failed: props.report.failed,
							})}
						</strong>
						<div>
							{props.report.results.map((result) => (
								<span
									key={result.sourcePath}
									className={result.success ? "success" : "error"}
									title={result.error || result.targetPath}
								>
									{result.success ? "✓" : "✗"} {result.title || result.sourcePath}
								</span>
							))}
						</div>
					</div>
				)}
			
			</DialogContent>
		</Dialog>
	);
}
