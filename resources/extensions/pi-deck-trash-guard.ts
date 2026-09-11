/**
 * PiDeck Trash Guard Extension（回收站守卫）
 *
 * 拦截 bash 工具调用中的删除类命令（rm / unlink / rmdir / del / rd / erase /
 * Remove-Item 等），在原命令执行前把每个目标复制一份送进系统回收站，然后
 * 一律放行原命令 —— 即「删除照常发生，但回收站里留一份底」。
 *
 * 多平台回收站写入（零第三方依赖，全部 node 内置 + 系统自带工具）：
 * - Windows：PowerShell + Microsoft.VisualBasic.FileIO.FileSystem
 *   （DeleteFile/DeleteDirectory + SendToRecycleBin），脚本经
 *   -EncodedCommand（UTF-16LE base64）传入，天然免疫路径注入；
 * - macOS：osascript 让 Finder delete（进废纸篓）；
 * - Linux：优先 gio trash（XDG Trash 规范），缺失时回退 trash-put。
 *
 * 设计约束：
 * - 本文件自包含：只依赖 @earendil-works/pi-coding-agent（仅类型）与 node
 *   内置模块，不 import PiDeck 源码（扩展在 pi 进程内加载）。
 * - 副本先落到 os.tmpdir() 暂存目录再送回收站：这样原文件所在卷与回收站
 *   卷解耦（跨卷回收站语义由暂存区所在卷承担），且原文件在备份期间不动。
 * - 永不阻断 agent：任何内部错误只记 stderr 后放行；找不到目标/目标过大
 *   也直接放行（删除不被守卫，行为与未装本扩展一致）。
 * - 备份上限：单文件 100MB、单次调用累计 500MB、目录深 24 层，防止
 *   `rm -rf node_modules` 之类把回收站/暂存盘撑爆。超限目标跳过并告警。
 * - 开关：PIDECK_TRASH_GUARD=off|0|false 关闭；未设置或其它值默认开启。
 *
 * 已知边界（解析层面刻意不做，避免误伤）：
 * - 不解析 `find -delete` / `git clean` / `xargs rm` / 变量展开等间接删除，
 *   只认「命令字面量 + 静态路径」这一层；这部分删除不受守卫。
 * - glob 只展开最后一段通配（`*.log` / `build/*.js`）；含 `**` 或目录段
 *   通配的按无匹配处理（照常删除但不备份），并记 stderr 告警。
 */

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// ── 常量 ──

/** 单文件备份上限：100MB */
const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** 单次工具调用累计备份上限：500MB */
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
/** 目录递归深度上限 */
const MAX_DIR_DEPTH = 24;
/** 回收站写入超时（系统命令挂死时不能卡住 agent） */
const TRASH_TIMEOUT_MS = 20_000;
/** 暂存目录名（os.tmpdir() 下） */
const STAGING_ROOT = "pi-deck-trash-guard";

const LOG_PREFIX = "[pi-deck-trash-guard]";

/** POSIX 删除族：目标参数以 `-` 开头视为标志（rmdir 归入 Windows 族：/ 标志） */
const POSIX_DELETE_COMMANDS = new Set(["rm", "unlink"]);
/** Windows 删除族（cmd/powershell 风格）：目标参数以 `/` 开头视为标志 */
const WINDOWS_DELETE_COMMANDS = new Set(["del", "erase", "rd", "rmdir"]);
/** PowerShell 删除族：目标参数以 `-` 开头视为标志 */
const POWERSHELL_DELETE_COMMANDS = new Set(["remove-item", "ri"]);
/**
 * 删除命令前可出现的前缀包装（跳过后继续识别）。
 * 注意：跨平台集合统一小写比较；rmdir 在 POSIX/Windows 都存在，按
 * 「-/ 标志都能匹配」处理（见 isFlagToken）。
 */
const COMMAND_PREFIXES = new Set(["sudo", "doas", "nohup", "command", "exec"]);

