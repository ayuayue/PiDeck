/**
 * 拼音字典按需装载（不进启动 chunk）的语义守护。
 *
 * 背景：pinyinTable.ts 是 go-pinyin 抽出的 26k 条字典（生成物），原先被 pinyinSearch
 * 静态 import → 随启动 chunk 一起解析并常驻堆，不用搜索的会话白付这份成本。改为
 * ensurePinyinTable() 动态 import 后有两个易错点必须钉住：
 *   1. 表未就绪时 pinyinKeys 必须返回 null 且**不写缓存**——否则「还没加载」会被错记成
 *      「该标题没有汉字」，永久污染这个标题的键，装载完成后也救不回来；
 *   2. pinyinSearch 不得再静态 import 字典模块，否则 chunk 拆分静默失效（功能照常，
 *      只是启动又变慢——最难发现的那类回归）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("表未就绪：pinyinKeys 返回 null，且不把「空结果」写进缓存", async () => {
	// 独立加载一份模块实例（同一进程内其它测试可能已装载过表，那会掩盖未就绪分支）
	const fresh = loadTsCommonJs("src/renderer/src/utils/pinyinSearch.ts");
	assert.equal(fresh.pinyinKeys("重庆"), null, "表未装载时必须返回 null（而不是空键）");

	await fresh.ensurePinyinTable();
	const keys = fresh.pinyinKeys("重庆");
	assert.ok(keys, "装载完成后必须产出真实键");
	// 异读首字母不漏：重 → ctz，所以 cq 与 zq 都该命中
	assert.ok(keys.initials.includes("c"), "首字母应含 c（chong）");
	assert.ok(keys.initials.includes("z"), "首字母应含 z（zhong）");
	assert.ok(keys.full.includes("chongqing") === false, "全拼只取默认读音（zhong），不覆盖异读");
});

test("装载后同一标题重复取键走缓存（对象同一性）", async () => {
	const mod = loadTsCommonJs("src/renderer/src/utils/pinyinSearch.ts");
	await mod.ensurePinyinTable();
	const first = mod.pinyinKeys("设置页搜索");
	const second = mod.pinyinKeys("设置页搜索");
	assert.equal(first, second, "键按标题缓存，重复渲染不应二次拆字");
});

test("单飞：并发 ensurePinyinTable 共享同一次装载", async () => {
	const mod = loadTsCommonJs("src/renderer/src/utils/pinyinSearch.ts");
	const [a, b, c] = await Promise.all([mod.ensurePinyinTable(), mod.ensurePinyinTable(), mod.ensurePinyinTable()]);
	assert.equal(a, b);
	assert.equal(b, c);
	assert.ok(a.size > 1000, "装载的是整份字典");
});

test("源码契约：pinyinSearch 不得静态 import 字典模块（否则进启动 chunk）", () => {
	const source = readFileSync("src/renderer/src/utils/pinyinSearch.ts", "utf8");
	assert.doesNotMatch(source, /^\s*import\s+(?!type)[^;]*from\s+"\.\/pinyinTable"/m, "字典必须走动态 import，静态 import 会让 26k 条随启动 chunk 解析");
	assert.match(source, /import\("\.\/pinyinTable"\)/, "按需装载入口必须存在");
});
