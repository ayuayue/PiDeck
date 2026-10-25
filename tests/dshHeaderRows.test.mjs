import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createDshHeaderRows, updateDshHeaderRow, serializeDshHeaderRows } = loadTsCommonJs("src/renderer/src/config/dshHeaderRows.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

// 行身份必须独立于可编辑的 header 名，否则每敲一个字符都会 remount 并丢失焦点。
test("编辑 header 名和值不改变行 ID、顺序或其它行", () => {
	const rows = createDshHeaderRows({ "X-One": "one", "X-Two": "two" });
	rows.forEach(Object.freeze);
	Object.freeze(rows);
	const renamed = updateDshHeaderRow(rows, rows[0].id, { name: "X-Renamed" });
	const updated = updateDshHeaderRow(renamed, rows[0].id, { value: "new" });
	assert.equal(updated[0].id, rows[0].id);
	assert.equal(updated[1], rows[1]);
	assert.equal(rows[0].name, "X-One");
	assert.deepEqual(plain(serializeDshHeaderRows(updated)), { "X-Renamed": "new", "X-Two": "two" });
});

test("空白 header 名只是编辑中草稿，不写入配置；命名后保留空值", () => {
	const rows = createDshHeaderRows({ "X-One": "one" });
	const blank = updateDshHeaderRow(rows, rows[0].id, { name: "  " });
	assert.equal(blank.length, 1);
	assert.equal(serializeDshHeaderRows(blank), undefined);
	const named = updateDshHeaderRow(blank, rows[0].id, { name: " x-opencode-session ", value: "" });
	assert.deepEqual(plain(serializeDshHeaderRows(named)), { "x-opencode-session": "" });
});

test("HTTP 头大小写不敏感，重复名最后一行优先且值不被 trim", () => {
	const rows = createDshHeaderRows({ "X-OpenCode-Client": "first", "x-opencode-client": " last " });
	assert.deepEqual(plain(serializeDshHeaderRows(rows)), { "x-opencode-client": " last " });
});

test("读取旧配置保留 UA 和未知头，空配置不插入固定 session 值", () => {
	const rows = createDshHeaderRows({ "User-Agent": "legacy-ua", "X-Other": "keep" });
	assert.deepEqual(plain(serializeDshHeaderRows(rows)), { "User-Agent": "legacy-ua", "X-Other": "keep" });
	assert.notEqual(rows[0].id, rows[1].id);
	for (const value of [undefined, null, {}, { " ": "value", invalid: 42 }]) {
		assert.equal(createDshHeaderRows(value).length, 0);
		assert.equal(serializeDshHeaderRows(createDshHeaderRows(value)), undefined);
	}
});

test("删除所有行清空 headers，不影响剩余行的身份", () => {
	const rows = createDshHeaderRows({ "X-One": "one", "X-Two": "two" });
	const remaining = rows.filter((row) => row.id !== rows[0].id);
	assert.equal(remaining[0], rows[1]);
	assert.deepEqual(plain(serializeDshHeaderRows(remaining)), { "X-Two": "two" });
	assert.equal(serializeDshHeaderRows([]), undefined);
});

test("特殊对象属性名仍然按普通请求头序列化", () => {
	const rows = createDshHeaderRows(JSON.parse('{"__proto__":"header-value","constructor":"constructor-value"}'));
	assert.deepEqual(plain(serializeDshHeaderRows(rows)), JSON.parse('{"__proto__":"header-value","constructor":"constructor-value"}'));
});
