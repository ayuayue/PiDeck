/**
 * 智能体配置的纯归一化层（无 IO、无状态）：读盘前向兼容、IPC/存储入参收敛、
 * 设置/默认智能体/会话绑定的悬空清理都收在这里，AgentProfileStore 只负责串行写与快照。
 *
 * 两条归一化语义刻意分开：
 * - 读盘（normalizePersistedState）：坏值尽量修复（钳长度、补默认、丢坏模型、去重 id），绝不抛错；
 * - 入参（normalizeCreateInput / applyAgentProfilePatch）：必填项缺失才抛错（IPC 边界已先拒绝）。
 */

import {
	AGENT_PROFILE_BACKENDS,
	AGENT_PROFILE_CATEGORIES,
	AGENT_PROFILE_DESCRIPTION_MAX_CHARS,
	AGENT_PROFILE_ICON_MAX_CHARS,
	AGENT_PROFILE_NAME_MAX_CHARS,
	AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS,
	type AgentMarketSettings,
	type AgentModelRef,
	type AgentProfile,
	type AgentProfileBackend,
	type AgentProfileCategory,
	type CreateAgentProfileInput,
	type UpdateAgentMarketSettingsInput,
} from "../../shared/types";
import { BUILTIN_AGENT_SEEDS, createBuiltinAgentProfile } from "./builtinAgents";

export const SCHEMA_VERSION = 1;

/**
 * 市场设置缺省值：应用内划词与系统级划词默认开启（核心入口；系统级受快捷键冲突影响时用户可关），
 * 默认智能体留空 = 渲染层回退内置翻译官，会话绑定为空（「使用」智能体时才写入）。
 */
export const DEFAULT_AGENT_MARKET_SETTINGS: AgentMarketSettings = { selectionToolEnabled: true, systemSelectionEnabled: false, selectionToolAgentId: null, sessionAgentBindings: {} };

/** 会话绑定上限：设置文件与 IPC 快照都随绑定数增长，超出后拒绝新绑定（解绑不受限），避免无界膨胀。 */
export const MAX_SESSION_AGENT_BINDINGS = 2_000;

/** 绑定两端（会话 id / 智能体 id）的形态上限：IPC 边界与读盘归一化共用，超出/含控制字符一律按坏数据丢弃。 */
export const MAX_SESSION_AGENT_BINDING_ID_CHARS = 200;

/** 模型/供应商标识的形态上限：真实目录键可能是中文、冒号或 URL，只卡长度与控制字符，不复制 pi 命名文法。 */
export const AGENT_MODEL_FIELD_MAX_CHARS = 200;

const MAX_AGENT_ID_CHARS = 200;
const MODEL_FIELD_CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/u;

/**
 * 原型键黑名单：sessionAgentBindings 的键来自可手改的 JSON，直接赋给普通对象会把
 * "__proto__" 送到原型 setter 上（污染该对象自身原型，后续读取全部错乱），
 * 因此读盘与 bindSession 入口共用同一份拒绝规则。
 */
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 落盘结构；version 用于未来迁移，revision 与市场快照的 revision 同源。 */
export type PersistedAgentProfileState = {
	version: number;
	revision: number;
	settings: AgentMarketSettings;
	agents: AgentProfile[];
	/**
	 * 用户拖拽出的展示顺序（只存 id）。空数组 = 未自定义 = 按默认规则排序。
	 * 与 agents 分开存：agents 的数组顺序属于存储细节（新建推尾部），展示顺序是用户偏好，
	 * 两者混在一起会让「导入/补种/迁移」意外改掉用户排好的顺序。
	 */
	agentOrder: string[];
};

/**
 * 主进程侧更新入参：比渲染层契约多 model / backend 的显式清除语义。
 * null（以及成对的空串 {@provider:"",modelId:""}）表示清空首选模型 = 跟随会话；
 * backend 的 null（或渲染层传入的 own key + undefined）表示清除 = 跟随默认后端；键缺失才表示保留原值。
 */
