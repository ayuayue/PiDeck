/**
 * 远端 pi 运行时端口（Phase 4 P4.2 产品路由）。
 *
 * 这里只有一件事：把「远端会话怎么起来」从 `AgentManager` 里**借出去**。AgentManager 需要知道
 * 的只有两句：给我一条远端启动计划，给我配对的启动器；至于事实怎么探测（远端解释器/pi 入口/
 * runner 路径）、ssh 怎么拉、握手怎么等，全部留在 `RemoteHostConnectionService` 那条已验证的
 * 通道里 —— 这正是「PiDeck 不复制 pi 行为、也不为访问 pi 开第二条通道」的落点。
 *
 * 为什么端口是「注入 + 缺省拒绝」而不是「AgentManager 里判断远端」：
 * - 正式包/未开启实验时**不存在**远端能力，端口也不会被注入。缺省路径必须是拒绝（见
 *   `createRemoteUnlocked`），而不是拿远端项目的 cwd 去起一个本机 pi —— 后者不会报错，
 *   只会 stat 到一个本机同名路径（或 ENOENT 被吞掉），用户看到的是「会话莫名其妙起来了」。
 * - 端口由装配处构造（`src/main/index.ts`）：门禁表达式与连接服务单例都只允许有一份。
 *
 * 本模块**不**碰本机路径：plan 里的每个路径都由 `buildRemotePiRuntimePlan` 在构造点按远端
 * 绝对 POSIX 形状验过（本机 Windows 路径、相对路径当场抛稳定码）。
 *
 * 远端项目 trust（P4.4b）：决策由装配注入的 `resolveTrust` 提供，**每次 prepare 现读**（撤销下一次
 * spawn 即生效，不需重启）；解析不出决策/材料缺失/解析失败一律按「未决策」处理 —— plan 里一个
 * trust flag 都不出现，远端行为与历史版本一致（远端 pi 是否加载项目 `.pi` 资源仍由它自己决定）。
 */
import { randomUUID } from "node:crypto";
import type { RemoteExtensionSnapshotFacts, RemotePiRuntimeFacts } from "../remote/RemoteHostConnectionService";
import { piVersionAtLeast } from "../extensions/extensionVersionGate";
import { listRemoteInjectableExtensionNames } from "../extensions/remoteExtensionSnapshot";
import type { RemoteSessionRegistration } from "../sessions/SessionCatalog";
// 会话根解析与文件名 stem 都从 scanner 转出：远端会话身份的两个既有判定（根在哪、暂定标题取什么）
// 只允许有一份实现。
import { createRemoteSessionScanner, REMOTE_SESSION_MAX_ID_LENGTH, REMOTE_SESSION_MAX_PATH_LENGTH, titleFromRemoteSessionId, type RemoteSessionCatalogPort, type RemoteSessionCommandTransportPort, type RemoteSessionScannerPort } from "../sessions/RemoteSessionScanner";
import type { PiRuntimeLauncher, RemoteSshPiRuntimeLaunchPlan } from "./PiSpawnHandle";
import { buildRemotePiRuntimePlan } from "./piRemoteRuntimePlan";
import { remoteSecurityPolicyPath } from "../remote/RemoteSecurityPolicyArtifact";
import type { PiRpcBaseArgsSettings, PiTrustOverride } from "./piRpcArgs";

/**
 * 远端运行时域的稳定码（消息即码：调用方（协调器/测试）按字符串判定，绝不按措辞）。
 *
 * 为什么不是 `REMOTE_FEATURE_DISABLED`（远端 IPC 通道回答「门禁没开」的那个码）：会话链路里
 * 「拿不到服务」有三种来源，调用方无法区分——远端能力关闭、装配还没跑到（本服务是懒建单例）、
 * 服务建造失败（ssh 客户端发现等）。前两种恰好是同一个「不可用」，第三种还要带上自己的原因，
 * 所以会话链路用一个更宽的 `unavailable`，而不是把「连不上/没建好」误报成「功能没开」。
 * **门禁位置不变**：仍只由 `registerIpc` 里的单一发布策略 `REMOTE_FEATURE_AVAILABLE` 裁定，
 * 本模块不自己读环境变量（读第二处迟早会与它漂移）。
 */
