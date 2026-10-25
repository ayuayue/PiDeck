/**
 * 微信 iLink 桥接配置管理。
 *
 * 单账号模型：iLink 是「一个微信号 1:1 绑定一个 Bot」，重新扫码只换 token、身份不变，
 * 所以这里不做飞书那样的多 Bot CRUD —— 那套结构在微信侧是多余抽象，只会让绑定
 * 归属判断多一层。若将来协议支持多账号，再加 version 2 迁移。
 *
 * bot_token 是长期凭据（拿到即可收发这个微信号的消息），落盘前用 Electron
 * safeStorage 加密，与飞书 App Secret 同一套 v2: 标记格式。两处实现刻意各自独立：
 * 密文从不跨模块流转，格式一致只是为了让运维/备份的人不那么容易踩坑。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import type { ImChannelBackend, WeChatAccountInfo, WeChatChatBinding, WeChatModelChainEntry, WeChatSettings } from "../../shared/types";
import { parseImChannelBackend } from "../../shared/types";
import { ILINK_DEFAULT_BASE_URL } from "./ilinkProtocol";

/** 模型链上限。链路是「兜底」不是模型清单：太长只会让失败重试拖时间、多花钱。 */
export const MODEL_CHAIN_MAX = 8;

// ===== 路径 =====
// 不能在模块求值时解析：主进程此时可能尚未 setPath("userData")，必须在读写边界解析。

function getConfigDir(): string {
	const dir = join(app.getPath("userData"), "wechat");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function getSettingsPath(): string {
	return join(getConfigDir(), "wechat.json");
}

function getBindingsPath(): string {
	return join(getConfigDir(), "wechat-bindings.json");
}

// ===== 持久化形状 =====

/** 落盘的账号记录。encryptedBotToken 永不离开主进程。 */
type PersistedAccount = {
	ilinkBotId: string;
	ilinkUserId: string;
	encryptedBotToken: string;
	baseUrl: string;
	displayName: string;
	loggedInAt: number;
	/** getUpdates 增量游标。必须持久化：重启后从旧游标续接，否则历史消息会被重新喂给 Agent。 */
	cursor: string;
	/** 服务端判会话失效（errcode -14）后置位：token 已废，界面据此提示重新扫码。 */
	needsRelogin?: boolean;
};

type SettingsFile = {
	version: 1;
	enabled: boolean;
	account: PersistedAccount | null;
	defaultWorkspaceId?: string;
	defaultModelId?: string;
	/** 新会话的运行时后端；缺省 pi。已存在的绑定各带自己的 backend。 */
	backend?: ImChannelBackend;
	modelChain?: WeChatModelChainEntry[];
};

type BindingsFile = {
	version: 1;
	bindings: WeChatBindingPersist[];
};

export type WeChatBindingPersist = WeChatChatBinding;

const EMPTY_SETTINGS: SettingsFile = { version: 1, enabled: false, account: null };

/**
 * 归一化模型链：丢掉空 provider/modelId、去重、截断到模型链上限。
 * 界面与 IPC 都会校验，但文件可能被手改——落盘/读取边界必须再洗一次。
 */
export function normalizeModelChain(value: unknown): WeChatModelChainEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: WeChatModelChainEntry[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const provider = typeof record.provider === "string" ? record.provider.trim() : "";
		const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
		if (!provider || !modelId) continue;
		if (entries.some((entry) => entry.provider === provider && entry.modelId === modelId)) continue;
		const modelName = typeof record.modelName === "string" && record.modelName.trim() ? record.modelName.trim() : undefined;
		entries.push(modelName ? { provider, modelId, modelName } : { provider, modelId });
		if (entries.length >= MODEL_CHAIN_MAX) break;
	}
	return entries;
}

// ===== 读写 =====

function readSettings(): SettingsFile {
	const path = getSettingsPath();
	if (!existsSync(path)) return { ...EMPTY_SETTINGS };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SettingsFile>;
		if (parsed?.version !== 1) return { ...EMPTY_SETTINGS };
		return {
			version: 1,
			enabled: parsed.enabled === true,
			account: parsed.account ?? null,
			defaultWorkspaceId: parsed.defaultWorkspaceId,
			defaultModelId: parsed.defaultModelId,
			// 手改/旧版写入的非法值一律丢掉（当未设置），不把脏值带到建会话链路。
			backend: parseImChannelBackend(parsed.backend),
			modelChain: normalizeModelChain(parsed.modelChain),
		};
	} catch {
		// 配置损坏时按「未登录」处理而不是抛错：桥接起不来不该让应用起不来。
		return { ...EMPTY_SETTINGS };
	}
}

