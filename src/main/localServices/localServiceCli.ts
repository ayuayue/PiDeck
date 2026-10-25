import { execFile, spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";

/** 一次性命令结果：只回 stdout 或稳定原因码，stderr 原文（可能含令牌）不上抛。 */
export type LocalServiceCommandResult = { ok: true; stdout: string } | { ok: false; reason: string };

/** 长驻命令只回「起没起来」：不等退出，所以没有 stdout。 */
export type LocalServiceSpawnResult = { ok: true } | { ok: false; reason: string };

export type LocalServiceCli = {
	/** 一次性命令：读 stdout，带超时（超时即失败，不留悬挂子进程）。 */
	run(args: string[], timeoutMs: number): Promise<LocalServiceCommandResult>;
	/** 长驻命令：立刻返回、不等待退出（服务自己接管进程）。 */
	spawnDetached(args: string[]): LocalServiceSpawnResult;
};

/** 命令名/参数只允许安全字符：两者都来自主进程适配器常量，这里兜住「以后有人把外部输入接进来」。 */
const COMMAND_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const ARGUMENT_PATTERN = /^[A-Za-z0-9_=./:@+-]{1,160}$/;

/**
 * Windows 上 npm 全局命令是 `.cmd` 垫片，Node 24 直接 spawn 会 EINVAL，
 * 必须经 `cmd.exe /d /s /c` 走（同 src/main/ipc/systemIpc.ts 的探测形态）。
 * 整行作为一个 verbatim 参数传入，不做字符串插值拼 shell。
 */
export function localServiceInvocation(command: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
	if (!COMMAND_PATTERN.test(command)) throw new Error("invalid-service-command");
	for (const arg of args) if (!ARGUMENT_PATTERN.test(arg)) throw new Error("invalid-service-argument");
	if (process.platform !== "win32") return { command, args, windowsVerbatimArguments: false };
	return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", [command, ...args].join(" ")], windowsVerbatimArguments: true };
}

/** 启动器程序从这两个环境变量取真正的命令（值来自适配器常量，不来自外部输入）。 */
export const LOCAL_SERVICE_LAUNCH_COMMAND_ENV = "PIDECK_LOCAL_SERVICE_COMMAND";
export const LOCAL_SERVICE_LAUNCH_ARGS_ENV = "PIDECK_LOCAL_SERVICE_ARGS";

/**
 * Windows 长驻命令的 GUI 启动器程序（`-e` 注入，见 localServiceDetachedInvocation）。
 *
 * 为什么需要它：长驻服务必须 `detached` 才能活过 PiDeck 退出（非 detached 的子进程挂在 libuv 的
 * job 上，PiDeck 一退就被连坐杀掉）；但 detached 的**控制台子系统**子进程由 Windows 新建控制台，
 * 而 `windowsHide` 对「新建的」控制台不生效，于是 `cmd.exe /c bili start` 会闪一个黑框（2026-02 实测）。
 *
 * 解法：让直接子进程换成 GUI 子系统二进制（app 自己的 electron.exe / PiDeck.exe，
 * `ELECTRON_RUN_AS_NODE=1` 当 Node 跑，`-e` 只支持这种形态）：GUI 进程自己不带控制台、也不会新建
 * 窗口，它再以 `windowsHide` 拉起真正的 CLI，CLI 拿到的是「没有窗口的可继承控制台」，孙进程
 * （bili 里的 node 代理）继承它，全程不出现窗口。
 *
 * 启动器必须**活到 CLI 退出**（不能 unref 后自己先撤）：非 detached 的子进程落在启动器自己的
 * libuv job 上，启动器一退就被 KILL_ON_JOB_CLOSE 连坐杀掉（实测如此）；它退出时机与 CLI 同步。
 */
export const LOCAL_SERVICE_LAUNCHER_PROGRAM = [
	"const{spawn}=require('node:child_process')",
	"const env={...process.env}",
	`delete env.ELECTRON_RUN_AS_NODE;delete env.${LOCAL_SERVICE_LAUNCH_COMMAND_ENV};delete env.${LOCAL_SERVICE_LAUNCH_ARGS_ENV}`,
	`const child=spawn(process.env.${LOCAL_SERVICE_LAUNCH_COMMAND_ENV},JSON.parse(process.env.${LOCAL_SERVICE_LAUNCH_ARGS_ENV}||'[]'),{env,stdio:'ignore',windowsHide:true,windowsVerbatimArguments:true})`,
	"child.on('error',()=>process.exit(1))",
	"child.on('exit',(code)=>process.exit(code??0))",
].join(";");

/** 长驻命令最终 spawn 的形态（纯函数，便于断言）。 */
export function localServiceDetachedInvocation(
	invocation: { command: string; args: string[]; windowsVerbatimArguments: boolean },
	options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; runtimePath?: string } = {},
): { command: string; args: string[]; env: NodeJS.ProcessEnv; windowsVerbatimArguments: boolean } {
	const baseEnv = options.env ?? process.env;
	if ((options.platform ?? process.platform) !== "win32") return { command: invocation.command, args: invocation.args, env: baseEnv, windowsVerbatimArguments: invocation.windowsVerbatimArguments };
	return {
		command: options.runtimePath ?? process.execPath,
		args: ["-e", LOCAL_SERVICE_LAUNCHER_PROGRAM],
		env: { ...baseEnv, ELECTRON_RUN_AS_NODE: "1", [LOCAL_SERVICE_LAUNCH_COMMAND_ENV]: invocation.command, [LOCAL_SERVICE_LAUNCH_ARGS_ENV]: JSON.stringify(invocation.args) },
		// 启动器程序由 libuv 按 argv 规则加引号（不是 verbatim 整行），CLI 那一层才是 verbatim。
		windowsVerbatimArguments: false,
	};
}

