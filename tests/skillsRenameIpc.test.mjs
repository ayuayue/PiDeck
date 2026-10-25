import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const sharedIpc = readFileSync("src/shared/ipc.ts", "utf8");

test("skills:rename channel is defined, invoked and handled in all three layers", () => {
	assert.match(sharedIpc, /skillsRename:\s*"skills:rename"/);
	assert.match(preload, /ipcChannels\.skillsRename/);
	assert.match(systemIpc, /ipcMain\.handle\(ipcChannels\.skillsRename/);
});

test("skills rename handler validates renderer input and routes to SkillManager.rename", () => {
	const start = systemIpc.indexOf("ipcMain.handle(ipcChannels.skillsRename");
	assert.ok(start >= 0, "skillsRename handler must exist in systemIpc");
	const block = systemIpc.slice(start, systemIpc.indexOf("});", start) + 3);
	// 渲染层路径与新名称不可信：进入 SkillManager 前先做类型/非空/长度校验（AGENTS.md 输入校验在边界）。
	assert.match(block, /typeof skillPath !== "string"/);
	assert.match(block, /typeof newName !== "string"/);
	assert.match(block, /skillManager\.rename\(skillPath, newName\)/);
});