export const REMOTE_RUNTIME_CODES = {
	/** 连接服务拿不到（门禁关闭 / 尚未装配 / 建造失败）：远端运行时不可用（**不**回退本机）。 */
	unavailable: "REMOTE_RUNTIME_UNAVAILABLE",
	/** `createLauncher()` 在 `prepare()` 之前被调用（端口契约错用）。 */
	launcherUnprepared: "REMOTE_RUNTIME_LAUNCHER_UNPREPARED",
	/**
	 * 远端会话属于一条 catalog 记录，而当前端口没有登记能力（旧装配 / 测试替身）。
	 *
	 * 语义收窄记录（P4.2 收口）：以前这条码表示「远端身份在本批无法表达成 ssh locator」，现在 ssh
	 * locator 已能从 pi 上报的会话文件折出来；只剩「端口不提供这条正门」时仍 fail-closed ——
	 * 绝不拿一条带本机 filePath 的伪记录顶上。
	 */
	catalogIdentityUnsupported: "REMOTE_SESSION_CATALOG_IDENTITY_UNSUPPORTED",
	/**
	 * pi 上报的会话文件折不成「会话根之下的 POSIX 相对路径」（非绝对 / 含 `..` 或控制字节 / 落在根外）。
	 * 拿不到可信的远端身份就拒绝登记：猜一个 id 写进 catalog 比失败更难查（下次扫描会另立一条记录）。
	 */
	locatorUnresolved: "REMOTE_SESSION_LOCATOR_UNRESOLVED",
	/** 本地专属操作（本机 fs/git/终端 cwd/会话文件读写）被要求对远端运行时执行。 */
	localOperationUnsupported: "REMOTE_RUNTIME_LOCAL_OPERATION_UNSUPPORTED",
} as const;

/** 远端注入内置扩展所需的最低 pi 版本（扩展按 1.x 事件面编写，0.85–0.99 不注入）。 */
export const REMOTE_EXTENSIONS_MIN_PI_VERSION = "1.0.0";

/** 未注入时给 UI / 日志的闭集原因（消息即码）。 */
export type RemoteRuntimeExtensionReason = "REMOTE_PI_EXTENSIONS_UNSUPPORTED" | "REMOTE_EXTENSIONS_UNAVAILABLE" | "REMOTE_EXTENSIONS_DISABLED" | "REMOTE_EXTENSIONS_NONE";

/** 本次运行实际注入的内置扩展（basename，顺序即 `-e` 顺序）；未注入时只给闭集原因。 */
export type RemoteRuntimeExtensions = {
	readonly applied: readonly string[];
	readonly reason?: RemoteRuntimeExtensionReason;
	/** 诊断用的底层稳定码（不直接上 UI；仅在 reason 为 unavailable 时有值）。 */
	readonly detail?: string;
};

/** `prepare()` 的完整结果：启动计划 + 本次注入面（UI 的能力门只认 `applied`，不认“应该能”）。 */
export type RemoteRuntimePrepareResult = {
	readonly plan: RemoteSshPiRuntimeLaunchPlan;
	readonly extensions: RemoteRuntimeExtensions;
};

/** 启动准备入参：远端主机 + 远端工作目录 + 可选的「重开同一会话」。 */
export type RemoteRuntimePrepareInput = {
	readonly hostId: string;
	/** 远端项目根（canonical 远端绝对 POSIX；本机路径在这里是错误输入）。 */
	readonly remoteCwd: string;
	/** 「重开同一会话」时带上的远端会话文件（pi 自己报回来的那条远端路径）。 */
	readonly sessionFile?: string;
	/** 匿名会话：远端 pi 不落会话文件（与本地 `PiProcess.start` 追加 `--no-session` 同一语义）。 */
	readonly noSession?: boolean;
	/** PiDeck 会话 key（`SessionRecord.id`）：安全等级快照按它查表，必须与本地 `securitySessionKey` 同源。 */
	readonly sessionId?: string;
};

