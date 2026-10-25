/**
 * 智能体 IPC：智能体配置 CRUD + 市场设置（业务在 AgentProfileStore，本文件只做边界适配）。
 *
 * 渲染层数据一律不可信：名称/简介/图标/角色设定按共享常量卡长度，分类走白名单，
 * agentId 只校验形态与上限，模型引用只校验形状（目录键可能是中文/URL，不复制 pi 命名文法）。
 * 日志只记 id/分类/布尔量，绝不落角色设定与简介原文（用户内容）。
 */

import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import {
	AGENT_PROFILE_DESCRIPTION_MAX_CHARS,
	AGENT_PROFILE_ICON_MAX_CHARS,
	AGENT_PROFILE_NAME_MAX_CHARS,
	AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS,
	type AgentChangedEvent,
	type AgentMarketSettings,
	type AgentModelRef,
	type AgentProfile,
	type AgentProfileBackend,
	type AgentProfileCategory,
	type AgentProfileSnapshot,
	type BindAgentSessionInput,
	type CreateAgentProfileInput,
	type UpdateAgentMarketSettingsInput,
} from "../../shared/types";
import type { AgentProfileStore } from "../agents/AgentProfileStore";
import { isAgentModelFieldValid, isAgentProfileBackend, isAgentProfileCategory, normalizeBindingId, type AgentProfilePatch } from "../agents/agentProfileNormalize";
import type { AppLogger } from "../logging/AppLogger";

export type AgentProfileIpcDeps = {
	store: AgentProfileStore;
	appLogger: AppLogger;
	onNotifyChanged: (event: AgentChangedEvent) => void;
};

const LOG_SCOPE = "agent-profiles";

/** id 上限：uuid 与内置 id 都远小于它，超长只可能是脏数据（也挡住把超长串塞进日志）。 */
const MAX_AGENT_ID_CHARS = 200;
/** 排序载荷上限：仅作为防御性护栏（真实智能体数量远小于它）。 */
const MAX_AGENT_ORDER_ENTRIES = 5_000;

/**
 * 注册智能体 IPC。
 * 返回清理函数：卸载时退订 store 变更并摘掉全部 handler（与 automationIpc 同一生命周期约定）。
 */
