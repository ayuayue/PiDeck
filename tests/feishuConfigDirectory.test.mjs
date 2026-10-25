import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 仅临时目录与 fake Electron；覆盖 setPath 时序、历史数据冲突和失败回退。 */
function fixture(t) {
	const root = fs.mkdtempSync(join(tmpdir(), "pideck-feishu-dir-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

function loadConfig(getPath, fsOverrides = {}) {
	return loadTsCommonJs("src/main/feishu/FeishuConfig.ts", {
		stubs: { electron: { app: { getPath }, safeStorage: { isEncryptionAvailable: () => false } }, "node:fs": { ...fs, ...fsOverrides } },
	});
}

test("模块导入不提前创建目录；setPath 后所有飞书读写落在最新 userData", (t) => {
	const root = fixture(t);
	let userData = join(root, "bootstrap");
	const mod = loadConfig(() => userData);
	assert.equal(fs.existsSync(userData), false);
	userData = join(root, "PiDeck");
	mod.setSessionBotId("s1", "bot1");
	mod.setPersistentChatId("/sessions/s1.jsonl", "chat1");
	assert.equal(mod.getSessionBotId("s1"), "bot1");
	assert.equal(mod.getPersistentChatId("/sessions/s1.jsonl"), "chat1");
	assert.equal(fs.existsSync(join(root, "bootstrap")), false);
	assert.equal(fs.existsSync(join(userData, "pi-desktop")), false);
	assert.equal(JSON.parse(fs.readFileSync(join(userData, "feishu", "feishu-session-bot.json"), "utf8")).s1, "bot1");
});

test("飞书子目录更名失败继续读旧配置，恢复后下次读取自动补迁", (t) => {
	const root = fixture(t);
	const legacy = join(root, "pi-desktop");
	fs.mkdirSync(legacy);
	fs.writeFileSync(join(legacy, "feishu-session-bot.json"), '{"s1":"bot-old"}');
	let blocked = true;
	const mod = loadConfig(() => root, {
		renameSync(from, to) {
			if (blocked) throw new Error("simulated failure");
			return fs.renameSync(from, to);
		},
	});
	assert.equal(mod.getSessionBotId("s1"), "bot-old");
	assert.equal(fs.existsSync(join(root, "feishu")), false);
	blocked = false;
	assert.equal(mod.getSessionBotId("s1"), "bot-old");
	assert.equal(fs.existsSync(legacy), false);
	assert.equal(fs.readFileSync(join(root, "feishu", "feishu-session-bot.json"), "utf8"), '{"s1":"bot-old"}');
});

test("Bot 后端只认 pi/dsh：非法值不透传，手改文件里的非法值读取时被洗掉", (t) => {
	const root = fixture(t);
	const mod = loadConfig(() => root);

	const bot = mod.addBot({ name: "b", appId: "cli_a", appSecret: "s" });
	assert.equal(mod.listBots()[0].backend, undefined, "缺省不写后端");

	assert.equal(mod.updateBot(bot.id, { backend: "dsh" })?.backend, "dsh");
	assert.equal(mod.listBots()[0].backend, "dsh", "合法后端落盘");
	assert.equal(mod.updateBot(bot.id, { backend: "acp" })?.backend, undefined, "非法后端归一化成不指定");

	// 人工编辑配置文件时可能写入任意值：读取阶段必须再洗一次，不能让非法值流进桥接层。
	const configDir = join(root, "feishu");
	const configFile = fs.readdirSync(configDir).find((name) => fs.readFileSync(join(configDir, name), "utf8").includes('"bots"'));
	assert.ok(configFile, "应找到 Bot 配置文件");
	const filePath = join(configDir, configFile);
	const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
	raw.bots[0].backend = "claude";
	fs.writeFileSync(filePath, JSON.stringify(raw));
	assert.equal(mod.listBots()[0].backend, undefined, "读取时洗掉非法后端");
});

test("两代飞书目录并存时使用新目录，两边数据均不覆盖或合并", (t) => {
	const root = fixture(t);
	for (const [dir, value] of [
		["pi-desktop", "bot-old"],
		["feishu", "bot-new"],
	]) {
		fs.mkdirSync(join(root, dir));
		fs.writeFileSync(join(root, dir, "feishu-session-bot.json"), JSON.stringify({ s1: value }));
	}
	const mod = loadConfig(() => root);
	assert.equal(mod.getSessionBotId("s1"), "bot-new");
	assert.equal(JSON.parse(fs.readFileSync(join(root, "pi-desktop", "feishu-session-bot.json"), "utf8")).s1, "bot-old");
	assert.equal(JSON.parse(fs.readFileSync(join(root, "feishu", "feishu-session-bot.json"), "utf8")).s1, "bot-new");
});
