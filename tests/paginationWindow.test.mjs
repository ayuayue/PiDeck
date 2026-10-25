import { test } from "node:test";
import assert from "node:assert/strict";
import { paginationWindow } from "../src/renderer/src/utils/pagination.ts";

test("paginationWindow: 总页数较少时返回完整序列，无省略号", () => {
	assert.deepEqual(paginationWindow(1, 5), [1, 2, 3, 4, 5]);
	assert.deepEqual(paginationWindow(3, 7), [1, 2, 3, 4, 5, 6, 7]);
});

test("paginationWindow: 中间页保留前后各 2 页，首尾常驻，缺口用省略号", () => {
	// 当前页 10/20：窗口 8-12，前后各一个省略号
	assert.deepEqual(paginationWindow(10, 20), [1, "ellipsis-start", 8, 9, 10, 11, 12, "ellipsis-end", 20]);
});

test("paginationWindow: 靠前时仅尾部省略号，靠后时仅头部省略号", () => {
	// 当前页 3/20：窗口 1-5，尾部省略
	assert.deepEqual(paginationWindow(3, 20), [1, 2, 3, 4, 5, "ellipsis-end", 20]);
	// 当前页 19/20：窗口 17-20，头部省略
	assert.deepEqual(paginationWindow(19, 20), [1, "ellipsis-start", 17, 18, 19, 20]);
});

test("paginationWindow: 首页/尾页即当前页时窗口贴合", () => {
	assert.deepEqual(paginationWindow(1, 20), [1, 2, 3, "ellipsis-end", 20]);
	assert.deepEqual(paginationWindow(20, 20), [1, "ellipsis-start", 18, 19, 20]);
});

test("paginationWindow: 越界页码收敛，总页数 ≤ 0 视为 1 页", () => {
	assert.deepEqual(paginationWindow(0, 10), [1, 2, 3, "ellipsis-end", 10]);
	assert.deepEqual(paginationWindow(99, 10), [1, "ellipsis-start", 8, 9, 10]);
	assert.deepEqual(paginationWindow(5, 0), [1]);
});

test("paginationWindow: 自定义 sibling", () => {
	assert.deepEqual(paginationWindow(10, 50, 1), [1, "ellipsis-start", 9, 10, 11, "ellipsis-end", 50]);
});
