/**
 * 本地引擎的常驻推理进程（whisper-server）。
 *
 * 为什么要常驻：whisper-cli 每转写一段就要重新加载几百 MB 模型 + DLL 初始化。
 * 实测（i5-12400 / small-q5_1 / 8 秒音频）单段端到端 6.3~8.5 秒，其中「模型加载 +
 * 一次 30 秒窗口编码」就要 3.2 秒——这是**每段都要重复付**的固定成本，于是停止录音后
 * 队列里的分段看起来永远排不完。常驻 server 后同一音频 warm 请求 2.6~3.3 秒，
 * `/health` 冷启动仅 0.3~0.4 秒（模型加载本身约 2.8 秒）。
 *
 * 生命周期（与 AGENTS 的退出清理纪律配对）：
 * - **懒启动**：第一次转写才拉起，不录音就不占内存；
 * - **就绪判定**：轮询 `/health`，进程中途退出直接判失败，不猜；
 * - **空闲退出**：一段时间无请求即杀进程树，把内存还给用户；
 * - **换配置即重启**：key = server 路径 + 模型路径，语言走请求级字段因此不需要重启；
 * - **失败熔断**：拉不起来就冷却一段时间并让调用方回退 whisper-cli，
 *   保证「提速路径失败」不会变成「语音输入不可用」；
 * - **退出必清理**：`shutdown()` 登记进 quitCleanup，删除模型/重装运行时前也必须调用
 *   （Windows 下进程持有 .bin 会让删除失败）。
 *
 * 解码参数刻意走**请求级 multipart**（`best_of`/`beam_size`/`language`/`prompt`），
 * 启动参数只留模型与端口：server 的默认值每个请求都会重置（见 server.cpp 的
 * `whisper_params params = default_params;`），请求级传参才不会受历史进程影响。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname } from "node:path";
import { createServer } from "node:net";
import { VOICE_SIMPLIFIED_CHINESE_PROMPT } from "./simplifiedChinese";
import { killProcessTree } from "../git/gitProcess";

/** 单次 /inference 的上界：常驻进程没有「进程卡死」的兜底，必须自己掐。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** 冷启动等待：small 约 0.4s、Medium/Turbo 数秒，给足余量但不无限等。 */
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
/** 空闲多久退出：覆盖「连说几次」的间隔，又不至于整时段驻内存。 */
const DEFAULT_IDLE_STOP_MS = 120_000;
/** 拉起失败后的冷却：期间不再尝试，直接走 whisper-cli。 */
const DEFAULT_BREAKER_MS = 5 * 60_000;
/** 响应体积上限：一段语音的文本远小于此，超出即视为异常输出。 */
const MAX_RESPONSE_BYTES = 512 * 1024;
const HEALTH_POLL_INTERVAL_MS = 150;

export type WhisperServerTranscribeInput = {
	requestId: string;
	/** 已落盘的 16kHz 单声道 WAV（文件生命周期由 WhisperTranscriber 负责）。 */
	wavPath: string;
	/** 生效的 whisper-cli 路径：server 与它同目录，据此定位。 */
	cliPath: string;
	modelPath: string;
	language: string;
};

/** `fallback` = 本引擎不可用/失败，调用方应改走 whisper-cli；`cancelled` = 用户主动取消。 */
export type WhisperServerResult = { status: "ok"; text: string } | { status: "fallback"; error: string } | { status: "cancelled" };

export type WhisperServerPoolDeps = {
	/** 解析与 CLI 同目录的 whisper-server；null = 该 CLI 旁没有 server（自定义路径/手工安装）。 */
	resolveServerPath: (input: { cliPath: string }) => string | null;
	/** 子进程环境（清洗后的 env）；undefined = 继承。 */
	getEnv?: () => NodeJS.ProcessEnv | undefined;
	threads?: number;
	log: (message: string, details?: Record<string, unknown>) => void;
	requestTimeoutMs?: number;
	startupTimeoutMs?: number;
	idleStopMs?: number;
	breakerMs?: number;
};

type RunningServer = {
	key: string;
	child: ChildProcess;
	baseUrl: string;
	exited: boolean;
	idleTimer: NodeJS.Timeout | null;
	stderrTail: string;
};

export class WhisperServerPool {
	private running: RunningServer | null = null;
	private starting: { key: string; promise: Promise<RunningServer | null> } | null = null;
	private unavailableUntil = 0;
	private readonly controllers = new Map<string, AbortController>();

