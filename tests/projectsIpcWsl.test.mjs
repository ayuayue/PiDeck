import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");

test("projects:add 只服务 Windows 目录框；WSL 目录走发行版内选择器入库", () => {
	// 系统对话框递给主进程的 `\\wsl.localhost\<distro>\<home>` 按发行版默认用户鉴权，
	// root 档案的 /root 在 Windows 侧打不开——所以 projects:add 不再猜环境，直接无参入库。
	assert.match(source, /ipcMain\.handle\(ipcChannels\.projectsAdd, async \(\) => \{[\s\S]{0,400}?await projectStore\.chooseAndAdd\(\)/);
	// WSL 添加是独立通道，且入库前必须在发行版内校验目录真实存在（Windows 侧 stat 不可信）。
	assert.match(source, /ipcMain\.handle\(ipcChannels\.projectsAddWslPath, async \(_event, pathValue: unknown, hostIdValue: unknown\) => \{/);
	assert.match(source, /const target = await resolveWslBrowseTarget\(hostIdValue\);[\s\S]{0,200}?if \(target === null\) throw new Error\(mainCopy\("project\.wslEnvironmentUnavailable"\)\);/);
	assert.match(source, /const listed = await listWslDirectory\(\{ distro: target\.distro, user: target\.user, path \}\)/);
	// 身份由主进程解析：无档案 id 时回退「设置 → 开发 → Pi 来源」的全局开关；缺 distro/user 视为不可用。
	assert.match(source, /if \(settings\.wslEnabled !== true\) return null;/);
	assert.match(source, /const distro = String\(settings\.wslDistro \?\? ""\)\.trim\(\);/);
});

test("WSL 项目入库前先归一化路径：drvfs 存宿主盘符，其余存规范 UNC", () => {
	// /mnt/<盘符> 走 9P 在 Windows 侧 stat 会 EPERM（目录不存在）、git 探测失败、pi spawn cwd ENOENT。
	assert.match(source, /const projectPath = mountedDriveToWindowsPath\(listed\.value\.path\) \?\? linuxPathToWslUnc\(listed\.value\.path, target\.distro\);/);
	assert.match(source, /await projectStore\.add\(projectPath, undefined, "wsl", target\.identity\)/);
});

test("projects:add-by-path（右键直达）在全局 WSL 模式下按发行版规则归一化，不把 WSL 目录记成 windows", () => {
	// 早先这里不带 environment 入库，项目被记成 windows 环境，随后 getVisibleProjects 按环境过滤
	// 把它整条藏掉——表现为「添加了却找不到、打不开」。
	assert.match(source, /const wslDistro = process\.platform === "win32" && settings\.wslEnabled === true \? String\(settings\.wslDistro \?\? ""\)\.trim\(\) : "";/);
	assert.match(source, /normalized = normalizeWslProjectAddPath\(projectPath, wslDistro\);/);
	// 别的发行版的目录 / 宿主盘符目录都要明确报错，不能静默入库后消失。
	assert.match(source, /if \(isWslDistroMismatchError\(error\)\) throw new Error\(mainCopy\("project\.wslDistroMismatch", \{/);
	assert.match(source, /throw new Error\(mainCopy\("project\.windowsPathInWslMode"\)\);/);
	assert.match(source, /await projectStore\.add\(projectPath, undefined, wslDistro \? "wsl" : undefined\)/);
});

test("visible projects follow the global mode; remote and chat projects are exempt", () => {
	assert.match(source, /settings\.wslEnabled \? all\.filter\(/);
	assert.match(source, /isRemoteProject\(project\) \|\| project\.kind === "chat"/);
});
