/**
 * ACP 工具登记表的校验与消毒(纯函数)。
 *
 * 设置(IPC 入参不可信)与渲染层表单共用同一份规则,单测见
 * tests/acpToolConfig.test.mjs。非法**条目**丢弃而不是拒绝整表:
 * 用户增删一条工具时,另一条脏数据不应阻断保存。
 */
import type { AcpToolConfig, AcpToolValidation } from "../../shared/types/acp";
import type { AcpConfigOption } from "./acpProtocol";

/** 单字段长度上限(显示名/命令足够,防滥用)。 */
const NAME_MAX_CHARS = 80;
const COMMAND_MAX_CHARS = 300;
const ARGS_LIMIT = 32;
const TOOLS_LIMIT = 32;
const ENV_LIMIT = 16;
const ENV_VALUE_MAX_CHARS = 2000;

function cleanString(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxChars) return undefined;
	// 控制字符一律拒绝(路径/参数里不该出现;也防终端转义注入展示文案)。
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
	return trimmed;
}

/** env 注入消毒:键必须是合法环境变量名,值限非控制字符文本(API key 等);失败条目丢弃。 */
function sanitizeEnv(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const env: Record<string, string> = {};
	let count = 0;
	for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
		if (count >= ENV_LIMIT) break;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawKey)) continue;
		if (typeof rawVal !== "string" || !rawVal || rawVal.length > ENV_VALUE_MAX_CHARS) continue;
		if (/[\u0000-\u001f\u007f]/.test(rawVal)) continue;
		env[rawKey] = rawVal;
		count += 1;
	}
	return count > 0 ? env : undefined;
}

/**
 * 新建/编辑单条工具的表单校验:返回 ok=false 时 reasonKey 供渲染层本地化。
 * duplicateAgainst 用于查重(编辑时排除自身 id)。
 */
export function validateAcpTool(input: { id?: string; name?: unknown; command?: unknown; args?: unknown; env?: unknown; bypassPermissions?: unknown }, existing: AcpToolConfig[] = []): AcpToolValidation & { tool?: AcpToolConfig } {
	const name = cleanString(input.name, NAME_MAX_CHARS);
	const command = cleanString(input.command, COMMAND_MAX_CHARS);
	const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === "string" && arg.trim().length > 0).slice(0, ARGS_LIMIT) : [];
	const env = sanitizeEnv(input.env);
	if (!name) return { ok: false, reasonKey: "acp.toolNameRequired" };
	if (!command) return { ok: false, reasonKey: "acp.toolCommandRequired" };
	// 显示名重复会让会话列表/选择器难区分;命令本身允许重复(同一 CLI 不同参数)。
	if (existing.some((tool) => tool.name === name && tool.id !== input.id)) return { ok: false, reasonKey: "acp.toolDuplicateName" };
	return {
		ok: true,
		tool: {
			id: typeof input.id === "string" && input.id.trim() ? input.id : createAcpToolId(),
			name,
			command,
			args,
			...(env ? { env } : {}),
			// 只认显式 true：历史设置里没有该字段 = 不启用（默认不开旁路权限）
			...(input.bypassPermissions === true ? { bypassPermissions: true } : {}),
			enabled: true,
		},
	};
}

