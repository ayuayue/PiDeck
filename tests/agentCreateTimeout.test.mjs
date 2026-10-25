import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/hooks/useSessionActions.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");

test("new conversation creates a metadata-only Session draft", () => {
	// 块边界不能假设两空格缩进（formatter 统一为 tab）：用「行首 } / return {」锚点。
	const createDraftSource = source.match(/async function createSessionDraft\([\s\S]*?\n[\t ]*\}\s*\n[\t ]*return \{/)?.[0] ?? "";
	assert.match(createDraftSource, /api\.sessions\.createDraft\(\{/);
	assert.match(createDraftSource, /commitSessionSelection\(projectId, session\.id, true\)/);
	assert.doesNotMatch(createDraftSource, /setActiveAgentId/);
	assert.doesNotMatch(createDraftSource, /api\.agents\.create/);
});

test("renderer has no direct Agent creation path", () => {
	const injector = readFileSync("src/renderer/src/components/session/SessionRuntimeInjector.tsx", "utf8");
	assert.doesNotMatch(app, /async function createAgent\(/);
	assert.doesNotMatch(app, /api\.agents\.create\(/);
	// 新建会话统一走 SessionView 的 createDraft 链路（原 onHeaderTrigger fallback 已随
	// 会话操作 combo 移除，draft 入口改经 services 注入直传 SessionView）
	assert.match(injector, /runCreateSessionDraft=\{services\.runCreateSessionDraft\}/);
});
