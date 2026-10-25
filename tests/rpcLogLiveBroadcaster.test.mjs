// 行为测试：RpcLogLiveBroadcaster（DSH 后端的实时 RPC 日志广播，镜像 pi AgentManager 语义）。
// 无 electron 依赖，真实执行：观看闸门 / 80ms 批量聚合 / 超限留余 / 有界缓冲 / 生命周期清理。
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { RpcLogLiveBroadcaster } = loadTsCommonJs("src/main/logging/RpcLogLiveBroadcaster.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const AGENT_A = "dsh:session-a";
const AGENT_B = "dsh:session-b";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const entry = (agentId, i) => ({ id: `e${i}`, agentId, direction: "send", summary: `s${i}`, time: 1000 + i });

/** flushMs=1：毫秒级触发，测试等待 15ms 即可；send 记录全部调用供断言。 */
function makeBroadcaster() {
	const sends = [];
	const broadcaster = new RpcLogLiveBroadcaster({
		send: (channel, payload) => sends.push({ channel, payload }),
		flushMs: 1,
	});
	return { broadcaster, sends };
}

test("未登记观看的 agent 直接丢弃，不产生任何 IPC", async () => {
	const { broadcaster, sends } = makeBroadcaster();
	broadcaster.enqueue(entry(AGENT_A, 0));
	broadcaster.enqueue(entry(AGENT_A, 1));
	await sleep(15);
	assert.equal(sends.length, 0);
	// 登记后再推才走广播
	broadcaster.setWatching(AGENT_A, true);
	broadcaster.enqueue(entry(AGENT_A, 2));
	await sleep(15);
	assert.equal(sends.length, 1);
	// 注意：payload 外层对象由 vm 沙箱里编译的 TS 模块创建（不同 V8 realm，prototype 不同），
	// deepStrictEqual 会因原型不等失败——逐字段断言，元素对象仍是测试侧 realm 可 deepEqual。
	assert.equal(sends[0].channel, ipcChannels.agentsRpcLog);
	assert.equal(sends[0].payload.agentId, AGENT_A);
	assert.equal(sends[0].payload.entries.length, 1);
	assert.deepEqual(sends[0].payload.entries[0], entry(AGENT_A, 2));
});

test("多条目聚合成一批，按 agentId 隔离批次", async () => {
	const { broadcaster, sends } = makeBroadcaster();
	broadcaster.setWatching(AGENT_A, true);
	broadcaster.setWatching(AGENT_B, true);
	for (let i = 0; i < 5; i++) broadcaster.enqueue(entry(AGENT_A, i));
	broadcaster.enqueue(entry(AGENT_B, 0));
	await sleep(15);
	assert.equal(sends.length, 2);
	const batchA = sends.find((s) => s.payload.agentId === AGENT_A);
	const batchB = sends.find((s) => s.payload.agentId === AGENT_B);
	assert.equal(batchA.payload.entries.length, 5);
	assert.equal(batchB.payload.entries.length, 1);
});

test("单批超限（MAX_BATCH=100）留到下一轮，不丢日志", async () => {
	const { broadcaster, sends } = makeBroadcaster();
	broadcaster.setWatching(AGENT_A, true);
	for (let i = 0; i < 150; i++) broadcaster.enqueue(entry(AGENT_A, i));
	await sleep(15);
	assert.equal(sends.length, 1);
	assert.equal(sends[0].payload.entries.length, 100);
	// 余量不靠定时器续发：只有新条目进来才触发下一轮（与 pi 一致，避免空转）
	await sleep(15);
	assert.equal(sends.length, 1);
	broadcaster.enqueue(entry(AGENT_A, 150));
	await sleep(15);
	assert.equal(sends.length, 2);
	assert.equal(sends[1].payload.entries.length, 51);
	assert.equal(sends[1].payload.entries[0].id, "e100");
});

test("聚合缓冲有界（MAX_PENDING=1000）：极端高频丢最旧", async () => {
	const { broadcaster, sends } = makeBroadcaster();
	broadcaster.setWatching(AGENT_A, true);
	for (let i = 0; i < 1001; i++) broadcaster.enqueue(entry(AGENT_A, i));
	await sleep(15);
	assert.equal(sends.length, 1);
	assert.equal(sends[0].payload.entries.length, 100);
	// e0 被丢最旧：首批从 e1 开始
	assert.equal(sends[0].payload.entries[0].id, "e1");
});

test("dropPending 丢弃该 agent 的待发缓冲，观看登记不受影响", async () => {
	const { broadcaster, sends } = makeBroadcaster();
	broadcaster.setWatching(AGENT_A, true);
	broadcaster.enqueue(entry(AGENT_A, 0));
	broadcaster.enqueue(entry(AGENT_A, 1));
	broadcaster.dropPending(AGENT_A);
	await sleep(15);
	assert.equal(sends.length, 0);
	// 观看登记仍在：新条目照常广播（DSH agentId 跨 stop/attach 稳定，面板可跨重启周期挂载）
	broadcaster.enqueue(entry(AGENT_A, 2));
	await sleep(15);
	assert.equal(sends.length, 1);
	// payload 外层对象是 vm 沙箱 realm（见首个用例注释），逐字段断言
	assert.equal(sends[0].payload.agentId, AGENT_A);
	assert.equal(sends[0].payload.entries.length, 1);
	assert.deepEqual(sends[0].payload.entries[0], entry(AGENT_A, 2));
});

test("clear 清空观看登记、待发缓冲与在途定时器（stopAll/退出路径）", async () => {
	const { broadcaster, sends } = makeBroadcaster();
	broadcaster.setWatching(AGENT_A, true);
	broadcaster.enqueue(entry(AGENT_A, 0));
	broadcaster.clear();
	await sleep(15);
	assert.equal(sends.length, 0);
	// 观看登记已清：clear 后再推也直接丢弃
	broadcaster.enqueue(entry(AGENT_A, 1));
	await sleep(15);
	assert.equal(sends.length, 0);
});

test("取消观看后条目不再广播", async () => {
	const { broadcaster, sends } = makeBroadcaster();
	broadcaster.setWatching(AGENT_A, true);
	broadcaster.setWatching(AGENT_A, false);
	broadcaster.enqueue(entry(AGENT_A, 0));
	await sleep(15);
	assert.equal(sends.length, 0);
});
