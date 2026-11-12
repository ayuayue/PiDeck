/**
 * 远端 Session 只读发现（G3，Phase 3 第三段）。
 *
 * 这里做的事有三件：**列出远端会话文件**（列表级元数据）、**把其中一条幂等登记进本地 SessionCatalog**，
 * 以及**按需解析一条会话的标题**（H1：有界读头部后交给本地标题管线，只读、不写 catalog）。
 * 列表级扫描仍然不做任何内容解析——标题走独立通道；不做侧栏 UI、不做 move/archive/delete（Phase 4/5）。
 *
 * 会话根（J2）：默认 `<remote home>/.pi/agent/sessions`，但 pi 的 `sessionDir` 可以把它换掉——所以每次操作
 * 先做一次**有界配置探测**（读 `settings.json` ≤64 KiB），配置缺失/读不到/畸形都退回默认根（与历史行为逐字
 * 一致），配置里的 `sessionDir` 不可用则给稳定码拒绝（理由见 `remoteSessionIdentity.resolveConfiguredSessionDir`）。pi 的 settings 是
 * user + project 合并的，所以根有两层：
 * - user-level `<home>/.pi/agent/settings.json`（全局根）：相对值拒绝（pi 按会话 cwd 解析，主机级无从得知），
 *   绝对值必须在 home 之内；
 * - **项目级** `<项目根>/.pi/settings.json`（本次新增）：相对值按该项目根解析、绝对值允许在项目外（用户显式配置），
 *   只影响该项目。项目级 `sessionDir` 只在**项目级发现**（`scan(hostId, projectId)`）与身份推导里生效。
 * **边界**：`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / `--session-dir` 是远端进程环境
 * （helper 没有读 env 的操作），仍然不可知 → 这种会话会以 `REMOTE_SESSION_LOCATOR_UNRESOLVED`
 * 如实拒绝（不猜一个 id），见 docs/archive/remote/remote-development-handoff.md 第六批。
 *
 * 作用域：侧栏区块挂在**项目**下，所以 `scan(hostId, projectId)` 只列该项目的会话（默认根只扫它自己的
 * encoded-cwd 目录）；不带 projectId 的旧主机级扫描保留给诊断探针与测试。项目级根的 id 带
 * `project:<encoded-cwd>/` 命名空间，默认根保持旧 id——旧记录不迁移。
 *
 * 边界与不变量（全部 fail-closed）：
 * - 远端路径**绝不进本地 fs**：本模块不 import node:fs。远端访问面收敛成一个
 *   `RemoteSessionTreeSource`（「在一个 root 上列目录 / 批量描述 / 有界头读」），两个实现：
 *   `port.withProjectSession`（helper 会话，旧路径）与一次性短命令（`options.transport`，R1a）。
 *   这样「候选选择 / 上限 / 字节预算 / 排序 / 归属」只有一份，换通道不改语义。
 * - **扫描与根解析不抢 root**（R1a）：helper 一个 host 只有一个活动 root，借 `withProjectSession(会话根)`
 *   读列表会把用户的文件树/Git 踢下线再连回来（docs/remote-file-tree-and-git-unification-plan.md §1.2 R1）。
 *   装配注入一次性命令传输后这两件事全程不碰 helper；`register`/`title` 仍走 helper 会话（按需单条读，
 *   不在本卡范围内），所以装配与旧行为在未注入 transport 时逐字不变。
 * - 结果只含 { remoteSessionId, remotePath, name, size, mtimeMs }；没有任何远端正文。
 * - 上限是硬上限：工作区目录 ≤512、会话文件 ≤2000、单次扫描元数据字节预算 ≤1 MiB、并发 ≤4。
 *   越界是**拒绝**（稳定码），不是悄悄截断——截断后的列表看起来和完整列表一样。
 * - 每个失败都带稳定码；reader/连接层自己的稳定码原样转述，未知异常才折叠成 REMOTE_SESSION_SCAN_FAILED。
 *
 * 已知代价（有意为之，写在这里免得下次误读）：fs.list 不带 mtime，所以每个候选文件都要被描述一次；
 * 自 helper 1.22.0 起这件事走 `fs.statMany`（每批 ≤64 条路径，逐条语义与单条 fs.stat 完全相同），
 * 2000 个文件最多 32 次 RPC，而不是 2000 次。候选选择、预算、排序与归属仍然全部留在本模块，
 * helper 只负责「把这些已知路径逐个描述」。走一次性命令时请求数是同一量级（一目录一条命令 + 每 64 条
 * 候选一条命令），差别是 mtime 只有秒精度、且需要远端有 `wc` 与 `stat`（细节见 `RemoteSessionScanSource`）。
 */

