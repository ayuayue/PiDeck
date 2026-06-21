import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { shell } from "electron";
import type { ExternalEditor } from "../../shared/types";

type EditorCandidate = {
	id: string;
	name: string;
	commands: string[];
	commonPaths: string[];
	args?: string[];
};

const WINDOWS_PROGRAM_FILES = [
	process.env.LOCALAPPDATA,
	process.env.ProgramFiles,
	process.env["ProgramFiles(x86)"],
].filter((value): value is string => Boolean(value));

const CANDIDATES: EditorCandidate[] = [
	{
		id: "vscode",
		name: "Visual Studio Code",
		// Windows 上 VS Code 的 code/code.cmd shim 可能启动后无窗口,优先使用 GUI 主程序 Code.exe。
		commands: process.platform === "win32" ? [] : ["code"],
		commonPaths: [
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Programs", "Microsoft VS Code", "Code.exe")),
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Microsoft VS Code", "Code.exe")),
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Programs", "Microsoft VS Code", "bin", "code.cmd")),
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Microsoft VS Code", "bin", "code.cmd")),
			"/usr/bin/code",
			"/usr/local/bin/code",
			"/snap/bin/code",
			"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
		],
	},
	{
		id: "cursor",
		name: "Cursor",
		commands: ["cursor", "cursor.cmd"],
		commonPaths: [
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Programs", "Cursor", "Cursor.exe")),
			"/usr/bin/cursor",
			"/usr/local/bin/cursor",
			"/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
		],
	},
	{
		id: "zed",
		name: "Zed",
		commands: ["zed", "zed.cmd"],
		commonPaths: [
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Programs", "Zed", "Zed.exe")),
			"/usr/bin/zed",
			"/usr/local/bin/zed",
			"/Applications/Zed.app/Contents/MacOS/cli",
		],
	},
	{
		id: "idea",
		name: "IntelliJ IDEA",
		commands: ["idea", "idea64.exe", "idea.bat"],
		commonPaths: [
			...WINDOWS_PROGRAM_FILES.flatMap((root) => [
				join(root, "JetBrains", "IntelliJ IDEA 2025.3", "bin", "idea64.exe"),
				join(root, "JetBrains", "IntelliJ IDEA 2025.2", "bin", "idea64.exe"),
				join(root, "JetBrains", "IntelliJ IDEA 2025.1", "bin", "idea64.exe"),
			]),
			"/usr/bin/idea",
			"/usr/local/bin/idea",
			"/Applications/IntelliJ IDEA.app/Contents/MacOS/idea",
		],
	},
	{
		id: "webstorm",
		name: "WebStorm",
		commands: ["webstorm", "webstorm64.exe", "webstorm.bat"],
		commonPaths: [
			...WINDOWS_PROGRAM_FILES.flatMap((root) => [
				join(root, "JetBrains", "WebStorm 2025.3", "bin", "webstorm64.exe"),
				join(root, "JetBrains", "WebStorm 2025.2", "bin", "webstorm64.exe"),
				join(root, "JetBrains", "WebStorm 2025.1", "bin", "webstorm64.exe"),
			]),
			"/usr/bin/webstorm",
			"/usr/local/bin/webstorm",
			"/Applications/WebStorm.app/Contents/MacOS/webstorm",
		],
	},
	{
		id: "phpstorm",
		name: "PhpStorm",
		commands: ["phpstorm", "phpstorm64.exe", "phpstorm.bat"],
		commonPaths: [
			...WINDOWS_PROGRAM_FILES.flatMap((root) => [
				join(root, "JetBrains", "PhpStorm 2025.3", "bin", "phpstorm64.exe"),
				join(root, "JetBrains", "PhpStorm 2025.2", "bin", "phpstorm64.exe"),
				join(root, "JetBrains", "PhpStorm 2025.1", "bin", "phpstorm64.exe"),
			]),
			"/usr/bin/phpstorm",
			"/usr/local/bin/phpstorm",
			"/Applications/PhpStorm.app/Contents/MacOS/phpstorm",
		],
	},
	{
		id: "pycharm",
		name: "PyCharm",
		commands: ["pycharm", "pycharm64.exe", "pycharm.bat"],
		commonPaths: [
			...WINDOWS_PROGRAM_FILES.flatMap((root) => [
				join(root, "JetBrains", "PyCharm 2025.3", "bin", "pycharm64.exe"),
				join(root, "JetBrains", "PyCharm 2025.2", "bin", "pycharm64.exe"),
			]),
			"/usr/bin/pycharm",
			"/usr/local/bin/pycharm",
			"/Applications/PyCharm.app/Contents/MacOS/pycharm",
		],
	},
];

