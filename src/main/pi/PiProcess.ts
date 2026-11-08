import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PiRpcClient } from "./PiRpcClient";
import { basePiRpcArgs } from "./piRpcArgs";
import { LocalPiRuntimeLauncher } from "./LocalPiRuntimeLauncher";
import type { PiRuntimeLauncher, PiRuntimeLaunchPlan, PiSpawnHandle, RemoteSshPiRuntimeLaunchPlan } from "./PiSpawnHandle";
import { PiLocator } from "./PiLocator";
import { createSpawnFailureError } from "./piSpawnFailure";
import { parkBlockedExtensionsInDir, unparkBlockedExtensions, type ParkedExtension } from "./piExtensionFilter";
import type { AppSettings } from "../../shared/types";
import type { SessionProxyMode } from "../../shared/types/session";
import { toWindowsHostPath, toWslLinuxPath } from "../wsl/WslPaths";
import { appendBuiltInExtensionArgs } from "../extensions/builtInExtensions";
import { getAppLogger } from "../logging/sharedLogger";
import { applyPiProxyMode } from "../sessions/sessionProxyPolicy";
import { parsePiVersion, piVersionAtLeast } from "../extensions/extensionVersionGate";

type PiProcessSettings = Pick<
	AppSettings,
	"piProxyEnabled" | "piProxyUrl" | "piProxyBypass" | "customPiPath" | "wslEnabled" | "wslDistro" | "wslUser" | "piRpcOffline" | "piRpcNoExtensions" | "piRpcNoSkills" | "removedBuiltInExtensions" | "disabledExtensions" | "disabledSkills" | "disabledPrompts" | "autoSessionTitle"
>;

type PiProcessLocator = Pick<PiLocator, "resolveCommand" | "createInvocation" | "createProcessEnv" | "resolveArgCharBudget"> & Partial<Pick<PiLocator, "warmWslCommand">>;

/**
 * 共享的本地启动器（无状态）。注入面只用于远端会话（P4.2）与测试：
 * 不注入时一切行为与抽取前一致——spawn 选项、停止顺序、退出上报都在 LocalPiRuntimeLauncher 内。
 */
const defaultLocalPiRuntimeLauncher: PiRuntimeLauncher = new LocalPiRuntimeLauncher();

/** 可选：覆盖扩展扫描用的用户 home（WSL 映射 Windows home 时传入）。 */
type PiProcessOptions = {
	agentHomeDir?: string;
	/**
	 * 运行时启动面（Phase 4 P4.0）。缺省 = 本地启动器：spawn/停止/退出上报的语义与抽取前逐字一致。
	 * 远端会话（P4.2）由 coordinator 注入远端 launcher，PiProcess 本身不判断位置类型。
	 */
	runtimeLauncher?: PiRuntimeLauncher;
	/**
	 * 远端运行时计划（P4.2）。给了它就是「这条 runtime 跑在远端」：参数与 cwd 全部来自 plan，
	 * 本地专属准备一律不参与（见 `startRemoteRuntime`）。它必须与 `runtimeLauncher` 一起注入——
	 * 本地启动器收到远端 plan 会直接拒（`PI_RUNTIME_LAUNCH_PLAN_INVALID`），不会静默降级。
	 *
	 * 注意：远端模式下 `start(sessionPath, trustOverride)` 的这两个参数不适用——会话文件要写进 plan 的
	 * `args`（`--session <远端路径>`），远端 trust 语义属 P4.4（本批不代替实现）。
	 */
	runtimePlan?: PiRuntimeLaunchPlan;
	/**
	 * 解析当前应通过 -e 注入的 PiDeck 内置扩展绝对路径。
	 * 未提供时 RPC 不注入内置扩展（兼容测试/探针）。
	 */
	resolveBuiltInExtensionPaths?: (settings?: PiProcessSettings, includeProjectResources?: boolean) => string[];
	/**
	 * PiDeck 内置技能目录（每个元素是含 SKILL.md 的技能目录），以 --skill 显式注入。
	 *
	 * 为什么不用 pi 的自动发现目录：~/.pi/agent/skills 是 TUI 与 PiDeck 共用的，
	 * 桌面端专用技能落在那里会被终端里的 pi 也加载。--skill 只影响本进程，
	 * 由 AgentManager 按当前开关解析后传入；未提供 = 不注入（测试/探针/模型快照）。
	 */
	bundledSkillPaths?: string[];
	/**
	 * 安全策略快照路径（userData/security-policy.json）。
	 * 注入 PIDECK_SECURITY_CONFIG 环境变量，pi-deck-security-gate 扩展据此加载规则。
	 */
	securitySnapshotPath?: string;
	/**
	 * 会话身份（会话文件路径 = SessionRecord.id）。
	 * 注入 PIDECK_SESSION_ID 环境变量，扩展按它解析会话级等级覆盖。
	 */
	securitySessionId?: string;
	/**
	 * 当前会话是否已绑定飞书（PIDECK_FEISHU_LINKED=1）。
	 * pi-deck-ask-question 扩展据此把 ask_question 换成禁用提示版：
	 * 飞书端交互卡片体验差（按钮截断/选项上限），agent 应把问题直接写进回复。
	 * 进程级标记，绑定发生在 runtime 启动前（FeishuBridge 先建 binding 再 activateRuntime），
	 * 因此 spawn 时判断可靠；绑定后已运行的会话需重启才生效（解绑后同样持续到重启）。
	 */
	feishuLinked?: boolean;
	/**
	 * 会话级代理覆盖（单会话开关）：on = 强制启用（复用全局 piProxyUrl），
	 * off = 强制直连；缺省/follow = 跟随全局设置。仅在本进程 spawn 时生效。
	 */
	proxyOverride?: SessionProxyMode;
	/**
	 * 模型请求快照的环境变量（`PIDECK_MODEL_TRACE_URL` / `PIDECK_MODEL_TRACE_TOKEN`）。
	 *
	 * 由 AgentManager 在 spawn 前从 ModelTraceServer 取（每 agent 一份 token）。
	 * 缺省表示端点不可用 —— 扩展会静默不工作，pi 行为不变。
	 */
	modelTraceEnv?: Record<string, string>;
	/**
	 * 关联会话端点的环境变量（`PIDECK_LINKED_SESSIONS_URL` / `PIDECK_LINKED_SESSIONS_TOKEN`，docs/host-boundaries.md 例外九）。
	 * 缺省表示端点不可用 —— `pi-deck-linked-sessions` 扩展不注册工具。
	 */
	linkedSessionsEnv?: Record<string, string>;
	/**
	 * spawn pi 前对会话文件的预检/修复回调（如剔除旧版 PiDeck 私有 sessionName 头行，
	 * 该行会让 pi 报 "Session file is not a valid pi session" 并 exit 1）。
	 * 返回是否发生修复；抛错或未注入都不阻塞启动（pi 自身的加载错误更接近事实，留日志即可）。
	 */
	repairSessionFileBeforeStart?: (sessionPath: string) => Promise<boolean>;
};

