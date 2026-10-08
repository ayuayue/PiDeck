import { execFile } from "node:child_process";
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from "node:child_process";
import type { PiInstallExecResult } from "../../shared/types";

/**
 * 引导安装（Environment Guide）里「全局安装 pi」的执行器。
 *
 * 单独成模块的原因：IPC handler 只应做入参校验与适配，而「怎么把 npm 跑起来」
 * 是业务逻辑，且它踩过 Windows 上一个专门坑，必须有单测兜住（见下）。
 */

/** npm install 超时上限：首次下载 + 链接全局 bin 通常 1 分钟内，留足国内镜像慢速余量。 */
export const PI_GLOBAL_INSTALL_TIMEOUT_MS = 300_000;

/**
 * 引导安装用的启动规格（PiLocator.createInvocation 的结构子集）。
 *
 * 关键：Windows 下 command 必须是 CreateProcess 能直接拉起的可执行文件
 * （node.exe / cmd.exe），绝不能是 npm.cmd 本身。
 */
export type PiGlobalInstallInvocation = {
	command: string;
	args: string[];
	shell?: boolean;
	pathPrefix?: string;
	windowsVerbatimArguments?: boolean;
	/** 启动通道（node-direct / cmd-shim + 回退原因），仅用于日志诊断。 */
	windowsLaunch?: { channel: string; entry?: string; reason?: string };
};

/** 注入的启动规格解析器 + env 工厂（生产环境传 PiLocator 的适配器）。 */
export type PiGlobalInstallLauncher = {
	createInvocation: (command: string, args: string[]) => PiGlobalInstallInvocation;
	/** pathPrefix：把便携 node / 垫片所在目录前置进 PATH，让 npm 能找到配套的 node。 */
	createProcessEnv: (pathPrefix?: string) => NodeJS.ProcessEnv;
};

/** execFile 的最小注入面（测试替身只关心 command/args/options）。 */
export type PiInstallExecFile = (file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding, callback: (error: ExecFileException | null, stdout: string, stderr: string) => void) => unknown;

/** 执行结果 + 诊断字段；调用方把诊断字段记日志后，只把 PiInstallExecResult 部分回给渲染层。 */
export type PiGlobalInstallOutcome = PiInstallExecResult & {
	/** 实际执行的命令（node.exe / cmd.exe / 裸 npm），排查「到底走没走 node 直启」。 */
	launchCommand: string;
	launchChannel?: string;
	launchFallbackReason?: string;
};

export type PiGlobalInstallInput = {
	/** 已解析的 npm：便携 node 同目录的 npm.cmd，或裸命令名 "npm"。 */
	npmCommand: string;
	/** npm install 参数（含镜像源），不含 --prefix。 */
	npmArgs: string[];
	/**
	 * 安装前缀目录（可选）。省略时**不拼 --prefix**，npm 落到它自己的全局目录
	 *（用户真全局安装，引导 2026-10 起的首选形态）；传入时 pi 落进
	 * <userData>/pi-runtime/pi-global（无系统 npm/全局不可写时的回退，不写系统目录、无需提权）。
	 */
	prefixDir?: string;
	launcher: PiGlobalInstallLauncher;
	cwd: string;
	timeoutMs?: number;
	execFileImpl?: PiInstallExecFile;
};

/**
 * 判定「直接交给 execFile 必然起不来」的批处理垫片形态。
 *
 * 2026-09 报障根因：Windows 的 npm 是 .cmd 垫片，CreateProcess 不认 .cmd/.bat，
 * `execFile("npm")` / `execFile("…\\npm.cmd")` 都只得到 ENOENT（Node 24 用
 * `shell:true` 启动 .cmd 更是直接 EINVAL 拒绝）。表现为引导步骤「点击即失败」：
 * exitCode -1、stdout/stderr 全空，界面只剩「✗ 安装失败：」没有任何原因。
 */
export function isWindowsBatchShim(command: string): boolean {
	return /\.(?:cmd|bat)$/i.test(command.trim());
}

