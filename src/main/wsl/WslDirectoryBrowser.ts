/**
 * WslDirectoryBrowser（Wave 0，见 `docs/wsl-project-in-distro-io-plan.md`）。
 *
 * 为什么在发行版内列目录，而不是 `\\wsl.localhost\<distro>\…`：9P 一律按**发行版默认用户**鉴权，
 * 与 `wsl.exe -u` 和文件属主都无关（实测 root 建的 700 目录 Windows 侧 EACCES，debian 建的能读）。
 * 所以 root 档案的 `/root` 只有「以 root 身份在发行版里跑」这一条路。
 *
 * 为什么这里是一次性 `sh`，而项目内文件域走 helper：helper 的 `--root` 按设计拒绝文件系统根
 * （`isAbsoluteRoot`：末字符是 `/` 就 `ROOT_INVALID`），而目录选择是**还没有项目根**时的操作，
 * 一次导航只需要单层 `maxdepth 1`——一个目录一次 RPC，常驻 helper 零收益。
 *
 * 三条纪律沿用 `WslPiConfigStore`：
 * - `shell:false` 的 wsl.exe argv；distro/user/path 都是数据，绝不进 shell 语法；
 * - 脚本用 "$1" 取路径，$0 是便于 `ps` 识别的标记；
 * - 失败只回稳定码，不透出 stderr 原文。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { normalize as normalizeLinux } from "node:path/posix";
import { opFail, opOk, type Op } from "../../shared/op";
import { WSL_DIRECTORY_CODES, type WslDirectoryPage } from "../../shared/types/wslDirectory";
import { getWslExe } from "./wslExe";

/**
 * 一页列出的子目录上限；超出即 `truncated: true`，不靠「刚好等于上限」猜。
 * 与 SSH 目录浏览同值：两者共用同一句「目录过多」文案。
 */
export const WSL_DIRECTORY_LIST_LIMIT = 300;

/** 单次输出的字节帽：目录名再离谱也不会需要更多；超限的那条记录在解析时丢弃并标 truncated。 */
const WSL_DIRECTORY_OUTPUT_BYTES = 256 * 1024;

/** 请求路径长度帽：Linux 路径上限远低于这个数，超长一定是误传或被塞了别的东西。 */
const WSL_DIRECTORY_MAX_PATH = 4096;

const LIST_TIMEOUT_MS = 15_000;

/**
 * 单层子目录列举。
 * - `-L` 让指向目录的符号链接也算目录（不带 -L 时它们是 `other`，用户会看不到自己的软链工作目录）；
 * - 先 `cd` 再找 `.`：输出只回名字，不把用户给的路径原样穿过一遍线；
 * - 退出码是协议：2=不是目录，4=不存在，5=以该身份进不去，其余（含 spawn 失败/超时）=发行版不可用。
 */
const LIST_SCRIPT = ['dir="$1"', 'if [ ! -e "$dir" ]; then exit 4; fi', 'if [ ! -d "$dir" ]; then exit 2; fi', 'if ! cd "$dir" 2>/dev/null; then exit 5; fi', `find -L . -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null | head -c ${WSL_DIRECTORY_OUTPUT_BYTES}`, "exit 0"].join("\n");

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export type WslDirectoryListInput = {
	distro: string;
	user: string;
	/** 发行版内的绝对 Linux 路径。 */
	path: string;
};

export type WslDirectoryExecOutput = { code: number; stdout: Buffer };

/** 可注入执行端口：单测用它证明 argv 形状与退出码映射，不真跑 wsl.exe。 */
export type WslDirectoryExec = (args: string[], options: { timeoutMs: number }) => Promise<WslDirectoryExecOutput>;

/** 生产 argv：`-d <distro> -u <user> --exec /bin/sh -c <script> pideck-dir <path>`。 */
export function buildWslDirectoryListArgs(input: { distro: string; user: string; path: string }): string[] {
	return ["-d", input.distro, "-u", input.user, "--exec", "/bin/sh", "-c", LIST_SCRIPT, "pideck-dir", input.path];
}

/**
 * 归一请求路径；不可用时返回 null（空、非绝对、超长、含控制字符）。
 * 不 trim：Linux 目录名可以以空格结尾，trim 会指向别处。
 */
