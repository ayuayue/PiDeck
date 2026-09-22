import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { IMPORT_LIST_PAGE_SIZE, buildImportSearchHaystack, formatImportSearchTime, growImportListWindow, matchesImportQuery, normalizeImportQuery, resolveImportListWindow, toggleSelectedPaths } = loadTsCommonJs("src/renderer/src/utils/importSessionList.ts");

/** VM 里创建的对象/数组与测试上下文不同源，strict deepEqual 会因原型不同而失败，先归一化成纯数据。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("normalizeImportQuery 去首尾空白并小写化", () => {
	assert.equal(normalizeImportQuery("  Fix Login  "), "fix login");
	assert.equal(normalizeImportQuery(""), "");
	assert.equal(normalizeImportQuery("修复登录"), "修复登录");
});

test("matchesImportQuery 空关键字恒命中，多关键字按 AND 匹配", () => {
	const haystack = buildImportSearchHaystack(["Refactor auth flow", "D:/work/app", "2026-09-21 10:30"]);
	assert.equal(matchesImportQuery(haystack, ""), true);
	assert.equal(matchesImportQuery(haystack, "auth"), true);
	// 跨字段的 AND：关键字分别命中标题与日期，验证「分词 + 全字段索引」的组合行为。
	assert.equal(matchesImportQuery(haystack, "auth 2026-09"), true);
	assert.equal(matchesImportQuery(haystack, "auth 2025-01"), false);
	assert.equal(matchesImportQuery(haystack, "missing"), false);
	// 索引自带小写语义：调用方传小写关键字即可大小写不敏感。
	assert.equal(matchesImportQuery(haystack, "REFACTOR"), false);
	assert.equal(matchesImportQuery(haystack, "refactor"), true);
});

test("buildImportSearchHaystack 跳过空值并拼成小写索引", () => {
	assert.equal(buildImportSearchHaystack([undefined, null, "", "Title", 3]), "title\n3");
});

test("formatImportSearchTime 输出本地 YYYY-MM-DD HH:mm，非法值返回空串", () => {
	assert.equal(formatImportSearchTime(undefined), "");
	assert.equal(formatImportSearchTime(0), "");
	assert.equal(formatImportSearchTime(Number.NaN), "");
	const stamp = new Date(2026, 8, 21, 9, 5).getTime();
	assert.equal(formatImportSearchTime(stamp), "2026-09-21 09:05");
});

test("toggleSelectedPaths 空目标不清空已有勾选", () => {
	assert.deepEqual(plain(toggleSelectedPaths(["a", "b"], [])), ["a", "b"]);
});

test("toggleSelectedPaths 目标全选中时只移除目标，保留筛选外的勾选", () => {
	assert.deepEqual(plain(toggleSelectedPaths(["a", "b", "c"], ["b", "c"])), ["a"]);
});

test("toggleSelectedPaths 部分选中时补齐目标，不清空筛选外的勾选", () => {
	assert.deepEqual(plain(toggleSelectedPaths(["a", "b"], ["b", "c"])), ["a", "b", "c"]);
});

test("toggleSelectedPaths 在大规模选择下保持去重与子集语义", () => {
	// 5000 行是控制器可能拿到的量级：全选 → 再取消前一半，验证集合运算没有重复项。
	const all = Array.from({ length: 5000 }, (_, index) => `p${index}`);
	const selectedAll = toggleSelectedPaths([], all);
	assert.equal(selectedAll.length, 5000);
	const half = toggleSelectedPaths(selectedAll, all.slice(0, 2500));
	assert.equal(half.length, 2500);
	assert.equal(new Set(half).size, 2500);
});

test("首屏窗口行数保持在小批量区间", () => {
	assert.equal(IMPORT_LIST_PAGE_SIZE > 0 && IMPORT_LIST_PAGE_SIZE <= 100, true);
});

test("resolveImportListWindow 数据源变化时回到首屏窗口", () => {
	const page = IMPORT_LIST_PAGE_SIZE;
	const first = [{ id: 1 }, { id: 2 }];
	const window = { source: first, count: page * 3 };
	// 同一数据源：保持引用稳定，避免下游 memo 白跑。
	assert.equal(resolveImportListWindow(window, first, page), window);
	const second = [{ id: 3 }];
	const reset = resolveImportListWindow(window, second, page);
	assert.equal(reset.source, second);
	assert.equal(reset.count, page);
});

test("growImportListWindow 每批追加一页并在数据取完时收敛", () => {
	const page = 40;
	const source = new Array(100).fill(null);
	const window = { source, count: page };
	const grown = growImportListWindow(window, source.length, page);
	assert.equal(grown.count, 80);
	// 最后一批按剩余条数截断，避免「已显示 120 / 100」这类越界文案。
	assert.equal(growImportListWindow(grown, source.length, page).count, 100);
	// 已经渲染完：返回原引用，避免无意义的重渲染。
	const done = growImportListWindow(grown, source.length, page);
	assert.equal(growImportListWindow(done, source.length, page), done);
	assert.equal(growImportListWindow({ source: [], count: page }, 0, page).count, page);
});
