/**
 * 提示词增强的宿主侧服务。
 *
 * 职责：按需拉起/复用一个常驻助手进程（`resources/pi-enhance-host.mjs`，复用
 * 用户自己那套 pi 的 ModelRuntime），把助手的 NDJSON 记录转译成共享契约的事件，
 * 按渲染层回调转发（delta/done/aborted/error，全部按 runId 配对）。
 *
 * 为什么是常驻单进程而不是每次一个：增强是高频小操作，进程冷启动（node + pi
 * SDK）会让每次点击都多等约 1s；且旧 run 必须能被新 run 打断，常驻进程让
 * 「取消旧的、立即起新的」在同一进程内完成，不产生进程风暴。
 *
 * 与认证助手（PiAuthService，一次操作一个进程）不同，这里同进程串行跑多个
 * run：每个记录都带 id，宿主只认 `activeRun.id`，旧 id 的迟到记录直接丢弃。
 * 生命周期纪律（本文件是所有清理路径的唯一归属地）：
 * - 新 run 到来时先取消助手侧旧 run 并本地结算（回调 onAborted），再发 complete；
 *   受理路径经 acceptChain 串行化，避免两次点击在 boot 等待窗口内交错双跑；
 * - run 超时 / 助手退出 / spawn 失败 / dispose 都会结算 activeRun；
 * - 助手进程意外退出后允许下次调用重新拉起（childReady 复位即重试路径）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { EnhanceErrorKind, EnhanceRunInput } from "../../../shared/types/enhance";
import type { AppLogger } from "../../logging/AppLogger";
import type { PiAuthHostLaunch, PiAuthHostLaunchFailureReason } from "../auth/piAuthHostLaunch";

/** 助手协议版本；与 `resources/pi-enhance-host.mjs` 的 PROTOCOL_VERSION 对应。 */
export const PI_ENHANCE_PROTOCOL_VERSION = 1;

/** 助手脚本文件名（打包进 extraResources；dev 在 appPath/resources 下）。 */
export const PI_ENHANCE_HOST_FILENAME = "pi-enhance-host.mjs";

/** 拉起进程到 ready 的上限：node 启动 + 加载 pi SDK，正常 1s 内，留足余量。 */
const DEFAULT_BOOT_TIMEOUT_MS = 15_000;
/**
 * 单次增强的上限：模型首 token 在慢供应商/推理档上可能要几十秒，完整改写
 * 千字草稿也就一两分钟；5 分钟足够宽，同时保证进程不会无限期挂着。
 */
const DEFAULT_RUN_TIMEOUT_MS = 5 * 60_000;

/** 助手 stdout 单行缓冲硬上限：协议帧都是小 JSON，超限即按协议错误结算。 */
export const MAX_ENHANCE_HOST_LINE_CHARS = 8 * 1024 * 1024;

/**
 * 内置增强提示词（workbuddy 风格）。
 * 内容与 docs/pi-prompt-templates/enhance-prompt.md 同源（该目录是历史内置
 * 模板的归档）；打包后读不到 docs/，因此运行时以这份常量为唯一来源。
 */
export const ENHANCE_SYSTEM_PROMPT = `你是一位提示词工程专家，专门为 AI 编程助手优化用户提示词。用户会发来一段需求草稿，你的任务是把它改写成更清晰、更具体、更可执行的增强版提示词——不是执行它，也不是回答它。

## 分析流程
1. 评估原始草稿：明确主要目标、含糊之处、缺失的上下文、已有的明确约束
2. 应用提示词工程原则：让任务和范围清晰、补充必要上下文、明确预期输出、在有助于理解时添加示例
3. 重写为增强版：保持原始目标不变，补齐有意义的细节、边界情况和质量要求

## 硬性约束
- 语言一致（最高优先级）：必须使用与草稿完全相同的语言输出，中文草稿 → 中文增强版，不要混入其他语言
- 只输出增强后的提示词，不要任何前言、解释、语言标注或分析
- 不回答草稿中的问题——把它们展开/改写为更详细的需求
- 不请求指南/教程，不索取代码片段
- 不推荐草稿中未提到的技术选型
- 不解释如何做，只明确要做什么
- 保持简洁：增强版不超过 800 字
- 草稿已足够清晰时做轻度润色，而不是原样返回

直接输出增强后的提示词。`;

