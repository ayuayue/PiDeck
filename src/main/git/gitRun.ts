import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
// 本地 import 带 .ts 扩展名：rewind checkpointCore 经本模块被 tests/*.test.mjs 用
// Node type stripping 直接加载，extensionless 相对 import 在 Node ESM 下解析不到。
import { killProcessTree, runGit as spawnGit, type RunGitOptions } from "./gitProcess.ts";
import { currentGitExecutable } from "./gitExecutable.ts";
import { decodeWslGitStderr, decodeWslGitStdout, planGitSpawn, resolveWslGitTarget, resolveWslGitTimeout, toHostGitOutputPath, type GitSpawnPlan } from "./gitWsl.ts";

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

/**
 * execFile 输出超上限（ERR_CHILD_PROCESS_STDIO_MAXBUFFER）时的错误，额外带上已收集到的截断输出。
 *
 * Node 其实把截断内容挂在 error.stdout 上，但那是 any 形状：调用方读它要类型收窄，还得知道
 * 「有 stdout 不等于成功」。统一成这个错误后，「只消费输出前缀」的调用方（提交摘要）能显式降级；
 * 其余调用方行为不变：message 仍是 execFile / 本模块原文（溢出报错本来就不带 `Command failed:` 前缀），
 * 按失败处理的路径照旧，只是多了一个可选的截断输出可读。
 */
export class GitOutputOverflowError extends Error {
	/** 截至上限的输出（已被截断，调用方只可当作前缀使用） */
	readonly stdout: string;

	constructor(message: string, stdout: string) {
		super(message);
		this.name = "GitOutputOverflowError";
		this.stdout = stdout;
	}
}

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
		try {
			const { stdout, stderr } = await execFileAsync(plan.command, plan.args, {
				cwd: plan.cwd,
				env: plan.env ? { ...process.env, ...plan.env } : undefined,
				timeout: options.timeoutMs,
				maxBuffer: options.maxBuffer,
				windowsHide: true,
			});
			return { stdout, stderr };
		} catch (error) {
			throw toGitExecError(error);
		}
	}
	return runWslGit(plan, options);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * execFile 失败统一出口：输出超上限转成 GitOutputOverflowError（保留截断 stdout），
 * 其它错误原样抛出（渲染层 gitOperationErrorText 依赖 `Command failed: …` 前缀与 stderr 字段）。
 */
function toGitExecError(error: unknown): unknown {
	if (!isPlainObject(error) || error["code"] !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return error;
	const message = typeof error["message"] === "string" ? error["message"] : "stdout maxBuffer length exceeded";
	const partial = typeof error["stdout"] === "string" ? error["stdout"] : "";
	return new GitOutputOverflowError(message, partial);
}

/** 执行一个 git 命令（spawn 语义：进程树 kill、超时兜底、stdin 通道）。 */
export function runGitCommand(args: string[], options: RunGitOptions): Promise<{ stdout: string; stderr: string }> {
	const plan = planGitSpawn(args, { cwd: options.cwd, env: options.env, nativeCommand: currentGitExecutable() });
	if (!plan.target) {
		return spawnGit(plan.args, { ...options, cwd: plan.cwd }, plan.command);
	}
	return runWslGit(plan, options);
}

/** toplevel 解析超时：它是加速通道的前置步骤，宁可早失败退化成轮询，也不能拖住订阅方。 */
const GIT_TOPLEVEL_TIMEOUT_MS = 5000;

/**
 * 从 `git rev-parse --show-toplevel` 的 stdout 里取出 toplevel 路径（纯函数，可单测）。
 *
 * 取**最后一个非空行**：git 的真实值总是最后一行，前面可能被包装层（git alias 的 echo、
 * wrapper 告警、中文 Windows 的代码页提示）插入额外行。取首行会把前缀当成路径——
 * 路径非法 → 签名恒 null → 着色/角标重新退化成只靠 5 秒轮询（就是本层要修的原缺陷）。
 *
 * @returns 空输出或只有空白时返回 null（调用方静默降级，不起轮询采样阶段就失败）
 */
export function parseToplevelOutput(stdout: string): string | null {
	const lines = stdout.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i].trim();
		if (line) return line;
	}
	return null;
}

/**
 * 解析 cwd 所属仓库的 toplevel（宿主视角绝对路径）；不是仓库 / git 不可用 / 超时一律返回 null。
 *
 * 为什么需要它：GitRefsWatcher 只盯 <repo>/.git 下的 refs 文件，而订阅方给的是项目根——
 * 项目根是仓库子目录（或项目根下才另有仓库）时，join(项目根, ".git") 根本不存在，签名恒为
 * null、永不通告，文件树着色与 ahead/behind 角标退化成只靠 5 秒轮询。向上解析到 toplevel
 * 才是 refs 真正所在的那一层。
 *
 * 两处必须复用既有能力、不能另写一套：
 * 1) 走 execGit，WSL 仓库（UNC 路径）由它分流到发行版内 git——用宿主 git.exe 经 9P 会判
 *    dubious ownership 并看到另一套索引；
 * 2) `rev-parse --show-toplevel` 是「git 保证输出绝对路径」的字段，WSL 分支里给的是 Linux
 *    路径（/home/...），必须经 toHostGitOutputPath 回译成宿主路径，否则后续 stat 全落空。
 *
 * 不抛异常：检测属加速手段，调用方（GitRefsWatcher）拿到 null 只记 warn 并退回轮询兜底。
 */
export async function resolveGitToplevel(cwd: string, timeoutMs: number = GIT_TOPLEVEL_TIMEOUT_MS): Promise<string | null> {
	try {
		const { stdout } = await execGit(["rev-parse", "--show-toplevel"], { cwd, timeoutMs });
		// 真实值在最后一行：包装层可能带回显/告警前缀（解析规则见 parseToplevelOutput）
		const toplevel = parseToplevelOutput(stdout);
		if (!toplevel) return null;
		return toHostGitOutputPath(toplevel, resolveWslGitTarget(cwd));
	} catch {
		return null;
	}
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
				// 带上已收集的截断输出：只消费前缀的调用方（提交摘要）可降级，其余照旧按失败处理
				settle(() => reject(new GitOutputOverflowError(`Command output exceeded ${maxBuffer} bytes: ${plan.display}`, decodeWslGitStdout(stdoutRaw))));
			} else if (code === 0) {
				settle(() => resolve({ stdout: decodeWslGitStdout(stdoutRaw), stderr }));
			} else {
				// 对齐 execFile / gitProcess 的报错格式（首行命令、其余 stderr）。
				settle(() => reject(new Error(`Command failed: ${plan.display}\n${stderr || decodeWslGitStdout(stdoutRaw)}`)));
			}
		});
	});
}
