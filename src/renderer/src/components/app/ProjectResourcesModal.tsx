import { Button } from "../ui-shadcn/button";
import { cn } from "../../lib/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { showNotice } from "../../utils/notice";

import { Check, FileEdit, Pencil, ToggleLeft, ToggleRight, Trash2, X } from "lucide-react";
import { CodeMirrorEditor } from "../app/CodeMirrorEditor";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import type {
	PiExtensionSummary,
	PiPromptTemplateSummary,
	PiSkillSummary,
	Project,
	ProjectResourceListResult,
} from "../../../../shared/types";
import { t } from "../../i18n";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import { Label } from "../../components/ui-shadcn/label";

type ProjectResourcesApi = typeof window.piDesktop.projectResources;

type ProjectResourceTab = "skills" | "extensions" | "prompts";

type DeleteTarget =
	| { kind: "skill"; item: PiSkillSummary }
	| { kind: "extension"; item: PiExtensionSummary }
	| { kind: "prompt"; item: PiPromptTemplateSummary };

export function ProjectResourcesModal(props: {
	project: Project;
	onClose: () => void;
}) {
	const [data, setData] = useState<ProjectResourceListResult>({ skills: [], extensions: [] });
	const [prompts, setPrompts] = useState<PiPromptTemplateSummary[]>([]);
	const [promptsLoading, setPromptsLoading] = useState(false);
	const [loading, setLoading] = useState(true);
	const [createBusy, setCreateBusy] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
	const [deleteBusy, setDeleteBusy] = useState(false);
	const [activeTab, setActiveTab] = useState<ProjectResourceTab>("skills");
	const [newName, setNewName] = useState("");
	const [newDescription, setNewDescription] = useState("");
	// 项目 prompt 创建状态
	const [newPromptName, setNewPromptName] = useState("");
	const [newPromptDescription, setNewPromptDescription] = useState("");
	const [creatingPrompt, setCreatingPrompt] = useState(false);
	// 项目 prompt 编辑器状态
	const [editingProjectPrompt, setEditingProjectPrompt] = useState<PiPromptTemplateSummary | null>(null);
	const [editProjectPromptContent, setEditProjectPromptContent] = useState("");
	const [editProjectPromptLoading, setEditProjectPromptLoading] = useState(false);
	const [editProjectPromptSaving, setEditProjectPromptSaving] = useState(false);
	const [editProjectPromptSaved, setEditProjectPromptSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// 内建编辑器状态
	const [editingSkill, setEditingSkill] = useState<PiSkillSummary | null>(null);
	const [editContent, setEditContent] = useState("");
	const [editLoading, setEditLoading] = useState(false);
	const [editSaving, setEditSaving] = useState(false);
	const [editSaved, setEditSaved] = useState(false);
	// 项目 skill 重命名状态
	const [renamingSkill, setRenamingSkill] = useState<string | null>(null);
	const [renameSkillValue, setRenameSkillValue] = useState("");
	const [renameSkillBusy, setRenameSkillBusy] = useState(false);
	const api = (window as unknown as { piDesktop: { projectResources: ProjectResourcesApi } }).piDesktop.projectResources;

	const refresh = useMemo(
		() => async (showToast?: boolean) => {
			setLoading(true);
			setError(null);
			try {
				setData(await api.list(props.project.id));
				if (showToast) showNotice(t("projectResources.refreshed"), 2000);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		},
		[props.project.id],
	);

	/** 加载项目级提示词模板 */
	const loadPrompts = useCallback(async () => {
		setPromptsLoading(true);
		setError(null);
		try {
			const result = await window.piDesktop.prompts.listByProject(props.project.path);
			setPrompts(result.templates);
		} catch (err) {
			setPrompts([]);
		}
		setPromptsLoading(false);
	}, [props.project.path]);

	/** 进入提示词 tab 时自动加载 */
	useEffect(() => {
		if (activeTab === "prompts") {
			void loadPrompts();
		}
	}, [activeTab, loadPrompts]);

	useEffect(() => {
		void refresh();
		void loadPrompts();
	}, [refresh, loadPrompts]);

	const canCreateSkill = useMemo(
		() => newName.trim().length > 0 && newDescription.trim().length > 0,
		[newName, newDescription],
	);

	const createSkill = async () => {
		if (!canCreateSkill || createBusy) return;
		setCreateBusy(true);
		setError(null);
		try {
			await api.createSkill({
				projectId: props.project.id,
				name: newName.trim(),
				description: newDescription.trim(),
			});
			setNewName("");
			setNewDescription("");
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreateBusy(false);
		}
	};

	const confirmDelete = async () => {
		if (!deleteTarget || deleteBusy) return;
		setDeleteBusy(true);
		setError(null);
		try {
			if (deleteTarget.kind === "skill") {
				await api.deleteSkill(props.project.id, deleteTarget.item.path);
			} else if (deleteTarget.kind === "extension" && deleteTarget.item.path) {
				await api.deleteExtension(props.project.id, deleteTarget.item.path);
			} else if (deleteTarget.kind === "prompt") {
				// 用文件名删除项目级 prompt
				const fileName = deleteTarget.item.path.split(/[/\\]/).pop();
				if (fileName) {
					await window.piDesktop.prompts.deleteFromProject(props.project.path, fileName);
				}
			}
			setDeleteTarget(null);
			await Promise.all([refresh(), loadPrompts()]);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setDeleteBusy(false);
		}
	};

	// Ctrl+S / Cmd+S 快捷键保存
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.key !== "s") return;
			if (editingSkill && !editSaving) {
				e.preventDefault();
				void saveEditor();
			} else if (editingProjectPrompt && !editProjectPromptSaving) {
				e.preventDefault();
				void saveProjectPromptEditor();
			}
		};
		if (editingSkill || editingProjectPrompt) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [editingSkill, editingProjectPrompt, editSaving, editProjectPromptSaving]);

	/** 打开内建编辑器：读取 SKILL.md 内容 */
	const openEditor = async (skill: PiSkillSummary) => {
		setEditingSkill(skill);
		setEditContent("");
		setEditSaved(false);
		setEditLoading(true);
		setError(null);
		try {
			const content = await window.piDesktop.files.readContent(skill.path);
			setEditContent(content);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingSkill(null);
		} finally {
			setEditLoading(false);
		}
	};

	/** 保存编辑内容到 SKILL.md */
	const saveEditor = async () => {
		if (!editingSkill || editSaving) return;
		setEditSaving(true);
		setError(null);
		try {
			await window.piDesktop.files.writeContent(editingSkill.path, editContent);
			setEditSaved(true);
			window.setTimeout(() => setEditSaved(false), 2000);
			// 保存后刷新列表，让 readSkill 读到最新 frontmatter
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setEditSaving(false);
		}
	};

	/** 重命名项目 Skill */
	const renameSkillConfirm = async (skill: PiSkillSummary, newName: string) => {
		if (renameSkillBusy || !newName.trim() || newName.trim() === skill.name) {
			setRenamingSkill(null);
			return;
		}
		setRenameSkillBusy(true);
		setError(null);
		try {
			await api.renameSkill(props.project.id, skill.path, newName.trim());
			await refresh();
			setRenamingSkill(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRenameSkillBusy(false);
		}
	};

	/** 切换 Skill 启用/禁用 */
	const toggleSkill = async (skill: PiSkillSummary) => {
		const nextEnabled = !skill.enabled;
		try {
			const updated = await api.toggleSkill(props.project.id, skill.path, nextEnabled);
			// 直接更新列表中对应的 skill，避免全量刷新加载闪烁
			setData((prev) => ({
				...prev,
				skills: prev.skills.map((s) => (s.id === skill.id ? updated : s)),
			}));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const toggleExtension = async (extension: PiExtensionSummary) => {
		const nextEnabled = extension.enabled !== false ? false : true;
		try {
			await api.toggleExtension(props.project.id, extension.path!, nextEnabled);
			setData((prev) => ({
				...prev,
				extensions: prev.extensions.map((e) =>
					e.id === extension.id ? { ...e, enabled: nextEnabled } : e
				),
			}));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	// ── 项目级 prompt 操作 ──

	const canCreatePrompt = newPromptName.trim().length > 0 && newPromptDescription.trim().length > 0;

	const createProjectPrompt = async () => {
		if (!canCreatePrompt || creatingPrompt) return;
		setCreatingPrompt(true);
		setError(null);
		try {
			await window.piDesktop.prompts.createInProject(props.project.path, {
				name: newPromptName.trim(),
				description: newPromptDescription.trim(),
			});
			setNewPromptName("");
			setNewPromptDescription("");
			await loadPrompts();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreatingPrompt(false);
		}
	};

	const openProjectPromptEditor = async (prompt: PiPromptTemplateSummary) => {
		setEditingProjectPrompt(prompt);
		setEditProjectPromptContent("");
		setEditProjectPromptLoading(true);
		setEditProjectPromptSaved(false);
		setError(null);
		try {
			const content = await window.piDesktop.files.readContent(prompt.path);
			setEditProjectPromptContent(content);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingProjectPrompt(null);
		} finally {
			setEditProjectPromptLoading(false);
		}
	};

	const saveProjectPromptEditor = async () => {
		if (!editingProjectPrompt || editProjectPromptSaving) return;
		setEditProjectPromptSaving(true);
		setError(null);
		try {
			await window.piDesktop.files.writeContent(editingProjectPrompt.path, editProjectPromptContent);
			setEditProjectPromptSaved(true);
			window.setTimeout(() => setEditProjectPromptSaved(false), 2000);
			await loadPrompts();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setEditProjectPromptSaving(false);
		}
	};

	const cancelProjectPromptEditor = () => {
		setEditingProjectPrompt(null);
		setEditProjectPromptContent("");
	};

	return (
		<>
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(800px,calc(100vw-48px))]", "project-resources-dialog")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle></DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<header className="project-resources-header">
					<div>
						<strong>{t("projectResources.title")}</strong>
						<small>{props.project.path}</small>
					</div>
					<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")} onClick={props.onClose}>
						<X size={18} strokeWidth={2.2} aria-hidden="true" />
					</Button>
				</header>

				<div className="project-resources-toolbar">
					<div className="project-resources-tabs">
						{/* 分段 tab 保留原生：下划线式 active 指示是自定义语义，shadcn Tabs 未引入，
							强行套 Button 会与 .project-resources-tabs 的 border-bottom 样式冲突，
							待 P1 弹窗体系收口时统一引入 shadcn Tabs 迁移。 */}
						<button
							type="button"
							className={activeTab === "skills" ? "active" : ""}
							onClick={() => { setActiveTab("skills"); setEditingSkill(null); }}
						>
							{t("projectResources.skillsTab", { count: data.skills.length })}
						</button>
						<button
							type="button"
							className={activeTab === "extensions" ? "active" : ""}
							onClick={() => setActiveTab("extensions")}
						>
							{t("projectResources.extensionsTab", { count: data.extensions.length })}
						</button>
						<button
							type="button"
							className={activeTab === "prompts" ? "active" : ""}
							onClick={() => setActiveTab("prompts")}
						>
							{t("projectResources.promptsTab", { count: prompts.length })}
						</button>
					</div>
					<Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void refresh(true)} disabled={loading}>
						{loading ? t("common.loading") : t("common.refresh")}
					</Button>
				</div>

				{error && <div className="project-resources-error">{error}</div>}

				{editingSkill ? (
					<div className="prompts-editor-backdrop" onClick={() => setEditingSkill(null)}>
						<div className="prompts-editor-modal" onClick={(e) => e.stopPropagation()}>
							<div className="file-diff-header">
								<span className="file-diff-header-file">{editingSkill.name} · SKILL.md</span>
								<div className="file-diff-header-actions">
									<Button variant="ghost" size="icon-sm" onClick={() => setEditingSkill(null)} aria-label={t("common.close")} title={t("common.close")}>
										<X size={16} />
									</Button>
								</div>
							</div>
							{editLoading ? (
								<div className="py-12 text-center text-[13px] text-text-tertiary">{t("common.loading")}</div>
							) : (
								<div className="prompts-monaco-wrap">
									<CodeMirrorEditor
										value={editContent}
										onChange={setEditContent}
									/>
								</div>
							)}
							{editSaved && <span className="file-diff-hint saved">{t("config.promptSavedHint")}</span>}
						</div>
					</div>
				) : activeTab === "skills" ? (
					<div className="project-resources-body">
						<div className="project-resources-col-header">
							<strong>{t("projectResources.createSkill")}</strong>
						</div>
						<div className="project-resources-list-header">
							<strong>{t("projectResources.skillsTab", { count: data.skills.length })}</strong>
							<span>{data.skills.length}</span>
						</div>
						<section className="project-skill-create">
							<p>{t("projectResources.createSkillHint")}</p>
							<Label className="project-resources-name-field">
								<span>{t("config.name")}</span>
								<Input value={newName} placeholder="my-project-skill" onChange={(event) => setNewName(event.target.value)} />
							</Label>
							<Label className="project-resources-desc-field">
								<span>{t("config.description")}</span>
								<Textarea value={newDescription} placeholder="Use when..." onChange={(event) => setNewDescription(event.target.value)} />
							</Label>
							<Button  variant="default" onClick={createSkill} disabled={!canCreateSkill || createBusy}>
								{createBusy ? t("config.creatingSkill") : t("config.addSkill")}
							</Button>
						</section>
						<div className="project-resources-list-section">
						<ResourceListEmpty loading={loading} empty={data.skills.length === 0} label={t("projectResources.emptySkills")} />
						{data.skills.map((skill) => (
							<article key={skill.id} className="project-resource-card">
								<button
									type="button"
									className="project-resource-info"
									onClick={() => void openEditor(skill)}
									title={t("common.edit")}
								>
									<div className="project-resource-title">
										{renamingSkill === skill.id ? (
											<div className="skill-rename-inline">
												<Input
											value={renameSkillValue}
											onChange={(e) => setRenameSkillValue(e.target.value)}
													onKeyDown={(e) => { if (e.key === "Enter") void renameSkillConfirm(skill, renameSkillValue); if (e.key === "Escape") setRenamingSkill(null); }}
													autoFocus
													disabled={renameSkillBusy}
												/>
												{/* 内联行内按钮用 icon-xs（24px），避免 icon-sm 32px 撑高 28px 输入行 */}
												<Button variant="ghost" size="icon-xs" onClick={() => void renameSkillConfirm(skill, renameSkillValue)} disabled={renameSkillBusy} title={t("common.confirm")}>
													<Check size={14} strokeWidth={2} />
												</Button>
												<Button variant="ghost" size="icon-xs" onClick={() => setRenamingSkill(null)} disabled={renameSkillBusy} title={t("common.cancel")}>
													<X size={14} strokeWidth={2} />
												</Button>
											</div>
										) : (
											<strong>{skill.name}</strong>
										)}
										<span className="skill-badges">
											<span className={`skill-state ${skill.enabled ? "enabled" : "disabled"}`}>
												{skill.enabled ? t("common.enabled") : t("common.disabled")}
											</span>
											{!skill.valid && <span className="skill-state invalid">{t("config.needsFix")}</span>}
										</span>
									</div>
									<small>{skill.description || t("config.skillDescriptionMissing")}</small>
								<small>{skill.sourceLabel} · {skill.path}</small>
								</button>
								<div className="skill-card-actions project-resource-actions">
									{/* hover 显隐由 .project-resource-actions 控制；换 shadcn ghost 图标按钮统一尺寸 */}
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => void openEditor(skill)}
										title={t("common.edit")}
									>
										<Pencil size={14} strokeWidth={1.8} />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => { setRenamingSkill(skill.id); setRenameSkillValue(skill.name); }}
										title={t("common.rename")}
									>
										<FileEdit size={14} strokeWidth={1.8} />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => void toggleSkill(skill)}
										title={skill.enabled ? t("common.disable") : t("common.enabled")}
										style={skill.enabled ? { color: "var(--color-accent)" } : undefined}
									>
										{skill.enabled ? <ToggleRight size={18} strokeWidth={1.8} /> : <ToggleLeft size={18} strokeWidth={1.8} />}
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										className="text-destructive hover:bg-destructive/10 hover:text-destructive"
										onClick={() => setDeleteTarget({ kind: "skill", item: skill })}
										title={t("common.delete")}
									>
										<Trash2 size={14} strokeWidth={1.8} />
									</Button>
								</div>
							</article>
						))}
						</div>
					</div>
				) : activeTab === "extensions" ? (
					<div className="project-resources-body">
						<div className="project-resources-col-header">
							<strong>{t("projectResources.extensionsTab", { count: data.extensions.length })}</strong>
						</div>
						<div className="project-resources-list-header">
							<strong>{t("projectResources.extensionsTab", { count: data.extensions.length })}</strong>
							<span>{data.extensions.length}</span>
						</div>
						<section className="project-skill-create">
						</section>
						<div className="project-resources-list-section">
							<ResourceListEmpty loading={loading} empty={data.extensions.length === 0} label={t("projectResources.emptyExtensions")} />
						{data.extensions.map((extension) => (
							<article key={extension.id} className="project-resource-card">
								<div className="project-resource-info">
									<div className="project-resource-title">
										<strong>{extension.source}</strong>
										<span className={`skill-state ${extension.enabled === false ? "disabled" : "enabled"}`}>
											{extension.enabled !== false ? t("common.enabled") : t("common.disabled")}
										</span>
										<span className="skill-state enabled">{t("projectResources.projectScope")}</span>
									</div>
									<small>{extension.path}</small>
								</div>
								<div className="skill-card-actions project-resource-actions">
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => void toggleExtension(extension)}
										title={extension.enabled !== false ? t("common.disable") : t("common.enabled")}
										style={extension.enabled !== false ? { color: "var(--color-accent)" } : undefined}
									>
										{extension.enabled !== false ? <ToggleRight size={18} strokeWidth={1.8} /> : <ToggleLeft size={18} strokeWidth={1.8} />}
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										className="text-destructive hover:bg-destructive/10 hover:text-destructive"
										onClick={() => setDeleteTarget({ kind: "extension", item: extension })}
										disabled={!extension.path}
										title={t("common.delete")}
									>
										<Trash2 size={14} strokeWidth={1.8} />
									</Button>
								</div>
							</article>
						))}
						</div>
					</div>
				) : editingProjectPrompt ? (
					<div className="prompts-editor-backdrop" onClick={cancelProjectPromptEditor}>
						<div className="prompts-editor-modal" onClick={(e) => e.stopPropagation()}>
							<div className="file-diff-header">
								<span className="file-diff-header-file">{editingProjectPrompt.name}.md</span>
								<div className="file-diff-header-actions">
									<Button variant="ghost" size="icon-sm" onClick={cancelProjectPromptEditor} aria-label={t("common.close")} title={t("common.close")}>
										<X size={16} />
									</Button>
								</div>
							</div>
							{editProjectPromptLoading ? (
								<div className="py-12 text-center text-[13px] text-text-tertiary">{t("common.loading")}</div>
							) : (
								<div className="prompts-monaco-wrap">
									<CodeMirrorEditor
										value={editProjectPromptContent}
										onChange={setEditProjectPromptContent}
									/>
								</div>
							)}
							{editProjectPromptSaved && <span className="file-diff-hint saved">{t("config.promptSavedHint")}</span>}
						</div>
					</div>
				) : (
					<div className="project-resources-body">
						<div className="project-resources-col-header">
							<strong>{t("projectResources.createPrompt")}</strong>
						</div>
						<div className="project-resources-list-header">
							<strong>{t("projectResources.promptsTab", { count: prompts.length })}</strong>
							<span>{prompts.length}</span>
						</div>
						<section className="project-skill-create">
							<Label className="project-resources-name-field">
								<span>{t("config.name")}</span>
								<Input value={newPromptName} placeholder="my-project-prompt" onChange={(event) => setNewPromptName(event.target.value)} />
							</Label>
							<Label className="project-resources-desc-field">
								<span>{t("config.description")}</span>
								<Textarea value={newPromptDescription} placeholder="Use when..." onChange={(event) => setNewPromptDescription(event.target.value)} />
							</Label>
							<Button  variant="default" onClick={createProjectPrompt} disabled={!canCreatePrompt || creatingPrompt}>
								{creatingPrompt ? t("config.creatingSkill") : t("config.addSkill")}
							</Button>
						</section>
						<div className="project-resources-list-section">
						<ResourceListEmpty loading={promptsLoading} empty={prompts.length === 0} label={t("projectResources.emptyPrompts")} />
						{prompts.map((prompt) => (
							<article key={prompt.path} className="project-resource-card">
								{/* 整卡可点击区保留原生 button：内容是 title/desc 排版容器，非图标按钮 */}
								<button
									type="button"
									className="project-resource-info"
									onClick={() => void openProjectPromptEditor(prompt)}
									title={t("common.edit")}
								>
									<div className="project-resource-title">
										<strong>/{prompt.name}</strong>
									</div>
									<small>{prompt.description}</small>
									<small>{prompt.path}</small>
								</button>
								<div className="skill-card-actions project-resource-actions">
									<Button
										variant="ghost"
										size="icon-sm"
										onClick={() => void openProjectPromptEditor(prompt)}
										title={t("common.edit")}
									>
										<Pencil size={14} strokeWidth={1.8} />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										className="text-destructive hover:bg-destructive/10 hover:text-destructive"
										onClick={() => setDeleteTarget({ kind: "prompt", item: prompt })}
										title={t("common.delete")}
									>
										<Trash2 size={14} strokeWidth={1.8} />
									</Button>
								</div>
							</article>
						))}
						</div>
					</div>
				)}
			
			</DialogContent>
		</Dialog>

			{/* 统一确认删除弹框（#115 U5：换 shadcn ConfirmDialog） */}
			{deleteTarget && (
				<ConfirmDialog
					title={t("common.deleteConfirm")}
					message={deleteTarget.kind === "skill"
						? t("projectResources.deleteSkillConfirm", { name: deleteTarget.item.name })
						: deleteTarget.kind === "extension"
							? t("projectResources.deleteExtensionConfirm", { name: deleteTarget.item.source })
							: t("projectResources.deletePromptConfirm", { name: deleteTarget.item.name })}
					confirmLabel={deleteBusy ? t("common.deleting") : t("common.delete")}
					danger
					onCancel={() => { if (!deleteBusy) setDeleteTarget(null); }}
					onConfirm={() => void confirmDelete()}
				/>
			)}
		</>
	);
}

function ResourceListEmpty(props: { loading: boolean; empty: boolean; label: string }) {
	if (props.loading) return <div className="py-12 text-center text-[13px] text-text-tertiary">{t("common.loading")}</div>;
	if (props.empty) return <div className="py-12 text-center text-[13px] text-text-tertiary">{props.label}</div>;
	return null;
}