/**
 * 登记一条远端会话的 catalog 身份（Phase 4 P4.2 收口）。
 *
 * 入参只有 pi 上报回来的**远端绝对路径**：`remoteSessionId`（相对会话根的 POSIX 路径）由端口自己折，
 * 调用方不拼——在外面拼就等于把「会话根在哪」的判断复制到第二处，而配了自定义 `sessionDir` 的机器上
 * 那个判断是错的。`title` 缺省取文件名 stem（与 scanner 的登记路径同一取值）；`updatedAt` 未知就不传。
 */
export type RemoteSessionRegistrationRequest = {
	readonly hostId: string;
	readonly projectId: string;
	readonly remotePath: string;
	readonly title?: string;
	readonly updatedAt?: number;
};

/**
 * AgentManager 看到的全部远端能力。
 *
 * `prepare()` 与 `createLauncher()` 是**配对**的两次调用：`prepare()` 负责解析出这一轮的
 * 远端事实与计划，并把与它同源（同一个已验证 client）的启动器记下来；`createLauncher()`
 * 只把上一轮 `prepare()` 配好的启动器交出去。这样计划与启动器一定来自同一份连接事实——
 * 分成两条路各取一次，就会出现「用 A 会话的探测结果、经 B 通道起进程」。
 */
export type RemoteRuntimePort = {
	prepare(input: RemoteRuntimePrepareInput): Promise<RemoteRuntimePrepareResult>;
	createLauncher(): PiRuntimeLauncher;
	/**
	 * 把 pi 上报的远端会话文件登记成 catalog 的 ssh locator 身份，返回这条 catalog 记录。
	 *
	 * 与 `prepare()` 同款：**每次调用**才解析服务与 catalog（门禁/连接/装配都可能变），拿不到就
	 * `REMOTE_RUNTIME_UNAVAILABLE`。这个方法**可选**：缺省表示这个端口没有登记能力（旧装配/替身），
	 * 调用方据此 fail-closed，绝不用伪记录顶上。
	 */
	registerRemoteSession?(input: RemoteSessionRegistrationRequest): Promise<RemoteSessionRegistration>;
};

/**
 * 端口需要的连接服务面（`RemoteHostConnectionService` 结构上满足，无需 import 具体实现）。
 *
 * 除了启动事实，它还要满足 scanner 的端口面（`remoteHome` / `withProjectSession`）：会话根解析是
 * scanner 的实现，端口只是把它接出来用，不是另起一条远端访问通道。
 */
export type RemoteRuntimeServicePort = {
	remotePiRuntimeFacts(hostId: string): Promise<RemotePiRuntimeFacts>;
	/** 部署（或复用已部署的）内置扩展快照；失败返回稳定码，不抛。 */
	ensureRemoteExtensionSnapshot(hostId: string): Promise<RemoteExtensionSnapshotFacts>;
	/** 把安全策略快照写到该主机（原子替换）。缺省 = 不支持远端安全门，安全门不会被注入。 */
	pushSecurityPolicySnapshot?(hostId: string, bytes: Buffer | Uint8Array): Promise<void>;
	createPiRuntimeLauncher(hostId: string): PiRuntimeLauncher;
} & RemoteSessionScannerPort;

/**
 * 远端项目 trust 的决策来源（装配注入）。
 *
 * 只暴露一件事：这一次 spawn 该不该表态（approve / no-approve），以及不表态（undefined）——
 * 后者涵盖「用户没决策」「endpoint 变了导致作废」「pin 事实拿不到」三种情形。实现方是
 * `RemoteProjectTrustService`（结构上满足本类型），它自己从配置与主机目录现读事实；本端口不碰
 * pin、不新增 SSH 通道。
 */
export type RemoteRuntimeTrustPort = {
	trustOverride(input: { readonly hostId: string; readonly remoteRoot: string }): Promise<PiTrustOverride | undefined>;
};

export type RemoteRuntimeSettings = PiRpcBaseArgsSettings & {
	readonly autoSessionTitle?: boolean;
	readonly piRpcNoExtensions?: boolean;
	readonly removedBuiltInExtensions?: readonly string[];
	readonly enabledBuiltInExtensions?: readonly string[];
};

