import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Wave 0（docs/wsl-project-in-distro-io-plan.md）：WSL 添加项目不再经系统「打开文件夹」——
// \\wsl.localhost 按发行版默认用户鉴权，root 档案的 /root 递进去即报错。
// 目录由内置选择器在发行版内列出并校验，档案身份仍写入项目（distro/user/hostId）。
const shared = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const ipc = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");
const store = readFileSync("src/main/projects/ProjectStore.ts", "utf8");
const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");
const dialog = readFileSync("src/renderer/src/components/sidebar/WslProjectPickerDialog.tsx", "utf8");

test("in-distro browse + add channels are wired through shared, main and preload", () => {
	for (const channel of ['projectsListWslDirectory: "projects:list-wsl-directory"', 'projectsAddWslPath: "projects:add-wsl-path"']) {
		assert.ok(shared.includes(channel), `shared/ipc.ts 缺通道：${channel}`);
	}
	assert.match(ipc, /ipcMain\.handle\(ipcChannels\.projectsListWslDirectory/);
	assert.match(ipc, /ipcMain\.handle\(ipcChannels\.projectsAddWslPath/);
	assert.match(preload, /listWslDirectory: \(path: string, hostId\?: string\) => ipcRenderer\.invoke\(ipcChannels\.projectsListWslDirectory/);
	assert.match(preload, /addWslPath: \(path: string, hostId\?: string\) => ipcRenderer\.invoke\(ipcChannels\.projectsAddWslPath/);
	// 走系统对话框的旧通道整体退役，不留「点了必报错」的入口。
	assert.doesNotMatch(shared, /projectsAddWsl:/);
	assert.doesNotMatch(preload, /addWsl:/);
});

test("main resolves the profile itself and validates the directory inside the distro", () => {
	assert.match(ipc, /createWslHostStore\(userDataDir\)/);
	// 渲染层只给路径 + 可选档案 id；发行版/用户一律主进程解析。
	assert.match(ipc, /listWslDirectory\(\{ distro: target\.distro, user: target\.user, path \}\)/);
	// 入库前在发行版内校验（Windows 的 stat 对 UNC 会假报存在/EACCES），路径转规范 UNC 只发生在这一刻。
	assert.match(ipc, /const listed = await listWslDirectory/);
	assert.match(ipc, /projectStore\.add\(projectPath, undefined, "wsl", target\.identity\)/);
	// 项目保存显式档案身份；缺省档案时保持旧行为（回退全局 distro/user）。
	assert.match(store, /wslIdentity\?: WslProjectIdentity/);
	assert.match(store, /wslHostId: wslIdentity\.hostId/);
});

test("in-distro picker：drvfs（/mnt/盘符）入盘符路径，其余入规范 UNC", () => {
	// 回归：入 UNC 的 /mnt/c 目录在 Windows 侧 stat 是 EPERM（目录不存在），
	// 当 pi 子进程 cwd 是 spawn ENOENT（会话启动失败），git 探测也全挂。
	assert.match(ipc, /mountedDriveToWindowsPath\(listed\.value\.path\) \?\? linuxPathToWslUnc\(listed\.value\.path, target\.distro\)/);
});

test("the system folder dialog is no longer handed a WSL path", () => {
	assert.doesNotMatch(store, /normalizeSelectedWslProjectPath|windowsHome/);
	assert.match(store, /async chooseAndAdd\(\) \{/);
});

test("global add-project branches to the picker when WSL mode is on", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(app, /if \(settings\.wslEnabled === true\) \{\s*setWslProjectPicker\(\{\}\);\s*return;\s*\}/);
	assert.match(app, /<WslProjectPickerDialog/);
});

test("entry points open the picker: the profile row and the global add", () => {
	assert.match(tab, /openWslProjectPicker\(\{ hostId: host\.id \}\)/);
	assert.match(tab, /settings\.connections\.wsl\.addProject/);
	assert.doesNotMatch(tab, /desktopApi\.projects\.addWsl\(/);
	assert.match(dialog, /desktopApi\.projects\.listWslDirectory\(next \?\? "", hostId\)/);
	assert.match(dialog, /desktopApi\.projects\.addWslPath\(path, hostId\)/);
});