/** 供测试断言的平台判定 */
export function platformTrashKind(
	platform: string,
): "powershell" | "osascript" | "gio" | "unsupported" {
	if (platform === "win32") return "powershell";
	if (platform === "darwin") return "osascript";
	if (platform === "linux") return "gio";
	return "unsupported";
}

/** 环境变量开关：off/0/false 关闭，其余（含未设置）默认开启 */
export function isGuardEnabled(envValue: string | undefined): boolean {
	const v = (envValue ?? "").trim().toLowerCase();
	return !(v === "off" || v === "0" || v === "false" || v === "no");
}

// ── shell 词法（纯函数，供单测） ──

/**
 * 把命令按 shell 分隔符切成段：&&、||、;、|、&、换行、括号。
 * 引号内的分隔符不切（`rm "a;b"` 是一个目标）。
 */
export function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escape = false;
	const push = () => {
		if (current.trim()) segments.push(current.trim());
		current = "";
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (escape) {
			current += ch;
			escape = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			current += ch;
			escape = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "(" || ch === ")") {
			// && / || 是两个字符，但切开后空段自然被 push() 的 trim 过滤
			push();
			continue;
		}
		current += ch;
	}
	push();
	return segments;
}

/**
 * 引号感知分词：返回裸 token（引号已剥、反斜杠转义已解）。
 * 双引号内保留 `\` 除非其后是 " \ $ `（与 bash 语义一致，Windows 路径
 * `rm "C:\foo\bar"` 中的 \b 不被吞）。
 */
export function tokenizeSegment(segment: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let hasToken = false;
	let quote: '"' | "'" | null = null;
	let escape = false;
	const flush = () => {
		if (hasToken) {
			tokens.push(token);
			token = "";
			hasToken = false;
		}
	};
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		// 非引号区的反斜杠转义（bash 语义：\x → x，Windows 反斜杠路径在
		// 未加引号时本来就会被真实 shell 吃掉，这里保持一致）
		if (escape) {
			token += ch;
			hasToken = true;
			escape = false;
			continue;
		}
		// 单引号：原样保留一切直到闭合
		if (quote === "'") {
			if (ch === "'") quote = null;
			else {
				token += ch;
				hasToken = true;
			}
			continue;
		}
		// 双引号：反斜杠仅转义 " \ $ `，其余（Windows 路径分隔符）原样保留
		if (quote === '"') {
			if (ch === '"') {
				quote = null;
				continue;
			}
			if (ch === "\\") {
				const next = segment[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					token += next;
					i++;
				} else {
					token += ch;
				}
				hasToken = true;
				continue;
			}
			token += ch;
			hasToken = true;
			continue;
		}
		if (ch === "\\") {
			escape = true;
			hasToken = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			hasToken = true;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		token += ch;
		hasToken = true;
	}
	flush();
	return tokens;
}

/** 该命令族的目标参数里，什么前缀算标志 */
function isFlagToken(command: string, token: string): boolean {
	if (POSIX_DELETE_COMMANDS.has(command) || POWERSHELL_DELETE_COMMANDS.has(command)) {
		return token.startsWith("-") && token.length > 1;
	}
	if (WINDOWS_DELETE_COMMANDS.has(command)) {
		return token.startsWith("/") && token.length > 1;
	}
	return false;
}

/** 重定向符：其后一个 token 是重定向目标，不是删除对象 */
const REDIRECTIONS = new Set([">", ">>", "<", "2>", "2>>", "&>", "&>>"]);

/**
 * 重定向 token 识别（含无空格写法）：`2>&1`、`2>err.log`、`>&2`、`1>&2` 等。
 * 真实文件名不可能以数字+>& 开头出现在 shell 词法里（shell 自己就按重定向解析）。
 */