export type RemoteRuntimePortDeps = {
	/**
	 * 按需解析连接服务；门禁关闭或装配缺失时返回 undefined（端口据此 fail-closed）。
	 *
	 * 给解析器而不是给实例：连接服务是「实验门禁 + 异步探活」下的懒建对象，而 AgentManager
	 * 比它更早装配；解析器只在真正要起远端会话时才求值，也不会重复建第二个 client。
	 */
	resolveService(): Promise<RemoteRuntimeServicePort | undefined> | RemoteRuntimeServicePort | undefined;
	/** pi 的基础参数与「哪个扩展开/关」只认这一个设置来源（与本地同一份 SettingsStore 快照）。 */
	settings(): RemoteRuntimeSettings;
	/**
	 * runner init 帧的 `PIDECK_*` 环境通道是否可用。S2 接上 runner 1.1.0 后为 true；
	 * 为 false 时 `remote-needs-env` 的扩展（安全门）**不注入**——加载了却拿不到策略就是静默假安全。
	 */
	envChannelAvailable?: boolean;
	/**
	 * 本机安全策略快照的字节（SecurityStore 写出的那一份）。缺省/读不到 ⇒ 远端安全门不注入；
	 * 每次 prepare 现读，因为会话级等级覆盖会改快照内容。
	 */
	securityPolicyBytes?: () => Promise<Buffer | Uint8Array | undefined> | Buffer | Uint8Array | undefined;
	/**
	 * 远端项目 trust 的决策来源（可选）。未注入 = 永不表态（正式包/旧装配/测试替身的行为），
	 * 与「用户没决策」同一条路径：一个 flag 都不加。
	 */
	resolveTrust?(): RemoteRuntimeTrustPort | undefined | Promise<RemoteRuntimeTrustPort | undefined>;
	/**
	 * 按需解析 catalog（`SessionCatalog` 结构上满足 `ensureRemoteSession` 这一个入口）。
	 * 与 `resolveService` 同一个立场：装配比 catalog 早，回调只在真正要登记时才求值。
	 */
	resolveCatalog(): Promise<RemoteSessionCatalogPort | undefined> | RemoteSessionCatalogPort | undefined;
	/**
	 * 一次性远端命令（R1a，可选）：与 `resolveService` 同一立场——只在真正要解析会话根时才求值。
	 * 给了它时 `registerRemoteSession` 的根解析不借 helper 会话（不再把 host 的活动 root 切走）；
	 * 缺省退回 `withProjectSession`（旧装配/测试替身）。
	 */
	resolveRemoteTransport?(): RemoteSessionCommandTransportPort | undefined;
	/** 一次运行的身份（runner lease 命名/握手校验）；缺省随机，测试可注入固定值。 */
	createNonce?(): string;
};

/**
 * 错误自带的稳定码（错误对象的 `code` 或 `message` 本身是稳定码），否则 undefined。
 * 与 `RemoteSessionScanner` 的 `stableCodeOf` 同口径：稳定码是「一个大写词」，不是一句话。
 */
function stableRemoteCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const record = error as { code?: unknown; message?: unknown };
	for (const value of [record.code, record.message]) {
		if (typeof value === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(value)) return value;
	}
	return undefined;
}

/** 与引导握手同一个 nonce 形态（首字符字母数字，16..64）：`randomUUID` 去横线正好 32 位 hex。 */
function defaultNonce(): string {
	return randomUUID().replace(/-/g, "");
}

/**
 * 解析一个按需依赖（服务 / catalog）：建造失败时它自己带的稳定码更有指向性（如找不到 ssh 客户端 /
 * 还没装配），能转述就转述；不带稳定码的异常与「解析不出来」都折叠成 `unavailable`（fail-closed）。
 */
async function resolveOrUnavailable<Value>(resolve: () => Value | undefined | Promise<Value | undefined>): Promise<Value> {
	let resolved: Value | undefined;
	try {
		resolved = await resolve();
	} catch (error) {
		throw new Error(stableRemoteCode(error) ?? REMOTE_RUNTIME_CODES.unavailable);
	}
	if (resolved === undefined) throw new Error(REMOTE_RUNTIME_CODES.unavailable);
	return resolved;
}

