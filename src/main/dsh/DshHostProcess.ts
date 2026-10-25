import { join } from "node:path";
import { existsSync } from "node:fs";
import type { UtilityProcess } from "electron";
import { getAppLogger } from "../logging/sharedLogger";
import { dshManuallyStoppedError, isDshManuallyStoppedError } from "./dshManualStop";

/**
 * DSH host utilityProcess 生命周期管理（v2 形态，对应计划 §3.2 形态 b）。
 *
 * 职责：fork hostEntry、转发桥消息（fetch-request / fetch-abort）、
 * 健康信号（host-ready）、退出清理（kill + 等待 exit）。
 *
 * 桥协议见 dshHostBridge.ts；hostEntry 侧组合与主进程内嵌形态一致。
 */
/** dispose 后 start/restartAfterCrash 的拒绝文案（可辨识，不与手动停止/boot 失败混淆）。 */
const DSH_HOST_DISPOSED_ERROR = "DSH host process was disposed";

/** utilityProcess.fork 的最小依赖面（测试注入桩用，避免在单测里拉起 Electron）。 */
export type DshHostForkLike = (entryPath: string, args: string[], options: { env: Record<string, string>; stdio: "pipe"; serviceName: string }) => UtilityProcess;

/** 测试/诊断可调的启动参数默认值。 */
const DEFAULT_BOOT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

export class DshHostProcess {
	private child: UtilityProcess | null = null;
	private readonly listeners = new Set<(message: unknown) => void>();
	/** host-ready 订阅（首次启动与崩溃自动重启都会触发；E4 恢复钩子）。 */
	private readonly readyListeners = new Set<() => void>();
	private readyResolvers: Array<() => void> = [];
	private readyRejecters: Array<(error: Error) => void> = [];
	private ready = false;
	private exitPromise: Promise<void> | null = null;
	/** exitPromise 记的是哪个 child 的退出（child 被替换后旧 Promise 不再代表当前进程）。 */
	private exitChild: UtilityProcess | null = null;
	/** 最近一次 fork 出来的进程：kill() 把 child 置 null 之后，start() 的 catch 仍要能把它收掉。 */
	private lastForked: UtilityProcess | null = null;
	/** 启动失败（未 ready 退出）连续计数；host-ready 时清零。 */
	private bootFailures = 0;
	/** 运行期崩溃（ready 后退出）连续计数；显式 start(true) 时清零。
	 *  与 bootFailures 分开：运行期崩溃不再因 ready 清零而无限重启（E3）。 */
	private runtimeCrashes = 0;
	private readonly maxRestarts = 3;
	/** 主动停止中（kill/dispose）：exit 时不触发自动重启。 */
	private stopping = false;
	/** 不可逆终态：dispose 后拒绝一切 fork（含崩溃自动重启内部的 start(false)）。
	 *  崩溃退避窗口（0.5~2s）内 dispose 时，pending 的 restartAfterCrash 会在退避后
	 *  重新 fork——而 DshHost.dispose 早已返回，新进程成为无人认领的孤儿。 */
	private disposed = false;
	/** 最近一次 boot 失败的真实原因（host-error 消息详情，缺省退回 stderr 尾部）。
	 *  启动成功（host-ready）时清零；渲染层经 getStatus().bootError 拿到它，
	 *  否则用户只看到笼统的 "exited before ready (code=1)" 而不知道为何失败。 */
	private lastBootError: string | null = null;
	/** stderr 尾部环形缓冲（host 崩溃前未及发 host-error 消息时兜底取原因）。 */
	private readonly stderrTail: string[] = [];
	/** stderr 缓冲上限：超过则丢弃最早行，只保留最近几行即可定位失败原因。 */
	private static readonly STDERR_TAIL_LIMIT = 12;
	/** postMessage 在 host 已退出时只警告一次（abort 竞态可能连续触发）。 */
	private warnedDisposed = false;
	/** host 进程退出订阅（DshHost 借此中断悬挂的桥 pending）。 */
	private readonly exitListeners = new Set<() => void>();
	private readonly log: (scope: string, message: string, detail?: unknown) => void;

