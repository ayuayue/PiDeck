/**
 * preload resources 域：资源与商店：技能、提示词、扩展、内容更新、技能市场。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe } from "./ipcHelpers";
import type { CreatePiPromptTemplateInput, CreatePiSkillInput, PiCliUpdateResult, PiExtensionListResult, PiPromptTemplateListResult, PiPromptTemplateSummary, PiSkillListResult, PiSkillSummary, PromptStoreItem, PromptStoreSearchResult, ResourceImportApplyInput, ResourceImportApplyResponse, ResourceImportScanInput, ResourceImportScanResponse, SkillContentResult, YaoPromptDbSnapshot, YaoPromptDetailResult, YaoPromptListResult } from "../../shared/types";
import type { BuiltinContentCheckResult, BuiltinContentUpdateResult, BuiltinContentUpdateStatus } from "../../shared/types/contentUpdate";
import type { BuiltInExtensionsCheckResult, BuiltInExtensionsUpdateResult, BuiltInExtensionsUpdateStatus } from "../../shared/types/extensionsUpdate";
import type { SkillHubSearchOptions } from "../../shared/types/skills";

export const resourcesApi = {
	skills: {
		list: (options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.skillsList, options) as Promise<PiSkillListResult>,
		// 读技能 SKILL.md 正文（白名单校验在主进程完成），技能选择器详情/全文插入用。
		readContent: (path: string) => ipcRenderer.invoke(ipcChannels.skillsReadContent, path) as Promise<SkillContentResult>,
		create: (input: CreatePiSkillInput, options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.skillsCreate, input, options) as Promise<PiSkillSummary>,
		toggle: (path: string, enabled: boolean, options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.skillsToggle, path, enabled, options) as Promise<PiSkillSummary>,
		delete: (path: string, options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.skillsDelete, path, options) as Promise<void>,
		openFolder: (path?: string, options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.skillsOpenFolder, path, options) as Promise<void>,
		rename: (skillPath: string, newName: string, options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.skillsRename, skillPath, newName, options) as Promise<PiSkillSummary>,
	},
	resourceImport: {
		scan: (input: ResourceImportScanInput) => ipcRenderer.invoke(ipcChannels.resourceImportScan, input) as Promise<ResourceImportScanResponse>,
		apply: (input: ResourceImportApplyInput) => ipcRenderer.invoke(ipcChannels.resourceImportApply, input) as Promise<ResourceImportApplyResponse>,
	},
	extensions: {
		list: (forceRefresh?: boolean, options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.extensionsList, forceRefresh, options) as Promise<PiExtensionListResult>,
		uninstall: (source: string, scope?: "user" | "project" | "unknown", projectId?: string) => ipcRenderer.invoke(ipcChannels.extensionsUninstall, source, scope, projectId) as Promise<void>,
		install: (source: string, projectId?: string) => ipcRenderer.invoke(ipcChannels.extensionsInstall, source, projectId) as Promise<string>,
		toggle: (source: string, enabled: boolean, scope?: "user" | "project" | "unknown", path?: string, projectId?: string, options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.extensionsToggle, source, enabled, scope, path, projectId, options) as Promise<void>,
		removeBuiltIn: (source: string) => ipcRenderer.invoke(ipcChannels.extensionsRemoveBuiltIn, source) as Promise<void>,
		restoreBuiltIn: (source: string) => ipcRenderer.invoke(ipcChannels.extensionsRestoreBuiltIn, source) as Promise<void>,
		update: () => ipcRenderer.invoke(ipcChannels.extensionsUpdate) as Promise<PiCliUpdateResult>,
		updateOne: (source: string) => ipcRenderer.invoke(ipcChannels.extensionsUpdateOne, source) as Promise<PiCliUpdateResult>,
		catalog: (query: import("../../shared/types").PiPackageCatalogQuery) => ipcRenderer.invoke(ipcChannels.extensionsCatalog, query) as Promise<import("../../shared/types").PiPackageCatalog>,
		// ── 内置扩展热更新（版本号不跟应用版本走；检测走 AtomGit，更新写 userData 覆盖层）──
		builtInStatus: () => ipcRenderer.invoke(ipcChannels.extensionsBuiltInUpdateStatus) as Promise<BuiltInExtensionsUpdateStatus>,
		builtInCheck: (branch?: "main" | "dev") => ipcRenderer.invoke(ipcChannels.extensionsBuiltInUpdateCheck, branch) as Promise<BuiltInExtensionsCheckResult>,
		builtInUpdate: (branch?: "main" | "dev") => ipcRenderer.invoke(ipcChannels.extensionsBuiltInUpdateApply, branch) as Promise<BuiltInExtensionsUpdateResult>,
		builtInRestore: () => ipcRenderer.invoke(ipcChannels.extensionsBuiltInUpdateRestore) as Promise<BuiltInExtensionsUpdateResult>,
		builtInRestorePrevious: () => ipcRenderer.invoke(ipcChannels.extensionsBuiltInUpdateRestorePrevious) as Promise<BuiltInExtensionsUpdateResult>,
		/** 用系统默认程序打开当前生效的内置扩展目录（覆盖层优先，否则随包目录） */
		builtInOpenDir: () => ipcRenderer.invoke(ipcChannels.extensionsBuiltInOpenDir) as Promise<void>,
	},
	// ── 提示词商店官方模板 / 内置技能热更新（与内置扩展同构：sha256 比对 + userData 覆盖层）──
	contentStore: {
		promptsStatus: () => ipcRenderer.invoke(ipcChannels.promptsStoreUpdateStatus) as Promise<BuiltinContentUpdateStatus>,
		promptsCheck: (branch?: "main" | "dev") => ipcRenderer.invoke(ipcChannels.promptsStoreUpdateCheck, branch) as Promise<BuiltinContentCheckResult>,
		promptsUpdate: (branch?: "main" | "dev") => ipcRenderer.invoke(ipcChannels.promptsStoreUpdateApply, branch) as Promise<BuiltinContentUpdateResult>,
		promptsRestore: () => ipcRenderer.invoke(ipcChannels.promptsStoreUpdateRestore) as Promise<BuiltinContentUpdateResult>,
		promptsRestorePrevious: () => ipcRenderer.invoke(ipcChannels.promptsStoreUpdateRestorePrevious) as Promise<BuiltinContentUpdateResult>,
		/** 用系统默认程序打开当前生效的官方模板目录（覆盖层优先，否则随包目录） */
		promptsOpenDir: () => ipcRenderer.invoke(ipcChannels.promptsStoreOpenDir) as Promise<void>,
		skillsStatus: () => ipcRenderer.invoke(ipcChannels.skillsStoreUpdateStatus) as Promise<BuiltinContentUpdateStatus>,
		skillsCheck: (branch?: "main" | "dev") => ipcRenderer.invoke(ipcChannels.skillsStoreUpdateCheck, branch) as Promise<BuiltinContentCheckResult>,
		skillsUpdate: (branch?: "main" | "dev") => ipcRenderer.invoke(ipcChannels.skillsStoreUpdateApply, branch) as Promise<BuiltinContentUpdateResult>,
		skillsRestore: () => ipcRenderer.invoke(ipcChannels.skillsStoreUpdateRestore) as Promise<BuiltinContentUpdateResult>,
		skillsRestorePrevious: () => ipcRenderer.invoke(ipcChannels.skillsStoreUpdateRestorePrevious) as Promise<BuiltinContentUpdateResult>,
		/** 用系统默认程序打开当前生效的内置技能目录（覆盖层优先，否则随包目录） */
		skillsOpenDir: () => ipcRenderer.invoke(ipcChannels.skillsStoreOpenDir) as Promise<void>,
	},
	prompts: {
		list: (options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.promptsList, options) as Promise<PiPromptTemplateListResult>,
		create: (input: CreatePiPromptTemplateInput, options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.promptsCreate, input, options) as Promise<PiPromptTemplateSummary>,
		delete: (filePath: string, options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.promptsDelete, filePath, options) as Promise<void>,
		openFolder: (options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.promptsOpenFolder, options) as Promise<void>,
		edit: (filePath: string, content?: string, options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.promptsEdit, filePath, content, options) as Promise<string | void>,
		listByProject: (projectId: string) => ipcRenderer.invoke(ipcChannels.promptsListByProject, projectId) as Promise<PiPromptTemplateListResult>,
		createInProject: (projectId: string, input: CreatePiPromptTemplateInput) => ipcRenderer.invoke(ipcChannels.promptsCreateInProject, projectId, input) as Promise<PiPromptTemplateSummary>,
		deleteFromProject: (projectId: string, name: string) => ipcRenderer.invoke(ipcChannels.promptsDeleteInProject, projectId, name) as Promise<void>,
		rename: (oldName: string, newName: string, options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.promptsRename, oldName, newName, options) as Promise<PiPromptTemplateSummary>,
		renameInProject: (projectId: string, oldName: string, newName: string) => ipcRenderer.invoke(ipcChannels.promptsRenameInProject, projectId, oldName, newName) as Promise<PiPromptTemplateSummary>,
		toggle: (filePath: string, enabled: boolean, options?: import("../../shared/piConfig").PiResourceOptions) => ipcRenderer.invoke(ipcChannels.promptsToggle, filePath, enabled, options) as Promise<PiPromptTemplateSummary>,
		toggleInProject: (projectId: string, name: string, enabled: boolean) => ipcRenderer.invoke(ipcChannels.promptsToggleInProject, projectId, name, enabled) as Promise<PiPromptTemplateSummary>,
	},
	promptStore: {
		search: (query: string, options?: { limit?: number; type?: string; category?: string; tag?: string }) => ipcRenderer.invoke(ipcChannels.promptStoreSearch, query, options) as Promise<PromptStoreSearchResult>,
		get: (id: string) => ipcRenderer.invoke(ipcChannels.promptStoreGet, id) as Promise<PromptStoreItem>,
		import: (data: { title: string; description: string; content: string; projectId?: string }) => ipcRenderer.invoke(ipcChannels.promptStoreImport, data) as Promise<PiPromptTemplateSummary>,
	},
	yaoPrompts: {
		list: (opts?: { category?: string; search?: string; page?: number; pageSize?: number; categoriesOnly?: boolean }) => ipcRenderer.invoke(ipcChannels.yaoPromptsList, opts) as Promise<YaoPromptListResult>,
		detail: (slug: string, category: string) => ipcRenderer.invoke(ipcChannels.yaoPromptsDetail, slug, category) as Promise<YaoPromptDetailResult>,
		import: (slug: string, category: string, projectId?: string) => ipcRenderer.invoke(ipcChannels.yaoPromptsImport, slug, category, projectId) as Promise<PiPromptTemplateSummary>,
		onDbStateChange: (callback: (state: YaoPromptDbSnapshot) => void) => subscribe(ipcChannels.yaoPromptsDbState, callback),
		retryDb: () => ipcRenderer.invoke(ipcChannels.yaoPromptsDbRetry) as Promise<YaoPromptDbSnapshot>,
	},
	skillStore: {
		search: (query: string) => ipcRenderer.invoke(ipcChannels.skillStoreSearch, query) as Promise<PromptStoreSearchResult>,
		import: (item: PromptStoreItem, locationId?: string, projectId?: string) => ipcRenderer.invoke(ipcChannels.skillStoreImport, item, locationId, projectId) as Promise<PiSkillSummary>,
	},
	skillHub: {
		// 与主进程 handler 共用 SkillHubSearchOptions（query/limit）；旧 page/pageSize/sortBy/order 是
		// api.skillhub.cn 时代遗留参数，主进程从未读取——继续透传会让第二个参数被静默丢弃。
		search: (query: string, limit?: number) => ipcRenderer.invoke(ipcChannels.skillHubSearch, { query, limit } satisfies SkillHubSearchOptions) as Promise<import("../../shared/types").SkillHubSearchResult>,
		detail: (slug: string) => ipcRenderer.invoke(ipcChannels.skillHubDetail, slug) as Promise<import("../../shared/types").SkillHubDetail | null>,
		install: (slug: string, projectId?: string) => ipcRenderer.invoke(ipcChannels.skillHubInstall, slug, projectId) as Promise<import("../../shared/types").SkillHubInstallResult>,
		// 安装进度：主进程节流推送，返回退订函数（渲染层卸载必须退订）
		onInstallProgress: (callback: (progress: import("../../shared/types").SkillHubInstallProgress) => void) => subscribe(ipcChannels.skillHubInstallProgress, callback),
	},
};
