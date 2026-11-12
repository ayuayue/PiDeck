import { app } from "electron";
import type { AgentRuntimeState, AgentTab, ChatMessage, I18nParams, Project } from "../../shared/types";
import { COMPACT_CANCELLED_BY_OWNER, COMPACT_ROUTED_TO_OWNER, COMPACT_WAIT_TIMEOUT } from "../../shared/compactFeedback";
import { resolveBuiltInExtensionsOverlayDir } from "../extensions/builtInExtensions";
import { resolveLoadableExtensionPaths } from "../extensions/enabledExtensionResolver";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";
import { createCompactRpcRequest } from "./compactRpc";
import { readPiCompactionOwnership, type PiCompactionOwnership } from "./compactionOwner";
import type { PiProcess } from "./PiProcess";
import type { RpcResponse } from "./PiRpcClient";

/** 压缩域只读到的运行时切片（宿主 agents map 的值类型）。 */
type CompactionRuntime = { tab: AgentTab; process: PiProcess };

/**
 * 手动压缩域协作方的窄接口：只列实现真正用到的回调与读取器，不引入新状态。
 *
 * 压缩过程集合（pending/compacting/超时/rpcCompacting）由宿主持有并按引用传入——
 * `compaction_start`/`compaction_end` 事件、`getRuntimeState`、`clearAgentState` 都直接
 * 读写它们，搬进协作者只会把同样的状态藏一层。取消来源判定的两个读取器留在宿主：
 * 契约测试按「`compact` 紧随 `resolveCompactCancelMessage`」的相邻形态断言源码。
 */
export interface CompactionRunnerHost {
	requireRuntime(agentId: string): CompactionRuntime;
	readonly agents: Map<string, CompactionRuntime>;
	readonly appLogger?: AppLogger;
	readonly settingsStore: SettingsStore;
	/** rpcTimeout 走回调：设置可在会话期间被改，取实时值而不是构造时快照。 */
	rpcTimeout(): number;
	readonly pendingCompactProcesses: Map<string, PiProcess>;
	readonly compactingAgents: Set<string>;
	readonly compactTimedOutAgents: Set<string>;
	readonly rpcCompactingAgents: Set<string>;
	readonly contextOverflowByAgent: Map<string, boolean>;
	getProject(id: string): Project | undefined;
	emitRuntimeState(agentId: string): Promise<void>;
	emitContextOverflowState(agentId: string, contextOverflow: boolean): void;
	emitState(): void;
	getRuntimeState(agentId: string): Promise<AgentRuntimeState>;
	loadMessages(agentId: string, skipEntries?: boolean, earlyMessagesPromise?: Promise<RpcResponse>, options?: { preserveMessagesAfter?: number }): Promise<unknown>;
	reattachProcess(agentId: string, sessionPath: string): Promise<void>;
	addLocalizedMessage(agentId: string, role: ChatMessage["role"], i18nKey: string, fallbackText: string, options?: { params?: I18nParams; debugDetails?: string; meta?: Record<string, unknown> }): void;
	listRegisteredCommands(runtime: CompactionRuntime): Promise<Array<{ name: string; source?: string; sourcePath?: string }> | undefined>;
	/** 接管探测：实现是宿主的薄包装，实例可替换（测试与装配都按此形态注入）。 */
	resolveSessionCompactionOwnership(runtime: CompactionRuntime): Promise<PiCompactionOwnership | undefined>;
	resolveCompactCancelMessage(agentId: string, errorMessage: string): string | undefined;
	compactionCancelEvidence(agentId: string): Record<string, unknown>;
}

/** 手动压缩域：compact 请求编排、接管者改写、失败重连与探测（拆分第七刀）。 */
export class CompactionRunner {
	constructor(private readonly host: CompactionRunnerHost) {}

	/** 宿主字段别名：搬出的实现保持 `this.<字段>` 原样（契约测试按此形态断言）。 */
	private get agents() {
		return this.host.agents;
	}

	private get appLogger() {
		return this.host.appLogger;
	}

