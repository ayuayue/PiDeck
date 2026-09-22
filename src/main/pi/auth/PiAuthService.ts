/**
 * pi 供应商认证的宿主侧服务。
 *
 * 职责：按需拉起/回收认证助手进程（`resources/pi-auth-host.mjs`），把助手的
 * NDJSON 消息翻译成共享契约里的类型，并把「登录流程事件 / 待回答提问」推给渲染层。
 *
 * 为什么是一个子进程而不是主进程内直接 import pi 的 SDK：pi 的认证流程会拉起
 * 本地回调服务器、轮询设备码、读写 pi 的凭据目录，进程边界让它随「用完即杀」
 * 一起收干净，也避免 pi SDK 与 Electron 主进程共享模块状态。这是 PiDeck 访问
 * pi 内部能力的唯一例外通道，边界见仓库根 AGENTS.md「认证例外通道」。
 *
 * 生命周期纪律（本文件是所有清理路径的唯一归属地）：
 * - 每次操作一个助手进程；拿到 result / 取消 / 超时 / 助手退出都会走到 `settle()`；
 * - `settle()` 统一 kill 子进程、关闭 readline、清定时器、唤醒等待者；
 * - 应用退出时装配层调用 `dispose()`，同样走 `settle()`。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { PiAuthErrorKind, PiAuthFlowUpdate, PiAuthLoginRequest, PiAuthLoginResult, PiAuthLogoutResult, PiAuthProviderOption, PiAuthProviderList } from "../../../shared/types/piAuth";
import type { AppLogger } from "../../logging/AppLogger";
import type { PiAuthHostLaunch, PiAuthHostLaunchFailureReason } from "./piAuthHostLaunch";

/** 助手协议版本；与 `resources/pi-auth-host.mjs` 的 PROTOCOL_VERSION 对应。 */
export const PI_AUTH_PROTOCOL_VERSION = 1;

/** 拉起进程到收到结果的上限：node 启动 + 加载 pi SDK，正常在 1s 内。 */
const DEFAULT_SHORT_OPERATION_TIMEOUT_MS = 15_000;
/**
 * 登录的上限：流程包含用户在浏览器里完成授权，不能卡太紧；但也不能没有上限——
 * 渲染层关掉弹框后若助手无响应，只靠 cancel 指令会留下一个常驻子进程。
 */
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;

/** 助手进程上报的供应商条目；比跨 IPC 契约多一个来源标记（可选：旧助手/判定不出时不带）。 */
type HostAuthProviderOption = PiAuthProviderOption & { builtIn?: boolean };

/** 助手的 stdout 消息（协议 v1）。仅主进程侧使用，不跨进程，因此不放进 shared。 */
type HostMessage =
	| { type: "ready"; protocolVersion?: number; piVersion?: string | null }
	| { type: "providers"; providers?: HostAuthProviderOption[]; piVersion?: string | null }
	| { type: "event"; event: unknown }
	| { type: "prompt"; id: string; prompt: { kind: string; message: string; placeholder?: string; options?: readonly { id: string; label: string; description?: string }[] } }
	| { type: "prompt-cancelled"; id: string }
	| { type: "result"; ok: boolean; cancelled?: boolean; command?: string; providerId?: string; error?: { message?: string; kind?: string } }
	| { type: "fatal"; stage?: string; message?: string };

type HostSessionOutcome = { kind: "result"; message: HostMessage } | { kind: "error"; errorKind: PiAuthErrorKind; message: string };

/** 认证服务的日志口：与 AppLogger 对齐但只关心「记一条」，不需要 await。 */
export type PiAuthLogger = {
	debug: (message: string) => void;
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
};

/**
 * 只保留 pi 自己支持的认证供应商，滤掉 `models.json` 里用户自定义的供应商。
 *
 * 为什么要在宿主侧过滤：pi 的 `getProviders()` 把「内置目录 + 本地自定义」合成一份，
 * 自定义项的认证描述是 pi 兜底生成的（`apiKey.name` 恒为 "API key"），列进登录列表
 * 既没有信息量（密钥早已在模型设置里填过），又会把真正可登录的项淹掉。
 * 只有 `builtIn === false` 才算「明确非内置」；字段缺失（pi 改了内部结构、旧助手）
 * 一律保留——宁可多显示，也不能把供应商列表清空。
 */
export function filterSupportedAuthProviders(providers: HostAuthProviderOption[]): PiAuthProviderOption[] {
	return providers.filter((provider) => provider.builtIn !== false);
}

