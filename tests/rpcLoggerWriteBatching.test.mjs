// RpcLogger 落盘合并写入 + 实时副本行为测试。
//
// 为什么单独测这个：开启 RPC 日志记录后，每条 stdio 事件都要落盘。流式阶段 pi 每秒能推
// 上百条 message_update，旧实现是「每条一次 appendFile（还带一次 mkdir）」，主进程文件系统
// 调用数与日志条数成正比 —— 用户体感是「日志太多太快就把整个应用拖卡」。
// 现在行先进内存缓冲，满 256 行或 250ms 刷一批，系统调用只与刷出次数有关。
//
// 另一条行为契约：push() 返回环形缓冲里那份 data 已截断的副本，AgentManager 用它广播，
// 所以「初始历史（getLive）」和「实时追加」必须是同一形态，且大 payload 不跨进程克隆。
import assert from "node:assert/strict";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/** 极简内存文件系统：只实现 RpcLogger 会用到的读写，并记录 appendFile 调用次数 */
function createHarness() {
	const files = new Map();
	const appends = [];
	const fsPromises = {
		appendFile: async (filePath, data) => {
			const text = String(data);
			files.set(filePath, (files.get(filePath) ?? "") + text);
			appends.push({ filePath, lines: text.split("\n").filter(Boolean).length });
		},
		mkdir: async () => undefined,
		readFile: async (filePath) => {
			const content = files.get(filePath);
			if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return content;
		},
		readdir: async () => [],
		rename: async () => undefined,
		// readEntryIds 走 stat 预检的有界读：内存 FS 必须能报 size，否则去重窗口永远为空
		stat: async (filePath) => {
			const content = files.get(filePath);
			if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return { mtimeMs: 1, size: content.length };
		},
		unlink: async () => undefined,
		writeFile: async () => undefined,
	};
	const load = createTsSandbox({
		stubs: {
			electron: { app: { getPath: () => "/pideck-test-userdata" } },
			"node:fs/promises": fsPromises,
			// RpcLogger.listFiles 用 require("fs").readdirSync（跨日 gzip / 清理才用），
			// 这里给空目录即可：测试只关心写入合并，不触发压缩分支
			fs: { readdirSync: () => [], createReadStream: () => ({}), createWriteStream: () => ({}) },
			"node:fs": { readdirSync: () => [], createReadStream: () => ({}), createWriteStream: () => ({}) },
			"node:zlib": { createGzip: () => ({}), createGunzip: () => ({}) },
			"node:stream/promises": { pipeline: async () => undefined },
		},
	});
	const { RpcLogger } = load("src/main/logging/RpcLogger.ts");
	return { logger: new RpcLogger(), files, appends, fsPromises };
}

function entry(overrides = {}) {
	return {
		id: `id-${Math.random().toString(36).slice(2)}`,
		agentId: "agent-1",
		direction: "recv",
		summary: "← message_update.text_delta",
		data: { type: "message_update" },
		time: Date.now(),
		...overrides,
	};
}

/** 等缓冲里的异步写队列跑完（flush 挂在 writeQueue 上，链式 promise 需要几个宏任务） */
async function settle(times = 6) {
	for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("push 不再逐条落盘：行先进缓冲，flushPending 才一次写完", async () => {
	const { logger, appends, files } = createHarness();
	for (let i = 0; i < 5; i++) logger.push(entry());
	// 关键断言：5 条日志 = 0 次文件系统写入（旧实现是 5 次 appendFile + 5 次 mkdir）
	assert.equal(appends.length, 0, "push 必须只入缓冲，不立即写盘");

	await logger.flushPending();

	assert.equal(appends.length, 1, "整批只调用一次 appendFile");
	assert.equal(appends[0].lines, 5);
	const [onlyFile] = [...files.keys()];
	assert.match(onlyFile, /rpc-agent-1-\d{4}-\d{2}-\d{2}\.jsonl$/);
	const lines = files.get(onlyFile).trim().split("\n");
	assert.equal(lines.length, 5);
	// 每行都是完整 JSON 条目（落盘内容不截断，截断只发生在实时副本）
	assert.deepEqual(JSON.parse(lines[0]).agentId, "agent-1");
});

test("缓冲到行数水位自动刷出，不等定时器", async () => {
	const { logger, appends } = createHarness();
	// FLUSH_MAX_LINES = 256：第 256 条触发同步刷出
	for (let i = 0; i < 256; i++) logger.push(entry());
	await settle();
	assert.equal(appends.length, 1, "达到行数水位应立刻整批写盘");
	assert.equal(appends[0].lines, 256);
});

test("flushPending 可重入：空缓冲不产生写入，刷完的缓冲不重复落盘", async () => {
	const { logger, appends } = createHarness();
	await logger.flushPending();
	assert.equal(appends.length, 0);
	logger.push(entry());
	await logger.flushPending();
	await logger.flushPending();
	assert.equal(appends.length, 1);
});

test("push 返回截断后的实时副本，落盘的仍是完整内容", async () => {
	const { logger, appends, files } = createHarness();
	const big = { type: "prompt", message: "x".repeat(9000) };
	const live = logger.push(entry({ data: big }));
	// MAX_LIVE_DATA_BYTES = 4096：环形缓冲/广播只留摘要，避免大 payload 跨进程克隆
	assert.deepEqual(Object.keys(live.data).sort(), ["preview", "size", "truncated"]);
	assert.equal(live.data.truncated, true);
	assert.equal(live.data.size, JSON.stringify(big).length);
	// getLive 与广播同形（历史截断、追加不截断的老不一致不会复发）
	assert.equal(logger.getLive("agent-1")[0], live);

	await logger.flushPending();
	const [onlyFile] = [...files.keys()];
	const written = JSON.parse(files.get(onlyFile).trim());
	assert.equal(appends.length, 1);
	// 文件保留完整内容，用户展开旧日志仍能看到全文
	assert.equal(written.data.message.length, 9000);
});

test("保存面板条目会先刷缓冲，去重才看得见刚产生的自动日志", async () => {
	const { logger, files, appends } = createHarness();
	const shared = entry({ id: "same-id", data: { type: "response" } });
	logger.push(shared);
	// 缓冲里那条还没落盘；appendEntries 内部先 flushPending，readEntryIds 才读得到 same-id
	const written = await logger.appendEntries([shared]);
	assert.equal(appends.length, 1, "只应有自动落盘那一批，保存条目被去重挡掉");
	// 注意：返回值是 vm 沙箱里构造的数组，deepEqual 会因跨 realm 原型不同而失败，只比长度与内容
	assert.equal(written.length, 0, "同一 id 的自动日志应先落盘并被去重命中");
	const [onlyFile] = [...files.keys()];
	assert.equal(files.get(onlyFile).trim().split("\n").length, 1);
});