import { REMOTE_HELPER_MAX_STAT_MANY_PATHS } from "../remote/RemoteHelperContract";
// hostId 的判据只允许有一份：与持久化边界（readSshSessionLocator / 项目域）共用 shared 的权威取值域。
import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";
import { createRemoteWorkspaceReader, REMOTE_WORKSPACE_MAX_HEAD_BYTES, REMOTE_WORKSPACE_MAX_WINDOW_BYTES, type RemoteWorkspacePort } from "../remote/RemoteWorkspaceReader";
// R1a：一次性命令版的「根解析 + 列表读取」。两个实现共用同一套扫描语义，区别只在远端访问通道。
import { createRemoteSessionScanSource, type RemoteSessionCommandTransportPort, type RemoteSessionTree, type RemoteSessionTreeEntry, type RemoteSessionTreeSource } from "./RemoteSessionScanSource";
// 装配侧（index.ts / remoteSessionIpc / remoteRuntimePort）要声明同样的端口：从本模块转出，避免各处自己去 source 模块取。
export type { RemoteSessionCommandTransportPort };
import { SUBAGENT_ARTIFACTS_DIR_NAME } from "../../shared/sessionIdentity";
import { createRemoteSessionRoots, type RemoteSessionRootResolution } from "./remoteSessionRoots";
// 远端会话的路径/身份词汇与稳定码只有一份（根解析模块与本模块共用；这里转出保持既有导入点不变）。
import { CONTROL_CHARS, REMOTE_SESSION_CODES, REMOTE_SESSION_MAX_ID_LENGTH, type RemoteSessionIdentityResolution, type RemoteSessionProjectCandidate, type RemoteSessionProjectResolver } from "./remoteSessionIdentity";
import type { RemoteSessionRegistration, RemoteSessionRegistrationInput } from "./SessionCatalog";
import { inferSessionTitleFromHeadText, type SessionTitleInference } from "./sessionNameLine";
// 渲染层要消费这三个结构，所以它们是 shared 契约而不是本模块私有类型；这里只转出，避免同一结构两处各定义一份。
import type { RemoteSessionEntry, RemoteSessionRegisterResult, RemoteSessionScanResult, RemoteSessionTitleResult } from "../../shared/types/remoteHost";
export type { RemoteSessionEntry, RemoteSessionRegisterResult, RemoteSessionScanResult } from "../../shared/types/remoteHost";
// H1 新增的按需标题结果同样只转出 shared 契约（remoteSessionWiring 钉的是上一行的既有形状，不合并两行）。
export type { RemoteSessionTitleResult } from "../../shared/types/remoteHost";

export {
	REMOTE_SESSION_AGENT_DIR_SUFFIX,
	REMOTE_SESSION_CODES,
	REMOTE_SESSION_MAX_ID_LENGTH,
	REMOTE_SESSION_MAX_PATH_LENGTH,
	REMOTE_SESSION_PROJECT_ID_PREFIX,
	REMOTE_SESSION_ROOT_SUFFIX,
	REMOTE_SESSION_SETTINGS_FILE_NAME,
} from "./remoteSessionIdentity";
export type { RemoteSessionIdentityResolution, RemoteSessionProjectCandidate, RemoteSessionProjectResolver } from "./remoteSessionIdentity";
export type { RemoteSessionRootResolution } from "./remoteSessionRoots";

/**
 * 单次扫描的硬上限（冻结设计第 7 条）。**只能下调，不能调高**（见 readLimits）：
 * 这些数字本身就是「有界」这件事的定义，允许调用方放大等于没有上限。
 */
export const REMOTE_SESSION_LIMITS = {
	/** 工作区目录（pi 的 encoded-cwd 子目录）上限。 */
	maxWorkspaceDirs: 512,
	/** 会话文件上限。 */
	maxFiles: 2000,
	/** 单次扫描的元数据字节预算：每个列出的目录项计 name 的 UTF-8 字节 + 结构开销，每次 stat 计 64 字节。 */
	maxTotalBytes: 1024 * 1024,
	/** 并发上限（列目录与 stat 共用）。 */
	concurrency: 4,
} as const;

/** 每个目录项的结构开销（与 name 长度一起计入字节预算）。 */
export const REMOTE_SESSION_ENTRY_OVERHEAD_BYTES = 32;
/** 每次 stat 计入字节预算的固定开销。 */
export const REMOTE_SESSION_STAT_OVERHEAD_BYTES = 64;
/** 装配时 port/limits 不合法（与其它远端模块一致，构造期抛出）。 */
export const REMOTE_SESSION_SCANNER_OPTIONS_INVALID = "REMOTE_SESSION_SCANNER_OPTIONS_INVALID";

/** 一条远端会话的列表级元数据；不含任何正文。 */
// RemoteSessionEntry / RemoteSessionScanResult / RemoteSessionRegisterResult 定义在 shared/types/remoteHost.ts，
// 由本文件顶部 import + 转出（渲染层要消费同一结构，不允许两处各写一份）。

/** 一个已建立会话的窄请求面（与 RemoteProjectSession 结构同形，便于装配直接传服务）。 */
export type RemoteSessionSessionPort = {
	request(method: string, params?: unknown, options?: { timeoutMs?: number; onRequestId?: (requestId: string) => void }): Promise<unknown>;
	cancel(requestId: string, options?: { timeoutMs?: number }): Promise<unknown>;
};

