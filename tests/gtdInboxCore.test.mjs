import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * #546 阶段 1：分诊投影（状态机）+ 稀疏账本（只存人类意图水位）。
 */
const { projectGtdBucket, isGtdUnread } = loadTsCommonJs("src/shared/gtdProjection.ts");
const { GTD_BUCKET_ORDER, GTD_COLLAPSED_BUCKETS } = loadTsCommonJs("src/shared/types/gtd.ts");
const { GtdLedgerStore } = loadTsCommonJs("src/main/gtd/GtdLedger.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

const NOW = 1_760_000_000_000;

test("顺序即优先级：needs-you 压过置顶与结清", () => {
	assert.equal(projectGtdBucket({ status: "idle", pendingInteraction: true, pinned: true, state: { settledAt: NOW }, now: NOW }), "needs-you");
	assert.equal(projectGtdBucket({ status: "error", pinned: true, now: NOW }), "needs-you");
});

test("置顶压过 snooze 与 settled，但不压 needs-you", () => {
	assert.equal(projectGtdBucket({ status: "idle", pinned: true, state: { settledAt: NOW, snoozeUntil: NOW + 1000 }, now: NOW }), "pinned");
});

test("snooze 未到期 → snoozed；到期自动回 active", () => {
	assert.equal(projectGtdBucket({ status: "idle", state: { snoozeUntil: NOW + 1 }, now: NOW }), "snoozed");
	assert.equal(projectGtdBucket({ status: "idle", state: { snoozeUntil: NOW }, now: NOW }), "active");
});

test("结清后没有新活动 → settled；出现更晚活动自动复活", () => {
	assert.equal(projectGtdBucket({ status: "idle", state: { settledAt: 100 }, lastActivityAt: 100, now: NOW }), "settled");
	assert.equal(projectGtdBucket({ status: "idle", state: { settledAt: 100 }, lastActivityAt: 101, now: NOW }), "active");
	// 复活后运行中会话重新进 working，不需要额外「重新打开」
	assert.equal(projectGtdBucket({ status: "running", state: { settledAt: 100 }, lastActivityAt: 101, now: NOW }), "working");
});

test("运行中/启动中 → working；空闲 → active", () => {
	assert.equal(projectGtdBucket({ status: "running", now: NOW }), "working");
	assert.equal(projectGtdBucket({ status: "starting", now: NOW }), "working");
	assert.equal(projectGtdBucket({ status: "idle", now: NOW }), "active");
});

test("未读 = 最近活动晚于最后一次查看；从没看过也算未读", () => {
	assert.equal(isGtdUnread({ lastActivityAt: 200, viewedAt: 100 }), true);
	assert.equal(isGtdUnread({ lastActivityAt: 100, viewedAt: 100 }), false);
	assert.equal(isGtdUnread({ lastActivityAt: 100 }), true);
	assert.equal(isGtdUnread({}), false);
});

test("桶列表与折叠默认值稳定（UI 依赖顺序）", () => {
	assert.deepEqual([...GTD_BUCKET_ORDER], ["needs-you", "pinned", "active", "working", "snoozed", "settled"]);
	assert.deepEqual([...GTD_COLLAPSED_BUCKETS], ["working", "snoozed", "settled"]);
});

test("账本：补丁落盘、重新加载可读，null 清除水位", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gtd-ledger-"));
	try {
		const file = join(dir, "gtd-ledger.json");
		const store = new GtdLedgerStore(file);
		await store.patch("s1", { settledAt: 100, viewedAt: 90 });
		assert.deepEqual(plain(await store.snapshot()), { s1: { settledAt: 100, viewedAt: 90 } });

		// 模拟重启：新实例读同一份文件
		const reloaded = new GtdLedgerStore(file);
		assert.deepEqual(plain(await reloaded.snapshot()), { s1: { settledAt: 100, viewedAt: 90 } });

		// null = 撤销结清；其它字段保留
		await reloaded.patch("s1", { settledAt: null });
		assert.deepEqual(plain(await reloaded.snapshot()), { s1: { viewedAt: 90 } });

		// 条目的三个水位都被清掉 → 整条移除（稀疏存储，不留空对象）
		await reloaded.patch("s1", { viewedAt: null });
		assert.deepEqual(plain(await reloaded.snapshot()), {});

		const onDisk = JSON.parse(await readFile(file, "utf8"));
		assert.deepEqual(plain(onDisk.sessions), {}, "落盘内容与快照一致");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("账本：脏数据与非法补丁值不写坏文件", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gtd-ledger-"));
	try {
		const file = join(dir, "gtd-ledger.json");
		const store = new GtdLedgerStore(file);
		// 非正数 / 非有限数 / 字符串 → 视为清除（不写入垃圾时间戳）
		await store.patch("s1", { settledAt: -5, viewedAt: Number.NaN, snoozeUntil: "明天" });
		assert.deepEqual(plain(await store.snapshot()), {});

		// 加载坏 JSON：按空账本继续，下一次写入覆盖它
		const { writeFile } = await import("node:fs/promises");
		await writeFile(file, "{ not json", "utf8");
		const recovered = new GtdLedgerStore(file);
		assert.deepEqual(plain(await recovered.snapshot()), {});
		await recovered.patch("s2", { viewedAt: 10 });
		assert.deepEqual(plain(await recovered.snapshot()), { s2: { viewedAt: 10 } });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
