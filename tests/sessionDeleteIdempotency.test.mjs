import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scanner = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
const ipc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");

test("session file deletion treats an already missing local file as success", () => {
	// 幂等分支：文件已不在时跳过回收站、只留痕（行为由 tests/sessionScannerDelete.test.mjs 的
	// #364 用例实测）。注意这里不再早退——文件没了仍要尽力清理同级子会话目录，避免孤儿目录。
	assert.match(scanner, /if \(!existsSync\(filePath\)\)\s*\{\s*getAppLogger\(\)\?\.info\("session", "Session delete skipped \(file already gone\)"/);
	assert.match(scanner, /await this\.deleteSiblingDirBestEffort\(filePath\);/);
	// 删除走系统回收站（可恢复）；回收站不可用时抛错，拒绝静默硬删。
	assert.match(scanner, /await shell\.trashItem\(targetPath\);/);
});

test("catalog delete still removes the catalog record after a stale file path", () => {
	assert.match(ipc, /if \(entry\.filePath\) \{[\s\S]*await sessionScanner\.delete\(entry\.filePath\);[\s\S]*\}/);
	assert.match(ipc, /await sessionCatalog\.removeWithDescendants\(sessionId\)/);
});

test("WSL deletion uses force semantics for the same idempotent contract", () => {
	assert.match(scanner, /"rm", "-f", wslPath/);
});