/**
 * 本模块需要的远端能力：解析 home，以及「在一个受控 root 里跑完整个操作」。
 * 刻意不复刻 RemoteHostConnectionService 的类型：G2 正在给它加 remoteHome，
 * 用窄端口并行开发不会把两批改动耦合在一起（装配处直接传服务，结构上满足）。
 */
export type RemoteSessionScannerPort = {
	remoteHome(hostId: string): Promise<string | undefined>;
	/** 可选：缓存状态读不到时**按需建立会话**再读一次（生产端口提供；缺失时退回只读）。 */
	remoteHomeEnsuring?(hostId: string): Promise<string | undefined>;
	withProjectSession<T>(hostId: string, root: string, task: (session: RemoteSessionSessionPort) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }>;
};

/** catalog 侧只用到 ensureRemoteSession 这一个入口（SessionCatalog 结构上满足）。 */
export type RemoteSessionCatalogPort = {
	ensureRemoteSession(input: RemoteSessionRegistrationInput): Promise<RemoteSessionRegistration>;
	/**
	 * 可选：这条远端会话是否已被用户「移除记录」（墓碑命中）。列表级发现用它把已移除的会话从「可导入」
	 * 里排除——远端文件仍在（PiDeck 不删远端数据），但「删了又回来」是用户可感知的错误。
	 */
	isRemoteSessionDismissed?(hostId: string, remoteSessionId: string): boolean;
};

export type RemoteSessionScannerLimits = {
	maxWorkspaceDirs: number;
	maxFiles: number;
	maxTotalBytes: number;
	concurrency: number;
};

export type RemoteSessionScannerOptions = {
	port: RemoteSessionScannerPort;
	/**
	 * 可选：一次性远端命令传输（生产是 `runPinnedRemoteCommand`，与读/写/归档同一条 pinned SSH 通道）。
	 * 给了它时**扫描与会话根解析**不再借 helper 会话，因此不再把 host 的活动 root 切走（R1a）；缺省退回
	 * helper 会话路径，旧装配与测试替身因此逐字不变。
	 */
	transport?: RemoteSessionCommandTransportPort;
	catalog?: RemoteSessionCatalogPort;
	/** 远端会话归属哪个本地项目：可选（未注入时用 `projectCandidates` 自行判）。 */
	projectIdForHost?: RemoteSessionProjectResolver;
	/**
	 * 该主机上的远端项目清单：项目级扫描根与 `project:` 命名空间的 id 解析都靠它。
	 * 与 `projectIdForHost` 同源（装配从 ProjectStore 收窄），scanner 不自己读项目表。
	 */
	projectCandidates?: (hostId: string) => readonly RemoteSessionProjectCandidate[];
	/** 只允许把这些硬上限调小（测试用）。 */
	limits?: Partial<RemoteSessionScannerLimits>;
};

export type RemoteSessionScanner = {
	/**
	 * 只读列出远端会话；不写 catalog、不读正文。
	 *
	 * `projectId` 给出时是**项目级**发现：只扫该项目的 encoded-cwd 目录与它自己的项目级
	 * `sessionDir`（同主机其他项目的会话不得出现）。缺省保持旧的主机级扫描（默认根）。
	 */
	scan(hostId: string, projectId?: string): Promise<RemoteSessionScanResult>;
	/**
	 * 会话根解析（J2）：默认 `<remote home>/.pi/agent/sessions`，被 user-level `settings.json` 的
	 * `sessionDir` 覆盖时用它。scan/register/title 内部走的就是这一个函数。
	 *
	 * 为什么转出：别处（远端 runtime 把 pi 上报的会话文件折成 `remoteSessionId` 时）必须用**同一份**
	 * 会话根判定。各自再拼一次 `<home>/.pi/agent/sessions` 就会在配了自定义 `sessionDir` 的机器上
	 * 折出看似正常但错的相对路径。
	 */
	resolveSessionRoot(hostId: string): Promise<RemoteSessionRootResolution>;
	/**
	 * pi 上报的**绝对**会话文件 → catalog 身份（`remoteSessionId`）。
	 *
	 * 默认根之下的文件用旧 id（`<相对默认根>`），项目级 `sessionDir` 之下的用
	 * `project:<encoded-cwd>/<相对项目会话根>`。两者只允许这一份实现：扫描登记与会话运行时登记
	 * 必须算出**同一个** id，否则同一文件会出现两条侧栏记录。
	 */
	identityForPath(input: { hostId: string; projectId: string; projectRemotePath: string; remotePath: string }): Promise<RemoteSessionIdentityResolution>;
	/** 在远端确认该文件仍存在后，幂等登记进 catalog 并返回稳定 sessionId。 */
	register(input: { hostId: string; remoteSessionId: string }): Promise<RemoteSessionRegisterResult>;
	/**
	 * 按需解析真实标题（H1）：有界读头部（≤ REMOTE_WORKSPACE_MAX_HEAD_BYTES）交给本地标题管线。
	 * 只读、不写 catalog；解析不出强制 fallback（title = 文件名 stem），绝不编造。
	 */
	title(input: { hostId: string; remoteSessionId: string }): Promise<RemoteSessionTitleResult>;
};

