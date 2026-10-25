/**
 * 扩展输出条目（appendEntry）data 载荷的展示格式化（issue #285）。
 * 载荷形状由扩展自由决定（字符串/记录/数组/嵌套），这里锁定格式化契约：
 * - 裸字符串 → 单个无标签字段（保留换行）
 * - 记录 → 按 key 顺序成行；字符串/数字/布尔直出，嵌套 JSON 缩进展示
 * - 数组与其它原始值 → 整体 JSON；超长值截断带省略号
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { formatExtensionEntryFields, EXTENSION_ENTRY_FIELD_VALUE_MAX } = loadTsCommonJs("src/renderer/src/components/session/extensionEntry.ts");

// 模块经 vm 加载，返回的数组/对象来自沙箱 realm（prototype 不同），
// deepEqual 前先展开成宿主对象（同 sessionNotifyCards 的 outline 处理）。
function hostCopy(fields) {
	return [...fields].map((field) => ({ ...field }));
}

test("裸字符串载荷 → 单个无标签字段，保留换行", () => {
	assert.deepEqual(hostCopy(formatExtensionEntryFields("第一行\n第二行")), [{ key: "", value: "第一行\n第二行" }]);
});

test("undefined / 空字符串 / 空记录 → 无字段（卡片只显示标题行）", () => {
	assert.deepEqual(hostCopy(formatExtensionEntryFields(undefined)), []);
	assert.deepEqual(hostCopy(formatExtensionEntryFields("")), []);
	assert.deepEqual(hostCopy(formatExtensionEntryFields({})), []);
});

test("记录载荷按 key 顺序成行：字符串、数字、布尔直出", () => {
	const fields = hostCopy(formatExtensionEntryFields({ query: "看下迁移进度", depth: "brief", retries: 2, pinned: false }));
	assert.deepEqual(fields, [
		{ key: "query", value: "看下迁移进度" },
		{ key: "depth", value: "brief" },
		{ key: "retries", value: "2" },
		{ key: "pinned", value: "false" },
	]);
});

test("嵌套对象/数组值 JSON 缩进展示，null 字段跳过", () => {
	const fields = formatExtensionEntryFields({ context: { a: 1 }, tags: ["x", "y"], gone: null });
	assert.equal(fields.length, 2);
	assert.equal(fields[0].key, "context");
	assert.equal(fields[0].value.includes('\n\t"a": 1'), true);
	assert.deepEqual(JSON.parse(fields[1].value), ["x", "y"]);
});

test("数组载荷整体 JSON 展示为单个无标签字段", () => {
	const fields = formatExtensionEntryFields([1, "two"]);
	assert.equal(fields.length, 1);
	assert.equal(fields[0].key, "");
	assert.deepEqual(JSON.parse(fields[0].value), [1, "two"]);
});

test("超长值在上限处截断并标注省略号", () => {
	const long = "x".repeat(EXTENSION_ENTRY_FIELD_VALUE_MAX + 100);
	const fields = formatExtensionEntryFields({ blob: long });
	assert.equal(fields[0].value.length, EXTENSION_ENTRY_FIELD_VALUE_MAX + 1);
	assert.ok(fields[0].value.endsWith("…"));
});