	constructor(
		/** hostEntry 产物路径（out/main/hostEntry.js）。 */
		private readonly entryPath: string,
		/** fork 参数（dsh-home / dsh-config / dsh-node-modules）。 */
		private readonly forkArgs: string[],
		/** fork 环境变量（DSH_HOME 等已在 entry 内设置；这里可补应用级 env）。 */
		private readonly forkEnv: Record<string, string>,
		log?: (scope: string, message: string, detail?: unknown) => void,
		/**
		 * 用户是否手动停止了 host（由 DshHost 透传 settings.dshManualStopped）。
		 * 崩溃自动重启路径（restartAfterCrash → start）不经过 DshHost.start，
		 * 必须在这里二次门控，否则「停止后崩溃重启又把 host 拉起来」。
		 */
		private readonly isManualStopped: () => boolean = () => false,
		/**
		 * 可注入的依赖面（默认走 Electron 真实实现）：
		 * - fork：utilityProcess.fork；测试用桩进程验证「boot 超时 / 早退是否留下孤儿进程」；
		 * - bootReadyTimeoutMs：等待 host-ready 的上限（E1）；测试压到毫秒级。
		 */
		private readonly deps: {
			fork?: DshHostForkLike;
			bootReadyTimeoutMs?: number;
		} = {},
	) {
		this.log = log ?? ((scope, message, detail) => getAppLogger()?.info(scope, message, detail));
	}

	/** 是否已 fork（无论是否 ready）。 */
	isRunning(): boolean {
		return this.child !== null;
	}

	/** OS pid（fork 后才有；供进程监控采样内存）。 */
	get pid(): number | undefined {
		const pid = this.child?.pid;
		return typeof pid === "number" && pid > 0 ? pid : undefined;
	}

	/** 是否已完成 boot（host-ready 已收到）。 */
	isReady(): boolean {
		return this.ready;
	}

	/** 最近一次 boot 失败的真实原因；启动成功或从未失败时返回 null。
	 *  DshHost.getStatus() 把它透出给渲染层（配置页概览错误 banner）。 */
	getLastBootError(): string | null {
		if (this.lastBootError) return this.lastBootError;
		// host 未发 host-error 就崩溃（原生崩溃/被 kill）：stderr 尾部兜底。
		return this.stderrTail.length > 0 ? this.stderrTail.join("\n") : null;
	}