	constructor(private readonly deps: WhisperServerPoolDeps) {}

	/** 是否处于熔断冷却期（设置页/日志据此解释「为什么这次又走了 CLI」）。 */
	get coolingDown(): boolean {
		return Date.now() < this.unavailableUntil;
	}

	async transcribe(input: WhisperServerTranscribeInput): Promise<WhisperServerResult> {
		const controller = new AbortController();
		this.controllers.set(input.requestId, controller);
		let server: RunningServer | null = null;
		try {
			server = await this.ensureServer(input);
			if (!server) return { status: "fallback", error: this.coolingDown ? "server-cooling-down" : "server-unavailable" };
			this.clearIdleTimer(server);
			const text = await this.infer(server, input, controller.signal);
			return { status: "ok", text };
		} catch (error) {
			if (controller.signal.aborted) return { status: "cancelled" };
			const message = error instanceof Error ? error.message : String(error);
			this.deps.log("request failed", { requestId: input.requestId, error: message });
			// 进程异常退出时把 running 交出去，下一次请求会拉起新实例。
			return { status: "fallback", error: message };
		} finally {
			this.controllers.delete(input.requestId);
			if (server && !server.exited && this.running === server) this.armIdleTimer(server);
		}
	}

	/** 取消进行中的请求：中断 HTTP，进程保留（下一次请求不必再等模型加载）。 */
	cancel(requestId: string): void {
		this.controllers.get(requestId)?.abort();
	}

	/**
	 * 停掉常驻进程（quit / 换模型 / 删模型 / 重装运行时）。
	 * 必须同时清熔断：否则「删掉模型又装回来」这种操作会带着冷却期，用户看不出原因。
	 */
	async shutdown(reason: string): Promise<void> {
		this.unavailableUntil = 0;
		const server = this.running;
		this.running = null;
		this.starting = null;
		if (!server) return;
		await this.terminate(server, reason);
	}

	private async ensureServer(input: WhisperServerTranscribeInput): Promise<RunningServer | null> {
		if (Date.now() < this.unavailableUntil) return null;
		const serverPath = this.deps.resolveServerPath({ cliPath: input.cliPath });
		if (!serverPath) {
			// 自定义 CLI 旁边常没有 server（手工装的单文件），这是常态而非故障：不熔断，只静默回退。
			return null;
		}
		const key = `${serverPath}\u0000${input.modelPath}`;
		const current = this.running;
		if (current && current.key === key && !current.exited) return current;
		const pending = this.starting;
		if (pending && pending.key === key) return pending.promise;
		const promise = this.startServer(key, serverPath, input.modelPath);
		this.starting = { key, promise };
		try {
			return await promise;
		} finally {
			if (this.starting?.key === key) this.starting = null;
		}
	}

