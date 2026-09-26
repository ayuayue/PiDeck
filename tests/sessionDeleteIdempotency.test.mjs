import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scanner = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
const ipc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");

test("session file deletion treats an already missing local file as success", () => {
	assert.match(scanner, /if \(!existsSync\(filePath\)\) return;/);
	// 删除走系统回收站（可恢复）；回收站不可用时抛错，拒绝静默硬删。
	assert.match(scanner, /await shell\.trashItem\(filePath\);/);
});

test("catalog delete still removes the catalog record after a stale file path", () => {
	assert.match(ipc, /const sessionFilePath = localSessionFilePath\(sessionId\);/);
	assert.match(ipc, /if \(sessionFilePath\) \{[\s\S]*await sessionScanner\.delete\(sessionFilePath\);[\s\S]*\}/);
	assert.match(ipc, /await sessionCatalog\.removeWithDescendants\(sessionId\)/);
});

test("WSL deletion uses force semantics for the same idempotent contract", () => {
	assert.match(scanner, /"rm", "-f", wslPath/);
});
