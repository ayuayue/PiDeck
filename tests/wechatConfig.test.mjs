import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 微信 iLink 配置存储测试（WeChatConfig）。
 *
 * 重点在两类不可回退的约束：
 * 1. 安全：bot_token 是「拿到即可收发这个微信号消息」的长期凭据，不得明文入库，
 *    更不得出现在渲染层可见的账号信息里。
 * 2. 身份：iLink 不校验消息来源，白名单必须由我们兜住——只有扫码登录的那个
 *    微信号能与 Bot 对话。
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

async function loadConfigModule({ safeStorage = makeFakeSafeStorage(), prepare = async () => {} } = {}) {
	const tempDir = await mkdtemp(join(tmpdir(), "wechat-config-"));
	await prepare(tempDir);
	const load = createTsSandbox({ stubs: { electron: { app: { getPath: () => tempDir }, safeStorage } } });
	return { mod: load("src/main/wechat/WeChatConfig.ts"), tempDir };
}

async function readStoredSettings(tempDir) {
	return JSON.parse(await readFile(join(tempDir, "wechat", "wechat.json"), "utf8"));
}

/**
 * 沙箱里造出来的对象原型属于另一个 realm，深度比较会连原型一起比，
 * 结构完全一样也会报 "same structure but are not reference-equal"；比较前先降级成纯数据。
 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const LOGIN = { ilinkBotId: "78d85fe69881@im.bot", ilinkUserId: "o9cq80x1@im.wechat", botToken: "78d85fe69881@im.bot:06000072642df0" };

test("新登录：token 加密入库带 v2 前缀，且不以明文出现在任何落盘文件中", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		const account = mod.saveAccount(LOGIN);
		assert.equal(account.ilinkBotId, LOGIN.ilinkBotId);
		const raw = await readFile(join(tempDir, "wechat", "wechat.json"), "utf8");
		assert.equal(raw.includes(LOGIN.botToken), false, "明文 token 绝不能落盘");
		assert.ok((await readStoredSettings(tempDir)).account.encryptedBotToken.startsWith("v2:"));
		assert.equal(mod.getDecryptedBotToken(), LOGIN.botToken);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("渲染层可见的账号信息里永远没有 token", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		mod.saveAccount(LOGIN);
		const serialized = JSON.stringify(mod.getSettings());
		assert.equal(serialized.includes("botToken"), false);
		assert.equal(serialized.includes("06000072642df0"), false);
		assert.equal(serialized.includes("encryptedBotToken"), false);
		assert.equal(mod.getSettings().account.ilinkUserId, LOGIN.ilinkUserId);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("白名单：只有扫码登录的那个微信号能对话", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		assert.equal(mod.isAllowedUser(LOGIN.ilinkUserId), false, "未登录时任何人都不能对话");
		mod.saveAccount(LOGIN);
		assert.equal(mod.isAllowedUser(LOGIN.ilinkUserId), true);
		assert.equal(mod.isAllowedUser("someone-else@im.wechat"), false);
		assert.equal(mod.isAllowedUser(""), false, "空 userId 不能因为与空账号比较而放行");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("重新扫码同一 Bot 保留自定义名字，换 Bot 用默认名", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		mod.saveAccount(LOGIN);
		mod.setDisplayName("我的助手");
		assert.equal(mod.getSettings().account.displayName, "我的助手");

		mod.saveAccount({ ...LOGIN, botToken: "rotated-token" });
		assert.equal(mod.getSettings().account.displayName, "我的助手", "重扫不能把用户起的名字冲掉");
		assert.equal(mod.getDecryptedBotToken(), "rotated-token");

		mod.saveAccount({ ...LOGIN, ilinkBotId: "other-bot@im.bot", ilinkUserId: "other@im.wechat", botToken: "t2" });
		assert.equal(mod.getSettings().account.displayName, "微信 ClawBot");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("重新扫码换成另一个微信号：通道只剩新号能对话，旧绑定仍保留", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		mod.saveAccount(LOGIN);
		mod.upsertBinding({ chatId: LOGIN.ilinkUserId, userId: LOGIN.ilinkUserId, sessionId: "sess-1", workspaceId: "ws-1", createdAt: 1 });
		assert.equal(mod.isAllowedUser(LOGIN.ilinkUserId), true);

		// 已登录状态下重新扫码，扫的是另一个微信号：白名单整体换成新号。
		mod.saveAccount({ ilinkBotId: "other-bot@im.bot", ilinkUserId: "other@im.wechat", botToken: "t2" });
		assert.equal(mod.isAllowedUser(LOGIN.ilinkUserId), false, "旧号不能再驱动这个 Bot（单账号约束就是这条）");
		assert.equal(mod.isAllowedUser("other@im.wechat"), true);
		assert.equal(plain(mod.loadBindings()).length, 1, "绑定不随换号消失：换回来还能接回原会话");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("重新扫码清空游标（换 token 就是新会话，旧游标位置已作废）", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		mod.saveAccount(LOGIN);
		mod.setCursor("cursor-advanced");
		assert.equal(mod.getCursor(), "cursor-advanced");
		mod.saveAccount({ ...LOGIN, botToken: "fresh" });
		assert.equal(mod.getCursor(), "");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("游标只在变化时落盘，且未登录时不写", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		mod.setCursor("nothing-to-write");
		assert.equal(mod.getCursor(), "", "未登录时游标无处可存");
		mod.saveAccount(LOGIN);
		mod.setCursor("c1");
		const settingsPath = join(tempDir, "wechat", "wechat.json");
		const before = (await readFile(settingsPath, "utf8")).length;
		mod.setCursor("c1");
		assert.equal((await readFile(settingsPath, "utf8")).length, before, "同值不重写");
		mod.setCursor("c2");
		assert.equal(mod.getCursor(), "c2");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("会话失效后标记需重扫并清游标（不能拿废 token 继续轮询）", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		mod.saveAccount(LOGIN);
		mod.setCursor("c9");
		mod.markNeedsRelogin();
		assert.equal(mod.getSettings().account.needsRelogin, true);
		assert.equal(mod.getCursor(), "");
		mod.saveAccount(LOGIN);
		assert.equal(mod.getSettings().account.needsRelogin, false, "重新登录后标记必须清除");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("降级：safeStorage 不可用时回落 base64，仍然不明文入库", async () => {
	const { mod, tempDir } = await loadConfigModule({ safeStorage: makeFakeSafeStorage({ available: false }) });
	try {
		mod.saveAccount(LOGIN);
		const raw = await readFile(join(tempDir, "wechat", "wechat.json"), "utf8");
		assert.equal(raw.includes(LOGIN.botToken), false);
		assert.equal((await readStoredSettings(tempDir)).account.encryptedBotToken.startsWith("v2:"), false);
		assert.equal(mod.getDecryptedBotToken(), LOGIN.botToken);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("解密失败（换机器）返回空串，不把密文当明文外发", async () => {
	const { mod, tempDir } = await loadConfigModule({ safeStorage: makeFakeSafeStorage({ failDecrypt: true }) });
	try {
		mod.saveAccount(LOGIN);
		assert.equal(mod.getDecryptedBotToken(), "", "解不开就当未登录，绝不能把密文当 token 发出去");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("配置损坏时按未登录处理而不抛错（桥接起不来不该让应用起不来）", async () => {
	const { mod, tempDir } = await loadConfigModule({
		prepare: async (dir) => {
			await mkdir(join(dir, "wechat"));
			await writeFile(join(dir, "wechat", "wechat.json"), "{ broken json");
			await writeFile(join(dir, "wechat", "wechat-bindings.json"), "not json either");
		},
	});
	try {
		assert.deepEqual(plain(mod.getSettings()), { enabled: false, account: null, modelChain: [] });
		assert.equal(mod.getDecryptedBotToken(), "");
		assert.deepEqual(JSON.parse(JSON.stringify(mod.loadBindings())), []);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("版本不匹配的配置不猜测、按未登录处理", async () => {
	const { mod, tempDir } = await loadConfigModule({
		prepare: async (dir) => {
			await mkdir(join(dir, "wechat"));
			await writeFile(join(dir, "wechat", "wechat.json"), JSON.stringify({ version: 99, enabled: true, account: { ilinkBotId: "x", ilinkUserId: "u", encryptedBotToken: "plain" } }));
		},
	});
	try {
		assert.equal(mod.getSettings().account, null);
		assert.equal(mod.getSettings().enabled, false);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("绑定：按 chatId upsert、按会话删除，且不误删别人", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		const binding = { chatId: "user-a@im.wechat", userId: "user-a@im.wechat", sessionId: "sess-1", sessionPath: "/sessions/a.jsonl", workspaceId: "ws-1", createdAt: 1 };
		mod.upsertBinding(binding);
		mod.upsertBinding({ ...binding, chatId: "user-b@im.wechat", userId: "user-b@im.wechat", sessionId: "sess-2" });
		assert.equal(mod.loadBindings().length, 2);

		// 同一 chatId 再写是更新而不是追加（重复扫码/重连不该堆出一串死绑定）
		mod.upsertBinding({ ...binding, modelId: "m-1" });
		assert.equal(mod.loadBindings().length, 2);
		assert.equal(mod.getBinding(binding.chatId).modelId, "m-1");
		assert.equal(mod.getBinding(binding.chatId).createdAt, 1, "upsert 不得重置 createdAt");

		assert.equal(mod.removeBindingsBySessionId("sess-1"), 1);
		assert.equal(mod.getBinding(binding.chatId), undefined);
		assert.equal(mod.loadBindings().length, 1, "只删指向该会话的绑定");
		assert.equal(mod.removeBinding("user-b@im.wechat"), true);
		assert.equal(mod.removeBinding("user-b@im.wechat"), false);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("登出只清凭据、保留绑定（重新扫码能接回同一个 pi 会话）", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		mod.saveAccount(LOGIN);
		mod.upsertBinding({ chatId: LOGIN.ilinkUserId, userId: LOGIN.ilinkUserId, sessionId: "sess-1", workspaceId: "ws-1", createdAt: 1 });
		mod.clearAccount();
		assert.equal(mod.getSettings().account, null);
		assert.equal(mod.getSettings().enabled, false);
		assert.equal(mod.loadBindings().length, 1);
		assert.equal(mod.getDecryptedBotToken(), "");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("默认关闭：未显式启用前桥接不应自启", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		assert.equal(mod.getSettings().enabled, false);
		mod.saveAccount(LOGIN);
		assert.equal(mod.getSettings().enabled, true, "扫码成功后即为用户意图明确的启用");
		mod.setEnabled(false);
		assert.equal(mod.getSettings().enabled, false);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("base url 归一化：接受裸域名并补上 https，缺省回退官方地址", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		mod.saveAccount({ ...LOGIN, baseUrl: "ilinkai.weixin.qq.com" });
		assert.equal(mod.getSettings().account.baseUrl, "https://ilinkai.weixin.qq.com");
		mod.saveAccount({ ...LOGIN, baseUrl: "https://other.example.com" });
		assert.equal(mod.getSettings().account.baseUrl, "https://other.example.com");
		mod.saveAccount({ ...LOGIN, baseUrl: "   " });
		assert.equal(mod.getSettings().account.baseUrl, "https://ilinkai.weixin.qq.com");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("缺 token 或 botId 的登录结果一律不落盘（半截凭据比没有更危险）", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		assert.equal(mod.saveAccount({ ...LOGIN, botToken: "" }), null);
		assert.equal(mod.saveAccount({ ...LOGIN, ilinkBotId: "" }), null);
		assert.equal(mod.getSettings().account, null);
		assert.equal(mod.getSettings().enabled, false);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("工作区/模型设置可更新与清空", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		mod.updateSettings({ defaultWorkspaceId: "ws-1", defaultModelId: "m-1" });
		assert.equal(mod.getSettings().defaultWorkspaceId, "ws-1");
		mod.updateSettings({ defaultModelId: "" });
		assert.equal(mod.getSettings().defaultModelId, undefined, "空串等于清空，不留空字符串设置项");
		assert.equal(mod.getSettings().defaultWorkspaceId, "ws-1", "未提到的字段不动");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

// ===== 模型链 =====

test("模型链落盘前归一化：丢空项、去重、截断", async () => {
	// 链是「兜底顺序」，重复项会让同一模型跑两次、空项会在顺延时直接报错。
	const { mod, tempDir } = await loadConfigModule();
	try {
		mod.updateSettings({
			modelChain: [{ provider: " p1 ", modelId: "fast", modelName: " Fast " }, { provider: "p1", modelId: "fast" }, { provider: "", modelId: "不完整的条目" }, { provider: "p2", modelId: "   " }, ...Array.from({ length: 12 }, (_, index) => ({ provider: "px", modelId: `m${index}` }))],
		});

		const chain = mod.getSettings().modelChain;
		assert.equal(chain.length, mod.MODEL_CHAIN_MAX, "超长链必须截到上限");
		assert.deepEqual(plain(chain[0]), { provider: "p1", modelId: "fast", modelName: "Fast" }, "首项要去空白并保留显示名");
		assert.deepEqual(plain(chain[1]), { provider: "px", modelId: "m0" }, "重复项与残缺项被丢掉");
		assert.deepEqual(plain(chain[chain.length - 1]), { provider: "px", modelId: "m6" });
		assert.deepEqual((await readStoredSettings(tempDir)).modelChain, plain(chain), "落盘的必须已经是洗过的链");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("手改文件里的非法模型链在读取时被洗掉，不影响其他设置", async () => {
	// 设置文件是明文可手改的：读取边界必须再洗一次，不能把垃圾传给桥接。
	const { mod, tempDir } = await loadConfigModule({
		prepare: async (dir) => {
			await mkdir(join(dir, "wechat"), { recursive: true });
			await writeFile(join(dir, "wechat", "wechat.json"), JSON.stringify({ version: 1, enabled: true, defaultWorkspaceId: "ws-9", modelChain: [{ provider: "p1" }, { modelId: "fast" }, "字符串", null, { provider: "p2", modelId: "smart" }, { provider: "p2", modelId: "smart" }] }));
		},
	});
	try {
		assert.deepEqual(plain(mod.getSettings().modelChain), [{ provider: "p2", modelId: "smart" }], "残缺项被丢掉、重复项去重后只剩合法条目");
		assert.equal(mod.getSettings().defaultWorkspaceId, "ws-9", "洗模型链不得弄丢同一文件里的其它设置");
		assert.equal(mod.getSettings().enabled, true);
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("模型链可用空数组清空", async () => {
	const { mod, tempDir } = await loadConfigModule();
	try {
		mod.updateSettings({ modelChain: [{ provider: "p1", modelId: "fast" }] });
		mod.updateSettings({ modelChain: [] });
		assert.deepEqual(plain(mod.getSettings().modelChain), [], "清空后必须是空链（回到不干预会话模型）");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

// ===== 渠道后端（pi / dsh）=====

test("渠道后端只落 pi/dsh：非法值归一化成「不指定」而不是透传", async () => {
	// 设置文件是明文可手改的，IPC 入参也可能来自旧版渲染层：两层都要挡住非法后端。
	// 归一化的结果是「不指定」（= pi 默认），不能把垃圾值透给桥接。
	const { mod, tempDir } = await loadConfigModule();
	try {
		assert.equal(mod.getSettings().backend, undefined, "默认不指定后端：与历史行为一致（pi）");
		mod.updateSettings({ backend: "pi" });
		assert.equal(mod.getSettings().backend, "pi");
		mod.updateSettings({ backend: "dsh" });
		assert.equal(mod.getSettings().backend, "dsh");
		assert.equal((await readStoredSettings(tempDir)).backend, "dsh", "后端要落盘");
		mod.updateSettings({ defaultWorkspaceId: "ws-1" });
		assert.equal(mod.getSettings().backend, "dsh", "未提到的字段不动");
		mod.updateSettings({ backend: "acp" });
		assert.equal(mod.getSettings().backend, undefined, "非法后端不得写入（回落默认）");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("手改文件里的非法渠道后端在读取时被洗掉", async () => {
	const { mod, tempDir } = await loadConfigModule({
		prepare: async (dir) => {
			await mkdir(join(dir, "wechat"), { recursive: true });
			await writeFile(join(dir, "wechat", "wechat.json"), JSON.stringify({ version: 1, enabled: true, backend: "claude", defaultWorkspaceId: "ws-9", modelChain: [] }));
		},
	});
	try {
		assert.equal(mod.getSettings().backend, undefined, "不认识的后端名不得带进运行期");
		assert.equal(mod.getSettings().defaultWorkspaceId, "ws-9", "洗后端不得弄丢同一文件里的其它设置");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});
