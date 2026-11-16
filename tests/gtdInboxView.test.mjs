import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * #546 阶段 2：活动行的分桶（组顺序、空桶省略、未读标记）与视图模式读取。
 */
const { GTD_ROW_DRAG_MIME, GTD_SNOOZE_DEFAULT_MS, bucketGtdRows, gtdDropIntent, readGtdMode, shouldHandleGtdUndoKey, undoSettleTarget, writeGtdMode } = loadTsCommonJs("src/renderer/src/components/sidebar/gtdInboxModel.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const NOW = 1_760_000_000_000;

function rowsOf(meta) {
	return meta.map((entry) => ({ ...entry }));
}

test("按桶优先级归组，空桶不输出，桶内保持输入顺序", () => {
	const rows = rowsOf([
		{ sessionId: "a", status: "idle" },
		{ sessionId: "b", status: "running" },
		{ sessionId: "c", status: "idle", pendingInteraction: true },
		{ sessionId: "d", status: "running" },
	]);
	const groups = bucketGtdRows({
		rows,
		describe: (row) => row,
		ledger: {},
		pinned: new Set(),
		now: NOW,
	});
	assert.deepEqual(plain(groups.map((group) => [group.bucket, group.rows.map((entry) => entry.row.sessionId)])), [
		["needs-you", ["c"]],
		["active", ["a"]],
		["working", ["b", "d"]],
	]);
});

test("needs-you 压过置顶；置顶压过 settled", () => {
	const groups = bucketGtdRows({
		rows: rowsOf([{ sessionId: "p", status: "idle", pinned: true, pendingInteraction: true }]),
		describe: (row) => row,
		ledger: {},
		pinned: new Set(["p"]),
		now: NOW,
	});
	assert.equal(groups[0].bucket, "needs-you");

	const pinnedSettled = bucketGtdRows({
		rows: rowsOf([{ sessionId: "q", status: "idle" }]),
		describe: (row) => row,
		ledger: { q: { settledAt: NOW - 10 } },
		pinned: new Set(["q"]),
		now: NOW,
	});
	assert.equal(pinnedSettled[0].bucket, "pinned");
});

test("未读：最近活动晚于最后一次查看；点开后不再未读", () => {
	const describe = (row) => row;
	const rows = rowsOf([{ sessionId: "a", status: "idle", lastActivityAt: 500 }]);
	const before = bucketGtdRows({ rows, describe, ledger: { a: { viewedAt: 400 } }, pinned: new Set(), now: NOW });
	assert.equal(before[0].rows[0].unread, true);
	const after = bucketGtdRows({ rows, describe, ledger: { a: { viewedAt: 500 } }, pinned: new Set(), now: NOW });
	assert.equal(after[0].rows[0].unread, false);
});

test("结清后出现更晚活动自动复活（回到 active 而不是 settled）", () => {
	const groups = bucketGtdRows({
		rows: rowsOf([{ sessionId: "a", status: "idle", lastActivityAt: 900 }]),
		describe: (row) => row,
		ledger: { a: { settledAt: 800 } },
		pinned: new Set(),
		now: NOW,
	});
	assert.equal(groups[0].bucket, "active");
});

test("视图模式：没有 localStorage 时默认传统视图，写入失败也不抛", () => {
	assert.equal(readGtdMode(), false);
	assert.doesNotThrow(() => writeGtdMode(true));
	assert.equal(readGtdMode(), false);
});

test("拖拽改桶：只有用户可决定的桶能接住，运行态桶返回 null", () => {
	assert.deepEqual(plain(gtdDropIntent("settled", NOW)), { settledAt: NOW });
	assert.deepEqual(plain(gtdDropIntent("active", NOW)), { settledAt: null, snoozeUntil: null });
	assert.deepEqual(plain(gtdDropIntent("snoozed", NOW)), { snoozeUntil: NOW + GTD_SNOOZE_DEFAULT_MS });
	assert.equal(gtdDropIntent("needs-you", NOW), null);
	assert.equal(gtdDropIntent("working", NOW), null);
	assert.equal(gtdDropIntent("pinned", NOW), null);
	assert.equal(GTD_SNOOZE_DEFAULT_MS, 60 * 60 * 1000, "默认稍后提醒 1 小时");
	assert.equal(GTD_ROW_DRAG_MIME.includes("gtd"), true, "与分屏拖拽的 MIME 区分");
});

test("5 秒内可撤销；超时不再命中", () => {
	assert.equal(undoSettleTarget({ sessionId: "s1", at: NOW }, NOW + 4999), "s1");
	assert.equal(undoSettleTarget({ sessionId: "s1", at: NOW }, NOW + 5000), "s1");
	assert.equal(undoSettleTarget({ sessionId: "s1", at: NOW }, NOW + 5001), undefined);
	assert.equal(undoSettleTarget(null, NOW), undefined);
});

test("Ctrl/Cmd+Z 只在非输入区接管", () => {
	const base = { key: "z", ctrlKey: true, metaKey: false };
	assert.equal(shouldHandleGtdUndoKey(base), true);
	assert.equal(shouldHandleGtdUndoKey({ ...base, ctrlKey: false, metaKey: true }), true);
	assert.equal(shouldHandleGtdUndoKey({ ...base, key: "Z" }), true);
	assert.equal(shouldHandleGtdUndoKey({ ...base, ctrlKey: false }), false, "不带修饰键的 z 是输入");
	assert.equal(shouldHandleGtdUndoKey({ ...base, targetTagName: "INPUT" }), false, "输入框撤销留给浏览器");
	assert.equal(shouldHandleGtdUndoKey({ ...base, targetTagName: "TEXTAREA" }), false);
	assert.equal(shouldHandleGtdUndoKey({ ...base, targetEditable: true }), false, "contenteditable 同理");
});
