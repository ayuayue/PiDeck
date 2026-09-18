import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");

test("agentsLog/agentsTextStream 全部发射点携带 runtime triple", () => {
  const spreads = source.match(/\.\.\.this\.streamRuntimeTriple\(agentId\)/g) ?? [];
  // stderr 与 protocol-error（agentsLog×2）+ agent_start 重置 + emitTextStreamNow 负载 = 4 处
  assert.ok(spreads.length >= 4, `expected >=4 streamRuntimeTriple spreads, got ${spreads.length}`);
});

test("streamRuntimeTriple 定义存在且读取 AgentTab 绑定", () => {
  assert.match(source, /private streamRuntimeTriple\(agentId: string\)/);
  assert.match(source, /runtime\?\.tab\.deckSessionId/);
  assert.match(source, /runtime\?\.tab\.runtimeGeneration/);
});
