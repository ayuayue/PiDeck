import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("user message edit handler does not keep the initial empty active agent", () => {
	const source = readFileSync("src/renderer/src/App.tsx", "utf8");
	// setPromptForAgent（draft 权威源写入）已迁入 useSessionPromptDispatch。
	const promptDispatch = readFileSync("src/renderer/src/hooks/session/useSessionPromptDispatch.ts", "utf8");

	assert.match(source, /const activeAgentIdRef = useRef<string \| undefined>\(activeAgentId\);/);
	assert.match(source, /activeAgentIdRef\.current = activeAgentId;/);
	assert.match(promptDispatch, /const targetAgentId = agentId;/);
	// previous 的权威源是 Session draft atom（与 editorAttachSelection 契约一致）：
	// livePromptByAgentRef 只在 setPromptForAgent 内更新，用它会把已删除的旧引用带回
	assert.match(promptDispatch, /previous = store\.get\(sessionDraftByIdAtom\)\[targetAgentId\] \?\? ""/);
	assert.match(promptDispatch, /setSessionDraft\(\{ sessionId: targetAgentId, value: nextValue \}\);/);
	assert.doesNotMatch(promptDispatch, /setPromptByAgent/);
});
