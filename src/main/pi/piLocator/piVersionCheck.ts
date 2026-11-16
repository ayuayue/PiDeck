import { execFile } from "node:child_process";
import type { PiInstallStatus } from "../../../shared/types";
import type { MainProcessTranslationKey } from "../../../shared/i18n/mainProcessCopy";

/**
 * `--version` 探测域（PiLocator 拆分第五刀）：探测执行 + 输出解码 + 失败文案。
 *
 * 启动形态（命令/参数/shell）与子进程 env 都由宿主经窄接口传入——本域只负责「跑一次、
 * 把 stdout/stderr/exit code 变成 PiInstallStatus」，不决定启动哪个 pi。
 * 注释是现场结论（GBK、Node 异常行、#484 的 env node 反查），搬动时不要删。
 */

type Translate = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

/** 探测用到的启动形态切片：只列本域实际读的字段。 */
type VersionCheckInvocation = {
	command: string;
	args: string[];
	shell: boolean;
	pathPrefix?: string;
	windowsVerbatimArguments?: boolean;
	wsl?: { distro: string; user: string; piCommand: string };
};

/** 宿主窄接口：只给探测需要的两个入口（命令形态 + 子进程 env）。 */
export type PiVersionCheckHost = {
	createInvocation(command: string, args: string[]): VersionCheckInvocation;
	createProcessEnv(settings: undefined, pathPrefix: string | undefined, wsl: { distro: string; user: string; piCommand: string } | undefined): NodeJS.ProcessEnv;
};

/**
 * Node 未捕获异常的诊断行（`TypeError: ...` / `Error [ERR_XXX]: ...`）。
 * pi 的 POSIX 垫片靠 `#!/usr/bin/env node` 找解释器：命中过旧 node 时 stderr 首行是
 * `file:///.../chunk-XXXX.js:47` 这类栈帧地址，真正的原因（缺哪个 API）在后面的异常行里（#484）。
 */
const NODE_EXCEPTION_LINE = /^(?:[A-Za-z_$][\w$]*)?Error\b/;

/**
 * 执行 --version 轻量健康检查：验证可执行文件发现和 Node shim 启动是否正常。
 * validateCustomPath 和 check 共用此方法，仅 searchedDirs 有差异：
 * - validateCustomPath: searchedDirs 为空（用户已手动指定路径）
 * - check: searchedDirs 为自动扫描的目录列表
 *
 * 使用 encoding: 'buffer' 避免 Windows 中文环境下 stderr 的 GBK 输出被 utf8 错误解码导致乱码。
 *
 * `quiet`：安装列表探测逐个候选跑 --version，没装好/陈旧的候选失败是常态，
 * 不必为每一条往主进程日志刷 console.error（真正的启动失败由 check()/PiProcess 报）。
 */
export async function runPiVersionCheck(host: PiVersionCheckHost, translate: Translate, command: string, searchedDirs: string[], options: { quiet?: boolean } = {}): Promise<PiInstallStatus> {
	return new Promise((resolve) => {
		const invocation = host.createInvocation(command, ["--version"]);
		// 子进程 PATH 与「pi 垫片自己看到的 PATH」必须同源：失败时靠它反查 shebang 的 `env node`。
		const env = host.createProcessEnv(undefined, invocation.pathPrefix, invocation.wsl);
		execFile(
			invocation.command,
			invocation.args,
			{
				env,
				shell: invocation.shell,
				windowsHide: true,
				timeout: 8_000,
				encoding: "buffer",
				windowsVerbatimArguments: invocation.windowsVerbatimArguments,
			},
			async (error, stdout, stderr) => {
				if (error) {
					// 优先使用 stderr 中的实际错误信息（如"系统找不到指定的文件"），
					// 并处理 Windows GBK 编码问题。兜底用 error.message 但去掉冗余的命令行前缀。
					const stderrText = decodeBuffer(stderr);
					const stdoutText = decodeBuffer(stdout);
					const raw = stderrText || cleanExecError(error.message);
					// 仅命令行本身没有诊断价值时，补上 exit code / timeout，方便区分 PATH 与真失败
					const errObj = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
					// 逐个候选探测（quiet）失败是常态，WSL 里生效的是发行版内的 node：两种情形都不探。
					const node = options.quiet || invocation.wsl ? undefined : await probeEnvNode(env);
					if (!options.quiet) {
						console.error("[PiLocator] pi CLI check failed", {
							command,
							error: raw,
							stderr: stderrText || undefined,
							stdout: stdoutText || undefined,
							exitCode: errObj.code,
							killed: errObj.killed,
							envNode: node ? `${node.version} ${node.execPath}` : undefined,
							invocation: {
								command: invocation.command,
								args: invocation.args,
								pathPrefix: invocation.pathPrefix,
							},
						});
					}
					resolve({ installed: false, command, searchedDirs, error: composeCheckFailure(translate, raw, node?.version) });
					return;
				}

				const version = decodeBuffer(stdout).trim();
				resolve({ installed: true, command, searchedDirs, version });
			},
		);
	});
}

