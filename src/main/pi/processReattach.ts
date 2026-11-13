import { isLocalProject, isRemoteProject } from "../../shared/projectLocation";
import type { AgentTab, ChatMessage, I18nParams, Project, SessionEnvironment } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";
import { describeExtensionFallbackSkip } from "./extensionStartupFallback";
import type { PiProcess } from "./PiProcess";
import type { PiRuntimeLauncher, RemoteSshPiRuntimeLaunchPlan } from "./PiSpawnHandle";
import type { RpcResponse } from "./PiRpcClient";
import { REMOTE_RUNTIME_CODES, type RemoteRuntimePort } from "./remoteRuntimePort";
import type { StandbyAgentPool } from "./StandbyAgentPool";
import type { StartupDiagnosticsQueue } from "./startupDiagnosticsQueue";

/** 进程重挂接域只读到的运行时切片（宿主 agents map 的值类型 `AgentRuntime`）。 */
type ReattachRuntime = { tab: AgentTab; process: PiProcess };

/** 进程退出载荷（PiProcess `exit` 事件形状）。 */
type ProcessExitPayload = { code: number | null; signal: string | null };

/** 握手产物：本域只消费会话状态与扩展回退标记，RPC client 仍归宿主使用。 */
type ReattachHandshake = {
	process: PiProcess;
	state: RpcResponse;
	fallbackFromExtensions: boolean;
	fallbackDebug?: string;
};

/**
 * 进程重挂接域的窄接口：只列实现真正用到的读取器与回调，不新增状态。
 *
 * 跨域集合（startupHandshakeAgents / userInitiatedStop / autoRestartAttempted / compactingAgents /
 * rpcCompactingAgents / lastAbortAtByAgent / standbyPool）由宿主持有并按引用传入——stop / abort /
 * 压缩 / 握手都直接读写它们，搬进协作者只会把同样的状态藏一层。
 * `reattachProcess` 在宿主保留同名薄包装，因为压缩域经它观察重连（测试按实例属性替换）。
 */
export interface ProcessReattachHost {
	readonly agents: Map<string, ReattachRuntime>;
	getProject(id: string): Project | undefined;
	readonly appLogger?: AppLogger;
	/** 远端重连要用当前会话文件重新 prepare 计划；缺省 = 本机产品（远端以稳定码 fail-closed）。 */
	readonly remoteRuntime?: RemoteRuntimePort;
	readonly remoteLaunchByAgent: Map<string, { plan: RemoteSshPiRuntimeLaunchPlan; launcher: PiRuntimeLauncher }>;
	handshakePiProcess(agentId: string, options: { projectPath: string; sessionPath?: string; deckSessionId?: string; onExit: (payload: ProcessExitPayload) => void }): Promise<ReattachHandshake>;
	reportSessionPathFromPi(reported: string | undefined, projectId: string, environment: SessionEnvironment, fallbackBase: string): string | undefined;
	readonly rpcCompactingAgents: Set<string>;
	readonly autoRestartAttempted: Set<string>;
	readonly abortedDuringAsk: Set<string>;
	readonly startupHandshakeAgents: Set<string>;
	readonly userInitiatedStop: Set<string>;
	readonly compactingAgents: Set<string>;
	readonly lastAbortAtByAgent: Map<string, number>;
	readonly standbyPool: StandbyAgentPool;
	readonly startupDiagnostics: StartupDiagnosticsQueue;
	readonly settingsStore: SettingsStore;
	/** 启动握手超时可随 rpcTimeout 变：取实时值，不是构造时快照。 */
	startupHandshakeTimeoutMs(): number;
	loadMessages(agentId: string, skipEntries?: boolean, earlyMessagesPromise?: Promise<RpcResponse>, options?: { preserveMessagesAfter?: number }): Promise<unknown>;
	addMessage(agentId: string, role: ChatMessage["role"], text: string, meta?: Record<string, unknown>): void;
	addLocalizedMessage(agentId: string, role: ChatMessage["role"], i18nKey: string, fallbackText: string, options?: { params?: I18nParams; debugDetails?: string; meta?: Record<string, unknown> }): void;
	clearAgentState(agentId: string): void;
	emitState(): void;
}

