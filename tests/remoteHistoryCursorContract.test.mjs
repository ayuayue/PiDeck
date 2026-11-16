/**
 * 远端历史页的游标契约（收口 2026-10）。
 *
 * 背景：远端历史经主进程有界窗口读回，`nextBefore` 是**字节偏移**；而本地磁盘历史把它当**活动分支消息下标**用，
 * 并在「页 + 内存超限裁剪」时做算术前移（`nextBefore + dropCount`）。两者塞进同一 source 会让远端游标被算坏
 * （静默跳内容）。契约：远端记录的磁盘页在归约时标成 `source: "remote"`，那条算术（只对 `"disk"` 生效）因此跳过它。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { sessionAtomsSource } from "./helpers/sessionAtomsSources.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

const SESSION_ID = "session-remote-history";
const remoteRecord = {
	id: SESSION_ID,
	projectId: "project-remote",
	title: "远端会话",
	createdAt: 1,
	updatedAt: 1,
	locator: { kind: "ssh", hostId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", remotePath: "/home/dev/.pi/agent/sessions/x/y.jsonl" },
};
const localRecord = { id: SESSION_ID, projectId: "project-local", title: "本机会话", createdAt: 1, updatedAt: 1, locator: { kind: "local", environment: "native", filePath: "/tmp/x.jsonl" } };

function seedPage(store, record) {
	store.set(atoms.sessionRecordsAtom, { [SESSION_ID]: record });
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: SESSION_ID,
		messages: [{ id: "m1", agentId: "agent-1", role: "user", text: "hi", timestamp: 1 }],
		source: "disk",
		expectedRevision: 0,
		page: { total: 1, nextBefore: 4242 },
	});
	return store.get(atoms.sessionMessagesCacheAtom)[SESSION_ID];
}

test('远端记录的磁盘页归约成 source:"remote"，且保留页（分页可见）', () => {
	const store = createStore();
	const entry = seedPage(store, remoteRecord);
	assert.equal(entry.source, "remote");
	assert.equal(entry.page?.nextBefore, 4242, "远端游标必须原样保留，不得被算术改写");
});

test('本机记录不受影响：仍是 source:"disk"', () => {
	const store = createStore();
	const entry = seedPage(store, localRecord);
	assert.equal(entry.source, "disk");
	assert.equal(entry.page?.nextBefore, 4242);
});

test("契约守卫：那条游标算术仍只对 disk 生效（远端不会被算）", () => {
	const src = sessionAtomsSource;
	// 裁剪前移分支的守卫必须仍是 disk-only：
	assert.match(src, /current\.source !== "disk"/);
	// 归约点必须按记录 locator 判定远端：
	assert.match(src, /get\(sessionRecordsAtom\)\[input\.sessionId\]\?\.locator\?\.kind === "ssh"/);
	// 存进状态与放行 page 都用归约后的来源：
	assert.match(src, /source: historySource,/);
	assert.match(src, /historySource !== "runtime" && input\.page/);
});
