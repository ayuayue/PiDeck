/**
 * 远端会话的**身份与路径词汇**（纯函数 + 常量，不做任何远端访问）。
 *
 * 为什么单独成模块：会话身份（`remoteSessionId`）有两套命名空间——默认根沿用 pi 的
 * `<encoded-cwd>/<file>.jsonl`，项目级 `sessionDir` 用 `project:<encoded-cwd>/<file>.jsonl`——而
 * 「扫描发现的 id」与「运行时上报路径折出的 id」必须逐字相同，否则同一文件会出现两条侧栏记录。
 * 把「根在哪个形状里、id 怎么拼、哪些形状拒收」收在这里，扫描器与根解析都只引用这一份。
 *
 * 本模块不 import 扫描器（避免循環），稳定码也在这边定义、由扫描器转出。
 */

/** 项目级会话根在 `remoteSessionId` 里的命名空间前缀。 */
export const REMOTE_SESSION_PROJECT_ID_PREFIX = "project:";

/** remoteSessionId 的长度上限：shared 的 `SessionLocator.remoteSessionId` 就是这个域。 */
export const REMOTE_SESSION_MAX_ID_LENGTH = 256;
/** remotePath 的长度上限：shared 的 `SessionLocator.remotePath` 域。 */
export const REMOTE_SESSION_MAX_PATH_LENGTH = 4096;

/** 会话根的**默认值**相对远端 home 的后缀（pi 未配置 `sessionDir` 时就是它）。 */
export const REMOTE_SESSION_ROOT_SUFFIX = ".pi/agent/sessions";
/** pi 的 user-level agent 目录（`<remote home>/.pi/agent`）：`settings.json` 与默认 sessions 都在它下面。 */
export const REMOTE_SESSION_AGENT_DIR_SUFFIX = ".pi/agent";
/** pi 的配置文件：user-level 与项目级都叫这个名字。 */
export const REMOTE_SESSION_SETTINGS_FILE_NAME = "settings.json";

/** 远端会话域的稳定码（消息即码；调用方按字符串判定，绝不按措辞）。 */
export const REMOTE_SESSION_CODES = {
	/** hostId 不是可用的诊断身份/传输键。 */
	hostIdInvalid: "REMOTE_SESSION_HOST_ID_INVALID",
	/** 远端 home 解析不出（remoteHome 返回 undefined/空/非绝对路径）。 */
	homeUnavailable: "REMOTE_SESSION_HOME_UNAVAILABLE",
	/** remoteSessionId 不是合法的「相对会话根的 POSIX .jsonl 路径」。 */
	idInvalid: "REMOTE_SESSION_ID_INVALID",
	/** 工作区目录数越过硬上限。 */
	dirLimitExceeded: "REMOTE_SESSION_DIR_LIMIT_EXCEEDED",
	/** 会话文件数越过硬上限。 */
	fileLimitExceeded: "REMOTE_SESSION_FILE_LIMIT_EXCEEDED",
	/** 元数据字节预算耗尽。 */
	budgetExceeded: "REMOTE_SESSION_BUDGET_EXCEEDED",
	/** 会话归属解析不出（多项目且按目录判不出，或项目命名空间对不上）。 */
	projectUnresolved: "REMOTE_SESSION_PROJECT_UNRESOLVED",
	/** 装配没有提供 catalog 端口（旧装配/正式包）。 */
	catalogUnavailable: "REMOTE_SESSION_CATALOG_UNAVAILABLE",
	/** catalog 写入失败且自身不带稳定码。 */
	registerFailed: "REMOTE_SESSION_REGISTER_FAILED",
	/** 扫描过程中出现了不带稳定码的异常。 */
	scanFailed: "REMOTE_SESSION_SCAN_FAILED",
	/** 按需标题解析过程中出现了不带稳定码的异常。 */
	titleFailed: "REMOTE_SESSION_TITLE_FAILED",
	/** 配置里的 sessionDir 不可用（非字符串/相对路径/控制字节/越出边界）：拒绝而不是静默扫错目录。 */
	sessionDirInvalid: "REMOTE_SESSION_SESSION_DIR_INVALID",
	/** pi 上报的会话文件折不成（相对会话根的）身份：不猜、不截断。 */
	locatorUnresolved: "REMOTE_SESSION_LOCATOR_UNRESOLVED",
} as const;

/** 该主机上的一个远端项目（扫描根与项目归属的候选）。 */
export type RemoteSessionProjectCandidate = { readonly id: string; readonly remotePath: string };

/** 远端会话归属哪个本地项目由装配决定（扫描器不解析正文，无法自行推断）。 */
export type RemoteSessionProjectResolver = (hostId: string, remoteSessionId: string) => string | undefined;

/** 「pi 上报的绝对路径 → catalog 身份」的结果：折不出来一律稳定码，不猜一个 id 写进 catalog。 */
export type RemoteSessionIdentityResolution = { readonly ok: true; readonly remoteSessionId: string } | { readonly ok: false; readonly code: string };

/** 远端拒绝控制字节；这里也不把它们当成词汇的一部分。 */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * POSIX 路径规范化：折叠空段与 `.`，解析 `..`；试图越过根（`..` 逃逸）或结果为空返回 undefined。
 * 远端会话根必须是一个确定的绝对路径，规范化是「仍在 home 之内」判定的前提。
 */
export function normalizePosixPath(path: string): string | undefined {
	const segments: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return undefined;
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.length === 0 ? undefined : "/" + segments.join("/");
}