/** 终止窗口判定时长：覆盖 abort RPC ack（pi 等 idle 才响应）+ settled + 收尾清理。 */
const ABORT_EXIT_REATTACH_WINDOW_MS = 15_000;

/** 进程退出后自动重挂接域（拆分第九刀）：重连 + 两条 exit 处理 + 启动失败诊断文案。 */
export class ProcessReattach {
	constructor(private readonly host: ProcessReattachHost) {}

	/** 宿主字段别名：搬出的实现保持 `this.<字段>` 原样（契约测试按此形态断言）。 */
	private get agents() {
		return this.host.agents;
	}

	private get getProject() {
		return this.host.getProject;
	}

	private get appLogger() {
		return this.host.appLogger;
	}

	private get remoteRuntime() {
		return this.host.remoteRuntime;
	}

	private get remoteLaunchByAgent() {
		return this.host.remoteLaunchByAgent;
	}

	private get handshakePiProcess() {
		return this.host.handshakePiProcess;
	}

	private get reportSessionPathFromPi() {
		return this.host.reportSessionPathFromPi;
	}

	private get rpcCompactingAgents() {
		return this.host.rpcCompactingAgents;
	}

	private get autoRestartAttempted() {
		return this.host.autoRestartAttempted;
	}

	private get abortedDuringAsk() {
		return this.host.abortedDuringAsk;
	}

	private get loadMessages() {
		return this.host.loadMessages;
	}

	private get startupDiagnostics() {
		return this.host.startupDiagnostics;
	}

	private get startupHandshakeAgents() {
		return this.host.startupHandshakeAgents;
	}

	private get standbyPool() {
		return this.host.standbyPool;
	}

	private get userInitiatedStop() {
		return this.host.userInitiatedStop;
	}

	private get compactingAgents() {
		return this.host.compactingAgents;
	}

	private get lastAbortAtByAgent() {
		return this.host.lastAbortAtByAgent;
	}

	private get settingsStore() {
		return this.host.settingsStore;
	}

	private get startupHandshakeTimeoutMs() {
		return this.host.startupHandshakeTimeoutMs();
	}

	private get addMessage() {
		return this.host.addMessage;
	}

	private get addLocalizedMessage() {
		return this.host.addLocalizedMessage;
	}

	private get clearAgentState() {
		return this.host.clearAgentState;
	}

	private get emitState() {
		return this.host.emitState;
	}

