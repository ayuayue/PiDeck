/**
 * 启动期迁移执行器（计划 A3/A5 的接线层）。
 *
 * 为什么放在启动：`--no-extensions/--no-skills/--no-prompt-templates` 白名单一旦
 * 退出，旧禁用记录就再无生效途径。若不在退出前把「用户当时关掉的资源」翻译成原生
 * 过滤规则，用户会感觉「升级后我禁用的东西全回来了」。因此：
 *
 *  1. 读取旧记录（PiDeck 应用设置 + 项目 `.pi/settings.json` 私有字段）；
 *  2. 枚举当前可解析资源，生成迁移计划（纯函数，见 piResourceMigration）；
 *  3. 写入原生配置；只有全部成功才清理旧记录；
 *  4. 失败/未解析时保留旧记录并报告，**不静默丢弃用户的禁用意图**。
 *
 * 幂等：迁移完成记录在 PiResourceStateStore；同一环境重复启动不会重复写。
 * 惰性：全局在首次启动时处理一次；项目在打开该项目资源页或启动该项目 Agent 前处理。
 */

import type { AppSettings } from "../../shared/types";
import type { PiResourceConfigService } from "./PiResourceConfigService";
import type { PiResourceStateStore } from "./PiResourceStateStore";
import { applyResourceMigration, buildLegacyStateCleanup, migrationActionKey, planResourceMigration, type LegacyDisabledState, type MigrationPlan, type ResolvedMigrationResource } from "./piResourceMigration";
import { completedMigrationInputs, markResolvedMigrationInputs, pendingMigrationLegacy } from "./piResourceMigrationProgress";

export type LegacySettingsReader = () => Pick<AppSettings, "disabledExtensions" | "disabledSkills" | "disabledPrompts">;

export type ProjectLegacyState = {
	disabledExtensions: string[];
	disabledSkills: string[];
	disabledPrompts: string[];
	inheritedExtensions: string[];
	inheritedSkills: string[];
	inheritedPrompts: string[];
};

export type MigrationRunnerDeps = {
	service: Pick<PiResourceConfigService, "setFileResourceEnabled" | "setPackageEnabled" | "readSummary">;
	state: PiResourceStateStore;
	readSettings: LegacySettingsReader;
	/** 解析当前全局资源（扩展/技能/提示词），用于把名字映射到原生匹配值。 */
	resolveGlobalResources: () => Promise<ResolvedMigrationResource[]>;
	/** 读取项目私有禁用记录（`.pi/settings.json`）。 */
	readProjectLegacyState: (projectId: string) => Promise<ProjectLegacyState | null>;
	resolveProjectResources: (projectId: string) => Promise<ResolvedMigrationResource[]>;
	/** 迁移成功后清理 PiDeck 侧旧记录。 */
	writeSettingsPatch: (patch: { disabledExtensions?: unknown[]; disabledSkills?: string[]; disabledPrompts?: string[] }) => Promise<void>;
	/** 清理项目私有禁用记录（`.pi/settings.json`），仅清理成功迁移的类别。 */
	clearProjectLegacyState: (projectId: string, patch: { extensions?: boolean; skills?: boolean; prompts?: boolean; inherited?: boolean }) => Promise<void>;
	logger?: { info: (scope: string, message: string, detail?: unknown) => void; warn: (scope: string, message: string, detail?: unknown) => void };
};

export type MigrationRunResult = {
	status: "skipped" | "completed" | "partial" | "failed";
	plan?: MigrationPlan;
	applied?: number;
	errors: string[];
};

function canSkipMigration(record: ReturnType<PiResourceStateStore["readMigration"]>): boolean {
	return Boolean(record?.cleanupCompleted && Array.isArray(record.unresolved) && record.unresolved.length === 0);
}

const EMPTY_PROJECT_STATE: ProjectLegacyState = { disabledExtensions: [], disabledSkills: [], disabledPrompts: [], inheritedExtensions: [], inheritedSkills: [], inheritedPrompts: [] };

function legacyStateFrom(deps: MigrationRunnerDeps, project?: ProjectLegacyState): LegacyDisabledState {
	const settings = deps.readSettings();
	return {
		global: {
			disabledExtensions: settings.disabledExtensions ?? [],
			disabledSkills: settings.disabledSkills ?? [],
			disabledPrompts: settings.disabledPrompts ?? [],
			// 白名单总开关已随白名单机制一起移除：历史 true 值不再有任何语义，
			// 迁移按「列表本身从未生效」处理会误判，因此统一按 false（照常迁移列表）。
			disableExtensionWhitelist: false,
		},
		project: project ?? EMPTY_PROJECT_STATE,
	};
}

/** 旧记录是否完全为空：空时直接跳过，不产生无意义的状态文件写入。 */
function hasAnyLegacyDisable(legacy: LegacyDisabledState): boolean {
	const g = legacy.global;
	const p = legacy.project;
	return g.disabledExtensions.length > 0 || g.disabledSkills.length > 0 || g.disabledPrompts.length > 0 || p.disabledExtensions.length > 0 || p.disabledSkills.length > 0 || p.disabledPrompts.length > 0 || p.inheritedExtensions.length > 0 || p.inheritedSkills.length > 0 || p.inheritedPrompts.length > 0;
}

