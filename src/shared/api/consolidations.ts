/**
 * 统一接口聚合层 · 收口映射（consolidations）。
 *
 * sessions 域四子域（catalog/runtime/import/rewind）与 config 域十子库的
 * 「组名 → preload 方法名」映射。T5 接线（composeFacade）依赖本文件完整落盘
 * （FIND-2 方案 a）：门面按组做 Pick 视图，缺失方法静默缺席（S3：不 throw）。
 *
 * 方法名全集与 src/preload/index.ts 的 sessions/config 命名空间逐一核对
 * （sessions 112、config 48，探针快照 tests/unifiedApiChannelSnapshot.test.mjs 锚定通道数）。
 */
import type { ConfigSubstoreId, SessionSubdomainId } from "./domainTypes";

/**
 * sessions 命名空间 111 方法 → 四子域。
 *
 * 裁决（S5，沉默清单，PLAN.md:202）：DSH 方法按语义分组——运行时查询面
 * （listDshModels / discoverDshModels / listDshProviders / listDshAgentPresets / getDshDefaultModel /
 * getDshStatus 等）归 runtime；DSH 互导入口及其 describe 配对
 * （importDsh* / describeDsh* / syncDsh* / listDshForeignSessions / searchDshSessions）归 import。
 */
export const SESSIONS_SUBDOMAINS = {
	catalog: [
		"archiveRecord",
		"copyRecord",
		"createAnonymous",
		"createDraft",
		"deleteArchivedRecord",
		"deleteCatalogMessage",
		"deleteRecord",
		"editCatalogMessage",
		"exportRecordHtml",
		"list",
		"listArchived",
		"listCatalog",
		"onCatalogRefreshed",
		"prepareCatalogResend",
		"readRecordMessagePage",
		"readRecordMessages",
		"removeCatalogMessageImage",
		"searchContent",
		"searchInSession",
		"setFocusedSession",
		"unarchiveRecord",
		"updateRecord",
	],
	runtime: [
		"abortRuntime",
		"activateRuntime",
		"cancelDshQueuedMessage",
		"chooseDshRunnerNode",
		"cloneRuntime",
		"compactRuntime",
		"createDshGoal",
		"deleteArchivedDshSession",
		"deleteRuntimeMessage",
		"detectDshRunnerNode",
		"discoverDshModels",
		"draftCommands",
		// 2027-02 补齐基线遗漏：这两个方法在 preload sessions 命名空间里一直存在，
		// 但从未归入任何子域，导致「四组并集 ≡ 全集」锚点长期偏差 2。
		// 两者都是按目标取提示词模板（草稿 / runtime），与 draftCommands 同语义，归 runtime。
		"draftPromptTemplates",
		"editRuntimeMessage",
		"exportRuntimeHtml",
		"forkRuntimeSession",
		"getDshDefaultModel",
		"getDshRuntimeStatus",
		"getDshSessionPath",
		"getDshStatus",
		"getRuntimeForkMessages",
		"getRuntimeState",
		"installDshPlugin",
		"installDshRunnerNode",
		"installDshRuntime",
		"installDshUserPlugin",
		"listArchivedDshSessions",
		"listDshAgentPresets",
		"listDshDynamicPlugins",
		"listDshModels",
		"listDshOrphans",
		"listDshProviders",
		"listDshSkills",
		"listDshStaticPlugins",
		"listDshSubagents",
		"listDshUserPlugins",
		"listRuntimeCommands",
		"listRuntimeModels",
		"listRuntimePromptTemplates",
		"listRuntimeThinkingLevels",
		"listRuntimes",
		"listSessionSubagents",
		"listSessionTodo",
		"mutateDshSettings",
		"onDshRuntimeInstallProgress",
		"onDshRuntimeStatusChanged",
		"onRuntimeEvent",
		"openDshDocument",
		"prepareRuntimeResend",
		"readDshCredential",
		"readDshSubagentHistory",
		"readMessageFullText",
		"readOutline",
		"readProcessEvents",
		"readReferenceMessages",
		"reloadResources",
		"resolveLaunchDefaults",
		"restartDshHost",
		"restartRuntime",
		"runDshGoalAction",
		"runDshPlugin",
		"searchDshPluginMarket",
		"sendPrompt",
		"sendUiResponse",
		"setDshCredential",
		"setRuntimeModel",
		"setRuntimePermission",
		"setRuntimeThinking",
		"startDshHost",
		"stopDshHost",
		"stopDshPlugin",
		"stopRuntime",
		"unarchiveDshSession",
		"uninstallDshPlugin",
		"uninstallDshRuntime",
		"uninstallDshUserPlugin",
		"unsetDshCredential",
		"updateDshSettings",
	],
	import: ["describeDshCredentials", "describeDshSettings", "importDshForeignSession", "importDshRuntimeDir", "importDshRuntimeFile", "listDshForeignSessions", "searchDshSessions", "syncDshForeignSessions"],
	rewind: ["getBranchTree", "getRewindCheckpointDiff", "listRewindCheckpoints", "restoreRewindCheckpoint"],
} as const satisfies Record<SessionSubdomainId, readonly string[]>;

/**
 * config 命名空间 48 方法 → 十子库（ConfigManager 单类无子 Store，按方法语义分组）。
 * config-backup:* 与 configBackups 7 方法是独立命名空间（config-backup 行），不进本表。
 */
export const CONFIG_SUBSTORES = {
	models: ["fetchModels", "getModels", "saveModels", "onModelsVerifyResult", "discoverExternalAgents", "resolveExternalAgentKey"],
	auth: ["getAuth", "saveAuth"],
	settings: ["getConfigDir", "getSettings", "saveSettings", "saveRaw"],
	mcp: ["getMcp", "saveMcp", "probeMcp", "installMcpSetupSkill", "mcpListStatus", "mcpLogin", "mcpLogout", "onMcpLoginUrl"],
	trust: ["getTrust"],
	tokendance: ["getTokendanceModels", "installTokendance", "tokendanceAuthAwait", "tokendanceAuthCancel", "tokendanceAuthExchange", "tokendanceAuthStart", "tokendanceTopUpCreate", "tokendanceTopUpOpenAlipay", "tokendanceTopUpStatus"],
	usageProbes: ["fetchUsage", "getUsageProbes", "saveUsageProbes", "installUsageSkill", "listUsageProbeStates", "testUsageProbe"],
	resources: ["piResourcesSetBuiltin", "piResourcesSummary"],
	vision: ["visionClearEvents", "visionClearLog", "visionGetConfig", "visionGetEvents", "visionGetLog", "visionSaveConfig"],
	maintenance: ["applyProviderMigration", "previewProviderMigration", "installImageGenSkill", "testProvider", "export", "import"],
} as const satisfies Record<ConfigSubstoreId, readonly string[]>;

/** 子域方法名字面量联合（facadeTypes 的 Pick 视图用）。 */
export type SessionSubdomainMethods<TSubdomain extends SessionSubdomainId> = (typeof SESSIONS_SUBDOMAINS)[TSubdomain][number];

/** 子库方法名字面量联合（facadeTypes 的 Pick 视图用）。 */
export type ConfigSubstoreMethods<TStore extends ConfigSubstoreId> = (typeof CONFIG_SUBSTORES)[TStore][number];