	/**
	 * 进程退出后重新附加到同一会话：创建新的 PiProcess 并替换旧的进程引用。
	 * 在压缩导致 pi 进程自动重启后调用，保持同一 agentId 可继续对话。
	 *
	 * 与 create() 中创建过程的区别：不重新分配 agentId、不解绑项目，
	 * 只替换底层的 pi 进程和 RPC 客户端，保留所有消息和 tab 状态。
	 */
	async reattachProcess(agentId: string, sessionPath: string): Promise<void> {
		const runtime = this.agents.get(agentId);
		if (!runtime) throw new Error("Agent not found: " + agentId);

		const project = this.getProject(runtime.tab.projectId);
		if (!project) throw new Error("Project not found");
		// 远端会话同样支持自动重连：launch 计划在 create 时就登记进了 `remoteLaunchByAgent`，握手直接复用它
		// （远端没有计划时 `handshakePiProcess` 会抛 `REMOTE_RUNTIME_UNAVAILABLE`——绝不会掉进本机 pi）。
		// 与本地只差两处语义，见下方 `isRemote` 分叉：路径不归一化、历史不加载。
		const isRemote = !isLocalProject(project);
		// 远端重连必须**用当前会话文件重新 prepare 计划**：create 时那份计划没有 `--session`（那时 pi 还没
		// 报出会话文件），直接拿 map 里的旧计划重拉会开出**新会话**而不是接回原会话。`restart` 同样走这条。
		if (isRemote) {
			const hostId = isRemoteProject(project) ? project.locator.hostId : undefined;
			const remoteRuntime = this.remoteRuntime;
			if (!hostId || !remoteRuntime) throw new Error(REMOTE_RUNTIME_CODES.unavailable);
			const prepared = await remoteRuntime.prepare({
				hostId,
				remoteCwd: runtime.tab.cwd,
				sessionFile: sessionPath,
				// 与 create 同一取值顺序（与本地 securitySessionId 同源）；重连也可能拿到新的会话文件。
				...(runtime.tab.deckSessionId === undefined && sessionPath.length === 0 ? {} : { sessionId: runtime.tab.deckSessionId ?? sessionPath }),
			});
			// 重连可能换主机环境（版本/快照），注入面随之更新；UI 必须跟着变，不能留旧的能力门。
			runtime.tab.remoteExtensions = prepared.extensions;
			this.remoteLaunchByAgent.set(agentId, { plan: prepared.plan, launcher: remoteRuntime.createLauncher() });
		}

		void this.appLogger?.info("agent", "Reattaching process", {
			agentId,
			sessionPath,
			location: isRemote ? "remote" : "local",
		});
		const { deckSessionId, runtimeGeneration } = runtime.tab;
		const assertCurrentRuntime = (process: PiProcess) => {
			// 握手也会等待：关闭或另一次重连后，不得发布旧历史/诊断或恢复已关闭的 tab。
			if (this.agents.get(agentId) !== runtime || runtime.process !== process) {
				process.stop();
				throw new Error("Compaction cancelled: runtime changed");
			}
			if (runtime.tab.deckSessionId !== deckSessionId || runtime.tab.runtimeGeneration !== runtimeGeneration || runtime.tab.sessionPath !== sessionPath) throw new Error("Compaction cancelled: runtime changed");
		};

		const handshake = await this.handshakePiProcess(agentId, {
			// 远端：`projectPath` 的消费者只有日志与生命周期事件归属，不是本机文件路径——create 同样
			// 传远端 cwd（`project.path` 在远端项目上不存在，也不再能靠 `isLocalProject` 收窄）。
			projectPath: isRemote ? runtime.tab.cwd : project.path,
			sessionPath,
			deckSessionId: runtime.tab.deckSessionId,
			onExit: (payload) => this.handleReattachProcessExit(agentId, runtime, payload),
		});
		const process = handshake.process;
		assertCurrentRuntime(process);
		const restartDiag = process.getDiagnostics();
		void this.appLogger?.info("agent", "Pi process restarted", {
			agentId,
			command: restartDiag?.command,
			args: restartDiag?.args?.join(" "),
			cwd: restartDiag?.cwd,
			fallbackFromExtensions: handshake.fallbackFromExtensions,
		});

		try {
			const stateResponse = handshake.state;
			const data = stateResponse.data as { sessionId?: string; sessionFile?: string; sessionName?: string } | undefined;
			runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
			// 远端与本地走同一个归一化入口：远端只做 POSIX 归一化（相对 sessionDir 会报相对路径），
			// 本地走平台规则。原样采用远端值会让下一次 spawn 的 `--session` 与 catalog 身份对不上。
			runtime.tab.sessionPath = this.reportSessionPathFromPi(data?.sessionFile ?? sessionPath, runtime.tab.projectId, runtime.tab.sessionEnvironment ?? "native", runtime.tab.cwd);
			runtime.tab.status = "idle";
			// 进程退出型压缩可能来不及发 compaction_end；重连成功即表示 Pi 已可继续接收消息。
			this.rpcCompactingAgents.delete(agentId);

			// 重连成功后清除自动重连标记，允许下一次再触发
			this.autoRestartAttempted.delete(agentId);

			// 如果有旧的 pending abort 标记，清理掉
			this.abortedDuringAsk.delete(agentId);

			// 重连期间用户可能已发送消息（乐观上屏）：必须保护，否则替换投影时未落盘消息丢失。
			// 远端跳过：本批不加载远端历史（create 同标 `historyLoading: "unsupported"`），且本机 reader
			// 读不到远端文件——拉一次只会白跑并可能把空页写进缓存。
			if (!isRemote) await this.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() }).catch(() => undefined);
			assertCurrentRuntime(process);
			this.startupDiagnostics.notifyExtensionsDisabled(agentId, {
				fallbackFromExtensions: handshake.fallbackFromExtensions,
				debugDetails: handshake.fallbackDebug,
			});