/** 全局迁移：启动时调用一次（已完成后直接跳过）。 */
export async function runGlobalResourceMigration(deps: MigrationRunnerDeps): Promise<MigrationRunResult> {
	return runResourceMigration(deps);
}

/** 项目迁移：打开项目资源页/启动该项目 Agent 前调用（幂等）。 */
export async function runProjectResourceMigration(deps: MigrationRunnerDeps, projectId: string): Promise<MigrationRunResult> {
	return runResourceMigration(deps, projectId);
}

/** 一个作用域一个提交顺序：每条 native 写入落进度 → 清理旧输入 → 发布完成标记。 */
async function runResourceMigration(deps: MigrationRunnerDeps, projectId?: string): Promise<MigrationRunResult> {
	const key = projectId ? `project:${projectId}` : "global:settings";
	let previous: ReturnType<PiResourceStateStore["readMigration"]>;
	try {
		previous = deps.state.readMigration(key);
	} catch (error) {
		return { status: "failed", errors: [String(error)] };
	}
	if (canSkipMigration(previous)) return { status: "skipped", errors: [] };
	const errors: string[] = [];
	let project: ProjectLegacyState | null = null;
	try {
		if (projectId) project = await deps.readProjectLegacyState(projectId);
	} catch (error) {
		errors.push(`read project legacy: ${error instanceof Error ? error.message : String(error)}`);
		return { status: "failed", errors };
	}
	const legacy = legacyStateFrom(deps, project ?? undefined);
	// 全局旧输入由全局门控拥有，项目只把全局资源用作继承规则的解析来源。
	if (projectId) legacy.global = { disabledExtensions: [], disabledSkills: [], disabledPrompts: [], disableExtensionWhitelist: false };
	const completedInputs = completedMigrationInputs(legacy, previous);
	const appliedActions = new Set(previous?.appliedActions ?? []);
	const revisions = { ...previous?.revisions };
	let plan: MigrationPlan = { actions: [], unresolved: [], archived: [] };
	const saveProgress = (cleanupCompleted: boolean) => {
		if (
			!deps.state.recordMigration(key, {
				completedAt: Date.now(),
				cleanupCompleted,
				revisions,
				appliedActions: [...appliedActions],
				completedInputs: [...completedInputs],
				unresolved: plan.unresolved.map((item) => `${item.kind} ${item.name} (${item.scope}): ${item.reason}`),
			})
		)
			throw new Error("migration state write failed; legacy input retained");
	};
	if (!hasAnyLegacyDisable(legacy)) {
		try {
			saveProgress(true);
		} catch (error) {
			return { status: "failed", errors: [String(error)] };
		}
		return { status: "skipped", errors: [] };
	}
	let resources: ResolvedMigrationResource[];
	try {
		resources = [...(await deps.resolveGlobalResources()), ...(projectId ? await deps.resolveProjectResources(projectId) : [])];
	} catch (error) {
		errors.push(`resolve resources: ${error instanceof Error ? error.message : String(error)}`);
		return { status: "failed", errors };
	}
	plan = planResourceMigration({ legacy: pendingMigrationLegacy(legacy, completedInputs), resources, projectId });
	const report = await applyResourceMigration({
		plan,
		service: deps.service,
		alreadyApplied: appliedActions,
		onApplied: (action, writtenRevisions) => {
			appliedActions.add(migrationActionKey(action));
			Object.assign(revisions, writtenRevisions);
			saveProgress(false);
		},
	});
	if (report.failed.length > 0) {
		errors.push(...report.failed.map((item) => `${item.action.kind} ${item.action.value}: ${item.error}`));
		deps.logger?.warn("migration", "Resource migration incomplete; legacy disables kept", { projectId, failed: report.failed.length });
		return { status: report.applied > 0 ? "partial" : "failed", plan, applied: report.applied, errors };
	}
	markResolvedMigrationInputs(legacy, plan, completedInputs);
	try {
		saveProgress(false);
		if (projectId) {
			await deps.clearProjectLegacyState(projectId, {
				extensions: !plan.unresolved.some((item) => item.kind === "extension"),
				skills: !plan.unresolved.some((item) => item.kind === "skill"),
				prompts: !plan.unresolved.some((item) => item.kind === "prompt"),
				inherited: plan.unresolved.length === 0,
			});
		} else {
			await deps.writeSettingsPatch(buildLegacyStateCleanup({ legacy, report }));
		}
		if (plan.unresolved.length === 0) saveProgress(true);
	} catch (error) {
		errors.push(`cleanup/state: ${error instanceof Error ? error.message : String(error)}`);
	}
	const complete = errors.length === 0 && plan.unresolved.length === 0;
	deps.logger?.info("migration", complete ? "Resource migration completed" : "Resource migration pending", { projectId, applied: report.applied, unresolved: plan.unresolved.length });
	return { status: complete ? "completed" : report.applied > 0 || appliedActions.size > 0 || errors.length > 0 ? "partial" : "failed", plan, applied: report.applied, errors };
}