export function createLocalServiceCli(options: { command: string; env?: () => NodeJS.ProcessEnv | undefined }): LocalServiceCli {
	return {
		run(args, timeoutMs) {
			let invocation: ReturnType<typeof localServiceInvocation>;
			try {
				invocation = localServiceInvocation(options.command, args);
			} catch {
				return Promise.resolve({ ok: false, reason: "cli-failed" });
			}
			return new Promise((resolve) => {
				execFile(invocation.command, invocation.args, { env: options.env?.(), timeout: timeoutMs, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
					if (error) {
						resolve({ ok: false, reason: "cli-failed" });
						return;
					}
					resolve({ ok: true, stdout: String(stdout ?? "") });
				});
			});
		},
		spawnDetached(args) {
			let invocation: ReturnType<typeof localServiceInvocation>;
			try {
				invocation = localServiceInvocation(options.command, args);
			} catch {
				return { ok: false, reason: "start-failed" };
			}
			try {
				// win32 经 GUI 启动器拉起（消掉 detached 新控制台的黑框），其他平台直接 detached。
				const launch = localServiceDetachedInvocation(invocation, { env: options.env?.(), runtimePath: process.execPath });
				const child = spawn(launch.command, launch.args, { env: launch.env, detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments });
				// 未处理的 error 事件会直接崩主进程；spawn 失败在回调里同步返回不可靠，这里兜住。
				child.on("error", () => undefined);
				child.unref();
				return { ok: true };
			} catch {
				return { ok: false, reason: "start-failed" };
			}
		},
	};
}

/**
 * 终止一个 pid 的命令形态（纯函数，便于断言；参数永远是数组，不经 shell 拼接）。
 * taskkill 是 System32 里的真 exe（不是 .cmd 垫片），所以不需要经 cmd.exe。
 * 非法 pid 返回 null：pid 只来自适配器自己的报告，这里再兜一道，避免误杀。
 */
export function killLocalServiceInvocation(pid: number, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } | null {
	if (!Number.isInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) return null;
	return platform === "win32" ? { command: "taskkill", args: ["/pid", String(pid), "/t", "/f"] } : { command: "kill", args: ["-TERM", String(pid)] };
}

/**
 * 停止服务：外部 CLI 没有 stop 子命令，只能按 pid 终止。
 * Windows 用 `taskkill /t /f` 连子进程一起收（bili 是 node 进程）；pid 只来自适配器自己的报告，
 * 不做任何猜测，避免误杀。返回值只表示「终止动作是否成功」，真实状态一律再查一次。
 */
export function killLocalServiceProcess(pid: number, options: { platform?: NodeJS.Platform; timeoutMs?: number } = {}): Promise<boolean> {
	const invocation = killLocalServiceInvocation(pid, options.platform ?? process.platform);
	if (!invocation) return Promise.resolve(false);
	return new Promise((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(ok);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(invocation.command, invocation.args, { windowsHide: true, stdio: "ignore" });
		} catch {
			finish(false);
			return;
		}
		timer = setTimeout(() => {
			child.kill();
			finish(false);
		}, options.timeoutMs ?? 10_000);
		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
	});
}
