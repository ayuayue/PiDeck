import { randomUUID } from "node:crypto";
import { isRemoteProject } from "../../shared/projectLocation";
import type { AgentTab, CreateAgentInput, RemoteProject } from "../../shared/types";
import { looksLikePiSessionFileStem } from "./agentUtils";
import type { AgentFactoryHost, CreateHandshake } from "./agentFactoryHost";

/**
 * 本机/WSL 创建域（拆分第十刀 · local 半边）：项目 trust 预检、资源迁移门、spawn、握手、
 * 会话身份归一化与后台历史加载；命中远端项目时整条流水线转交 `AgentFactoryRemote`。
 *
 * 宿主保留 `create` 公开入口、standby 认领与同名薄包装（`createUnlocked`），
 * 所以这里只提供 `create()` 门面与 private 的 `createUnlocked` 实现。
 */
export class AgentFactoryLocal {
	/**
	 * `createRemoteUnlocked` 由宿主按引用注入（远端半边在 agentFactoryRemote.ts）：
	 * 用同名 getter 别名，让搬出的实现保持 `this.createRemoteUnlocked(...)` 原样。
	 */
	constructor(
		private readonly host: AgentFactoryHost,
		private readonly createRemote: (input: CreateAgentInput, project: RemoteProject) => Promise<AgentTab>,
	) {}

	/** 创建域入口：宿主 `create` / standby 认领经同名薄包装进到这里（实现仍在 `createUnlocked`）。 */
	create(input: CreateAgentInput): Promise<AgentTab> {
		return this.createUnlocked(input);
	}

	/** 宿主字段别名：搬出的实现保持 `this.<字段>` 原样（契约测试按此形态断言）。 */
	private get createRemoteUnlocked() {
		return this.createRemote;
	}

	private get agents() {
		return this.host.agents;
	}

	private get messages() {
		return this.host.messages;
	}

	private get getProject() {
		return this.host.getProject;
	}

	private get appLogger() {
		return this.host.appLogger;
	}

	private get projectTrust() {
		return this.host.projectTrust;
	}

	private get startupDiagnostics() {
		return this.host.startupDiagnostics;
	}

	private get maxHistoryLoadTurns() {
		return this.host.maxHistoryLoadTurns;
	}

	private get resourceMigrationGate() {
		return this.host.resourceMigrationGate();
	}

	private get onBeforeAgentSpawn() {
		return this.host.onBeforeAgentSpawn;
	}

	private get translate() {
		return this.host.translate;
	}

	private get createPiProcess() {
		return this.host.createPiProcess;
	}

	private get handshakePiProcess() {
		return this.host.handshakePiProcess;
	}

	private get handleCreateProcessExit() {
		return this.host.handleCreateProcessExit;
	}

	private get reportSessionPathFromPi() {
		return this.host.reportSessionPathFromPi;
	}

	private get findRuntimeBySessionKey() {
		return this.host.findRuntimeBySessionKey;
	}

	private get getAgentSessionIdentityDefaults() {
		return this.host.getAgentSessionIdentityDefaults;
	}

	private get sessionKeyFor() {
		return this.host.sessionKeyFor;
	}

	private get buildStartupFailureMessage() {
		return this.host.buildStartupFailureMessage;
	}

	private get addLocalizedMessage() {
		return this.host.addLocalizedMessage;
	}

	private get recordTiming() {
		return this.host.recordTiming;
	}

	private get notifyMcpThirdPartyTakeover() {
		return this.host.notifyMcpThirdPartyTakeover;
	}

	private get getHistoryAutoLoadDecision() {
		return this.host.getHistoryAutoLoadDecision;
	}

	private get readRecentMessagesFromSessionFile() {
		return this.host.readRecentMessagesFromSessionFile;
	}

	private get loadMessages() {
		return this.host.loadMessages;
	}

	private get scheduleMessageEmit() {
		return this.host.scheduleMessageEmit;
	}

	private get emitState() {
		return this.host.emitState;
	}

	private async createUnlocked(input: CreateAgentInput) {
		const t0 = Date.now();
		const project = this.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);
		// 远端项目（Phase 4 P4.2）：cwd 在远端，走独立的远端分支；没有注入远端运行时端口时
		// 分支内直接 fail-closed（UNSUPPORTED_PROJECT_LOCATION），绝不拿远端 cwd 去起本机 pi。
		// 放在资源迁移之前：迁移读的是本机项目目录上的旧禁用记录，远端项目没有本机目录。
		if (isRemoteProject(project)) return this.createRemoteUnlocked(input, project);
		// 走到这里 project 已窄化为 LocalProject（远端已在上一行分工，其它位置类型由编译器点名）。
		// 先迁移该项目作用域的旧禁用记录；失败不阻塞启动（迁移内部已记录，且旧记录会被保留）。
		await this.resourceMigrationGate?.(project.id).catch(() => undefined);

