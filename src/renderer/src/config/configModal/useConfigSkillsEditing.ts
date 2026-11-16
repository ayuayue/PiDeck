import { useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PiDesktopApi } from "../../../../preload";
import type { PiResourceOptions } from "../../../../shared/piConfig";
import type { PiSkillListResult, PiSkillLocation, PiSkillSummary, ProjectResourceDiscoveryResult, ProjectResourceListResult } from "../../../../shared/types";
import { isGlobalSkillSourceId } from "../../../../shared/resourceIdentity";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { emptyProjectResourceData, GLOBAL_SKILL_SOURCES, isGlobalSkill, isProjectSkill, PROJECT_SKILL_SOURCES, type ResourceScope } from "../resourceScopeModel";
import type { PiResourceWriteAction } from "../piResourceTargetModel";

type ConfigSkillsEditingDeps = {
	api: PiDesktopApi;
	resourceScope: ResourceScope;
	/** 资源管理器入口项目：项目作用域下新建 skill 走它。 */
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
	/** 登记到宿主的 UI 计时器（Saved 徽章复位）。 */
	scheduleUiTimer: (fn: () => void, ms: number) => void;
};

/**
 * 技能页（列表 + 编辑器）的草稿状态与增删改动作：只搬数据与 IPC 动作，不渲染。
 * 刷新同时回写 discovery / projectResources——列表要并排展示包与 settings 声明的只读行。
 */