export type AgentProfilePatch = Omit<Partial<CreateAgentProfileInput>, "model" | "backend"> & { model?: AgentModelRef | null; backend?: AgentProfileBackend | null };

/** 新建时由归一化层决定的内容字段（id / 时间戳 / 使用统计由存储层补）。 */
export type NormalizedAgentProfileContent = {
	name: string;
	description: string;
	icon: string;
	systemPrompt: string;
	category: AgentProfileCategory;
	model?: AgentModelRef;
	backend?: AgentProfileBackend;
};

export function createEmptyState(): PersistedAgentProfileState {
	// sessionAgentBindings 是对象：必须每次新建，否则多个空状态会共享同一份绑定表。
	return { version: SCHEMA_VERSION, revision: 0, settings: createDefaultSettings(), agents: [], agentOrder: [] };
}

function createDefaultSettings(): AgentMarketSettings {
	return { ...DEFAULT_AGENT_MARKET_SETTINGS, sessionAgentBindings: {} };
}

/**
 * 读盘归一化。
 * changed 用「规范化结果的键序无关序列化」对比原文件判断：字段被钳长度、补默认、丢弃坏值
 * 或去掉未知键都算变化，需要写回磁盘；否则每次启动都会把同一份脏数据重复修一遍。
 */
export function normalizePersistedState(value: unknown, now: number): { state: PersistedAgentProfileState; changed: boolean } {
	const record = isRecord(value) ? value : {};
	const rawAgents = Array.isArray(record.agents) ? record.agents : [];
	const seen = new Set<string>();
	const agents: AgentProfile[] = [];
	for (const entry of rawAgents) {
		const agent = normalizePersistedAgent(entry, now);
		// 重复 id 只保留第一条：按 id 查找/更新的语义要求 id 唯一，手工改坏的文件最容易撞这里。
		if (!agent || seen.has(agent.id)) continue;
		seen.add(agent.id);
		agents.push(agent);
	}
	const state: PersistedAgentProfileState = {
		version: SCHEMA_VERSION,
		revision: finiteInteger(record.revision, 0),
		// 设置里的默认智能体是否悬空要等种子补齐后由 resolveSelectionAgent 判定，这里只收敛形状。
		settings: normalizeSettingsShape(record.settings),
		agents,
		agentOrder: normalizeAgentOrder(record.agentOrder, seen),
	};
	return { state, changed: canonicalJson(value) !== canonicalJson(state) };
}

/**
 * 自定义展示顺序归一化：只留字符串、去重、剔除已不存在的 id（删除智能体后旧顺序会残留）。
 * 顺序只是展示偏好，坏值不能让智能体本身失效，所以丢弃而不是抛错；返回空数组表示未自定义。
 */
export function normalizeAgentOrder(value: unknown, knownIds: ReadonlySet<string>): string[] {
	if (!Array.isArray(value)) return [];
	const order: string[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const id = clampText(entry.trim(), MAX_AGENT_ID_CHARS);
		if (!id || !knownIds.has(id) || seen.has(id)) continue;
		seen.add(id);
		order.push(id);
	}
	return order;
}

function normalizePersistedAgent(value: unknown, now: number): AgentProfile | undefined {
	// id 是唯一身份：缺失/非字符串的条目无法被查找、编辑或调用，只能丢弃。
	if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return undefined;
	const id = clampText(value.id.trim(), MAX_AGENT_ID_CHARS);
	const createdAt = finiteInteger(value.createdAt, now);
	const updatedAt = Math.max(createdAt, finiteInteger(value.updatedAt, createdAt));
	const model = normalizeModelRef(value.model);
	// 后端白名单之外的持久化值（旧版本/手改文件/acp）一律丢弃 = 跟随默认后端，
	// 不抛错也不保留：AgentProfileBackend 是「新建会话」的语义，坏值会让「使用」建出错误后端。
	const backend = isAgentProfileBackend(value.backend) ? value.backend : undefined;
	// 名字缺失时用 id 兜底：比「未命名」可定位，也不会把主进程文案写进用户数据。
	const name = clampText(trimmedText(value.name), AGENT_PROFILE_NAME_MAX_CHARS) || id;
	return {
		id,
		name,
		description: clampText(trimmedText(value.description), AGENT_PROFILE_DESCRIPTION_MAX_CHARS),
		icon: clampText(trimmedText(value.icon), AGENT_PROFILE_ICON_MAX_CHARS),
		systemPrompt: clampText(trimmedText(value.systemPrompt), AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS),
		...(model ? { model } : {}),
		...(backend ? { backend } : {}),
		category: isAgentProfileCategory(value.category) ? value.category : "general",
		...(value.builtin === true ? { builtin: true } : {}),
		createdAt,
		updatedAt,
		usageCount: finiteInteger(value.usageCount, 0),
		...(finiteOptional(value.lastUsedAt) === undefined ? {} : { lastUsedAt: finiteOptional(value.lastUsedAt) }),
	};
}