function isRedirectToken(token: string): boolean {
	return (
		REDIRECTIONS.has(token) ||
		/^[0-9]*&?>/.test(token) || // 2>&1 / 2>err.log / &>out / >
		/^[0-9]*>&[0-9]+$/.test(token) || // 1>&2
		/^>/.test(token) // >out.log / >>out.log
	);
}

/**
 * 从单段命令中提取删除类命令的目标 token（相对/绝对路径字面量）。
 * - 跳过前缀包装（sudo 等）后按命令字识别删除族；
 * - 丢弃标志（-/ 前缀按命令族判断）、`--` 及其后的标志、重定向目标；
 * - -Path/-LiteralPath 的值是路径，保留（前一个 token 已被当标志丢弃）。
 */
export function extractDeleteTargets(segment: string): string[] {
	const tokens = tokenizeSegment(segment);
	if (tokens.length === 0) return [];
	let index = 0;
	// 跳过 sudo / nohup 等前缀包装
	while (index < tokens.length && COMMAND_PREFIXES.has(tokens[index].toLowerCase())) {
		index++;
	}
	if (index >= tokens.length) return [];
	const rawCommand = tokens[index].toLowerCase();
	// 去掉 powershell 别名可能的路径形式（如 /usr/bin/rm）
	const command = rawCommand.includes("/") ? basename(rawCommand).toLowerCase() : rawCommand;
	const isDelete =
		POSIX_DELETE_COMMANDS.has(command) ||
		WINDOWS_DELETE_COMMANDS.has(command) ||
		POWERSHELL_DELETE_COMMANDS.has(command);
	if (!isDelete) return [];
	index++; // 跳过命令字

	const targets: string[] = [];
	let flagsEnded = false; // 遇到 `--` 后全部按目标处理
	while (index < tokens.length) {
		const token = tokens[index];
		index++;
		if (!flagsEnded && token === "--") {
			flagsEnded = true;
			continue;
		}
		if (!flagsEnded && isFlagToken(command, token)) {
			// -Path x / -LiteralPath x / -Filter x：下一个 token 是参数值。
			// -Path/-LiteralPath 的值是真目标 → 保留；-Filter 的值不是
			// 独立文件 → 连同下一个 token 一起丢弃。
			if (POWERSHELL_DELETE_COMMANDS.has(command)) {
				const lower = token.toLowerCase();
				if (lower === "-path" || lower === "-literalpath") continue; // 值留给下一轮当目标
				if (lower === "-filter" && index < tokens.length) index++; // 值丢弃
			}
			continue;
		}
		if (isRedirectToken(token)) {
			// 独立重定向符（> / >> / < / 2> / &>）的下一个 token 是重定向目标 → 丢弃；
			// fd 复制型（2>&1）与紧凑型（2>err.log）已含目标，后面不跟独立目标
			if (index < tokens.length && REDIRECTIONS.has(token)) index++;
			continue;
		}
		targets.push(token);
	}
	return targets;
}

/**
 * 展开最后一段通配的 glob（`*.log`、`build/*.js`、`?`、`[abc]`）。
 * - 无通配 → 原样返回；
 * - 含 `**` 或目录段通配 → 返回 []（不支持，调用方告警）；
 * - 与 shell 语义一致：`*` 不匹配隐藏文件（除非模式本身以 `.` 开头）。
 */
export function expandGlobTarget(target: string, cwd: string): string[] {
	const hasWildcard = /[*?[]/.test(target);
	if (!hasWildcard) return [target];
	if (target.includes("**")) return [];
	const dir = dirname(target);
	const pattern = basename(target);
	const baseDir = dir && dir !== "." ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : cwd;
	let entries: string[];
	try {
		entries = readdirSync(baseDir);
	} catch {
		return [];
	}
	const matchHidden = pattern.startsWith(".");
	const regex = new RegExp(
		"^" +
			pattern
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, "[^/]*")
				.replace(/\?/g, "[^/]") +
			"$",
	);
	return entries
		.filter((entry) => (matchHidden || !entry.startsWith(".")) && regex.test(entry))
		.map((entry) => join(dir === "." ? "" : dir, entry));
}