/** 远端路径里的控制字节与远端 helper 的路径域同判据（出现即拒绝，不回显）。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * pi 上报的远端会话文件 → `remoteSessionId`（相对会话根的 POSIX 路径），折不出来返回 undefined。
 *
 * **只做一件事：去掉根前缀。** pi 的两种布局都由此得到正确的 id：默认根是
 * `<root>/--<encoded-cwd>--/<file>.jsonl`（id 带一层工作区目录），user-level `sessionDir` 是平铺
 * `<root>/<file>.jsonl`。所以按 `/` 切出文件名是错的（丢掉一层身份），复刻 pi 的 cwd 编码更是把它的
 * 实现细节抄进 PiDeck——两者都明确不做。
 *
 * 判据是**逐段严格**而不是「规范化后再比较」：`.` / `..` / 空段 / 尾斜杠一律拒绝，于是不存在「规范化
 * 之后才落回根内」的中间态（`<root>/../elsewhere/x.jsonl` 在这里根本不合法）。根前缀按 `root + "/"`
 * 比，因此 `/srv/sessions-extra/x.jsonl` 不属于 `/srv/sessions` 这类误匹配不会被当成命中。
 * 反斜杠同样拒绝：`remoteSessionId` 的既有判据（scanner 的 `readRemoteSessionId`）不接受它，
 * 放进来会造出一条别的远端路径永远读不到的记录。
 */
function remoteSessionIdWithinRoot(root: string, remotePath: string): string | undefined {
	if (typeof remotePath !== "string" || remotePath.length === 0 || remotePath.length > REMOTE_SESSION_MAX_PATH_LENGTH) return undefined;
	if (!remotePath.startsWith("/") || remotePath.includes("\\") || CONTROL_CHARS.test(remotePath)) return undefined;
	const prefix = root.endsWith("/") ? root : root + "/";
	if (!remotePath.startsWith(prefix)) return undefined;
	const relative = remotePath.slice(prefix.length);
	if (relative.length === 0 || relative.length > REMOTE_SESSION_MAX_ID_LENGTH) return undefined;
	for (const segment of relative.split("/")) {
		if (segment.length === 0 || segment === "." || segment === "..") return undefined;
	}
	return relative;
}

/**
 * 解析这一次 spawn 的 trust 决策。
 *
 * 失败一律折叠成「未决策」：读配置/读主机目录不顺不是安全问题，但**不能**让它变成
 * 默认 approve（那等于静默信任任意远端项目），也不能让它把远端会话卡死——不表态就是最保守的行为。
 */
async function resolveTrustOverride(resolve: RemoteRuntimePortDeps["resolveTrust"], input: RemoteRuntimePrepareInput): Promise<PiTrustOverride | undefined> {
	try {
		const port = await resolve?.();
		if (port === undefined) return undefined;
		return await port.trustOverride({ hostId: input.hostId, remoteRoot: input.remoteCwd });
	} catch {
		return undefined;
	}
}

/**
 * 选本次要注入的内置扩展（纯决策，副作用只有“确保快照已部署”）。
 *
 * 判定顺序是**先便宜后贵**：设置开关 → 版本门槛 → 才去部署快照。版本不够的主机绝不应该为了“先看看有什么”
 * 白传 524KB；诊断开关打开时同理。所有失败都折成闭集 reason，不抛——扩展是降级面，不是启动前置条件。
 */