/** 远端文件树里「不存在」的稳定码（helper 与一次性命令两个通道同一词汇）。 */
const PATH_NOT_FOUND = "PATH_NOT_FOUND";

/** 一个码就是一个码，绝不是自由文本。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** 常规扫描跳过的目录：归档/回收，以及 pi-subagents 的产物转储（与本地 SessionScanner 同口径）。 */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([".pideck-archive", ".trash", SUBAGENT_ARTIFACTS_DIR_NAME]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 稳定码转述：错误对象自己的 code 或 message 是稳定码时原样返回，否则 undefined（交由调用方折叠）。 */
function stableCodeOf(error: unknown): string | undefined {
	if (!isRecord(error)) return undefined;
	const code = error.code;
	if (typeof code === "string" && STABLE_CODE.test(code)) return code;
	const message = error.message;
	if (typeof message === "string" && STABLE_CODE.test(message)) return message;
	return undefined;
}

/**
 * hostId 要在发帧前就能当诊断身份与传输键用；非法值不回显。
 *
 * K2-1：判据收敛到 shared 的 `PROJECT_HOST_ID_PATTERN`——hostId 只可能由 `RemoteHostStore` 用
 * `randomUUID()` 生成（持久化边界、codec、pin、诊断、IPC 全部只接受这一形状）。以前这里只要求
 * 「非空 ≤64 无控制字节」，于是非 UUID 会先打一次远端往返，直到写 catalog 才以
 * `REMOTE_SESSION_IDENTITY_INVALID` 拒绝：同一个坏输入在两个边界得到两种结论，且失败点更靠后。
 * 现在两个边界同判据，稳定码仍是 `REMOTE_SESSION_HOST_ID_INVALID`。
 */
function readHostId(value: unknown): string | undefined {
	return typeof value === "string" && PROJECT_HOST_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * remoteSessionId 必须是**相对会话根的 POSIX .jsonl 路径**：非空、≤256、无控制字节、无反斜杠、非绝对、
 * 无 . / .. 段、无空段、末段是带 stem 的 .jsonl（".jsonl" 这种空 stem 不算会话身份，列表扫描也跳过它）。
 * 它同时会被当作 helper 请求路径用，形状不合法就一个帧都不发。
 */
function readRemoteSessionId(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_SESSION_MAX_ID_LENGTH) return undefined;
	if (CONTROL_CHARS.test(value) || value.includes("\\") || value.startsWith("/")) return undefined;
	const segments = value.split("/");
	for (const segment of segments) {
		if (segment.length === 0 || segment === "." || segment === "..") return undefined;
	}
	// 末段必须是有 stem 的 .jsonl：".jsonl" 这类空 stem 文件不是会话身份，扫描侧同样跳过它。
	const last = segments[segments.length - 1] ?? "";
	if (last.length <= ".jsonl".length || !last.toLowerCase().endsWith(".jsonl")) return undefined;
	return value;
}

/**
 * 权威标题判据（I1 三档口径）：标题来自**名字字段**——pi 的 session_info，或旧版 PiDeck 私有
 * sessionName 行——而不是首条 user/assistant 文本的弱兜底。本地管线用同一个 fromSessionInfo 标志
 * 把权威名落成 catalog 的 manual、弱兜底落成 fallback，所以这里必须同判据。
 */
function isAuthoritativeTitle(inference: SessionTitleInference): boolean {
	return inference.name !== undefined && inference.fromSessionInfo;
}

/**
 * 文件名 stem（暂定标题）。时间戳 stem 由 catalog 的展示层清成 Untitled，这里不做产品判断。
 *
 * 转出是给别的「登记一条远端会话」的路径用的（别处再写一遍 `basename` 去后缀就会与这里漂移）。
 */
export function titleFromRemoteSessionId(remoteSessionId: string): string {
	const base = remoteSessionId.slice(remoteSessionId.lastIndexOf("/") + 1);
	const stem = base.replace(/\.jsonl$/i, "").trim();
	return stem.length > 0 ? stem : "Untitled";
}

function isJsonlName(name: string): boolean {
	return name.toLowerCase().endsWith(".jsonl") && name.length > ".jsonl".length;
}

/** 只允许把硬上限调小：maxWorkspaceDirs/maxFiles/maxTotalBytes/concurrency 都在 [1, 默认值] 内才是合法装配。 */
function readLimits(value: unknown): RemoteSessionScannerLimits | undefined {
	const limits: RemoteSessionScannerLimits = { ...REMOTE_SESSION_LIMITS };
	if (value === undefined) return limits;
	if (!isRecord(value)) return undefined;
	for (const key of ["maxWorkspaceDirs", "maxFiles", "maxTotalBytes", "concurrency"] as const) {
		const raw = value[key];
		if (raw === undefined) continue;
		if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > REMOTE_SESSION_LIMITS[key]) return undefined;
		limits[key] = raw;
	}
	return limits;
}