/** 估算一组参数占用的命令行字符数（含分隔空格；路径带空格时 spawn 会补引号，一并留余量）。 */
function estimateArgChars(args: readonly string[]): number {
	let total = 0;
	for (const arg of args) total += arg.length + 1 + (arg.includes(" ") ? 2 : 0);
	return total;
}

/**
 * 取工作目录的客观状态。
 *
 * 只用于「spawn 失败后还原真实原因」（见 piSpawnFailure），绝不据此拦截启动：
 * WSL 的 \\wsl$\... 宿主路径在 Windows 侧 stat 可能失败，但 spawn 是正常的。
 */
function readCwdState(cwd: string): { exists: boolean; isDirectory: boolean } {
	try {
		return { exists: true, isDirectory: statSync(cwd).isDirectory() };
	} catch {
		return { exists: false, isDirectory: false };
	}
}

/**
 * 取错误消息（跨 realm 安全）：vm/worker 里创建的错误对象不满足 `instanceof Error`，但同样带 message，
 * 所以按属性取而不是按原型判——否则远端路径上的错误会被降级成 `Error: <码>` 这种带前缀的字符串，
 * 而诊断层只承认「消息即稳定码」。
 */
function errorMessage(error: unknown): string {
	if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
	return String(error);
}

type VersionCacheEntry = { status: "pending"; promise: Promise<boolean> } | { status: "done"; ok: boolean; version: string | null };

/**
 * 白名单注入因超出命令行预算被整体跳过时，留给启动诊断的信息。
 *
 * dev 已把启用/停用改为 pi 原生过滤规则（PiDeck 不再自己枚举白名单），本地与远端启动都不再产生
 * 该字段；但 AgentManager 的启动诊断仍按此形状读取（保留导出与 diagnostics 字段，当前恒为空）。
 */
export type WhitelistSkip = {
	kind: "extensions" | "skills" | "prompts";
	/** 被跳过的条数（用户关心的是「多少个」）。 */
	count: number;
	/** 注入后的整条命令行估算字符数（含已有参数），可直接与 budget 比较。 */
	chars: number;
	/** 本次注入自身占用的估算字符数，用来说明「谁是撑爆预算的大头」。 */
	injected: number;
	budget: number;
};

export class PiProcess extends EventEmitter {
	/** 运行时进程句柄（本地 = spawn 的包裹；远端 = pinned ssh + runner，P4.2）。 */
	private handle?: PiSpawnHandle;
	private readonly runtimeLauncher: PiRuntimeLauncher;
	private rpc?: PiRpcClient;
	/** 从 --version 归一化出的完整版本串（如 "0.85.0" / "1.0.0"），用于启动诊断与各版本门槛比较。 */
	private piVersion: string | null = null;
	/**
	 * pi --version 只用于启动失败后的诊断，不应阻塞真正的 RPC 进程启动。
	 * 按 command 路径缓存结果，避免连续打开多个 Agent 时重复启动 Node shim。
	 */
	private static readonly versionCache = new Map<string, VersionCacheEntry>();

	/**
	 * 失效跨进程版本缓存（`pi update` 自更新后调用）：旧版本的门槛判断
	 * （信任标志、白名单门等）对新版本毫无意义，必须重新探测。
	 */
	static invalidateVersionCache(): void {
		PiProcess.versionCache.clear();
	}

	/**
	 * --approve/--no-approve 信任标志在 pi 0.79.0 引入。
	 * 完整 semver 比较：0.79+ 与 1.x+ 均支持；版本未知/探测失败时保守判不支持。
	 */
	private static versionSupportsTrustFlags(piVersion: string | null): boolean {
		return piVersionAtLeast(piVersion, "0.79.0");
	}

