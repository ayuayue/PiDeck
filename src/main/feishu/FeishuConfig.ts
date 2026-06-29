/**
 * 飞书配置管理
 *
 * 多 Bot CRUD + App Secret 加密存储。
 * 数据持久化到 ~/.pi-desktop/feishu.json
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { FeishuBotConfig } from "../../shared/types";

// ===== 配置文件路径 =====

function getConfigDir(): string {
	const dir = join(app.getPath("userData"), "pi-desktop");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function getFeishuConfigPath(): string {
	return join(getConfigDir(), "feishu.json");
}

function getFeishuBindingsPath(botId: string): string {
	return join(getConfigDir(), `feishu-bindings-${botId}.json`);
}

// ===== 多 Bot 配置 =====

export type FeishuMultiBotConfig = {
	version: 2;
	bots: FeishuBotConfig[];
	/** 删除 Bot 只移除配置，不删除绑定文件；重新添加同一 App ID 时复用旧 ID 防止重复建群。 */
	deletedBotIdsByAppId?: Record<string, string>;
};

function readConfig(): FeishuMultiBotConfig {
	const path = getFeishuConfigPath();
	if (!existsSync(path)) {
		return { version: 2, bots: [], deletedBotIdsByAppId: {} };
	}
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);

		// 向后兼容 v1 格式（单 Bot）
		if (parsed.version === 1 && parsed.appId) {
			return {
				version: 2,
				bots: [
					{
						id: parsed.id || randomUUID(),
						name: parsed.name || "默认机器人",
						enabled: parsed.enabled !== false,
						appId: parsed.appId || "",
						appSecret: parsed.appSecret || "",
						defaultWorkspaceId: parsed.defaultWorkspaceId,
						requireMention: parsed.requireMention,
					},
				],
			};
		}

		return parsed as FeishuMultiBotConfig;
	} catch {
		return { version: 2, bots: [], deletedBotIdsByAppId: {} };
	}
}

