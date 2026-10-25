import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 设置页侧栏搜索的打分内核（`components/app/settings/settingsSearch.ts`）。
 *
 * 这里测的是「用户输入 → 结果顺序」这一层行为，不碰 React：中文名、英文别名、
 * 拼音首字母、多词 AND 都必须能搜到，且标题命中永远压过「关键词恰好含这几个字」。
 * e2e 负责验证接线（输入 → 切 tab → 滚到锚点），本文件只保证打分不会把该找的东西漏掉。
 */
// 拼音字典改为按需装载后，拼音通道只在表就绪后生效。settingsSearch 内部 require 的
// pinyinSearch 与这里单独加载的实例不共享状态（loadTsCommonJs 每次调用都是新模块图），
// 用 stubs 把已装载的实例注入，保证打分断言跑在真实字典上。
const pinyinModule = loadTsCommonJs("src/renderer/src/utils/pinyinSearch.ts");
await pinyinModule.ensurePinyinTable();

async function loadSearch() {
	return loadTsCommonJs("src/renderer/src/components/app/settings/settingsSearch.ts", {
		stubs: { "../../../utils/pinyinSearch": pinyinModule },
	});
}

const ENTRIES = [
	{ id: "tab:proxy", tab: "proxy", title: "代理", tabLabel: "代理", keywords: ["代理", "网络", "http proxy"] },
	{ id: "tab:terminal", tab: "terminal", title: "终端", tabLabel: "终端", keywords: ["终端", "shell"] },
	{ id: "field:terminal-font", tab: "terminal", section: "terminal-font", title: "终端字体", tabLabel: "终端", keywords: ["字体", "font"] },
	{ id: "field:usage-query", tab: "usage", section: "usage-probe", title: "用量查询", tabLabel: "用量统计", keywords: ["usage", "token"] },
	{ id: "field:font", tab: "appearance", section: "appearance-fonts", title: "字体", tabLabel: "外观设置", keywords: ["font"] },
	{ id: "field:git-sign", tab: "git", section: "git-sign", title: "提交签名", tabLabel: "Git", keywords: ["gpg", "commit sign"] },
];

const ORDER = ["common", "appearance", "terminal", "proxy", "git", "usage"];

function titles(hits) {
	return hits.map((hit) => hit.entry.title);
}

/** vm 沙箱里造出来的对象/数组来自另一个 realm：深比较前先转成本 realm 的普通值。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("Chinese title match wins over keyword-only match", async () => {
	const search = await loadSearch();
	const hits = search.searchSettingsEntries(ENTRIES, "终端", ORDER);
	// 标题就叫「终端」的 tab 排在「终端字体」前，且只靠关键词含「终端」的条目（无）不出现在前面
	assert.equal(hits[0].entry.id, "tab:terminal");
	assert.deepEqual(plain(titles(hits)), ["终端", "终端字体"]);
});

test("pinyin initials and full pinyin both reach Chinese titles", async () => {
	const search = await loadSearch();
	assert.deepEqual(plain(titles(search.searchSettingsEntries(ENTRIES, "ylcx", ORDER))), ["用量查询"]);
	assert.deepEqual(plain(titles(search.searchSettingsEntries(ENTRIES, "daili", ORDER))), ["代理"]);
	assert.deepEqual(plain(titles(search.searchSettingsEntries(ENTRIES, "zdt", ORDER))), ["终端字体"]);
});

test("English keywords are reachable case-insensitively", async () => {
	const search = await loadSearch();
	assert.deepEqual(plain(titles(search.searchSettingsEntries(ENTRIES, "GPG", ORDER))), ["提交签名"]);
	assert.deepEqual(plain(titles(search.searchSettingsEntries(ENTRIES, "http proxy", ORDER))), ["代理"]);
});

test("multiple tokens are AND-ed", async () => {
	const search = await loadSearch();
	assert.deepEqual(plain(titles(search.searchSettingsEntries(ENTRIES, "终端 字体", ORDER))), ["终端字体"]);
	assert.deepEqual(plain(titles(search.searchSettingsEntries(ENTRIES, "终端 git", ORDER))), []);
});

test("tab label brings the whole page in, below its own entries", async () => {
	const search = await loadSearch();
	const hits = search.searchSettingsEntries(ENTRIES, "用量统计", ORDER);
	// 「用量统计」是 tab 名，不是条目名；靠 tabLabel 通道命中，用来「进那一页找找」。
	assert.deepEqual(plain(titles(hits)), ["用量查询"]);
	assert.ok(hits[0].score < 500, "tab-label channel must stay below title/keyword channels");
});

test("typing the whole name outranks a prefix of a longer name", async () => {
	const search = await loadSearch();
	// 「字体」整串相等命中 1000 分；「终端字体」只是包含命中 800 分
	assert.deepEqual(plain(titles(search.searchSettingsEntries(ENTRIES, "字体", ORDER))), ["字体", "终端字体"]);
	assert.deepEqual(plain(titles(search.searchSettingsEntries(ENTRIES, "终端字", ORDER))), ["终端字体"]);
});

test("blank query yields nothing and the limit is honoured", async () => {
	const search = await loadSearch();
	assert.deepEqual(plain(search.searchSettingsEntries(ENTRIES, "", ORDER)), []);
	assert.deepEqual(plain(search.searchSettingsEntries(ENTRIES, "   ", ORDER)), []);
	assert.equal(search.searchSettingsEntries(ENTRIES, "字", ORDER, 1).length, 1);
});

test("highlight segments follow the matched indices", async () => {
	const search = await loadSearch();
	assert.deepEqual(plain(search.splitHighlightedTitle("终端字体", [2, 3])), [
		{ text: "终端", hit: false },
		{ text: "字体", hit: true },
	]);
	assert.deepEqual(plain(search.splitHighlightedTitle("代理", [])), [{ text: "代理", hit: false }]);
});

test("every registered settings anchor is reachable from the sidebar search", () => {
	const builder = loadTsCommonJs("src/renderer/src/components/app/settings/settingsSearchEntries.ts");
	const anchors = loadTsCommonJs("src/renderer/src/utils/settingsFieldAnchors.ts").SETTINGS_FIELD_ANCHORS;
	// 用 key 当文案：本用例只关心「清单里的每条锚点都进了搜索条目」，不关心译文。
	const entries = builder.buildSettingsSearchEntries((key) => key);
	const fieldIds = new Set(entries.filter((entry) => entry.id.startsWith("field:")).map((entry) => entry.id));
	for (const anchor of anchors) {
		assert.ok(fieldIds.has(`field:${anchor.slug}`), `anchor ${anchor.slug} missing from settings search`);
	}
	// tab 级入口也要齐：侧栏搜「终端」这类页面名时必须能直接进页
	const tabIds = new Set(entries.filter((entry) => entry.id.startsWith("tab:")).map((entry) => entry.tab));
	const { SETTINGS_TAB_IDS } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsTabLayout.ts");
	for (const tab of SETTINGS_TAB_IDS) assert.ok(tabIds.has(tab), `tab ${tab} missing from settings search`);
});
