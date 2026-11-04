import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");

test("projects:add is Windows-only; WSL uses the in-distro browser and add-by-path flow", () => {
	// 系统目录对话框按发行版默认用户鉴权，无法可靠访问其它 WSL 用户的目录，因此
	// projects:add 只允许 Windows 路径；WSL 必须走主进程内置选择器与 add-wsl-path。
	assert.match(source, /ipcMain\.handle\(ipcChannels\.projectsAdd,[\s\S]{0,500}?projectStore\.chooseAndAdd\(\)/);
	assert.doesNotMatch(source, /chooseAndAdd\(\s*env\s*,\s*wslEnvironment\s*\)/);
	assert.doesNotMatch(source, /projectsAddWsl:/);
	assert.match(source, /ipcMain\.handle\(ipcChannels\.projectsAddWslPath/);
	assert.match(source, /listWslDirectory\(\{ distro: target\.distro, user: target\.user, path \}\)/);
	assert.match(source, /linuxPathToWslUnc\(listed\.value\.path, target\.distro\)/);
	assert.match(source, /projectStore\.add\(projectPath, undefined, "wsl", target\.identity\)/);
});

test("visible projects follow the global mode; remote and chat projects are exempt", () => {
	assert.match(source, /settings\.wslEnabled \? all\.filter\(/);
	assert.match(source, /isRemoteProject\(project\) \|\| project\.kind === "chat"/);
});