export type PiAuthLaunchResolver = () => PiAuthHostLaunch;

export type PiAuthServiceOptions = {
	/** 由装配层注入：需要 app 路径、settings 与 PiLocator，服务本身不碰 electron。 */
	resolveLaunch: PiAuthLaunchResolver;
	logger?: PiAuthLogger;
	/** 便于单测替换 spawn；默认用 node:child_process。 */
	spawnFn?: typeof spawn;
	/** 超时可覆盖：单测用它缩短等待，生产用默认值。 */
	timeouts?: { short?: number; login?: number };
};

/** 「登录流程推送」的订阅者；由 IPC 层注册，把更新转发到渲染进程。 */
export type PiAuthFlowSink = (update: PiAuthFlowUpdate) => void;

const LAUNCH_FAILURE_HINT: Record<PiAuthHostLaunchFailureReason, string> = {
	wsl: "pi 运行在 WSL 中，无法在应用内完成登录；请在 WSL 终端执行 pi 后输入 /login。",
	"no-pi-entry": "找不到 pi 可加载的 JS 入口（可能是编译版单文件 pi）；请在终端执行 pi 后输入 /login。",
	"helper-missing": "应用缺少认证助手文件 resources/pi-auth-host.mjs，请重新安装或更新 PiDeck。",
};

/**
 * 一次助手进程会话：负责消息泵、结算与清理。
 *
 * 消息泵的必要性：助手在 spawn 后可能立刻吐 `ready`/`fatal`（SDK 缺失时几乎瞬时），
 * 而调用方要等「拿到 session 之后」才注册等待——若此时才挂 `line` 监听，早期消息
 * 会被 readline 丢掉，表现为「明明有明确原因却报超时」。所以这里在 spawn 当场就
 * 开始收集消息，等待者从队列取。
 */
class AuthHostSession {
	readonly child: ChildProcessWithoutNullStreams;
	readonly done: Promise<void>;
	private readonly logger?: PiAuthLogger;
	private readonly readline: ReadlineInterface;
	private readonly pending: HostMessage[] = [];
	private readonly waiters: Array<(message: HostMessage | undefined) => void> = [];
	private readonly timers: NodeJS.Timeout[] = [];
	private readonly stderrTail: string[] = [];
	private settled = false;
	private settleOutcome?: HostSessionOutcome;
	private resolveDone: () => void = () => {};

	constructor(child: ChildProcessWithoutNullStreams, logger?: PiAuthLogger) {
		this.child = child;
		this.logger = logger;
		this.done = new Promise<void>((resolve) => {
			this.resolveDone = resolve;
		});
		this.readline = createInterface({ input: child.stdout });
		this.readline.on("line", (line) => {
			const message = parseHostMessage(line);
			if (!message) return;
			const waiter = this.waiters.shift();
			if (waiter) waiter(message);
			else this.pending.push(message);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").trimEnd();
			if (!text) return;
			// 只留最近若干行：足够定位问题，又不让日志无界增长。
			this.stderrTail.push(text);
			if (this.stderrTail.length > 20) this.stderrTail.shift();
		});
		child.on("error", (error) => this.settle({ kind: "error", errorKind: "spawn-failed", message: error.message }));
		child.on("close", (code) => this.settle({ kind: "error", errorKind: "protocol", message: `认证助手意外退出（code ${code ?? "null"}）${this.stderrTail.at(-1) ? `：${this.stderrTail.at(-1)}` : ""}` }));
	}

	get isSettled(): boolean {
		return this.settled;
	}

	/** 助手日志，用于错误上下文（stdout 是协议通道，日志只在 stderr）。 */
	get diagnostics(): string {
		return this.stderrTail.join("\n");
	}
	send(command: Record<string, unknown>): void {
		if (this.settled || this.child.stdin.destroyed) return;
		this.child.stdin.write(`${JSON.stringify(command)}\n`);
	}

