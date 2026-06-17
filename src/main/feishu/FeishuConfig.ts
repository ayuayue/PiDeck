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
};

function readConfig(): FeishuMultiBotConfig {
	const path = getFeishuConfigPath();
	if (!existsSync(path)) {
		return { version: 2, bots: [] };
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
		return { version: 2, bots: [] };
	}
}

function writeConfig(config: FeishuMultiBotConfig): void {
	const path = getFeishuConfigPath();
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

// ===== 公开 API =====

/** 列出所有 Bot 配置 */
export function listBots(): FeishuBotConfig[] {
	return readConfig().bots;
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
	const bot: FeishuBotConfig = {
		id: randomUUID(),
		name: input.name,
		enabled: true,
		appId: input.appId,
		appSecret: encryptSecret(input.appSecret),
		defaultWorkspaceId: input.defaultWorkspaceId,
		defaultUserOpenId: input.defaultUserOpenId,
		requireMention: input.requireMention ?? true,
	};
	config.bots.push(bot);
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
	const before = config.bots.length;
	config.bots = config.bots.filter((b) => b.id !== botId);
	if (config.bots.length === before) return false;
	writeConfig(config);
	return true;
}

/** 解密 App Secret */
export function getDecryptedBotAppSecret(botId: string): string {
	const bot = getBot(botId);
	if (!bot) return "";
	return decryptSecret(bot.appSecret);
}

// ===== 绑定持久化 =====

export type FeishuChatBindingPersist = {
	chatId: string;
	botId: string;
	userId: string;
	sessionId: string;
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