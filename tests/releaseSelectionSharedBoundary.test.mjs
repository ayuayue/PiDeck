/**
 * 通道切换共享层边界契约测试（Task 6 步骤 9）：
 * 1. releaseSelection.ts 是共享纯函数（任务 7 的 macManualUpdate 复用）：源码不得 import electron。
 * 2. 通道名集中在 shared/ipc.ts（AGENTS.md 硬性规则）：五个 channelSwitch 通道必须在 map 内定义。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("releaseSelection.ts 不依赖 electron（共享纯函数，任务 7 macManualUpdate 复用）", () => {
	const source = readFileSync(new URL("../src/main/update/releaseSelection.ts", import.meta.url), "utf8");
	assert.ok(!/from\s+["']electron["']/.test(source), "releaseSelection.ts 不得 import electron");
});

test("channelSwitch 五通道集中在 shared/ipc.ts，名称符合规格 §4", () => {
	const source = readFileSync(new URL("../src/shared/ipc.ts", import.meta.url), "utf8");
	const expected = [
		['channelSwitchQuery: "channel-switch:query"', "channel-switch:query"],
		['channelSwitchDownload: "channel-switch:download"', "channel-switch:download"],
		['channelSwitchLaunch: "channel-switch:launch"', "channel-switch:launch"],
		['channelSwitchGetStatus: "channel-switch:get-status"', "channel-switch:get-status"],
		['channelSwitchStateChanged: "channel-switch:state-changed"', "channel-switch:state-changed"],
	];
	for (const [literal, channel] of expected) {
		assert.ok(source.includes(literal), `shared/ipc.ts 应定义 ${channel}`);
	}
});