	/** 取一条消息；会话结束时返回 undefined（等待者由 settle 统一唤醒）。 */
	nextMessage(): Promise<HostMessage | undefined> {
		const queued = this.pending.shift();
		if (queued) return Promise.resolve(queued);
		if (this.settled) return Promise.resolve(undefined);
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	/**
	 * 结算原因；等待方在消息泵返回 undefined 后读它，才能拿到精确失败原因
	 * （spawn ENOENT / 助手带退出码退出 / 超时），而不是笼统的「已退出」。
	 */
	get outcome(): HostSessionOutcome | undefined {
		return this.settleOutcome;
	}

	/** 注册超时定时器；结算时统一清理，避免遗留 timer 让主进程保持存活。 */
	addTimeout(ms: number, onTimeout: () => void): void {
		this.timers.push(setTimeout(onTimeout, ms));
	}

	/**
	 * 结算会话：只生效一次。kill 子进程的失败不影响结算结果——用户要看到的是
	 * 「登录失败了/取消了」，而不是「进程清理报错」。
	 */
	settle(outcome: HostSessionOutcome): void {
		if (this.settled) return;
		this.settled = true;
		this.settleOutcome = outcome;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.length = 0;
		this.readline.close();
		this.child.stdout.removeAllListeners();
		this.child.stderr.removeAllListeners();
		this.child.removeAllListeners();
		this.child.kill();
		for (const waiter of this.waiters.splice(0)) waiter(undefined);
		if (outcome.kind === "error") {
			const stderr = this.diagnostics;
			this.logger?.warn(`认证助手异常结束：${outcome.errorKind} ${outcome.message}${stderr ? ` | stderr: ${stderr}` : ""}`);
		}
		this.resolveDone();
	}
}

export class PiAuthService {
	private readonly resolveLaunch: PiAuthLaunchResolver;
	private readonly logger?: PiAuthLogger;
	private readonly spawnFn: typeof spawn;
	private readonly shortTimeoutMs: number;
	private readonly loginTimeoutMs: number;
	private flowSink?: PiAuthFlowSink;
	/** 进行中的独占操作（login / logout）：一次只允许一个，避免两个进程同时写凭据。 */
	private exclusiveSession?: AuthHostSession;
	private disposed = false;

	constructor(options: PiAuthServiceOptions) {
		this.resolveLaunch = options.resolveLaunch;
		this.logger = options.logger;
		this.spawnFn = options.spawnFn ?? spawn;
		this.shortTimeoutMs = options.timeouts?.short ?? DEFAULT_SHORT_OPERATION_TIMEOUT_MS;
		this.loginTimeoutMs = options.timeouts?.login ?? DEFAULT_LOGIN_TIMEOUT_MS;
	}

	/** 注册登录流程推送出口；传 undefined 取消订阅（窗口销毁时调用）。 */
	setFlowSink(sink: PiAuthFlowSink | undefined): void {
		this.flowSink = sink;
	}

	get busy(): boolean {
		return this.exclusiveSession !== undefined;
	}

	/**
	 * 列出 pi 支持的供应商与当前凭据状态。
	 * 只读快照，不占用独占槽位——登录进行中也能刷新列表。
	 */
	async listProviders(): Promise<{ ok: true; list: PiAuthProviderList } | { ok: false; errorKind: PiAuthErrorKind; error: string }> {
		const opened = this.openSession();
		if (!opened.ok) return { ok: false, errorKind: opened.errorKind, error: opened.error };
		const session = opened.session;
		try {
			session.send({ cmd: "list" });
			const outcome = await this.awaitOutcome(session, (message) => message.type === "providers", "列出供应商", this.shortTimeoutMs);
			if (outcome.kind === "error") return { ok: false, errorKind: outcome.errorKind, error: outcome.message };
			const message = outcome.message as Extract<HostMessage, { type: "providers" }>;
			return { ok: true, list: { providers: filterSupportedAuthProviders(message.providers ?? []), piVersion: message.piVersion ?? undefined } };
		} finally {
			session.settle({ kind: "error", errorKind: "protocol", message: "list finished" });
		}
	}

