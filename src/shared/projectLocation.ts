/**
 * 项目位置的判别窄化（纯函数，三层共用）。
 *
 * Phase 3 第二段起 `Project` 是 local/remote 判别联合：远端项目**没有** `path`，因此所有
 * 「把 `project.path` 当本机路径用」的消费点都会在类型层被编译器逐个点名，而不是运行期
 * 才发现传进来一个远端字符串。这两个助手是窄化的唯一出处：本地分支返回带 `path` 的类型，
 * 远端分支由调用方显式处理（拒绝 / 路由到远端服务），不允许用 `!` 或 `as` 绕过。
 */
import type { LocalProject, Project, ProjectLocator, RemoteProject } from "./types/project";
import type { SessionLocator } from "./types/session";

/** 本机（含 WSL）项目：拥有 `path`，可交给 `node:fs`/Git/终端等本机实现。 */
export function isLocalProject(project: Project): project is LocalProject {
	return !("locator" in project) || project.locator.kind !== "ssh";
}

/** 远端 (SSH) 项目：只有 `{ hostId, remotePath }`，任何本机路径消费者都必须拒绝它。 */
export function isRemoteProject(project: Project): project is RemoteProject {
	return "locator" in project && project.locator.kind === "ssh";
}

/**
 * 取本机路径；远端项目返回 `undefined`。
 *
 * 供「远端应被拒绝，但拒绝方式是实现细节」的边界使用（例如 presence 探测、日志）。凡是
 * 结果会被写盘或交给 `node:fs` 的地方都必须用 `isLocalProject` 显式分支，不能靠这个函数
 * 把 `undefined` 继续往下传。
 */
export function localProjectPath(project: Project): string | undefined {
	return isLocalProject(project) ? project.path : undefined;
}

/**
 * ssh 项目 locator 的唯一判据（写入侧、codec 读取、主机引用扫描三处共用）。
 *
 * 值域裁定的依据（跨 store 一致性）：
 * - `hostId` 是 `RemoteHostStore` 的 profile 主键。该 store 用 `randomUUID()` 生成 id，其 codec
 *   （以及 pin / bootstrap / 连接诊断 / rebind 等每一个 hostId 消费者）只接受这个 UUID 形状，
 *   登记 IPC 也在发起确认前先用同一正则校验。所以**非 UUID 的 hostId 永远不可能命中任何主机**：
 *   它既不是一份合法远端项目，也不能被当成「某个主机的引用」。写入侧拒绝它、读取侧拒绝它、
 *   扫描侧也拒绝它，是同一件事的三处表述 —— 不是把扫描放宽成「任何非空字符串」。
 * - `remotePath` 与 `RemoteBrowseRoot.readCanonicalBrowseRoot` 同域（绝对 POSIX、非根、无尾斜杠、
 *   无空/`.`/`..` 段、≤4096、无控制字节），因为写入侧唯一来源就是那里确认过的 canonical 值，
 *   放行集不会比它更窄，既有合法项目不会被拒。
 *
 * shared 是纯契约层：这里只做字符串校验，不依赖任何运行时模块。
 */
export const PROJECT_HOST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 远端路径长度上界，与 `RemoteBrowseRoot` 交给 helper 的 `--root` 上界保持一致（4096）。 */
export const MAX_PROJECT_REMOTE_PATH = 4096;

const PROJECT_PATH_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 远端项目 locator 的窄化形状（`ProjectLocator` 的 ssh 分支）。 */
export type SshProjectLocator = Extract<ProjectLocator, { kind: "ssh" }>;

/** canonical 远端目录：绝对 POSIX、非根、无尾斜杠、无空/`.`/`..` 段、有界、无控制字节。 */
export function readCanonicalRemoteProjectPath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROJECT_REMOTE_PATH) return undefined;
	if (PROJECT_PATH_CONTROL_CHARS.test(value)) return undefined;
	if (!value.startsWith("/") || value === "/" || value.endsWith("/")) return undefined;
	const segments = value.slice(1).split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
	return value;
}

/**
 * 校验一条 ssh 项目 locator（`{ kind: "ssh", hostId, remotePath }`），非法返回 undefined。
 * 写入、读取、扫描共用这一个判据；调用方不得各自再加一套更宽或更窄的规则（那正是
 * 「写入可通过、加载被整份拒绝」的来源）。
 */
export function readSshProjectLocator(value: unknown): SshProjectLocator | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.kind !== "ssh") return undefined;
	if (typeof record.hostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(record.hostId)) return undefined;
	const remotePath = readCanonicalRemoteProjectPath(record.remotePath);
	if (remotePath === undefined) return undefined;
	return { kind: "ssh", hostId: record.hostId, remotePath };
}

/**
 * 校验持久化 locator（local / ssh 两支），非法返回 undefined。codec 读取与引用扫描共用，
 * 保证「codec 能加载的记录」与「扫描能解释的记录」是同一个集合。
 *
 * local 分支额外拒绝 `hostId`：本地 locator 不该携带主机引用。若放行，扫描会把一条指向某主机的
 * 主机引用读成「本地项目 ⇒ 没有引用」，退役流程据此硬删仍被引用的主机 —— 这正是本函数存在的
 * 唯一理由之一。
 */