/** 收窄「带 message 字符串的类错误对象」。 */
function isMessagedErrorLike(value: unknown): value is { message: string } {
	if (typeof value !== "object" || value === null || !("message" in value)) return false;
	return typeof Reflect.get(value, "message") === "string";
}

/** 取「为什么没跑起来」的文本：ENOENT/权限类错误 npm 根本没执行，只有 error.message 有信息。 */
export function describePiInstallExecFailure(error: unknown): string {
	if (!error) return "";
	// 不用 instanceof Error 判型：这条消息是失败时唯一可读的原因，而 ts 模块经 vm 沙箱加载时
	// 跨 realm 的 instanceof 恒为 false，会把错误退化成 "Error: xxx" 或丢掉原因。
	if (isMessagedErrorLike(error)) return error.message;
	return String(error);
}

/**
 * 全局安装 pi：解析启动规格 → 执行 npm → 归一化结果。
 *
 * 不自己拼 command 的理由：Windows 通道判断（.cmd 垫片还原 node + JS 入口、裸命令名走
 * cmd.exe /d /s /c）已经在 PiLocator.createInvocation 里实现并带安全校验（垫片来自用户磁盘，
 * 入口被改写必须拒绝），这里复用而不是第二套实现。
 */
export async function runPiGlobalInstall(input: PiGlobalInstallInput): Promise<PiGlobalInstallOutcome> {
	// prefixDir 缺省 = 真全局安装：npm 用自己的全局前缀（Windows 是 %APPDATA%\npm，
	// 版本管理器布局是用户目录），与用户终端 `npm i -g` 完全同路，后续更新/卸载也同路。
	const prefixArg = input.prefixDir ? `--prefix=${input.prefixDir}` : "";
	const invocation = input.launcher.createInvocation(input.npmCommand, prefixArg ? [...input.npmArgs, prefixArg] : [...input.npmArgs]);
	const launchChannel = invocation.windowsLaunch?.channel;
	const fallbackReason = invocation.windowsLaunch?.reason;

	// 兜底闸门：任何情况下都不把 .cmd/.bat 直接交给 execFile —— 那正是本次报障的失败形态，
	// 与其让子进程静默 ENOENT（界面/日志都无输出），不如立刻给出可读原因。
	if (isWindowsBatchShim(invocation.command)) {
		return {
			success: false,
			exitCode: null,
			stdout: "",
			stderr: `refusing to launch batch shim directly: ${invocation.command}`,
			launchCommand: invocation.command,
			launchChannel,
			launchFallbackReason: fallbackReason,
		};
	}

	const execFileImpl = input.execFileImpl ?? execFile;
	const result = await new Promise<PiInstallExecResult>((resolve) => {
		execFileImpl(
			invocation.command,
			invocation.args,
			{
				env: input.launcher.createProcessEnv(invocation.pathPrefix),
				cwd: input.cwd,
				timeout: input.timeoutMs ?? PI_GLOBAL_INSTALL_TIMEOUT_MS,
				encoding: "utf8",
				windowsHide: true,
				// 数组传参、不经 shell 拼接（安全约束）；Windows 该有的 cmd 层由 createInvocation 显式补上。
				shell: invocation.shell === true,
				// cmd /c 的末位参数是整条命令行，里面的引号由 createInvocation 维护；
				// 让 Node 再转义一次会把带空格的路径改坏。
				windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
			},
			(error, stdout, stderr) => {
				const execError = error as ExecFileException | null;
				resolve({
					success: !error,
					exitCode: typeof execError?.code === "number" ? execError.code : error ? -1 : 0,
					stdout: stdout || "",
					// stderr 为空但确实失败（spawn 层错误：ENOENT / EACCES / 超时被杀）时补上
					// error.message，否则渲染层只能显示「安装失败：」而没有任何原因。
					stderr: stderr || describePiInstallExecFailure(error),
				});
			},
		);
	});

	return { ...result, launchCommand: invocation.command, launchChannel, launchFallbackReason: fallbackReason };
}