function isRemoteSessionScannerPort(value: unknown): value is RemoteSessionScannerPort {
	return isRecord(value) && typeof value.remoteHome === "function" && typeof value.withProjectSession === "function";
}

/** 把已建立会话适配成 reader 需要的 port；hostId 不一致一律拒绝（否则诊断会说谎）。 */
function sessionPort(session: RemoteSessionSessionPort, hostId: string): RemoteWorkspacePort {
	const port: RemoteWorkspacePort = {
		request: (requestHostId, method, params, options) => (requestHostId === hostId ? session.request(method, params, options) : Promise.reject(new Error("SSH_HOST_NOT_READY"))),
	};
	if (typeof session.cancel === "function") {
		port.cancel = (requestHostId, requestId, options) => (requestHostId === hostId ? session.cancel(requestId, options) : Promise.reject(new Error("SSH_HOST_NOT_READY")));
	}
	return port;
}

/**
 * helper 会话实现（旧路径）：把三件只读操作绑到一个 root 的 helper 会话上。
 *
 * 代价如实记下：`withProjectSession` 会让 host **切换活动 root**（helper 启动时固定了 `--root`，换 root 就
 * discard 重建），所以这条路径仍会把用户项目的文件树/Git 踢下线再连回来。装配注入 `transport` 后扫描与
 * 根解析走一次性命令（`RemoteSessionScanSource`），不再经过这里；`register`/`title` 仍用它（按需单条读）。
 */
function helperTreeSource(port: RemoteSessionScannerPort): RemoteSessionTreeSource {
	return {
		async withRoot(hostId, root, task) {
			const outcome = await port.withProjectSession(hostId, root, (session) => task(helperTree(hostId, session)));
			// 建立失败（未连接/已断开）原样转述它自己的稳定码：调用方按稳定码上报，不猜原因。
			if (!outcome.ok) throw new Error(outcome.code);
			return outcome.value;
		},
	};
}

/** helper 会话上的四件只读操作：一律走 `RemoteWorkspaceReader`（与项目读面同一套协议校验）。 */
function helperTree(hostId: string, session: RemoteSessionSessionPort): RemoteSessionTree {
	const reader = createRemoteWorkspaceReader({ port: sessionPort(session, hostId) });
	return {
		async readHead(relativePath, maxBytes) {
			const head = await reader.readHead(hostId, relativePath, maxBytes);
			return { content: head.content, bytes: head.bytes, size: head.size };
		},
		async readWindow(relativePath, window) {
			const read = await reader.readWindow(hostId, relativePath, window);
			return { content: read.content, bytes: read.bytes, size: read.size };
		},
		async list(relativeDirectory) {
			return (await reader.list(hostId, relativeDirectory)).entries;
		},
		async statMany(relativePaths) {
			return (await reader.statMany(hostId, relativePaths)).entries;
		},
	};
}

type Budget = { remaining: number };

/** 元数据字节预算：一旦为负立刻拒绝（预算是有界这件事的体现，不是统计值）。 */
function charge(budget: Budget, bytes: number): void {
	budget.remaining -= bytes;
	if (budget.remaining < 0) throw new Error(REMOTE_SESSION_CODES.budgetExceeded);
}

function chargeListing(budget: Budget, entries: readonly RemoteSessionTreeEntry[]): void {
	for (const entry of entries) charge(budget, Buffer.byteLength(entry.name, "utf8") + REMOTE_SESSION_ENTRY_OVERHEAD_BYTES);
}

/** 并发受限的 map：worker 数不超过 limits.concurrency，且结果按输入顺序落位。 */
/**
 * Split candidates into the helper's fixed batch size. The last batch is simply shorter: a short final batch is
 * a normal answer, never a reason to pad or to send a second, empty request.
 */
function batches(candidates: readonly string[]): string[][] {
	const result: string[][] = [];
	for (let index = 0; index < candidates.length; index += REMOTE_HELPER_MAX_STAT_MANY_PATHS) result.push(candidates.slice(index, index + REMOTE_HELPER_MAX_STAT_MANY_PATHS));
	return result;
}

async function mapBounded<Input, Output>(items: readonly Input[], concurrency: number, run: (item: Input, index: number) => Promise<Output>): Promise<Output[]> {
	const results = new Array<Output>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await run(items[index] as Input, index);
		}
	});
	await Promise.all(workers);
	return results;
}

