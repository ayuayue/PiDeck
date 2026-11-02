import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");

test("projects:add follows the global Pi source (Windows / WSL) while the profile entry is paused", () => {
	// 连接档案（projects:add-wsl）只在 dev 通道开放；正式包仍按「设置 → 开发 → Pi 来源」
	// 的全局开关决定新项目环境，与 0.9.8 一致。档案放开后再切回「只加本机项目」。
	assert.match(source, /const env = settings\.wslEnabled \? \("wsl" as const\) : \("windows" as const\)/);
	assert.match(source, /chooseAndAdd\(env, wslEnvironment\)/);
	// WSL 模式下必须带发行版环境，否则 chooseAndAdd 直接抛 INVALID_WSL_PATH（#155）。
	assert.match(source, /resolveWslEnvironment\(settings\.wslDistro, settings\.wslUser\)/);
});

test("visible projects follow the global mode; remote and chat projects are exempt", () => {
	assert.match(source, /settings\.wslEnabled \? all\.filter\(/);
	assert.match(source, /isRemoteProject\(project\) \|\| project\.kind === "chat"/);
});
