import { app } from "electron";
import { join } from "node:path";
import { isLocalProject } from "../../shared/projectLocation";
import { toWslLinuxPath } from "../wsl/WslPaths";
import type { AgentManager } from "../pi/AgentManager";
import { PiResourceConfigService, isPackageSource } from "../config/PiResourceConfigService";
import { PiResourceStateStore } from "../config/PiResourceStateStore";
import type { ResolvedMigrationResource } from "../config/piResourceMigration";
import { runGlobalResourceMigration, runProjectResourceMigration } from "../config/piResourceMigrationRunner";
import { runPackageRootRuleRepair, type PackageRootRuleRepairDeps } from "../config/piPackageRootRuleRepair";
import type { ConfigManager } from "../config/ConfigManager";
import type { ExtensionManager } from "../extensions/ExtensionManager";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectResourceManager } from "../projects/ProjectResourceManager";
import type { ProjectStore } from "../projects/ProjectStore";
import type { PromptManager } from "../prompts/PromptManager";
import type { SettingsStore } from "../settings/SettingsStore";
import type { SkillManager } from "../skills/SkillManager";

/**
 * 旧禁用记录 → pi 原生配置迁移（计划 A3/A5；自 index.ts 的 whenReady 装配体就地外移，行为零变化）。
 *
 * 启动期一次性执行：旧列表一旦被清理，原生过滤就是唯一生效来源。失败/未解析时保留旧记录并记日志
 * （下次启动幂等重试），不静默打开用户禁用的资源。迁移必须在任何 Agent spawn 前跑完，
 * 所以这里同时把 `ensureResourceMigration` 交给 AgentManager 作为 spawn 前门控。
 */
export interface ResourceMigrationContext {
	readonly agentManager: AgentManager;
	readonly appLogger: AppLogger;
	readonly configManager: ConfigManager;
	readonly extensionManager: ExtensionManager;
	readonly projectResourceManager: ProjectResourceManager;
	readonly projectStore: ProjectStore;
	readonly promptManager: PromptManager;
	readonly refreshExtensionProjection: () => Promise<void>;
	readonly refreshPromptProjection: () => Promise<void>;
	readonly refreshSkillProjection: () => Promise<void>;
	readonly settingsStore: SettingsStore;
	readonly skillManager: SkillManager;
	readonly assign: (patch: { piResourceStateStore?: PiResourceStateStore; piResourceConfigService?: PiResourceConfigService; ensurePiResourceMigration?: (projectId?: string) => Promise<void> }) => void;
}

