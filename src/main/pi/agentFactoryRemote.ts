import { randomUUID } from "node:crypto";
import type { AgentTab, CreateAgentInput, RemoteProject, SessionEnvironment } from "../../shared/types";
import { remotePiDiscoveryCopyKey } from "../remote/remotePiDiscoveryCopy";
import { remoteSessionCodeCopyKey } from "../remote/remoteSessionCopy";
import type { AgentSessionIdentityDefaults } from "./agentSessionIdentity";
import { looksLikePiSessionFileStem } from "./agentUtils";
import type { AgentFactoryHost, CreateHandshake } from "./agentFactoryHost";
import { PiProcess } from "./PiProcess";
import type { PiRuntimeLauncher, RemoteSshPiRuntimeLaunchPlan } from "./PiSpawnHandle";
import { REMOTE_RUNTIME_CODES } from "./remoteRuntimePort";

/**
 * 远端创建域（拆分第十刀 · remote 半边）：进程从哪里起来全部来自装配注入的远端运行时端口，
 * 本机专属步骤（project trust 预检、会话文件修复、路径归一化、历史读取）一律不参与。
 *
 * 本机行程由 `AgentFactoryLocal.createUnlocked` 判定 `isRemoteProject` 后转交这里，
 * 所以两条流水线的会话身份 key / 既有 runtime 复用 / tab / 事件桥 / 握手完全同源。
 */
export class AgentFactoryRemote {
	constructor(private readonly host: AgentFactoryHost) {}

	/** 域入口：`createRemoteUnlocked` 是 private（契约测试按该签名切片），跨文件调用只走这里。 */
	create(input: CreateAgentInput, project: RemoteProject): Promise<AgentTab> {
		return this.createRemoteUnlocked(input, project);
	}

	/** 宿主字段别名：搬出的实现保持 `this.<字段>` 原样（契约测试按此形态断言）。 */
	private get agents() {
		return this.host.agents;
	}

	private get messages() {
		return this.host.messages;
	}

	private get remoteLaunchByAgent() {
		return this.host.remoteLaunchByAgent;
	}

	private get appLogger() {
		return this.host.appLogger;
	}

	private get remoteRuntime() {
		return this.host.remoteRuntime;
	}

	private get securityStore() {
		return this.host.securityStore;
	}