/**
 * 汇总一次 bash 调用的全部删除目标：
 * 分段 → 提取 → 相对路径基于 cwd 绝对化 → glob 展开 → 过滤存在项 → 去重。
 */
export function collectDeleteTargets(command: string, cwd: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const segment of splitShellSegments(command)) {
		for (const raw of extractDeleteTargets(segment)) {
			const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw);
			for (const expanded of expandGlobTarget(absolute, cwd)) {
				const key = expanded.replace(/[\\/]+$/, "");
				if (!seen.has(key) && existsSync(expanded)) {
					seen.add(key);
					result.push(expanded);
				}
			}
		}
	}
	return result;
}

// ── 体积评估 ──

/**
 * 递归统计目标体积。超限返回 Infinity（提前剪枝）；路径消失返回 -1。
 * 目录深度超限同样视为超限（防符号链接环/超深树拖垮遍历）。
 */
function measureSize(target: string, depth: number): number {
	let stat;
	try {
		stat = statSync(target);
	} catch {
		return -1; // 备份期间消失：跳过
	}
	if (!stat.isDirectory()) return stat.size;
	if (depth > MAX_DIR_DEPTH) return Number.POSITIVE_INFINITY;
	let total = 0;
	let entries: string[];
	try {
		entries = readdirSync(target);
	} catch {
		return stat.size; // 不可读目录：至少保住目录节点本身的大小估计
	}
	for (const entry of entries) {
		const size = measureSize(join(target, entry), depth + 1);
		if (size === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
		if (size < 0) continue;
		total += size;
		if (total > MAX_TOTAL_BYTES) return Number.POSITIVE_INFINITY;
	}
	return total;
}

/** 目标是否值得备份（存在、单文件 ≤ 上限、总量 ≤ 上限、深度 ≤ 上限） */
function isBackupCandidate(target: string, currentTotal: number): boolean {
	try {
		const stat = statSync(target);
		if (!stat.isDirectory()) {
			return stat.size <= MAX_FILE_BYTES && currentTotal + stat.size <= MAX_TOTAL_BYTES;
		}
	} catch {
		return false;
	}
	return measureSize(target, 0) <= MAX_TOTAL_BYTES;
}

// ── 暂存与回收站写入 ──

function log(message: string): void {
	process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

/** 带超时的子进程执行（数组参数，杜绝注入） */
function runCommand(
	file: string,
	args: string[],
	timeoutMs: number,
): Promise<{ code: number; stderr: string }> {
	return new Promise((resolvePromise) => {
		let stderr = "";
		let settled = false;
		const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"] });
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise({ code, stderr });
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(-1);
		}, timeoutMs);
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", () => finish(-2)); // ENOENT 等
		child.on("close", (code) => finish(code ?? -1));
	});
}

/** Windows：VB FileIO SendToRecycleBin（脚本整体 base64，免疫注入） */
async function trashViaPowerShell(paths: string[], directories: Set<string>): Promise<void> {
	const lines = [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null",
		...paths.map((path) =>
			directories.has(path)
				? `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${path.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`
				: `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${path.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`,
		),
	].join("\r\n");
	// -EncodedCommand 要求 UTF-16LE base64
	const encoded = Buffer.from(lines, "utf16le").toString("base64");
	const { code, stderr } = await runCommand(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
		TRASH_TIMEOUT_MS,
	);
	if (code !== 0) throw new Error(`powershell trash failed (code=${code}): ${stderr.slice(0, 500)}`);
}

/** macOS：Finder delete（进废纸篓而不是直接删） */
async function trashViaOsascript(paths: string[]): Promise<void> {
	const escapeAppleScript = (path: string) => path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const items = paths.map((path) => `POSIX file "${escapeAppleScript(path)}"`).join(", ");
	const script = `tell application "Finder" to delete {${items}}`;
	const { code, stderr } = await runCommand("osascript", ["-e", script], TRASH_TIMEOUT_MS);
	if (code !== 0) throw new Error(`osascript trash failed (code=${code}): ${stderr.slice(0, 500)}`);
}