export function startResourceMigration(ctx: ResourceMigrationContext): void {
	const { agentManager, appLogger, configManager, extensionManager, projectResourceManager, projectStore, promptManager, refreshExtensionProjection, refreshPromptProjection, refreshSkillProjection, settingsStore, skillManager, assign } = ctx;

	// ── 旧禁用记录 → pi 原生配置迁移（计划 A3/A5）──
	// 启动期一次性执行：旧列表一旦被清理，原生过滤就是唯一生效来源。
	// 失败/未解析时保留旧记录并记日志（下次启动幂等重试），不静默打开用户禁用的资源。
	const piResourceStateStore = new PiResourceStateStore(join(app.getPath("userData"), "pi-native-resources.json"));
	const piResourceConfigService = new PiResourceConfigService(
		{
			globalSettingsPath: () => join(configManager.getConfigDir(), "settings.json"),
			resolveProject: async (projectId) => {
				const project = projectStore.get(projectId);
				// pi 原生资源配置作用在本机 `.pi/settings.json`：远端项目没有本机 root，按「项目不适用」返回 null。
				if (!project || project.kind === "chat" || !isLocalProject(project)) return null;
				const root = project.path;
				const settings = settingsStore.get();
				const resourceWslDistro = project.environment === "wsl" ? (project.wslDistro ?? settings.wslDistro) : undefined;
				const trustPath = process.platform === "win32" && resourceWslDistro !== undefined ? toWslLinuxPath(root, { distro: resourceWslDistro }) : root;
				return { root, trusted: (await configManager.getProjectTrustDecision(trustPath)) === true };
			},
		},
		piResourceStateStore,
		{ projectTrust: async (projectId, _root) => (await configManager.getProjectTrustDecision(projectStore.get(projectId)?.path ?? "")) === true },
	);
	assign({ piResourceStateStore, piResourceConfigService });
	/**
	 * 迁移依赖：全局与项目共用（项目迁移也需要全局资源做名称→路径映射）。
	 * 迁移是「旧禁用记录 → 原生过滤规则」的唯一入口，必须在任何 Agent spawn 前跑完，
	 * 否则退出白名单后旧记录不再有任何生效途径（见计划 A5）。
	 */
	const migrationDeps: import("../config/piResourceMigrationRunner").MigrationRunnerDeps = {
		service: piResourceConfigService,
		state: piResourceStateStore,
		readSettings: () => settingsStore.get(),
		resolveGlobalResources: async () => {
			const settings = settingsStore.get();
			const resources: ResolvedMigrationResource[] = [];
			// 迁移只需要「旧禁用记录里的名字 → 原生过滤匹配值」的映射，直接用各 Manager
			// 的列表（它们已按原生规则投影状态，但这里要的是全部条目，与启用与否无关）。
			const extensionList = await extensionManager?.list(false).catch(() => null);
			for (const item of extensionList?.extensions ?? []) {
				if (!item.source || item.builtIn) continue;
				// 包安装的扩展：`item.path` 是**包目录**，不能当顶层过滤值（写进去就是惰性规则，
				// 让开关投影误判停用）；带 packageSource 后由规划器改成「整包停用」。
				resources.push({ kind: "extensions", name: item.source, value: item.path ?? item.source, scope: item.scope === "project" ? "project" : "user", ...(isPackageSource(item.source) ? { packageSource: item.source } : {}) });
			}
			const skills = await skillManager?.list().catch(() => null);
			for (const skill of skills?.skills ?? []) {
				// pideck-global（自带技能）也要参与映射：老版本把它们装在 pi 的全局目录，
				// 迁移时把旧禁用名翻成新路径的 -path 规则，用户的停用意图才不会丢。
				if (skill.sourceId !== "pi-global" && skill.sourceId !== "agents-global" && skill.sourceId !== "pideck-global") continue;
				resources.push({ kind: "skills", name: skill.name, value: skill.path, scope: "user" });
			}
			const prompts = await promptManager?.list().catch(() => null);
			for (const template of prompts?.templates ?? []) {
				if (template.scope === "project") continue;
				resources.push({ kind: "prompts", name: template.name, value: template.path, scope: "user" });
			}
			return resources;
		},
		readProjectLegacyState: async (projectId) => projectResourceManager.readProjectLegacyDisables(projectId),
		resolveProjectResources: async (projectId) => {
			const project = projectStore.get(projectId);
			if (!project) return [];
			const resources: ResolvedMigrationResource[] = [];
			for (const skill of (await projectResourceManager.list(projectId).catch(() => null))?.skills ?? []) {
				if (typeof skill.path === "string") resources.push({ kind: "skills", name: skill.name, value: skill.path, scope: "project" });
			}
			return resources;
		},
		writeSettingsPatch: async (patch) => {
			await settingsStore.update(patch as Parameters<typeof settingsStore.update>[0]);
		},
		clearProjectLegacyState: async (projectId, patch) => {
			await projectResourceManager.clearProjectLegacyDisables(projectId, patch);
		},
		logger: { info: (scope, message, detail) => void appLogger.info(scope, message, detail), warn: (scope, message, detail) => void appLogger.warn(scope, message, detail) },
	};
	/**
	 * 包目录路径规则清理（幂等）：历史迁移曾把「指向包安装的禁用」写成顶层 `-<包目录>`，
	 * 对 pi 惰性却让列表投影误判停用。npm 包只装在两处：全局 install 目录与项目 `.pi/npm`。
	 */
	const packageRootRuleRepairDeps: PackageRootRuleRepairDeps = {
		service: {
			stripPackageRootResourceRules: async (scope, packageDirs) => {
				const service = piResourceConfigService;
				if (!service) return { ok: false, error: "pi resource service unavailable", removed: [] };
				return service.stripPackageRootResourceRules(scope, packageDirs);
			},
		},
		npmRoot: (scope) => {
			if (scope.scope === "project") {
				const project = projectStore.get(scope.projectId);
				return project && isLocalProject(project) ? join(project.path, ".pi", "npm", "node_modules") : "";
			}
			return join(configManager.getConfigDir(), "npm", "node_modules");
		},
		logger: { info: (scope, message, detail) => void appLogger.info(scope, message, detail), warn: (scope, message, detail) => void appLogger.warn(scope, message, detail) },
	};
	/** 迁移后刷新投影缓存：否则列表仍按旧列表显示，与实际生效的原生规则不一致。 */
	const refreshAllProjections = async (): Promise<void> => {
		await Promise.all([refreshSkillProjection(), refreshPromptProjection(), refreshExtensionProjection()]);
	};
	let globalMigrationRun: Promise<void> | null = null;
	const projectMigrationRuns = new Map<string, Promise<void>>();
	/**
	 * 确保该作用域的旧禁用记录已迁移（幂等、并发复用同一个 Promise）。
	 * Agent spawn 前必须 await：迁移未完成就启动会话会把用户停用的资源重新加载。
	 */
	const ensureResourceMigration = async (projectId?: string): Promise<void> => {
		if (!projectId) {
			globalMigrationRun ??= runGlobalResourceMigration(migrationDeps).then(async (result) => {
				// 先清历史残留的包目录规则，再刷新投影：否则开关仍会显示成停用。
				await runPackageRootRuleRepair(packageRootRuleRepairDeps, { scope: "global" });
				await refreshAllProjections();
				if (result.errors.length > 0) {
					void appLogger.warn("migration", "Global resource migration reported problems", { status: result.status, errors: result.errors });
				}
			});
			return globalMigrationRun;
		}
		let run = projectMigrationRuns.get(projectId);
		if (!run) {
			run = runProjectResourceMigration(migrationDeps, projectId).then(async (result) => {
				await runPackageRootRuleRepair(packageRootRuleRepairDeps, { scope: "project", projectId });
				await refreshAllProjections();
				if (result.errors.length > 0) {
					void appLogger.warn("migration", "Project resource migration reported problems", { projectId, status: result.status, errors: result.errors });
				}
			});
			projectMigrationRuns.set(projectId, run);
		}
		return run;
	};
	// 启动即开始全局迁移（不阻塞窗口创建），并把它交给 AgentManager 在 spawn 前 await。
	void ensureResourceMigration();
	assign({ ensurePiResourceMigration: ensureResourceMigration });
	agentManager.configureResourceMigrationGate(ensureResourceMigration);
}
