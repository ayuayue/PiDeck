import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";
// 第 12 步 Wave 3：信任/资源/扫描路径按项目 distro，不再要求全局 wslEnabled。

const main = mainIpcSource;
test("project trust uses the project's own distro with a global fallback", () => {
	assert.match(main, /const trustWslDistro = project\?\.environment === "wsl" \? \(project\?\.wslDistro \?\? settings\.wslDistro\) : undefined;/);
	assert.match(main, /const resourceWslDistro = project\.environment === "wsl" \? \(project\.wslDistro \?\? settings\.wslDistro\) : undefined;/);
	assert.match(main, /const projectWslDistro = project\.environment === "wsl" \? \(project\.wslDistro \?\? settings\.wslDistro\) : undefined;/);
});

test("background catalog scans resolve identity from the project", () => {
	assert.match(main, /const wsl = resolveProjectWslIdentity\(project, settings\);/);
	assert.match(main, /mergeScanned\(project\.id, summaries, wsl !== undefined/);
	assert.match(main, /mergeScanned\(projectId, summaries, wsl !== undefined/);
});
