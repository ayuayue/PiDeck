import { existsSync, readdirSync, readFileSync } from "node:fs";

// 主进程启动链源码断言的读取面。index.ts 的装配块正按波次搬进 src/main/startup/，
// IPC handler 已按域搬进 src/main/ipc/；断言的是「主进程行为存在于某处」，
// 所以读取面要覆盖这些位置，否则每搬一块都要改上百个断言。
const entryPath = "src/main/index.ts";
const ipcDirectory = "src/main/ipc";
const startupDirectory = "src/main/startup";
const windowDirectory = "src/main/window";

function readDirectorySources(directory) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true })
		.filter((name) => String(name).endsWith(".ts"))
		.map(String)
		.sort()
		.map((name) => {
			const path = `${directory}/${name.split("\\").join("/")}`;
			return { path, source: readFileSync(path, "utf8") };
		});
}

// 启动装配面：index.ts 入口 + startup/ 分块 + window/ 窗口与生命周期分块，**不含** ipc/ 域实现。
// 边界型断言（「装配层不直接 ipcMain.handle」「开关只在装配层派生一次」）必须用它：
// 域实现搬进 src/main/ipc/ 正是这类断言要守住的分离，把 ipc/ 混进读取面会让守卫失效。
export const mainAssemblySources = [{ path: entryPath, source: readFileSync(entryPath, "utf8") }, ...readDirectorySources(startupDirectory), ...readDirectorySources(windowDirectory)];

export const mainAssemblySource = mainAssemblySources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");

export const mainIpcSources = [...mainAssemblySources, ...readDirectorySources(ipcDirectory)];

export const mainIpcSource = mainIpcSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
