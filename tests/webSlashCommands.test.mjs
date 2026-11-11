/**
 * Web 输入框斜杠命令（纯函数）。
 *
 * 守的行为：
 * - 只在行首/空白后的 `/` 开菜单（`a/b`、`https://x` 不算）；
 * - 候选排序：前缀命中优先，其余保持权威命令表顺序，数量有上限；
 * - 选中只替换 token，光标后已写的正文不丢；
 * - 草稿会话的本地发现按 pi 的真实调用形态生成（模板 `/名`，技能 `/skill:名`）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/* 生产模块在 vm 沙箱里创建的对象/数组属于另一个 realm：深度比较前转成本 realm 的普通值。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

const { WEB_SLASH_MAX_ITEMS, detectWebSlashToken, filterWebSlashItems, applyWebSlashItem, mergeWebSlashItems, slashItemsFromCommands, slashItemsFromResources } = loadTsCommonJs("src/renderer/src/web/webSlashCommands.ts");

test("detectWebSlashToken：行首与空白后的 / 都算命令起始", () => {
	assert.deepEqual(plain(detectWebSlashToken("/", 1)), { start: 0, query: "" });
	assert.deepEqual(plain(detectWebSlashToken("/com", 4)), { start: 0, query: "com" });
	assert.deepEqual(plain(detectWebSlashToken("帮我看看 /comp", 10)), { start: 5, query: "comp" }, "光标前的最后一个 / 才是 token 起点");
	assert.deepEqual(plain(detectWebSlashToken("第一行\n/compact", 17)), { start: 4, query: "compact" });
	// 光标在 token 中间：只按光标前的内容算 query
	assert.deepEqual(plain(detectWebSlashToken("/compact", 4)), { start: 0, query: "com" });
});

test("detectWebSlashToken：正文里的斜杠不开菜单", () => {
	assert.equal(detectWebSlashToken("a/b", 3), null, "紧贴字母的 / 是路径/正文");
	assert.equal(detectWebSlashToken("https://example.com", 19), null);
	assert.equal(detectWebSlashToken("/com pact", 9), null, "query 出现空白即视为正文");
	assert.equal(detectWebSlashToken("看看这个/那段", 7), null);
	assert.equal(detectWebSlashToken("没有斜杠", 4), null);
});

test("filterWebSlashItems：前缀优先、其余按原顺序、空关键字全列", () => {
	const items = [
		{ name: "review", description: "" },
		{ name: "compact", description: "" },
		{ name: "pre-review", description: "" },
		{ name: "skill:compact-hints", description: "" },
	];
	assert.deepEqual(
		filterWebSlashItems(items, "comp").map((item) => item.name),
		["compact", "skill:compact-hints"],
		"前缀命中排在子串命中前",
	);
	assert.deepEqual(
		filterWebSlashItems(items, "review").map((item) => item.name),
		["review", "pre-review"],
	);
	assert.deepEqual(
		filterWebSlashItems(items, "").map((item) => item.name),
		items.map((item) => item.name),
		"空关键字保持权威命令表顺序（扩展 → 提示词 → 技能）",
	);
	assert.deepEqual(plain(filterWebSlashItems(items, "zzz")), []);
});

test("filterWebSlashItems：候选数量有上限", () => {
	const many = Array.from({ length: WEB_SLASH_MAX_ITEMS + 15 }, (_, index) => ({ name: `cmd-${index}`, description: "" }));
	assert.equal(filterWebSlashItems(many, "cmd").length, WEB_SLASH_MAX_ITEMS);
});

test("applyWebSlashItem：替换 token、保留光标后正文、光标落在插入文本末尾", () => {
	const result = applyWebSlashItem("/com 你好", 4, "compact");
	assert.equal(result.text, "/compact  你好");
	assert.equal(result.caret, "/compact ".length);
	// 无 token 时插在光标处，而不是拼到文末
	const noToken = applyWebSlashItem("前缀正文", 2, "new");
	assert.equal(noToken.text, "前缀/new 正文");
	assert.equal(noToken.caret, "前缀/new ".length);
});

test("mergeWebSlashItems：同名去重，先到的更权威（运行时命令表 > 本地发现）", () => {
	const merged = mergeWebSlashItems([
		[
			{ name: "compact", description: "runtime" },
			{ name: "review", description: "runtime" },
		],
		[
			{ name: "Compact", description: "local" },
			{ name: "skill:review", description: "local" },
		],
	]);
	assert.deepEqual(
		[...merged].map((item) => item.name),
		["compact", "review", "skill:review"],
		"大小写不同的同名也去重",
	);
	assert.equal(merged[0].description, "runtime");
});

test("slashItemsFromCommands：沿用运行时的 source，忽略空名", () => {
	const items = slashItemsFromCommands([
		{ name: " reload ", description: "hot reload", source: "extension" },
		{ name: "my-template", description: "", source: "prompt" },
		{ name: "skill:fmt", description: "format", source: "skill" },
		{ name: "  ", source: "skill" },
	]);
	assert.deepEqual(
		[...items].map((item) => [item.name, item.source]),
		[
			["reload", "extension"],
			["my-template", "prompt"],
			["skill:fmt", "skill"],
		],
	);
	assert.equal(items[0].description, "hot reload");
});

test("slashItemsFromResources：模板按名调用、技能加 skill: 前缀、禁用的不列", () => {
	const items = slashItemsFromResources(
		[
			{ name: "translate", description: "翻成中文" },
			{ name: "off-prompt", description: "", enabled: false },
		],
		[
			{ name: "fmt", description: "格式化" },
			{ name: "off-skill", description: "", enabled: false },
		],
	);
	assert.deepEqual(
		[...items].map((item) => [item.name, item.source]),
		[
			["translate", "prompt"],
			["skill:fmt", "skill"],
		],
	);
});
