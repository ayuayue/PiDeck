/**
 * WebStateEventHub 版本键门控行为（2027-02 性能治理）。
 *
 * 契约：流式期间每条 pi 事件都会 schedule 一次去抖推送，但 runtime 状态面
 * （runtimes 身份/状态/代数 + pendingUi 摘要）并不随 delta 变化——键未变时
 * 必须跳过整快照构建 + 序列化（此前每次构建 ~100KB JSON 只为比对出「无变化」）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebStateEventHub } = loadTsCommonJs("src/main/web/WebStateEventHub.ts");

function makeHarness() {
	let loadCalls = 0;
	let revisionValue = "rev-1";
	const writes = [];
	const client = {
		writeRaw: (wire) => {
			writes.push(wire);
			return true;
		},
	};
	const hub = new WebStateEventHub({
		// 载荷随键变化（真实场景里键变 = 状态面变了）
		loadState: async () => {
			loadCalls += 1;
			return { revision: revisionValue };
		},
		stateRevision: () => revisionValue,
	});
	return {
		hub,
		client,
		writes,
		getLoadCalls: () => loadCalls,
		setRevision: (next) => {
			revisionValue = next;
		},
	};
}

test("键未变：跳过整快照构建；键变化：构建并推送；force 不受门控", async () => {
	const { hub, client, writes, getLoadCalls, setRevision } = makeHarness();
	// 首推（force 语义：handle 连接即推）必须构建
	await hub.push([client], true);
	assert.equal(getLoadCalls(), 1, "force 首推必须构建快照");
	assert.equal(writes.length, 1);

	// 键未变（流式 delta 场景）：跳过构建
	await hub.push([client]);
	assert.equal(getLoadCalls(), 1, "版本键未变不得重新构建快照");
	assert.equal(writes.length, 1, "也不得重复推送");

	// 键变化（runtime 状态翻转）：构建 + 推送
	setRevision("rev-2");
	await hub.push([client]);
	assert.equal(getLoadCalls(), 2, "版本键变化必须重新构建");
	assert.equal(writes.length, 2, "并推送新快照");

	// 再次回到稳定键：跳过构建
	await hub.push([client]);
	assert.equal(getLoadCalls(), 2, "回到稳定键不得重复构建");
	assert.equal(writes.length, 2);
});

test("没有 Web 订阅者时 schedule 不建去抖定时器（Web 只是数据出口）", () => {
	const { hub } = makeHarness();
	hub.schedule();
	// statePushTimer 是 TS private（运行期普通字段）：无订阅者时不应排 400ms 快照比对。
	assert.equal(hub.statePushTimer, null);
});

test("skipRevisionGate：5s 兜底 tick 必须穿过版本键门（#442）", async () => {
	// 版本键只含 runtimes + pendingUi；桌面端改名/删除会话不进键。tick 若也走这个门，
	// 第一道就 return，后面的全量 JSON 比对永远执行不到 —— 兜底形同虚设。
	const { hub, client, writes, getLoadCalls } = makeHarness();
	await hub.push([client], true);
	assert.equal(getLoadCalls(), 1);
	// 键未变：普通 push（pi 事件路径）保持跳过，性能优化不能被 tick 修复撤掉
	await hub.push([client]);
	assert.equal(getLoadCalls(), 1, "普通 push 键未变时必须继续跳过构建");
	// 绕过版本键：必须构建快照去比对（内容确实没变时仍不重复推送）
	await hub.push([client], false, { skipRevisionGate: true });
	assert.equal(getLoadCalls(), 2, "tick 必须穿过版本键门，否则目录变更永远推不出去");
	assert.equal(writes.length, 1, "内容真的没变时不得重复推送（JSON 比对门照常生效）");

	// 接线契约：tick 的定时器确实把 flag 传下去了（flag 有了但没接等于没修）
	const source = readFileSync(`${process.cwd()}/src/main/web/WebStateEventHub.ts`, "utf8");
	assert.match(source, /setInterval\(\(\) => void this\.push\(undefined, false, \{ skipRevisionGate: true \}\), 5_000\)/, "startTick 必须每 5s 走绕过版本键的 push");
});

test("未提供 stateRevision 时退回旧行为（每次构建 + json 比对）", async () => {
	let loadCalls = 0;
	const writes = [];
	const client = {
		writeRaw: (wire) => {
			writes.push(wire);
			return true;
		},
	};
	const hub = new WebStateEventHub({
		loadState: async () => {
			loadCalls += 1;
			return { a: 1 };
		},
	});
	await hub.push([client], true);
	await hub.push([client]);
	assert.equal(loadCalls, 2, "无版本键时保持旧路径：每次都构建");
	assert.equal(writes.length, 1, "json 比对门照常免推");
});