export function registerAgentProfileIpc(deps: AgentProfileIpcDeps): () => void {
	const { store, appLogger, onNotifyChanged } = deps;

	// 变更事件在主进程订阅一次再转发给渲染层：多窗口共用同一份内存状态，各自拉快照。
	const unsubscribeChanged = store.onChanged((event) => {
		onNotifyChanged(event);
	});

	ipcMain.handle(ipcChannels.agentProfilesGetSnapshot, async (): Promise<AgentProfileSnapshot> => {
		return store.getSnapshot();
	});

	ipcMain.handle(ipcChannels.agentProfilesCreate, async (_event, input: unknown): Promise<AgentProfile> => {
		const parsed = parseCreateInput(input);
		return runWithLog(appLogger, "create agent profile", { category: parsed.category ?? "general" }, async () => {
			const agent = await store.create(parsed);
			void appLogger.info(LOG_SCOPE, "Created agent profile", { agentId: agent.id, category: agent.category });
			return agent;
		});
	});

	ipcMain.handle(ipcChannels.agentProfilesUpdate, async (_event, agentId: unknown, patch: unknown): Promise<AgentProfile> => {
		const id = parseAgentId(agentId);
		const parsed = parseUpdatePatch(patch);
		return runWithLog(appLogger, "update agent profile", { agentId: id }, async () => {
			// 未知 id 由 store 抛 "Agent not found: <id>"，IPC 不重复实现查找语义。
			const agent = await store.update(id, parsed);
			void appLogger.info(LOG_SCOPE, "Updated agent profile", { agentId: id, category: agent.category });
			return agent;
		});
	});

	ipcMain.handle(ipcChannels.agentProfilesDelete, async (_event, agentId: unknown): Promise<boolean> => {
		const id = parseAgentId(agentId);
		return runWithLog(appLogger, "delete agent profile", { agentId: id }, async () => {
			// false = 不存在或内置智能体（不可删除），两种情况都不抛错：UI 靠 false 区分「不可删」。
			const deleted = await store.delete(id);
			void appLogger.info(LOG_SCOPE, "Deleted agent profile", { agentId: id, deleted });
			return deleted;
		});
	});

	ipcMain.handle(ipcChannels.agentProfilesResetBuiltin, async (_event, agentId: unknown): Promise<AgentProfile> => {
		const id = parseAgentId(agentId);
		return runWithLog(appLogger, "reset builtin agent profile", { agentId: id }, async () => {
			const agent = await store.resetBuiltin(id);
			void appLogger.info(LOG_SCOPE, "Reset builtin agent profile", { agentId: id });
			return agent;
		});
	});

	ipcMain.handle(ipcChannels.agentProfilesDuplicate, async (_event, agentId: unknown): Promise<AgentProfile> => {
		const id = parseAgentId(agentId);
		return runWithLog(appLogger, "duplicate agent profile", { agentId: id }, async () => {
			const agent = await store.duplicate(id);
			void appLogger.info(LOG_SCOPE, "Duplicated agent profile", { sourceAgentId: id, agentId: agent.id });
			return agent;
		});
	});

	ipcMain.handle(ipcChannels.agentProfilesBindSession, async (_event, input: unknown): Promise<AgentMarketSettings> => {
		const parsed = parseBindSessionInput(input);
		return runWithLog(appLogger, "bind agent to session", { sessionId: parsed.sessionId, agentId: parsed.agentId }, async () => {
			// 不存在的智能体由 store 抛 "Agent not found: <id>"：IPC 不重复实现查找语义。
			// 日志只记 id 与绑定数，绝不落角色设定（用户内容）。
			const settings = await store.bindSession(parsed);
			void appLogger.info(LOG_SCOPE, "Bound agent to session", { sessionId: parsed.sessionId, agentId: parsed.agentId, boundSessions: Object.keys(settings.sessionAgentBindings).length });
			return settings;
		});
	});

	ipcMain.handle(ipcChannels.agentProfilesReorder, async (_event, agentIds: unknown): Promise<string[]> => {
		const order = parseAgentOrder(agentIds);
		return runWithLog(appLogger, "reorder agent profiles", { count: order.length }, async () => {
			const nextOrder = await store.reorder(order);
			void appLogger.info(LOG_SCOPE, "Reordered agent profiles", { count: nextOrder.length });
			return nextOrder;
		});
	});

	ipcMain.handle(ipcChannels.agentProfilesUpdateSettings, async (_event, patch: unknown): Promise<AgentMarketSettings> => {
		const parsed = parseSettingsPatch(patch);
		return runWithLog(appLogger, "update agent market settings", { keys: Object.keys(parsed) }, async () => {
			const selected = parsed.selectionToolAgentId;
			// 显式指定默认智能体时先确认存在：store 只会静默回退 null，那样用户会以为设置没保存。
			if (typeof selected === "string" && !store.get(selected)) throw new Error(`Agent not found: ${selected}`);
			const settings = await store.updateSettings(parsed);
			void appLogger.info(LOG_SCOPE, "Updated agent market settings", { selectionToolEnabled: settings.selectionToolEnabled, selectionToolAgentId: settings.selectionToolAgentId });
			return settings;
		});
	});

	return () => {
		unsubscribeChanged();
		ipcMain.removeHandler(ipcChannels.agentProfilesGetSnapshot);
		ipcMain.removeHandler(ipcChannels.agentProfilesCreate);
		ipcMain.removeHandler(ipcChannels.agentProfilesUpdate);
		ipcMain.removeHandler(ipcChannels.agentProfilesDelete);
		ipcMain.removeHandler(ipcChannels.agentProfilesResetBuiltin);
		ipcMain.removeHandler(ipcChannels.agentProfilesDuplicate);
		ipcMain.removeHandler(ipcChannels.agentProfilesUpdateSettings);
		ipcMain.removeHandler(ipcChannels.agentProfilesBindSession);
		ipcMain.removeHandler(ipcChannels.agentProfilesReorder);
	};
}

