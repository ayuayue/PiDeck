/**
 * Go sidecar 宿主侧共享客户端（NDJSON stdio）。
 *
 * 四个 sidecar（session-index / file-index / session-store / xue-index）此前各自
 * 复制了一份协议纪律：boot 超时、ready 握手与协议版本校验、请求 id 配对、迟到
 * 响应丢弃、stdout 行缓冲上界、进程身份核对、失败一律 `{ ok: false }` 结算。
 * 本类只收敛「传输 + 生命周期」，业务命令、ready 日志文案、超时上限仍由各服务
 * 注入，避免把四个 sidecar 的语义差异藏进一个大类。
 *
 * 失败语义（调用方依赖降级）：任何失败以 `{ ok: false, reason }` 返回、绝不抛异常。
 * 子进程输出一律不可信：非法行只忽略，协议版本不符/行缓冲溢出直接回收进程。
 *
 * 生命周期纪律（清理路径唯一归属地）：
 * - 进程复用键（roots/dbPath/常量）变化 → 结算在途请求并重启；
 * - boot 超时 / 进程退出 / stdin 管道错误 → 结算 pending 并标记 dead，下次调用重试；
 * - dispose → 结算 + 杀进程（幂等）；
 * - 所有子进程事件回调核对进程身份（this.child === child），旧进程迟到事件只吸收；
 * - 就绪态用同步三元态 childState 暴露（isReady*），交互路径据此降级而不是等 boot。
 *
 * 本模块不 import electron，也不做路径解析：二进制定位与 spawn 参数由服务注入，
 * tests 可用 PassThrough 假子进程直接驱动。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** 四个服务共用的失败原因；新增原因必须同步各服务的公开结果类型。 */
export type GoSidecarFailureReason = "binary-missing" | "boot-failed" | "timeout" | "protocol" | "request-failed" | "not-ready";

export type GoSidecarCallResult<T> = { ok: true; value: T } | { ok: false; reason: GoSidecarFailureReason; message: string };

export type GoSidecarLogger = {
	debug: (message: string) => void;
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
};

/** `node:child_process.spawn` 的函数类型；单测用它注入假子进程。 */
export type GoSidecarSpawnFn = typeof spawn;

export type GoSidecarReadyFrame = {
	type: "ready";
	protocolVersion?: number;
	/** 各 sidecar 的 ready 附加字段（日志/诊断用），不参与生命周期判断。 */
	[key: string]: unknown;
};

export type GoSidecarResponseFrame = {
	type: "response";
	id?: number;
	ok?: boolean;
	result?: unknown;
	error?: string;
};

type HostRecord = GoSidecarReadyFrame | GoSidecarResponseFrame | { type: string };

/**
 * 各服务的文案差异集中在这里，基类不猜业务措辞。
 * `keyChanged` 只在进程复用键变化时使用；session-store 键恒定，实际不会触发。
 */
export type GoSidecarMessages = {
	binaryMissing: string;
	spawnFailed: string;
	bootFailed: string;
	processError: string;
	processExited: (code: number | null) => string;
	requestTimeout: string;
	requestFailed: (error: string | undefined) => string;
	childUnavailable: string;
	writeFailed: string;
	pipeClosed: string;
	protocolMismatch: string;
	responseOverflow: string;
	disposed: string;
	keyChanged: string;
};

export type GoSidecarClientOptions = {
	/** 日志前缀与 kill 原因里的服务名（"file-index" 等）。 */
	name: string;
	resolveBinaryPath: () => string | null;
	spawnFn?: GoSidecarSpawnFn;
	timeouts?: { boot?: number; request?: number };
	logger?: GoSidecarLogger;
	protocolVersion: number;
	/** stdout 单行上限（字节）：防异常帧撑爆内存，按各服务响应规模设置；UTF-8 下按字节比按字符更保守。 */
	maxLineChars: number;
	messages: GoSidecarMessages;
	/** ready 帧通过协议校验后回调：各服务只在这里记日志/保存诊断字段。 */
	onReady?: (frame: GoSidecarReadyFrame) => void;
	/** 是否把 stderr 每行打到 debug（原 file-index / session-store 行为）。 */
	logStderr?: boolean;
	/** 写 stdin 失败的日志级别（原 file-index / session-store 用 error）。 */
	writeFailureLogLevel?: "warn" | "error";
};