export function useConfigSkillsEditing(deps: ConfigSkillsEditingDeps) {
	const { api, resourceScope, projectId, effectiveProjectId, hasProject, resourceOptions, blockResourceMutation, resourceGenerationRef, bumpResourceGeneration, setDiscoveryData, setProjectResourcesData, clearDirty, setError, notify: showToast, scheduleUiTimer } = deps;

	const [skillsData, setSkillsData] = useState<PiSkillListResult>({
		locations: [],
		skills: [],
	});
	const [creatingSkill, setCreatingSkill] = useState(false);
	const [newSkillName, setNewSkillName] = useState("");
	const [newSkillDescription, setNewSkillDescription] = useState("");
	const [newSkillLocationId, setNewSkillLocationId] = useState<PiSkillLocation["id"]>("pi-global");
	/** Keep the create target inside the selected resource scope. */
	useEffect(() => {
		const allowed = skillsData.locations.filter((location) => (resourceScope === "project" ? PROJECT_SKILL_SOURCES.has(location.id) : GLOBAL_SKILL_SOURCES.has(location.id)));
		if (allowed.length > 0 && !allowed.some((location) => location.id === newSkillLocationId)) {
			setNewSkillLocationId(allowed[0].id);
		}
	}, [newSkillLocationId, resourceScope, skillsData.locations]);
	const [deleteSkillConfirm, setDeleteSkillConfirm] = useState<PiSkillSummary | null>(null);
	const [editingGlobalSkill, setEditingGlobalSkill] = useState<PiSkillSummary | null>(null);
	const [editGlobalContent, setEditGlobalContent] = useState("");
	const [editGlobalLoading, setEditGlobalLoading] = useState(false);
	const [editGlobalSaving, setEditGlobalSaving] = useState(false);
	const [editGlobalSaved, setEditGlobalSaved] = useState(false);

	/**
	 * Refresh global resources and, when in project scope, project-owned resources plus overrides.
	 * Discovery is always requested: the global page renders package/settings owned rows too.
	 */
	const refreshSkills = async () => {
		const generation = resourceGenerationRef.current;
		const projectIdHere = resourceScope === "project" ? effectiveProjectId : undefined;
		const [globalResult, projectResult, discoveryResult] = await Promise.all([api.skills.list(resourceOptions), projectIdHere && hasProject ? api.projectResources.list(projectIdHere) : Promise.resolve(emptyProjectResourceData()), api.projectResources.discovery(projectIdHere)]);
		if (generation !== resourceGenerationRef.current) return;
		setDiscoveryData(discoveryResult);
		setProjectResourcesData(projectResult);
		const locations = [...globalResult.locations, ...projectResult.skillLocations];
		setSkillsData({
			locations,
			skills: [...projectResult.skills, ...globalResult.skills.filter(isGlobalSkill)],
		});
	};

	const handleCreateSkill = async () => {
		if (blockResourceMutation("skills:create")) return;
		setCreatingSkill(true);
		setError(null);
		try {
			if (resourceScope === "project" && projectId) {
				const locationId = newSkillLocationId === "project-agents" ? "project-agents" : "project-pi";
				await api.projectResources.createSkill({
					projectId,
					name: newSkillName,
					description: newSkillDescription,
					locationId,
				});
			} else {
				await api.skills.create({ name: newSkillName, description: newSkillDescription, locationId: newSkillLocationId }, resourceOptions);
			}
			setNewSkillName("");
			setNewSkillDescription("");
			bumpResourceGeneration();
			await refreshSkills();
			showToast(t("config.skillCreatedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreatingSkill(false);
		}
	};

	const handleToggleSkill = async (skill: PiSkillSummary, enabled: boolean) => {
		if (blockResourceMutation("skills:toggle")) return;
		setError(null);
		try {
			if (resourceScope === "project" && effectiveProjectId) {
				if (isProjectSkill(skill)) {
					await api.projectResources.toggleSkill(effectiveProjectId, skill.path, enabled);
				} else if (isGlobalSkill(skill) && isGlobalSkillSourceId(skill.sourceId)) {
					if (skill.enabled === false) {
						// A globally disabled skill cannot be re-enabled from project scope.
						showNotice(t("config.resourceScope.inheritedReadOnly"), 4000, "warning");
						return;
					}
					await api.projectResources.toggleInherited({
						projectId: effectiveProjectId,
						kind: "skill",
						// 原生规则写的是 pi 能匹配的文件路径；身份键（pi-global:<名>）pi 不认，写了也不生效
						key: skill.path,
						enabled,
					});
				}
			} else {
				await api.skills.toggle(skill.path, enabled, resourceOptions);
			}
			bumpResourceGeneration();
			await refreshSkills();
			showToast(enabled ? t("config.skillEnabledToast") : t("config.skillDisabledToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const confirmDeleteSkill = async () => {
		if (blockResourceMutation("skills:delete")) return;
		if (!deleteSkillConfirm) return;
		const target = deleteSkillConfirm;
		setDeleteSkillConfirm(null);
		setError(null);
		try {
			if (resourceScope === "project" && !isProjectSkill(target)) return;
			if (resourceScope === "project" && effectiveProjectId) {
				await api.projectResources.deleteSkill(effectiveProjectId, target.path);
			} else {
				await api.skills.delete(target.path, resourceOptions);
			}
			bumpResourceGeneration();
			await refreshSkills();
			showToast(t("config.skillDeletedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleRenameGlobalSkill = async (skill: PiSkillSummary, newName: string) => {
		if (blockResourceMutation("skills:rename")) return;
		setError(null);
		try {
			if (resourceScope === "project" && !isProjectSkill(skill)) {
				// Inherited global rows are read-only in project scope; never mutate the global skill.
				showNotice(t("config.resourceScope.inheritedReadOnly"), 4000, "warning");
				return;
			}
			if (resourceScope === "project" && isProjectSkill(skill) && effectiveProjectId) {
				await api.projectResources.renameSkill(effectiveProjectId, skill.path, newName);
			} else {
				await api.skills.rename(skill.path, newName, resourceOptions);
			}
			bumpResourceGeneration();
			await refreshSkills();
			showToast(t("config.skillRenamedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleEditGlobalSkill = async (skill: PiSkillSummary) => {
		if (blockResourceMutation("skills:edit")) return;
		// Inherited global rows are read-only in project scope.
		if (resourceScope === "project" && !isProjectSkill(skill)) {
			showNotice(t("config.resourceScope.inheritedReadOnly"), 4000, "warning");
			return;
		}
		setEditingGlobalSkill(skill);
		setEditGlobalContent("");
		setEditGlobalLoading(true);
		setError(null);
		try {
			const accessScope = isProjectSkill(skill) && effectiveProjectId ? { projectId: effectiveProjectId } : undefined;
			const content = await api.files.readContent(skill.path, undefined, accessScope);
			setEditGlobalContent(content);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingGlobalSkill(null);
		} finally {
			setEditGlobalLoading(false);
		}
	};

	// Ctrl+S / Cmd+S 快捷键保存 skill 编辑器
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s" && editingGlobalSkill && !editGlobalSaving) {
				e.preventDefault();
				void saveGlobalSkillEditor();
			}
		};
		if (editingGlobalSkill) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [editingGlobalSkill, editGlobalSaving]);

	const saveGlobalSkillEditor = async (): Promise<boolean> => {
		if (!editingGlobalSkill || editGlobalSaving) return false;
		setEditGlobalSaving(true);
		setError(null);
		try {
			const accessScope = isProjectSkill(editingGlobalSkill) && effectiveProjectId ? { projectId: effectiveProjectId } : undefined;
			await api.files.writeContent(editingGlobalSkill.path, editGlobalContent, accessScope);
			clearDirty("skills");
			setEditGlobalSaved(true);
			scheduleUiTimer(() => setEditGlobalSaved(false), 2000);
			bumpResourceGeneration();
			await refreshSkills();
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setEditGlobalSaving(false);
		}
	};

	return {
		skillsData,
		creatingSkill,
		newSkillName,
		setNewSkillName,
		newSkillDescription,
		setNewSkillDescription,
		newSkillLocationId,
		setNewSkillLocationId,
		deleteSkillConfirm,
		setDeleteSkillConfirm,
		editingGlobalSkill,
		setEditingGlobalSkill,
		editGlobalContent,
		setEditGlobalContent,
		editGlobalLoading,
		editGlobalSaving,
		editGlobalSaved,
		refreshSkills,
		handleCreateSkill,
		handleToggleSkill,
		confirmDeleteSkill,
		handleRenameGlobalSkill,
		handleEditGlobalSkill,
		saveGlobalSkillEditor,
	};
}