/** home 判据与 G3 逐字一致（绝对 POSIX、长度受限、无控制字节），额外去掉尾部斜杠。 */
export function readRemoteHome(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_SESSION_MAX_PATH_LENGTH || CONTROL_CHARS.test(value) || !value.startsWith("/")) return undefined;
	return value === "/" ? "/" : value.replace(/\/+$/, "");
}

/** 远端项目根/会话根的绝对形状（与 home 同一判据，但不去尾斜杠以外的语义）。 */
export function isAbsoluteRemotePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= REMOTE_SESSION_MAX_PATH_LENGTH && !CONTROL_CHARS.test(value) && value.startsWith("/");
}

/**
 * 校验并规范化 **user-level** 配置里的 `sessionDir`（返回 undefined = 不可用）。
 *
 * 支持 pi 的 `~` 展开语义（CHANGELOG #3514：settings.json 里的 sessionDir 会展开 `~`）；`~user` 需要远端
 * passwd，helper 没有这个操作 ⇒ 拒绝。**拒绝而不是退回默认根**的理由：pi 的相对路径是按**会话自己的 cwd**
 * 解析的（pi docs/settings.md:64），主机级扫描在原理上不可能正确；退回默认根会给出「看起来正常但是错的
 * 列表」——那正是「发现不了比报错更糟」要避免的形态。越出 home 之外的目录同样拒绝（扫描边界只承诺 home 内）。
 */
export function resolveConfiguredSessionDir(value: string, home: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > REMOTE_SESSION_MAX_PATH_LENGTH || CONTROL_CHARS.test(trimmed)) return undefined;
	const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? home + trimmed.slice(1) : trimmed;
	if (!expanded.startsWith("/")) return undefined;
	const normalized = normalizePosixPath(expanded);
	if (normalized === undefined) return undefined;
	if (normalized !== home && !normalized.startsWith(home + "/")) return undefined;
	return normalized;
}

/**
 * 项目级 `sessionDir` 解析（pi 语义：相对值按**会话自己的 cwd** = 项目根解析，绝对值原样使用，`~` 展开）。
 *
 * 与 user-level 的差别：这里**允许**指向 home 之外。项目级配置是用户针对这个目录显式写的，而项目根本身
 * 就可能不在 home 下；把合法配置拒掉等于让项目里的会话永远发现不了。
 */
export function resolveProjectConfiguredSessionDir(value: string, home: string | undefined, projectRoot: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > REMOTE_SESSION_MAX_PATH_LENGTH || CONTROL_CHARS.test(trimmed)) return undefined;
	const expanded = trimmed === "~" && home !== undefined ? home : trimmed.startsWith("~/") && home !== undefined ? home + trimmed.slice(1) : trimmed;
	if (expanded.startsWith("/")) return normalizePosixPath(expanded);
	// `~user` 需要 passwd，helper 没有这个操作：明确拒绝（不退回默认根，免得给出错的列表）。
	if (expanded.startsWith("~")) return undefined;
	return normalizePosixPath(projectRoot + "/" + expanded);
}

/**
 * 从 `remoteSessionId` 里读出项目命名空间。非项目前缀返回 undefined；前缀格式不对返回 null（= 非法 id）。
 * 单独一个函数是为了让「扫描拼 id」与「登记/标题解 id」只看同一段规则。
 */
export function readProjectSessionId(remoteSessionId: string): { encodedCwd: string; relative: string } | null | undefined {
	if (!remoteSessionId.startsWith(REMOTE_SESSION_PROJECT_ID_PREFIX)) return undefined;
	const rest = remoteSessionId.slice(REMOTE_SESSION_PROJECT_ID_PREFIX.length);
	const index = rest.indexOf("/");
	if (index <= 0 || index === rest.length - 1) return null;
	return { encodedCwd: rest.slice(0, index), relative: rest.slice(index + 1) };
}

/**
 * pi 上报的远端会话文件 → `remoteSessionId`（相对会话根的 POSIX 路径），折不出来返回 undefined。
 *
 * **只做一件事：去掉根前缀。** pi 的两种布局都由此得到正确的 id：默认根是
 * `<root>/--<encoded-cwd>--/<file>.jsonl`（id 带一层工作区目录），user-level `sessionDir` 是平铺
 * `<root>/<file>.jsonl`。所以按 `/` 切出文件名是错的（丢掉一层身份），复刻 pi 的 cwd 编码更是把它的
 * 实现细节抄进 PiDeck——两者都明确不做。
 *
 * 判据是**逐段严格**而不是「规范化后再比较」：`.` / `..` / 空段 / 尾斜杠一律拒绝。根前缀按
 * `root + "/"` 比，因此 `/srv/sessions-extra/x.jsonl` 不属于 `/srv/sessions` 这类误匹配不会被当成命中。
 */
export function remoteSessionIdWithinRoot(root: string, remotePath: string): string | undefined {
	if (!isAbsoluteRemotePath(remotePath) || remotePath.includes("\\")) return undefined;
	const prefix = root.endsWith("/") ? root : root + "/";
	if (!remotePath.startsWith(prefix)) return undefined;
	const relative = remotePath.slice(prefix.length);
	if (relative.length === 0 || relative.length > REMOTE_SESSION_MAX_ID_LENGTH) return undefined;
	for (const segment of relative.split("/")) {
		if (segment.length === 0 || segment === "." || segment === "..") return undefined;
	}
	return relative;
}