function writeSettings(settings: SettingsFile): void {
	writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), "utf-8");
}

function readBindings(): WeChatBindingPersist[] {
	const path = getBindingsPath();
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<BindingsFile>;
		return Array.isArray(parsed?.bindings) ? parsed.bindings : [];
	} catch {
		return [];
	}
}

function writeBindings(bindings: WeChatChatBinding[]): void {
	const payload: BindingsFile = { version: 1, bindings };
	writeFileSync(getBindingsPath(), JSON.stringify(payload, null, 2), "utf-8");
}

// ===== 加密 =====
// safeStorage 不可用（部分 Linux 无 keyring）时新写入退化为基础 base64，功能不阻断；
// 解密失败（换机器/系统凭据变化）必须返回 ""，宁可判定「配置缺失」，也不能把密文当
// 明文外发 —— 那会让每次请求都带一个垃圾 token，故障现象极难归因。

let safeStorageAvailable: boolean | null = null;

function isSafeStorageUsable(): boolean {
	if (safeStorageAvailable === null) {
		try {
			safeStorageAvailable = safeStorage.isEncryptionAvailable();
		} catch {
			safeStorageAvailable = false;
		}
	}
	return safeStorageAvailable;
}

function encryptSecret(plain: string): string {
	if (!plain) return "";
	if (isSafeStorageUsable()) {
		try {
			return `v2:${safeStorage.encryptString(plain).toString("base64")}`;
		} catch {
			// 加密失败不阻断登录：落到下面的 base64 分支
		}
	}
	return Buffer.from(plain, "utf-8").toString("base64");
}

function decryptSecret(stored: string): string {
	if (!stored) return "";
	if (stored.startsWith("v2:")) {
		try {
			return safeStorage.decryptString(Buffer.from(stored.slice(3), "base64"));
		} catch {
			return "";
		}
	}
	return Buffer.from(stored, "base64").toString("utf-8");
}

// ===== 设置 =====

export function getSettings(): WeChatSettings {
	const settings = readSettings();
	return {
		enabled: settings.enabled,
		account: toPublicAccount(settings.account),
		defaultWorkspaceId: settings.defaultWorkspaceId,
		defaultModelId: settings.defaultModelId,
		backend: settings.backend,
		modelChain: settings.modelChain ?? [],
	};
}

function toPublicAccount(account: PersistedAccount | null): WeChatAccountInfo | null {
	if (!account) return null;
	return {
		ilinkBotId: account.ilinkBotId,
		ilinkUserId: account.ilinkUserId,
		displayName: account.displayName,
		baseUrl: account.baseUrl,
		loggedInAt: account.loggedInAt,
		needsRelogin: account.needsRelogin === true,
	};
}

export function setEnabled(enabled: boolean): void {
	const settings = readSettings();
	settings.enabled = enabled;
	writeSettings(settings);
}

export function updateSettings(patch: { defaultWorkspaceId?: string; defaultModelId?: string; backend?: ImChannelBackend; modelChain?: WeChatModelChainEntry[] }): WeChatSettings {
	const settings = readSettings();
	if (patch.defaultWorkspaceId !== undefined) settings.defaultWorkspaceId = patch.defaultWorkspaceId || undefined;
	if (patch.defaultModelId !== undefined) settings.defaultModelId = patch.defaultModelId || undefined;
	// 非法值归一为 undefined（缺省 pi）；写 "pi" 与不写等价，但保留显式值便于排障。
	if (patch.backend !== undefined) settings.backend = parseImChannelBackend(patch.backend);
	if (patch.modelChain !== undefined) settings.modelChain = normalizeModelChain(patch.modelChain);
	writeSettings(settings);
	return getSettings();
}

// ===== 账号 =====

/** 账号记录（含密文）。只有桥接层需要，渲染层拿到的账号走 getSettings().account。 */
export function getAccount(): PersistedAccount | null {
	return readSettings().account;
}

export function getPublicAccount(): WeChatAccountInfo | null {
	return toPublicAccount(readSettings().account);
}

/** 解密后的 bot_token。未登录、或密文解不开（换机器）时返回空串，调用方须按「未登录」处理。 */
export function getDecryptedBotToken(): string {
	const account = readSettings().account;
	if (!account) return "";
	return decryptSecret(account.encryptedBotToken);
}

