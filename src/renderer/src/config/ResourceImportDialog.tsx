import { AlertTriangle, CheckCircle2, Download, Loader2, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
import { Button } from "../components/ui-shadcn/button";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { ConfigSelect } from "./ConfigShared";
import { t } from "../i18n";
import type { ResourceImportKind, ResourceImportReport, ResourceImportSourceKind } from "../../../shared/types/resourceImport";
import { canImportResource, type ResourceImportProject, useResourceImportDialog } from "./useResourceImportDialog";

function formatImportMessage(message: string): string {
	const unsupported = /^Unsupported transport:\s*(.+)$/.exec(message);
	if (unsupported) return t("config.import.blockerUnsupportedTransport", { transport: unsupported[1] });
	if (message === "Exactly one transport is required.") return t("config.import.blockerTransportRequired");
	if (message === "MCP name is invalid for PiDeck.") return t("config.import.blockerInvalidName");
	if (message === "Converted MCP definition is invalid.") return t("config.import.blockerInvalidDefinition");
	if (message === "Skill name cannot be converted to a safe name.") return t("config.import.blockerSkillName");
	if (message === "MCP server definition must be an object.") return t("config.import.blockerDefinitionObject");
	if (message === "Transport type does not match the configured fields.") return t("config.import.blockerTransportMismatch");
	if (message === "Transport type must be a string.") return t("config.import.blockerTransportType");
	if (message === "Transport type is empty.") return t("config.import.blockerTransportEmpty");
	if (message === "Multiple transport declarations were found.") return t("config.import.blockerMultipleTransports");
	if (message === "MCP server map must be an object." || message === "Codex MCP server map must be an object.") return t("config.import.sourceServerMapError");
	if (message === "Source could not be read." || message === "Source could not be resolved." || message === "Skill source could not be read.") return t("config.import.sourceReadError");
	if (message === "Source JSON must be an object.") return t("config.import.sourceParseError");
	if (message === "Source is not a regular file." || message === "Source path is outside the project boundary.") return t("config.import.sourceUnsafePath");
	if (message === "Source file is too large.") return t("config.import.sourceTooLarge");
	if (message === "Project is not available for resource import.") return t("config.import.projectUnavailable");
	if (message === "Project is not trusted.") return t("config.import.projectUntrusted");
	if (message === "Import scan expired. Please scan again.") return t("config.import.scanExpired");
	if (message === "Import target changed. Please scan again.") return t("config.import.targetChanged");
	if (message === "Source changed. Please scan again." || message === "Source changed or is no longer safe. Please scan again.") return t("config.import.sourceChanged");
	if (message === "Target already contains this resource." || message === "Target already contains this MCP server." || message === "Target already contains this skill.") return t("config.import.conflict");
	if (message === "Resource cannot be imported.") return t("config.import.itemNotImportable");
	if (message === "MCP definition unavailable.") return t("config.import.itemNotImportable");
	if (message === "PiDeck MCP configuration is invalid; repair it before importing." || message === "MCP config could not be saved.") return t("config.import.mcpTargetInvalid");
	if (message === "Skill target is unavailable.") return t("config.import.skillTargetInvalid");
	if (message === "Some skill entries were skipped because they are unsafe.") return t("config.import.warningSkillUnsafeEntries");
	if (message === "Skill source is not a safe directory.") return t("config.import.warningSkillSymlink");
	if (message === "Skill source could not be read.") return t("config.import.sourceReadError");
	if (message === "Skill name missing; directory name will be used.") return t("config.import.warningSkillNameMissing");
	if (message === "Description missing.") return t("config.import.warningSkillDescriptionMissing");
	if (message === "Skill directory is not safe to import.") return t("config.import.warningSkillUnsafe");
	if (message === "Skill source must be a directory without symbolic links." || message === "Skill contains a symbolic link and cannot be imported.") return t("config.import.warningSkillSymlink");
	if (message === "Skill contains an unsupported file type.") return t("config.import.warningSkillFileType");
	if (message === "Skill file is too large." || message === "Skill directory is too large.") return t("config.import.warningSkillTooLarge");
	if (message === "SKILL.md could not be read.") return t("config.import.sourceReadError");
	if (message === "Source JSON could not be parsed." || message === "Codex TOML could not be parsed.") return t("config.import.sourceParseError");
	const field = /^Field not preserved:\s*(.+)$/.exec(message);
	if (field) return t("config.import.warningFieldNotPreserved", { field: field[1] });
	if (message === "Some environment values were not strings and were omitted.") return t("config.import.warningEnvValues");
	if (message === "Environment variables were not an object and were omitted.") return t("config.import.warningEnvObject");
	if (message === "Some command arguments were not strings and were omitted." || message === "Command arguments were not an array and were omitted.") return t("config.import.warningArgsValues");
	if (message === "Working directory was not a non-empty string and was omitted.") return t("config.import.warningCwdValue");
	if (message === "Environment variables may be missing at runtime.") return t("config.import.warningEnvMissing");
	if (message === "Some header values were not strings and were omitted.") return t("config.import.warningHeaderValues");
	if (message === "HTTP headers were not an object and were omitted.") return t("config.import.warningHeaderObject");
	if (message === "Both headers fields were present; the standard headers field was used.") return t("config.import.warningHeadersConflict");
	if (message === "HTTP headers may be missing at runtime.") return t("config.import.warningHeadersMissing");
	if (message === "Authentication values require manual verification.") return t("config.import.warningAuth");
	if (message === "Command was not found on PATH.") return t("config.import.warningCommandMissing");
	if (message === "URL could not be reached during the compatibility check.") return t("config.import.warningUrlUnreachable");
	if (message === "MCP endpoint could not be reached during the compatibility check.") return t("config.import.warningEndpointUnreachable");
	if (message === "Compatibility check timed out or failed.") return t("config.import.warningProbeFailed");
	if (message === "A duplicate name exists in this scan; only one candidate can be imported." || message.startsWith("Duplicate name in this scan (")) return t("config.import.warningDuplicate");
	if (message === "The skill name exceeds 64 characters and will be truncated.") return t("config.import.warningSkillNameLong");
	if (message === "Skill description exceeds 1024 characters.") return t("config.import.warningSkillDescriptionLong");
	if (message.includes("symbolic link")) return t("config.import.warningSkillSymlink");
	if (message.includes("unsupported file type")) return t("config.import.warningSkillFileType");
	if (message.includes("too large")) return t("config.import.warningSkillTooLarge");
	if (message.includes("too deep")) return t("config.import.warningSkillTooDeep");
	if (message === "Too many skill candidates; remaining entries were omitted.") return t("config.import.warningSkillCandidateLimit");
	if (
		message === "Invalid resource import input." ||
		message === "Invalid resource import scan input." ||
		message === "Invalid resource import apply input." ||
		message === "Invalid resource import target." ||
		message === "Invalid MCP target." ||
		message === "Invalid skill target." ||
		message === "Invalid project id." ||
		message === "Invalid source project id." ||
		message === "Invalid resource import candidate ids." ||
		message === "Invalid import candidate."
	)
		return t("config.import.invalidInput");
	if (message === "Resource import failed.") return t("config.import.genericError");
	// Diagnostics originate from external configuration and filesystem operations.
	// Unrecognized text may contain path/credential context, so never display it raw.
	return t("config.import.genericError");
}

function sourceLabelFor(source: ResourceImportSourceKind): string {
	if (source === "claude-global") return t("config.import.sourceClaudeGlobal");
	if (source === "claude-project") return t("config.import.sourceClaudeProject");
	if (source === "codex-global") return t("config.import.sourceCodexGlobal");
	return t("config.import.sourceCodexProject");
}

function resultStatusLabel(status: ResourceImportReport["results"][number]["status"]): string {
	if (status === "imported") return t("config.import.itemImported");
	if (status === "skipped") return t("config.import.itemSkipped");
	return t("config.import.itemFailed");
}

/** Presentation-only shell for external MCP and skill imports. */
export function ResourceImportDialog(props: {
	kind: ResourceImportKind;
	sourceProjectId?: string;
	/** 技能导入的项目目标数据源；MCP 导入只写全局层。 */
	projects?: ResourceImportProject[];
	/** When set, the skill importer is hosted by a project resource page and must stay there. */
	fixedProjectId?: string;
	triggerLabel: string;
	open?: boolean;
	onImported?: () => void;
}) {
	const state = useResourceImportDialog({
		kind: props.kind,
		sourceProjectId: props.sourceProjectId,
		projects: props.projects,
		fixedProjectId: props.fixedProjectId,
		open: props.open,
		onImported: props.onImported,
	});

	return (
		<>
			<Button variant="outline" size="sm" onClick={state.openDialog} disabled={state.loading || state.applying}>
				<Download size={14} />
				{props.triggerLabel}
			</Button>
			<Dialog open={state.open} onOpenChange={state.handleOpenChange}>
				<DialogContent className="flex max-h-[80vh] flex-col gap-0 overflow-hidden sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle>{props.kind === "mcp" ? t("config.import.mcpTitle") : t("config.import.skillTitle")}</DialogTitle>
					</DialogHeader>
					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden py-3">
						<div className="flex items-center gap-2">
							<span className="text-control text-muted-foreground">{t("config.import.target")}</span>
							<ConfigSelect value={state.selectedTargetValue} options={state.targetOptions} onChange={state.selectTarget} />
						</div>
						{state.error ? <div className="rounded border border-danger/30 bg-danger-soft px-3 py-2 text-control text-danger">{formatImportMessage(state.error)}</div> : null}
						{state.report ? (
							<div className="space-y-2 rounded border border-border-subtle bg-bg-hover px-3 py-2 text-control">
								<div className="flex flex-wrap items-center gap-3">
									<span className="text-success">{t("config.import.resultImported", { count: state.report.imported })}</span>
									<span className="text-warning">{t("config.import.resultSkipped", { count: state.report.skipped })}</span>
									<span className="text-danger">{t("config.import.resultFailed", { count: state.report.failed })}</span>
								</div>
								<div className="space-y-1 border-t border-border-subtle pt-2">
									{state.report.results.map((item) => (
										<div key={item.candidateId} className="flex items-start gap-2 text-caption">
											<span className={item.status === "imported" ? "text-success" : item.status === "skipped" ? "text-warning" : "text-danger"}>{resultStatusLabel(item.status)}</span>
											<span className="min-w-0 break-words">
												{item.name}
												{item.reason ? ` · ${formatImportMessage(item.reason)}` : ""}
											</span>
										</div>
									))}
								</div>
							</div>
						) : null}
						{state.loading ? (
							<div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
								<Loader2 className="animate-pideck-spin" size={16} />
								{t("config.import.scanning")}
							</div>
						) : state.scan ? (
							<>
								<div className="flex items-center justify-between text-caption text-muted-foreground">
									<span>{t("config.import.candidateCount", { count: state.scan.candidates.length })}</span>
									<Button variant="ghost" size="sm" onClick={() => state.toggleAll(state.selected.size === 0)} disabled={state.applying}>
										{state.selected.size === 0 ? t("config.import.selectAll") : t("config.import.clearAll")}
									</Button>
								</div>
								<div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
									{state.scan.sources.map((source) => (
										<div key={`${source.source}:${source.pathLabel}`} className="text-micro text-muted-foreground">
											{sourceLabelFor(source.source)} · {source.pathLabel} · {source.exists ? t("config.import.sourceFound") : t("config.import.sourceMissing")}
											{source.error ? ` · ${formatImportMessage(source.error)}` : ""}
										</div>
									))}
									{state.scan.candidates.length === 0 ? (
										<div className="py-8 text-center text-control text-muted-foreground">{t("config.import.empty")}</div>
									) : (
										state.scan.candidates.map((candidate) => {
											const disabled = !canImportResource(candidate);
											return (
												<div key={candidate.candidateId} className="rounded border border-border-subtle px-3 py-2">
													<div className="flex items-start gap-2">
														<Checkbox aria-label={candidate.targetName} checked={state.selected.has(candidate.candidateId)} disabled={disabled || state.applying} onCheckedChange={(checked) => state.toggleCandidate(candidate.candidateId, checked === true)} />
														<div className="min-w-0 flex-1">
															<div className="flex items-center gap-2">
																<strong className="truncate text-control">{candidate.targetName || candidate.name}</strong>
																{canImportResource(candidate) ? <CheckCircle2 className="text-success" size={14} /> : <XCircle className="text-danger" size={14} />}
															</div>
															<div className="text-micro text-muted-foreground">
																{sourceLabelFor(candidate.source)} · {candidate.sourcePathLabel}
															</div>
															{candidate.description ? <div className="text-caption text-muted-foreground">{candidate.description}</div> : null}
															{candidate.conflict ? <div className="text-micro text-warning">{t("config.import.conflict")}</div> : null}
															{candidate.blockers.map((item) => (
																<div key={item} className="text-micro text-danger">
																	{formatImportMessage(item)}
																</div>
															))}
															{candidate.warnings.map((item) => (
																<div key={item} className="flex items-center gap-1 text-micro text-warning">
																	<AlertTriangle size={12} />
																	{formatImportMessage(item)}
																</div>
															))}
															{candidate.preview?.url ? (
																<div className="truncate font-mono text-micro text-muted-foreground">{candidate.preview.url}</div>
															) : candidate.preview?.command ? (
																<div className="truncate font-mono text-micro text-muted-foreground">
																	{candidate.preview.command} {(candidate.preview.args ?? []).join(" ")}
																</div>
															) : null}
														</div>
													</div>
												</div>
											);
										})
									)}
								</div>
							</>
						) : null}
					</div>
					<DialogFooter>
						<Button variant="ghost" onClick={() => state.handleOpenChange(false)} disabled={state.applying}>
							{state.report ? t("common.close") : t("common.cancel")}
						</Button>
						<Button onClick={() => void state.apply()} disabled={state.report !== null || state.applying || state.loading || state.selected.size === 0}>
							{state.applying ? <Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" /> : null}
							{state.applying ? t("config.import.importing") : t("config.import.confirm", { count: state.selected.size })}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