/** 助手 stdout 记录（协议 v1）。仅主进程侧使用，不跨进程。 */
type HostRecord = { type: "ready"; protocolVersion?: number } | { type: "started"; id?: string } | { type: "delta"; id?: string; text?: string } | { type: "done"; id?: string; text?: string } | { type: "error"; id?: string; errorKind?: string; message?: string } | { type: "fatal"; stage?: string; message?: string };

export type EnhanceLogger = {
	debug: (message: string) => void;
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
};

/** 一次 run 的终端回调集：每个回调在整个生命周期内恰好被调用一次。 */
export type EnhanceRunCallbacks = {
	onDelta: (text: string) => void;
	onDone: (text: string) => void;
	onAborted: () => void;
	onError: (errorKind: EnhanceErrorKind, message: string) => void;
};

export type EnhanceAcceptResult = { ok: true; runId: string } | { ok: false; errorKind: EnhanceErrorKind; message: string };

export type EnhancePromptServiceOptions = {
	/** 由装配层注入：需要 app 路径、settings 与 PiLocator，服务本身不碰 electron。 */
	resolveLaunch: () => PiAuthHostLaunch;
	logger?: EnhanceLogger;
	/** 便于单测替换 spawn；默认用 node:child_process。 */
	spawnFn?: typeof spawn;
	/** 超时可覆盖：单测用它缩短等待，生产用默认值。 */
	timeouts?: { boot?: number; run?: number };
};

const LAUNCH_FAILURE_HINT: Record<PiAuthHostLaunchFailureReason, string> = {
	wsl: "pi 运行在 WSL 中，提示词增强暂不可用。",
	"no-pi-entry": "找不到 pi 可加载的 JS 入口（可能是编译版单文件 pi），提示词增强暂不可用。",
	"helper-missing": "应用缺少增强助手文件 resources/pi-enhance-host.mjs，请重新安装或更新 PiDeck。",
};

/** 本地结算时各错误分类的默认详情；不覆盖助手/调用方给出的具体原因。 */
const SETTLE_FALLBACK_MESSAGE: Partial<Record<EnhanceErrorKind, string>> = {
	timeout: "增强请求超时，已自动停止",
	protocol: "增强请求失败",
	"model-error": "模型返回错误",
};

/**
 * 把启动失败原因归一到共享契约的错误分类。
 * 三种原因对用户都是「这条通道现在起不来」，细节靠 message 区分。
 */
function mapLaunchFailure(reason: PiAuthHostLaunchFailureReason): { errorKind: EnhanceErrorKind; message: string } {
	return { errorKind: "sdk-unavailable", message: LAUNCH_FAILURE_HINT[reason] };
}

/** 收窄助手上报的错误分类；未知值退回 protocol，渲染层永远能选到文案。 */
const HOST_ERROR_KINDS = new Set<EnhanceErrorKind>(["invalid-request", "helper-missing", "wsl", "no-pi-entry", "spawn-failed", "sdk-unavailable", "model-not-found", "no-provider", "busy", "aborted", "timeout", "protocol", "model-error"]);

function mapHostErrorKind(kind: string | undefined, fallback: EnhanceErrorKind): EnhanceErrorKind {
	return kind && HOST_ERROR_KINDS.has(kind as EnhanceErrorKind) ? (kind as EnhanceErrorKind) : fallback;
}

/** 从原生 Error、跨 realm 错误或未知抛出值中提取稳定的可展示详情。 */
function getErrorMessage(error: unknown): string {
	if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
	return String(error);
}

/** 解析助手的一行 stdout；非 JSON 或结构异常返回 undefined（前向兼容）。 */
function parseHostRecord(line: string): HostRecord | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return typeof (parsed as { type?: unknown }).type === "string" ? (parsed as HostRecord) : undefined;
	} catch {
		return undefined;
	}
}

export class EnhancePromptService {
	private readonly resolveLaunch: () => PiAuthHostLaunch;
	private readonly logger?: EnhanceLogger;
	private readonly spawnFn: typeof spawn;
	private readonly bootTimeoutMs: number;
	private readonly runTimeoutMs: number;

	private disposed = false;
	private child: ChildProcessWithoutNullStreams | null = null;
	/** 当前进程的 boot 完成信号："ready" 可用；"dead" 表示本进程不可用（下次重拉）。 */
	private childReady: Promise<"ready" | "dead"> | null = null;
	private notifyReady: () => void = () => {};
	private notifyDead: () => void = () => {};
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	private activeRun: { id: string; callbacks: EnhanceRunCallbacks; timer: NodeJS.Timeout; accepted: boolean } | null = null;
	private stderrTail: string[] = [];
	/** 受理路径互斥：同一时刻只有一次 enhance() 在走 settle→boot→write 序列。 */
	private acceptChain: Promise<unknown> = Promise.resolve();