/** 只按 id 补种缺失的内置智能体：用户改过内置内容就保留现状（升级应用不覆盖用户的编辑）。 */
export function seedMissingBuiltins(agents: readonly AgentProfile[]): AgentProfile[] {
	const existing = new Set(agents.map((agent) => agent.id));
	const missing = BUILTIN_AGENT_SEEDS.filter((seed) => !existing.has(seed.id)).map((seed) => createBuiltinAgentProfile(seed));
	return missing.length > 0 ? [...missing, ...agents] : [...agents];
}

/** 默认智能体必须仍然存在：指向已删除 id 时回退「未设置」（渲染层再回退内置翻译官）。 */
export function resolveSelectionAgent(settings: AgentMarketSettings, agents: readonly AgentProfile[]): AgentMarketSettings {
	const selected = settings.selectionToolAgentId;
	if (selected === null) return settings;
	return agents.some((agent) => agent.id === selected) ? settings : { ...settings, selectionToolAgentId: null };
}

/**
 * 会话绑定必须指向仍存在的智能体：与默认智能体的悬空清理同一语义。
 * 删除智能体时 store 会在同一次写入里剪掉绑定；这里兜住「手工改文件 / 旧版本残留 / 种子补种前」
 * 这类没有经过 delete 路径的悬空绑定，避免绑定的会话发送时拿到 undefined 而静默失效。
 */
export function resolveSessionBindings(settings: AgentMarketSettings, agents: readonly AgentProfile[]): AgentMarketSettings {
	const known = new Set(agents.map((agent) => agent.id));
	const entries = Object.entries(settings.sessionAgentBindings);
	const kept = entries.filter(([, agentId]) => known.has(agentId));
	if (kept.length === entries.length) return settings;
	return { ...settings, sessionAgentBindings: Object.fromEntries(kept) };
}

export function normalizeSettings(value: unknown, agents: readonly AgentProfile[]): AgentMarketSettings {
	return resolveSessionBindings(resolveSelectionAgent(normalizeSettingsShape(value), agents), agents);
}

function normalizeSettingsShape(value: unknown): AgentMarketSettings {
	const record = isRecord(value) ? value : {};
	const enabled = typeof record.selectionToolEnabled === "boolean" ? record.selectionToolEnabled : DEFAULT_AGENT_MARKET_SETTINGS.selectionToolEnabled;
	// 系统级划词是新字段：旧文件没有它 → 取默认开（功能默认打开，用户可关）。
	const systemEnabled = typeof record.systemSelectionEnabled === "boolean" ? record.systemSelectionEnabled : DEFAULT_AGENT_MARKET_SETTINGS.systemSelectionEnabled;
	const selected = typeof record.selectionToolAgentId === "string" ? clampText(record.selectionToolAgentId.trim(), MAX_AGENT_ID_CHARS) : "";
	return { selectionToolEnabled: enabled, systemSelectionEnabled: systemEnabled, selectionToolAgentId: selected || null, sessionAgentBindings: normalizeSessionAgentBindings(record.sessionAgentBindings) };
}

