/**
 * 飞书配置管理
 *
 * 多 Bot CRUD + App Secret 加密存储。
 * 数据持久化到 userData/feishu/；历史 pi-desktop 子目录首读时整体迁移。
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import type { FeishuBotConfig } from "../../shared/types";
import { parseImChannelBackend } from "../../shared/types";
import { getAppLogger } from "../logging/sharedLogger";

let defaultBotName = "Feishu bot";

export function setFeishuConfigDefaultBotName(name: string): void {
	const normalized = name.trim();
	if (normalized) defaultBotName = normalized;
}

// ===== 配置文件路径 =====

function getConfigDir(): string {
	const userData = app.getPath("userData");
	const dir = join(userData, "feishu");
	const legacy = join(userData, "pi-desktop");
	// 保留密文与绑定的原始字节；两代目录并存时不覆盖，改名失败继续读旧配置。
	if (!existsSync(dir) && existsSync(legacy)) {
		try {
			renameSync(legacy, dir);
		} catch {
			void getAppLogger()?.warn("migration", "Feishu directory rename failed; continuing on legacy directory");
			return legacy;
		}
	}
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
						name: parsed.name || defaultBotName,
						enabled: parsed.enabled !== false,
						appId: parsed.appId || "",
						appSecret: parsed.appSecret || "",
						defaultWorkspaceId: parsed.defaultWorkspaceId,
						requireMention: parsed.requireMention,
					},
				],
			};
		}

		const config = parsed as FeishuMultiBotConfig;
		// 手改配置文件时可能写入任意值；非法后端在下游只会表现为「不可用」，这里统一洗成不指定。
		for (const bot of config.bots ?? []) {
			if (bot.backend !== undefined && parseImChannelBackend(bot.backend) === undefined) delete bot.backend;
		}
		return config;
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
export function addBot(input: { name: string; appId: string; appSecret: string; defaultWorkspaceId?: string; defaultUserOpenId?: string; requireMention?: boolean }): FeishuBotConfig {
	const config = readConfig();
	const appId = input.appId.trim();
	const existingIndex = config.bots.findIndex((b) => b.appId === appId);
	const reusedId = config.deletedBotIdsByAppId?.[appId];
	const bot: FeishuBotConfig = {
		// 同一飞书应用重新添加时复用旧 botId，旧绑定文件才能继续按 sessionPath/chatId 复用。
		id: existingIndex >= 0 ? config.bots[existingIndex].id : reusedId || randomUUID(),
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

	// App Secret 只接受明文：非空一律重加密入库（列表查询返回的 secret 恒为空串，
	// 渲染层不可能回传密文）。旧实现用 isBase64 启发式跳过「已加密」值，但飞书
	// Secret 恰好多为 32 位纯字母数字（长度 %4==0 且落入 base64 字符集），会被
	// 误判成已加密而明文入库，重启后又被误解码成垃圾导致认证失败。
	if (patch.appSecret) {
		patch = { ...patch, appSecret: encryptSecret(patch.appSecret) };
	}

	// 后端只认 pi/dsh：非法值归一化成「不指定」（跟随默认后端），不透传进配置文件。
	if (patch.backend !== undefined) {
		patch = { ...patch, backend: parseImChannelBackend(patch.backend) };
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
// 不能在模块求值时缓存路径：此时主进程可能尚未迁移/setPath，必须在读写边界解析。
function getSessionChatMapPath(): string {
	return join(getConfigDir(), "feishu-session-chat.json");
}

function readSessionChatMap(): Record<string, string> {
	try {
		const path = getSessionChatMapPath();
		if (!existsSync(path)) return {};
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

function writeSessionChatMap(map: Record<string, string>): void {
	writeFileSync(getSessionChatMapPath(), JSON.stringify(map, null, 2), "utf-8");
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
 * 为每个稳定 Session 分配一个指定的飞书 Bot。
 * 如果未分配，默认使用连接中的 Bot。
 */
function getSessionBotMapPath(): string {
	return join(getConfigDir(), "feishu-session-bot.json");
}

function readSessionBotMap(): Record<string, string> {
	try {
		const path = getSessionBotMapPath();
		if (!existsSync(path)) return {};
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

function writeSessionBotMap(map: Record<string, string>): void {
	writeFileSync(getSessionBotMapPath(), JSON.stringify(map, null, 2), "utf-8");
}

/** 获取某个稳定 Session 指定的 Bot ID，如果未指定返回 undefined。 */
export function getSessionBotId(sessionId: string): string | undefined {
	const map = readSessionBotMap();
	return map[sessionId];
}

/** 设置/清除某个稳定 Session 使用的 Bot ID。传 undefined 或空字符串清除分配。 */
export function setSessionBotId(sessionId: string, botId: string | undefined): void {
	const map = readSessionBotMap();
	if (botId) {
		map[sessionId] = botId;
	} else {
		delete map[sessionId];
	}
	writeSessionBotMap(map);
}

// ===== 绑定持久化 =====

export type FeishuChatBindingPersist = {
	chatId: string;
	botId: string;
	userId: string;
	sessionId: string;
	/** Current AgentManager runtime handle (optional for pre-agentId persisted data). */
	agentId?: string;
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

// ===== 加密/解密 =====
// 历史包袖：Phase 1 用 base64「加密」——只是混淆，拿到配置文件即可还原。
// v2 起 App Secret 用 Electron safeStorage（Windows DPAPI / macOS Keychain /
// Linux libsecret）加密，带 "v2:" 前缀标记；旧数据（纯 base64，无前缀）读取时
// 走 legacy 分支保持兼容。safeStorage 不可用（部分 Linux 无 keyring）时新写入
// 仍落 legacy base64，功能不阻断。
// 注意：v2 解密失败必须返回 ""（触发配置缺失错误），不能把密文当明文外发。

/** safeStorage 可用性探测结果缓存（每会话只探测一次） */
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

function encryptSecret(plainSecret: string): string {
	const trimmed = plainSecret.trim();
	if (!trimmed) return "";
	if (isSafeStorageUsable()) {
		try {
			const encrypted = safeStorage.encryptString(trimmed);
			return `v2:${Buffer.from(encrypted).toString("base64")}`;
		} catch {
			// 加密失败不阻断配置保存：落到 legacy 分支
		}
	}
	return Buffer.from(trimmed, "utf-8").toString("base64");
}

function decryptSecret(stored: string): string {
	if (!stored) return "";
	if (stored.startsWith("v2:")) {
		try {
			return safeStorage.decryptString(Buffer.from(stored.slice(3), "base64"));
		} catch {
			// v2 解密失败（换机器/系统凭据变化）：宁可判定配置缺失，也不把密文当明文外发
			return "";
		}
	}
	// legacy base64（Phase 1 数据）：原样兼容。老数据全部由 encryptSecret 写入，
	// 必为合法 base64；此处不再回退返回原文（那等于把垃圾当密钥外发）。
	return Buffer.from(stored, "base64").toString("utf-8");
}
