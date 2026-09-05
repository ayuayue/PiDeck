import { access, readdir } from "node:fs/promises";
import { basename, delimiter, dirname, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { shell } from "electron";
import {
	SUPPORTED_EXTERNAL_EDITORS,
	createDefaultExternalEditorSettings,
	type AppSettings,
	type ExternalEditor,
	type ExternalEditorId,
	type ExternalEditorSettings,
} from "../../shared/types";

type EditorCandidate = {
	id: ExternalEditorId;
	name: string;
	commands: string[];
	commonPaths: string[];
	windowsExecutableNames?: string[];
	windowsRegistryNames?: string[];
	args?: string[];
	/**
	 * JetBrains 系安装目录带版本号（IntelliJ IDEA 2026.1 / Community 等），
	 * 且用户可装在 $LOCALAPPDATA\Programs 根下（不带 JetBrains 父目录）。
	 * 提供这两个字段后，常规路径未命中时扫描 Programs 根下的
	 * `{prefix}*\bin\{exe}` 与 `JetBrains\{prefix}*\bin\{exe}` 通配目录。
	 */
	programsNamePrefixes?: string[];
	programsExeName?: string;
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
		// 先查 PATH，覆盖用户自定义安装目录；再查 GUI 主程序，兼顾默认安装和未配置 PATH 的场景。
		commands: process.platform === "win32" ? ["code", "code.cmd"] : ["code"],
		commonPaths: [
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Programs", "Microsoft VS Code", "Code.exe")),
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Microsoft VS Code", "Code.exe")),
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Programs", "Microsoft VS Code", "bin", "code.cmd")),
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Microsoft VS Code", "bin", "code.cmd")),
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe")),
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Programs", "Microsoft VS Code Insiders", "bin", "code-insiders.cmd")),
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Programs", "VSCodium", "VSCodium.exe")),
			...WINDOWS_PROGRAM_FILES.map((root) => join(root, "Programs", "VSCodium", "bin", "codium.cmd")),
			"/usr/bin/code",
			"/usr/local/bin/code",
			"/snap/bin/code",
			"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
		],
		windowsExecutableNames: ["Code.exe", "code.cmd"],
		windowsRegistryNames: ["visual studio code", "microsoft visual studio code"],
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
		windowsExecutableNames: ["Cursor.exe", "cursor.cmd"],
		windowsRegistryNames: ["cursor"],
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
		windowsExecutableNames: ["Zed.exe", "zed.cmd"],
		windowsRegistryNames: ["zed"],
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
		windowsExecutableNames: ["idea64.exe", "idea.bat"],
		windowsRegistryNames: ["intellij idea"],
		// 版本号目录通配扫描：覆盖 2026.x/Community 等非固定版本路径
		programsNamePrefixes: ["IntelliJ IDEA"],
		programsExeName: "idea64.exe",
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
		windowsExecutableNames: ["webstorm64.exe", "webstorm.bat"],
		windowsRegistryNames: ["webstorm"],
		programsNamePrefixes: ["WebStorm"],
		programsExeName: "webstorm64.exe",
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
		windowsExecutableNames: ["phpstorm64.exe", "phpstorm.bat"],
		windowsRegistryNames: ["phpstorm"],
		programsNamePrefixes: ["PhpStorm"],
		programsExeName: "phpstorm64.exe",
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
		windowsExecutableNames: ["pycharm64.exe", "pycharm.bat"],
		windowsRegistryNames: ["pycharm"],
		programsNamePrefixes: ["PyCharm"],
		programsExeName: "pycharm64.exe",
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
	// Windows 上仅匹配可执行扩展，避免把跨平台包中的 bin/code(shell 启动脚本)
	// 误判为可启动程序——这类文件 spawn 时会抛 ENOENT 后回退打开资源管理器。
	const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
	const alreadyHasWindowsExt = process.platform === "win32" && /\.(exe|cmd|bat)$/i.test(command);
	for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
		if (alreadyHasWindowsExt) {
			const fullPath = join(dir, command);
			if (await exists(fullPath)) return fullPath;
			continue;
		}
		for (const ext of extensions) {
			const fullPath = join(dir, `${command}${ext}`);
			if (await exists(fullPath)) return fullPath;
		}
	}
	return null;
}

function runRegQuery(key: string) {
	return new Promise<string>((resolve) => {
		const child = spawn("reg", ["query", key, "/s"], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.once("error", () => resolve(""));
		child.once("close", () => resolve(output));
	});
}

function parseRegValue(block: string, name: string) {
	const match = block.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, "im"));
	return match?.[1]?.trim() ?? "";
}

function normalizeDisplayIcon(value: string) {
	const trimmed = value.trim().replace(/^"|"$/g, "");
	return trimmed.replace(/,-?\d+$/, "");
}

function isLaunchableRegistryPath(path: string, executableNames: string[]) {
	const extension = extname(path).toLowerCase();
	if (![".exe", ".cmd", ".bat"].includes(extension)) return false;
	const fileName = basename(path).toLowerCase();
	return executableNames.some((name) => name.toLowerCase() === fileName);
}