/** Linux：gio trash（XDG），缺失时回退 trash-put */
async function trashViaGio(paths: string[]): Promise<void> {
	let result = await runCommand("gio", ["trash", "--", ...paths], TRASH_TIMEOUT_MS);
	if (result.code === -2) {
		// gio 不存在 → trash-put（trash-cli）
		result = await runCommand("trash-put", ["--", ...paths], TRASH_TIMEOUT_MS);
	}
	if (result.code !== 0) {
		throw new Error(`gio/trash-put trash failed (code=${result.code}): ${result.stderr.slice(0, 500)}`);
	}
}

async function moveToTrash(paths: string[], directories: Set<string>): Promise<void> {
	const kind = platformTrashKind(process.platform);
	if (paths.length === 0) return;
	if (kind === "powershell") return trashViaPowerShell(paths, directories);
	if (kind === "osascript") return trashViaOsascript(paths);
	if (kind === "gio") return trashViaGio(paths);
	throw new Error(`unsupported platform: ${process.platform}`);
}

// ── 单目标备份：复制到暂存区 → 送回收站 ──

let stagingSeq = 0;

async function backupTarget(target: string, currentTotal: number): Promise<boolean> {
	if (!isBackupCandidate(target, currentTotal)) {
		log(`跳过备份（过大/超深/已消失）: ${target}`);
		return false;
	}
	// 暂存区：tmpdir()/pi-deck-trash-guard/<batch>/，按序号命名避免重名
	const batchDir = process.env.PIDECK_TRASH_GUARD_STAGING_DIR || join(tmpdir(), STAGING_ROOT);
	const staged = join(batchDir, `${Date.now()}-${++stagingSeq}-${basename(target)}`);
	try {
		mkdirSync(batchDir, { recursive: true });
		cpSync(target, staged, { recursive: true });
		const stat = statSync(staged);
		await moveToTrash([staged], new Set([stat.isDirectory() ? staged : ""]));
		return true;
	} catch (error) {
		log(`备份失败（删除将不受守卫继续执行）: ${target} — ${String(error)}`);
		// 清掉暂存残留，不留垃圾
		try {
			rmSync(staged, { recursive: true, force: true });
		} catch {
			/* 忽略 */
		}
		return false;
	}
}

// ── 入口 ──

export default async function trashGuardExtension(pi: ExtensionAPI) {
	// 旧版 PiDeck / 独立 CLI 也会加载：默认开启，显式环境变量关闭
	if (!isGuardEnabled(process.env.PIDECK_TRASH_GUARD)) {
		return;
	}

	pi.on("tool_call", async (event: ToolCallEvent) => {
		// 删除只可能来自 bash（pi 内置工具无 remove/delete 专用工具）
		if (event.toolName !== "bash") return undefined;
		const input = event.input as Record<string, unknown>;
		const command = typeof input?.command === "string" ? input.command : "";
		if (!command.trim()) return undefined;

		try {
			const targets = collectDeleteTargets(command, process.cwd());
			if (targets.length === 0) return undefined;

			let total = 0;
			const backedUp: string[] = [];
			for (const target of targets) {
				const ok = await backupTarget(target, total);
				if (ok) {
					backedUp.push(target);
					try {
						total += statSync(target).size;
					} catch {
						/* 目标刚被并发删掉：只影响计数 */
					}
				}
			}
			if (backedUp.length > 0) {
				log(`已送回收站 ${backedUp.length} 项: ${backedUp.join(", ")}`);
			}
		} catch (error) {
			// 守卫本身出错绝不能阻断 agent
			log(`内部错误（放行原命令）: ${String(error)}`);
		}
		// 一律放行：原删除命令照常执行
		return undefined;
	});
}
