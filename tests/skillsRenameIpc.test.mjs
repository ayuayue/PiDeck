import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { systemIpcSource } from "./helpers/systemIpcSources.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";

const systemIpc = systemIpcSource;
const preload = preloadSource;
const sharedIpc = readFileSync("src/shared/ipc.ts", "utf8");

test("skills:rename channel is defined, invoked and handled in all three layers", () => {
	assert.match(sharedIpc, /skillsRename:\s*"skills:rename"/);
	assert.match(preload, /ipcChannels\.skillsRename/);
	assert.match(systemIpc, /ipcMain\.handle\(ipcChannels\.skillsRename/);
});

test("skills rename handler validates renderer input and routes to SkillManager.rename", () => {
	const start = systemIpc.indexOf("ipcMain.handle(ipcChannels.skillsRename");
	assert.ok(start >= 0, "skillsRename handler must exist in systemIpc");
	// handler 内部现在有对象字面量（resolvePiResourceWriteManager({...})），第一个 "});" 不再等于 handler 边界；
	// 用下一个 handler 的起点切块，避免切片被新代码撑破（断言本身不变）。
	const block = systemIpc.slice(start, systemIpc.indexOf("ipcMain.handle(ipcChannels.skillsOpenFolder", start));
	// 渲染层路径与新名称不可信：进入 SkillManager 前先做类型/非空/长度校验（AGENTS.md 输入校验在边界）。
	assert.match(block, /typeof skillPath !== "string"/);
	assert.match(block, /typeof newName !== "string"/);
	// task-16 起先按资源目标解析出 manager 再调用；只要求仍以 (skillPath, newName) 走单一 rename 入口。
	assert.match(block, /\.rename\(skillPath, newName\)/);
});
