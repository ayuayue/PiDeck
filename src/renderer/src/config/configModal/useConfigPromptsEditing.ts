import { useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { PiResourceOptions } from "../../../../shared/piConfig";
import type { PiPromptTemplateListResult, PiPromptTemplateSummary, ProjectResourceDiscoveryResult, ProjectResourceListResult } from "../../../../shared/types";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { translateBuiltinPromptDescription } from "../../composerBehavior";
import { emptyProjectResourceData, isProjectPrompt, type ResourceScope } from "../resourceScopeModel";
import type { PiResourceWriteAction } from "../piResourceTargetModel";

type ConfigPromptsEditingDeps = {
	api: PiDesktopApi;
	resourceScope: ResourceScope;
	/** 资源管理器入口项目：项目作用域下新建模板走它。 */
	projectId: string | undefined;
	effectiveProjectId: string | undefined;
	hasProject: boolean;
	resourceOptions: PiResourceOptions | undefined;
	/** 资源写门禁：true = 当前目标下该动作被拦下，调用方直接返回。 */
	blockResourceMutation: (action: PiResourceWriteAction) => boolean;
	resourceGenerationRef: MutableRefObject<number>;
	bumpResourceGeneration: () => void;
	setDiscoveryData: Dispatch<SetStateAction<ProjectResourceDiscoveryResult>>;
	setProjectResourcesData: Dispatch<SetStateAction<ProjectResourceListResult>>;
	clearDirty: (tabKey: string) => void;
	setError: Dispatch<SetStateAction<string | null>>;
	/** 成功提示出口（宿主统一走 showNotice）。 */
	notify: (message: string) => void;
};

/**
 * 提示词模板页（列表 + 编辑器）的草稿状态与增删改动作：只搬数据与 IPC 动作，不渲染。
 * 刷新同时回写 discovery / projectResources——列表要并排展示包与 settings 声明的只读行。
 */
export function useConfigPromptsEditing(deps: ConfigPromptsEditingDeps) {
	const { api, resourceScope, projectId, effectiveProjectId, hasProject, resourceOptions, blockResourceMutation, resourceGenerationRef, bumpResourceGeneration, setDiscoveryData, setProjectResourcesData, clearDirty, setError, notify: showToast } = deps;

	const [promptsData, setPromptsData] = useState<PiPromptTemplateListResult>({
		templates: [],
		globalDir: "",
	});
	const [creatingPrompt, setCreatingPrompt] = useState(false);
	const [newPromptName, setNewPromptName] = useState("");
	const [newPromptDescription, setNewPromptDescription] = useState("");
	const [editingPrompt, setEditingPrompt] = useState<PiPromptTemplateSummary | null>(null);
	const [editPromptContent, setEditPromptContent] = useState("");
	const [editPromptLoading, setEditPromptLoading] = useState(false);
	const [editPromptSaving, setEditPromptSaving] = useState(false);
	/** 用户已删除的内置模板名称（仅当前会话有效） */
	const [deletedBuiltinNames, setDeletedBuiltinNames] = useState<Set<string>>(new Set());
	/** 待确认删除的 Prompt 模板（删除前弹确认框） */
	const [deletePromptConfirm, setDeletePromptConfirm] = useState<PiPromptTemplateSummary | null>(null);

	/**
	 * 刷新 prompt templates 列表：project 自有数据仅在 project scope 拉取，旧响应不得覆盖新 scope 结果。
	 * discovery 例外：它同时解析全局 settings.json 的 packages/显式路径，全局页也要展示这些只读行，
	 * 因此总是请求（无项目时 projectId 传 undefined，后端只返回全局来源）。
	 */
	const refreshPrompts = async () => {
		const generation = resourceGenerationRef.current;
		const projectIdHere = resourceScope === "project" ? effectiveProjectId : undefined;
		const [globalResult, projectResult, projectResourceResult, discoveryResult] = await Promise.all([
			api.prompts.list(resourceOptions),
			projectIdHere && hasProject ? api.prompts.listByProject(projectIdHere) : Promise.resolve(null),
			projectIdHere && hasProject ? api.projectResources.list(projectIdHere) : Promise.resolve(emptyProjectResourceData()),
			api.projectResources.discovery(projectIdHere),
		]);
		if (generation !== resourceGenerationRef.current) return;
		const globalTemplates = globalResult.templates
			.filter((template) => template.userCreated || !deletedBuiltinNames.has(template.name))
			.map((template) => ({
				...template,
				description: translateBuiltinPromptDescription(template),
			}));
		setDiscoveryData(discoveryResult);
		setProjectResourcesData(projectResourceResult);
		setPromptsData({
			...globalResult,
			templates: [...(projectResult?.templates ?? []), ...globalTemplates],
		});
	};

	/** 创建新 prompt template */
	const handleCreatePrompt = async () => {
		if (blockResourceMutation("prompts:create")) return;
		setCreatingPrompt(true);
		setError(null);
		try {
			if (resourceScope === "project" && projectId) {
				await api.prompts.createInProject(projectId, {
					name: newPromptName,
					description: newPromptDescription,
				});
			} else {
				await api.prompts.create({ name: newPromptName, description: newPromptDescription }, resourceOptions);
			}
			setNewPromptName("");
			setNewPromptDescription("");
			bumpResourceGeneration();
			await refreshPrompts();
			showToast(t("config.promptCreatedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreatingPrompt(false);
		}
	};

	/** 确认删除 prompt template */
	const confirmDeletePrompt = async (target: PiPromptTemplateSummary) => {
		if (blockResourceMutation("prompts:delete")) return;
		// 先关弹框再干活（与 confirmDeleteSkill 同款）：ConfirmDialog 是受控的，
		// 不在这里清状态，删完弹框会一直挂在页面上，而且取消也会变得无反应（#518）。
		setDeletePromptConfirm(null);
		setError(null);
		if (resourceScope === "project" && !isProjectPrompt(target)) return;
		if (target.userCreated) {
			try {
				if (isProjectPrompt(target) && effectiveProjectId) {
					await api.prompts.deleteFromProject(effectiveProjectId, target.name);
				} else {
					await api.prompts.delete(target.path, resourceOptions);
				}
				bumpResourceGeneration();
				await refreshPrompts();
				showToast(t("config.promptDeletedToast"));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		} else {
			// 内置模板：从显示列表中移除
			setDeletedBuiltinNames((prev) => new Set(prev).add(target.name));
			showToast(t("config.promptDeletedToast"));
		}
	};

	/** 打开 prompt template 编辑器 */
	const handleEditPrompt = async (template: PiPromptTemplateSummary) => {
		// Inherited global rows are read-only in project scope.
		if (resourceScope === "project" && !isProjectPrompt(template)) {
			showNotice(t("config.resourceScope.inheritedReadOnly"), 4000, "warning");
			return;
		}
		// 内置模板直接使用预加载的 content，无需从文件读取
		if (!template.userCreated) {
			setEditingPrompt(template);
			setEditPromptContent(template.content);
			setEditPromptLoading(false);
			setError(null);
			return;
		}
		setEditingPrompt(template);
		setEditPromptContent("");
		setEditPromptLoading(true);
		setError(null);
		try {
			const content = isProjectPrompt(template) && effectiveProjectId ? await api.files.readContent(template.path, undefined, { projectId: effectiveProjectId }) : await api.prompts.edit(template.path, undefined, resourceOptions);
			setEditPromptContent(content as string);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingPrompt(null);
		} finally {
			setEditPromptLoading(false);
		}
	};

	/** 取消编辑 prompt template（放弃未保存修改，清除标记） */
	const handleCancelEditPrompt = () => {
		setEditingPrompt(null);
		setEditPromptContent("");
		clearDirty("prompts");
	};

	/** 保存 prompt template 编辑器内容；返回是否成功（关闭确认框等待其结果再决定是否关闭） */
	const handleSaveEditPrompt = async (): Promise<boolean> => {
		if (!editingPrompt || editPromptSaving) return false;
		setEditPromptSaving(true);
		setError(null);
		try {
			if (!editingPrompt.userCreated) {
				// 内置模板：先创建用户副本，再写入编辑内容
				const created = await api.prompts.create({ name: editingPrompt.name, description: editingPrompt.description }, resourceOptions);
				await api.prompts.edit(created.path, editPromptContent, resourceOptions);
			} else if (isProjectPrompt(editingPrompt) && effectiveProjectId) {
				await api.files.writeContent(editingPrompt.path, editPromptContent, { projectId: effectiveProjectId });
			} else {
				await api.prompts.edit(editingPrompt.path, editPromptContent, resourceOptions);
			}
			clearDirty("prompts");
			showToast(t("config.promptSavedToast"));
			setEditingPrompt(null);
			bumpResourceGeneration();
			await refreshPrompts();
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setEditPromptSaving(false);
		}
	};

	/** Ctrl+S 快速保存：保存但不关闭弹框、不弹提示 */
	const handleRenamePrompt = async (template: PiPromptTemplateSummary, newName: string) => {
		if (blockResourceMutation("prompts:rename")) return;
		setError(null);
		try {
			if (resourceScope === "project" && !isProjectPrompt(template)) {
				// Inherited global rows are read-only in project scope; never mutate the global file.
				showNotice(t("config.resourceScope.inheritedReadOnly"), 4000, "warning");
				return;
			}
			if (isProjectPrompt(template) && effectiveProjectId) {
				await api.prompts.renameInProject(effectiveProjectId, template.name, newName);
			} else {
				await api.prompts.rename(template.name, newName, resourceOptions);
			}
			bumpResourceGeneration();
			await refreshPrompts();
			showToast(t("config.promptRenamedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleTogglePrompt = async (template: PiPromptTemplateSummary, enabled: boolean) => {
		if (blockResourceMutation("prompts:toggle")) return;
		setError(null);
		try {
			if (resourceScope === "project" && effectiveProjectId) {
				if (isProjectPrompt(template)) {
					await api.prompts.toggleInProject(effectiveProjectId, template.name, enabled);
				} else if (template.enabled === false) {
					// A globally disabled template cannot be re-enabled from project scope.
					showNotice(t("config.resourceScope.inheritedReadOnly"), 4000, "warning");
					return;
				} else {
					await api.projectResources.toggleInherited({
						projectId: effectiveProjectId,
						kind: "prompt",
						// 原生规则写的是 pi 能匹配的文件路径；不能传 PiDeck 身份键（pi 不认，写了也不生效）
						key: template.path,
						enabled,
					});
				}
			} else {
				await api.prompts.toggle(template.path, enabled, resourceOptions);
			}
			bumpResourceGeneration();
			await refreshPrompts();
			showToast(enabled ? t("config.promptEnabledToast") : t("config.promptDisabledToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleQuickSavePrompt = async (): Promise<boolean> => {
		if (!editingPrompt || editPromptSaving) return false;
		setEditPromptSaving(true);
		setError(null);
		try {
			if (!editingPrompt.userCreated) {
				const created = await api.prompts.create({ name: editingPrompt.name, description: editingPrompt.description }, resourceOptions);
				await api.prompts.edit(created.path, editPromptContent, resourceOptions);
			} else if (isProjectPrompt(editingPrompt) && effectiveProjectId) {
				await api.files.writeContent(editingPrompt.path, editPromptContent, { projectId: effectiveProjectId });
			} else {
				await api.prompts.edit(editingPrompt.path, editPromptContent, resourceOptions);
			}
			clearDirty("prompts");
			await refreshPrompts();
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setEditPromptSaving(false);
		}
	};

	return {
		promptsData,
		creatingPrompt,
		newPromptName,
		setNewPromptName,
		newPromptDescription,
		setNewPromptDescription,
		editingPrompt,
		setEditingPrompt,
		editPromptContent,
		setEditPromptContent,
		editPromptLoading,
		editPromptSaving,
		deletePromptConfirm,
		setDeletePromptConfirm,
		refreshPrompts,
		handleCreatePrompt,
		confirmDeletePrompt,
		handleEditPrompt,
		handleCancelEditPrompt,
		handleSaveEditPrompt,
		handleRenamePrompt,
		handleTogglePrompt,
		handleQuickSavePrompt,
	};
}
