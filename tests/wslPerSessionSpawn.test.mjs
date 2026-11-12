import { agentManagerSource } from "./helpers/agentManagerSources.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 第 12 步 Wave 2：WSL 会话 spawn 时用档案里的 distro/user，而不是固定全局环境。
// 缺字段仍回退全局（兼容旧项目）；远端会话不参与 WSL 身份。
const manager = agentManagerSource;

test("spawn settings override carries the session WSL identity", () => {
	assert.match(manager, /settingsOverride\?: Partial<Pick<AppSettings, [^>]*"wslEnabled" \| "wslDistro" \| "wslUser"/);
	assert.match(manager, /const wslSpawnOverride = sessionEnvironment === "wsl" && tab\.wslDistro !== undefined && tab\.wslUser !== undefined \? \{ wslEnabled: true, wslDistro: tab\.wslDistro, wslUser: tab\.wslUser \} : undefined;/);
	assert.match(manager, /createPiProcess\(project\.path, input\.sessionPath, input\.deckSessionId, wslSpawnOverride, id\)/);
});

test("session path conversion uses the input distro, not only the global one", () => {
	assert.match(manager, /const createWslDistro = input\.environment === "wsl" \? \(input\.wslDistro \?\? this\.wslEnvironment\?\.distro\) : undefined;/);
	assert.match(manager, /toSessionProtocolPath\(sessionPath, createWslDistro\)/);
	assert.match(manager, /private toSessionProtocolPath\(sessionPath: string, distro = this\.wslEnvironment\?\.distro\)/);
});

test("PiProcess resolves the command from the effective settings", () => {
	const process = readFileSync("src/main/pi/PiProcess.ts", "utf8");
	assert.match(process, /settings\?\.wslEnabled/);
	assert.match(process, /this\.settings\?\.wslDistro/);
});
