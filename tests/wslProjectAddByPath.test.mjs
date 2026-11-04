/**
 * 回归：WSL 模式（用户报障：root 启动 WSL 时，按路径添加项目报「找不到 / 打不开 \\wsl 这种路径」）。
 *
 * `projects:add-by-path` 是右键菜单、快捷任务这类「不改目录选择框」的入口。它早先只做
 * stat + `projectStore.add(path)`，不带 environment：WSL 目录于是被记成 windows 项目，
 * 随后 getVisibleProjects 在 WSL 模式下按环境过滤，把刚加进去的项目整条藏掉。
 *
 * 这里锁三件事：
 * 1. 纯函数归一（UNC / WSL 绝对路径 / 宿主盘符路径 / 发行版不匹配）；
 * 2. handler 在 WSL 模式下带 environment 入库、并对宿主路径/跨发行版给出可读错误；
 * 3. ProjectStore 对同路径的旧记录改写 environment，否则「加过的目录」永远留在旧环境里。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { normalizeWslProjectAddPath, isWslDistroMismatchError } = loadTsCommonJs("src/main/wsl/WslPaths.ts");
const ipc = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");
const store = readFileSync("src/main/projects/ProjectStore.ts", "utf8");

test("\\wsl$ / \\wsl.localhost 两种 UNC 都归一成规范 UNC", () => {
	assert.equal(normalizeWslProjectAddPath("\\\\wsl$\\Debian\\root\\proj", "Debian"), "\\\\wsl.localhost\\Debian\\root\\proj");
	assert.equal(normalizeWslProjectAddPath("\\\\wsl.localhost\\Debian\\home\\me\\proj", "Debian"), "\\\\wsl.localhost\\Debian\\home\\me\\proj");
	// 正斜杠形态（浏览器/文件抽屉递过来的）同样识别
	assert.equal(normalizeWslProjectAddPath("//wsl.localhost/Debian/root/proj", "Debian"), "\\\\wsl.localhost\\Debian\\root\\proj");
	// 发行版名大小写不敏感
	assert.equal(normalizeWslProjectAddPath("\\\\wsl.localhost\\debian\\root\\proj", "Debian"), "\\\\wsl.localhost\\Debian\\root\\proj");
});

test("WSL 内的绝对 Linux 路径归一：发行版内转 UNC，/mnt 盘符转宿主盘符路径", () => {
	assert.equal(normalizeWslProjectAddPath("/root/proj", "Debian"), "\\\\wsl.localhost\\Debian\\root\\proj");
	assert.equal(normalizeWslProjectAddPath("/home/me/proj/", "Debian"), "\\\\wsl.localhost\\Debian\\home\\me\\proj");
	// drvfs 不能存 UNC：Windows 侧对 \\wsl.localhost\<distro>\mnt\c 的 stat 是 EPERM，
	// 当 pi 子进程 cwd 则是 spawn ENOENT（用户报障：目录不存在 + 会话启动失败 + Git 不可用）。
	assert.equal(normalizeWslProjectAddPath("/mnt/d/work/proj", "Debian"), "D:\\work\\proj");
	assert.equal(normalizeWslProjectAddPath("/mnt/c/Users/me", "Debian"), "C:\\Users\\me");
	assert.equal(normalizeWslProjectAddPath("\\\\wsl.localhost\\Debian\\mnt\\d\\work\\proj", "Debian"), "D:\\work\\proj");
});

test("宿主盘符路径返回 null（由 handler 给明确错误，不静默入库后消失）", () => {
	assert.equal(normalizeWslProjectAddPath("D:\\project\\demo", "Debian"), null);
	assert.equal(normalizeWslProjectAddPath("D:/project/demo", "Debian"), null);
	assert.equal(normalizeWslProjectAddPath("relative\\path", "Debian"), null);
});

test("发行版不匹配抛 WSL_DISTRO_MISMATCH", () => {
	assert.throws(
		() => normalizeWslProjectAddPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\proj", "Debian"),
		(error) => isWslDistroMismatchError(error) && String(error.message).includes("WSL_DISTRO_MISMATCH"),
	);
});

test("add-by-path 在 WSL 模式下按 wsl 环境入库，宿主路径直接报错", () => {
	const body = ipc.match(/ipcMain\.handle\(ipcChannels\.projectsAddByPath,[\s\S]*?\n\t\}\);/);
	assert.ok(body, "projectsAddByPath handler 未找到");
	assert.match(body[0], /settings\.wslEnabled === true/, "必须读全局 WSL 开关，否则 WSL 目录会被记成 windows 项目");
	assert.match(body[0], /normalizeWslProjectAddPath\(projectPath, wslDistro\)/);
	assert.match(body[0], /projectStore\.add\(projectPath, undefined, wslDistro \? "wsl" : undefined\)/, "入库必须带 environment，否则会被可见性过滤掉");
	assert.match(body[0], /mainCopy\("project\.windowsPathInWslMode"\)/);
	assert.match(body[0], /mainCopy\("project\.wslDistroMismatch"/);
	assert.match(body[0], /mainCopy\("project\.wslPathNotFound"/);
});

test("ProjectStore 重新添加同一目录时改写 environment（否则旧记录永远留在旧环境）", () => {
	assert.match(store, /\} else if \(environment !== undefined && existing\.environment !== environment\) \{[\s\S]*?existing\.environment = environment;/);
});