	/** 开始一次登录；事件/提问经 flowSink 推送，直到结果、取消或超时。 */
	async login(request: PiAuthLoginRequest): Promise<PiAuthLoginResult> {
		if (this.exclusiveSession) {
			return { ok: false, cancelled: false, providerId: request.providerId, error: "已有登录流程正在进行", errorKind: "busy" };
		}
		const opened = this.openSession();
		if (!opened.ok) {
			return { ok: false, cancelled: false, providerId: request.providerId, error: opened.error, errorKind: opened.errorKind };
		}
		const session = opened.session;
		this.exclusiveSession = session;
		try {
			// 助手会把未 ready 前收到的指令排队（见其 queuedCommands），无需先等 ready。
			session.send({ cmd: "login", providerId: request.providerId, type: request.method });
			const outcome = await this.awaitOutcome(session, (message) => message.type === "result", "登录", this.loginTimeoutMs);
			if (outcome.kind === "error") {
				return { ok: false, cancelled: false, providerId: request.providerId, error: outcome.message, errorKind: outcome.errorKind };
			}
			const result = outcome.message as Extract<HostMessage, { type: "result" }>;
			const succeeded = result.ok === true;
			// 用户主动取消不是错误：不返回 error，渲染层靠 cancelled 区分「取消」与「失败」。
			const cancelled = result.cancelled === true;
			return {
				ok: succeeded,
				cancelled,
				providerId: result.providerId ?? request.providerId,
				error: succeeded || cancelled ? undefined : (result.error?.message ?? "登录失败"),
				// 助手能区分「供应商不存在 / 该供应商不支持交互式登录」等情形，
				// 原样带上去，否则用户只能看到笼统的「登录失败」。
				errorKind: succeeded || cancelled ? undefined : mapHostErrorKind(result.error?.kind, "login-failed"),
			};
		} finally {
			this.exclusiveSession = undefined;
			session.settle({ kind: "error", errorKind: "protocol", message: "login finished" });
		}
	}

	/** 登出：清掉 pi 凭据里该供应商的登录态。 */
	async logout(providerId: string): Promise<PiAuthLogoutResult> {
		if (this.exclusiveSession) {
			return { ok: false, providerId, error: "已有登录流程正在进行" };
		}
		const opened = this.openSession();
		if (!opened.ok) return { ok: false, providerId, error: opened.error };
		const session = opened.session;
		this.exclusiveSession = session;
		try {
			session.send({ cmd: "logout", providerId });
			const outcome = await this.awaitOutcome(session, (message) => message.type === "result", "登出", this.shortTimeoutMs);
			if (outcome.kind === "error") return { ok: false, providerId, error: outcome.message };
			const result = outcome.message as Extract<HostMessage, { type: "result" }>;
			return { ok: result.ok === true, providerId: result.providerId ?? providerId, error: result.ok === true ? undefined : (result.error?.message ?? "登出失败") };
		} finally {
			this.exclusiveSession = undefined;
			session.settle({ kind: "error", errorKind: "protocol", message: "logout finished" });
		}
	}

	/** 回填用户对某个提问的回答；没有进行中的登录时返回 false。 */
	answerPrompt(promptId: string, value: string): boolean {
		const session = this.exclusiveSession;
		if (!session) return false;
		session.send({ cmd: "answer", id: promptId, value });
		return true;
	}

	/** 取消当前登录（用户关弹框）。助手会中止流程并回一个 cancelled 结果。 */
	cancel(): boolean {
		const session = this.exclusiveSession;
		if (!session) return false;
		session.send({ cmd: "cancel" });
		return true;
	}

	/** 应用退出/窗口关闭时的总清理。 */
	dispose(): void {
		this.disposed = true;
		this.flowSink = undefined;
		const session = this.exclusiveSession;
		this.exclusiveSession = undefined;
		session?.settle({ kind: "error", errorKind: "protocol", message: "认证服务已停止" });
	}

	// -----------------------------------------------------------------------
	// 内部：进程与协议
	// -----------------------------------------------------------------------

	/** 解析启动参数并拉起助手；参数解析失败直接给出可读原因。 */
	private openSession(): { ok: true; session: AuthHostSession } | { ok: false; errorKind: PiAuthErrorKind; error: string } {
		if (this.disposed) return { ok: false, errorKind: "sdk-unavailable", error: "认证服务已停止" };
		const launch = this.resolveLaunch();
		if (!launch.ok) {
			const hint = LAUNCH_FAILURE_HINT[launch.reason];
			this.logger?.warn(`认证助手启动参数解析失败：${launch.reason}${launch.detail ? `（${launch.detail}）` : ""}`);
			// 三种原因都归到 sdk-unavailable：对用户来说都是「这条通道现在起不来」，
			// 细节（WSL / 找不到入口 / 缺文件）靠 message 区分，渲染层会一起展示。
			return { ok: false, errorKind: "sdk-unavailable", error: launch.detail ? `${hint}（${launch.detail}）` : hint };
		}
		this.logger?.debug(`启动认证助手：${launch.nodeExe} ${launch.helperPath}`);
		const child = this.spawnFn(launch.nodeExe, [launch.helperPath], {
			env: launch.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		}) as ChildProcessWithoutNullStreams;
		const session = new AuthHostSession(child, this.logger);
		return { ok: true, session };
	}

