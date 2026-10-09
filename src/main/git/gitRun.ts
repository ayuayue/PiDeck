import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
// 本地 import 带 .ts 扩展名：rewind checkpointCore 经本模块被 tests/*.test.mjs 用
// Node type stripping 直接加载，extensionless 相对 import 在 Node ESM 下解析不到。
import { killProcessTree, runGit as spawnGit, type RunGitOptions } from "./gitProcess.ts";
import { currentGitExecutable } from "./gitExecutable.ts";
import { decodeWslGitStderr, decodeWslGitStdout, planGitSpawn, resolveWslGitTimeout, type GitSpawnPlan } from "./gitWsl.ts";

/**
 * git 子进程执行收口：GitService / WorktreeService / rewind checkpoint / gitIpc 的
 * 全部 git 调用都经过这里的两个入口，「宿主 git 还是 WSL 发行版内 git」在入口内部
 * 按 cwd 决定（规则见 gitWsl.ts），业务代码不再感知两者差异。
 *
 * - execGit：execFile 语义（读类命令为主；保留 execFile 的 maxBuffer 截断行为，
 *   以及 `Command failed: …` 报错前缀——渲染层 gitOperationErrorText 依赖该约定）。
 * - runGitCommand：spawn 语义（gitProcess.runGit 的进程树 kill + 超时兜底 + stdin input），
 *   供 mutation 与 checkpoint 的 commit-tree / cat-file --batch / update-ref --stdin 使用。
 */

const execFileAsync = promisify(execFile);

export type ExecGitOptions = {
	cwd: string;
	timeoutMs?: number;
	maxBuffer?: number;
	env?: NodeJS.ProcessEnv;
};

/** WSL 分支默认输出上限，对齐 gitProcess.runGit 的 16MB。 */
const WSL_GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** 执行一个 git 读类命令（execFile 语义）。 */
export async function execGit(args: string[], options: ExecGitOptions): Promise<{ stdout: string; stderr: string }> {
	const plan = planGitSpawn(args, { cwd: options.cwd, env: options.env, nativeCommand: currentGitExecutable() });
	if (!plan.target) {
		const { stdout, stderr } = await execFileAsync(plan.command, plan.args, {
			cwd: plan.cwd,
			env: plan.env ? { ...process.env, ...plan.env } : undefined,
			timeout: options.timeoutMs,
			maxBuffer: options.maxBuffer,
			windowsHide: true,
		});
		return { stdout, stderr };
	}
	return runWslGit(plan, options);
}

/** 执行一个 git 命令（spawn 语义：进程树 kill、超时兜底、stdin 通道）。 */
export function runGitCommand(args: string[], options: RunGitOptions): Promise<{ stdout: string; stderr: string }> {
	const plan = planGitSpawn(args, { cwd: options.cwd, env: options.env, nativeCommand: currentGitExecutable() });
	if (!plan.target) {
		return spawnGit(plan.args, { ...options, cwd: plan.cwd }, plan.command);
	}
	return runWslGit(plan, options);
}

/**
 * WSL 分支执行：与 gitProcess.runGit 同构（超时 → 杀进程树 → 2s 兜底，保证 promise
 * 一定 settle），差别只在输出按 Buffer 收集后再解码：
 * - wsl.exe 自身报错是 UTF-16LE 本地化文案，必须拿原始字节判定编码；
 * - git 的 -z 输出靠 NUL 分隔，UTF-8 路径上不能丢字节。
 *
 * 已知限制：超时用 taskkill /T 只杀得到 wsl.exe，Linux 侧 git 由发行版 init 收养、
 * 可能继续跑完——读类命令无副作用，mutation 的超时本身已是异常路径。
 */
function runWslGit(plan: GitSpawnPlan, options: { timeoutMs?: number; maxBuffer?: number; input?: string }): Promise<{ stdout: string; stderr: string }> {
	const maxBuffer = options.maxBuffer ?? WSL_GIT_MAX_BUFFER;
	// 冷启动与 9P 首次目录遍历可能超过宿主默认超时，WSL 侧统一抬到下限。
	const timeoutMs = resolveWslGitTimeout(options.timeoutMs);
	return new Promise((resolve, reject) => {
		const child = spawn(plan.command, plan.args, {
			cwd: plan.cwd,
			// 需要写 stdin 时才开 pipe（commit-tree 消息、cat-file --batch 的 SHA 列表走这里）。
			stdio: options.input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		if (options.input !== undefined && child.stdin) {
			// 断管兜底：同 gitProcess.runGit——排队写在 wsl.exe 提前退出时触发 error 事件
			// （EOF/EPIPE），无监听会炸主进程；promise 结局已由 close/error 通道结算。
			child.stdin.on("error", () => {});
			child.stdin.write(options.input);
			child.stdin.end();
		}

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let overflowed = false;
		let settled = false;
		let treeKilled = false;
		let mainTimer: NodeJS.Timeout | null = null;
		let fallbackTimer: NodeJS.Timeout | null = null;

		const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
			const next = (stream === "stdout" ? stdoutBytes : stderrBytes) + chunk.length;
			if (stream === "stdout") stdoutBytes = next;
			else stderrBytes = next;
			if (next > maxBuffer) {
				overflowed = true;
				return;
			}
			(stream === "stdout" ? stdoutChunks : stderrChunks).push(chunk);
		};

		child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		const clearTimers = () => {
			if (mainTimer) {
				clearTimeout(mainTimer);
				mainTimer = null;
			}
			if (fallbackTimer) {
				clearTimeout(fallbackTimer);
				fallbackTimer = null;
			}
		};

		mainTimer = setTimeout(() => {
			if (child.pid !== undefined && !treeKilled) {
				treeKilled = true;
				killProcessTree(child.pid);
			}
			fallbackTimer = setTimeout(() => {
				settle(() => reject(new Error(`Command timed out: ${plan.display}`)));
			}, 2000);
			fallbackTimer.unref?.();
		}, timeoutMs);

		child.on("error", (error) => {
			clearTimers();
			settle(() => reject(error));
		});

		child.on("close", (code) => {
			clearTimers();
			const stdoutRaw = Buffer.concat(stdoutChunks);
			const stderr = decodeWslGitStderr(Buffer.concat(stderrChunks));
			if (overflowed) {
				settle(() => reject(new Error(`Command output exceeded ${maxBuffer} bytes: ${plan.display}`)));
			} else if (code === 0) {
				settle(() => resolve({ stdout: decodeWslGitStdout(stdoutRaw), stderr }));
			} else {
				// 对齐 execFile / gitProcess 的报错格式（首行命令、其余 stderr）。
				settle(() => reject(new Error(`Command failed: ${plan.display}\n${stderr || decodeWslGitStdout(stdoutRaw)}`)));
			}
		});
	});
}