		const sessionIdentityDefaults = this.getAgentSessionIdentityDefaults();
		const sessionEnvironment = input.environment ?? sessionIdentityDefaults.environment;
		const id = randomUUID();
		void this.appLogger?.info("agent", "Agent create requested", {
			agentId: id,
			projectId: input.projectId,
			projectPath: project.path,
			sessionPath: input.sessionPath,
			title: input.title,
		});
		const existingForSessionKey = this.sessionKeyFor(input, sessionIdentityDefaults);
		const existingForSession = existingForSessionKey ? this.findRuntimeBySessionKey(existingForSessionKey) : undefined;
		if (existingForSession) {
			void this.appLogger?.info("agent", "Agent create reused existing session", {
				agentId: existingForSession.tab.id,
				sessionPath: input.sessionPath,
			});
			return existingForSession.tab;
		}

		const tab: AgentTab = {
			id,
			projectId: project.id,
			cwd: project.path,
			title: input.title || `${project.name} agent`,
			status: "starting",
			deckSessionId: input.deckSessionId,
			sessionPath: input.sessionPath,
			sessionEnvironment,
			sessionSource: input.source ?? "pi",
			wslDistro: input.wslDistro ?? (sessionEnvironment === "wsl" ? sessionIdentityDefaults.wslDistro : undefined),
			wslUser: input.wslUser ?? (sessionEnvironment === "wsl" ? sessionIdentityDefaults.wslUser : undefined),
			importedSourceId: input.importedSourceId,
			noSession: input.noSession,
			standby: input.standby ? true : undefined,
			createdAt: Date.now(),
		};

		const t1 = Date.now();
		const trustOverride = await this.projectTrust.ensureProjectTrust(project);
		const t2 = Date.now();

		void this.appLogger?.info("agent", "Agent pi process start", { agentId: id });
		// 每次 spawn 前异步刷新模型列表缓存（不等完成，避免阻塞 Agent 启动）：
		// 用户直接编辑 models.json/auth.json 后，下一次启动的 Agent 即能看到新模型。
		this.onBeforeAgentSpawn?.();
		// 第 12 步：WSL 会话把档案里的 distro/user 作为本次 spawn 的覆盖值，
		// 让 PiProcess 用正确发行版解析命令与路径；缺字段才回退全局设置。
		const wslSpawnOverride = sessionEnvironment === "wsl" && tab.wslDistro !== undefined && tab.wslUser !== undefined ? { wslEnabled: true, wslDistro: tab.wslDistro, wslUser: tab.wslUser } : undefined;
		this.agents.set(id, { tab, process: this.createPiProcess(project.path, input.sessionPath, input.deckSessionId, wslSpawnOverride, id) });
		this.messages.set(id, []);
		this.emitState();

		let handshake: CreateHandshake;
		try {
			handshake = await this.handshakePiProcess(id, {
				projectPath: project.path,
				sessionPath: input.sessionPath,
				deckSessionId: input.deckSessionId,
				trustOverride,
				noSession: input.noSession,
				onExit: (payload) => this.handleCreateProcessExit(id, tab, payload),
			});
		} catch (error) {
			// start() 同步失败（非法 cwd、spawn 抛错等）也要落到会话错误卡，而不是 IPC 裸抛。
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			const failedProcess = this.agents.get(id)?.process;
			void this.appLogger?.error("agent", "Agent pi process start threw", {
				agentId: id,
				projectId: project.id,
				sessionPath: input.sessionPath,
				error: rawMessage,
				diagnostics: failedProcess?.getDiagnostics(),
				platform: globalThis.process.platform,
				arch: globalThis.process.arch,
			});
			this.addLocalizedMessage(id, "error", "diagnostic.agentStartFailed", "Pi RPC 启动失败。", {
				debugDetails: this.buildStartupFailureMessage(rawMessage, failedProcess?.getDiagnostics() ?? null),
			});
			this.emitState();
			return tab;
		}
		const { process, fallbackFromExtensions } = handshake;
		const t3 = Date.now();
		const diag = process.getDiagnostics();
		void this.appLogger?.info("agent", "Pi process spawned", {
			agentId: id,
			prepareMs: t1 - t0,
			trustMs: t2 - t1,
			spawnCallMs: t3 - t2,
			command: diag?.command,
			args: diag?.args?.join(" "),
			cwd: diag?.cwd,
			fallbackFromExtensions,
		});