/** 统一失败日志：只记操作名与 id/计数；错误消息也不含用户正文（store 的错误只带 id）。 */
async function runWithLog<T>(appLogger: AppLogger, action: string, detail: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		void appLogger.error(LOG_SCOPE, `Failed to ${action}`, { ...detail, error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
}

function parseAgentId(value: unknown): string {
	if (typeof value !== "string") throw new Error("Invalid agent id");
	const id = value.trim();
	if (!id || id.length > MAX_AGENT_ID_CHARS) throw new Error("Invalid agent id");
	return id;
}

/**
 * 排序入参：完整 id 数组。未知/重复 id 不在这里拦，交给 store 按当前状态过滤——
 * 渲染层可能拿着拖拽开始时的旧快照，其中存在刚刚被删除的智能体 id。
 */
function parseAgentOrder(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error("Invalid agent order");
	if (value.length > MAX_AGENT_ORDER_ENTRIES) throw new Error("Agent order is too long");
	return value.map((entry) => parseAgentId(entry));
}

function parseRequiredText(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string") throw new Error(`Invalid agent profile: ${label}`);
	const text = value.trim();
	if (!text) throw new Error(`Agent ${label} is required`);
	if (text.length > maxLength) throw new Error(`Agent ${label} is too long`);
	return text;
}

/** 可选文本：缺键/null = 未提供；空串合法（= 清空简介/图标）。 */
function parseOptionalText(value: unknown, label: string, maxLength: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`Invalid agent profile: ${label}`);
	const text = value.trim();
	if (text.length > maxLength) throw new Error(`Agent ${label} is too long`);
	return text;
}

function parseCategory(value: unknown): AgentProfileCategory | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isAgentProfileCategory(value)) throw new Error("Invalid agent profile: category");
	return value;
}

/**
 * 模型引用归一化（渲染层与 JSON 都不可信）：
 * - 形状非法（非对象 / 字段不是字符串）→ 抛错；
 * - null、成对空串、只填一半、超长或含控制字符 → 归一化成 null（= 未设置 = 跟随会话模型）。
 * 编辑器用 { provider: "", modelId: "" } 表示「跟随会话模型」，所以坏引用不能让保存失败，
 * 但也绝不把半截引用落盘（落盘规则见 agentProfileNormalize.normalizeModelRef）。
 */
function parseModelRef(value: unknown): AgentModelRef | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (!isRecord(value) || typeof value.provider !== "string" || typeof value.modelId !== "string") throw new Error("Invalid agent profile: model");
	if (!isAgentModelFieldValid(value.provider) || !isAgentModelFieldValid(value.modelId)) return null;
	return { provider: value.provider, modelId: value.modelId };
}

function parseCreateInput(value: unknown): CreateAgentProfileInput {
	if (!isRecord(value)) throw new Error("Invalid agent profile input");
	const description = parseOptionalText(value.description, "description", AGENT_PROFILE_DESCRIPTION_MAX_CHARS);
	const icon = parseOptionalText(value.icon, "icon", AGENT_PROFILE_ICON_MAX_CHARS);
	const category = parseCategory(value.category);
	const model = parseModelRef(value.model);
	const backend = parseBackend(value.backend);
	return {
		name: parseRequiredText(value.name, "name", AGENT_PROFILE_NAME_MAX_CHARS),
		systemPrompt: parseRequiredText(value.systemPrompt, "system prompt", AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS),
		...(description === undefined ? {} : { description }),
		...(icon === undefined ? {} : { icon }),
		...(category === undefined ? {} : { category }),
		...(model ? { model } : {}),
		// 新建时 null 与缺省同义：没有「清除」语义，直接不写该字段（= 跟随默认后端）。
		...(backend === null || backend === undefined ? {} : { backend }),
	};
}

