import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 飞书 App Secret 存储加密回归测试（FeishuConfig）。
 *
 * 背景 1（正确性 bug）：updateBot 旧实现用 isBase64 启发式判断「已加密」，
 * 但飞书 Secret 恰好多为 32 位纯字母数字（长度 %4==0 且落入 base64 字符集），
 * 会被误判而明文入库，重启后被误解码成垃圾导致认证失败。
 * 背景 2（安全）：Phase 1 的「加密」只是 base64。v2 起用 Electron safeStorage，
 * 带 "v2:" 前缀；legacy 数据兼容读取；safeStorage 不可用时降级不阻断。
 * 每个用例独立加载模块（独立 temp userData），互不污染。
 */

function makeFakeSafeStorage({ available = true, failDecrypt = false } = {}) {
	return {
		isEncryptionAvailable: () => available,
		encryptString: (s) => Buffer.from(`SAFE<${s}>`),
		decryptString: (buf) => {
			if (failDecrypt) throw new Error("keychain changed");
			const s = Buffer.isBuffer(buf) ? buf.toString() : String(buf);
			if (!s.startsWith("SAFE<") || !s.endsWith(">")) throw new Error("corrupt ciphertext");
			return s.slice(5, -1);
		},
	};
}

async function loadConfigModule({ safeStorage, prepare = async () => {} }) {
	const tempDir = await mkdtemp(join(tmpdir(), "feishu-secret-"));
	await prepare(tempDir);
	const load = createTsSandbox({
		stubs: {
			electron: {
				app: { getPath: () => tempDir },
				safeStorage,
			},
		},
	});
	const mod = load("src/main/feishu/FeishuConfig.ts");
	return { mod, tempDir };
}

async function readStoredConfig(tempDir) {
	return JSON.parse(await readFile(join(tempDir, "feishu", "feishu.json"), "utf8"));
}

