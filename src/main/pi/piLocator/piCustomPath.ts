import { existsSync } from "node:fs";
import { extname } from "node:path";
import { buildWslCommandMarker, isWslInteropPath } from "../../wsl/wslPiProbe";

/**
 * 用户输入路径域（PiLocator 拆分第二刀）：归一化 + 平台可执行性判定。
 *
 * 这里只回答「这串东西能不能当可执行入口」，不发起任何探测；宿主 `resolveCommand` /
 * `validateCustomPath` / `check` 共用同一套规则，避免 UI 校验、settings 保存和 agent 启动
 * 拿到不同的路径解释。注释都是现场结论（JSON 双反斜杠、.ps1、WSL 内路径），搬动时不要删。
 */

/**
 * 归一化用户粘贴的路径：去除首尾引号，兼容 JSON 风格双反斜杠，并在 Windows 下优先补全同目录 pi.cmd。
 * 这样 UI 校验、settings 保存和 agent 启动都使用同一条路径规则，避免不同入口行为不一致。
 */
export function normalizeCustomPath(rawPath?: string) {
	let value = rawPath?.trim() ?? "";
	if (!value) return "";

	const quotePairs: Array<[string, string]> = [
		['"', '"'],
		["'", "'"],
		["“", "”"],
		["‘", "’"],
	];
	let stripped = true;
	while (stripped && value.length >= 2) {
		stripped = false;
		for (const [left, right] of quotePairs) {
			if (value.startsWith(left) && value.endsWith(right)) {
				value = value.slice(left.length, -right.length).trim();
				stripped = true;
			}
		}
	}

	if (process.platform === "win32") {
		// 用户从 JSON/日志里复制时可能得到 D:\\foo\\pi.cmd；只在疑似 Windows 盘符/UNC 路径时折叠双反斜杠。
		if (/^(?:[a-zA-Z]:\\\\|\\\\\\\\)/.test(value)) {
			value = value.replace(/\\\\/g, "\\");
		}

		// npm 有时同时生成无扩展名脚本和 .cmd；Windows 启动 agent 时优先使用 .cmd shim，
		// 可避免裸 `pi` 被当作 shell 内部命令或文本文件处理。
		if (!extname(value)) {
			const cmdCandidate = `${value}.cmd`;
			if (existsSync(cmdCandidate)) return cmdCandidate;
			const exeCandidate = `${value}.exe`;
			if (existsSync(exeCandidate)) return exeCandidate;
		}
	}

	return value;
}

export function isUnsupportedPowerShellShim(command: string) {
	return process.platform === "win32" && command.trim().toLowerCase().endsWith(".ps1");
}

/**
 * win32 下无盘符的 Linux 绝对路径（/home/...）：不可能是 Windows 可执行文件，
 * 直接跑只会 ENOENT + 笼统文案。典型成因是 WSL 模式没落盘（设置草稿未提交）
 * 或用户在非 WSL 模式粘贴了 WSL 内路径（2026-09-17 用户反馈）。
 * 给出可行动的提示，而不是让用户对着 ENOENT 猜。
 */
export function isDrivelessLinuxPathOnWindows(command: string) {
	return process.platform === "win32" && command.startsWith("/");
}

/** 用户粘贴的 Linux 绝对路径在 WSL 模式下包装成内部 wsl:// 标记。双斜杠保留命令自身的首 `/`。 */
export function toWslCustomPath(command: string, wslEnabled?: boolean, wslDistro?: string, wslUser?: string): string | null {
	if (!command || !wslEnabled || process.platform !== "win32" || !wslDistro || !wslUser || !command.startsWith("/") || isWslInteropPath(command)) {
		return null;
	}
	return buildWslCommandMarker(wslDistro, wslUser, command);
}