	private get settingsStore() {
		return this.host.settingsStore;
	}

	private get rpcTimeoutMs() {
		return this.host.rpcTimeout();
	}

	private get pendingCompactProcesses() {
		return this.host.pendingCompactProcesses;
	}

	private get compactingAgents() {
		return this.host.compactingAgents;
	}

	private get compactTimedOutAgents() {
		return this.host.compactTimedOutAgents;
	}

	private get rpcCompactingAgents() {
		return this.host.rpcCompactingAgents;
	}

	/** 宿主回调别名：搬出的实现保持 `this.resolveSessionCompactionOwnership(...)` 原样。 */
	private get resolveSessionCompactionOwnership() {
		return this.host.resolveSessionCompactionOwnership;
	}

	private get contextOverflowByAgent() {
		return this.host.contextOverflowByAgent;
	}

	/**
	 * 手动触发上下文压缩。pi 会将历史消息摘要化以释放 context 空间，
	 * 适用于长时间对话后 context 占比过高、但不想丢失关键信息的场景。
	 *
	 * 注意：pi 在压缩完成后可能会自动重启进程（尤其早期版本），此时 RPC 请求会因
	 * "pi exited" 错误而失败。本方法检测到进程退出后会自动重连同一会话并加载消息，
	 * 因此调用方不应把 RPC 失败等同于压缩失败。
	 */
	async compact(agentId: string, prompt?: string) {
		const runtime = this.host.requireRuntime(agentId);
		const compactProcess = runtime.process;
		const { deckSessionId, runtimeGeneration, sessionPath } = runtime.tab;
		let expectedProcess = compactProcess;
		const assertCurrentRuntime = () => {
			if (this.agents.get(agentId) !== runtime || runtime.process !== expectedProcess || runtime.tab.deckSessionId !== deckSessionId || runtime.tab.runtimeGeneration !== runtimeGeneration || runtime.tab.sessionPath !== sessionPath) throw new Error("Compaction cancelled: runtime changed");
		};
		let keepCompacting = false;
		const trimmedPrompt = prompt?.trim();
		const startTime = Date.now();

		void this.appLogger?.info("agent", "Compact requested", {
			agentId,
			prompt: trimmedPrompt,
			hasSessionPath: !!runtime.tab.sessionPath,
		});

		// 已有压缩在进行（手动请求未返回 / pi 自动压缩中）：拒绝重复请求。
		// 渲染层按钮在 isCompacting 时禁用，这里是双保险。旧实现 return 成功状态，
		// 用户连点会当成「压缩完成」或完全没反应；改为明确错误，UI 映射 inProgress。
		if (this.pendingCompactProcesses.has(agentId) || this.compactingAgents.has(agentId) || this.rpcCompactingAgents.has(agentId)) {
			void this.appLogger?.info("agent", "Compact skipped: already compacting", {
				agentId,
			});
			throw new Error("already compacting");
		}

		// 探测也属于这次请求；占位先于任何 await，原生压缩标记仍只在实际发送 RPC 时设置。
		this.pendingCompactProcesses.set(agentId, compactProcess);
		void this.host.emitRuntimeState(agentId);
		try {
			// 接管者改写：会话的上下文窗口可能已被扩展独占（它用 session_before_compact
			// 钩子取消 pi 的压缩）。这时发 compact RPC 注定拿到 Compaction cancelled，
			// 必须改成它自己的入口（如 Magic Context 的 /ctx-wrapup），否则用户只看到「没反应」。
			const ownership = await this.resolveSessionCompactionOwnership(runtime);
			assertCurrentRuntime();
			if (ownership && ownership.owners.length > 0) {
				return await this.routeCompactToOwner(runtime, ownership);
			}

			// 标记压缩中，退出处理器据此区分压缩重启与异常崩溃
			this.compactingAgents.add(agentId);
			// 立即推送 isCompacting=true（getRuntimeState 合并 compactingAgents 集合）：
			// 让圆环按钮进入禁用/进度态，避免用户重复点击触发第二个 compact。
			// 此前 add 后无推送，isCompacting 要等 pi 的 compaction_start 事件才到渲染层。
			void this.host.emitRuntimeState(agentId);

			try {
				// 等待上限吃 rpcTimeout 设置（默认 600s）：压缩要过一遍 LLM 摘要，大上下文
				// （真实案例 tokensBefore≈209k）轻松超过两分钟——写死 120s 时后台 149.4s 完成
				// 却被提前报「压缩失败」，而 rpcTimeout 调大也无效（#303）。超时≠失败：进程
				// 仍活着时压缩大概率还在后台跑，见下方超时分支。
				const response = await compactProcess.client.request(createCompactRpcRequest(trimmedPrompt), this.rpcTimeoutMs);
				assertCurrentRuntime();
				void this.appLogger?.info("agent", "Compact RPC response received", {
					agentId,
					elapsedMs: Date.now() - startTime,
					rpcSuccess: response.success,
					rpcError: response.error,
				});

				// success:false 必须抛给上层：渲染层靠错误文案映射 nothing-to-do / too-small
				// 友好 toast。之前只 warn 不抛，导致「暂无可压缩内容」永远到不了 UI（#113 3.2-7）。
				if (!response.success) {
					const rpcError = response.error?.trim() || "compact failed";
					void this.appLogger?.warn("agent", "Compact RPC returned failure", {
						agentId,
						error: rpcError,
					});
					this.compactingAgents.delete(agentId);
					throw new Error(rpcError);
				}

				this.compactingAgents.delete(agentId);
				// 上下文超限恢复入口成功后清除失败标记；否则下一次打开圆环仍会误显示「先压缩」。
				this.contextOverflowByAgent.delete(agentId);
				this.host.emitContextOverflowState(agentId, false);
				// 压缩成功且进程未退出，直接加载消息（压缩期间乐观/流式消息不能丢：保护到重载完成）
				await this.host.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() }).catch(() => undefined);
				assertCurrentRuntime();
				void this.appLogger?.info("agent", "Compact completed successfully", {
					agentId,
					totalElapsedMs: Date.now() - startTime,
				});
			} catch (error) {
				// 关闭/替换后的旧请求不能恢复进程、清掉新上下文或把旧错误归给新进程。
				assertCurrentRuntime();
				const errorMsg = error instanceof Error ? error.message : String(error);
				const processAlive = compactProcess.isRunning();
				// 等待超时≠压缩失败：进程仍活着时 pi 大概率还在后台压（#303 真实案例：
				// 120s 超时报错，149.4s 后台实际成功并写入会话文件）。超时单独分支处理。
				const waitTimedOut = processAlive && /RPC command timed out [^:]*: compact/.test(errorMsg);
				// 取消来源判定必须在这里做（compact 完成后观测就会被下一次压缩覆盖）：
				// 只有它能让「点了压缩没反应」变成可解释的提示 + 可排查的日志。
				const cancelSource = processAlive && !waitTimedOut ? this.host.resolveCompactCancelMessage(agentId, errorMsg) : undefined;
				if (waitTimedOut) {
					// 超时是「没等到响应」不是「压缩失败」，日志用 warn 避免告警噪音误导排查
					void this.appLogger?.warn("agent", "Compact wait timed out; still running in background", {
						agentId,
						elapsedMs: Date.now() - startTime,
						error: errorMsg,
						hasSessionPath: !!runtime.tab.sessionPath,
					});
				} else {
					void this.appLogger?.error("agent", "Compact failed", {
						agentId,
						elapsedMs: Date.now() - startTime,
						error: errorMsg,
						processAlive,
						hasSessionPath: !!runtime.tab.sessionPath,
						...(cancelSource ? { cancelSource } : {}),
						...this.host.compactionCancelEvidence(agentId),
					});
					this.compactingAgents.delete(agentId);
				}

				// 如果进程在压缩期间退出（pi 压缩后自动重启进程的行为），
				// RPC 请求会因连接断开而失败，但压缩实际已完成。
				// 尝试重连同一会话，不从 compact() 层面抛出错误。
				if (!processAlive && runtime.tab.sessionPath) {
					void this.appLogger?.info("agent", "Compact: process exited, reattaching", {
						agentId,
					});
					await this.host.reattachProcess(agentId, runtime.tab.sessionPath);
					// 这是本次压缩主动重连的新进程；只有同一 runtime 仍在时才接纳它。
					if (this.agents.get(agentId) !== runtime) throw new Error("Compaction cancelled: runtime changed");
					expectedProcess = runtime.process;
					runtime.tab.status = "idle";
					await this.host.loadMessages(agentId, false, undefined, { preserveMessagesAfter: Date.now() }).catch(() => undefined);
					assertCurrentRuntime();
					this.host.addLocalizedMessage(agentId, "system", "diagnostic.compactDone", "会话压缩完成");
					this.host.emitState();
					void this.appLogger?.info("agent", "Compact: reattach succeeded", {
						agentId,
						totalElapsedMs: Date.now() - startTime,
					});
				} else if (waitTimedOut) {
					// 不清 compactingAgents：isCompacting 保持 true，圆环按钮继续禁用，
					// 防止用户在后台压缩期间重复触发；状态由 compaction_end 事件负责收尾
					// （compaction_end 处理器里同步 delete）。标记本 agent 超时过，
					// 后台最终成功时补发「压缩完成」系统消息（RPC 已 reject，正常 toast 链
					// 不会再走）。
					this.compactTimedOutAgents.add(agentId);
					keepCompacting = true;
					throw new Error(COMPACT_WAIT_TIMEOUT);
				} else if (cancelSource) {
					// 抛带来源的稳定文案：渲染层据此给出「扩展接管 / 被自己打断」的可操作
					// 提示，而不是原来那条被归成静默的 pi 原文（用户只看到「没反应」）。
					void this.appLogger?.warn("agent", "Compact cancelled", {
						agentId,
						cancelSource,
						piError: errorMsg,
						sessionId: runtime.tab.deckSessionId,
					});
					throw new Error(cancelSource);
				} else {
					// 非退出相关的 RPC 错误，正常抛出
					throw error;
				}
			}
		} finally {
			// 只释放本次请求占位，迟到 finally 不得清理后来启动的新进程请求。
			if (this.pendingCompactProcesses.get(agentId) === compactProcess) {
				this.pendingCompactProcesses.delete(agentId);
				if (!keepCompacting) this.compactingAgents.delete(agentId);
				if (this.agents.get(agentId) === runtime) void this.host.emitRuntimeState(agentId);
			}
		}

		return this.host.getRuntimeState(agentId);
	}

	/**
	 * 探测「这个会话的上下文窗口由谁管」（见 pi/compactionOwner.ts 的背景说明）。
	 *
	 * 两层证据：
	 * 1. 「装了且启用」：用与 spawn 同源的加载查询（`resolveLoadableExtensionPaths`，原生过滤 + 旧禁用记录）——
	 *    PiDeck 扩展管理里禁用的扩展不会出现在路径集合里，不能按磁盘 packages 判接管；
	 * 2. 「命令本次可用」：`get_commands` 确认 /ctx-wrapup 已注册（compaction-off 模式 /
	 *    子会话下 MC 不注册它）。
	 * 接管开关只能读磁盘配置（pi 没有「列出已加载扩展钩子」的 RPC）。
	 * 探测本身绝不抛：探测失败按「没有接管者」处理，退回原来的 compact RPC，
	 * 失败时由 cancel 来源判定兜底提示。
	 */
	async probeSessionCompactionOwnership(runtime: CompactionRuntime): Promise<PiCompactionOwnership | undefined> {
		try {
			const project = runtime.tab.projectId ? this.host.getProject(runtime.tab.projectId) : undefined;
			const projectCwd = project?.path;
			const sessionCommandNames = await this.listRegisteredCommandNames(runtime);
			// 与 spawn 同源的白名单解析；拿不到项目 cwd 时传 undefined（退回磁盘 packages 推导）
			// 与运行时同源的「会加载哪些扩展」查询（原生过滤 + 旧禁用记录）。
			const loadedExtensionPaths = projectCwd
				? resolveLoadableExtensionPaths({
						cwd: projectCwd,
						includeProjectResources: true,
						disabled: this.settingsStore.get().disabledExtensions ?? [],
						removedBuiltInExtensions: this.settingsStore.get().removedBuiltInExtensions ?? [],
						builtInRoots: {
							appPath: app.getAppPath(),
							resourcesPath: process.resourcesPath,
							isDev: !app.isPackaged,
							overlayDir: resolveBuiltInExtensionsOverlayDir(app.getPath("userData")),
						},
					})
				: undefined;
			return readPiCompactionOwnership({
				projectCwd,
				sessionCommandNames,
				loadedExtensionPaths,
			});
		} catch (error) {
			void this.appLogger?.warn("agent", "Compaction ownership probe failed", {
				agentId: runtime.tab.id,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	/**
	 * 列出 pi 已注册的命令名；探测失败返回 undefined（=「不确定」，不是「没有」）。
	 * 不区分 extension/prompt/skill 来源：`/ctx-wrapup` 这类接管者命令只可能来自扩展。
	 */
	private async listRegisteredCommandNames(runtime: CompactionRuntime): Promise<string[] | undefined> {
		const commands = await this.host.listRegisteredCommands(runtime);
		if (!commands) return undefined;
		return commands.map((command) => command.name).filter((name) => name.length > 0);
	}

	/**
	 * 上下文窗口被扩展独占时的压缩改写 / 拒绝。
	 *
	 * 为什么用 throw 表达「已改写」：compact() 的返回契约是 runtime state，没有
	 * 「我改用了别的命令」这种位；渲染层本来就把错误文案当分类通道（见
	 * shared/compactFeedback 的稳定标记），所以这里抛标记而不是伪造成功状态——
	 * 渲染层因此不会误报「压缩完成」（真正的结果由接管者自己的状态提示给出）。
	 */
	private async routeCompactToOwner(runtime: CompactionRuntime, ownership: PiCompactionOwnership): Promise<AgentRuntimeState> {
		const agentId = runtime.tab.id;
		const process = runtime.process;
		const { deckSessionId, runtimeGeneration, sessionPath } = runtime.tab;
		const command = ownership.manualCommand;
		void this.appLogger?.warn("agent", "Compact handled by context owner", {
			agentId,
			owners: ownership.owners,
			conflicted: ownership.conflicted,
			manualCommand: command,
			ownerReady: ownership.ownerReady,
			piAutoCompactionEnabled: ownership.piAutoCompactionEnabled,
			notes: ownership.notes,
		});

		if (!command || !ownership.ownerReady) {
			// 接管者没有自己的手动入口（billion-context）或还没配好（MC 未配 historian 模型）：
			// 说清原因比静默失败重要——这正是「pi 压不了、它自己也压不了」的状态。
			throw new Error(`${COMPACT_CANCELLED_BY_OWNER}: ${ownership.notes.join("；") || "该扩展取消了 pi 的压缩"}`);
		}

		const startedAt = Date.now();
		const response = await process.client.request({ type: "prompt", message: command }, this.settingsStore.get().rpcTimeout).catch((error) => ({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		}));
		if (this.agents.get(agentId) !== runtime || runtime.process !== process || runtime.tab.deckSessionId !== deckSessionId || runtime.tab.runtimeGeneration !== runtimeGeneration || runtime.tab.sessionPath !== sessionPath) throw new Error("Compaction cancelled: runtime changed");
		void this.appLogger?.info("agent", "Compact owner command dispatched", {
			agentId,
			command,
			elapsedMs: Date.now() - startedAt,
			success: response.success,
			error: response.success ? undefined : response.error,
		});
		if (!response.success) {
			throw new Error(`${COMPACT_CANCELLED_BY_OWNER}: ${response.error ?? command}`);
		}
		throw new Error(`${COMPACT_ROUTED_TO_OWNER}: ${command}`);
	}
}
