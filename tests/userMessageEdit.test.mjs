import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("user message edit handler does not keep the initial empty active agent", () => {
	const source = readFileSync("src/renderer/src/App.tsx", "utf8");

	assert.match(
		source,
		/const activeAgentIdRef = useRef<string \| undefined>\(activeAgentId\);/,
	);
	assert.match(source, /activeAgentIdRef\.current = activeAgentId;/);
	assert.match(source, /const targetAgentId = activeAgentIdRef\.current;/);
	assert.match(source, /const previous = livePromptByAgentRef\.current\[targetAgentId\] \?\? "";/);
	assert.match(source, /\[targetAgentId\]: nextValue/);
});