	constructor(options: EnhancePromptServiceOptions) {
		this.resolveLaunch = options.resolveLaunch;
		this.logger = options.logger;
		this.spawnFn = options.spawnFn ?? spawn;
		this.bootTimeoutMs = options.timeouts?.boot ?? DEFAULT_BOOT_TIMEOUT_MS;
		this.runTimeoutMs = options.timeouts?.run ?? DEFAULT_RUN_TIMEOUT_MS;
	}

	/**
	 * 发起一次增强。受理成功后，终态一律通过回调送达（done/aborted/error 各恰好
	 * 一次）；受理失败（通道起不来）同步返回错误。
	 */
	enhance(input: EnhanceRunInput, callbacks: EnhanceRunCallbacks): Promise<EnhanceAcceptResult> {
		if (this.disposed) return Promise.resolve({ ok: false, errorKind: "sdk-unavailable", message: "提示词增强服务已停止" });
		const accepted = this.acceptChain.then(
			() => this.acceptInternal(input, callbacks),
			() => this.acceptInternal(input, callbacks),
		);
		this.acceptChain = accepted.then(
			() => undefined,
			() => undefined,
		);
		return accepted;
	}

	/** 串行化的受理实现：打断旧的 → 确保 helper 进程 ready → 登记 run → 下发。 */
	private async acceptInternal(input: EnhanceRunInput, callbacks: EnhanceRunCallbacks): Promise<EnhanceAcceptResult> {
		// 先停掉助手侧旧模型流，再本地结算；只清 UI 会让旧请求继续消耗额度。
		// 旧 id 的迟到记录被丢弃，不等待助手确认，也不会二次回调。
		this.cancel();
		const boot = await this.ensureChild();
		if (boot !== "ready") {
			return { ok: false, errorKind: "sdk-unavailable", message: "增强助手启动失败，请重试" };
		}
		const child = this.child;
		if (!child) return { ok: false, errorKind: "sdk-unavailable", message: "增强助手启动失败，请重试" };
		const runId = randomUUID();
		// 先登记 activeRun，再写 complete：Writable 可能在 write() 内同步发出 error，
		// 只有这样 stdin 错误处理器才能立即结算本次 run。此时先标记为未受理，
		// 因为写入失败时回调不能与同步的 ok:false 结果同时对外发出。
		const timer = setTimeout(() => {
			this.logger?.warn(`增强请求超时（${Math.round(this.runTimeoutMs / 1000)}s）：runId=${runId}`);
			this.sendToHelper({ cmd: "cancel", id: runId });
			if (this.activeRun?.id === runId) this.settleActive("timeout");
		}, this.runTimeoutMs);
		// 定时器必须在写入首帧前就存在：异步 stdin error 可能紧跟 write() 触发，
		// 此时错误处理会同步清理 activeRun，不能留下一个永不结算的定时器。
		this.activeRun = { id: runId, callbacks, timer, accepted: false };
		const sent = this.sendToHelper({ cmd: "complete", id: runId, provider: input.provider, modelId: input.modelId, systemPrompt: ENHANCE_SYSTEM_PROMPT, userText: input.userText });
		if (!sent.ok) {
			if (this.activeRun?.id === runId) this.settleActive("protocol", sent.message);
			else clearTimeout(timer);
			return { ok: false, errorKind: "protocol", message: sent.message };
		}
		if (this.activeRun?.id !== runId) {
			clearTimeout(timer);
			return { ok: false, errorKind: "protocol", message: "增强助手输入管道已关闭，请重试" };
		}
		this.activeRun.accepted = true;
		return { ok: true, runId };
	}

	/** 取消当前 run（渲染层停止按钮）。没有进行中的 run 时静默。 */
	cancel(): void {
		const run = this.activeRun;
		if (!run) return;
		this.sendToHelper({ cmd: "cancel", id: run.id });
		this.settleActive("aborted");
	}

	/** 应用退出时由装配层调用；结算一切并停掉助手进程。 */
	dispose(): void {
		this.disposed = true;
		this.settleActive("aborted");
		this.killChild("dispose");
	}

	// ------------------------------------------------------------------
	// 子进程生命周期
	// ------------------------------------------------------------------

