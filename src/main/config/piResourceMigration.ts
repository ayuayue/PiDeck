/**
 * 旧禁用记录 → pi 原生配置的迁移（计划 A3）。
 *
 * 背景：PiDeck 历史上用「禁用列表 + 白名单启动」实现启停，记录存在两个地方：
 * - PiDeck 应用设置：`disabledExtensions`（scope+source）、`disabledSkills`、
 *   `disabledPrompts`、`disableExtensionWhitelist`；
 * - 项目 `.pi/settings.json`：`disabledExtensions/disabledSkills/disabledPrompts`
 *   （私有记录）与 `pideckDisabledGlobal*`（项目里禁用的全局资源）。
 * 这些都不是 pi 原生字段。切到原生配置后必须把「当时真的被禁用的资源」翻译成
 * 原生过滤规则，且**不能反过来把用户关掉的资源重新打开**。
 *
 * 本模块分两步：
 * 1. `planResourceMigration`（纯函数）：把旧记录映射到已解析资源，输出可直接执行的
 *    写入动作与无法解析的条目；
 * 2. `applyResourceMigration`：调用 PiResourceConfigService 写入原生配置，成功后
 *    记录迁移完成；任一步失败都不清理旧记录（下次幂等重试）。
 *
 * 迁移期间旧记录仍是「用户意图」的唯一可靠来源，因此先规划、后写入、最后才清理。
 */

import type { PiResourceConfigService } from "./PiResourceConfigService";
import type { PiResourceKind } from "../../shared/types/piResources";
import type { PiResourceStateStore } from "./PiResourceStateStore";

/** 旧设置里的禁用扩展条目（scope + source 身份）。 */
export type LegacyDisabledExtension = { scope: "user" | "project" | "unknown"; source: string };

/** 待迁移的旧状态（调用方从 app settings / 项目 settings 读出）。 */
export type LegacyDisabledState = {
	global: {
		disabledExtensions: readonly LegacyDisabledExtension[];
		disabledSkills: readonly string[];
		disabledPrompts: readonly string[];
		/** true = 当时白名单整体关闭（禁用列表不生效）：不能凭空造出新禁用。 */
		disableExtensionWhitelist: boolean;
	};
	project: {
		/** 项目自己的扩展禁用 source（私有记录）。 */
		disabledExtensions: readonly string[];
		disabledSkills: readonly string[];
		disabledPrompts: readonly string[];
		/** 项目里禁用的全局资源（继承覆盖）。 */
		inheritedExtensions: readonly string[];
		inheritedSkills: readonly string[];
		inheritedPrompts: readonly string[];
	};
};

/** 已解析的资源（来自各 Manager 的列表；path 是其原生匹配值）。 */
export type ResolvedMigrationResource = {
	kind: Exclude<PiResourceKind, "themes">;
	name: string;
	/** 原生过滤匹配值：文件/目录路径，或扩展的 source。 */
	value: string;
	scope: "user" | "project";
	/** 资源属于某个包（包内单项开关语义不同，见计划 4.3）。 */
	packageSource?: string;
};

export type MigrationWriteAction = {
	scope: { scope: "global" } | { scope: "project"; projectId: string };
	kind: Exclude<PiResourceKind, "themes">;
	value: string;
	/**
	 * 本动作应写成「整包停用」时给出包的 source（`npm:xxx`）：写进 `packages` 条目，
	 * 而不是顶层 `extensions` 的路径规则——后者是 2026-10 事故的成因：包目录规则对 pi
	 * 惰性（pi 的精确匹配只认资源文件路径），却让开关投影把包内扩展误判成停用。
	 */
	packageSource?: string;
	reason: string;
};

export type MigrationUnresolved = {
	kind: "extension" | "skill" | "prompt";
	name: string;
	scope: "global" | "project";
	reason: string;
};

export type MigrationPlan = {
	/** 需要写入原生配置的停用动作（去重后）。 */
	actions: MigrationWriteAction[];
	/** 无法映射到具体资源的旧记录：保留给用户处理，不静默丢弃也不扩大范围。 */
	unresolved: MigrationUnresolved[];
	/** 归档说明：旧机制下本就不生效的记录，不自动变成新禁用。 */
	archived: string[];
};