export function createRemoteSessionScanner(options: RemoteSessionScannerOptions): RemoteSessionScanner {
	if (!isRecord(options) || !isRemoteSessionScannerPort(options.port)) throw new Error(REMOTE_SESSION_SCANNER_OPTIONS_INVALID);
	// 传输端口是可选的能力升级：给了就必须真的可用（否则会在第一次扫描时才炸，而不是在装配期）。
	if (options.transport !== undefined && (!isRecord(options.transport) || typeof options.transport.runRemoteCommand !== "function")) throw new Error(REMOTE_SESSION_SCANNER_OPTIONS_INVALID);
	const parsedLimits = readLimits(options.limits);
	if (parsedLimits === undefined) throw new Error(REMOTE_SESSION_SCANNER_OPTIONS_INVALID);
	const limits: RemoteSessionScannerLimits = parsedLimits;
	const { port, catalog, projectIdForHost } = options;
	/**
	 * 远端访问面：注入一次性命令传输时扫描与根解析全程不碰 helper（R1a）；缺省退回 helper 会话
	 * （旧装配与测试替身）。两个实现都只提供「一个 root 上的三件只读操作」，所以下面的上限/预算/排序只有一份。
	 */
	const treeSource: RemoteSessionTreeSource = options.transport === undefined ? helperTreeSource(port) : createRemoteSessionScanSource({ transport: options.transport });

	// 会话根解析与身份推导在 `remoteSessionRoots`：本模块只负责扫描/登记的动作面。
	const roots = createRemoteSessionRoots({ port, treeSource, projectCandidates: options.projectCandidates, projectIdForHost, readHostId });

	/**
	 * 列出会话根下的会话文件（两层：根 → 工作区子目录 → *.jsonl；根目录下的 *.jsonl 也收，与本地 collectJsonl 同口径）。
	 *
	 * 目录列表与每个候选的 stat 都并发受限；上限与字节预算在**发起之前**判断，越界即抛稳定码。
	 * 任何一次列目录失败都会让整次扫描失败：返回「少一半但看起来完整」的列表比失败更糟。
	 */
	async function collectEntries(tree: RemoteSessionTree, idPrefix: string, budget: Budget): Promise<RemoteSessionEntry[]> {
		const rootListing = await tree.list(".");
		chargeListing(budget, rootListing);

		const workspaceDirs: string[] = [];
		const candidates: string[] = [];
		for (const entry of rootListing) {
			if (entry.kind === "directory") {
				if (!SKIP_DIRECTORIES.has(entry.name)) workspaceDirs.push(entry.name);
				continue;
			}
			// 非 .jsonl 文件、以及 symlink/其它类型：不是会话文件，直接跳过（跳过不是错误）。
			if (entry.kind === "file" && isJsonlName(entry.name)) candidates.push(entry.name);
		}
		// 目录上限在列它们之前判断：越界就不必再为它们发 512+ 个帧。
		if (workspaceDirs.length > limits.maxWorkspaceDirs) throw new Error(REMOTE_SESSION_CODES.dirLimitExceeded);

		// 预算在 worker 里就扣：一旦越界就停止继续发列目录请求，而不是等 512 个目录都列完再判。
		const listings = await mapBounded(workspaceDirs, limits.concurrency, async (directory) => {
			const listing = await tree.list(directory);
			chargeListing(budget, listing);
			return listing;
		});
		for (let index = 0; index < workspaceDirs.length; index += 1) {
			const directory = workspaceDirs[index];
			const listing = listings[index];
			for (const entry of listing) {
				if (entry.kind === "file" && isJsonlName(entry.name)) candidates.push(directory + "/" + entry.name);
			}
		}
		// 文件上限同样在 stat 之前判断：越界是稳定码，不是截断。
		if (candidates.length > limits.maxFiles) throw new Error(REMOTE_SESSION_CODES.fileLimitExceeded);

		const entries = (
			await mapBounded(batches(candidates), limits.concurrency, async (batch) => {
				// 预算按**逻辑条目**扣：一次批量 RPC 仍然等于 batch.length 条描述，不能因为合成一个帧就少计。
				for (let index = 0; index < batch.length; index += 1) charge(budget, REMOTE_SESSION_STAT_OVERHEAD_BYTES);
				const described = await tree.statMany(batch);
				const collected: RemoteSessionEntry[] = [];
				for (const stat of described) {
					// 列表与描述之间类型变了（并发改名/替换）或文件已消失：跳过这条，不把非文件登记成会话。
					if (stat.kind !== "file") continue;
					collected.push({ remoteSessionId: idPrefix + stat.path, remotePath: idPrefix + stat.path, name: titleFromRemoteSessionId(stat.path), size: stat.bytes, mtimeMs: stat.mtimeMs });
				}
				return collected;
			})
		).flat();
		// 输出顺序固定（按远端身份升序）：同一棵远端目录树的两次扫描结果逐字可比。
		return entries.sort((left, right) => (left.remoteSessionId < right.remoteSessionId ? -1 : left.remoteSessionId > right.remoteSessionId ? 1 : 0));
	}

	return {
		// 导出物就是上面那个内部函数本身（同一个函数对象，不包一层）：语义逐字相同，没有第二条实现。
		resolveSessionRoot: roots.resolveSessionRoot,
		// 身份推导（含项目级命名空间）只允许一份实现，见 `remoteSessionRoots`。
		identityForPath: roots.identityForPath,
		async scan(hostId, projectId) {
			const host = readHostId(hostId);
			if (host === undefined) return { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid };
			// 项目级发现是产品口径（侧栏区块挂在项目下）；缺省的主机级扫描保留给旧调用点与测试。
			const scopedProjectId = typeof projectId === "string" && projectId.length > 0 ? projectId : undefined;
			if (projectId !== undefined && scopedProjectId === undefined) return { ok: false, code: REMOTE_SESSION_CODES.projectUnresolved };
			if (scopedProjectId === undefined) {
				const resolvedRoot = await roots.resolveSessionRoot(host);
				if (!resolvedRoot.ok) return { ok: false, code: resolvedRoot.code };
				try {
					const entries = await treeSource.withRoot(host, resolvedRoot.root, (tree) => collectEntries(tree, "", { remaining: limits.maxTotalBytes }));
					return { ok: true, entries };
				} catch (error) {
					return { ok: false, code: stableCodeOf(error) ?? REMOTE_SESSION_CODES.scanFailed };
				}
			}
			const scanRoots = await roots.resolveScanRoots(host, scopedProjectId);
			if (!scanRoots.ok) return { ok: false, code: scanRoots.code };
			// 多个根共享同一份字节预算：上限是「一次扫描」的上限，不是「每个根各自一份」。
			const budget: Budget = { remaining: limits.maxTotalBytes };
			try {
				const seen = new Set<string>();
				const entries: RemoteSessionEntry[] = [];
				for (const spec of scanRoots.roots) {
					let collected: RemoteSessionEntry[];
					try {
						// 两种实现共用这一句：注入 transport 时是一次性命令（不切 root），否则是 helper 会话。
						collected = await treeSource.withRoot(host, spec.root, (tree) => collectEntries(tree, spec.idPrefix, budget));
					} catch (error) {
						// 目录还不存在（项目还没有任何会话）不是失败：跳过这个根，其余根照常。
						if (stableCodeOf(error) === PATH_NOT_FOUND) continue;
						throw error;
					}
					for (const entry of collected) {
						if (seen.has(entry.remoteSessionId)) continue;
						seen.add(entry.remoteSessionId);
						entries.push(entry);
						// 文件上限是「一次扫描」的上限：多个根合并后也要守，否则看起来完整的列表可能超出约定体量。
						if (entries.length > limits.maxFiles) throw new Error(REMOTE_SESSION_CODES.fileLimitExceeded);
					}
				}
				return { ok: true, entries: entries.sort((left, right) => (left.remoteSessionId < right.remoteSessionId ? -1 : left.remoteSessionId > right.remoteSessionId ? 1 : 0)) };
			} catch (error) {
				// 稳定码原样转述（连接层/命令源/reader 各自有自己的码），未知异常才折叠成 scanFailed。
				return { ok: false, code: stableCodeOf(error) ?? REMOTE_SESSION_CODES.scanFailed };
			}
		},
		async register(input) {
			const host = readHostId(input?.hostId);
			if (host === undefined) return { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid };
			const remoteSessionId = readRemoteSessionId(input?.remoteSessionId);
			// 非法 id 一个帧都不发：形状不合法就不可能是一次远端发现。
			if (remoteSessionId === undefined) return { ok: false, code: REMOTE_SESSION_CODES.idInvalid };
			if (catalog === undefined) return { ok: false, code: REMOTE_SESSION_CODES.catalogUnavailable };
			// 归属先判（同步、零远端往返）：没有可写的地方就不该建立会话、也不该为必失败的操作发远端请求。
			const ownership = roots.resolveProjectIdForSessionId(host, remoteSessionId);
			if (!ownership.ok) return { ok: false, code: ownership.code };
			const projectId = ownership.projectId;
			const located = await roots.resolveRootForRemoteSessionId(host, remoteSessionId);
			if (!located.ok) return { ok: false, code: located.code };
			const remotePath = located.root + "/" + located.relative;
			try {
				// 登记前先在远端确认这条 id 现在仍是一个普通文件：远端 id 不能凭空编造。
				// 描述走与扫描同一个树面（单条 statMany 与单条 stat 逐字段同义）：注入 transport 时不切 root。
				const described = await treeSource.withRoot(host, located.root, (tree) => tree.statMany([located.relative]));
				const stat = described[0];
				if (stat === undefined) return { ok: false, code: REMOTE_SESSION_CODES.registerFailed };
				// 两个码与 helper 通道逐字一致：路径消失 ⇒ PATH_NOT_FOUND，存在的非普通文件 ⇒ NOT_A_FILE。
				if (stat.kind === "missing") return { ok: false, code: PATH_NOT_FOUND };
				if (stat.kind !== "file") return { ok: false, code: "NOT_A_FILE" };
				// 登记写**绝对** remotePath（默认根之下也一样）：远端读/写/归档本来就优先用绝对路径，
				// 这样登录后不必再猜会话根；旧记录（相对 remotePath）继续走根解析兜底。
				const registration = await catalog.ensureRemoteSession({ projectId, hostId: host, remoteSessionId, remotePath, title: titleFromRemoteSessionId(remoteSessionId), updatedAt: stat.mtimeMs });
				return { ok: true, sessionId: registration.record.id, created: registration.created, remoteSessionId, remotePath };
			} catch (error) {
				return { ok: false, code: stableCodeOf(error) ?? REMOTE_SESSION_CODES.registerFailed };
			}
		},
		async title(input) {
			const host = readHostId(input?.hostId);
			if (host === undefined) return { ok: false, code: REMOTE_SESSION_CODES.hostIdInvalid };
			const remoteSessionId = readRemoteSessionId(input?.remoteSessionId);
			if (remoteSessionId === undefined) return { ok: false, code: REMOTE_SESSION_CODES.idInvalid };
			const located = await roots.resolveRootForRemoteSessionId(host, remoteSessionId);
			if (!located.ok) return { ok: false, code: located.code };
			const root = located.root;
			const relative = located.relative;
			try {
				// 只读：整次解析在同一个树面上完成（帧预算 = 1 次头读 +（仅在头不足时）1 次尾窗读，各自 ≤64 KiB）；
				// 刻意不接收也不需要 catalog —— 标题通道不写盘（写盘仍只属于 register）。
				const outcome = await treeSource.withRoot(host, root, async (tree) => {
					const head = await tree.readHead(relative, REMOTE_WORKSPACE_MAX_HEAD_BYTES);
					// 头尾可能截断多字节字符：fatal:false 会得到 U+FFFD，落在最后一行 → 该行 JSON.parse 失败被跳过。
					const headText = new TextDecoder().decode(head.content);
					const headInference = inferSessionTitleFromHeadText(headText);
					// 头内已经有权威名（session_info 或旧版私有 sessionName 行）就够了：不读尾。
					if (isAuthoritativeTitle(headInference)) return { inference: headInference, tailDegraded: false };
					// 头已经覆盖整个文件（size ≤ 头上限）：尾窗口就是同一段内容，不重复读。
					if (head.size <= REMOTE_WORKSPACE_MAX_HEAD_BYTES) return { inference: headInference, tailDegraded: false };
					// pi 的 `/name` 是**追加在文件尾**的，所以只有头不足时才补一次有界尾窗口。
					// 尾读复用头读的 size ⇒ 全程只有 1 次 sizing stat；尾读是增益步骤：失败降级为头部结果
					// （与本地 readHeadAndInfer 的 best-effort 口径一致），而头读失败仍然按稳定码拒绝——
					// 那时连文件是否存在都没有证据。
					try {
						// 零重叠（K2-2）：尾窗起点取**头窗结束处**与「贴住文件尾」两者中更靠后的一个。
						// size > 128 KiB 时与原来一致（就是最后 ≤64 KiB）；64 KiB < size < 128 KiB 时只读头窗
						// 没覆盖的那段，不再重复传输头窗覆盖过的字节。
						const offset = Math.max(head.bytes, head.size - REMOTE_WORKSPACE_MAX_WINDOW_BYTES);
						const tail = await tree.readWindow(relative, { offset, maxBytes: REMOTE_WORKSPACE_MAX_WINDOW_BYTES, size: head.size });
						if (tail.bytes === 0) return { inference: headInference, tailDegraded: false };
						// 同一套解析器跑 head + tail（本地 readHeadAndInfer 也是把两个窗口拼起来解析一次）：
						// 权威名优先，弱兜底仍取最早一条 user 文本（头窗口在前）。
						return { inference: inferSessionTitleFromHeadText(headText + "\n" + new TextDecoder().decode(tail.content)), tailDegraded: false };
					} catch {
						// 尾读失败**不再静默**（K2-3）：标题与档位仍是头部那份（诚实降级、绝不编造），
						// 但把「尾窗没读到」这件事如实带给调用方与界面。
						return { inference: headInference, tailDegraded: true };
					}
				});
				const { inference, tailDegraded } = outcome;
				// tailDegraded 只在**真的降级**时出现（缺省即正常）：不给 shared 契约与既有 deepEqual 加噪声。
				const degraded = tailDegraded ? { tailDegraded: true } : {};
				// 解析不出绝不编造：强制 fallback 到文件名 stem（与 G3 的暂定标题同一取值）。
				if (inference.name === undefined) return { ok: true, title: titleFromRemoteSessionId(remoteSessionId), titleOrigin: "fallback", ...degraded };
				// 档位如实区分（口径冻结 authoritative/inferred/fallback）：来自名字字段 = authoritative
				// （含旧版私有 sessionName 行——本地 scannedTitleOrigin 对同一判据落 manual）；首条消息弱兜底 = inferred。
				return { ok: true, title: inference.name, titleOrigin: isAuthoritativeTitle(inference) ? "authoritative" : "inferred", ...degraded };
			} catch (error) {
				return { ok: false, code: stableCodeOf(error) ?? REMOTE_SESSION_CODES.titleFailed };
			}
		},
	};
}