/** 渲染层不应用 crypto/randomUUID 造 id(纯函数可测):时间戳+随机后缀。 */
export function createAcpToolId(): string {
	return `acp-tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** settings.acpToolConfigDefaults 的运行时形态：工具 id → 选项 id → 值。 */
export type AcpToolConfigDefaults = Record<string, Record<string, string | boolean>>;

const DEFAULTS_TOOLS_LIMIT = 32;
const DEFAULTS_OPTIONS_LIMIT = 16;
const DEFAULT_TOOL_ID_MAX_CHARS = 128;
const DEFAULT_OPTION_ID_MAX_CHARS = 80;
const DEFAULT_VALUE_MAX_CHARS = 200;

/**
 * 是否记忆该 configOption：用户口径只记思考档/模式/权限，模型与模型参数不记。
 * category 缺失时用 id 兜底排除 model（少数 agent 不回 category）。
 */
export function isRememberedAcpConfigOption(option: { id: string; category?: string }): boolean {
	const category = option.category?.trim().toLowerCase();
	if (category === "model" || category === "model_config") return false;
	if (!category && option.id.trim().toLowerCase() === "model") return false;
	return true;
}

/** configOption 里承载「会话模式/权限档」的那一项（id 或 category 为 mode）。 */
export function isAcpModeOption(option: { id: string; category?: string }): boolean {
	return option.id.trim().toLowerCase() === "mode" || option.category?.trim().toLowerCase() === "mode";
}

/** 当前枚举里的模式项；boolean 型不是模式枚举（无值可选），跳过。 */
export function findAcpModeOption(options: ReadonlyArray<AcpConfigOption> | undefined): AcpConfigOption | undefined {
	return (options ?? []).find((option) => option.type !== "boolean" && isAcpModeOption(option));
}

/** select 型选项的全部可选值（分组展开）；非 select/无枚举回空数组。 */
export function acpConfigOptionValues(option: Pick<AcpConfigOption, "type" | "options"> | undefined): string[] {
	if (!option || option.type === "boolean") return [];
	const values: string[] = [];
	for (const item of option.options ?? []) {
		if ("group" in item) for (const inner of item.options) values.push(inner.value);
		else values.push(item.value);
	}
	return values;
}

/**
 * agent 自己枚举里代表「跳过审批」的模式档，按强度从高到低取第一个命中：
 * CodeBuddy 2.178.1 的 fullAccess（连危险命令也不拦）语义强于 bypassPermissions
 * （仍会拦危险命令），所以排在第一位；Claude 是 bypassPermissions、Qoder 是 yolo、
 * 其余按 bypass 前缀兜住。运行期下发能否被接受由 agent 决定（Qoder 直接拒绝）。
 */
const ACP_BYPASS_MODE_PRIORITY = ["fullaccess", "bypasspermissions", "bypass_permissions", "bypass", "yolo"];

export function findAcpBypassModeValue(option: Pick<AcpConfigOption, "type" | "options"> | undefined): string | undefined {
	const values = acpConfigOptionValues(option);
	for (const target of ACP_BYPASS_MODE_PRIORITY) {
		const hit = values.find((value) => value.trim().toLowerCase() === target);
		if (hit !== undefined) return hit;
	}
	return undefined;
}

/** 模式值是否属于「跳过审批」档（与 findAcpBypassModeValue 同一张优先级表，大小写不敏感）。 */
export function isAcpBypassModeValue(value: string | boolean): boolean {
	return typeof value === "string" && ACP_BYPASS_MODE_PRIORITY.includes(value.trim().toLowerCase());
}

/** 设置加载/更新边界的整表消毒：脏工具/脏选项/超长值丢弃，不因一条坏数据拒绝整表。 */
export function sanitizeAcpToolConfigDefaults(value: unknown): AcpToolConfigDefaults {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: AcpToolConfigDefaults = {};
	let toolCount = 0;
	for (const [rawToolId, rawOptions] of Object.entries(value as Record<string, unknown>)) {
		if (toolCount >= DEFAULTS_TOOLS_LIMIT) break;
		const toolId = cleanString(rawToolId, DEFAULT_TOOL_ID_MAX_CHARS);
		if (!toolId || !rawOptions || typeof rawOptions !== "object" || Array.isArray(rawOptions)) continue;
		const options: Record<string, string | boolean> = {};
		let optionCount = 0;
		for (const [rawOptionId, rawValue] of Object.entries(rawOptions as Record<string, unknown>)) {
			if (optionCount >= DEFAULTS_OPTIONS_LIMIT) break;
			const optionId = cleanString(rawOptionId, DEFAULT_OPTION_ID_MAX_CHARS);
			if (!optionId) continue;
			if (typeof rawValue === "boolean") {
				options[optionId] = rawValue;
			} else {
				const text = cleanString(rawValue, DEFAULT_VALUE_MAX_CHARS);
				if (!text) continue;
				options[optionId] = text;
			}
			optionCount += 1;
		}
		if (optionCount > 0) {
			result[toolId] = options;
			toolCount += 1;
		}
	}
	return result;
}

/**
 * 计算新建会话要重放的配置：只保留当前 agent 枚举里仍存在、类型匹配且值确实不同的项。
 * 顺序按 defaults 的插入顺序；单条失败由调用方跳过，不阻塞会话创建。
 */
export function planAcpConfigReplay(options: ReadonlyArray<Pick<AcpConfigOption, "id" | "category" | "type" | "currentValue">> | undefined, defaults: Record<string, string | boolean> | undefined): Array<{ id: string; value: string | boolean }> {
	if (!options || !defaults) return [];
	const plan: Array<{ id: string; value: string | boolean }> = [];
	for (const [id, value] of Object.entries(defaults)) {
		const option = options.find((candidate) => candidate.id === id);
		if (!option || !isRememberedAcpConfigOption(option)) continue;
		if (option.type === "boolean" ? typeof value !== "boolean" : typeof value !== "string") continue;
		if (option.currentValue === value) continue;
		plan.push({ id, value });
	}
	return plan;
}

/** 单条记忆写入（不可变）：值非法或与现值相同时返回 undefined，调用方跳过落盘。 */
export function withAcpConfigDefault(defaults: AcpToolConfigDefaults, toolId: string, optionId: string, value: string | boolean): AcpToolConfigDefaults | undefined {
	const cleanToolId = cleanString(toolId, DEFAULT_TOOL_ID_MAX_CHARS);
	const cleanOptionId = cleanString(optionId, DEFAULT_OPTION_ID_MAX_CHARS);
	if (!cleanToolId || !cleanOptionId) return undefined;
	if (typeof value === "string" && !cleanString(value, DEFAULT_VALUE_MAX_CHARS)) return undefined;
	const current = defaults[cleanToolId] ?? {};
	if (current[cleanOptionId] === value) return undefined;
	return { ...defaults, [cleanToolId]: { ...current, [cleanOptionId]: value } };
}

/** 设置加载/更新边界的整表消毒:非法条目丢弃,合法条目字段归一。 */
export function sanitizeAcpTools(value: unknown): AcpToolConfig[] {
	if (!Array.isArray(value)) return [];
	const seenIds = new Set<string>();
	const seenNames = new Set<string>();
	const tools: AcpToolConfig[] = [];
	for (const raw of value.slice(0, TOOLS_LIMIT)) {
		if (!raw || typeof raw !== "object") continue;
		const record = raw as Record<string, unknown>;
		const id = typeof record.id === "string" && record.id.trim() ? record.id : createAcpToolId();
		if (seenIds.has(id)) continue;
		const name = cleanString(record.name, NAME_MAX_CHARS);
		const command = cleanString(record.command, COMMAND_MAX_CHARS);
		if (!name || !command || seenNames.has(name)) continue;
		const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string" && arg.trim().length > 0).slice(0, ARGS_LIMIT) : [];
		const env = sanitizeEnv(record.env);
		seenIds.add(id);
		seenNames.add(name);
		tools.push({ id, name, command, args, ...(env ? { env } : {}), ...(record.bypassPermissions === true ? { bypassPermissions: true } : {}), enabled: record.enabled !== false });
	}
	return tools;
}

/**
 * 工具勾了「bypass 权限」但 agent 的模式枚举里没有 bypass 档时的用户提示（#556）。
 *
 * 这是配置无效的告知，不是错误：会话照常开，只是放行不会发生。载荷走 agents:notice，
 * 渲染层用 i18nKey + i18nParams 翻译；message 是兜底文案（key 缺失或非渲染端消费时可读）。
 */
export type AcpBypassUnavailableNotice = {
	i18nKey: "notice.acpBypassUnavailable";
	i18nParams: { tool: string; modes: string };
	kind: "warning";
	duration: number;
	message: string;
};

export function acpBypassUnavailableNotice(toolName: string, availableModes: readonly string[]): AcpBypassUnavailableNotice {
	const modes = availableModes.join(" / ");
	return {
		i18nKey: "notice.acpBypassUnavailable",
		i18nParams: { tool: toolName, modes },
		kind: "warning",
		duration: 8000,
		message: `"${toolName}" offers no bypass mode (available: ${modes || "none"}); its "bypass permissions" setting has no effect.`,
	};
}

/**
 * 会话配了附加根目录、但工具在 initialize 里没声明 `sessionCapabilities.additionalDirectories`
 * 时的用户提示（#560）：配置不会下发，必须说出来，不能静默丢弃。
 */
export type AcpAdditionalDirectoriesIgnoredNotice = {
	i18nKey: "notice.acpAdditionalDirectoriesIgnored";
	i18nParams: { tool: string; count: number };
	kind: "warning";
	duration: number;
	message: string;
};

export function acpAdditionalDirectoriesIgnoredNotice(toolName: string, count: number): AcpAdditionalDirectoriesIgnoredNotice {
	return {
		i18nKey: "notice.acpAdditionalDirectoriesIgnored",
		i18nParams: { tool: toolName, count },
		kind: "warning",
		duration: 8_000,
		message: `"${toolName}" does not declare additional directories support; ${count} configured director(ies) were not sent.`,
	};
}