/**
 * 绑定表归一化：键值都必须是非空、不超上限、无控制字符的字符串，坏条目直接丢弃
 * （绑定是附加能力，坏数据不该让整个市场不可用），条目数封顶 MAX_SESSION_AGENT_BINDINGS。
 * 是否指向存在的智能体由 resolveSessionBindings 在种子补齐后判定。
 */
function normalizeSessionAgentBindings(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const bindings: Record<string, string> = {};
	let count = 0;
	for (const [rawSessionId, rawAgentId] of Object.entries(value)) {
		if (count >= MAX_SESSION_AGENT_BINDINGS) break;
		const sessionId = normalizeBindingId(rawSessionId);
		const agentId = normalizeBindingId(rawAgentId);
		if (!sessionId || !agentId) continue;
		bindings[sessionId] = agentId;
		count += 1;
	}
	return bindings;
}

/**
 * 设置 patch 的存储侧收敛：会话绑定只能经 bindSession 改，
 * 其他路径（旧快照 / 直调 store / IPC 未知键）带进来的 sessionAgentBindings 一律忽略，
 * 避免一次设置保存把全部绑定覆盖掉。
 */
export function sanitizeSettingsPatch(patch: UpdateAgentMarketSettingsInput): UpdateAgentMarketSettingsInput {
	const sanitized: UpdateAgentMarketSettingsInput = {};
	if (patch.selectionToolEnabled !== undefined) sanitized.selectionToolEnabled = patch.selectionToolEnabled;
	if (patch.systemSelectionEnabled !== undefined) sanitized.systemSelectionEnabled = patch.systemSelectionEnabled;
	if (patch.selectionToolAgentId !== undefined) sanitized.selectionToolAgentId = patch.selectionToolAgentId;
	return sanitized;
}

export function normalizeCreateInput(input: CreateAgentProfileInput): NormalizedAgentProfileContent {
	const model = normalizeModelRef(input.model);
	return {
		name: normalizeRequiredText(input.name, "Agent name", AGENT_PROFILE_NAME_MAX_CHARS),
		description: normalizeOptionalText(input.description, AGENT_PROFILE_DESCRIPTION_MAX_CHARS),
		icon: normalizeOptionalText(input.icon, AGENT_PROFILE_ICON_MAX_CHARS),
		systemPrompt: normalizeRequiredText(input.systemPrompt, "Agent system prompt", AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS),
		category: isAgentProfileCategory(input.category) ? input.category : "general",
		...(model ? { model } : {}),
		// 未知后端静默丢弃 = 跟随默认后端：IPC 边界已先拒绝非法枚举。
		...(isAgentProfileBackend(input.backend) ? { backend: input.backend } : {}),
	};
}

/** 更新补丁叠加：缺键保留原值；model 用 hasOwn 判定（null / 空串对 = 清空首选模型）。 */
export function applyAgentProfilePatch(current: AgentProfile, patch: AgentProfilePatch, now: number): AgentProfile {
	const next: AgentProfile = {
		...current,
		name: patch.name === undefined ? current.name : normalizeRequiredText(patch.name, "Agent name", AGENT_PROFILE_NAME_MAX_CHARS),
		description: patch.description === undefined ? current.description : normalizeOptionalText(patch.description, AGENT_PROFILE_DESCRIPTION_MAX_CHARS),
		icon: patch.icon === undefined ? current.icon : normalizeOptionalText(patch.icon, AGENT_PROFILE_ICON_MAX_CHARS),
		systemPrompt: patch.systemPrompt === undefined ? current.systemPrompt : normalizeRequiredText(patch.systemPrompt, "Agent system prompt", AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS),
		category: patch.category === undefined ? current.category : isAgentProfileCategory(patch.category) ? patch.category : "general",
		updatedAt: now,
	};
	if (Object.hasOwn(patch, "model")) {
		const model = normalizeModelRef(patch.model);
		if (model) next.model = model;
		else delete next.model;
	}
	// 后端与模型同一套「键存在才改」语义：显式 null = 清除（跟随默认后端），缺键 = 保留原值。
	if (Object.hasOwn(patch, "backend")) {
		const backend = patch.backend;
		if (isAgentProfileBackend(backend)) next.backend = backend;
		else delete next.backend;
	}
	return next;
}