function decodeBuffer(buf: Buffer | null): string {
	if (!buf || buf.length === 0) return "";
	const utf8 = buf.toString("utf8");
	// UTF-8 解码后不含 Unicode 替换字符（\ufffd），说明解码正确
	if (!utf8.includes("\ufffd")) return utf8;
	// Windows 中文环境下，cmd/powershell 的错误输出通常是 GBK (codepage 936)
	try {
		return new TextDecoder("gbk", { fatal: false }).decode(buf);
	} catch {
		// 极少数环境不支持 gbk TextDecoder（如某些精简 Node.js），保留原始字节
		return buf.toString("latin1");
	}
}

/**
 * 清理 execFile 默认错误消息，去掉冗余的 "Command failed: ..." 命令行前缀，
 * 只保留有意义的错误描述。
 */
export function cleanExecError(message: string): string {
	// Node.js execFile 错误格式："Command failed: powershell.exe ..."
	// 去掉前缀，只保留后半段或返回简洁提示
	const cleaned = message.replace(/^Command failed:\s*/i, "").trim();
	// 如果去掉前缀后仍是完整命令行（太长），截断为友好提示
	if (cleaned.length > 120) {
		return cleaned.slice(0, 100) + "…";
	}
	return cleaned;
}

/**
 * 校验/检测失败的对外文案：通用提示 + 真实失败原因首行。
 * stderr 里的「No such file or directory / Permission denied / timed out」是用户
 * 区分「路径写错 / 不可执行 / WSL 冷启动超时」的唯一线索，此前只进 dev console，
 * 设置页只能看到笼统的「无法运行 pi CLI」，用户无从下手（2026-09-17 WSL 自定义路径排查）。
 * 单行 + 去 ANSI/控制字符 + 截断，避免多行 stderr 破坏设置页布局。
 *
 * 取行顺序：Node 异常行 > 第一条非空行。崩溃栈的首行只有 `file:///...chunk.js:47`，
 * 只取首行会把「缺哪个 API」这类可行动信息吞掉，用户拿到的原因毫无意义（#484）。
 * nodeVersion 只在崩在 JS 异常上时附带：这类失败八成是 PATH 命中的 node 太旧，
 * 而 pi 的 engines 为空、CLI 自身不报版本问题，两侧都没有版本线索。
 */
export function composeCheckFailure(translate: Translate, raw: string, nodeVersion?: string): string {
	const lines = raw
		.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
		.split(/\r?\n/)
		.map((line) => line.replace(/[\x00-\x1f\x7f]/g, "").trim())
		.filter((line) => line.length > 0);
	const picked = lines.find((line) => NODE_EXCEPTION_LINE.test(line)) ?? lines[0];
	if (!picked) return translate("mainPi.checkFailed");
	let short = picked.length > 160 ? `${picked.slice(0, 160)}…` : picked;
	if (nodeVersion && NODE_EXCEPTION_LINE.test(picked)) short = `${short} (node ${nodeVersion})`;
	return translate("mainPi.checkFailedReason", { reason: short });
}

/**
 * 反查 `#!/usr/bin/env node` 实际命中的解释器（版本 + 真实路径）。
 *
 * pi 的 POSIX 垫片靠 shebang 找 node，子进程 PATH 的顺序直接决定拿到哪个版本：
 * 用户 PATH 里遗留的旧 node 会让 pi 一早崩在缺 API 上，而 pi 的 engines 为空、
 * CLI 自身不会提示，两侧都没有版本线索（#484）。检测失败时多跑一次 `env node`，
 * 把解释器写进日志/原因，让「PATH 里有个旧 node」从靠猜变成可见。
 * Win32 不经 `env`（.cmd 垫片直接解析 node.exe），WSL 里生效的是发行版内的 node，两者都不探。
 */
function probeEnvNode(env: NodeJS.ProcessEnv): Promise<{ version: string; execPath: string } | undefined> {
	if (process.platform === "win32") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		execFile("/usr/bin/env", ["node", "-p", "process.version + ' ' + process.execPath"], { env, timeout: 3_000, encoding: "utf8", windowsHide: true }, (error, stdout) => {
			if (error) {
				resolve(undefined);
				return;
			}
			const [version, execPath] = String(stdout).trim().split(/\s+/);
			resolve(version && execPath && /^v\d+\.\d+\.\d+/.test(version) ? { version, execPath } : undefined);
		});
	});
}
