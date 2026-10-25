import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { FileManagerInfo } from "../../shared/types/project";

/**
 * 文件管理器检测与打开（「打开方式」下拉的补充入口）。
 *
 * 平台策略：
 * - Windows：固定用系统资源管理器（explorer.exe），名称由渲染层按 i18n 显示；
 * - macOS：Finder（open 命令）；
 * - Linux：按常见文件管理器优先级从 PATH 检测（GNOME Files / Dolphin / Nemo /
 *   Thunar / PCManFM / Konqueror），取第一个命中，未命中回退 xdg-open。
 *
 * 检测逻辑抽成纯函数（platform + PATH + which 探针）便于单测。
 */

type FileManagerCandidate = {
	id: FileManagerInfo["id"];
	name: string;
	/** PATH 里的可执行名（Linux 无扩展名） */
	commands: string[];
};

const LINUX_CANDIDATES: FileManagerCandidate[] = [
	{ id: "nautilus", name: "Files", commands: ["nautilus"] },
	{ id: "dolphin", name: "Dolphin", commands: ["dolphin"] },
	{ id: "nemo", name: "Nemo", commands: ["nemo"] },
	{ id: "thunar", name: "Thunar", commands: ["thunar"] },
	{ id: "pcmanfm", name: "PCManFM", commands: ["pcmanfm-qt", "pcmanfm"] },
	{ id: "konqueror", name: "Konqueror", commands: ["konqueror"] },
];

/** PATH 上是否存在可执行命令（Linux 无扩展名；Windows 补 .exe 探测） */
export function findOnPath(command: string, pathEnv: string, platform: string): boolean {
	const extensions = platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
	const alreadyHasExt = platform === "win32" && /\.(exe|cmd|bat)$/i.test(command);
	const dirs = pathEnv.split(platform === "win32" ? ";" : ":").filter(Boolean);
	for (const dir of dirs) {
		if (alreadyHasExt) {
			if (existsSync(joinPath(dir, command))) return true;
			continue;
		}
		for (const ext of extensions) {
			if (existsSync(joinPath(dir, `${command}${ext}`))) return true;
		}
	}
	return false;
}

function joinPath(dir: string, name: string): string {
	// Windows 用反斜杠、POSIX 用斜杠连接（与 shell 路径分隔一致）
	const sep = dir.includes("/") && !dir.includes("\\") ? "/" : "\\";
	return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/**
 * 检测当前平台可用的文件管理器（纯函数：platform + PATH + which 探针注入）。
 * returns null 表示未检测到（调用方回退系统默认打开）。
 */
export function detectFileManagerForPlatform(platform: string, pathEnv: string, which: (command: string) => boolean): FileManagerInfo | null {
	if (platform === "win32") {
		return { id: "windows-explorer", name: "explorer", command: "explorer.exe" };
	}
	if (platform === "darwin") {
		return { id: "finder", name: "Finder", command: "open" };
	}
	for (const candidate of LINUX_CANDIDATES) {
		const command = candidate.commands.find((cmd) => which(cmd));
		if (command) {
			return { id: candidate.id, name: candidate.name, command };
		}
	}
	return null;
}

/** 当前平台的默认检测（生产调用点） */
export function detectFileManager(): FileManagerInfo | null {
	return detectFileManagerForPlatform(process.platform, process.env.PATH ?? "", (command) => findOnPath(command, process.env.PATH ?? "", process.platform));
}

/**
 * 在系统文件管理器中打开指定目录（目录存在性由调用方保证）。
 * 失败时抛错，渲染层 toast 提示。
 */
export function openFileManagerAt(path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const info = detectFileManager();
		if (!info) {
			// Linux 未检测到文件管理器：回退系统默认（目录由 xdg-open 打开）
			reject(new Error("no file manager detected"));
			return;
		}
		if (process.platform === "darwin") {
			const macChild = spawn("open", [path], { detached: true, stdio: "ignore" });
			// fire-and-forget 也必须有 error 兜底：未处理的 error 事件会直接炸主进程。
			macChild.once("error", (error) => reject(error));
			macChild.once("spawn", () => {
				macChild.unref();
				resolve();
			});
			return;
		}
		if (process.platform === "win32") {
			// explorer.exe 是 GUI 子系统程序：SystemRoot 未必在 PATH 里，裸命令
			// spawn 会 ENOENT 静默失败（表现就是「点了没反应」）；用绝对路径启动。
			const explorer = joinPath(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe");
			const winChild = spawn(explorer, [path], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			winChild.once("error", (error) => reject(error));
			winChild.once("spawn", () => {
				winChild.unref();
				resolve();
			});
			return;
		}
		const child = spawn(info.command, [path], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.once("error", (error) => reject(error));
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