function parseUpdatePatch(value: unknown): AgentProfilePatch {
	if (!isRecord(value)) throw new Error("Invalid agent profile patch");
	// 只接受编辑器会改的内容字段：id / builtin / createdAt / usageCount 由主进程独占，未知键直接忽略。
	const patch: AgentProfilePatch = {};
	if (value.name !== undefined) patch.name = parseRequiredText(value.name, "name", AGENT_PROFILE_NAME_MAX_CHARS);
	if (value.description !== undefined) patch.description = parseOptionalText(value.description, "description", AGENT_PROFILE_DESCRIPTION_MAX_CHARS) ?? "";
	if (value.icon !== undefined) patch.icon = parseOptionalText(value.icon, "icon", AGENT_PROFILE_ICON_MAX_CHARS) ?? "";
	if (value.systemPrompt !== undefined) patch.systemPrompt = parseRequiredText(value.systemPrompt, "system prompt", AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS);
	if (value.category !== undefined) patch.category = parseCategory(value.category) ?? "general";
	const model = parseModelRef(value.model);
	if (model !== undefined) patch.model = model;
	// 后端用 hasOwn 判定：编辑器「跟随默认」会把 backend 显式置 undefined（清除），
	// 与「键缺失 = 保留原值」是两种语义（与 model 的 null 清空同一套约定）。
	if (Object.hasOwn(value, "backend")) patch.backend = parseBackend(value.backend);
	return patch;
}

/**
 * 智能体后端：缺省 = 未提供；null/undefined = 清除（跟随默认后端）；
 * 白名单外一律抛错（渲染层下拉正常不会命中，命中即旧版本/脏数据）。
 */
function parseBackend(value: unknown): AgentProfileBackend | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (!isAgentProfileBackend(value)) throw new Error("Invalid agent profile: backend");
	return value;
}

/**
 * 会话绑定入参：sessionId 必填，agentId 为 null（解绑）或非空 id。
 * 两端都卡长度与控制字符，并拒绝原型键（绑定表是普通对象，__proto__ 会污染原型）。
 */
function parseBindSessionInput(value: unknown): BindAgentSessionInput {
	if (!isRecord(value)) throw new Error("Invalid bind session input");
	const sessionId = normalizeBindingId(value.sessionId);
	if (!sessionId) throw new Error("Invalid session id");
	if (value.agentId === null) return { sessionId, agentId: null };
	const agentId = normalizeBindingId(value.agentId);
	if (!agentId) throw new Error("Invalid agent id");
	return { sessionId, agentId };
}

function parseSettingsPatch(value: unknown): UpdateAgentMarketSettingsInput {
	if (!isRecord(value)) throw new Error("Invalid agent market settings patch");
	// 会话绑定只能经 bind-session 改：设置保存拿的是旧快照，静默接收会把其它窗口刚写入的
	// 绑定整表覆盖。显式拒绝比忽略更好——渲染层一旦误传能在开发期立刻暴露。
	if (Object.hasOwn(value, "sessionAgentBindings")) throw new Error("Invalid agent market settings: sessionAgentBindings");
	const patch: UpdateAgentMarketSettingsInput = {};
	if (value.selectionToolEnabled !== undefined) {
		if (typeof value.selectionToolEnabled !== "boolean") throw new Error("Invalid agent market settings: selectionToolEnabled");
		patch.selectionToolEnabled = value.selectionToolEnabled;
	}
	if (value.systemSelectionEnabled !== undefined) {
		if (typeof value.systemSelectionEnabled !== "boolean") throw new Error("Invalid agent market settings: systemSelectionEnabled");
		patch.systemSelectionEnabled = value.systemSelectionEnabled;
	}
	if (value.selectionToolAgentId !== undefined) {
		if (value.selectionToolAgentId === null) patch.selectionToolAgentId = null;
		else if (typeof value.selectionToolAgentId === "string" && value.selectionToolAgentId.trim() && value.selectionToolAgentId.length <= MAX_AGENT_ID_CHARS) patch.selectionToolAgentId = value.selectionToolAgentId.trim();
		else throw new Error("Invalid agent market settings: selectionToolAgentId");
	}
	return patch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