function writeConfig(config: FeishuMultiBotConfig): void {
	const path = getFeishuConfigPath();
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

// ===== 公开 API =====

/** 列出所有 Bot 配置 */
export function listBots(): FeishuBotConfig[] {
	return readConfig().bots.map((bot) => ({ ...bot, appSecret: "" }));
}

/** 获取单个 Bot 配置 */
export function getBot(botId: string): FeishuBotConfig | undefined {
	return readConfig().bots.find((b) => b.id === botId);
}

/** 添加 Bot */
export function addBot(input: {
	name: string;
	appId: string;
	appSecret: string;
	defaultWorkspaceId?: string;
	defaultUserOpenId?: string;
	requireMention?: boolean;
}): FeishuBotConfig {
	const config = readConfig();
	const appId = input.appId.trim();
	const existingIndex = config.bots.findIndex((b) => b.appId === appId);
	const reusedId = config.deletedBotIdsByAppId?.[appId];
	const bot: FeishuBotConfig = {
		// 同一飞书应用重新添加时复用旧 botId，旧绑定文件才能继续按 sessionPath/chatId 复用。
		id: existingIndex >= 0 ? config.bots[existingIndex].id : (reusedId || randomUUID()),
		name: input.name,
		enabled: true,
		appId,
		appSecret: encryptSecret(input.appSecret),
		defaultWorkspaceId: input.defaultWorkspaceId,
		defaultUserOpenId: input.defaultUserOpenId,
		requireMention: input.requireMention ?? true,
	};
	if (existingIndex >= 0) {
		config.bots[existingIndex] = { ...config.bots[existingIndex], ...bot };
	} else {
		config.bots.push(bot);
	}
	if (config.deletedBotIdsByAppId) delete config.deletedBotIdsByAppId[appId];
	writeConfig(config);
	return bot;
}

/** 更新 Bot 配置 */
export function updateBot(botId: string, patch: Partial<FeishuBotConfig>): FeishuBotConfig | undefined {
	const config = readConfig();
	const index = config.bots.findIndex((b) => b.id === botId);
	if (index === -1) return undefined;

	// 如果 patch.appSecret 是明文（不是 base64），加密后存储
	if (patch.appSecret && !isBase64(patch.appSecret)) {
		patch.appSecret = encryptSecret(patch.appSecret);
	}

	config.bots[index] = { ...config.bots[index], ...patch };
	writeConfig(config);
	return config.bots[index];
}

/** 删除 Bot */
export function removeBot(botId: string): boolean {
	const config = readConfig();
	const removed = config.bots.find((b) => b.id === botId);
	const before = config.bots.length;
	config.bots = config.bots.filter((b) => b.id !== botId);
	if (config.bots.length === before) return false;
	if (removed?.appId) {
		// 只删除 Bot 配置，不删除群绑定文件；记录 appId → botId 供后续重加同一应用时复用。
		config.deletedBotIdsByAppId = config.deletedBotIdsByAppId ?? {};
		config.deletedBotIdsByAppId[removed.appId] = removed.id;
	}
	writeConfig(config);
	return true;
}

/** 解密 App Secret */
export function getDecryptedBotAppSecret(botId: string): string {
	const bot = getBot(botId);
	if (!bot) return "";
	return decryptSecret(bot.appSecret);
}

// ===== 会话-群组 ChatId 持久化 =====

/**
 * 持久化 sessionPath → chatId 的映射，独立于绑定生命周期。
 * removeBinding 不会删除此映射，确保断开重连后能复用已有群组、不重复创建。
 * key 为会话文件路径（sessionPath），value 为飞书群 chatId。
 */
const SESSION_CHAT_MAP_PATH = join(getConfigDir(), "feishu-session-chat.json");

function readSessionChatMap(): Record<string, string> {
	try {
		if (!existsSync(SESSION_CHAT_MAP_PATH)) return {};
		return JSON.parse(readFileSync(SESSION_CHAT_MAP_PATH, "utf-8"));
	} catch {
		return {};
	}
}

function writeSessionChatMap(map: Record<string, string>): void {
	writeFileSync(SESSION_CHAT_MAP_PATH, JSON.stringify(map, null, 2), "utf-8");
}

/** 根据 sessionPath 查找已有群组 chatId（不受 removeBinding 影响） */
export function getPersistentChatId(sessionPath: string): string | undefined {
	if (!sessionPath) return undefined;
	const map = readSessionChatMap();
	return map[sessionPath];
}

/** 保存 sessionPath → chatId 映射，用于断开重连后复用群组。 */
export function setPersistentChatId(sessionPath: string, chatId: string): void {
	if (!sessionPath || !chatId) return;
	const map = readSessionChatMap();
	map[sessionPath] = chatId;
	writeSessionChatMap(map);
}

// ===== 会话-Bot 分配持久化 =====

/**
 * 为每个 Agent 分配一个指定的飞书 Bot。
 * 如果未分配，默认使用连接中的 Bot。
 */
const SESSION_BOT_MAP_PATH = join(getConfigDir(), "feishu-session-bot.json");

function readSessionBotMap(): Record<string, string> {
	try {
		if (!existsSync(SESSION_BOT_MAP_PATH)) return {};
		return JSON.parse(readFileSync(SESSION_BOT_MAP_PATH, "utf-8"));
	} catch {
		return {};
	}
}

function writeSessionBotMap(map: Record<string, string>): void {
	writeFileSync(SESSION_BOT_MAP_PATH, JSON.stringify(map, null, 2), "utf-8");
}

/** 获取某个 Agent 指定的 Bot ID，如果未指定返回 undefined */
export function getSessionBotId(agentId: string): string | undefined {
	const map = readSessionBotMap();
	return map[agentId];
}

/** 设置/清除某个 Agent 使用的 Bot ID。传 undefined 或空字符串清除分配。 */
export function setSessionBotId(agentId: string, botId: string | undefined): void {
	const map = readSessionBotMap();
	if (botId) {
		map[agentId] = botId;
	} else {
		delete map[agentId];
	}
	writeSessionBotMap(map);
}

// ===== 绑定持久化 =====

export type FeishuChatBindingPersist = {
	chatId: string;
	botId: string;
	userId: string;
	sessionId: string;
	sessionPath?: string;
	workspaceId: string;
	channelId?: string;
	modelId?: string;
	source: string;
	chatType: string;
	groupName?: string;
	createdAt: number;
};

export function loadBindings(botId: string): FeishuChatBindingPersist[] {
	const path = getFeishuBindingsPath(botId);
	if (!existsSync(path)) return [];
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as FeishuChatBindingPersist[];
	} catch {
		return [];
	}
}

export function saveBindings(botId: string, bindings: FeishuChatBindingPersist[]): void {
	const path = getFeishuBindingsPath(botId);
	writeFileSync(path, JSON.stringify(bindings, null, 2), "utf-8");
}

// ===== 加密/解密（简化版，用 Electron safeStorage） =====

function encryptSecret(plainSecret: string): string {
	// Phase 1: 简单 base64，后续可升级为 Electron safeStorage
	return Buffer.from(plainSecret, "utf-8").toString("base64");
}

function decryptSecret(encryptedSecret: string): string {
	if (!encryptedSecret) return "";
	try {
		return Buffer.from(encryptedSecret, "base64").toString("utf-8");
	} catch {
		return encryptedSecret; // 降级：返回原始值
	}
}

function isBase64(str: string): boolean {
	// Base64 只包含 A-Za-z0-9+/= 字符，且长度是 4 的倍数
	if (!str || str.length % 4 !== 0) return false;
	return /^[A-Za-z0-9+/]*={0,2}$/.test(str);
}