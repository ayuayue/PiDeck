import { it } from "node:test";
import assert from "node:assert/strict";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 通知历史启动回灌（hydrateNoticeHistoryFromDisk）行为断言。
 * 落盘历史由主进程返回（无渲染层自增 id），hydrate 负责重新编号并替换内存缓冲。
 */
function loadNoticeHistory() {
	// window 注入 undefined：模块的落盘推送（window?.piDesktop）在沙箱里必须安全短路
	return createTsSandbox({ globals: { window: undefined } })("src/renderer/src/utils/noticeHistory.ts");
}

it("hydrate 用落盘历史替换内存缓冲并接续自增编号", () => {
	const { hydrateNoticeHistoryFromDisk, recordNoticeHistory, getNoticeHistorySnapshot, subscribeNoticeHistory } = loadNoticeHistory();

	let notified = 0;
	const unsubscribe = subscribeNoticeHistory(() => {
		notified += 1;
	});

	hydrateNoticeHistoryFromDisk([
		{ timestamp: 100, kind: "info", title: "旧通知一", duration: 6000 },
		{ timestamp: 200, kind: "error", title: "旧通知二", description: "详情", duration: Number.POSITIVE_INFINITY },
	]);

	const entries = getNoticeHistorySnapshot();
	assert.equal(entries.length, 2);
	assert.equal(entries[0].id, 1, "落盘条目由 hydrate 重新编号");
	assert.equal(entries[1].id, 2);
	assert.equal(entries[1].duration, Number.POSITIVE_INFINITY, "主进程解码后的常驻时长原样保留");
	assert.equal(notified, 1, "hydrate 应通知订阅者刷新表格");

	// 回灌后新记录接续编号，不与磁盘条目冲突
	recordNoticeHistory({ title: "新通知", kind: "warning", duration: 1000 });
	const after = getNoticeHistorySnapshot();
	assert.equal(after.length, 3);
	assert.equal(after[2].id, 3);
	assert.equal(after[2].title, "新通知");

	unsubscribe();
});

it("hydrate 清空旧内存：从有记录状态回灌为磁盘内容", () => {
	const { hydrateNoticeHistoryFromDisk, recordNoticeHistory, getNoticeHistorySnapshot } = loadNoticeHistory();

	recordNoticeHistory({ title: "启动前弹出", kind: "info", duration: 1000 });
	assert.equal(getNoticeHistorySnapshot().length, 1);

	hydrateNoticeHistoryFromDisk([{ timestamp: 1, kind: "info", title: "磁盘历史", duration: 1000 }]);
	assert.deepEqual(
		getNoticeHistorySnapshot().map((entry) => entry.title),
		["磁盘历史"],
		"挂载时刻内存为空是前提，回灌直接替换",
	);
});

it("hydrate 空数组等价于清空内存缓冲", () => {
	const { hydrateNoticeHistoryFromDisk, getNoticeHistorySnapshot } = loadNoticeHistory();

	hydrateNoticeHistoryFromDisk([]);
	assert.equal(getNoticeHistorySnapshot().length, 0);
});