export function normalizeWslListPath(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > WSL_DIRECTORY_MAX_PATH) return null;
	if (CONTROL_CHARS.test(raw)) return null;
	if (!raw.startsWith("/")) return null;
	const normalized = normalizeLinux(raw);
	if (!normalized.startsWith("/")) return null;
	return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : normalized;
}

/**
 * 解析 `-print0` 输出，只回**名字**（父级/面包屑由渲染层按 POSIX 字符串规则推，与 SSH 浏览器同一组件）。
 * 字节帽会切断最后一条记录：结尾没有 NUL 时丢弃残段并标 truncated，绝不半条名字进列表。
 */
export function parseWslDirectoryListing(stdout: Buffer): { entries: WslDirectoryPage["entries"]; truncated: boolean } {
	const raw = stdout.toString("utf8");
	const segments = raw.split("\0");
	// 字节帽会切断最后一条记录：结尾没有 NUL 时最后一段是残段；有 NUL 时最后一段是空串。两种都要丢。
	const incomplete = raw.length > 0 && segments[segments.length - 1] !== "";
	const names = segments
		.slice(0, -1)
		.map((segment) => (segment.startsWith("./") ? segment.slice(2) : segment))
		.filter((name) => name.length > 0 && name !== ".");
	const overflowed = names.length > WSL_DIRECTORY_LIST_LIMIT;
	const shown = names.slice(0, WSL_DIRECTORY_LIST_LIMIT).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	return { entries: shown.map((name) => ({ name })), truncated: incomplete || overflowed };
}

const defaultExec: WslDirectoryExec = (args, options) =>
	new Promise((resolve, reject) => {
		const exe = getWslExe();
		// shell 回退会把 & | 变成命令语法：宁可失败，也不经 shell。绝对路径缺失直接拒（与配置写端口同口径）。
		if (exe.shell || (isAbsolute(exe.command) && !existsSync(exe.command))) {
			reject(new Error("WSL_EXE_UNAVAILABLE"));
			return;
		}
		execFile(exe.command, args, { timeout: options.timeoutMs, windowsHide: true, shell: false, maxBuffer: WSL_DIRECTORY_OUTPUT_BYTES * 2 }, (error, stdout) => {
			if (error === null) {
				resolve({ code: 0, stdout: toBuffer(stdout) });
				return;
			}
			const status = (error as NodeJS.ErrnoException & { code?: number | string }).code;
			// 非零退出是协议的一部分（2/4/5），带已写出的 stdout 一起回；ENOENT 之类才是「跑不起来」。
			if (typeof status === "number") resolve({ code: status, stdout: toBuffer(stdout) });
			else reject(error);
		});
	});

function toBuffer(value: string | Buffer): Buffer {
	return Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8");
}

/**
 * 列一层 WSL 目录。任何失败都是 `Op` 拒绝（只读操作，`outcome` 恒为 rejected——重试不会重复执行任何东西）。
 * 「上级」与面包屑不在这里算：那是路径字符串层面的事实，渲染层与 SSH 浏览器共用同一套规则。
 */
export async function listWslDirectory(input: WslDirectoryListInput, deps: { exec?: WslDirectoryExec; platform?: NodeJS.Platform; timeoutMs?: number } = {}): Promise<Op<WslDirectoryPage>> {
	const platform = deps.platform ?? process.platform;
	if (platform !== "win32") return opFail(WSL_DIRECTORY_CODES.unavailable);
	const path = normalizeWslListPath(input.path);
	if (path === null) return opFail(WSL_DIRECTORY_CODES.pathInvalid);
	const run = deps.exec ?? defaultExec;
	let output: WslDirectoryExecOutput;
	try {
		output = await run(buildWslDirectoryListArgs({ distro: input.distro, user: input.user, path }), { timeoutMs: deps.timeoutMs ?? LIST_TIMEOUT_MS });
	} catch {
		return opFail(WSL_DIRECTORY_CODES.unavailable);
	}
	if (output.code === 2) return opFail(WSL_DIRECTORY_CODES.notDirectory);
	if (output.code === 4) return opFail(WSL_DIRECTORY_CODES.notFound);
	if (output.code === 5) return opFail(WSL_DIRECTORY_CODES.unreadable);
	if (output.code !== 0) return opFail(WSL_DIRECTORY_CODES.unavailable);
	const listed = parseWslDirectoryListing(output.stdout);
	return opOk({ path, entries: listed.entries, truncated: listed.truncated });
}
