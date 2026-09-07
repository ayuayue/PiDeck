/**
 * WSL 可执行文件路径解析模块。
 * Phase 2.2: 从 index.ts 中提取。智能查找 wsl.exe：
 * 优先绝对路径（含 32-bit Sysnative 绕过），全部不存在时回退到 PATH。
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

let resolved: { command: string; shell: boolean } | null = null;

/**
 * 解码 wsl.exe 的 stdout。
 * Windows 10 1903+ 的 wsl.exe 以 UTF-16LE 输出（`wsl -l -q` 尤其明显），
 * 按 utf8 解码会得到字符间夹 NUL 的乱码，过滤后列表恒为空 —— 表现为设置页发行版下拉框空白。
 * 这里按 BOM / NUL 特征判定 UTF-16LE，其余按 UTF-8，并剥掉残留 NUL。
 */
export function decodeWslOutput(raw: Buffer | string): string {
	const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ""), "utf8");
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
		return buffer.subarray(2).toString("utf16le").replace(/\0/g, "");
	}
	// 无 BOM 但呈「ASCII + NUL」交替特征：同样是 UTF-16LE
	if (buffer.length >= 4 && buffer[1] === 0x00 && buffer[3] === 0x00) {
		return buffer.toString("utf16le").replace(/\0/g, "").replace(/^\ufeff/, "");
	}
	return buffer.toString("utf8").replace(/\0/g, "");
}

/**
 * 解析 `wsl -l -q` 输出为发行版名列表。
 * 过滤空行与含反斜杠的历史输出（旧版本会带 `\` 标记默认发行版）。
 */
export function parseWslDistroList(raw: Buffer | string): string[] {
	return decodeWslOutput(raw)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.includes("\\"));
}

export function getWslExe(): { command: string; shell: boolean } {
	if (resolved) return resolved;
	const root = process.env.SystemRoot || "C:\\Windows";
	const candidates = process.arch === "ia32"
		? [join(root, "Sysnative", "wsl.exe"), join(root, "System32", "wsl.exe")]
		: [join(root, "System32", "wsl.exe")];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			resolved = { command: candidate, shell: false };
			return resolved;
		}
	}
	// `execFile` can resolve a bare executable through PATH without a shell. Keeping
	// shell=false is important here: distro/user values are settings data, and a
	// shell fallback would turn characters such as `&` or `|` into command syntax.
	resolved = { command: "wsl", shell: false };
	return resolved;
}