	/** 拉起（或复用）助手进程并等到 ready。失败返回 "dead"，下次调用会重试新进程。 */
	private ensureChild(): Promise<"ready" | "dead"> {
		if (this.disposed) return Promise.resolve("dead");
		if (this.child && this.childReady) return this.childReady;
		const launch = this.resolveLaunch();
		if (!launch.ok) {
			this.logger?.warn(`增强助手启动参数解析失败：${launch.reason}${launch.detail ? `（${launch.detail}）` : ""}`);
			return Promise.resolve("dead");
		}
		this.logger?.debug(`启动增强助手：${launch.nodeExe} ${launch.helperPath}`);
		const child = this.spawnFn(launch.nodeExe, [launch.helperPath], {
			env: launch.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		}) as ChildProcessWithoutNullStreams;
		this.child = child;
		this.stderrTail = [];
		// write 的异步 EPIPE 不会被 try/catch 或 child 的 error 监听捕获。
		// 监听保留到旧进程被回收，身份核对让迟到管道错误只被吸收、不影响新 run。
		child.stdin.on("error", (error: Error) => this.handleChildStdinError(child, error));
		// kill 后 close/stdout 仍可能迟到；必须在消费事件处核对进程身份,
		// 否则旧助手会结算新 run，甚至用旧 ready 跳过新助手的握手。
		child.stdout.on("data", (chunk: Buffer) => {
			if (this.child === child) this.consumeStdout(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (this.child !== child) return;
			const line = chunk.toString("utf8").trim();
			if (line) this.stderrTail.push(line);
			if (this.stderrTail.length > 10) this.stderrTail.shift();
		});
		// error/close 都把本进程标记为不可用：下次调用 ensureChild 走重拉路径。
		child.on("error", (error) => {
			if (this.child !== child) return;
			this.logger?.error(`增强助手进程错误：${error.message}`);
			this.markChildDead("spawn-failed", error.message);
		});
		child.on("close", (code) => {
			if (this.child !== child) return;
			const tail = this.stderrTail.at(-1);
			this.logger?.warn(`增强助手退出（code ${code ?? "null"}）${tail ? `：${tail}` : ""}`);
			this.markChildDead("protocol", `增强助手意外退出（code ${code ?? "null"}）${tail ? `：${tail}` : ""}`);
		});
		const ready = new Promise<"ready" | "dead">((resolveReady) => {
			const bootTimer = setTimeout(() => {
				this.logger?.warn(`增强助手 boot 超时（${Math.round(this.bootTimeoutMs / 1000)}s）`);
				resolveReady("dead");
				this.killChild("boot-timeout");
			}, this.bootTimeoutMs);
			this.notifyReady = () => {
				clearTimeout(bootTimer);
				resolveReady("ready");
			};
			this.notifyDead = () => {
				clearTimeout(bootTimer);
				resolveReady("dead");
			};
		});
		this.childReady = ready;
		return ready;
	}

	/** 清空当前进程引用并唤醒 boot 等待者；返回原引用供 kill，可安全重复调用。 */
	private teardownChild(): ChildProcessWithoutNullStreams | null {
		const child = this.child;
		this.child = null;
		this.childReady = null;
		// 半帧/半字符只属于原进程，不能与重拉助手的第一条 ready 拼接。
		this.buffer = "";
		this.decoder = new StringDecoder("utf8");
		this.notifyDead();
		return child;
	}

	/** 结束当前进程；close/error 分支负责后续结算与状态复位。 */
	private killChild(reason: string): void {
		const child = this.teardownChild();
		if (!child) return;
		this.logger?.debug(`停止增强助手（${reason}）`);
		try {
			child.kill();
		} catch {
			// 进程已死时的 kill 抛错可以忽略；close 监听负责收尾。
		}
	}

	/** 同步写入异常和异步管道错误共用收尾；旧进程的迟到错误只吸收。 */
	private handleChildStdinError(child: ChildProcessWithoutNullStreams, error: unknown): string | undefined {
		if (this.child !== child) return undefined;
		const message = `增强助手输入管道错误：${getErrorMessage(error)}`;
		this.logger?.error(message);
		this.killChild("stdin-error");
		this.settleActive("protocol", message);
		return message;
	}

	/** 把当前进程标为不可用并结算进行中的 run（进程自行退出路径）。 */
	private markChildDead(errorKind: EnhanceErrorKind, message: string): void {
		this.teardownChild();
		this.settleActive(errorKind, message);
	}

	// ------------------------------------------------------------------
	// 消息泵
	// ------------------------------------------------------------------

	private consumeStdout(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		if (this.buffer.length > MAX_ENHANCE_HOST_LINE_CHARS) {
			const dropped = this.buffer.length;
			this.buffer = "";
			this.logger?.error(`增强助手 stdout 行缓冲溢出：丢弃 ${dropped} 字节无换行输出`);
			this.killChild("protocol");
			this.settleActive("protocol", "增强助手 stdout 行缓冲溢出");
			return;
		}
		for (;;) {
			const lf = this.buffer.indexOf("\n");
			if (lf === -1) break;
			const line = this.buffer.slice(0, lf);
			this.buffer = this.buffer.slice(lf + 1);
			this.handleRecord(parseHostRecord(line));
		}
	}

	private handleRecord(record: HostRecord | undefined): void {
		if (!record) return;
		switch (record.type) {
			case "ready": {
				if (record.protocolVersion !== PI_ENHANCE_PROTOCOL_VERSION) {
					this.logger?.error(`增强助手协议版本不匹配：助手=${String(record.protocolVersion)} 宿主=${PI_ENHANCE_PROTOCOL_VERSION}`);
					this.killChild("protocol-version");
					this.settleActive("protocol", `增强助手协议版本不匹配（${String(record.protocolVersion)}）`);
					return;
				}
				this.notifyReady();
				return;
			}
			case "fatal": {
				this.logger?.error(`增强助手致命错误（${record.stage ?? "unknown"}）：${record.message ?? ""}`);
				this.killChild("fatal");
				this.settleActive("sdk-unavailable", record.message ?? "增强助手启动失败");
				return;
			}
			default:
				break;
		}
		// run 记录：只认当前 activeRun 的 id，旧 run 的迟到记录直接丢弃。
		const run = this.activeRun;
		if (!run || record.id !== run.id) return;
		switch (record.type) {
			case "started":
				// 受理时已本地确认，无需处理；保留分支以显式忽略。
				break;
			case "delta":
				if (typeof record.text === "string" && record.text.length > 0) run.callbacks.onDelta(record.text);
				break;
			case "done":
				clearTimeout(run.timer);
				this.activeRun = null;
				run.callbacks.onDone(typeof record.text === "string" ? record.text : "");
				break;
			case "error": {
				clearTimeout(run.timer);
				this.activeRun = null;
				const kind = mapHostErrorKind(record.errorKind, "protocol");
				if (kind === "aborted") run.callbacks.onAborted();
				else run.callbacks.onError(kind, record.message ?? SETTLE_FALLBACK_MESSAGE[kind] ?? "增强请求失败");
				break;
			}
		}
	}

	// ------------------------------------------------------------------
	// 基础设施
	// ------------------------------------------------------------------

	private sendToHelper(message: unknown): { ok: true } | { ok: false; message: string } {
		const child = this.child;
		if (!child) return { ok: false, message: "增强助手未运行，请重试" };
		try {
			child.stdin.write(`${JSON.stringify(message)}\n`);
			// 测试替身或某些 Writable 实现可能在 write() 内同步发出 error；
			// 此时监听器已清空当前 child，不能把它当作成功写入。
			if (this.child !== child) return { ok: false, message: "增强助手输入管道已关闭，请重试" };
			return { ok: true };
		} catch (error) {
			// Writable 也可能同步抛错；不能只等待未来的 close，否则当前 run 会一直
			// 占着 activeRun 到超时，且 boot 阶段的受理者会拿到一个假成功。
			return { ok: false, message: this.handleChildStdinError(child, error) ?? "增强助手输入管道已关闭，请重试" };
		}
	}

	/**
	 * 本地结算当前 run（不动助手进程）。被新 run 取代 / cancel / dispose /
	 * 进程死亡时用：助手侧旧 run 的迟到记录会因 id 不匹配被丢弃，不会二次回调。
	 */
	private settleActive(errorKind: EnhanceErrorKind, message?: string): void {
		const run = this.activeRun;
		if (!run) return;
		clearTimeout(run.timer);
		this.activeRun = null;
		// 首帧写入失败时，受理方还会收到同步的 ok:false；不能再异步发一个
		// error 回调，避免 IPC 同时发布 error 和受理失败两条终态。
		if (!run.accepted) return;
		if (errorKind === "aborted" && !message) run.callbacks.onAborted();
		else run.callbacks.onError(errorKind, message ?? SETTLE_FALLBACK_MESSAGE[errorKind] ?? "增强请求失败");
	}
}