export function readProjectLocator(value: unknown): ProjectLocator | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.kind === "local") {
		if (record.hostId !== undefined) return undefined;
		if (record.environment !== "native" && record.environment !== "wsl") return undefined;
		if (typeof record.localPath !== "string" || !record.localPath.trim()) return undefined;
		if (record.wslDistro !== undefined && typeof record.wslDistro !== "string") return undefined;
		// 第 11 步的新字段：wslHostId 是 WSL 档案主键（UUID），wslUser 是 Linux 用户。
		// native 项目带这些字段属于写入侧混淆，整条拒绝而不是忽略。
		if (record.wslUser !== undefined && (typeof record.wslUser !== "string" || !/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/u.test(record.wslUser))) return undefined;
		if (record.wslHostId !== undefined && (typeof record.wslHostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(record.wslHostId))) return undefined;
		if (record.environment !== "wsl" && (record.wslUser !== undefined || record.wslHostId !== undefined)) return undefined;
		return {
			kind: "local",
			environment: record.environment,
			localPath: record.localPath,
			...(typeof record.wslDistro === "string" ? { wslDistro: record.wslDistro } : {}),
			...(typeof record.wslUser === "string" ? { wslUser: record.wslUser } : {}),
			...(typeof record.wslHostId === "string" ? { wslHostId: record.wslHostId } : {}),
		};
	}
	if (record.kind === "ssh") return readSshProjectLocator(record);
	return undefined;
}

/** 会话身份字段的既有值域（与 SessionCatalog 历史判据逐字一致：收窄 hostId 不改变这些字段的放行集）。 */
const MAX_SESSION_REMOTE_PATH = 4096;
const MAX_SESSION_REMOTE_ID = 256;
const MAX_SESSION_PATH_ALIASES = 32;

/** ssh 会话 locator 的窄化形状（`SessionLocator` 的 ssh 分支）。 */
export type SshSessionLocator = Extract<SessionLocator, { kind: "ssh" }>;

/**
 * ssh 会话 locator 的唯一判据（catalog 读取 / 远端登记写入 / 主机引用扫描三处共用）。
 *
 * `hostId` 与项目域共用同一个权威取值域 `PROJECT_HOST_ID_PATTERN`：它只可能是 RemoteHostStore 用
 * `randomUUID()` 生成的 profile 主键，非 UUID 永远命中不了任何主机 —— 既不是合法的远端会话身份，
 * 也不能被当成「某个主机的引用」。所以这里不是把扫描放宽成「任意非空字符串」，而是把 catalog 读取
 * 与登记写入一起收窄到 UUID；否则同一记录会出现「catalog 放行、扫描抛错」。
 *
 * 会话专用字段保持既有值域且**全部可选**：`remotePath`（会话文件身份，≤4096）、`remoteSessionId`
 * （≤256）、`remotePathAliases`（≤32 × ≤4096）。G3 早期只写 remoteSessionId、或只带 hostId 的历史
 * 记录因此仍然合法，不会因为本次收窄被拒。注意会话的 remotePath 是相对会话根的身份，不是 canonical
 * 授权根，所以这里刻意不复用 `readSshProjectLocator`（那会把历史记录整片拒掉）。
 */
export function readSshSessionLocator(value: unknown): SshSessionLocator | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.kind !== "ssh") return undefined;
	if (typeof record.hostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(record.hostId)) return undefined;
	if (record.remotePath !== undefined && (typeof record.remotePath !== "string" || record.remotePath.length > MAX_SESSION_REMOTE_PATH)) return undefined;
	if (record.remoteSessionId !== undefined && (typeof record.remoteSessionId !== "string" || record.remoteSessionId.length > MAX_SESSION_REMOTE_ID)) return undefined;
	let remotePathAliases: string[] | undefined;
	if (record.remotePathAliases !== undefined) {
		if (!Array.isArray(record.remotePathAliases) || record.remotePathAliases.length > MAX_SESSION_PATH_ALIASES) return undefined;
		const aliases: string[] = [];
		for (const alias of record.remotePathAliases) {
			if (typeof alias !== "string" || alias.length > MAX_SESSION_REMOTE_PATH) return undefined;
			aliases.push(alias);
		}
		remotePathAliases = aliases;
	}
	return {
		kind: "ssh",
		hostId: record.hostId,
		...(typeof record.remotePath === "string" ? { remotePath: record.remotePath } : {}),
		...(typeof record.remoteSessionId === "string" ? { remoteSessionId: record.remoteSessionId } : {}),
		...(remotePathAliases ? { remotePathAliases } : {}),
	};
}

/**
 * 项目是否可能有项目级资源目录（`.pi` / `.agents`）。
 *
 * chat 项目（会话工作区）没有。**写**要拒绝（`requireProject` 抛错），**读**要空集 ——
 * 判定在这里，调用点自己决定拒绝还是返回空列表。
 *
 * 反例（2026-11-26 真机）：`prompts:list-by-project` 走写路径守卫 `getProjectRoot()`，
 * chat 项目上每次调用都抛 `mainProjectResource.chatUnsupported`，配置页一打开 Prompts
 * 标签，主进程日志就刷满同样的堆栈。
 */
export function projectAllowsResources(project: { kind?: unknown } | undefined): boolean {
	return project !== undefined && project.kind !== "chat";
}