/**
 * 副本命名：`名称 (2)`、`名称 (3)`……取第一个未被占用的序号。
 * 序号属于数据而非 UI 文案（任何语言下都可读，不需要 i18n 词典），既让副本可区分，
 * 又不会覆盖用户已有的同名智能体；连续复制时先剥掉旧序号再递增，避免 (2)(2)。
 */
export function uniqueCopyName(baseName: string, agents: readonly AgentProfile[]): string {
	const base = baseName.replace(/\s*\(\d+\)$/, "").trim() || baseName;
	const taken = new Set(agents.map((agent) => agent.name));
	for (let index = 2; index <= 9_999; index += 1) {
		const candidate = clampText(`${base} (${index})`, AGENT_PROFILE_NAME_MAX_CHARS);
		if (!taken.has(candidate)) return candidate;
	}
	return clampText(`${base} (${agents.length + 1})`, AGENT_PROFILE_NAME_MAX_CHARS);
}

/**
 * 模型引用归一化：半截引用（只填 provider 或只填 modelId）与非法字符一律丢弃，
 * 等价于「跟随会话模型」——绝不落盘一个查不到的 provider/modelId 组合。
 */
export function normalizeModelRef(value: unknown): AgentModelRef | undefined {
	if (!isRecord(value)) return undefined;
	if (!isAgentModelFieldValid(value.provider) || !isAgentModelFieldValid(value.modelId)) return undefined;
	return { provider: value.provider, modelId: value.modelId };
}

/** 模型/供应商标识的边界与读盘共用规则：trim 后非空、不超长、无控制字符。 */
export function isAgentModelFieldValid(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= AGENT_MODEL_FIELD_MAX_CHARS && !MODEL_FIELD_CONTROL_CHARACTERS.test(value);
}

/** 分类白名单判定：筛选器与编辑器下拉只认这五个值，未知值会让智能体在 UI 里「消失」。 */
export function isAgentProfileCategory(value: unknown): value is AgentProfileCategory {
	return AGENT_PROFILE_CATEGORIES.some((category) => category === value);
}

/** 智能体后端白名单：只接受 pi / dsh，其余（acp/imagegen/脏数据）视为「未设置 = 跟随默认后端」。 */
export function isAgentProfileBackend(value: unknown): value is AgentProfileBackend {
	return AGENT_PROFILE_BACKENDS.some((backend) => backend === value);
}

/**
 * 会话绑定键/值的形态校验：trim 后非空、不超上限、无控制字符、非原型键。
 * IPC 边界（抛错拒绝）与读盘归一化（丢弃坏条目）共用同一份规则，避免两处上限漂移。
 */
export function normalizeBindingId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_SESSION_AGENT_BINDING_ID_CHARS) return undefined;
	if (MODEL_FIELD_CONTROL_CHARACTERS.test(trimmed)) return undefined;
	if (PROTOTYPE_KEYS.has(trimmed)) return undefined;
	return trimmed;
}

function normalizeRequiredText(value: unknown, label: string, maxLength: number): string {
	const text = trimmedText(value);
	// 必填字段空值抛错：IPC 边界已先拒绝，这里兜住直接调用 store 的内部路径。
	if (!text) throw new Error(`${label} is required`);
	return clampText(text, maxLength);
}

function normalizeOptionalText(value: unknown, maxLength: number): string {
	return clampText(trimmedText(value), maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedText(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function clampText(value: string, maxLength: number): string {
	return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function finiteInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function finiteOptional(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 键序无关的序列化：判断「用户文件与归一化结果是否一致」时，
 * 直接 JSON.stringify 会把键顺序差异误判成变化（每次启动白写一次盘）。
 */
function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => canonicalize(item));
	if (isRecord(value)) {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
		return sorted;
	}
	return value;
}
