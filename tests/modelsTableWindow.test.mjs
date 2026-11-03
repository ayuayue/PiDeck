import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { MODEL_TABLE_INITIAL_VISIBLE_ROWS, MODEL_TABLE_LOAD_MORE_STEP, resolveModelTableVisibleRowCount } = loadTsCommonJs("src/renderer/src/config/modelsUtils.ts");

/**
 * 模型表渐进渲染窗口。每行是「4 输入框 + Popover + 2 Dialog + 操作按钮」的重树，
 * 窗口必须小于单个供应商的典型行数（几十行），否则展开即全量挂载、点一下就卡。
 */

test("默认窗口 20 行，继续加载按步长递增", () => {
	assert.equal(MODEL_TABLE_INITIAL_VISIBLE_ROWS, 20);
	assert.equal(MODEL_TABLE_LOAD_MORE_STEP, 20);
	// 窗口只做前缀切片：行数超过窗口时按当前 state 截断
	assert.equal(resolveModelTableVisibleRowCount(300, MODEL_TABLE_INITIAL_VISIBLE_ROWS, -1), 20);
	assert.equal(resolveModelTableVisibleRowCount(300, 40, -1), 40);
	// 56 行的供应商（真实量级）展开时只挂 20 行，其余走「继续加载」
	assert.equal(resolveModelTableVisibleRowCount(56, MODEL_TABLE_INITIAL_VISIBLE_ROWS, -1), 20);
});

test("不超过窗口的列表全量展示，不出现「继续加载」", () => {
	assert.equal(resolveModelTableVisibleRowCount(20, MODEL_TABLE_INITIAL_VISIBLE_ROWS, -1), 20);
	assert.equal(resolveModelTableVisibleRowCount(3, MODEL_TABLE_INITIAL_VISIBLE_ROWS, -1), 3);
});

test("聚焦目标行落在窗口外时扩窗到该行（新增行在表尾）", () => {
	// 手动新增：21 个模型中新增行在 index 20（窗口外），窗口必须扩到看得见它
	assert.equal(resolveModelTableVisibleRowCount(21, MODEL_TABLE_INITIAL_VISIBLE_ROWS, 20), 21);
	// 聚焦目标在窗口内时窗口不变
	assert.equal(resolveModelTableVisibleRowCount(151, MODEL_TABLE_INITIAL_VISIBLE_ROWS, 5), 20);
});

test("窗口结果始终夹在 [0, total] 内，模型变少时不越界", () => {
	assert.equal(resolveModelTableVisibleRowCount(5, 100, -1), 5);
	assert.equal(resolveModelTableVisibleRowCount(0, 100, -1), 0);
	// 聚焦目标超过总数（聚焦键滞后于删除）也不越界
	assert.equal(resolveModelTableVisibleRowCount(50, 100, 120), 50);
});