async function selectRemoteExtensions(input: { service: RemoteRuntimeServicePort; hostId: string; version: string; settings: RemoteRuntimeSettings; envChannelAvailable: boolean }): Promise<{ paths: string[]; result: RemoteRuntimeExtensions }> {
	if (input.settings.piRpcNoExtensions === true) return { paths: [], result: { applied: [], reason: "REMOTE_EXTENSIONS_DISABLED" } };
	if (!piVersionAtLeast(input.version, REMOTE_EXTENSIONS_MIN_PI_VERSION)) return { paths: [], result: { applied: [], reason: "REMOTE_PI_EXTENSIONS_UNSUPPORTED" } };
	let snapshot: RemoteExtensionSnapshotFacts;
	try {
		snapshot = await input.service.ensureRemoteExtensionSnapshot(input.hostId);
	} catch (error) {
		return { paths: [], result: { applied: [], reason: "REMOTE_EXTENSIONS_UNAVAILABLE", detail: stableRemoteCode(error) ?? "REMOTE_EXTENSIONS_UNAVAILABLE" } };
	}
	if (!snapshot.ok) return { paths: [], result: { applied: [], reason: "REMOTE_EXTENSIONS_UNAVAILABLE", detail: snapshot.code } };
	const names = listRemoteInjectableExtensionNames({
		available: new Set(snapshot.fileNames),
		...(input.settings.removedBuiltInExtensions === undefined ? {} : { removedBuiltInExtensions: input.settings.removedBuiltInExtensions }),
		...(input.settings.enabledBuiltInExtensions === undefined ? {} : { optInBuiltInExtensions: input.settings.enabledBuiltInExtensions }),
		envAvailable: input.envChannelAvailable,
		...(input.settings.autoSessionTitle === false ? { autoSessionTitle: false } : {}),
	});
	if (names.length === 0) return { paths: [], result: { applied: [], reason: "REMOTE_EXTENSIONS_NONE" } };
	return { paths: names.map((name) => `${snapshot.root}/${name}`), result: { applied: names } };
}

/**
 * 把安全策略快照推到主机；任何一步不成立都返回 false（调用方把安全门从注入名单里拿掉）。
 *
 * 为什么失败就必须不注入：security-gate 在拿不到快照时是 **fail-open**（扩展对缺失配置的既有契约），
 * 「扩展在、策略没到」比完全没装更危险——用户看到等级选择器，实际什么都没拦。
 */
async function pushSecuritySnapshot(input: { service: RemoteRuntimeServicePort; hostId: string; readBytes: RemoteRuntimePortDeps["securityPolicyBytes"] }): Promise<boolean> {
	const push = input.service.pushSecurityPolicySnapshot;
	if (typeof push !== "function") return false;
	let bytes: Buffer | Uint8Array | undefined;
	try {
		bytes = input.readBytes === undefined ? undefined : await input.readBytes();
	} catch {
		return false;
	}
	if (bytes === undefined || bytes.length === 0) return false;
	try {
		await push.call(input.service, input.hostId, bytes);
		return true;
	} catch {
		return false;
	}
}

