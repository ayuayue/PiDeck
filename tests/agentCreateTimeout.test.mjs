import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/App.tsx", "utf8");

test("agent creation uses a bounded timeout instead of leaving pending agents forever", () => {
	assert.match(source, /const AGENT_CREATE_TIMEOUT_MS = 60_000;/);
	assert.match(source, /withTimeout<AgentTab>\(/);
	assert.match(source, /api\.agents\.create\(\{ projectId, sessionPath, title \}\)/);
	assert.match(source, /AGENT_CREATE_TIMEOUT_MS/);
	assert.match(source, /t\("app\.agentCreateTimeout"\)/);
	assert.match(source, /pendingAgentsRef\.current = pendingAgentsRef\.current\.filter/);
	assert.match(source, /showToast\(e instanceof Error \? e\.message : String\(e\), 5000\)/);
});

test("fresh agent creation exits an old session viewer before selecting the pending tab", () => {
	const createAgentSource = source.match(
		/async function createAgent\([\s\S]*?\n  \/\*\* 打开会话查看器/,
	)?.[0] ?? "";
	assert.match(createAgentSource, /if \(!sessionPath\) clearSessionViewerNow\(\);/);
	assert.ok(
		createAgentSource.indexOf("clearSessionViewerNow()") <
			createAgentSource.indexOf("setActiveAgentId(pendingTab.id)"),
	);
});
