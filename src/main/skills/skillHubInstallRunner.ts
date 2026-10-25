/**
 * 技能商店安装子进程的执行器：spawn + 流式进度 + 超时按树 kill。
 *
 * 为什么不用 execFile（旧实现）：execFile 只在进程结束时回调，30s 的冷安装期间界面完全
 * 无信息；且它把 stdout 丢掉，而 CLI 的真实报错恰恰打在 stdout（见 cleanInstallOutput）。
 * 这里改为流式读取，把输出翻译成阶段进度并通过 onProgress 上报（节流在解析器内）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { cleanInstallOutput, createInstallProgressParser, keepTail, type SkillHubInstallProgressUpdate } from "./skillHubInstallProgress";

/** 冷安装实测约 30s（首次下 npx cli + clone 仓库），120s 给慢代理留余量 */
export const SKILL_HUB_INSTALL_TIMEOUT_MS = 120_000;

export interface SkillHubInstallRunInput {
	command: string;
	args: string[];
	cwd?: string;
	/** 覆盖/追加到 process.env 的键（代理等）；undefined 表示原样继承 */
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	onProgress?: (update: SkillHubInstallProgressUpdate) => void;
	/** 测试注入点：默认 node:child_process.spawn */
	spawnImpl?: typeof spawn;
	/** 测试注入点：默认按平台 kill 进程树 */
	killTreeImpl?: (pid: number) => void;
}

/**
 * 超时兜底：win32 上安装是 cmd.exe → npx → node → git 的多层进程，只 kill 父进程会留下
 * 继续跑的 git；用 taskkill /T 按树杀。fire-and-forget 也必须挂 error 监听（未处理的
 * error 事件会直接崩主进程）。
 */
function defaultKillTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			killer.on("error", () => {
				// 杀不掉不影响结算：close 事件与超时 reject 已各自兜底
			});
		} catch {
			// 同上：spawn 同步抛错时忽略，等待 close 兜底
		}
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// 进程可能已退出（正常竞态），忽略
	}
}

/** 执行一次安装；失败抛出已清洗的原因（含 stdout 尾部真实报错），成功 resolve。 */
export async function runSkillHubInstall(input: SkillHubInstallRunInput): Promise<void> {
	const spawnImpl = input.spawnImpl ?? spawn;
	const killTree = input.killTreeImpl ?? defaultKillTree;
	const timeoutMs = input.timeoutMs ?? SKILL_HUB_INSTALL_TIMEOUT_MS;
	const parser = createInstallProgressParser();
	let stdoutTail = "";
	let stderrTail = "";
	let timedOut = false;

	const child: ChildProcess = spawnImpl(input.command, input.args, {
		cwd: input.cwd,
		env: input.env ? { ...process.env, ...input.env } : process.env,
		windowsHide: true,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settle = (finish: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			finish();
		};
		timer = setTimeout(() => {
			timedOut = true;
			if (child.pid) killTree(child.pid);
			child.kill();
		}, timeoutMs);

		const consume = (chunk: string, isStdout: boolean) => {
			if (isStdout) stdoutTail = keepTail(stdoutTail + chunk);
			else stderrTail = keepTail(stderrTail + chunk);
			const update = parser.push(chunk);
			if (update && input.onProgress) input.onProgress(update);
		};

		child.stdout?.on("data", (chunk: Buffer | string) => consume(chunk.toString(), true));
		child.stderr?.on("data", (chunk: Buffer | string) => consume(chunk.toString(), false));
		child.on("error", (error) => {
			settle(() => reject(new Error(cleanInstallOutput({ stdout: stdoutTail, stderr: stderrTail, fallback: error.message }))));
		});
		child.on("close", (code, signal) => {
			// 残余（未以换行结尾）的输出补一次，让失败原因与最后阶段都完整
			const update = parser.push("\n");
			if (update && input.onProgress) input.onProgress(update);
			if (timedOut) {
				const last = parser.current();
				const hint = last?.detail ? `（最后输出：${last.detail}）` : "";
				settle(() => reject(new Error(cleanInstallOutput({ stdout: stdoutTail, stderr: stderrTail, fallback: `安装超时（${Math.round(timeoutMs / 1000)} 秒）${hint}` }))));
				return;
			}
			if (code === 0) {
				settle(resolve);
				return;
			}
			settle(() => reject(new Error(cleanInstallOutput({ stdout: stdoutTail, stderr: stderrTail, fallback: `安装命令退出码 ${code ?? signal ?? "unknown"}` }))));
		});
	});
}