async function exists(path: string) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function findOnPath(command: string) {
	const pathEnv = process.env.PATH ?? "";
	const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
		for (const ext of extensions) {
			const fullPath = join(dir, command.endsWith(ext) ? command : `${command}${ext}`);
			if (await exists(fullPath)) return fullPath;
		}
	}
	return null;
}

/** 检测本机常见编辑器，优先 PATH，其次常见安装目录。 */
export async function detectExternalEditors(): Promise<ExternalEditor[]> {
	const editors: ExternalEditor[] = [];
	const seen = new Set<string>();
	for (const candidate of CANDIDATES) {
		let command: string | null = null;
		let detectedFrom: ExternalEditor["detectedFrom"] = "path";
		for (const cli of candidate.commands) {
			command = await findOnPath(cli);
			if (command) break;
		}
		if (!command) {
			for (const commonPath of candidate.commonPaths) {
				if (await exists(commonPath)) {
					command = commonPath;
					detectedFrom = "common-path";
					break;
				}
			}
		}
		if (!command || seen.has(candidate.id)) continue;
		seen.add(candidate.id);
		editors.push({
			id: candidate.id,
			name: candidate.name,
			command,
			args: candidate.args,
			detectedFrom,
		});
	}
	return editors;
}

function quoteCmdArg(value: string) {
	return `"${value.replace(/"/g, '\\"')}"`;
}

export async function openProjectInEditor(editor: ExternalEditor, projectPath: string) {
	return new Promise<void>((resolve, reject) => {
		const needsCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(editor.command);
		const launchArgs = [...(editor.args ?? []), ...(editor.id === "vscode" ? ["--reuse-window"] : []), projectPath];
		const command = needsCmd ? (process.env.ComSpec || "cmd.exe") : editor.command;
		const args = needsCmd
			// Windows 批处理启动 GUI 程序时使用 start 更可靠；第一个空字符串是窗口标题占位。
			? ["/d", "/s", "/c", `start "" ${quoteCmdArg(editor.command)} ${launchArgs.map(quoteCmdArg).join(" ")}`]
			: launchArgs;

		// 打开外部编辑器问题常与 PATH、cmd shim、路径空格有关；保留控制台诊断信息方便用户反馈。
		console.log("[EditorDetector] launching editor", {
			editorId: editor.id,
			editorName: editor.name,
			command,
			args,
			originalCommand: editor.command,
			projectPath,
			needsCmd,
		});

		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			shell: false,
		});
		child.once("error", async (error) => {
			console.error("[EditorDetector] failed to launch editor", {
				editorId: editor.id,
				command,
				args,
				error,
			});
			// 部分 GUI 应用不适合 spawn 时,回退到系统打开路径,避免用户点击后无反馈。
			const fallbackError = await shell.openPath(projectPath);
			if (fallbackError) reject(error);
			else resolve();
		});
		child.once("spawn", () => {
			console.log("[EditorDetector] editor process spawned", {
				editorId: editor.id,
				pid: child.pid,
				command,
			});
			child.unref();
			resolve();
		});
		child.once("exit", (code, signal) => {
			console.log("[EditorDetector] editor launcher exited", {
				editorId: editor.id,
				code,
				signal,
			});
		});
	});
}
