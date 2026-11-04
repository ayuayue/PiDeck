import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");

test("projects:add serves the Windows dialog only; WSL adds go through in-distro browsing", () => {
	// 9P 坑（Wave 0）：系统对话框递来的 \\wsl.localhost\<distro>\<home> 按发行版**默认用户**鉴权，
	// root 档案的 /root 在 Windows 侧根本打不开，所以 WSL 添加项目不再经系统对话框，
	// 改走内置选择器：projects:list-wsl-directory 列目录 + projects:add-wsl-path 在发行版内校验后入库。
	assert.match(source, /const project = await projectStore\.chooseAndAdd\(\)/);
	// 不再把环境参数交给 chooseAndAdd（旧实现按 settings.wslEnabled 分支传 "wsl"）。
	assert.doesNotMatch(source, /chooseAndAdd\(env/);
	assert.doesNotMatch(source, /ipcChannels\.projectsAddWsl\b/);
	assert.match(source, /ipcChannels\.projectsListWslDirectory/);
	assert.match(source, /ipcChannels\.projectsAddWslPath/);
	// 入库前必须在发行版内列一次目录：listWslDirectory 决定路径是否存在（不存在 / 不可用分别给稳定错误码）。
	assert.match(source, /listWslDirectory\(\{ distro: target\.distro, user: target\.user, path \}\)/);
});

test("visible projects follow the global mode; remote and chat projects are exempt", () => {
	assert.match(source, /settings\.wslEnabled \? all\.filter\(/);
	assert.match(source, /isRemoteProject\(project\) \|\| project\.kind === "chat"/);
});
