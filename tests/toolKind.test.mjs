import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { getToolKind, getToolKindLabel } = loadTsCommonJs("src/renderer/src/components/session/toolKind.ts");

test("only reserved MCP tool namespaces receive an MCP badge", () => {
	assert.equal(getToolKind("mcp"), "mcp-proxy");
	assert.equal(getToolKindLabel("mcp"), "MCP");

	assert.equal(getToolKind("mcp__github__create_issue"), "mcp-direct");
	assert.equal(getToolKindLabel("mcp__github__create_issue"), "MCP");
	assert.equal(getToolKind("MCP__github__create_issue"), "mcp-direct");
});

test("ordinary tools with underscores stay unbadged", () => {
	for (const toolName of ["pwsh_persistent", "ask_question", "get_goal", "job_output", "str_replace_editor", "chrome_devtools_navigate"]) {
		assert.equal(getToolKind(toolName), "extension", toolName);
		assert.equal(getToolKindLabel(toolName), "", toolName);
	}
});

test("Pi built-ins remain built-ins without an MCP badge", () => {
	for (const toolName of ["bash", "edit", "find", "grep", "ls", "read", "write"]) {
		assert.equal(getToolKind(toolName), "builtin", toolName);
		assert.equal(getToolKindLabel(toolName), "", toolName);
	}
});