/**
 * 保存扫码结果。重新扫码会重置 cursor —— 换了 token 就是新会话，
 * 沿用旧游标会让服务端从一个已经作废的位置续接。
 */
export function saveAccount(input: { ilinkBotId: string; ilinkUserId: string; botToken: string; baseUrl?: string; displayName?: string }): WeChatAccountInfo | null {
	if (!input.botToken || !input.ilinkBotId) return null;
	const settings = readSettings();
	const previous = settings.account;
	const isSameBot = previous?.ilinkBotId === input.ilinkBotId;
	// 同一个 Bot 重新扫码时保留用户起的名字，否则每次扫码都要重命名。
	const displayName = input.displayName ?? (isSameBot ? previous?.displayName : undefined) ?? "微信 ClawBot";
	settings.account = {
		ilinkBotId: input.ilinkBotId,
		ilinkUserId: input.ilinkUserId,
		encryptedBotToken: encryptSecret(input.botToken),
		baseUrl: normalizeBaseUrl(input.baseUrl) ?? ILINK_DEFAULT_BASE_URL,
		displayName,
		loggedInAt: Date.now(),
		cursor: "",
	};
	settings.enabled = true;
	writeSettings(settings);
	return toPublicAccount(settings.account);
}

export function setDisplayName(displayName: string): WeChatSettings {
	const settings = readSettings();
	if (settings.account && displayName.trim()) {
		settings.account.displayName = displayName.trim();
		writeSettings(settings);
	}
	return getSettings();
}

/** 登出。只清凭据，绑定与会话保留（重新扫码后还能接回同一个 pi 会话）。 */
export function clearAccount(): void {
	const settings = readSettings();
	settings.account = null;
	settings.enabled = false;
	writeSettings(settings);
}

/**
 * 标记需要重新扫码。token 已废，继续轮询只会反复拿同一个错误，所以同时清游标：
 * 下次登录是全新会话，从旧位置续接没有意义。
 */
export function markNeedsRelogin(): void {
	const settings = readSettings();
	if (!settings.account) return;
	settings.account.needsRelogin = true;
	settings.account.cursor = "";
	writeSettings(settings);
}

/** 只允许扫码登录的那个微信号与 Bot 对话。iLink 不做这个校验，必须由我们兜住。 */
export function isAllowedUser(userId: string): boolean {
	const account = readSettings().account;
	if (!account) return false;
	return Boolean(userId) && userId === account.ilinkUserId;
}

// ===== 游标 =====

/**
 * 持久化收信游标。只在变化时写盘：长轮询约 18 秒一轮，无条件写会让磁盘每秒都被碰一次。
 */
export function setCursor(cursor: string): void {
	const settings = readSettings();
	if (!settings.account || settings.account.cursor === cursor) return;
	settings.account.cursor = cursor;
	writeSettings(settings);
}

export function getCursor(): string {
	return readSettings().account?.cursor ?? "";
}

// ===== 会话绑定 =====

export function loadBindings(): WeChatChatBinding[] {
	return readBindings();
}

export function getBinding(chatId: string): WeChatChatBinding | undefined {
	return readBindings().find((binding) => binding.chatId === chatId);
}

/** 按 chatId upsert。chatId 就是对方的 ilink_user_id（1:1 没有群聊维度）。 */
export function upsertBinding(binding: WeChatChatBinding): void {
	const bindings = readBindings();
	const index = bindings.findIndex((item) => item.chatId === binding.chatId);
	if (index >= 0) {
		bindings[index] = { ...bindings[index], ...binding };
	} else {
		bindings.push(binding);
	}
	writeBindings(bindings);
}

export function removeBinding(chatId: string): boolean {
	const bindings = readBindings();
	const next = bindings.filter((item) => item.chatId !== chatId);
	if (next.length === bindings.length) return false;
	writeBindings(next);
	return true;
}

/** 会话被删除时清掉指向它的绑定，避免下次收信指向一个不存在的会话。 */
export function removeBindingsBySessionId(sessionId: string): number {
	const bindings = readBindings();
	const next = bindings.filter((item) => item.sessionId !== sessionId);
	const removed = bindings.length - next.length;
	if (removed > 0) writeBindings(next);
	return removed;
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	const trimmed = baseUrl.trim();
	if (!trimmed) return undefined;
	return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}