test("v2：safeStorage 可用时入库带 v2 前缀，解密还原明文", async () => {
	const { mod, tempDir } = await loadConfigModule({ safeStorage: makeFakeSafeStorage() });
	try {
		const bot = mod.addBot({ name: "bot", appId: "cli_a1", appSecret: "plain-secret-1" });
		const stored = (await readStoredConfig(tempDir)).bots[0].appSecret;
		assert.ok(stored.startsWith("v2:"), "新写入必须带 v2 前缀");
		assert.notEqual(stored, "plain-secret-1", "不得明文入库");
		assert.equal(mod.getDecryptedBotAppSecret(bot.id), "plain-secret-1");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("回归：updateBot 收到 32 位纯字母数字 Secret 也会加密入库（旧 isBase64 启发式会误判成已加密而明文存储）", async () => {
	const { mod, tempDir } = await loadConfigModule({ safeStorage: makeFakeSafeStorage() });
	try {
		// 32 位纯字母数字：长度 %4==0、全落在 base64 字符集 —— 旧启发式的误判形态
		const alnumSecret = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
		const bot = mod.addBot({ name: "bot", appId: "cli_a2", appSecret: "initial" });
		mod.updateBot(bot.id, { appSecret: alnumSecret });
		const stored = (await readStoredConfig(tempDir)).bots[0].appSecret;
		assert.notEqual(stored, alnumSecret, "疑似 base64 的明文也必须加密，不得原样入库");
		assert.ok(stored.startsWith("v2:"));
		assert.equal(mod.getDecryptedBotAppSecret(bot.id), alnumSecret);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("updateBot 不带 appSecret 的 patch 不覆盖已存密钥", async () => {
	const { mod, tempDir } = await loadConfigModule({ safeStorage: makeFakeSafeStorage() });
	try {
		const bot = mod.addBot({ name: "bot", appId: "cli_a3", appSecret: "keep-me" });
		mod.updateBot(bot.id, { name: "renamed", defaultUserOpenId: "ou_1" });
		assert.equal(mod.getDecryptedBotAppSecret(bot.id), "keep-me", "改名字/改 open_id 不动密钥");
		const updated = mod.getBot(bot.id);
		assert.equal(updated.name, "renamed");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("降级：safeStorage 不可用时回落 legacy base64，功能不阻断", async () => {
	const { mod, tempDir } = await loadConfigModule({ safeStorage: makeFakeSafeStorage({ available: false }) });
	try {
		const bot = mod.addBot({ name: "bot", appId: "cli_a4", appSecret: "fallback-secret" });
		const stored = (await readStoredConfig(tempDir)).bots[0].appSecret;
		assert.ok(!stored.startsWith("v2:"), "不可用时不打 v2 标记");
		assert.notEqual(stored, "fallback-secret", "即便降级也不得明文入库");
		assert.equal(mod.getDecryptedBotAppSecret(bot.id), "fallback-secret");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("v2 解密失败（换机器/系统凭据变化）返回空串，不把密文当明文外发", async () => {
	const { mod, tempDir } = await loadConfigModule({ safeStorage: makeFakeSafeStorage({ failDecrypt: true }) });
	try {
		// 先用能加密的实例写入（分两次加载太重，直接手写 v2 载荷）
		const bot = mod.addBot({ name: "bot", appId: "cli_a5", appSecret: "will-lose" });
		assert.equal(mod.getDecryptedBotAppSecret(bot.id), "", "解密失败宁可判定配置缺失");
		const stored = (await readStoredConfig(tempDir)).bots[0].appSecret;
		assert.ok(bot.id && stored.startsWith("v2:"));
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("旧飞书目录迁到 feishu，密文、群绑定与会话分配原样保留", async () => {
	const legacy = Buffer.from("legacy-secret-2023", "utf8").toString("base64");
	const config = { version: 2, bots: [{ id: "legacy-bot", name: "old", enabled: true, appId: "cli_old", appSecret: legacy, requireMention: true }], deletedBotIdsByAppId: {} };
	const { mod, tempDir } = await loadConfigModule({
		safeStorage: makeFakeSafeStorage(),
		prepare: async (dir) => {
			await mkdir(join(dir, "pi-desktop"));
			await writeFile(join(dir, "pi-desktop", "feishu.json"), JSON.stringify(config));
			await writeFile(join(dir, "pi-desktop", "feishu-bindings-legacy-bot.json"), JSON.stringify([{ chatId: "chat-old" }]));
			await writeFile(join(dir, "pi-desktop", "feishu-session-chat.json"), JSON.stringify({ "/sessions/old.jsonl": "chat-old" }));
			await writeFile(join(dir, "pi-desktop", "feishu-session-bot.json"), JSON.stringify({ "session-old": "legacy-bot" }));
		},
	});
	try {
		assert.equal(mod.getDecryptedBotAppSecret("legacy-bot"), "legacy-secret-2023");
		assert.equal((await readStoredConfig(tempDir)).bots[0].appSecret, legacy);
		assert.equal(mod.loadBindings("legacy-bot")[0].chatId, "chat-old");
		assert.equal(mod.getPersistentChatId("/sessions/old.jsonl"), "chat-old");
		assert.equal(mod.getSessionBotId("session-old"), "legacy-bot");
		await assert.rejects(access(join(tempDir, "pi-desktop")), { code: "ENOENT" });
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("源码契约：updateBot 不再用 isBase64 启发式判断「已加密」", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile("src/main/feishu/FeishuConfig.ts", "utf8");
	assert.ok(!/\bisBase64\s*\(/.test(source), "启发式函数/调用已删除：无法可靠区分明文与密文，一律非空即加密");
	assert.match(source, /v2:/, "加密载荷必须带 v2 前缀标记，解密按标记分流");
	assert.match(source, /patch = \{ \.\.\.patch, appSecret: encryptSecret/, "updateBot 必须重加密而非透传");
});
