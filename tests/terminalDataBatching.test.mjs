import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// 终端输出合批器（src/main/terminal/terminalDataBatching.ts）单测：
// 模块无本地依赖，用与 terminalDockState.test.mjs 相同的 transpile+vm 模式，
// 但要往 vm 上下文注入 setTimeout/clearTimeout（真实计时器，batchMs 用小窗口）。

function compile(filePath, context) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: () => ({}),
		setTimeout,
		clearTimeout,
		...context,
	});
	return module.exports;
}

function loadBatcherModule() {
	return compile("src/main/terminal/terminalDataBatching.ts");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("rapid pushes within one window coalesce into a single emit", async () => {
	const { createTerminalDataBatcher } = loadBatcherModule();
	const emitted = [];
	const batcher = createTerminalDataBatcher((data) => emitted.push(data), { batchMs: 5 });
	batcher.push("a");
	batcher.push("b");
	batcher.push("c");
	await sleep(25);
	assert.deepEqual(emitted, ["abc"], "一个窗口内的 3 次小 chunk 应合并为 1 次 emit");
	batcher.dispose();
});

test("flush delivers pending immediately and is idempotent", async () => {
	const { createTerminalDataBatcher } = loadBatcherModule();
	const emitted = [];
	const batcher = createTerminalDataBatcher((data) => emitted.push(data), { batchMs: 50 });
	batcher.push("x");
	batcher.flush();
	assert.deepEqual(emitted, ["x"]);
	batcher.flush();
	assert.deepEqual(emitted, ["x"], "空 flush 是 no-op，不得发出空载荷");
	batcher.push("y");
	await sleep(70);
	assert.deepEqual(emitted, ["x", "y"], "flush 后新数据走正常窗口路径且保序");
	batcher.dispose();
});

test("oversized push flushes immediately without waiting for the window", async () => {
	const { createTerminalDataBatcher } = loadBatcherModule();
	const emitted = [];
	const batcher = createTerminalDataBatcher((data) => emitted.push(data), { batchMs: 500, maxChars: 10 });
	batcher.push("0123456789A");
	assert.deepEqual(emitted, ["0123456789A"], "达到 maxChars 应立即刷出");
	await sleep(20);
	assert.equal(emitted.length, 1, "已刷出的数据不依赖窗口补发");
	batcher.dispose();
});

test("dispose drops pending data and stops the timer", async () => {
	const { createTerminalDataBatcher } = loadBatcherModule();
	const emitted = [];
	const batcher = createTerminalDataBatcher((data) => emitted.push(data), { batchMs: 5 });
	batcher.push("tail");
	batcher.dispose();
	await sleep(25);
	assert.deepEqual(emitted, [], "dispose 后挂起数据必须被丢弃（tab 已关闭，迟到无意义）");
});

test("empty push never schedules a window", async () => {
	const { createTerminalDataBatcher } = loadBatcherModule();
	const emitted = [];
	const batcher = createTerminalDataBatcher((data) => emitted.push(data), { batchMs: 5 });
	batcher.push("");
	await sleep(25);
	assert.deepEqual(emitted, []);
	batcher.dispose();
});

test("TerminalSessionManager keeps data-before-exit ordering and disposes on close", () => {
	// 接线守卫：批处理的生命周期约束（见 terminalDataBatching.ts 头注释）必须由
	// 管理器侧遵守——纯函数测试覆盖不了跨模块顺序，这里用源码扫描锁住。
	const source = readFileSync("src/main/terminal/TerminalSessionManager.ts", "utf8");
	const exitBlock = source.match(/pty\.onExit\(\(event\) => \{[\s\S]*?\n\t\t\}\);/);
	assert.ok(exitBlock, "onExit 块应可被发现");
	const flushIdx = exitBlock[0].indexOf("batcher.flush()");
	const emitExitIdx = exitBlock[0].indexOf("ipcChannels.terminalExit");
	assert.ok(flushIdx > 0 && flushIdx > -1 && emitExitIdx > -1 && flushIdx < emitExitIdx, "onExit 必须先 flush 合批器再发 terminalExit（保序）");

	// close / closeAgent / closeOwner 三条关闭路径都要 flush+dispose 再 kill
	const disposeCount = (source.match(/batcher\.dispose\(\)/g) || []).length;
	assert.ok(disposeCount >= 3, `三条关闭路径都应 dispose 合批器，实际 ${disposeCount} 处`);
	const closeBlock = source.match(/close\(tabId: string\) \{[\s\S]*?\n\t\}/);
	assert.ok(closeBlock, "close 块应可被发现");
	assert.ok(closeBlock[0].indexOf("batcher.flush()") < closeBlock[0].indexOf("pty.kill()"), "close 必须先 flush 再 kill");

	// 渲染层回放缓冲上界与主进程常量必须同步为 200_000。
	// 2027-02 重构：主进程回放缓冲收口到 terminalReplayBuffer.ts（分段存储），
	// 上界常量随之迁移；管理器必须经该模块追加（不得回退成单字符串拼接）。
	const manager = readFileSync("src/main/terminal/TerminalSessionManager.ts", "utf8");
	assert.match(manager, /appendTerminalReplay\(runtime\.buffer, data\)/, "onData 必须经分段缓冲追加");
	const replayModule = readFileSync("src/main/terminal/terminalReplayBuffer.ts", "utf8");
	assert.match(replayModule, /MAX_TERMINAL_REPLAY_BUFFER = 200_000/);
	const dockState = readFileSync("src/renderer/src/terminalDockState.ts", "utf8");
	assert.match(dockState, /TERMINAL_REPLAY_MAX_CHARS = 200_000/);
});

test("TerminalDock appends live data and exit text through the capped helper", () => {
	// 渲染层接线守卫：onData 与 onExit 两处都必须走 appendTerminalReplayBuffer，
	// 不允许绕过上界直接字符串拼接（长跑终端内存无界回归）。
	const dock = readFileSync("src/renderer/src/components/terminal/TerminalDock.tsx", "utf8");
	const uses = dock.match(/appendTerminalReplayBuffer\(buffersRef\.current\[payload\.tabId\] \?\? ""/g) || [];
	assert.equal(uses.length, 2, "onData 与 onExit 两处都应经 appendTerminalReplayBuffer 截尾");
	assert.doesNotMatch(dock, /buffersRef\.current\[[^\]]+\] = buffersRef\.current\[[^\]]+\] \?\? ""\) \+ payload\.data/, "禁止绕过截尾 helper 直拼");
});
