import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");

test("agentsLog/agentsTextStream 全部发射点携带 runtime triple", () => {
	const spreads = source.match(/\.\.\.this\.streamRuntimeTriple\(agentId\)/g) ?? [];
	// abort 的 queue-cleared 先取 runtimeIdentity 快照再展开（await 后核对原 runtime
	// 不能误停下一轮的稳定性来源），三元组携带语义与直接展开相同，计入同一口径。
	const viaIdentity = source.match(/\.\.\.runtimeIdentity/g) ?? [];
	// stderr 与 protocol-error（agentsLog×2）+ agent_start 重置 + emitTextStreamNow 负载 = 4 处
	assert.ok(spreads.length + viaIdentity.length >= 4, `expected >=4 runtime-triple carries, got ${spreads.length + viaIdentity.length}`);
});

test("streamRuntimeTriple 定义存在且读取 AgentTab 绑定", () => {
	assert.match(source, /private streamRuntimeTriple\(agentId: string\)/);
	assert.match(source, /runtime\?\.tab\.deckSessionId/);
	assert.match(source, /runtime\?\.tab\.runtimeGeneration/);
});
