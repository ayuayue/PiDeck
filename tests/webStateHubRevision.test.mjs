/**
 * WebStateEventHub 版本键门控行为（2027-02 性能治理）。
 *
 * 契约：流式期间每条 pi 事件都会 schedule 一次去抖推送，但 runtime 状态面
 * （runtimes 身份/状态/代数 + pendingUi 摘要）并不随 delta 变化——键未变时
 * 必须跳过整快照构建 + 序列化（此前每次构建 ~100KB JSON 只为比对出「无变化」）。
 */
import assert from "node:assert/strict";
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