	/**
	 * 等到达成 `match` 的消息；期间把 event / prompt 推给渲染层。
	 *
	 * 超时是「整个操作」的预算而不是单条消息的：登录流程中间可能有多次提问，
	 * 每次提问都重置计时会让总时长失控。
	 */
	private async awaitOutcome(session: AuthHostSession, match: (message: HostMessage) => boolean, operation: string, timeoutMs: number): Promise<HostSessionOutcome> {
		// 文案里带上实际超时长度：用户反馈「卡住了」时，日志与提示能直接说明等了多久。
		const timeoutLabel = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
		const timeoutMessage = `${operation}超时（${timeoutLabel}）`;
		let timedOut = false;
		session.addTimeout(timeoutMs, () => {
			timedOut = true;
			session.settle({ kind: "error", errorKind: "timeout", message: timeoutMessage });
		});
		for (;;) {
			const message = await session.nextMessage();
			if (!message) {
				if (timedOut) return { kind: "error", errorKind: "timeout", message: timeoutMessage };
				// 用会话记录的结算原因回给调用方：spawn 失败、助手带退出码退出等
				// 细节都带在里面，比笼统的「已退出」更可诊断。
				const settledOutcome = session.outcome;
				return settledOutcome ?? { kind: "error", errorKind: "protocol", message: "认证助手已退出，请重试" };
			}
			if (message.type === "fatal") {
				const failure = message as Extract<HostMessage, { type: "fatal" }>;
				// 只有「加载 pi SDK / 创建 runtime」才算通道不可用；其余是协议问题。
				const errorKind: PiAuthErrorKind = failure.stage === "sdk-load" || failure.stage === "startup" || failure.stage === "runtime-create" ? "sdk-unavailable" : "protocol";
				const detail = failure.message ?? "认证助手启动失败";
				session.settle({ kind: "error", errorKind, message: detail });
				return { kind: "error", errorKind, message: detail };
			}
			if (match(message)) return { kind: "result", message };
			// 非终态消息（ready/providers/event/prompt/prompt-cancelled）：
			// 与推送有关的转发给渲染层，宿主不解释流程语义。
			const update = toFlowUpdate(message);
			if (update) this.flowSink?.(update);
		}
	}
}

/**
 * 把助手的错误分类收窄到共享契约的取值域；未知分类退回兜底值，
 * 保证渲染层永远能选到一条文案（不把未识别的字符串透传到 UI）。
 */
const HOST_ERROR_KINDS = new Set<PiAuthErrorKind>(["unknown-provider", "unsupported", "login-failed", "sdk-unavailable", "spawn-failed", "busy", "timeout", "protocol"]);

function mapHostErrorKind(kind: string | undefined, fallback: PiAuthErrorKind): PiAuthErrorKind {
	return kind && HOST_ERROR_KINDS.has(kind as PiAuthErrorKind) ? (kind as PiAuthErrorKind) : fallback;
}

/** 解析助手的一行 stdout；非 JSON 或结构异常返回 undefined（对协议保持前向兼容）。 */
function parseHostMessage(line: string): HostMessage | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return typeof (parsed as { type?: unknown }).type === "string" ? (parsed as HostMessage) : undefined;
	} catch {
		return undefined;
	}
}

/** 把协议消息翻成交给渲染层的流程更新；与推送无关的消息返回 undefined。 */
function toFlowUpdate(message: HostMessage): PiAuthFlowUpdate | undefined {
	if (message.type === "event") {
		// 只透传渲染层认识的四种事件；pi 未来新增事件时静默忽略，不必同步升级宿主。
		const event = message.event as { type?: unknown } | undefined;
		if (!event || typeof event.type !== "string") return undefined;
		if (event.type !== "info" && event.type !== "auth_url" && event.type !== "device_code" && event.type !== "progress") return undefined;
		return { kind: "event", event: event as never };
	}
	if (message.type === "prompt") {
		const prompt = message.prompt;
		if (!prompt || typeof prompt.message !== "string") return undefined;
		if (prompt.kind !== "text" && prompt.kind !== "secret" && prompt.kind !== "select" && prompt.kind !== "manual_code") return undefined;
		return { kind: "prompt", prompt: { id: message.id, kind: prompt.kind, message: prompt.message, placeholder: prompt.placeholder, options: prompt.options } };
	}
	if (message.type === "prompt-cancelled") return { kind: "prompt-cancelled", promptId: message.id };
	return undefined;
}
