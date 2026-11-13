import { Loader2, X } from "lucide-react";
import type { ComponentProps, Dispatch, ReactNode, SetStateAction } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { PiSkillSummary, Project, ProjectResourceDiscoveryResult, ProjectResourceListResult } from "../../../../shared/types";
import type { PiResourceOptions } from "../../../../shared/piConfig";
import { Button } from "../../components/ui-shadcn/button";
import { CodeMirrorEditor } from "../../components/app/CodeMirrorEditor";
import { t } from "../../i18n";
import { SkillsTab } from "../SkillsTab";
import type { ResourceScope } from "../resourceScopeModel";

export type ConfigSkillsTabProps = {
	api: PiDesktopApi;
	statusBlock: ReactNode;
	resourceScope: ResourceScope;
	/** 资源管理器入口项目：项目作用域下新建/打开目录走它。 */
	effectiveProjectId: string | undefined;
	resourceOnly: boolean;
	scopeSelector: ReactNode;
	resourceOptions: PiResourceOptions | undefined;
	projects: Array<{ id: string; name: string; kind?: Project["kind"] }>;
	projectOverrides: ProjectResourceListResult["overrides"];
	discoverySkills: ProjectResourceDiscoveryResult["skills"];
	onError: (message: string) => void;
	/** 全局 Skill.md 编辑器（打开某个技能时整块换成编辑器）。 */
	editingSkill: PiSkillSummary | null;
	setEditingSkill: Dispatch<SetStateAction<PiSkillSummary | null>>;
	editContent: string;
	setEditContent: Dispatch<SetStateAction<string>>;
	editLoading: boolean;
	editSaved: boolean;
	markDirty: (tabKey: string) => void;
	clearDirty: (tabKey: string) => void;
} & Omit<ComponentProps<typeof SkillsTab>, "scope" | "projectId" | "fixedProjectId" | "scopeSelector" | "projects" | "projectOverrides" | "discoverySkills" | "onOpenRoot">;

/** 技能页内容（`skills` TabsContent 整块）：列表 / 全局 SKILL.md 编辑器二选一。 */
export function ConfigSkillsTab(props: ConfigSkillsTabProps) {
	const { api, statusBlock, resourceScope, effectiveProjectId, resourceOnly, scopeSelector, resourceOptions, projects, projectOverrides, discoverySkills, onError, editingSkill, setEditingSkill, editContent, setEditContent, editLoading, editSaved, markDirty, clearDirty, ...skillsTabProps } = props;

	return (
		<div className="config-content">
			{statusBlock}
			{!skillsTabProps.loading &&
				(editingSkill ? (
					<div className="prompts-editor-backdrop" onClick={() => setEditingSkill(null)}>
						<div className="prompts-editor-modal" onClick={(e) => e.stopPropagation()}>
							<div className="file-diff-header">
								<span className="file-diff-header-file">{editingSkill.name} · SKILL.md</span>
								<div className="file-diff-header-actions">
									<Button
										variant="ghost"
										size="icon"
										aria-label={t("common.close")}
										title={t("common.close")}
										onClick={() => {
											clearDirty("skills");
											setEditingSkill(null);
										}}
									>
										<X size={18} strokeWidth={2.2} aria-hidden="true" />
									</Button>
								</div>
							</div>
							{editLoading ? (
								<div className="flex items-center justify-center gap-2 py-12 text-control text-text-tertiary">
									<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
									{t("common.loading")}
								</div>
							) : (
								<div className="prompts-monaco-wrap">
									<CodeMirrorEditor
										value={editContent}
										onChange={(value) => {
											setEditContent(value);
											markDirty("skills");
										}}
									/>
								</div>
							)}
							{editSaved && <span className="file-diff-hint saved">{t("config.promptSavedHint")}</span>}
						</div>
					</div>
				) : (
					<SkillsTab
						{...skillsTabProps}
						scope={resourceScope}
						projectId={resourceScope === "project" ? effectiveProjectId : undefined}
						fixedProjectId={resourceOnly ? effectiveProjectId : undefined}
						scopeSelector={scopeSelector}
						projects={projects}
						projectOverrides={projectOverrides}
						discoverySkills={discoverySkills}
						onOpenRoot={() => {
							if (resourceScope === "project" && effectiveProjectId) {
								const kind = skillsTabProps.newLocationId === "project-agents" ? "project-agents" : "project-pi";
								void api.projectResources.openDirectory(effectiveProjectId, kind).catch((err) => onError(err instanceof Error ? err.message : String(err)));
								return;
							}
							void api.skills.openFolder(undefined, resourceOptions).catch((err) => onError(err instanceof Error ? err.message : String(err)));
						}}
					/>
				))}
		</div>
	);
}
