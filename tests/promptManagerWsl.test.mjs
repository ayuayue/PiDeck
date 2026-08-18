import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/main/prompts/PromptManager.ts", "utf8");

test("project prompt operations cross the WSL host filesystem boundary", () => {
	assert.match(source, /parseWslUncPath, toWindowsHostPath/);
	assert.match(source, /private hostPath\(path: string\): string/);
	assert.match(source, /join\(this\.hostPath\(projectPath\), "\.pi", "prompts"\)/);
	assert.match(source, /const hostFilePath = this\.hostPath\(filePath\)/);
});