		try {
			void this.appLogger?.info("agent", "Agent get_state request completed", { agentId: id });
			const state = handshake.state;
			const t4 = Date.now();
			void this.appLogger?.info("agent", "Agent get_state completed", {
				agentId: id,
				stateMs: t4 - t3,
				totalSinceCreateMs: t4 - t0,
			});
			const data = state.data as { sessionId?: string; sessionFile?: string; sessionName?: string } | undefined;
			tab.sessionId = data?.sessionId;
			tab.sessionPath = this.reportSessionPathFromPi(data?.sessionFile ?? input.sessionPath, project.id, sessionEnvironment, project.path);
			const piSessionName = data?.sessionName && !looksLikePiSessionFileStem(data.sessionName) ? data.sessionName : undefined;
			tab.title = input.title || piSessionName || (input.sessionPath ? this.translate("session.historyTitle", { project: project.name }) : `${project.name} agent`);
			tab.status = "idle";
			// 历史一律从 JSONL 尾部读最近 N 轮，禁止 get_messages：
			// pi 会把整段历史打成单行 JSON，主进程 JSON.parse 会冻住窗口按钮。
			// Agent 可用只依赖 get_state；历史后台加载，加载期间新消息由 preserveMessagesAfter 保护。
			const historyLoadDecision = this.getHistoryAutoLoadDecision(tab.sessionPath);
			const preserveMessagesAfter = Date.now();
			this.startupDiagnostics.notifyExtensionsDisabled(id, {
				fallbackFromExtensions,
				debugDetails: handshake.fallbackDebug,
			});
			// 第三方接管型 MCP 扩展提醒（M5b）：异步、不 await，绝不阻塞 Agent 就绪。
			void this.notifyMcpThirdPartyTakeover(id, diag?.piVersion ?? null);
			// standby 的 sessionPath 是 pi 预分配的新文件（尚未落盘），当历史加载只会报假错误。
			if (tab.sessionPath && !tab.standby) {
				void this.loadMessages(id, true, this.readRecentMessagesFromSessionFile(tab.sessionPath, this.maxHistoryLoadTurns), { preserveMessagesAfter })
					.then(() => {
						void this.appLogger?.info("agent", "Agent recent history loaded from file", {
							agentId: id,
							sessionPath: tab.sessionPath,
							sizeBytes: historyLoadDecision.sizeBytes,
							totalMs: Date.now() - preserveMessagesAfter,
						});
					})
					.catch((error) => {
						const list = this.messages.get(id) ?? [];
						const loadingMessage = list.find((message) => message.meta?.historyLoading === true);
						if (loadingMessage) {
							loadingMessage.role = "error";
							loadingMessage.text = "历史会话加载失败，可继续使用当前 Agent 或重新打开会话重试。";
							loadingMessage.meta = {
								historyLoading: "failed",
								i18nKey: "diagnostic.historyLoadFailed",
								debugDetails: error instanceof Error ? error.message : String(error),
							};
							loadingMessage.timestamp = Date.now();
							this.scheduleMessageEmit(id, true);
						}
						void this.appLogger?.warn("agent", "Agent recent history file load failed", {
							agentId: id,
							sessionPath: tab.sessionPath,
							error: error instanceof Error ? error.message : String(error),
						});
					});
			}
			this.recordTiming("agent.create", t0, {
				agentId: id,
				historyLoading: "background",
				fallbackFromExtensions,
			});
			void this.appLogger?.info("agent", "Agent create completed", {
				agentId: id,
				totalMs: Date.now() - t0,
				historyLoading: "background",
				fallbackFromExtensions,
			});
		} catch (error) {
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			const failedProcess = this.agents.get(id)?.process;
			void this.appLogger?.error("agent", "Agent create failed", {
				agentId: id,
				projectId: project.id,
				sessionPath: input.sessionPath,
				error: rawMessage,
			});
			this.addLocalizedMessage(id, "error", "diagnostic.agentStartFailed", "Pi RPC 启动失败。", {
				debugDetails: this.buildStartupFailureMessage(rawMessage, failedProcess?.getDiagnostics() ?? null),
			});
		}

		this.emitState();
		return tab;
	}
}