	private async startServer(key: string, serverPath: string, modelPath: string): Promise<RunningServer | null> {
		await this.stopCurrent("restart");
		let lastError = "health-check-timeout";
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const port = await pickFreePort();
			if (port === 0) {
				lastError = "no-free-port";
				break;
			}
			const child = spawn(serverPath, ["-m", modelPath, "--host", "127.0.0.1", "--port", String(port), "-t", String(this.threadCount())], {
				cwd: dirname(serverPath),
				detached: process.platform !== "win32",
				stdio: ["ignore", "ignore", "pipe"],
				windowsHide: true,
				env: this.deps.getEnv?.(),
			});
			const server: RunningServer = { key, child, baseUrl: `http://127.0.0.1:${port}`, exited: false, idleTimer: null, stderrTail: "" };
			child.stderr?.on("data", (chunk: Buffer) => {
				// 只留尾部若干字节：加载日志很长，失败时要看的恰恰是最后几行。
				server.stderrTail = `${server.stderrTail}${chunk.toString("utf8")}`.slice(-2000);
			});
			// spawn 成功但进程秒退（模型文件被占用、DLL 缺失）时 pid 仍有效，只有
			// error 事件会给出真正原因——不接住它就只剩一句「 exited with code 1」。
			child.on("error", (error) => {
				server.exited = true;
				server.stderrTail = `${server.stderrTail}${error.message}`.slice(-2000);
			});
			child.on("exit", () => {
				server.exited = true;
				this.clearIdleTimer(server);
				if (this.running === server) this.running = null;
			});
			this.running = server;
			const ready = await this.waitForHealth(server);
			if (ready) {
				this.deps.log("server ready", { port, key: key.split("\u0000")[1] });
				return server;
			}
			lastError = server.stderrTail.trim().split("\n").pop() ?? "server exited early";
			await this.terminate(server, "startup-failed");
		}
		this.unavailableUntil = Date.now() + (this.deps.breakerMs ?? DEFAULT_BREAKER_MS);
		this.deps.log("server unavailable, falling back to whisper-cli", { error: lastError, cooldownMs: this.deps.breakerMs ?? DEFAULT_BREAKER_MS });
		return null;
	}

	private async waitForHealth(server: RunningServer): Promise<boolean> {
		const deadline = Date.now() + (this.deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
		while (Date.now() < deadline) {
			if (server.exited) return false;
			await sleep(HEALTH_POLL_INTERVAL_MS);
			try {
				const response = await fetch(`${server.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
				if (response.ok) return true;
			} catch {
				// 端口还没 listen 之前连接被拒是正常现象，继续轮询。
			}
		}
		return false;
	}

	private async infer(server: RunningServer, input: WhisperServerTranscribeInput, signal: AbortSignal): Promise<string> {
		const bytes = await readFile(input.wavPath);
		const form = new FormData();
		form.append("file", new Blob([bytes], { type: "audio/wav" }), "speech.wav");
		form.append("response_format", "json");
		form.append("no_timestamps", "true");
		// 空语言交给 whisper 自动检测；server 对未知语言名会直接 500，比 CLI 的静默英文更可见。
		form.append("language", input.language.trim() || "auto");
		// 贪心解码：默认 best_of=2 + beam_size=-1 + temperature_inc=0.2 会做多次采样回退，
		// 实测把单段耗时拉高近一倍，而口述场景的准确率差异在这个档位上几乎看不出来。
		form.append("best_of", "1");
		form.append("beam_size", "1");
		form.append("temperature_inc", "0");
		form.append("suppress_nst", "true");
		form.append("prompt", VOICE_SIMPLIFIED_CHINESE_PROMPT);
		form.append("carry_initial_prompt", "true");
		const response = await fetch(`${server.baseUrl}/inference`, {
			method: "POST",
			body: form,
			signal: AbortSignal.any([signal, AbortSignal.timeout(this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)]),
		});
		if (!response.ok) throw new Error(`inference failed with ${response.status}`);
		const body = await response.text();
		if (body.length > MAX_RESPONSE_BYTES) throw new Error("inference response exceeded limit");
		const parsed: unknown = JSON.parse(body);
		const text = parsed && typeof parsed === "object" && "text" in parsed ? (parsed as { text: unknown }).text : "";
		return typeof text === "string" ? text.trim() : "";
	}

	private threadCount(): number {
		if (this.deps.threads && this.deps.threads > 0) return this.deps.threads;
		// whisper.cpp 线程数超过物理核反而更慢；拿不到物理核数时按逻辑核的一半估（超线程机型）。
		return Math.max(2, Math.min(8, Math.ceil(availableParallelism() / 2)));
	}

	private armIdleTimer(server: RunningServer): void {
		this.clearIdleTimer(server);
		server.idleTimer = setTimeout(() => {
			server.idleTimer = null;
			this.deps.log("idle timeout, stopping resident server");
			void this.terminate(server, "idle");
		}, this.deps.idleStopMs ?? DEFAULT_IDLE_STOP_MS);
	}

	private clearIdleTimer(server: RunningServer): void {
		if (!server.idleTimer) return;
		clearTimeout(server.idleTimer);
		server.idleTimer = null;
	}

	private async stopCurrent(reason: string): Promise<void> {
		const server = this.running;
		this.running = null;
		if (server) await this.terminate(server, reason);
	}

	private async terminate(server: RunningServer, reason: string): Promise<void> {
		this.clearIdleTimer(server);
		if (this.running === server) this.running = null;
		if (server.child.pid !== undefined && !server.exited) {
			killProcessTree(server.child.pid);
			await this.waitForExit(server);
		}
		server.exited = true;
		this.deps.log("server stopped", { reason });
	}

	private async waitForExit(server: RunningServer): Promise<void> {
		const deadline = Date.now() + 2000;
		while (!server.exited && Date.now() < deadline) await sleep(50);
	}

	/** 进行中的请求全部作废（组件卸载/退出）：先断 HTTP，再停进程。 */
	abortAll(): void {
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
	}
}

/** 取一个空闲端口：bind(0) 让系统分配后再立即释放。 */
async function pickFreePort(): Promise<number> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.unref();
		probe.on("error", () => resolve(0));
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