	/** fork hostEntry 并等待 host-ready（幂等；已 fork 未 ready 时复用等待）。
	 *  resetCrashCounters=true 表示「用户显式触发」（首次启动/重启 host/切换 DSH_HOME），
	 *  重置连续崩溃计数；自动重启路径传 false 保持计数，保证限次语义（E3）。 */
	async start(resetCrashCounters = false): Promise<void> {
		if (this.child) {
			if (this.ready) return;
			// 复用同一进程的等待同样要有超时与收尸：否则「已 fork 未 ready」状态被
			// 并发 start 复用时，这里会永久挂起（ensureStarted/dispose 都 await 它）。
			try {
				await this.waitForReady(this.deps.bootReadyTimeoutMs ?? DEFAULT_BOOT_READY_TIMEOUT_MS);
			} catch (error) {
				await this.reapTerminatedChild(this.child);
				throw error;
			}
			return;
		}
		// 手动停止门控（崩溃自动重启路径也走这里）：用户停过之后不再 fork，
		// 调用方（restartAfterCrash）按 isDshManuallyStoppedError 判定后静默放弃。
		if (this.isManualStopped()) throw dshManuallyStoppedError();
		// 终态门控：dispose 后的对象不得再 fork（见 disposed 字段注释的孤儿竞态）。
		if (this.disposed) throw new Error(DSH_HOST_DISPOSED_ERROR);
		this.ready = false;
		if (resetCrashCounters) {
			this.bootFailures = 0;
			this.runtimeCrashes = 0;
		}
		const child = await this.forkChild();
		this.child = child;
		this.lastForked = child;
		// 带上来源 child：被 kill 淘汰的旧进程可能在途消息里还有 host-ready / host-exit，
		// 若不校验来源，迟到帧会把实例重新标记成 ready（并触发 onReady 订阅者按
		// 「启动成功」恢复状态），而此时真正在跑的已经是另一个进程。
		child.on("message", (message) => {
			if (this.child !== child) return;
			this.handleMessage(message);
		});
		// hostEntry 的 console.error / 未捕获异常都会走 stderr；转发到主进程日志，
		// 否则 host 启动失败（exit before ready）只能看到 code，看不到原因。
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").trimEnd();
			if (text) {
				this.log("dsh-host-entry", text);
				// 同时保留最近几行：host 崩溃得早、未发 host-error 消息时，
				// 由 stderr 尾部兜底作为 getLastBootError() 的原因。
				if (this.stderrTail.length >= DshHostProcess.STDERR_TAIL_LIMIT) this.stderrTail.shift();
				this.stderrTail.push(text);
			}
		});
		child.on("exit", (code) => {
			// 已被淘汰的旧进程退出：本次启动已由 start() 的 catch 结算过（含自动重启判定），
			// 再走一遍会把新一轮启动的 child/ready 状态清掉。
			if (this.child !== child) {
				this.log("dsh-host", `superseded host process exited code=${code}`);
				return;
			}
			const wasReady = this.ready;
			this.log("dsh-host", `host process exited code=${code} (${wasReady ? "was ready" : "before ready"})`);
			this.child = null;
			this.ready = false;
			// 先通知订阅者（DshHost 借此 abortAllPending 中断悬挂 mux），再处理重启。
			for (const listener of this.exitListeners) {
				try {
					listener();
				} catch {
					// 订阅者异常不影响进程生命周期处理
				}
			}
			// 未 ready 的等待者：boot 失败（exit 早于 host-ready）。
			// 错误信息带真实失败原因（host-error 详情/stderr 尾部），IPC 抛给渲染层时
			// 用户能看到「为什么起不来」，而不是只有 exit code。
			const rejecters = this.readyRejecters;
			this.readyRejecters = [];
			for (const reject of rejecters) {
				reject(new Error(formatBootExitError(code, this.getLastBootError())));
			}
			this.exitPromise = null;
			this.exitChild = null;
			// 注意：不要在这里复位 stopping——下一行的自动重启分支正要靠它区分
			// 「用户主动停止」和「崩溃」；复位会让崩溃自动重启永久失效（E3）。
			// 复位点在 restartAfterCrash 内部（重新 fork 前）。
			// 崩溃/启动失败自动重启（限次）：boot 失败与运行期崩溃分开计数（E3），
			// 各限 maxRestarts 次；重试成功前保持等待，超限才抛给调用方。
			if (!this.stopping) {
				if (wasReady) {
					if (this.runtimeCrashes < this.maxRestarts) {
						this.runtimeCrashes += 1;
						this.log("dsh-host", `host crashed after ready (code=${code}); auto-restarting (crash ${this.runtimeCrashes}/${this.maxRestarts})`);
						void this.restartAfterCrash(this.runtimeCrashes);
					} else {
						this.log("dsh-host", "host crash restart limit reached; giving up");
					}
				} else if (this.bootFailures < this.maxRestarts) {
					this.bootFailures += 1;
					this.log("dsh-host", `host exited before ready (code=${code}); auto-restarting (boot ${this.bootFailures}/${this.maxRestarts})`);
					void this.restartAfterCrash(this.bootFailures);
				} else {
					this.log("dsh-host", "host boot failure restart limit reached; giving up");
				}
			}
		});
		// ⚠️ 本方法的失败路径必须自己收尸：调用方（DshHost.start）在 reject 后会把
		// startPromise 置空并重新 start()，新的 DshHostProcess 会覆盖 hostProcess 引用。
		// 这里若直接抛错而子进程还活着，那个进程就再也没有任何路径能 kill 它——
		// 实测：host 冷启动超过等待上限时，一次请求会留下一个约 250MB 的孤儿 host
		// 及其 runner 子进程，且两代会同时抢同一个 DSH_HOME（2026-10 内存排查）。
		try {
			await this.waitForReady(this.deps.bootReadyTimeoutMs ?? DEFAULT_BOOT_READY_TIMEOUT_MS);
		} catch (error) {
			await this.reapTerminatedChild(child);
			throw error;
		}
	}

	/**
	 * 本次 start() 失败的收尸：只终止「本次 fork 出来的那个进程」。
	 *
	 * 不能直接 await this.kill()——kill() 杀的是 this.child，而 this.child 可能已经被
	 * 另一条路径换掉了：exit 回调里 `void restartAfterCrash(n)` 会同步调用 kill()
	 * （child 随即在 kill 里被置 null），新启动的 start() 与它交错执行时，等
	 * waitForReady 的 reject 传到 catch 这里，this.child 可能已经是**新的、正在
	 * 启动的**进程；此时 kill() 会把正常的重启一起杀掉。
	 */
	private async reapTerminatedChild(child: UtilityProcess): Promise<void> {
		// child 仍指向本次进程：走标准 kill（含等待退出与宽限期兜底）。
		if (this.child === child) {
			await this.kill();
			return;
		}
		// 走到这里说明 exit 回调已经清过 this.child（进程自己退出了，或 kill 已发起）：
		// 正常情况无需再动它——对一个已退出的进程补一刀，在某些平台上 PID 可能已被复用。
		// 唯一需要兜底的是「this.child 被别的路径置空、但进程其实还活着」（例如并发
		// restartAfterCrash 里的 kill 置空后新 fork 失败）。此时只能按进程号确认存活，
		// 而 Electron UtilityProcess 没有跨平台可靠的探测手段，因此记录日志交给上层
		// 决策，不盲目 kill。
		if (this.lastForked !== child) return;
		this.log("dsh-host", "start failed after child reference was detached; process may need manual cleanup");
	}

	/** 拉起 host utilityProcess（默认走 Electron；测试注入桩进程）。 */
	private async forkChild(): Promise<UtilityProcess> {
		this.log("dsh-host", `forking host entry: ${this.entryPath}`);
		if (this.deps.fork) {
			return this.deps.fork(this.entryPath, this.forkArgs, {
				env: this.forkEnv,
				stdio: "pipe",
				serviceName: "pideck-dsh-host",
			});
		}
		const { utilityProcess } = await import("electron");
		return utilityProcess.fork(this.entryPath, this.forkArgs, {
			env: this.forkEnv,
			// 显式 pipe stdio：否则 Windows 上 stderr 可能不可读，boot 失败只能看到 exit code。
			stdio: "pipe",
			serviceName: "pideck-dsh-host",
		});
	}

	private waitForReady(timeoutMs = DEFAULT_BOOT_READY_TIMEOUT_MS): Promise<void> {
		if (this.ready) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			// E1：健康信号等待必须有超时——boot 卡死（进程存活但不发 host-ready）时
			// 不能永久挂起（ensureStarted/dispose 都 await 它，连退出都被拖住）。
			const timer = setTimeout(() => {
				const rIndex = this.readyResolvers.indexOf(resolveWrapper);
				if (rIndex >= 0) this.readyResolvers.splice(rIndex, 1);
				const jIndex = this.readyRejecters.indexOf(rejectWrapper);
				if (jIndex >= 0) this.readyRejecters.splice(jIndex, 1);
				reject(new Error(`DSH host did not become ready within ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref();
			const resolveWrapper = () => {
				clearTimeout(timer);
				resolve();
			};
			const rejectWrapper = (error: Error) => {
				clearTimeout(timer);
				reject(error);
			};
			this.readyResolvers.push(resolveWrapper);
			this.readyRejecters.push(rejectWrapper);
		});
	}

	private handleMessage(message: unknown): void {
		const parsed = message as { type?: string } | undefined;
		if (parsed?.type === "host-ready") {
			if (!this.ready) {
				this.ready = true;
				// boot 成功：清除上次失败原因，避免旧错误残留误导诊断。
				this.lastBootError = null;
				this.stderrTail.length = 0;
				this.bootFailures = 0;
				const resolvers = this.readyResolvers;
				this.readyResolvers = [];
				for (const resolve of resolvers) resolve();
				// 首次启动与崩溃自动重启都会触发：订阅者（DshAgentManager）据此
				// 恢复崩溃前的运行时状态（E4）。
				for (const listener of this.readyListeners) {
					try {
						listener();
					} catch {
						// 订阅者异常不影响 host-ready 处理
					}
				}
			}
			return;
		}
		if (parsed?.type === "host-error") {
			// hostEntry boot 失败：错误已通过 MessagePort 回传（stderr 不可靠），记入主进程日志
			// 并缓存为 lastBootError，供 getStatus().bootError 展示真实失败原因。
			const detail = (message as { message?: unknown }).message;
			const text = typeof detail === "string" ? detail : JSON.stringify(detail);
			this.lastBootError = text;
			this.log("dsh-host-entry", `fatal: ${text}`);
			return;
		}
		if (parsed?.type === "host-exit") {
			// host 主动请求退出（provideCmdline 的 exit 回调触发，如配置文档被外部修改后的
			// 优雅退出）：记录原因，进程随后自行退出；该消息不是桥业务帧，不转发给监听者
			// （parseDshFetchMessage 不识别，透传只会被当未知消息丢弃）。
			const code = (message as { code?: unknown }).code;
			this.log("dsh-host", `host requested exit code=${typeof code === "number" ? code : "unknown"}`);
			return;
		}
		// 其余消息（fetch-response/chunk/end/error）透传给桥监听者。
		for (const listener of this.listeners) listener(message);
	}

	/** 订阅 host → main 的全部桥消息（含 host-ready 之外的业务帧）。 */
	onMessage(listener: (message: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** 订阅 host-ready（首次启动与崩溃自动重启都会触发；E4 恢复钩子）。 */
	onReady(listener: () => void): () => void {
		this.readyListeners.add(listener);
		return () => {
			this.readyListeners.delete(listener);
		};
	}

	/** 向 host 发消息（fetch-request / fetch-abort）。未运行时不抛异常：
	 * 调用方多为 abort 回调/流取消等异步路径，抛错会变成未捕获异常（日志里
	 * 的 "DSH host process is not running" 崩溃即由此而来）；静默丢弃即可。 */
	postMessage(message: unknown): void {
		if (!this.child) {
			if (!this.warnedDisposed) {
				this.warnedDisposed = true;
				this.log("dsh-host", "postMessage ignored: host process is not running");
			}
			return;
		}
		this.child.postMessage(message);
	}

	/** 订阅 host 进程退出（运行中崩溃/主动 kill 都会触发；重启后需重新订阅）。 */
	onExit(listener: () => void): () => void {
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	/** 崩溃重启（限次 + 退避）：kill 后按 attempt 指数退避再重新 fork。返回是否已重启。 */
	async restartAfterCrash(attempt: number): Promise<boolean> {
		await this.kill();
		// kill() 会置 stopping=true（防 exit 触发自动重启）；这里是「重启」而非「退出」，
		// 必须在重新 fork 前复位，否则新进程 boot 失败时自动重启只生效一次。
		this.stopping = false;
		// E3：重启退避（500ms 起指数翻倍，封顶 2s），避免崩溃循环时忙等 fork。
		if (attempt > 1) {
			await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** (attempt - 2), 2000)));
		}
		try {
			// 自动重启不重置崩溃计数：连续失败仍受 maxRestarts 约束。
			await this.start(false);
			this.log("dsh-host", `host restarted after crash (attempt ${attempt})`);
			return true;
		} catch (error) {
			// 手动停止态下的 fork 被拒绝（start() 抛出 dshManuallyStoppedError）不算「崩溃重启失败」：
			// 用 info 记一行即可，warn 会在日志里堆成假故障信号。
			if (isDshManuallyStoppedError(error)) {
				this.log("dsh-host", "host auto-restart skipped: manually stopped by user");
			} else if (error instanceof Error && error.message === DSH_HOST_DISPOSED_ERROR) {
				// dispose 后的 pending 重启被拒同理：正常时序而非故障，只记 info。
				this.log("dsh-host", "host auto-restart skipped: process disposed");
			} else {
				this.log("dsh-host", `host restart failed: ${String(error)}`);
			}
			return false;
		}
	}

	/** 停止 host：kill 进程并等待退出（退出清理清单调用）。
	 *
	 * 必须幂等且可并发：boot 超时收尸（start 的 catch）、用户手动停止、退出清理
	 * 三条路径可能同时进来。exitPromise 按「被 kill 的那个 child」记账——旧实现复用
	 * 已 resolve 的 Promise，后到的调用会在进程还活着时立刻返回。 */
	async kill(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.stopping = true;
		// 未 ready 的等待者也要失败（kill 中断 boot）。被 kill 淘汰的等待者即使超时
		// 也不能再进 rejecters：start 的 catch 还要再调一次 kill，重复 reject 无意义。
		const rejecters = this.readyRejecters;
		this.readyRejecters = [];
		this.readyResolvers = [];
		for (const reject of rejecters) reject(new Error("DSH host process was killed"));
		const pending = this.exitPromise;
		if (pending && this.exitChild === child) {
			await pending;
			return;
		}
		let settle: () => void = () => {};
		const exitPromise = new Promise<void>((resolve) => {
			settle = resolve;
		});
		this.exitPromise = exitPromise;
		this.exitChild = child;
		child.once("exit", () => settle());
		child.kill();
		// 兜底：kill 后宽限期未退出强制终止（Windows 上偶发）。必须无条件 settle——
		// 旧实现只在 this.child === child 时才 settle，遇到 child 已被换掉就永久悬挂
		// （容错路径里 await this.kill() 会把 boot 失败变成永不返回）。
		setTimeout(() => {
			if (!this.child || this.child === child) {
				this.log("dsh-host", "host did not exit within grace period after kill; forcing terminate");
				child.kill();
			}
			settle();
		}, DEFAULT_KILL_GRACE_MS).unref();
		await exitPromise;
	}

	/** 释放（退出清理）：kill + 清监听；不可逆——之后拒绝一切 fork（终态门控）。 */
	async dispose(): Promise<void> {
		this.disposed = true;
		this.listeners.clear();
		await this.kill();
	}
}

/**
 * hostEntry 产物路径。
 * - 未打包（dev / electron-vite dev 以 `electron .` 启动）：appPath = 项目根，
 *   out/main/hostEntry.js。
 * - 打包：app.asar/out/main/hostEntry.js；electron-builder 已把 hostEntry.js 加入
 *   asarUnpack，Electron 的 asar fs patch 会把 app.asar 内路径自动映射到
 *   app.asar.unpacked（utilityProcess 加载真实文件，避免 asar 虚拟目录问题）。
 * - 直接以主进程产物启动（e2e `electron out/main/index.js` / electron-vite preview）：
 *   appPath 已是 out/main，标准拼接会翻倍成 out/main/out/main/hostEntry.js；
 *   探测到标准路径不存在时退到 appPath 同目录（产物与入口同目录）。
 */
export function resolveHostEntryPath(appPath: string): string {
	const standard = join(appPath, "out", "main", "hostEntry.js");
	if (existsSync(standard)) return standard;
	return join(appPath, "hostEntry.js");
}

/**
 * 格式化 host boot 失败错误（纯函数，可单测）：exit 早于 host-ready 时，
 * 把真实失败原因（host-error 详情/stderr 尾部）拼进错误信息，
 * 让渲染层/IPC 错误不再是只有 exit code 的笼统消息。
 */
export function formatBootExitError(code: number | null, detail: string | null): string {
	const base = `DSH host process exited before ready (code=${code})`;
	return detail ? `${base}: ${detail}` : base;
}