	/**
	 * 应用启动时预热 pi --version 缓存，避免首次创建 Agent（尤其 trust 路径）同步等待版本检测。
	 * 失败不抛错：仅影响缓存命中与诊断字段，不阻塞主流程。
	 */
	static async warmVersionCache(settings?: PiProcessSettings, locator: PiProcessLocator = new PiLocator()): Promise<boolean> {
		// WSL which 必须先异步预热，否则 resolveCommand 只能回退 Windows "pi"。
		if (settings?.wslEnabled && settings.wslDistro && settings.wslUser) {
			await locator.warmWslCommand?.(settings.wslDistro, settings.wslUser);
		}
		const command = locator.resolveCommand(settings?.customPiPath, settings?.wslEnabled, settings?.wslDistro, settings?.wslUser);
		// 复用实例方法的缓存逻辑：构造临时实例只为调用 ensureVersionCheck。
		const probe = new PiProcess(process.cwd(), settings, locator);
		return probe.ensureVersionCheck(command);
	}

	/** 启动失败 / 异常退出时的诊断信息 */
	private diagnostics: {
		command: string;
		args: string[];
		cwd: string;
		stderr: string[];
		exitCode: number | null;
		exitSignal: string | null;
		customPiPath: string | undefined;
		versionCheck: boolean;
		/** 版本检测是否真的跑完过（false 时 versionCheck=false 只表示「还没探过」，不是失败）。 */
		versionCheckProbed?: boolean;
		/**
		 * spawn 阶段就失败（Node 只发 error、不发 exit，pid 从未拿到）。
		 * 与「进程起来了又退出」严格区分：前者一定与扩展无关，回退禁用扩展没有意义。
		 */
		spawnFailed?: boolean;
		cwdMissing?: boolean;
		/**
		 * Windows 启动通道：node 直启（.cmd 垫片已还原成 node + JS 入口）或 cmd.exe 回退 + 原因。
		 * 这条以前是静默的，用户看到命令行里有 cmd.exe 会以为「改 node 启动没生效」。
		 */
		launch?: { channel: "node-direct" | "cmd-shim"; reason?: string; entry?: string };
		/** 被桌面端 RPC 启动路径自动隔离的扩展名（如 codeisland） */
		blockedExtensions?: string[];
		/** 白名单因超预算被跳过（dev 的原始过滤规则下恒为空，保留给 AgentManager 的诊断形状）。 */
		whitelistSkipped?: WhitelistSkip[];
		/** 从 pi --version 归一化的完整版本串（如 "0.99.1" / "1.0.0"）；探测失败/未探时 null。 */
		piVersion: string | null;
	} | null = null;

	constructor(
		private readonly cwd: string,
		private readonly settings?: PiProcessSettings,
		private readonly locator: PiProcessLocator = new PiLocator(),
		private readonly options: PiProcessOptions = {},
	) {
		super();
		this.runtimeLauncher = options.runtimeLauncher ?? defaultLocalPiRuntimeLauncher;
		// EventEmitter 在没有 listener 时 emit('error') 会变成未捕获异常并可能拖垮主进程。
		// AgentManager 在 await start() 之后才挂业务 error 监听，spawn 的 ENOENT 等错误
		// 往往在中间窗口异步到达。这里先挂一个诊断 sink，保证永远不会因 0 listener 崩进程；
		// 业务侧仍可再挂自己的 listener 做 UI 提示。
		this.on("error", (error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			// spawn 失败（ENOENT 等）在业务 listener 挂载前到达，双写日志文件避免启动失败无痕
			void getAppLogger()?.error("pi-process", "Spawn error (pre-listener sink)", { message });
			console.error("[PiProcess] child process error (pre-listener safe sink):", message);
		});
	}

	/** 返回诊断信息（进程启动失败或异常退出后调用） */
	getDiagnostics(): Readonly<{
		command: string;
		args: string[];
		cwd: string;
		stderr: string[];
		exitCode: number | null;
		exitSignal: string | null;
		customPiPath: string | undefined;
		versionCheck: boolean;
		/**
		 * 版本检测是否真的跑完过。
		 * versionCheck=false 有两种含义：探测失败（pi 不可用）或**还没探过**（未命中 --version 缓存）。
		 * 诊断卡不分青红皂白显示「✗ 失败」会把用户引去重装 pi，故单列一位。
		 */
		versionCheckProbed?: boolean;
		spawnFailed?: boolean;
		cwdMissing?: boolean;
		launch?: { channel: "node-direct" | "cmd-shim"; reason?: string; entry?: string };
		blockedExtensions?: string[];
		/** 白名单因超预算被跳过（dev 的原始过滤规则下恒为空，保留给 AgentManager 的诊断形状）。 */
		whitelistSkipped?: WhitelistSkip[];
		/** 从 pi --version 归一化的完整版本串（如 "0.99.1" / "1.0.0"）；探测失败/未探时 null。 */
		piVersion: string | null;
	}> | null {
		return this.diagnostics;
	}

	/** 本进程生命周期内临时停放的扩展，exit/stop 时还原。 */
	private parkedExtensions: ParkedExtension[] = [];