function normalizeName(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * 生成迁移计划（纯函数）。
 *
 * 映射规则：
 * - 扩展：按 source 与已安装/已发现扩展匹配；命中包安装时映射成「该项目/全局的包停用」
 *   （附带 skills/prompts 一起停用，计划 5.2 第 9 条），不命中的条目列入 unresolved。
 * - 技能/提示词：按名称匹配已解析资源；同名多来源时**逐项迁移**（计划 5.2 第 2 条），
 *   至少写入所有匹配到的同作用域资源，避免只关一个同名副本。
 * - `disableExtensionWhitelist: true`（白名单整体关闭）时的扩展禁用列表本就不生效：
 *   归档、不迁移（计划 5.2 第 8 条）。
 * - `scope: "unknown"` 的扩展禁用条目无法确定作用域：列入 unresolved，不扩大到全部项目。
 */
export function planResourceMigration(options: {
	legacy: LegacyDisabledState;
	resources: readonly ResolvedMigrationResource[];
	/** 项目迁移需要 projectId 才能写项目层。 */
	projectId?: string;
}): MigrationPlan {
	const { legacy, resources } = options;
	const actions: MigrationWriteAction[] = [];
	const unresolved: MigrationUnresolved[] = [];
	const archived: string[] = [];
	const seen = new Set<string>();

	const pushAction = (action: MigrationWriteAction) => {
		const key = `${action.scope.scope}:${action.scope.scope === "project" ? action.scope.projectId : ""}:${action.kind}:${normalizeName(action.value)}`;
		if (seen.has(key)) return;
		seen.add(key);
		actions.push(action);
	};

	// ── 全局扩展禁用 ──
	if (legacy.global.disableExtensionWhitelist) {
		if (legacy.global.disabledExtensions.length > 0) {
			archived.push(`disableExtensionWhitelist=true：${legacy.global.disabledExtensions.length} 条扩展禁用记录当时未生效，已归档为待处理。`);
		}
	} else {
		for (const entry of legacy.global.disabledExtensions) {
			const source = entry.source.trim();
			if (!source) continue;
			if (entry.scope === "project") {
				// 项目级扩展禁用：项目不迁移全局配置；交给项目侧处理。
				continue;
			}
			if (entry.scope === "unknown") {
				unresolved.push({ kind: "extension", name: source, scope: "global", reason: "记录没有作用域，无法确定要禁用的是哪一份安装。" });
				continue;
			}
			const matched = resources.filter((resource) => resource.kind === "extensions" && resource.scope === "user" && (resource.value === source || resource.name === source));
			if (matched.length === 0) {
				unresolved.push({ kind: "extension", name: source, scope: "global", reason: "找不到对应扩展（可能已卸载或在其它环境安装）。" });
				continue;
			}
			// 命中包安装的扩展：按包整体停用（附带技能/提示词一起停用，计划 5.2 第 9 条），
			// 只关扩展文件会让包内技能/提示词继续加载，与用户「禁用了这个包」的预期不符。
			const packageSources = [...new Set(matched.map((resource) => resource.packageSource).filter((item): item is string => Boolean(item)))];
			for (const packageSource of packageSources) {
				if (!packageSource.trim()) continue;
				actions.push({ scope: { scope: "global" }, kind: "extensions", value: packageSource, packageSource, reason: `旧禁用记录指向包安装（${packageSource}），整包停用` });
			}
			for (const resource of matched) {
				if (resource.packageSource) continue;
				pushAction({ scope: { scope: "global" }, kind: "extensions", value: resource.value, reason: `沿用旧禁用记录（${source}）` });
			}
		}
	}

	// ── 全局技能/提示词禁用 ──
	for (const [kind, names] of [
		["skills", legacy.global.disabledSkills],
		["prompts", legacy.global.disabledPrompts],
	] as const) {
		for (const rawName of names) {
			const name = normalizeName(rawName);
			if (!name) continue;
			const matched = resources.filter((resource) => resource.kind === kind && resource.scope === "user" && normalizeName(resource.name) === name);
			if (matched.length === 0) {
				unresolved.push({ kind: kind === "skills" ? "skill" : "prompt", name: rawName, scope: "global", reason: "找不到同名资源（可能已删除或从未安装）。" });
				continue;
			}
			for (const resource of matched) {
				pushAction({ scope: { scope: "global" }, kind, value: resource.value, reason: `沿用旧禁用记录（${rawName}）` });
			}
		}
	}

	// ── 项目侧 ──
	const projectId = options.projectId;
	const projectScope = projectId ? ({ scope: "project", projectId } as const) : undefined;
	const pushProject = (kind: Exclude<PiResourceKind, "themes">, value: string, reason: string) => {
		if (!projectScope) {
			unresolved.push({ kind: kind === "extensions" ? "extension" : kind === "skills" ? "skill" : "prompt", name: value, scope: "project", reason: "缺少项目上下文，无法写入项目配置。" });
			return;
		}
		pushAction({ scope: projectScope, kind, value, reason });
	};

	for (const source of legacy.project.disabledExtensions) {
		const trimmed = source.trim();
		if (!trimmed) continue;
		const matched = resources.filter((resource) => resource.kind === "extensions" && resource.scope === "project" && (resource.value === trimmed || resource.name === trimmed));
		if (matched.length === 0) {
			unresolved.push({ kind: "extension", name: trimmed, scope: "project", reason: "找不到项目内对应的扩展。" });
			continue;
		}
		for (const resource of matched) pushProject("extensions", resource.value, `沿用旧项目禁用记录（${trimmed}）`);
	}
	for (const [kind, names] of [
		["skills", legacy.project.disabledSkills],
		["prompts", legacy.project.disabledPrompts],
	] as const) {
		for (const rawName of names) {
			const name = normalizeName(rawName);
			if (!name) continue;
			const matched = resources.filter((resource) => resource.kind === kind && resource.scope === "project" && normalizeName(resource.name) === name);
			if (matched.length === 0) {
				unresolved.push({ kind: kind === "skills" ? "skill" : "prompt", name: rawName, scope: "project", reason: "找不到项目内同名资源。" });
				continue;
			}
			for (const resource of matched) pushProject(kind, resource.value, `沿用旧项目禁用记录（${rawName}）`);
		}
	}

	// 项目里禁用的「全局资源」：在项目层写精确规则（原生匹配值就是全局资源的路径）。
	for (const [kind, values] of [
		["extensions", legacy.project.inheritedExtensions],
		["skills", legacy.project.inheritedSkills],
		["prompts", legacy.project.inheritedPrompts],
	] as const) {
		for (const rawValue of values) {
			const value = rawValue.trim();
			if (!value) continue;
			pushProject(kind, value, `沿用旧项目继承禁用记录（${value}）`);
		}
	}

	return { actions, unresolved, archived };
}

export type MigrationApplyReport = {
	ok: boolean;
	applied: number;
	failed: Array<{ action: MigrationWriteAction; error: string }>;
	unresolved: MigrationUnresolved[];
	archived: string[];
	/** 完成后写回的 revision（诊断用）。 */
	revisions: Record<string, string>;
};

/**
 * 执行迁移计划：逐条写原生配置，任一条失败都保持旧记录不动（调用方据此提示）。
 * 全部成功才由调用方清理旧记录（见 markMigrationComplete）。
 */
export async function applyResourceMigration(options: {
	plan: MigrationPlan;
	service: Pick<PiResourceConfigService, "setFileResourceEnabled" | "setPackageEnabled">;
	state: PiResourceStateStore;
	/** 迁移记录 key（作用域标识）。 */
	migrationKey: string;
}): Promise<MigrationApplyReport> {
	const { plan, service, state, migrationKey } = options;
	const failed: MigrationApplyReport["failed"] = [];
	const revisions: Record<string, string> = {};
	let applied = 0;
	// 动作按作用域分组后按顺序写入；同一文件内的多个 action 由服务的锁内重读保证不互相覆盖。
	for (const action of plan.actions) {
		// 整包停用写 packages 条目（带 packageSource 的动作），其余写顶层精确规则。
		const result = action.packageSource ? await service.setPackageEnabled({ scope: action.scope, resourceId: action.packageSource, enabled: false }) : await service.setFileResourceEnabled({ scope: action.scope, kind: action.kind, resourceId: action.value, enabled: false });
		if (!result.ok) {
			failed.push({ action, error: result.error ?? "unknown error" });
			continue;
		}
		applied += 1;
		if (result.revision) revisions[`${action.scope.scope}:${action.scope.scope === "project" ? action.scope.projectId : "global"}`] = result.revision;
	}
	const ok = failed.length === 0;
	if (ok) {
		state.recordMigration(migrationKey, {
			completedAt: Date.now(),
			revisions,
			unresolved: plan.unresolved.map((item) => `${item.kind} ${item.name} (${item.scope}): ${item.reason}`),
		});
	}
	return { ok, applied, failed, unresolved: plan.unresolved, archived: plan.archived, revisions };
}

// ── 旧记录清理 ──────────────────────────────────────────────

/** 迁移成功后要清空的 PiDeck 应用设置字段（只清理成功迁移过的类别）。 */
export type LegacyStatePatch = {
	disabledExtensions?: LegacyDisabledExtension[];
	disabledSkills?: string[];
	disabledPrompts?: string[];
	disableExtensionWhitelist?: boolean;
};

/**
 * 计算清理后的应用设置补丁。
 *
 * 安全约束：
 * - 有 unresolved/failed 时不清理对应类别（保留旧记录供重试）；
 * - 扩展归档（白名单总开关）时保留 disableExtensionWhitelist 与列表，等待用户明确处理；
 * - 只返回需要改写的字段，调用方与 settingsStore 合并（不整份覆盖）。
 */
export function buildLegacyStateCleanup(options: { legacy: LegacyDisabledState; report: MigrationApplyReport }): LegacyStatePatch {
	const { legacy, report } = options;
	const patch: LegacyStatePatch = {};
	const failedExtension = report.failed.some((item) => item.action.kind === "extensions");
	const failedSkill = report.failed.some((item) => item.action.kind === "skills");
	const failedPrompt = report.failed.some((item) => item.action.kind === "prompts");
	const unresolvedExtension = report.unresolved.some((item) => item.kind === "extension");
	const unresolvedSkill = report.unresolved.some((item) => item.kind === "skill");
	const unresolvedPrompt = report.unresolved.some((item) => item.kind === "prompt");

	if (!failedExtension && !unresolvedExtension && !legacy.global.disableExtensionWhitelist) patch.disabledExtensions = [];
	if (!failedSkill && !unresolvedSkill) patch.disabledSkills = [];
	if (!failedPrompt && !unresolvedPrompt) patch.disabledPrompts = [];
	return patch;
}