type PendingRequest = {
	id: number;
	resolve: (value: GoSidecarCallResult<unknown>) => void;
	timer: NodeJS.Timeout;
};

function parseRecord(line: string): HostRecord | undefined {
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

function isReadyFrame(record: HostRecord): record is GoSidecarReadyFrame {
	return record.type === "ready";
}

function isResponseFrame(record: HostRecord): record is GoSidecarResponseFrame {
	return record.type === "response";
}

export class GoSidecarClient {
	protected readonly name: string;
	protected readonly logger?: GoSidecarLogger;
	protected disposed = false;

	private readonly resolveBinaryPath: () => string | null;
	private readonly spawnFn: GoSidecarSpawnFn;
	private readonly bootTimeoutMs: number;
	private readonly requestTimeoutMs: number;
	private readonly protocolVersion: number;
	private readonly maxLineChars: number;
	private readonly messages: GoSidecarMessages;
	private readonly onReady?: (frame: GoSidecarReadyFrame) => void;
	private readonly logStderr: boolean;
	private readonly writeFailureLogLevel: "warn" | "error";

	private child: ChildProcessWithoutNullStreams | null = null;
	private childReady: Promise<"ready" | "dead"> | null = null;
	/** booting/ready/dead 三元态：isReady 必须同步判断，不能 await childReady。 */
	private childState: "booting" | "ready" | "dead" | null = null;
	/** 当前进程的复用键（roots/dbPath/常量）；变化即重启，防止索引口径漂移。 */
	private childKey: string | null = null;
	private notifyReady: () => void = () => {};
	private notifyDead: () => void = () => {};
	/** 行泵分段缓冲（Buffer 版，见 consumeStdout 头注释）：已收未成行的字节段。 */
	private lineChunks: Buffer[] = [];
	/** 分段总字节数（溢出判定；按字节计，UTF-8 下比按字符更保守）。 */
	private lineTotalBytes = 0;
	/** 头块已扫过无 LF 的字节数：避免每个 chunk 重扫整块前缀。 */
	private headSearchedBytes = 0;
	private stderrTail: string[] = [];
	private pending = new Map<number, PendingRequest>();
	private nextId = 1;
	/** 最近一次通过协议校验的 ready 帧，拆进程时清空（诊断字段的唯一来源）。 */
	private lastReadyFrame: GoSidecarReadyFrame | null = null;

	constructor(options: GoSidecarClientOptions) {
		this.name = options.name;
		this.resolveBinaryPath = options.resolveBinaryPath;
		this.spawnFn = options.spawnFn ?? spawn;
		this.bootTimeoutMs = options.timeouts?.boot ?? 20_000;
		this.requestTimeoutMs = options.timeouts?.request ?? 15_000;
		this.logger = options.logger;
		this.protocolVersion = options.protocolVersion;
		this.maxLineChars = options.maxLineChars;
		this.messages = options.messages;
		this.onReady = options.onReady;
		this.logStderr = options.logStderr ?? false;
		this.writeFailureLogLevel = options.writeFailureLogLevel ?? "warn";
	}

	/** 退出清理：结算所有在途请求并杀进程（幂等）。 */
	dispose(): void {
		this.disposed = true;
		this.settleAll("protocol", this.messages.disposed);
		this.killChild("dispose");
	}

	/** 同步就绪探测（不区分复用键）；session-store 这类单进程服务直接用。 */
	protected isReadyAny(): boolean {
		return !this.disposed && this.child !== null && this.childState === "ready";
	}

	/** 同步就绪探测：进程已握手且复用键一致。 */
	protected isReadyForKey(key: string): boolean {
		return this.isReadyAny() && this.childKey === key;
	}

	/** 进程正在 boot 或已就绪且复用键一致（warmup 防重入用）。 */
	protected isActiveForKey(key: string): boolean {
		return !this.disposed && this.child !== null && this.childKey === key && (this.childState === "booting" || this.childState === "ready");
	}

	/** 最近一次 ready 帧（含各 sidecar 的附加字段）；拆进程后为 null。 */
	protected getReadyFrame(): GoSidecarReadyFrame | null {
		return this.lastReadyFrame;
	}

	/**
	 * 保证子进程存在且已就绪；复用键变化时先结算旧进程上的在途请求再重启。
	 * 返回值是统一的 fail-open 结果，调用方只做 `if (!ready.ok) return ready`。
	 */
	protected async ensureReady(key: string, args: readonly string[]): Promise<GoSidecarCallResult<true>> {
		if (this.disposed) return this.fail("boot-failed", this.messages.disposed);
		if (this.child && this.childKey === key && this.childReady) {
			const state = await this.childReady;
			return state === "ready" ? { ok: true, value: true } : this.fail("boot-failed", this.messages.bootFailed);
		}
		if (this.child) {
			// 复用键变化：旧进程的索引口径/库文件已不适用，在途请求一并结算。
			this.settleAll("protocol", this.messages.keyChanged);
			this.killChild("key-swap");
		}

		const binaryPath = this.resolveBinaryPath();
		if (!binaryPath) return this.fail("binary-missing", this.messages.binaryMissing);

		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.spawnFn(binaryPath, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as ChildProcessWithoutNullStreams;
		} catch {
			return this.fail("binary-missing", this.messages.spawnFailed);
		}

		this.child = child;
		this.childKey = key;
		this.childState = "booting";
		this.stderrTail = [];
		this.pending.clear();
		this.resetLineBuffer();
		this.attachChild(child);

		const bootStartedAt = Date.now();
		const ready = new Promise<"ready" | "dead">((resolveReady) => {
			// ready 与超时同拍到达时只认先到的终局（setImmediate 让已写出的 ready 先走完管道）。
			let settled = false;
			const bootTimer = setTimeout(() => {
				setImmediate(() => {
					if (settled) return;
					settled = true;
					this.logger?.warn(`${this.name} boot 超时（${Date.now() - bootStartedAt}ms）`);
					resolveReady("dead");
					this.killChild("boot-timeout");
				});
			}, this.bootTimeoutMs);
			this.notifyReady = () => {
				if (settled) return;
				settled = true;
				clearTimeout(bootTimer);
				this.childState = "ready";
				resolveReady("ready");
			};
			this.notifyDead = () => {
				if (settled) return;
				settled = true;
				clearTimeout(bootTimer);
				this.childState = "dead";
				resolveReady("dead");
			};
		});
		this.childReady = ready;

		const state = await ready;
		return state === "ready" ? { ok: true, value: true } : this.fail("boot-failed", this.messages.bootFailed);
	}

	/**
	 * 发送请求并按 id 等待响应；超时/进程死亡都会结算，绝不悬挂。
	 * `frame` 只约束 cmd，其余字段原样透传给各 sidecar（JSON 序列化保留全部属性）。
	 */
	protected request<T>(frame: { cmd: string } & Record<string, unknown>): Promise<GoSidecarCallResult<T>> {
		const child = this.child;
		if (!child) return Promise.resolve(this.fail("boot-failed", this.messages.childUnavailable));
		const id = this.nextId++;
		return new Promise<GoSidecarCallResult<T>>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.logger?.warn(`${this.name} 请求超时：cmd=${frame.cmd} id=${id}`);
				resolve(this.fail("timeout", this.messages.requestTimeout));
			}, this.requestTimeoutMs);
			this.pending.set(id, {
				id,
				timer,
				// 响应来自子进程 JSON：这里只做类型边界转换，字段级校验由各消费者负责。
				resolve: (value) => resolve(value as GoSidecarCallResult<T>),
			});
			try {
				child.stdin.write(`${JSON.stringify({ ...frame, id })}\n`);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				const message = error instanceof Error ? error.message : String(error);
				this.logger?.[this.writeFailureLogLevel](`${this.name} 写入失败：${message}`);
				resolve(this.fail("protocol", this.messages.writeFailed));
			}
		});
	}

	// ------------------------------------------------------------------
	// 子进程生命周期
	// ------------------------------------------------------------------

	private attachChild(child: ChildProcessWithoutNullStreams): void {
		child.stdin.on("error", (error: Error) => this.handleStdinError(child, error));
		child.stdout.on("data", (chunk: Buffer) => {
			if (this.child === child) this.consumeStdout(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (this.child === child) this.consumeStderr(chunk);
		});
		child.on("error", (error: Error) => {
			if (this.child !== child) return;
			this.logger?.error(`${this.name} 进程错误：${error.message}`);
			this.markChildDead("boot-failed", this.messages.processError);
		});
		child.on("close", (code: number | null) => {
			if (this.child !== child) return;
			const tail = this.stderrTail.at(-1);
			const message = this.messages.processExited(code);
			this.logger?.warn(`${message}${tail ? `：${tail}` : ""}`);
			this.markChildDead("boot-failed", message);
		});
	}

	/** 拆掉当前子进程并置 dead（不杀进程，由调用方决定）。 */
	private teardownChild(): ChildProcessWithoutNullStreams | null {
		const child = this.child;
		this.child = null;
		this.childReady = null;
		this.childKey = null;
		this.childState = "dead";
		this.lastReadyFrame = null;
		this.resetLineBuffer();
		this.notifyDead();
		return child;
	}

	/** 杀掉当前子进程：结算由调用方负责（boot 超时时 pending 尚未建立）。 */
	private killChild(reason: string): void {
		const child = this.teardownChild();
		if (!child) return;
		this.logger?.debug(`停止 ${this.name}（${reason}）`);
		try {
			child.kill();
		} catch {
			// 进程可能已退出：kill 失败不影响状态机（这里只需尽量回收）。
		}
	}

	private handleStdinError(child: ChildProcessWithoutNullStreams, error: Error): void {
		if (this.child !== child) return;
		this.logger?.error(`${this.name} stdin 错误：${error.message}`);
		this.killChild("stdin-error");
		this.settleAll("protocol", this.messages.pipeClosed);
	}

	/** 进程死亡：拆连接 + 结算在途请求（迟到事件由身份核对拦掉）。 */
	private markChildDead(reason: GoSidecarFailureReason, message: string): void {
		this.teardownChild();
		this.settleAll(reason, message);
	}

	// ------------------------------------------------------------------
	// 消息泵
	// ------------------------------------------------------------------

	/**
	 * 行泵（Buffer 分段版，2027-02 性能审计）。
	 *
	 * 原实现 `buffer += chunk` 后立即 `indexOf("\n")`：V8 对 cons-string 的 indexOf
	 * 要先整段扁平化，每个 data 事件都对已累积全长做一次拷贝+分配——单行响应成本
	 * O(B²/chunkSize)。session-store 的 get-index 单行可达 ~25MB（条目表口径），
	 * 按 64KB chunk 就是约 400 次全长扁平化，累计 GB 级 memcpy 全压在主进程。
	 *
	 * 分段后：LF（0x0A）按字节找，绝不出现在 UTF-8 多字节序列内部，跨 chunk 的
	 * 多字节字符只随完整行一次性 toString，不丢字节。已扫过无 LF 的前缀不重扫
	 *（headSearched 只对头块生效，其余块要么整块消费、要么是刚到的尾块）。
	 */
	private consumeStdout(chunk: Buffer): void {
		this.lineChunks.push(chunk);
		this.lineTotalBytes += chunk.length;
		if (this.lineTotalBytes > this.maxLineChars) {
			const dropped = this.lineTotalBytes;
			this.resetLineBuffer();
			this.logger?.error(`${this.name} stdout 行缓冲溢出：丢弃 ${dropped} 字节`);
			this.killChild("protocol");
			this.settleAll("protocol", this.messages.responseOverflow);
			return;
		}
		for (;;) {
			// LF 只可能出现在头块（从已扫位置起）或刚追加的尾块：中间块在各自到达的
			// 那一轮已整块扫过且无 LF（见方法头注释的不变式）。
			const head = this.lineChunks[0];
			const headLf = head ? head.indexOf(0x0a, this.headSearchedBytes) : -1;
			if (headLf !== -1) {
				const line = head.subarray(0, headLf);
				const rest = head.subarray(headLf + 1);
				this.lineTotalBytes -= headLf + 1;
				if (rest.length > 0) {
					this.lineChunks[0] = rest;
					this.headSearchedBytes = 0;
				} else {
					this.lineChunks.shift();
					this.headSearchedBytes = 0;
				}
				this.dispatchLine(line);
				continue;
			}
			if (this.lineChunks.length > 1) {
				const lastIdx = this.lineChunks.length - 1;
				const last = this.lineChunks[lastIdx];
				const lastLf = last.indexOf(0x0a);
				if (lastLf !== -1) {
					// 行跨多块：中间块按不变式整块 LF-free，直接 concat（每行一次拷贝，摊还 O(1)）
					const parts = this.lineChunks.slice();
					parts[lastIdx] = last.subarray(0, lastLf);
					const line = parts.length === 1 ? parts[0] : Buffer.concat(parts);
					this.lineTotalBytes -= line.length + 1;
					const rest = last.subarray(lastLf + 1);
					if (rest.length > 0) this.lineChunks = [rest];
					else this.lineChunks = [];
					this.headSearchedBytes = 0;
					this.dispatchLine(line);
					continue;
				}
			}
			// 本轮无完整行：头块记录已扫边界，等下一 chunk
			this.headSearchedBytes = head ? head.length : 0;
			break;
		}
	}

	/** 完整行 → 解析分发；空行跳过（与旧实现一致）。 */
	private dispatchLine(line: Buffer): void {
		const text = line.toString("utf8");
		if (!text.trim()) return;
		this.handleRecord(parseRecord(text), text);
	}

	/** 清空行缓冲分段（溢出/进程重建路径共用）。 */
	private resetLineBuffer(): void {
		this.lineChunks = [];
		this.lineTotalBytes = 0;
		this.headSearchedBytes = 0;
	}

	private consumeStderr(chunk: Buffer): void {
		const text = chunk.toString("utf8").trim();
		if (!text) return;
		for (const entry of text.split("\n")) {
			const line = entry.trim();
			if (!line) continue;
			this.stderrTail.push(line);
			if (this.logStderr) this.logger?.debug(`${this.name}: ${line}`);
		}
		// 只保留尾部若干行：进程崩溃时要能报出 Go 侧最后一句原因，又不无限增长。
		if (this.stderrTail.length > 10) this.stderrTail = this.stderrTail.slice(-10);
	}

	private handleRecord(record: HostRecord | undefined, rawLine: string): void {
		if (!record) {
			this.logger?.warn(`${this.name} stdout 非法行（已忽略）：${JSON.stringify(rawLine.slice(0, 200))}`);
			return;
		}
		if (isReadyFrame(record)) {
			if (record.protocolVersion !== this.protocolVersion) {
				this.logger?.error(`${this.name} 协议版本不匹配：sidecar=${String(record.protocolVersion)} 宿主=${this.protocolVersion}`);
				this.killChild("protocol-version");
				this.settleAll("protocol", this.messages.protocolMismatch);
				return;
			}
			this.lastReadyFrame = record;
			this.onReady?.(record);
			this.notifyReady();
			return;
		}
		if (!isResponseFrame(record)) return;
		const pending = this.pending.get(record.id ?? -1);
		if (!pending) return; // 迟到响应（超时已结算）直接丢弃
		this.pending.delete(record.id ?? -1);
		clearTimeout(pending.timer);
		if (record.ok) {
			pending.resolve({ ok: true, value: record.result ?? null });
		} else {
			this.logger?.warn(`${this.name} 请求失败：${record.error ?? "unknown"}`);
			pending.resolve(this.fail("request-failed", this.messages.requestFailed(record.error)));
		}
	}

	private settleAll(reason: GoSidecarFailureReason, message: string): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.resolve(this.fail(reason, message));
		}
		this.pending.clear();
	}

	private fail<T>(reason: GoSidecarFailureReason, message: string): GoSidecarCallResult<T> {
		return { ok: false, reason, message };
	}
}