	/**
	 * 仅停放 codeisland 等黑名单文件，不碰 npm packages / 其它本地扩展。
	 * 拒绝项目 trust 时只允许访问全局目录，不能扫描或移动项目资源。
	 * 用户已开 piRpcNoExtensions 时无需停放（扩展本就不会加载）。
	 */
	private parkIncompatibleExtensions(includeProjectResources: boolean): string[] {
		if (this.settings?.piRpcNoExtensions) return [];
		const home = this.options.agentHomeDir?.trim() || homedir();
		const dirs = [join(home, ".pi", "agent", "extensions")];
		if (includeProjectResources) dirs.push(join(this.cwd, ".pi", "extensions"));
		const parked: ParkedExtension[] = [];
		for (const dir of dirs) {
			parked.push(...parkBlockedExtensionsInDir(dir));
		}
		this.parkedExtensions = parked;
		// 去重 basename 供诊断展示
		return [...new Set(parked.map((p) => p.name))];
	}

	/** 还原本进程停放的扩展；幂等，可多次调用。 */
	private restoreParkedExtensions(): void {
		if (this.parkedExtensions.length === 0) return;
		unparkBlockedExtensions(this.parkedExtensions);
		this.parkedExtensions = [];
	}

	async start(sessionPath?: string, trustOverride?: "approve" | "no-approve", noSession?: boolean) {
		if (this.handle) return this.rpc!;
		// 远端运行时（P4.2）：进程怎么起来、在哪起来与本地完全不同，但起来之后的 RPC/事件/退出语义完全
		// 一致——所以只在这里分叉，下面那条本地路径一字不改。
		if (this.options.runtimePlan?.kind === "remote-ssh") return await this.startRemoteRuntime(this.options.runtimePlan);

		// 预检会话文件：旧版 PiDeck 私有 sessionName 头行会让 pi 拒绝加载（exit 1）。
		// 修复失败不阻塞启动——pi 自身的报错会进入启动诊断，比静默吞掉更有价值。
		if (sessionPath && !noSession && this.options.repairSessionFileBeforeStart) {
			try {
				const repaired = await this.options.repairSessionFileBeforeStart(sessionPath);
				if (repaired) {
					void getAppLogger()?.warn("pi-process", "Repaired legacy sessionName header before spawn", {
						sessionPath,
					});
				}
			} catch (error) {
				void getAppLogger()?.warn("pi-process", "Session file preflight repair failed", {
					sessionPath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// 信任确认由桌面端 AgentManager.ensureProjectTrust 在启动 pi 前完成，不再静默 --approve。
		// pi 在 RPC 模式下 project_trust 事件 hasUI 恒为 false，故信任弹窗由桌面端自行处理。
		// 基础参数与远端运行时共用一份（`piRpcArgs.basePiRpcArgs`）：同一个 pi 不能有两套基础参数。
		const args = basePiRpcArgs(this.settings);

		// 诊断开关：坏扩展/技能有时会拖垮 RPC 初始化；用户可在开发设置临时关闭后重试。
		// piRpcNoExtensions（总开关）优先：关闭后连白名单注入也不做，保证诊断路径干净。
		// pi 0.99 起这个开关会连带关掉内置扩展（mcp / llama.cpp / codemode / tool-search），
		// 这恰好就是诊断语义——用户要的是「pi 一个扩展都不加载」；不要在此处用
		// `-e builtin:mcp` 把内置扩展带回来（那会让诊断不再干净），
		// 需要 MCP 能力时请关掉该开关。
		if (this.settings?.piRpcNoExtensions) args.push("--no-extensions");
		if (this.settings?.piRpcNoSkills) args.push("--no-skills");

		const includeProjectResources = trustOverride !== "no-approve";
		let blockedNames: string[] = [];
		let startupComplete = false;
		try {
			// 仅临时停放 codeisland 等黑名单扩展文件；拒绝 trust 时不得扫描或移动项目扩展。
			blockedNames = this.parkIncompatibleExtensions(includeProjectResources);
			if (blockedNames.length > 0) {
				// 黑名单扩展被停放属于启动诊断事件，同步写入日志文件便于排查 RPC 初始化失败
				void getAppLogger()?.warn("pi-process", "Desktop-incompatible extensions parked for RPC", {
					blocked: blockedNames.join(", "),
				});
				console.warn("[PiProcess] Desktop-incompatible extensions parked for RPC:", blockedNames.join(", "));
			}

			// PiDeck 自带扩展：从 app resources 以 -e 注入，不再复制到 ~/.pi/agent/extensions。
			// 普通资源的启用/停用由 pi 原生 `settings.json` 过滤规则决定（见执行计划 A4/A5），
			// PiDeck 不再用 `--no-extensions` + 全量 `-e` 白名单复刻 pi 的发现逻辑。
			const builtInPaths = this.options.resolveBuiltInExtensionPaths?.(this.settings, includeProjectResources) ?? [];
			const argsWithBuiltIns = appendBuiltInExtensionArgs(args, builtInPaths, {
				noExtensions: Boolean(this.settings?.piRpcNoExtensions),
			});
			if (builtInPaths.length > 0 && !this.settings?.piRpcNoExtensions) {
				void getAppLogger()?.info("pi-process", "Loading PiDeck built-in extensions via -e", {
					extensions: builtInPaths.map((path) => path.split(/[/\\]/).pop()).join(", "),
				});
				console.log("[PiProcess] Loading PiDeck built-in extensions via -e:", builtInPaths.map((path) => path.split(/[/\\]/).pop()).join(", "));
			}

			// 内置技能：--skill 显式注入，TUI 不扫这个目录，自然看不到。
			// --no-skills 是「一个技能都不加载」的诊断开关，但 pi 对显式 --skill 仍会加载，
			// 所以这里必须自己跳过，否则开关名不副实。
			const bundledSkillPaths = this.settings?.piRpcNoSkills ? [] : (this.options.bundledSkillPaths ?? []);
			for (const skillPath of bundledSkillPaths) argsWithBuiltIns.push("--skill", skillPath);
			// 后续信任标志 / session / WSL 路径改写都基于已含 -e / --skill 的参数列表
			let finalPiArgs = argsWithBuiltIns;
			if (noSession) finalPiArgs.push("--no-session");
			if (sessionPath) finalPiArgs.push("--session", sessionPath);

			// 用户手动指定的 pi 路径优先于自动检测，解决 npm global、nvm 等路径未在 PATH 中的问题。
			// spawn 前再预热一次 WSL which：启动窗口已显示时异步等待可接受，不能同步 which。
			if (this.settings?.wslEnabled && this.settings.wslDistro && this.settings.wslUser) {
				await this.locator.warmWslCommand?.(this.settings.wslDistro, this.settings.wslUser);
			}
			const command = this.locator.resolveCommand(this.settings?.customPiPath, this.settings?.wslEnabled, this.settings?.wslDistro, this.settings?.wslUser);

			// A denied trust decision must fail closed. Without a verified --no-approve flag, starting pi
			// would allow its normal project discovery to load code the user explicitly rejected.
			if (trustOverride) {
				await this.ensureVersionCheck(command);
				const cached = PiProcess.versionCache.get(command);
				const supportsTrustFlags = cached?.status === "done" && cached.ok && PiProcess.versionSupportsTrustFlags(cached.version);
				if (trustOverride === "no-approve" && !supportsTrustFlags) {
					this.restoreParkedExtensions();
					void getAppLogger()?.error("pi-process", "Cannot enforce denied project trust", {
						command,
						piVersion: cached?.status === "done" ? cached.version : null,
						versionCheck: cached?.status === "done" ? cached.ok : false,
					});
					throw new Error("Cannot start an untrusted project safely: pi 0.79.0 or newer is required and its version must be verifiable.");
				}
				if (supportsTrustFlags) finalPiArgs.push(trustOverride === "approve" ? "--approve" : "--no-approve");
				// Approving an old pi retains historical behavior; only denial requires a hard security guarantee.
			}

			let spawnCwd = this.cwd;
			let diagnosticCwd = this.cwd;
			let wslCwd: string | undefined;
			if (command.startsWith("wsl://")) {
				const distro = this.settings?.wslDistro;
				if (!distro) throw new Error("WSL distribution is unavailable for pi startup.");
				const environment = { distro };
				wslCwd = toWslLinuxPath(this.cwd, environment);
				spawnCwd = toWindowsHostPath(this.cwd, environment);
				diagnosticCwd = wslCwd;

				// WSL 下 session / -e 扩展 / --skill 技能路径都需转成 Linux 路径，
				// 否则 pi 在 distro 内打不开 Windows 路径。
				finalPiArgs = finalPiArgs.map((arg, index) => {
					const prev = finalPiArgs[index - 1];
					if (prev === "--session" || prev === "--extension" || prev === "-e" || prev === "--skill") {
						// 仅转换看起来像 Windows 绝对路径的参数，避免误伤相对路径/选项值
						if (/^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith("\\\\")) {
							return toWslLinuxPath(arg, environment);
						}
					}
					return arg;
				});
			}
			const invocation = this.locator.createInvocation(command, finalPiArgs, wslCwd ? { wslCwd } : undefined);
			const finalArgs = invocation.args;

			// 初始化诊断信息。信任场景的版本检测已在上方同步完成。
			// 非信任场景仍异步触发，不阻塞 RPC 启动。
			const cachedVersion = PiProcess.versionCache.get(command);
			this.piVersion = cachedVersion?.status === "done" ? cachedVersion.version : this.piVersion;
			this.diagnostics = {
				command: command,
				args: finalArgs,
				cwd: diagnosticCwd,
				stderr: [],
				exitCode: null,
				exitSignal: null,
				customPiPath: this.settings?.customPiPath,
				versionCheck: cachedVersion?.status === "done" ? cachedVersion.ok : false,
				// 与 versionCheck 一起记录：只有真的探过才配显示「✗ 失败」（见 getDiagnostics 注释）。
				versionCheckProbed: cachedVersion?.status === "done",
				launch: invocation.windowsLaunch,
				blockedExtensions: blockedNames.length > 0 ? blockedNames : undefined,
				piVersion: this.piVersion,
			};
			if (invocation.windowsLaunch?.channel === "cmd-shim" && invocation.windowsLaunch.reason) {
				// 显式记录回退原因：命令行里出现 cmd.exe 时，用户与支持人员都要能立刻知道为什么没走 node 直启。
				void getAppLogger()?.warn("pi-process", "Windows launch falls back to cmd.exe", {
					command,
					spawned: invocation.command,
					reason: invocation.windowsLaunch.reason,
				});
				console.warn(`[PiProcess] Windows launch falls back to cmd.exe: ${invocation.windowsLaunch.reason}`);
			}
			if (!trustOverride) {
				void this.ensureVersionCheck(command);
			}

			// 打印等效命令行，方便在终端重现排查（同时写入日志文件供事后审计）
			console.log("[PiProcess] spawn等效命令:", [invocation.command, ...finalArgs].map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "));
			console.log("[PiProcess] spawn参数:", JSON.stringify({ command: invocation.command, shell: invocation.shell, cwd: spawnCwd, wslCwd: diagnosticCwd, argsCount: finalArgs.length }));
			void getAppLogger()?.debug("pi-process", "Pi process spawn", {
				command: invocation.command,
				argsCount: finalArgs.length,
				cwd: spawnCwd,
				shell: invocation.shell,
			});

			// 安全管理：把策略快照路径 + 会话身份注入 pi 子进程环境。
			// - securitySnapshotPath 是真实 Windows 路径（扩展需 fs 读取），WSL 下必须转成 /mnt/c/...，
			//   否则 pi 在 distro 内打不开。
			// - securitySessionId 是不透明身份 key（SessionRecord.id：新会话为 UUID，历史会话为文件路径），
			//   扩展仅用它做 sessionLevels 字典查表，从不 fs 打开——任何模式都原样注入，绝不能做路径转换：
			//   UUID 既非 UNC/盘符/绝对 Linux 路径，喂给 toWslLinuxPath 会抛 INVALID_WSL_PATH，
			//   导致 WSL 下临时会话（deckSessionId=UUID、无 sessionPath 兜底）在 spawn 前就崩、起不来。
			// 会话级代理覆盖：先按单会话开关改写设置（on/off），再走 createProcessEnv 注入标准代理 env。
			const effectiveSettings = applyPiProxyMode(this.settings, this.options.proxyOverride);
			if (this.options.proxyOverride === "on" && this.settings && !this.settings.piProxyUrl.trim()) {
				// on 但全局 URL 为空：applyPiProxyEnv 会因空 URL 直接放行（直连），留日志便于排查。
				void getAppLogger()?.warn("pi-process", "Session proxy override 'on' but global proxy URL is empty: falling back to direct", {
					sessionKey: this.options.securitySessionId,
				});
			}
			const env = this.locator.createProcessEnv(effectiveSettings, invocation.pathPrefix, invocation.wsl);
			if (this.options.securitySnapshotPath) {
				env.PIDECK_SECURITY_CONFIG = command.startsWith("wsl://") ? toWslLinuxPath(this.options.securitySnapshotPath, { distro: this.settings?.wslDistro ?? "" }) : this.options.securitySnapshotPath;
			}
			if (this.options.securitySessionId) {
				env.PIDECK_SESSION_ID = this.options.securitySessionId;
			}
			// 飞书绑定会话：ask_question 换成禁用提示版（扩展读取此标记，纯标志位无需路径转换）
			if (this.options.feishuLinked) {
				env.PIDECK_FEISHU_LINKED = "1";
			}
			// 模型快照端点：注入本机 URL + 每次 spawn 独享的 token。
			// 端点不可用时 modelTraceEnv 为空 → 不注入 → 扩展静默不工作，pi 行为不变。
			if (this.options.modelTraceEnv) {
				for (const [key, value] of Object.entries(this.options.modelTraceEnv)) {
					if (value) env[key] = value;
				}
			}
			if (this.options.linkedSessionsEnv) {
				for (const [key, value] of Object.entries(this.options.linkedSessionsEnv)) {
					if (value) env[key] = value;
				}
			}
			// 会话自动标题由 PiDeck 内置扩展在 agent_settled 后独立调用模型；
			// 显式注入 0/1，避免继承宿主环境中的同名变量。设置变更对新建/重启 Agent 生效。
			env.PIDECK_AUTO_SESSION_TITLE = this.settings?.autoSessionTitle === false ? "0" : "1";

			// spawn 前记录工作目录事实，仅用于「失败后还原真实原因」：
			// Windows 下 cwd 无效会被 libuv 报成 "spawn <cmd.exe> ENOENT"（实测复现），
			// 不记下来就只能把这条误导性错误原样丢给用户。
			const cwdFact = readCwdState(spawnCwd);
			const isWslCommand = command.startsWith("wsl://");

			// 每个 agent 绑定独立 cwd，确保 pi 自己发现项目级 AGENTS.md、settings 和 session 分组。
			// 打包后的 Electron 不一定继承用户终端 PATH；这里补齐跨平台 Node 工具链常见 bin 目录，尽量让已安装 pi 的用户开箱即用。
			// Windows 下通过 PiLocator.createInvocation 显式包裹含空格的 npm shim 路径，避免 cmd 拆分路径导致 agent 启动失败。
			// spawn 本身很少同步抛错（ENOENT 等多半异步 error 事件），但 cwd 非法等仍可能同步失败，必须捕获。
			try {
				// spawn 选项（stdio / shell / detached 进程组 / windowsHide / verbatim args）与停止顺序都在
				// LocalPiRuntimeLauncher 内，与抽取前逐字一致；这里只给一个 plan。
				this.handle = await this.runtimeLauncher.launch({
					kind: "local",
					command: invocation.command,
					args: finalArgs,
					cwd: spawnCwd,
					env,
					shell: invocation.shell,
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				});
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				if (this.diagnostics) {
					this.diagnostics.stderr.push(err.message);
					this.diagnostics.exitCode = -1;
					// 同步失败同样属于「进程从未起来」：回退禁用扩展没有意义（见 spawnFailed）。
					this.diagnostics.spawnFailed = true;
				}
				// spawn 失败也要还原停放的扩展，避免 codeisland 永久消失。
				this.restoreParkedExtensions();
				// 同步失败也走 error 通道，让 AgentManager 能把诊断写到会话卡片而不是主进程崩掉。
				this.emit("error", err);
				throw err;
			}

			this.wireRuntime();

			// 立即绑定 error：不要等 AgentManager 挂业务监听。
			// macOS 上 pi 路径缺失/架构不匹配时，error 事件可能在 start() 返回后几毫秒就到。
			this.handle.onSpawnError((error) => {
				if (this.diagnostics) {
					this.diagnostics.stderr.push(error.message);
					// spawn 失败通常没有 exit code；用 -1 标记“未能真正拉起进程”。
					if (this.diagnostics.exitCode === null) this.diagnostics.exitCode = -1;
				}
				// 关键：spawn 失败在 Node 里**只有 error 事件、没有 exit 事件**（pid 从未拿到）。
				// 不在这里收尾的话：
				//   1) 挂起的 RPC 请求（启动握手的 get_state）只能等满 rpcTimeout —— 默认 10 分钟，
				//      用户体感就是「启动失败不报错、直接超时」；
				//   2) 已停放的黑名单扩展永不还原（exit 回调是唯一的还原点）；
				//   3) isRunning() 仍为 true，扩展回退策略会误判为「进程还活着，别动它」。
				const spawnFailed = this.handle?.pid === undefined;
				let surfaced: Error = error;
				if (spawnFailed) {
					// WSL 的工作目录在 distro 内，Windows 侧 stat 宿主路径（\\wsl$\...）不可靠：
					// 探不到时不能反过来说「目录不存在」，否则会把 wsl.exe 自身的问题误报成项目路径问题。
					const cwdFactForDiagnosis = isWslCommand ? { exists: true, isDirectory: true } : cwdFact;
					if (this.diagnostics) {
						this.diagnostics.spawnFailed = true;
						this.diagnostics.cwdMissing = !cwdFactForDiagnosis.exists || !cwdFactForDiagnosis.isDirectory;
					}
					const { error: described, described: hasReason } = createSpawnFailureError({
						error,
						spawnedCommand: invocation.command,
						piCommand: command,
						cwd: spawnCwd,
						cwdExists: cwdFactForDiagnosis.exists,
						cwdIsDirectory: cwdFactForDiagnosis.isDirectory,
						// WSL 的 pi 在 distro 内，Windows 侧 existsSync 只会返回 false，不能据此说路径失效。
						piCommandExists: isWslCommand ? true : existsSync(command),
						isWindows: process.platform === "win32",
					});
					if (hasReason) {
						// 归因成功时把可读原因补进 stderr 缓冲：诊断卡展示这条，原始 errno 文本仍保留可检索
						surfaced = described;
						if (this.diagnostics) this.diagnostics.stderr.push(described.message);
					}
					// 用同一个错误终结 client：启动握手的 pending 请求会立刻以此 reject，不再空等超时。
					this.rpc?.close(surfaced);
					this.restoreParkedExtensions();
					this.handle = undefined;
					this.rpc = undefined;
				}
				this.emit("error", surfaced);
			});
			startupComplete = true;
			return this.rpc!;
		} catch (error) {
			// Resolver/version/WSL preparation can fail after extensions were parked but before a
			// child exit handler owns restoration. Roll back this start attempt synchronously.
			if (!startupComplete) {
				const failedProcess = this.handle;
				this.handle = undefined;
				this.rpc = undefined;
				try {
					// stop() 在第一个 await 之前同步发出信号，与这里的原 kill() 同时序。
					void failedProcess?.stop("shutdown");
				} catch {
					// The process may already have exited; restoration remains required either way.
				}
				this.restoreParkedExtensions();
			}
			throw error;
		}
	}

	get client() {
		if (!this.rpc) throw new Error("pi process is not running");
		return this.rpc;
	}

	/**
	 * 子进程 pid；尚未 start 或已退出时为 undefined。
	 * 供进程监控（内存查询/指标展示）使用，不持有引用之外的生命周期语义。
	 */
	get pid(): number | undefined {
		return this.handle?.pid;
	}

	isRunning(): boolean {
		return this.handle !== undefined && this.rpc !== undefined;
	}

	stop() {
		if (!this.handle) {
			// 进程已不在仍可能残留停放态（例如 start 中途失败路径）。
			this.restoreParkedExtensions();
			return;
		}
		// 停止顺序（Windows：先 taskkill /T 整树再杀根；Unix：先 SIGTERM 再延迟对进程组 SIGKILL 兜底）
		// 已搬进 LocalPiRuntimeLauncher，与抽取前逐字一致。本地实现不使用 reason；远端 runner（P4.2）
		// 用它决定 lease 回收的措辞。真正还原在 exit 回调里做；此处不提前 unpark，避免与仍在退出的 pi 竞态。
		void this.handle.stop("shutdown");
	}

	/**
	 * 共用的运行时接线：RPC 客户端、事件转发、stderr 诊断、退出收尾。
	 *
	 * 本地与远端只在这之前不同（进程怎么起来），之后完全一致——这正是 P4.0 抽出启动面的目的。
	 * spawn 失败**不**在这里处理：本地那条在 `start()` 里就地归因（要引用本机路径事实），远端那条在
	 * `launch()` 里 reject。
	 */
	private wireRuntime(): void {
		const handle = this.handle;
		if (handle === undefined) throw new Error("PI_RUNTIME_HANDLE_MISSING");
		this.rpc = new PiRpcClient(handle.stdin, handle.stdout);

		this.rpc.on("event", (event) => this.emit("event", event));
		this.rpc.on("protocol-error", (line) => this.emit("protocol-error", line));
		// 转发 RPC 日志到 AgentManager，用于前端调试面板展示
		this.rpc.on("log", (entry) => this.emit("rpc-log", entry));

		handle.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			// 缓冲启动期 stderr（上限 8KB），供启动失败后诊断展示
			if (this.diagnostics) {
				this.diagnostics.stderr.push(text);
				const total = this.diagnostics.stderr.reduce((s, l) => s + l.length, 0);
				if (total > 8192) this.diagnostics.stderr = [this.diagnostics.stderr.join("").slice(-4096)];
			}
			// stderr 不属于 RPC 协议，单独暴露给 UI 的日志面板，避免污染 JSONL stdout。
			this.emit("stderr", text);
		});

		handle.onExit(({ code, signal }) => {
			// 退出时更新诊断信息
			if (this.diagnostics) {
				this.diagnostics.exitCode = code;
				this.diagnostics.exitSignal = signal;
			}
			// pi 退出后还原临时停放的扩展，保证 CLI 仍能加载 codeisland。
			this.restoreParkedExtensions();
			this.rpc?.close(new Error(`pi exited: code=${code ?? "null"}, signal=${signal ?? "null"}`));
			this.emit("exit", { code, signal });
			this.handle = undefined;
			this.rpc = undefined;
		});
	}

	/**
	 * 远端运行时（P4.2）：一条 pinned ssh + 冻结 runner，参数与 cwd 全部来自 plan（命令行里只有解释器
	 * 与 runner 两段，其余走握手帧）。
	 *
	 * **跳过**的本地专属准备（全都带本机语义，远端照做只会把错误归因到本机）：命令定位与版本探测、
	 * WSL 路径转换、扩展/技能/提示词白名单与停放扩展、`PIDECK_SECURITY_CONFIG` 指向的本机快照路径、
	 * trust flag（远端 trust 属 P4.4）、本机 cwd 校验与 spawn 失败归因。
	 *
	 * 失败只可能是 `launch()` 的 reject（远端没有「起来了一半」的中间态）：按本地同款方式写诊断并 emit
	 * error，让 AgentManager 能把诊断写到会话卡片上。
	 */
	private async startRemoteRuntime(plan: RemoteSshPiRuntimeLaunchPlan): Promise<PiRpcClient> {
		// 诊断对象与本地同形（UI 的诊断卡片按这些字段渲染）。远端本轮**不**跑本机版本探测；
		// 远端 pi 的版本由 P4.1 的探测给出（plan 构造时已经判过兼容窗口）。
		this.diagnostics = {
			command: plan.piPath,
			args: [...plan.args],
			cwd: plan.cwd,
			stderr: [],
			exitCode: null,
			exitSignal: null,
			customPiPath: this.settings?.customPiPath,
			versionCheck: false,
			versionCheckProbed: false,
			// 远端不跑本机版本探测（版本由 P4.1 探测给出），诊断里按未知记 null。
			piVersion: null,
		};
		void getAppLogger()?.debug("pi-process", "Remote pi runtime launch", { hostId: plan.hostId, cwd: plan.cwd, argsCount: plan.args.length });
		try {
			this.handle = await this.runtimeLauncher.launch(plan);
		} catch (error) {
			// 用 errorMessage 而不是 instanceof：launcher 可能来自另一个 realm，而诊断只承认「消息即稳定码」。
			const err = new Error(errorMessage(error));
			if (this.diagnostics) {
				this.diagnostics.stderr.push(err.message);
				// 与本地同款：用 -1 标记「未能真正拉起进程」。
				if (this.diagnostics.exitCode === null) this.diagnostics.exitCode = -1;
				this.diagnostics.spawnFailed = true;
			}
			this.emit("error", err);
			throw err;
		}
		this.wireRuntime();
		return this.rpc!;
	}

	/** 后台执行 pi --version：更新诊断缓存，但不阻塞 start()/spawn。 */
	private ensureVersionCheck(command: string): Promise<boolean> {
		const cached = PiProcess.versionCache.get(command);
		if (cached?.status === "done") {
			this.piVersion = cached.version;
			if (this.diagnostics?.command === command) {
				this.diagnostics.versionCheck = cached.ok;
				this.diagnostics.versionCheckProbed = true;
			}
			return Promise.resolve(cached.ok);
		}
		if (cached?.status === "pending") return cached.promise;

		const promise = new Promise<boolean>((resolve) => {
			const invocation = this.locator.createInvocation(command, ["--version"]);
			execFile(
				invocation.command,
				invocation.args,
				{
					encoding: "utf8" as const,
					timeout: 5_000,
					shell: false,
					// Windows：--version 检查同样经 cmd.exe 拉起，缺 windowsHide 会闪现控制台窗口。
					windowsHide: true,
					env: this.locator.createProcessEnv(this.settings, invocation.pathPrefix),
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout) => {
					const ok = !error;
					const version = ok ? parsePiVersion(stdout.trim()) : null;
					PiProcess.versionCache.set(command, { status: "done", ok, version });
					this.piVersion = version;
					if (this.diagnostics?.command === command) {
						this.diagnostics.versionCheck = ok;
						this.diagnostics.versionCheckProbed = true;
					}
					this.emit("version-check", { ok, version });
					resolve(ok);
				},
			);
		});
		PiProcess.versionCache.set(command, { status: "pending", promise });
		return promise;
	}
}
