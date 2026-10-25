import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// ReplyActionRuleStore 的文件读写回归：种子化 / 文件优先 / 坏文件备份 / 原子保存。
// 与 quickMessages 测试同款写法：loadTsCommonJs 加载生产 TS，fs 操作用真临时目录。

const { ReplyActionRuleStore } = loadTsCommonJs("src/main/replyactions/ReplyActionRuleStore.ts");
const { REPLY_ACTIONS_FILE_VERSION } = loadTsCommonJs("src/shared/replyActions.ts");

const DEFAULT_RESOURCE = "resources/reply-actions.default.json";
const plain = (value) => JSON.parse(JSON.stringify(value));
const readDefaults = () => JSON.parse(readFileSync(DEFAULT_RESOURCE, "utf8"));

/** 每个用例独立临时目录：规则文件 + 可选的「坏文件」。 */
function makeStore(options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-replyact-"));
	const configPath = join(dir, "reply-actions.json");
	if (options.fileContent !== undefined) writeFileSync(configPath, options.fileContent);
	const logs = [];
	const store = new ReplyActionRuleStore({
		getConfigPath: () => configPath,
		getDefaultConfigPath: () => DEFAULT_RESOURCE,
		log: (scope, message, detail) => logs.push({ scope, message, detail }),
	});
	return { store, configPath, dir, logs };
}

const readConfig = (configPath) => JSON.parse(readFileSync(configPath, "utf8"));

test("store：没有规则文件时用随包规则种子化，并把文件真的落盘（用户可接着手工编辑）", async () => {
	const { store, configPath } = makeStore();
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), plain(readDefaults().items));
	assert.equal(snapshot.seeded, true, "首次生成应标记为种子化");
	assert.equal(snapshot.defaultsAvailable, true);
	assert.equal(snapshot.filePath, configPath);
	assert.deepEqual(plain(readConfig(configPath).items), plain(readDefaults().items), "种子应写进规则文件而不是只留在内存");
	assert.equal(readConfig(configPath).version, REPLY_ACTIONS_FILE_VERSION, "文件带结构版本号，便于将来迁移");
});

test("store：已有规则文件时完全以文件为准（手工编辑立刻生效，不被出厂规则覆盖）", async () => {
	const { store } = makeStore({ fileContent: JSON.stringify({ version: 1, items: [{ text: "只属于我的规则", triggers: [{ kind: "onStop" }] }] }) });
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), [{ text: "只属于我的规则", triggers: [{ kind: "onStop" }] }]);
	assert.equal(snapshot.seeded, false, "直接读到文件不应标记为种子化");
});

test("store：文件里的空数组是合法状态（清空后重启不复活出厂规则）", async () => {
	const { store } = makeStore({ fileContent: JSON.stringify({ version: 1, items: [] }) });
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), []);
	assert.equal(snapshot.seeded, false);
});

test("store：坏文件先备份成 .bak 再重建（用户手工编辑仍能找回）", async () => {
	const broken = "{ 这不是 JSON";
	const { store, configPath } = makeStore({ fileContent: broken });
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), plain(readDefaults().items), "无法识别时用出厂规则重建");
	assert.equal(readFileSync(`${configPath}.bak`, "utf8"), broken, "坏文件内容必须原样备份");
});

test("store：结构不对（items 不是数组）同样按不可识别处理，不静默吞掉用户内容", async () => {
	const { store, configPath } = makeStore({ fileContent: JSON.stringify({ items: "继续" }) });
	const snapshot = await store.getSnapshot();
	assert.deepEqual(plain(snapshot.items), plain(readDefaults().items));
	assert.ok(existsSync(`${configPath}.bak`), "结构异常也应留下备份");
});

test("store：save 先清洗再原子落盘，返回的快照与磁盘一致", async () => {
	const { store, configPath } = makeStore();
	await store.getSnapshot();
	const result = await store.save([
		{ text: "  提交  ", triggers: [{ kind: "onStop" }] },
		{ text: "提交", triggers: [{ kind: "onStop" }] },
		{ text: "推送", triggers: [{ kind: "onStop" }] },
	]);
	assert.equal(result.ok, true);
	assert.deepEqual(
		plain(result.snapshot.items),
		[
			{ text: "提交", triggers: [{ kind: "onStop" }] },
			{ text: "推送", triggers: [{ kind: "onStop" }] },
		],
		"重复与空白要在清洗时去掉",
	);
	assert.deepEqual(plain(readConfig(configPath).items), plain(result.snapshot.items));
	assert.equal(result.snapshot.seeded, false, "保存后的回读应来自文件本身");
});

test("store：save 拒绝结构但保留文件——非法输入不落盘", async () => {
	const { store, configPath } = makeStore({ fileContent: JSON.stringify({ version: 1, items: [{ text: "已有", triggers: [{ kind: "onStop" }] }] }) });
	const result = await store.save("不是数组");
	assert.equal(result.ok, true, "清洗层把非数组输入当空清单处理，仍是合法保存");
	assert.deepEqual(plain(readConfig(configPath).items), [], "清洗结果为空数组会覆盖原文件——渲染层必须传规则数组");
});
