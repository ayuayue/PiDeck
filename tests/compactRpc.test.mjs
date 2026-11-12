import { agentManagerSource } from "./helpers/agentManagerSources.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createCompactRpcRequest } = loadTsCommonJs("src/main/pi/compactRpc.ts");
const agentManager = agentManagerSource;

test("compact custom instructions are sent under both old and new pi field names", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(createCompactRpcRequest("  summarize the API changes  "))), {
		type: "compact",
		prompt: "summarize the API changes",
		customInstructions: "summarize the API changes",
	});
});

test("compact without instructions does not send empty compatibility fields", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(createCompactRpcRequest("  \n"))), { type: "compact" });
	assert.deepEqual(JSON.parse(JSON.stringify(createCompactRpcRequest(undefined))), { type: "compact" });
});

test("AgentManager uses the compatibility compact request builder", () => {
	assert.match(agentManager, /createCompactRpcRequest\(trimmedPrompt\)/);
	assert.doesNotMatch(agentManager, /type: \"compact\", prompt: trimmedPrompt/);
});