async function findInWindowsRegistry(candidate: EditorCandidate) {
	if (process.platform !== "win32") return null;
	const names = candidate.windowsRegistryNames ?? [];
	const executableNames = candidate.windowsExecutableNames ?? [];
	if (names.length === 0 || executableNames.length === 0) return null;

	const roots = [
		"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
		"HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
		"HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	];
	for (const root of roots) {
		const output = await runRegQuery(root);
		for (const block of output.split(/\r?\n(?=HKEY_)/)) {
			const displayName = parseRegValue(block, "DisplayName").toLowerCase();
			if (!displayName || !names.some((name) => displayName.includes(name))) continue;
			const displayIcon = normalizeDisplayIcon(parseRegValue(block, "DisplayIcon"));
			if (displayIcon && isLaunchableRegistryPath(displayIcon, executableNames) && await exists(displayIcon)) return displayIcon;
			const installLocation = parseRegValue(block, "InstallLocation");
			if (!installLocation) continue;
			for (const executableName of executableNames) {
				const executablePath = join(installLocation, executableName);
				if (await exists(executablePath)) return executablePath;
				const binPath = join(installLocation, "bin", executableName);
				if (await exists(binPath)) return binPath;
			}
		}
	}
	return null;
}

/**
 * 从 Programs 根目录条目里匹配安装目录名（大小写不敏感前缀匹配）。
 * 抽出为纯函数便于单测：传入 readdir 结果即可断言匹配规则。
 * 返回第一个匹配的目录名；无匹配返回 null。
 */
export function matchProgramsDirName(
	entries: string[],
	namePrefixes: string[],
): string | null {
	for (const entry of entries) {
		if (namePrefixes.some((prefix) => entry.toLowerCase().startsWith(prefix.toLowerCase()))) {
			return entry;
		}
	}
	return null;
}

/**
 * 扫描 Programs 根目录（含 $LOCALAPPDATA\Programs / ProgramFiles(x86)）下的
 * JetBrains 系安装：直接子目录 `{prefix}*` 或 `JetBrains\{prefix}*`，
 * 命中后校验 `bin\{exeName}` 是否存在。
 */
async function findInProgramsByPrefix(
	candidate: EditorCandidate,
): Promise<string | null> {
	const prefixes = candidate.programsNamePrefixes ?? [];
	const exeName = candidate.programsExeName;
	if (prefixes.length === 0 || !exeName) return null;
	for (const root of WINDOWS_PROGRAM_FILES) {
		// 扫描点：安装根自身、Programs 子目录（$LOCALAPPDATA\Programs 等，用户不带 JetBrains 父目录时）、
		// 以及 JetBrains 子目录。覆盖「Programs 根下 {prefix}*」与「JetBrains/{prefix}*」两种版本目录。
		for (const dir of [root, join(root, "Programs"), join(root, "JetBrains")]) {
			let entries: string[];
			try {
				entries = await readdir(dir);
			} catch {
				// 目录不存在/无权限：跳过该扫描点
				continue;
			}
			const matched = matchProgramsDirName(entries, prefixes);
			if (!matched) continue;
			const executablePath = join(dir, matched, "bin", exeName);
			if (await exists(executablePath)) return executablePath;
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
		if (!command) {
			command = await findInWindowsRegistry(candidate);
			if (command) detectedFrom = "common-path";
		}
		// JetBrains 系版本目录不固定：常规路径/注册表未命中时，
		// 扫描 Programs 根下 `{产品名}*\bin\{exe}` 通配目录（如 IntelliJ IDEA 2026.1）。
		if (!command && candidate.programsNamePrefixes) {
			command = await findInProgramsByPrefix(candidate);
			if (command) detectedFrom = "common-path";
		}
		if (!command) {
			continue;
		}
		if (seen.has(candidate.id)) continue;
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

export function mergeDetectedExternalEditors(
	current: ExternalEditorSettings | undefined,
	detected: ExternalEditor[],
): ExternalEditorSettings {
	const next: ExternalEditorSettings = {
		...createDefaultExternalEditorSettings(),
		...(current ?? {}),
	};
	for (const editor of detected) {
		const existing = next[editor.id];
		if (existing?.detectedFrom === "manual" && existing.command) continue;
		next[editor.id] = {
			enabled: true,
			command: editor.command,
			detectedFrom: editor.detectedFrom,
			updatedAt: Date.now(),
		};
	}
	return next;
}

export async function listConfiguredExternalEditors(settings: AppSettings): Promise<ExternalEditor[]> {
	const editors: ExternalEditor[] = [];
	for (const definition of SUPPORTED_EXTERNAL_EDITORS) {
		const configured = settings.externalEditors[definition.id];
		if (!configured?.enabled || !configured.command) continue;
		// 仅 exists() 通过不足以判断能否在 Windows 上 spawn(bin/code 文件存在但无法执行),
		// 因此先尝试把 stored command 解析成真正可启动路径再决定是否在下拉里展示。
		const resolved = await resolveLaunchableCommand(configured.command);
		if (!resolved) continue;
		if (!(await exists(resolved))) continue;
		editors.push({
			id: definition.id,
			name: definition.name,
			command: resolved,
			detectedFrom: configured.detectedFrom ?? "manual",
		});
	}
	return editors;
}

export async function validateExternalEditorCommand(command: string) {
	const trimmed = command.trim();
	return {
		valid: Boolean(trimmed) && await exists(trimmed),
		command: trimmed,
	};
}

function quoteCmdArg(value: string) {
	return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Windows 下把存储的编辑器启动命令解析成真正可被 CreateProcess 启动的路径。
 *
 * 历史版本曾把 bin/code(shell 启动脚本,#!/usr/bin/env sh)当作可执行项存储,
 * 直接 spawn 会抛 ENOENT -> shell.openPath 回退 -> 打开资源管理器。
 *
 * 解析策略（按优先级）:
 * 1. 已是 .exe 且存在 -> 直接返回,绕过 cmd/start 带来的任何权限问题。
 * 2. 否则优先查 bin 目录上一级的 GUI 主程序(如 Code.exe),仍走直接 spawn。
 * 3. 仍未命中时,对无扩展或非 Windows 可执行格式的命令尝试同名
 *    .cmd/.bat/.exe 兄弟,最后回退到自身(仅 .cmd/.bat 情形)。
 *
 * 返回 null 表示无法在 Windows 上启动,调用方负责回退/跳过。
 */
async function resolveLaunchableCommand(command: string): Promise<string | null> {
	if (process.platform !== "win32") return command;
	const ext = extname(command).toLowerCase();
	// 已是 .exe 且存在:最佳路径,不再依赖 start/cmd
	if (ext === ".exe") {
		return (await exists(command)) ? command : null;
	}
	// 优先查 bin/<name> 上一级的 Code.exe 等 GUI 主程序,避免走
	// cmd/start 链。某些环境下 start 对所有程序返回“拒绝访问”。
	const dir = dirname(command);
	const guiCandidates = [
		join(dir, "..", "Code.exe"),
		join(dir, "..", "Code - Insiders.exe"),
		join(dir, "..", "VSCodium.exe"),
	];
	for (const candidate of guiCandidates) {
		if (await exists(candidate)) return candidate;
	}
	// 若不是 .cmd/.bat/.exe(如 bin/code 无扩展的 shell 脚本),
	// 尝试同目录下 .cmd/.bat/.exe 兄弟。
	if (ext !== ".cmd" && ext !== ".bat") {
		for (const candidate of [`${command}.cmd`, `${command}.bat`, `${command}.exe`]) {
			if (await exists(candidate)) return candidate;
		}
	}
	// .cmd/.bat 本身存在且上面没找到 GUI exe -> 原样返回,走 cmd start 路径。
	if (ext === ".cmd" || ext === ".bat") {
		return (await exists(command)) ? command : null;
	}
	return null;
}

/** 将 WSL Linux 路径转为 Windows 可访问格式，供外部编辑器使用 */
function toWindowsCompatiblePath(path: string): string {
	if (!path.startsWith("/")) return path;
	// /mnt/d/tmp → D:\tmp
	const mntMatch = path.match(/^\/mnt\/([a-z])\/(.*)/);
	if (mntMatch) {
		return `${mntMatch[1].toUpperCase()}:\\${mntMatch[2].replace(/\//g, '\\')}`;
	}
	// /home/user/... → \\wsl$\<distro>\home\user\...（通过 WSL 网络共享）
	// distro 无法从路径本身推断，回退到原路径（VS Code 可能通过 WSL remote 连接）
	return path;
}

export async function openProjectInEditor(editor: ExternalEditor, projectPath: string) {
	// 防御性解析:即便 listConfiguredExternalEditors 把 stored command 修好了,
	// 也兜底处理从历史 settings.json 直接传过来的 legacy editor 对象,避免
	// spawn 走 ENOENT 再回退打开资源管理器。
	const launchCommand = (await resolveLaunchableCommand(editor.command)) ?? editor.command;
	// WSL 项目路径转换：/mnt/d/tmp → D:\tmp，/home/user/... → \\wsl$\...\home\user\...
	const resolvedPath = toWindowsCompatiblePath(projectPath);
	return new Promise<void>((resolve, reject) => {
		const needsCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(launchCommand);
		const launchArgs = [...(editor.args ?? []), ...(editor.id === "vscode" ? ["--new-window"] : []), resolvedPath];
		const command = needsCmd ? (process.env.ComSpec || "cmd.exe") : launchCommand;
		const args = needsCmd
			// Windows 批处理启动 GUI 程序时使用 start 更可靠；第一个空字符串是窗口标题占位。
			? ["/d", "/s", "/c", `start "" ${quoteCmdArg(launchCommand)} ${launchArgs.map(quoteCmdArg).join(" ")}`]
			: launchArgs;

		// 打开外部编辑器问题常与 PATH、cmd shim、路径空格有关；保留控制台诊断信息方便用户反馈。
		console.log("[EditorDetector] launching editor", {
			editorId: editor.id,
			editorName: editor.name,
			command,
			args,
			originalCommand: editor.command,
			projectPath: resolvedPath,
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
