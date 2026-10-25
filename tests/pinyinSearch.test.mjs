// 渲染层拼音检索（侧栏「搜索会话」）：键生成、分级打分、查询闸。
//
// 与 file-index sidecar 的一致性由这里守着：表由 go-pinyin 生成，分数逐值对齐
// native/file-index/fuzzy.go 的 scoreNamePinyin*（700/680/640/560）。两边漂移的话
// 同一个查询在文件搜索与会话搜索里会有不同结果。
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { pinyinKeys, ensurePinyinTable, matchPinyin, matchPinyinText, isPinyinQuery, PINYIN_SCORES } = loadTsCommonJs("src/renderer/src/utils/pinyinSearch.ts");
// 字典已改为按需装载（不进启动 chunk）：同步契约只在表就绪后成立，测试先装载再断言。
await ensurePinyinTable();
const SEP = "\u0000";

test("pinyinKeys 逐字给首字母集合与默认全拼", () => {
	const keys = pinyinKeys("用量查询");
	assert.ok(keys, "含汉字的标题应当有拼音键");
	// 查 有 cha/zha/chai 三个读音，去重后首字母是 c、z —— 与 Go 侧 pinyinKeys 同口径。
	assert.equal(keys.initials, ["y", "l", "cz", "x"].join(SEP));
	assert.equal(keys.full, "yongliangchaxun");
});

test("首字母集合含异读：重庆既能用 cq 也能用 zq 命中", () => {
	const keys = pinyinKeys("重庆");
	assert.ok(keys);
	const groups = keys.initials.split(SEP);
	assert.ok(groups[0].includes("c") && groups[0].includes("z"), `首字应当同时有 c 与 z，实际 ${groups[0]}`);
	assert.ok(matchPinyin(keys, "cq") > 0);
	assert.ok(matchPinyin(keys, "zq") > 0);
	// 全拼只存默认读音：zhongqing 命中，chongqing 不命中（字典取舍，见模块注释）。
	assert.ok(matchPinyin(keys, "zhongqing") > 0);
	assert.equal(matchPinyin(keys, "chongqing"), 0);
});

test("分级分数与 Go 侧逐值一致：整名 > 前缀 > 全拼 > 跳字", () => {
	assert.deepEqual({ ...PINYIN_SCORES }, { exact: 700, prefix: 680, full: 640, skip: 560 });
	const keys = pinyinKeys("用量查询");
	assert.ok(keys);
	assert.equal(matchPinyin(keys, "ylcx"), PINYIN_SCORES.exact);
	assert.equal(matchPinyin(keys, "ylc"), PINYIN_SCORES.prefix);
	assert.equal(matchPinyin(keys, "yongliang"), PINYIN_SCORES.full);
	// 跳字：跨过「用」直接拿「量查」，召回优先、分数最低。
	assert.equal(matchPinyin(keys, "lcx"), PINYIN_SCORES.skip);
	assert.equal(matchPinyin(keys, "zzzz"), 0);
});

test("只有纯小写字母、长度 2..24 的查询走拼音通道", () => {
	assert.equal(isPinyinQuery("ylcx"), true);
	assert.equal(isPinyinQuery("y"), false, "单字母会命中过多，不走拼音");
	assert.equal(isPinyinQuery("用量"), false);
	assert.equal(isPinyinQuery("main.go"), false);
	assert.equal(isPinyinQuery("MORPH"), false, "大写由调用方先 toLowerCase，这里只认小写");
	assert.equal(isPinyinQuery("a".repeat(25)), false);
	assert.equal(matchPinyinText("用量查询", "用量"), 0, "中文查询照旧走子串匹配");
	assert.equal(matchPinyinText("用量查询", "YL"), 0);
});

test("纯 ASCII 标题没有拼音键；键按标题缓存（同一对象）", () => {
	assert.equal(pinyinKeys("pi-desktop-dev"), null);
	assert.equal(pinyinKeys(""), null);
	const first = pinyinKeys("用量查询");
	const second = pinyinKeys("用量查询");
	assert.equal(first, second, "同一个标题必须复用缓存对象，列表每次渲染都会重算");
});

test("生成表本身完整：字符与条目一一对应，关键映射未漂移", () => {
	// 直接读生成物，防止有人手改表或忘记重跑 gen:pinyin-table。
	const { PINYIN_CHARS, PINYIN_ENTRIES } = loadTsCommonJs("src/renderer/src/utils/pinyinTable.ts");
	const rows = PINYIN_ENTRIES.split("\n");
	assert.equal(PINYIN_CHARS.length, rows.length, "PINYIN_CHARS 与 PINYIN_ENTRIES 必须同序同长");
	assert.ok(PINYIN_CHARS.length > 26000, `条目数量级不对：${PINYIN_CHARS.length}`);
	const probe = (char) => {
		const index = PINYIN_CHARS.indexOf(char);
		assert.ok(index >= 0, `表里缺少常用字 ${char}`);
		return rows[index].split("\t");
	};
	const [zhongInitials, zhongFull] = probe("中");
	assert.ok(zhongInitials.includes("z") && zhongFull === "zhong");
	const [yongInitials, yongFull] = probe("用");
	assert.ok(yongInitials.includes("y") && yongFull === "yong");
	const [chaInitials, chaFull] = probe("查");
	assert.ok(chaInitials.includes("c") && chaFull === "cha");
});