			void this.appLogger?.info("agent", "Process reattached successfully", {
				agentId,
			});
		} catch (error) {
			void this.appLogger?.error("agent", "Process reattach failed", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/** createUnlocked 路径的进程 exit：支持压缩后自动重连，其余标 closed。 */
	handleCreateProcessExit(agentId: string, tab: AgentTab, payload: { code: number | null; signal: string | null }) {
		if (this.startupHandshakeAgents.has(agentId)) return;
		// standby 进程在绑定前退出：立即从池剔除，避免 claim 到死进程（TTL 会兜其他泄漏路径）。
		if (this.standbyPool.status()?.agentId === agentId) this.standbyPool.clear();
		// 用户主动停止 → 不自动重连
		if (this.userInitiatedStop.has(agentId)) {
			this.userInitiatedStop.delete(agentId);
			tab.status = "closed";
			this.emitState();
			void this.appLogger?.info("agent", "Agent process exit handled: user-initiated stop", {
				agentId,
				code: payload.code,
				signal: payload.signal,
			});
			return;
		}
		// 手动压缩期间退出 → compact() 的 catch 块会负责重连
		if (this.compactingAgents.has(agentId)) {
			tab.status = "closed";
			this.emitState();
			void this.appLogger?.info("agent", "Agent process exit handled: compaction in progress", {
				agentId,
				code: payload.code,
			});
			return;
		}
		// 终止窗口内的意外退出（Issue #218 WSL）：pi 在处理 abort 时可能自行崩溃
		// （上游 #2716 族：abort 期间 unhandled rejection 直接杀 Node 进程），且任何
		// 退出码都可能。此时不把会话打成 closed 终态，而是按会话文件重连一次，
		// 保住会话可用性——用户只是终止了一条回复，不该丢掉整个会话。
		const lastAbortAt = this.lastAbortAtByAgent.get(agentId);
		const withinAbortWindow = lastAbortAt !== undefined && Date.now() - lastAbortAt < ABORT_EXIT_REATTACH_WINDOW_MS;
		if (withinAbortWindow && !this.autoRestartAttempted.has(agentId) && tab.sessionPath) {
			this.autoRestartAttempted.add(agentId);
			tab.status = "starting";
			this.emitState();
			void this.appLogger?.warn("agent", "Agent exited during abort window; reattaching session", {
				agentId,
				code: payload.code,
				signal: payload.signal,
				sessionPath: tab.sessionPath,
			});
			this.reattachProcess(agentId, tab.sessionPath)
				.then(() => {
					tab.status = "idle";
					this.addLocalizedMessage(agentId, "system", "diagnostic.abortReconnected", "终止后进程异常退出，会话已自动恢复");
					this.emitState();
				})
				.catch(() => {
					tab.status = "closed";
					void this.appLogger?.error("agent", "Agent reattach after abort-window exit failed", {
						agentId,
						code: payload.code,
						sessionPath: tab.sessionPath,
					});
					this.addLocalizedMessage(agentId, "error", "diagnostic.processReconnectFailed", "Agent 进程意外退出，自动重连失败");
					this.clearAgentState(agentId);
					this.emitState();
				});
			return;
		}
		// 自动压缩 / 进程干净退出（exit code 0）且有会话路径 → 尝试一次自动重连
		if (!this.autoRestartAttempted.has(agentId) && tab.sessionPath && payload.code === 0) {
			this.autoRestartAttempted.add(agentId);
			tab.status = "starting";
			this.emitState();
			void this.appLogger?.info("agent", "Agent process exited cleanly; auto-restarting", {
				agentId,
				code: payload.code,
				sessionPath: tab.sessionPath,
			});
			this.reattachProcess(agentId, tab.sessionPath)
				.then(() => {
					tab.status = "idle";
					this.addLocalizedMessage(agentId, "system", "diagnostic.compactReconnected", "会话压缩完成，Agent 已自动重连");
					this.emitState();
				})
				.catch(() => {
					tab.status = "closed";
					void this.appLogger?.error("agent", "Agent auto-restart failed", {
						agentId,
						code: payload.code,
						sessionPath: tab.sessionPath,
					});
					this.addLocalizedMessage(agentId, "error", "diagnostic.processReconnectFailed", "Agent 进程意外退出，自动重连失败");
					this.clearAgentState(agentId);
					this.emitState();
				});
			return;
		}
		tab.status = "closed";
		// 非 0 退出且还没写过错误卡时，补一条可排查信息（避免用户只看到 closed）。
		if (payload.code !== 0 && payload.code !== null) {
			const runtime = this.agents.get(agentId);
			const diag = runtime?.process.getDiagnostics() ?? null;
			this.addMessage(agentId, "error", this.buildStartupFailureMessage(`pi 进程退出 code=${payload.code}${payload.signal ? ` signal=${payload.signal}` : ""}`, diag));
		}
		// 最终停止（无重连路径）：统一清理该 agent 的运行态键，避免慢泄漏
		this.clearAgentState(agentId);
		this.emitState();
	}

	/** reattach 路径的进程 exit：同样做单次自动重连保护。 */
	handleReattachProcessExit(agentId: string, runtime: ReattachRuntime, payload: { code: number | null; signal: string | null }) {
		if (this.startupHandshakeAgents.has(agentId)) return;
		if (this.userInitiatedStop.has(agentId)) {
			this.userInitiatedStop.delete(agentId);
			runtime.tab.status = "closed";
			this.emitState();
			void this.appLogger?.info("agent", "Agent process exit handled: user-initiated stop (reattach)", {
				agentId,
				code: payload.code,
				signal: payload.signal,
			});
			return;
		}
		// 终止窗口内的意外退出（Issue #218 WSL）：与 create 路径同款处理，
		// pi 在 abort 处理中崩溃时按会话文件重连一次，而不是把会话打成 closed。
		const lastAbortAt = this.lastAbortAtByAgent.get(agentId);
		const withinAbortWindow = lastAbortAt !== undefined && Date.now() - lastAbortAt < ABORT_EXIT_REATTACH_WINDOW_MS;
		if (withinAbortWindow && !this.autoRestartAttempted.has(agentId) && runtime.tab.sessionPath) {
			this.autoRestartAttempted.add(agentId);
			runtime.tab.status = "starting";
			this.emitState();
			void this.appLogger?.warn("agent", "Agent exited during abort window; reattaching session (reattach path)", {
				agentId,
				code: payload.code,
				signal: payload.signal,
				sessionPath: runtime.tab.sessionPath,
			});
			this.reattachProcess(agentId, runtime.tab.sessionPath)
				.then(() => {
					runtime.tab.status = "idle";
					this.addLocalizedMessage(agentId, "system", "diagnostic.abortReconnected", "终止后进程异常退出，会话已自动恢复");
					this.emitState();
				})
				.catch(() => {
					runtime.tab.status = "closed";
					this.addLocalizedMessage(agentId, "error", "diagnostic.processReconnectFailed", "Agent 进程意外退出，自动重连失败");
					void this.appLogger?.error("agent", "Agent reattach after abort-window exit failed (reattach path)", {
						agentId,
						code: payload.code,
						signal: payload.signal,
						sessionPath: runtime.tab.sessionPath,
					});
					this.clearAgentState(agentId);
					this.emitState();
				});
			return;
		}
		// 自动压缩也可能发生在重连后的进程中；继续复用同一会话文件重附加，
		// 但仍用 autoRestartAttempted 做单次保护，避免真正异常退出时无限重启。
		if (!this.autoRestartAttempted.has(agentId) && runtime.tab.sessionPath && payload.code === 0) {
			this.autoRestartAttempted.add(agentId);
			runtime.tab.status = "starting";
			this.emitState();
			this.reattachProcess(agentId, runtime.tab.sessionPath)
				.then(() => {
					runtime.tab.status = "idle";
					this.addLocalizedMessage(agentId, "system", "diagnostic.compactReconnected", "会话压缩完成，Agent 已自动重连");
					void this.appLogger?.info("agent", "Agent reattach auto-restart succeeded", {
						agentId,
						code: payload.code,
						sessionPath: runtime.tab.sessionPath,
					});
					this.emitState();
				})
				.catch(() => {
					runtime.tab.status = "closed";
					this.addLocalizedMessage(agentId, "error", "diagnostic.processReconnectFailed", "Agent 进程意外退出，自动重连失败");
					void this.appLogger?.error("agent", "Agent reattach auto-restart failed", {
						agentId,
						code: payload.code,
						signal: payload.signal,
						sessionPath: runtime.tab.sessionPath,
					});
					this.clearAgentState(agentId);
					this.emitState();
				});
			return;
		}
		runtime.tab.status = "closed";
		// 最终停止（无重连路径）：统一清理该 agent 的运行态键。
		// 异常退出（非 0 码）与正常退出在此汇合，warn 记录退出码便于与 exit 事件区分。
		void this.appLogger?.warn("agent", "Agent process exited; no reconnect (reattach path)", {
			agentId,
			code: payload.code,
			signal: payload.signal,
			sessionPath: runtime.tab.sessionPath,
		});
		this.clearAgentState(agentId);
		this.emitState();
	}

	/**
	 * 把 pi 启动/退出失败整理成可复制的诊断文案。
	 * 目标：用户不至于只看到闪退或空白，Issue 也能直接贴日志。
	 */
	buildStartupFailureMessage(rawMessage: string, diag: ReturnType<PiProcess["getDiagnostics"]>): string {
		if (!diag) {
			return `⚠️ Pi RPC 启动失败\n\n${rawMessage}\n\nplatform=${globalThis.process.platform} arch=${globalThis.process.arch}`;
		}
		const lines: string[] = [];
		if (diag.spawnFailed) {
			// spawn 阶段失败：结论先行。否则用户被 "spawn C:\Windows\system32\cmd.exe ENOENT"
			// 引去查 cmd.exe/PATH/杀毒软件，而真实原因往往在工作目录或 pi 路径。
			lines.push("失败阶段: 进程未启动（spawn 失败；此时扩展根本没被加载，与扩展无关）");
		}
		if (diag.exitCode !== null) {
			lines.push(`退出码: ${diag.exitCode}${diag.exitSignal ? ` (signal: ${diag.exitSignal})` : ""}`);
		}
		const stderrText = diag.stderr.join("").trim();
		if (stderrText) {
			const snippet = stderrText.length > 600 ? "…" + stderrText.slice(-600) : stderrText;
			lines.push(`进程错误输出:\n${snippet}`);
		}
		lines.push(`pi 路径: ${diag.command}`);
		if (diag.customPiPath) lines.push(`自定义路径: ${diag.customPiPath}`);
		lines.push(`工作目录: ${diag.cwd}`);
		if (diag.cwdMissing) {
			lines.push("工作目录状态: ✗ 不存在 —— 这才是上面 spawn ENOENT 的真实原因" + "（Windows 会把「工作目录无效」误报成 cmd.exe 找不到，pi/cmd.exe 本身没问题）");
		}
		// 「✗ 失败」只在真的探过 pi --version 时才成立；没探过就说没探过，
		// 否则用户会被引去重装 pi（现场：真正原因其实是工作目录没了）。
		const versionCheckFailed = diag.versionCheckProbed !== false && !diag.versionCheck;
		lines.push(`版本检测: ${diag.versionCheckProbed === false ? "未完成（未拿到 pi --version 结果，不代表失败）" : diag.versionCheck ? "✓ 通过" : "✗ 失败"}`);
		lines.push(`运行环境: ${globalThis.process.platform}/${globalThis.process.arch}`);
		if (diag.launch && diag.launch.channel === "cmd-shim") {
			// 「pi 不是改成 node 启动了吗」——把通道与回退原因写进卡片，免得命令行里的 cmd.exe 被当成回归。
			lines.push(`启动通道: cmd.exe 回退${diag.launch.reason ? `（原因：${diag.launch.reason}）` : ""}` + "（node 直启需要 npm 生成的 pi.cmd 垫片与其中的 JS 入口都存在）");
		} else if (diag.launch?.channel === "node-direct") {
			lines.push("启动通道: node 直启（已还原 JS 入口，无 cmd.exe 中间层）");
		}
		if (diag.blockedExtensions && diag.blockedExtensions.length > 0) {
			// 桌面端已自动隔离的扩展（如 codeisland），方便用户对照「为何 RPC 没加载该扩展」。
			lines.push(`已自动隔离扩展: ${diag.blockedExtensions.join(", ")}`);
		}
		lines.push("");
		lines.push("━━━ 排查步骤 ━━━");
		if (diag.cwdMissing) {
			lines.push("1. 确认上面的工作目录是否真的存在（被移动/重命名/删除，或所在磁盘/网络盘未挂载）");
			lines.push("2. 目录不存在时 pi 无法以该目录为工作目录启动，与 pi 是否安装无关");
			lines.push("3. 在 PiDeck 中重新指定该项目的目录后重启会话");
		} else if (versionCheckFailed) {
			lines.push("1. 在终端执行 pi --version，确认 pi 是否已安装且路径正确");
			lines.push("2. 如未安装，执行 npm install -g @earendil-works/pi-coding-agent");
			lines.push("3. macOS 若从 Dock 启动，可在设置中填写完整 pi 路径（Homebrew 常见 /opt/homebrew/bin/pi）");
		} else if (diag.exitCode !== 0 && diag.exitCode !== null) {
			lines.push("1. 在终端执行 pi --mode rpc 看是否能正常启动");
			lines.push("2. 注意终端中的错误信息（架构不匹配/权限/扩展崩溃都会体现在这里）");
		} else if (!stderrText && diag.exitCode === null) {
			// 进程还活着但不响应握手：与「进程没起来」是两类问题，别让用户反复重装 pi。
			lines.push(`1. pi 进程已启动，但 ${Math.round(this.startupHandshakeTimeoutMs / 1000)} 秒内未响应 get_state（进程仍存活，不是崩溃）。`);
			lines.push("2. 常见原因：某个扩展在初始化阶段卡住、会话文件异常巨大、pi 在等待网络。");
			lines.push("3. 在终端执行 pi --mode rpc 看是否能正常启动，注意终端中的错误信息");
		} else {
			lines.push("1. 在终端执行 pi --mode rpc 确认 pi 能否正常启动");
			lines.push("2. 检查设置中的 pi 路径是否正确");
		}
		const startFlags = this.settingsStore.get();
		const noExt = Boolean(startFlags.piRpcNoExtensions);
		const noSkills = Boolean(startFlags.piRpcNoSkills);
		lines.push("");
		lines.push("━━━ 扩展 / 技能排查 ━━━");
		if (noExt || noSkills) {
			lines.push(`当前启动已禁用：${[noExt ? "扩展 (--no-extensions)" : null, noSkills ? "技能 (--no-skills)" : null].filter(Boolean).join("、")}`);
			lines.push("若仍失败，更可能是 pi 本体/路径/会话文件问题，而不是扩展加载。");
		} else if (diag.spawnFailed) {
			// 进程都没起来，扩展压根没被加载：让用户去关扩展只是白跑一趟。
			lines.push("本次失败发生在 pi 进程启动之前（扩展尚未加载），不需要在这里排查扩展/技能。");
		} else {
			lines.push("若怀疑某个扩展或技能导致启动失败：");
			lines.push("1. 打开 设置 → 开发设置");
			lines.push("2. 临时开启「禁用扩展启动」和/或「禁用技能启动」");
			lines.push("3. 保存后重新启动 Agent 验证");
			lines.push("若禁用后能启动，再逐个排查 ~/.pi/agent/extensions 与 skills。");
		}
		// 解释「为什么这次没有自动用 --no-extensions 重试」：用户预期启动失败会自动回退，
		// 缺了这句就会被当成回退功能没生效（现场反馈即如此）。
		const fallbackSkip = describeExtensionFallbackSkip({
			alreadyNoExtensions: noExt,
			stderr: stderrText,
			errorMessage: rawMessage,
			exitCode: diag.exitCode,
			spawnFailed: diag.spawnFailed === true,
			// 能走到诊断卡且未被判定为 spawn 失败、也没有退出码 ⇒ 进程当时仍存活（握手超时）
			processStillRunning: diag.spawnFailed !== true && diag.exitCode === null,
		});
		if (fallbackSkip) {
			lines.push("");
			lines.push("━━━ 扩展回退 ━━━");
			lines.push(`本次未自动用 --no-extensions 重试：${fallbackSkip}`);
		}
		lines.push("");
		lines.push("如问题持续，可在 GitHub 提交 Issue 并附上以上信息与应用日志。");
		return `⚠️ Pi RPC 启动失败\n\n${rawMessage}\n\n${lines.join("\n")}`;
	}
}
