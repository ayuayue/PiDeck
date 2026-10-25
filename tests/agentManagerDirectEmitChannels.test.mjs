import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const agentManagerSource = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const preloadSource = readFileSync("src/preload/index.ts", "utf8");

test("emit 收敛为直发白名单（仅 agentsRpcLog）", () => {
	assert.match(agentManagerSource, /export const DIRECT_EMIT_CHANNELS: ReadonlySet<string> = new Set\(\[ipcChannels\.agentsRpcLog\]\);/);
	assert.match(agentManagerSource, /if \(!DIRECT_EMIT_CHANNELS\.has\(channel\)\) return;/);
});

test("preload 订阅的 agents:* 通道必须全部在直发白名单内", () => {
	assert.equal(ipcChannels.agentsRpcLog, "agents:rpc-log");
	const referenced = [...preloadSource.matchAll(/ipcChannels\.(agents\w+)/g)].map((m) => m[1]);
	const unique = [...new Set(referenced)];
	assert.ok(unique.includes("agentsRpcLog"));
	for (const name of unique) {
		// preload 新增 agents 通道订阅时，必须同步 DIRECT_EMIT_CHANNELS 与本测试
		assert.equal(name, "agentsRpcLog", `unexpected preload agents channel subscription: ${name}`);
	}
});