	private get settingsStore() {
		return this.host.settingsStore;
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

	private get sessionKeyFor() {
		return this.host.sessionKeyFor;
	}

	private get onBeforeAgentSpawn() {
		return this.host.onBeforeAgentSpawn;
	}

	private get addLocalizedMessage() {
		return this.host.addLocalizedMessage;
	}

	private get buildStartupFailureMessage() {
		return this.host.buildStartupFailureMessage;
	}

	private get recordTiming() {
		return this.host.recordTiming;
	}

	private get notifyWhitelistSkipped() {
		return this.host.notifyWhitelistSkipped;
	}

	private get registerRemoteSessionIdentity() {
		return this.host.registerRemoteSessionIdentity;
	}

	private get emitState() {
		return this.host.emitState;
	}

	/**
	 * 远端项目的会话创建（Phase 4 P4.2 产品路由）。
	 *
	 * 与 `createUnlocked` 走**同一条**流水线（会话身份 key、既有 runtime 复用、tab、事件桥、
	 * agents.set、emitState、握手），分叉只有两处：
	 * 1. 「进程从哪里起来」：plan + launcher 全部来自装配注入的远端运行时端口；
	 * 2. 「哪些本机步骤不参与」：项目 trust 预检、会话文件修复、会话路径归一化、本地历史读取。
	 *
	 * 为什么第 2 条是硬要求：`locator.remotePath` 与 pi 报回来的会话文件都在那台机器上。把它们
	 * 当本机路径处理**不会报错**（stat 到本机同名路径，或 ENOENT 被吞掉），只会静默落到完全
	 * 不同的东西上 —— 这是 Phase 4 最贵的失败形态。
	 */
	private async createRemoteUnlocked(input: CreateAgentInput, project: RemoteProject): Promise<AgentTab> {
		const t0 = Date.now();
		// 端口缺省 = 正式包 / 未注入：远端项目在这里**没有**本机回退。用既有稳定码拒绝
		// （与「非本地项目不得当本机路径」同一个码：语义都是「这个位置在这里跑不了」）。
		if (!this.remoteRuntime) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		// 远端会话的 catalog 身份（P4.2 收口）：身份就在端口上（见 registerRemoteSession：scanner 的
		// 会话根解析 + `SessionCatalog.ensureRemoteSession` 这一条正门）。端口没有这个能力（旧装配 /
		// 测试替身）时与以前同一个稳定码 fail-closed——这条判据刻意留在 prepare 之前：能拒绝就不要
		// 先拉起一个远端进程，更不写一条带本机 filePath 的伪记录。
		if (input.deckSessionId && typeof this.remoteRuntime.registerRemoteSession !== "function") throw new Error(REMOTE_RUNTIME_CODES.catalogIdentityUnsupported);

		const hostId = project.locator.hostId;
		const remoteCwd = project.locator.remotePath;
		// 远端会话身份**不套 WSL**（见 sessionIdentityDefaultsFor）；create() 已对远端输入归一化，
		// 这里再钉一次，保证 tab 字段与身份 key 同源。
		const sessionIdentityDefaults: AgentSessionIdentityDefaults = { environment: "native" };
		const sessionEnvironment: SessionEnvironment = "native";
		const id = randomUUID();
		void this.appLogger?.info("agent", "Agent create requested", {
			agentId: id,
			projectId: input.projectId,
			hostId,
			remoteCwd,
			sessionPath: input.sessionPath,
			title: input.title,
			location: "remote",
		});
		const existingForSessionKey = this.sessionKeyFor({ ...input, environment: sessionEnvironment, wslDistro: undefined, wslUser: undefined }, sessionIdentityDefaults);
		const existingForSession = existingForSessionKey ? this.findRuntimeBySessionKey(existingForSessionKey) : undefined;
		if (existingForSession) {
			void this.appLogger?.info("agent", "Agent create reused existing session", {
				agentId: existingForSession.tab.id,
				hostId,
				sessionPath: input.sessionPath,
			});
			return existingForSession.tab;
		}

		const tab: AgentTab = {
			id,
			projectId: project.id,
			// 远端项目根：任何本机消费者（git/终端/会话文件读写）必须先过 isRemoteRuntime/isLocalProject。
			cwd: remoteCwd,
			title: input.title || `${project.name} agent`,
			status: "starting",
			deckSessionId: input.deckSessionId,
			sessionPath: input.sessionPath,
			sessionEnvironment,
			sessionSource: input.source ?? "pi",
			// 这条路径的 runtimePlan.kind 恒为 "remote-ssh"（launch.plan 由 buildRemotePiRuntimePlan 构造）。
			// 本字段（P4.2 起的字段名）现在只表示「这条会话的远端项目 trust 由 PiDeck 的决策表管理」，
			// 因此是渲染层「要不要显示 trust 条」的判据；四种展示态由决策表合成。
			// 具体传什么 flag 不在这里决定：远端运行时端口每次 prepare 现读决策（P4.4b），未决策就一个都不传。
			// 本机/WSL 分支不写这个字段。
			remoteTrustUnhandled: true,
			// 不写 wslDistro/wslUser/importedSourceId：它们是本机（WSL/导入器）身份，远端会话没有这些维度。
			noSession: input.noSession,
			createdAt: Date.now(),
		};

		const t1 = Date.now();
		let launch: { plan: RemoteSshPiRuntimeLaunchPlan; launcher: PiRuntimeLauncher };
		try {
			// 远端安全门读的是快照文件：先把本机快照落盘（幂等），否则首次 spawn 会因「读不到字节」
			// 把安全门从注入面拿掉（安全等级随后失效，但 UI 会如实隐藏）。
			await this.securityStore?.ensureSnapshotWritten();
			// 远端事实（解释器 / pi 入口 / runner 路径）先取，再在构造点验 plan 形状：
			// 门禁关闭/服务没建起来 → REMOTE_RUNTIME_UNAVAILABLE；主机没就绪 → SSH_HOST_NOT_READY；
			// pi 探测失败 → REMOTE_PI_*；本机路径混进 plan → REMOTE_RUNTIME_PATH_INVALID。
			const prepared = await this.remoteRuntime.prepare({
				hostId,
				remoteCwd,
				...(input.sessionPath === undefined ? {} : { sessionFile: input.sessionPath }),
				...(input.noSession ? { noSession: true } : {}),
				// 与本地 `securitySessionId: securitySessionKey ?? sessionPath` 同一取值：扩展只用它查
				// sessionLevels 字典，从不 fs 打开；远端历史会话没有 deckSessionId 时用远端会话文件路径。
				...(input.deckSessionId === undefined && input.sessionPath === undefined ? {} : { sessionId: input.deckSessionId ?? input.sessionPath }),
			});
			const { plan } = prepared;
			// 注入面跟着 tab 走（agents:state → 渲染层能力门）：UI 只认“实际注入了什么”，不认“应该能”。
			tab.remoteExtensions = prepared.extensions;
			launch = { plan, launcher: this.remoteRuntime.createLauncher() };
			// 远端 plan 的 args 是「这次到底用什么会话文件起的 pi」的唯一权威记录（runner 的 plan 走 stdin，
			// lease 里也没有 argv）——排「重启后是否真的接回同一会话」这类问题时，只看 app 日志就能定案。
			void this.appLogger?.info("agent", "Remote pi runtime plan prepared", { agentId: id, hostId, args: plan.args.join(" "), extensions: prepared.extensions.applied.join(",") || prepared.extensions.reason || "none" });
		} catch (error) {
			// 准备失败走**与本地「pi 起不来」同一条**错误卡路径：调用方（协调器/渲染层）看到的是会话
			// 启动失败 + 稳定码，而不是「会话正常起来了但什么都没发生」——更绝不允许回退本机 pi。
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("agent", "Remote agent prepare failed", {
				agentId: id,
				projectId: project.id,
				hostId,
				remoteCwd,
				error: rawMessage,
			});
			// 诊断占位进程：这一步没有任何可运行的远端计划（这正是失败原因），所以它只是一个**错误卡宿主**
			// ——不注入任何本地专属准备、从未也绝不会被 start()（见 spawnAndGetState 的远端守卫）。
			this.agents.set(id, { tab, process: new PiProcess(remoteCwd, this.settingsStore.get()) });
			this.messages.set(id, []);
			// 远端环境没准备好（pi/node/shell PATH 三类）时说清具体原因与下一步，而不是只丢一个稳定码。
			const discoveryKey = remotePiDiscoveryCopyKey(rawMessage) ?? remoteSessionCodeCopyKey(rawMessage);
			this.addLocalizedMessage(id, "error", discoveryKey ?? "diagnostic.agentStartFailed", discoveryKey ? this.translate(discoveryKey) : "Pi RPC 启动失败。", {
				debugDetails: this.buildStartupFailureMessage(rawMessage, null),
			});
			this.emitState();
			return tab;
		}
		this.remoteLaunchByAgent.set(id, launch);
		const t2 = Date.now();

		void this.appLogger?.info("agent", "Agent pi process start", { agentId: id, location: "remote", hostId });
		// 与本地一致：spawn 前异步刷新模型列表缓存。它是本机 pi 目录的刷新，不吃本次的远端 cwd；
		// 远端 pi 自己的模型目录属 P4.3。
		this.onBeforeAgentSpawn?.();
		this.agents.set(id, { tab, process: this.createPiProcess(remoteCwd, input.sessionPath, undefined, undefined, id, launch) });
		this.messages.set(id, []);
		this.emitState();

		let handshake: CreateHandshake;
		try {
			handshake = await this.handshakePiProcess(id, {
				// 远端项目根：`projectPath` 的消费者只有日志与生命周期事件归属，不是本机文件路径。
				projectPath: remoteCwd,
				sessionPath: input.sessionPath,
				deckSessionId: input.deckSessionId,
				// 远端 trust 不在这里传（也不再需要本机那套 override 参数）：决策由远端运行时端口在
				// prepare 时按 trust key 现读，未决策 ⇒ plan 里不出现任何 trust flag。
				noSession: input.noSession,
				onExit: (payload) => this.handleCreateProcessExit(id, tab, payload),
			});
		} catch (error) {
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			const failedProcess = this.agents.get(id)?.process;
			void this.appLogger?.error("agent", "Agent pi process start threw", {
				agentId: id,
				projectId: project.id,
				hostId,
				remoteCwd,
				error: rawMessage,
				diagnostics: failedProcess?.getDiagnostics(),
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
			location: "remote",
			hostId,
			prepareMs: t1 - t0,
			launchPrepareMs: t2 - t1,
			spawnCallMs: t3 - t2,
			command: diag?.command,
			args: diag?.args?.join(" "),
			cwd: diag?.cwd,
			fallbackFromExtensions,
		});
		// 白名单因条数过多被跳过：远端 plan 不带白名单注入，所以这里只做形状对齐（当前恒空）。
		if (diag?.whitelistSkipped && diag.whitelistSkipped.length > 0) {
			this.notifyWhitelistSkipped(id, diag.whitelistSkipped);
		}

		try {
			void this.appLogger?.info("agent", "Agent get_state request completed", { agentId: id, location: "remote" });
			const state = handshake.state;
			const t4 = Date.now();
			void this.appLogger?.info("agent", "Agent get_state completed", {
				agentId: id,
				stateMs: t4 - t3,
				totalSinceCreateMs: t4 - t0,
			});
			const data = state.data as { sessionId?: string; sessionFile?: string; sessionName?: string } | undefined;
			tab.sessionId = data?.sessionId;
			// pi 报回来的会话文件在远端：只做 POSIX 归一化（相对 sessionDir 会被 pi 报成相对 cwd），
			// 绝不用本机规则。它既是下一次 spawn（restart）的 `--session <远端路径>`，也是 catalog
			// 身份的 remotePath —— 两种用途都要求绝对形状。
			tab.sessionPath = this.reportSessionPathFromPi(data?.sessionFile ?? input.sessionPath, tab.projectId, sessionEnvironment, remoteCwd);
			// catalog 身份登记（P4.2 收口）：会话文件是 pi 自己选好并在握手 `get_state` 里上报的，
			// PiDeck 创建之前根本不知道它叫什么 —— 所以登记必然晚于 runtime 起来，**这是与本地流程的
			// 本质差别**（本地会话身份在创建之前就由 catalog 定好）。
			if (input.deckSessionId && tab.sessionPath) {
				const registration = await this.registerRemoteSessionIdentity(project, tab.sessionPath);
				const locator = registration.record.locator;
				// record 就是这条远端会话的 catalog 身份；tab 仍说「远端路径」这一种语言
				// （ssh locator 的 remotePath），不因登记退化成一条本机 filePath。
				if (locator?.kind === "ssh") tab.sessionPath = locator.remotePath;
			}
			const piSessionName = data?.sessionName && !looksLikePiSessionFileStem(data.sessionName) ? data.sessionName : undefined;
			tab.title = input.title || piSessionName || (input.sessionPath ? this.translate("session.historyTitle", { project: project.name }) : `${project.name} agent`);
			tab.status = "idle";
			// 远端历史不在本机（本批）：**不加载**。本机 reader 读不到远端文件；pi 的 get_messages
			// 会把整段历史打成单行 JSON 冻住主进程（见 loadMessages 的注释），也不是退路。
			// 远端历史窗口读取属下一批（`RemoteWorkspaceReader` 有界窗口）。
			this.recordTiming("agent.create", t0, {
				agentId: id,
				location: "remote",
				historyLoading: "unsupported",
				fallbackFromExtensions,
			});
			void this.appLogger?.info("agent", "Agent create completed", {
				agentId: id,
				hostId,
				totalMs: Date.now() - t0,
				historyLoading: "unsupported",
				fallbackFromExtensions,
			});
		} catch (error) {
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			const failedProcess = this.agents.get(id)?.process;
			void this.appLogger?.error("agent", "Agent create failed", {
				agentId: id,
				projectId: project.id,
				hostId,
				sessionPath: input.sessionPath,
				error: rawMessage,
			});
			// 身份登记失败（REMOTE_SESSION_LOCATOR_UNRESOLVED 等）也是「远端起不来」：给可读文案，
			// 否则用户只能看到稳定码，根本不知道是远端 pi 的会话目录配置问题。
			const createKey = remoteSessionCodeCopyKey(rawMessage);
			this.addLocalizedMessage(id, "error", createKey ?? "diagnostic.agentStartFailed", createKey ? this.translate(createKey) : "Pi RPC 启动失败。", {
				debugDetails: this.buildStartupFailureMessage(rawMessage, failedProcess?.getDiagnostics() ?? null),
			});
		}

		this.emitState();
		return tab;
	}
}