export function createRemoteRuntimePort(deps: RemoteRuntimePortDeps): RemoteRuntimePort {
	let launcher: PiRuntimeLauncher | undefined;
	/** 计划里的 generation 是「这台主机上的第几次启动」：同一次运行内单调递增即可，不做跨重启持久化。 */
	let generation = 0;
	return {
		async prepare(input: RemoteRuntimePrepareInput): Promise<RemoteRuntimePrepareResult> {
			// **每次调用**都重新解析服务：AgentManager 比连接服务先装配，门禁/连接状态也随时可能变
			// （还没建、建失败、被 gate 关掉）。任何「构造时捕获一个当时还不存在的实例」的写法都会让
			// 远端永远拿不到服务（那正是本批要避免的静默失败）。
			const service = await resolveOrUnavailable(() => deps.resolveService());
			// 事实先取（它会确保主机已连上、runner 已按内容寻址部署），再在构造点验 plan 的形状。
			const facts = await service.remotePiRuntimeFacts(input.hostId);
			// trust 决策在**每次 prepare**现读：撤销/改主意在下一轮 spawn 立即生效（本批明确不要求重启应用）。
			const trust = await resolveTrustOverride(deps.resolveTrust, input);
			const settings = deps.settings();
			// 扩展注入面：版本/设置/部署三道门全部在端口里收口，AgentManager 只消费结果。
			const extensions = await selectRemoteExtensions({ service, hostId: input.hostId, version: facts.version, settings, envChannelAvailable: deps.envChannelAvailable === true });
			// 安全门：只有「扩展已注入」且「快照已写入」才保留；否则把它从名单里拿掉并如实反映在结果里。
			let applied = [...extensions.result.applied];
			let extensionPaths = [...extensions.paths];
			let env: Record<string, string> | undefined;
			if (applied.includes("pi-deck-security-gate.ts")) {
				const pushed = await pushSecuritySnapshot({ service, hostId: input.hostId, readBytes: deps.securityPolicyBytes });
				if (pushed) {
					env = { PIDECK_SECURITY_CONFIG: remoteSecurityPolicyPath(facts.deployRoot), ...(input.sessionId === undefined ? {} : { PIDECK_SESSION_ID: input.sessionId }) };
				} else {
					applied = applied.filter((name) => name !== "pi-deck-security-gate.ts");
					extensionPaths = extensionPaths.filter((path) => !path.endsWith("/pi-deck-security-gate.ts"));
				}
			}
			const extensionResult: RemoteRuntimeExtensions =
				applied.length === 0 && extensions.result.reason !== undefined ? { applied, reason: extensions.result.reason, ...(extensions.result.detail === undefined ? {} : { detail: extensions.result.detail }) } : { applied, ...(extensions.result.detail === undefined ? {} : { detail: extensions.result.detail }) };
			const plan = buildRemotePiRuntimePlan({
				hostId: input.hostId,
				generation: (generation += 1),
				remoteCwd: input.remoteCwd,
				nodePath: facts.nodePath,
				piPath: facts.piPath,
				runnerPath: facts.runnerPath,
				nonce: (deps.createNonce ?? defaultNonce)(),
				...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
				// 未决策（含材料缺失 / 解析失败）⇒ 不传这个字段 ⇒ args 里不出现任何 trust flag。
				...(trust === undefined ? {} : { trust }),
				...(extensionPaths.length === 0 ? {} : { extensions: extensionPaths }),
				...(env === undefined ? {} : { env }),
				settings,
			});
			launcher = service.createPiRuntimeLauncher(input.hostId);
			// `--no-session` 在这里补：`buildRemotePiArgs` 只产出基础参数与 `--session`（远端与本地共享
			// 同一份基础参数，不允许两处各写一套），而匿名会话在本地由 `PiProcess.start` 追加同一面旗标。
			// 远端不补，pi 会把一次 PiDeck 匿名会话写成一个远端会话文件——PiDeck 这边并不认它。
			const finalPlan = input.noSession ? { ...plan, args: [...plan.args, "--no-session"] } : plan;
			return { plan: finalPlan, extensions: extensionResult };
		},
		createLauncher(): PiRuntimeLauncher {
			if (!launcher) throw new Error(REMOTE_RUNTIME_CODES.launcherUnprepared);
			return launcher;
		},
		async registerRemoteSession(input: RemoteSessionRegistrationRequest): Promise<RemoteSessionRegistration> {
			// 与 prepare() 同一口径：服务与 catalog 都按调用时才解析（门禁/装配状态都可能变）。
			const service = await resolveOrUnavailable(() => deps.resolveService());
			const catalog = await resolveOrUnavailable(() => deps.resolveCatalog());
			// 会话根解析**复用 scanner 的导出入口**（默认 `<home>/.pi/agent/sessions` vs user-level
			// `settings.json` 的 `sessionDir` 覆盖）：失败原样转述它的稳定码，不在这里折叠。
			const resolvedRoot = await createRemoteSessionScanner({ port: service, transport: deps.resolveRemoteTransport?.() }).resolveSessionRoot(input.hostId);
			if (!resolvedRoot.ok) throw new Error(resolvedRoot.code);
			const remoteSessionId = remoteSessionIdWithinRoot(resolvedRoot.root, input.remotePath);
			if (remoteSessionId === undefined) throw new Error(REMOTE_RUNTIME_CODES.locatorUnresolved);
			// catalog 写入只走这一条正门（`ensureRemoteSession`：幂等、两遍匹配、稳定 id）。
			return catalog.ensureRemoteSession({
				projectId: input.projectId,
				hostId: input.hostId,
				remoteSessionId,
				remotePath: input.remotePath,
				// title 在 catalog 的协议形状里必填：调用方没给就用文件名 stem（与 scanner 的登记路径同一取值）。
				title: input.title ?? titleFromRemoteSessionId(remoteSessionId),
				// 未知 mtime 用 0（catalog 的判据是「> 0 才算已知时间」）：不拿本机 now 冒充远端文件时间。
				updatedAt: input.updatedAt ?? 0,
			});
		},
	};
}
