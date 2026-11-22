/**
 * 远端会话历史的**有界窗口读取**（远端历史唯一读路径）。
 *
 * 为什么需要它：远端会话的 catalog 记录是 ssh locator，`normalizeEntryLocator` 已把 `filePath` 清空
 * （远端路径进本机字段正是要禁止的事）。于是既有的「读消息页」链路走到 `!sessionFilePath` 分支，
 * 拿 ImageSession 兜底 → 一个空页被 force 写进渲染层缓存 ⇒ 重启后点开远端会话看起来「没有历史」。
 * 本模块把那条链路按 locator 路由到**远端有界读取**上来。
 *
 * 为什么走 SSH 短命令而不是 helper 的 `fs.*`：
 * - helper 的 `--root` 是**每连接一个目录**（`RemoteHelperCommand`），会话文件在用户 home 下，
 *   不在项目 root 之内 ⇒ `fs.read` 只会得到 `PATH_OUTSIDE_ROOT`；要读它就得改 helper 的 root 语义
 *   或新增 op，而「零新增 helper op」是本阶段的既定决定（见 docs/archive/remote/remote-phase4-plan.md §3.6 后的
 *   冻结纪律）。
 * - 因此这里用既有 pinned SSH 通道执行**有界**读取命令（`tail`/`head`），复用 `buildPinnedSshInvocation`
 *   一系的 pin/指纹校验（禁止 ssh-keyscan、禁止把远端路径交给本机 fs）。
 *
 * 不变量：
 * - **字节上界**：单次窗口 ≤ `REMOTE_SESSION_HISTORY_WINDOW_BYTES`（2 MiB），命令参数只出现这个
 *   上界，绝不出现「整文件大小」；请求越界是**拒绝**（构造期 `..._OPTIONS_INVALID`），不是悄悄截断。
 *   一页可以连续取多个窗口（`REMOTE_SESSION_HISTORY_WINDOW_SKIPS`），但每个窗口各自仍受此上界。
 * - **窗口边界对齐行**：起点落在行中间丢半截行（当页不再显示它），终点被窗口截断时同样丢掉尾巴——
 *   半行 JSON 解析出来只会是脏数据。
 * - **失败结构化**：ssh/命令失败、输出里找不到标记、元数据畸形各有稳定码，绝不把裸异常或路径外传；
 *   命令行与远端 stderr 只进本地日志，不进返回结构。
 * - **损坏行 fail-soft**：单行 JSON 坏掉只跳过并计数（当页仍返回其余消息），不炸整页。
 *
 * 已知取舍（如实记录，不要当成已完成）：
 * - 远端分页游标是**字节偏移**（`nextBefore` = 本页最早一行在文件里的 1-based 起始偏移），不是本地那套
 *   「活动分支消息下标」。两者都满足 `SessionMessagePage` 的 `nextBefore: number | null` 契约，
 *   渲染层的「加载更早」据此翻页；但页边界只对齐**行**，不对齐本地那种「完整轮次」。
 * - `total` 是本窗口解析出的消息条数（下界）。远端不读整文件就无法给出活动分支消息总数，本地语义的
 *   `total` 在远端不成立；「还有更早历史」只由 `nextBefore !== null` 决定（渲染层也是这么用的）。
 * - `activeBranch` 只按**窗口内**的 parentId 链回溯（`buildActiveBranchEntryIds`）：窗口之外的祖先不可见，
 *   因此窗口首条之后的分支归属与本地整文件索引可能不同。
 * - **单行比一页上界还大时仍不可见**（罕见的超大图片消息）：一个窗口装不下整行就无法 JSON 解析，
 *   而它的缺失会断开 parentId 链，使更早的消息取不到。窗口上界现在是 2 MiB，能整行容纳本机实测的
 *   984 KiB 最大行及超过旧上界的截图消息；更大的单行仍需分段解析才能消除这条限制。
 * - 传输层是本机 ssh 客户端的 `execFile`（`SshClientRuntime.run`，`encoding: "utf8"`，缺省 maxBuffer
 *   256 KiB，历史读取显式放宽到 `REMOTE_SESSION_HISTORY_TRANSPORT_BYTES`）：
 *   文件里的非法 UTF-8 字节会被解码成替换字符（该行因此解析失败并被跳过，仍属 fail-soft），而按字节
 *   计算游标时以 `Buffer.byteLength` 回算——合法 UTF-8 下逐字节精确，含非法字节的极端文件可能偏移几个
 *   字节，表现为边界行被当成半行丢掉（不会串行、不会越界读）。
 */

import { randomBytes } from "node:crypto";
// hostId 与 ssh 身份判据只允许有一份：与持久化边界共用 shared 的权威取值域。
import { PROJECT_HOST_ID_PATTERN, readSshSessionLocator, type SshSessionLocator } from "../../shared/projectLocation";
import { buildActiveBranchEntryIds } from "../pi/AgentMessageProjector";
import { buildTimelineProjection, type ProjectedSessionEntry } from "../pi/sessionContextProjection";
import { isRoleMessageRole } from "../pi/sessionEntryIds";
import type { ChatMessage, SessionMessagePage } from "../../shared/types";

/** 单次窗口的字节上界（硬上界：请求超过它即拒绝，不 clamp）。
 *
 * 2026-12 由 128 KiB 提到 1 MiB。依据是真实会话文件：pi 把「带截图/图片的用户消息」写成**一整行**
 * JSONL，实测单行 347 KiB、681 KiB。128 KiB 的旧上界会让整页窗口落在这类行内部，分页于是
 * 停在行中间并把「没有完整行」误当成「到文件头」——用户症状就是「远端项目里往上翻翻不上去、
 * 自己发过的消息全找不到」（那条超长行之前的全部历史永久不可达）。
 * 1 MiB 能整行容纳这类消息；顺带把 20 MB 会话的上翻次数从 159 次降到 20 次。 */
export const REMOTE_SESSION_HISTORY_WINDOW_BYTES = 2 * 1024 * 1024;

/**
 * 传输层单次输出的字节上界。
 *
 * `SshClientRuntime.run` 的 execFile 缺省只给 256 KiB；历史读取显式放宽到这条线（
 * `runPinnedRemoteCommand` 的 `maxBuffer`），否则一页 1 MiB 会被传输层判成输出超界。
 * 这个常量的唯一用途就是让「窗口上界 < 传输上界」成为可断言的算术，而不是注释里的口头承诺。
 */
export const REMOTE_SESSION_HISTORY_TRANSPORT_BYTES = 4 * 1024 * 1024;

/**
 * 一页最多连续跨过多少个「没有完整行的窗口」。
 *
 * 超过一页上界的单行（罕见的大图消息）永远读不全：窗口整块落在行内时没有可解析的行，但位置仍在往前。
 * 跨窗重试让它不堵住分页（每页最多再往前推这么多窗口），而不是把「读不到内容」说成「到文件头」。
 */
export const REMOTE_SESSION_HISTORY_WINDOW_SKIPS = 4;

/** 本模块的稳定码词汇（构造期错误码见 `REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID`）。 */
export const REMOTE_SESSION_HISTORY_CODES = {
	/** hostId 不是可用的诊断身份/传输键。 */
	hostIdInvalid: "REMOTE_SESSION_HISTORY_HOST_ID_INVALID",
	/** locator 不是合法 ssh 身份（含 remotePath 长度越界）。 */
	locatorInvalid: "REMOTE_SESSION_HISTORY_LOCATOR_INVALID",
	/** 远端路径既不是绝对路径、也推不出会话根（相对身份 + 没有根解析端口）。 */
	pathUnresolved: "REMOTE_SESSION_HISTORY_PATH_UNRESOLVED",
	/** 远端路径不可用（非绝对/控制字节/含单引号/超长）：绝不把它拼进命令行。 */
	pathInvalid: "REMOTE_SESSION_HISTORY_PATH_INVALID",
	/** 传输层失败（ssh 起不来、超时、输出超上界）且自身不带稳定码。 */
	transportFailed: "REMOTE_SESSION_HISTORY_TRANSPORT_FAILED",
	/** 远端命令退出码非 0（stderr 不外传）。 */
	commandFailed: "REMOTE_SESSION_HISTORY_COMMAND_FAILED",
	/** stdout 里找不到本次调用的标记：输出不可信（横幅/噪声/对端不是我们预期的 shell）。 */
	markerMissing: "REMOTE_SESSION_HISTORY_MARKER_MISSING",
	/** 标记之后的元数据（文件字节数）解析不出来。 */
	metadataInvalid: "REMOTE_SESSION_HISTORY_METADATA_INVALID",
	/** 读取期间文件换代且重读后仍变化：不把它伪装成文件头。 */
	stale: "REMOTE_SESSION_HISTORY_STALE",
	/** 装配没提供读端口（旧装配/正式包）。 */
	readerUnavailable: "REMOTE_SESSION_HISTORY_UNAVAILABLE",
} as const;

/** 构造期参数不合法（与其它远端模块一致，构造即抛，不等到第一次读）。 */
export const REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID = "REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID";

/** 标记里允许出现的字符：本地随机 hex，命令与解析两侧共用同一形状。 */
const NONCE = /^[A-Za-z0-9]{8,64}$/;

/**
 * 本次调用的标记字面量。构造命令与解析输出**必须**用同一个函数：两侧各写一份迟早漂移成
 * 「标记永远找不到」——而那时的症状是「远端历史恒为空」，不是报错。
 */
export function remoteSessionHistoryMarker(nonce: string): string {
	if (typeof nonce !== "string" || !NONCE.test(nonce)) throw stable(REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID);
	return `PIDECK_HISTORY_${nonce}`;
}
/** remotePath 的域与 `readSshSessionLocator` 同源（shared 的 `MAX_SESSION_REMOTE_PATH`）。 */
const MAX_REMOTE_PATH_LENGTH = 4096;
/** 控制字节与 shell 单引号：前者会把命令切坏，后者会终结单引号字面量——两者都 fail-closed。 */
const PATH_FORBIDDEN_CHARS = /[\u0000-\u001f\u007f']/;
/** 相对身份（`remoteSessionId`）不允许的形状：反斜杠、`..` 段、空段。 */
const RELATIVE_SEGMENT_FORBIDDEN = /\\|(^|\/)\.\.?(\/|$)/;

/** 一个稳定码错误：message 本身就是码（远端 IPC 一系的既有约定）。 */
function stable(code: string): Error {
	return new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只让本身已经是稳定码的 message 通过；其余折叠成 fallback（路径/命令行/errno 永不外传）。 */
function codeOf(error: unknown, fallback: string): string {
	if (isRecord(error)) {
		const message = error.message;
		if (typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message)) return message;
	}
	return fallback;
}

/**
 * 远端会话文件的绝对路径判据（本模块唯一的路径入口）。
 *
 * 判据与 `readSshSessionLocator` / `readCanonicalRemoteProjectPath` 同域（绝对 POSIX、有界、无控制字节），
 * 另加两条**本地约束**：
 * - 不接受单引号。远端命令只把路径放在单引号字面量里（`'<path>'`），放行单引号就等于允许远端路径提前
 *   闭合字面量——这里选择拒绝而不是实现一套转义，因为 pi 的会话目录形状里没有单引号；
 * - 必须已经是**规范形式**（F6，security review §(f)）：重复分隔符、空段、`.`/`..` 段一律拒绝，
 *   尾斜杠也已拒绝。文档一直称这条判据是 canonical 的，旧实现却放行
 *   `/home/u/.pi/agent/sessions/../../../etc/passwd`；生产 catalog 写入侧虽然另有拒绝，但「唯一路径权威」
 *   不该依赖上游都记得再查一遍（未来新增写面或 catalog 被篡改时就是缺口）。
 *   选择拒绝而不是本地规范化：命令里的路径必须与远端真实文件逐字一致，静默 `path.posix.normalize`
 *   会把两个不同字符串映射到同一个远端路径（符号链接语义下甚至不是同一个文件），也会掩盖调用方的
 *   拼接错误。拒绝是可测试、可审计的。
 *
 * 注意 `..` 的拒绝是**词法**的：本判据不解析符号链接（远端真实身份由写守卫/读取命令自己保证）。
 */
export function validateRemoteSessionHistoryPath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_PATH_LENGTH) return undefined;
	if (PATH_FORBIDDEN_CHARS.test(value)) return undefined;
	if (!value.startsWith("/") || value.endsWith("/")) return undefined;
	// startsWith("/") 保证 segments[0] 是空串（根前缀）；其余段必须非空且不是 "." / ".."。
	const segments = value.slice(1).split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
	return value;
}

/**
 * 相对身份拼接：`<root>/<relative>`，并复查拼接结果仍是合法远端路径。
 *
 * 为什么不直接字符串相加：`remoteSessionId` 来自 catalog（跨重启的持久化输入），`..` 段必须在这里被
 * 拒掉，而不是交给远端 shell 去解析。
 */
export function joinRemoteSessionRoot(root: string, relative: string): string | undefined {
	const canonicalRoot = validateRemoteSessionHistoryPath(root);
	if (canonicalRoot === undefined) return undefined;
	if (typeof relative !== "string" || relative.length === 0 || relative.startsWith("/") || RELATIVE_SEGMENT_FORBIDDEN.test(relative)) return undefined;
	return validateRemoteSessionHistoryPath(`${canonicalRoot}/${relative}`);
}

/**
 * 构造一次有界窗口读取的远端命令（纯函数，测试直接断言它的参数）。
 *
 * 形状一（`endOffset` 省略）：读到文件尾——
 *   `printf '<marker>'; (stat -c '%i|%s|%y' '<path>' 2>/dev/null || stat -f '%i|%z|%m' '<path>'); tail -c <windowBytes> -- '<path>'; readStatus=$?; printf '<marker>_END'; (stat -c '%i|%s|%y' '<path>' 2>/dev/null || stat -f '%i|%z|%m' '<path>'); exit "$readStatus"`
 * 形状二（给了 `endOffset`，1-based 含端）：读 [start, endOffset] 这一段——
 *   `printf '<marker>'; (stat -c '%i|%s|%y' '<path>' 2>/dev/null || stat -f '%i|%z|%m' '<path>'); tail -c +<start> -- '<path>' | head -c <count>; readStatus=$?; printf '<marker>_END'; (stat -c '%i|%s|%y' '<path>' 2>/dev/null || stat -f '%i|%z|%m' '<path>'); exit "$readStatus"`
 *
 * 两种形状都带远端 stat（GNU/BSD 两种格式取当前系统可用的一种）：inode 用于发现原子替换，mtime 用于发现同体积原位重写，size 用于发现截断。
 *
 * 为什么把 stat 和 `tail` 放进**同一条**命令：窗口起点（也就是下一页的游标）要用文件大小才能算出来，
 * 而每次 `buildPinnedSshInvocation` 都要跑几次 `ssh -G` 校验路由——两次往返换一个可以本地算出的数字不划算。
 * 标记放在最前，是因为远端 shell 可能在 stdout 里混入登录横幅（`ssh` 非交互会话下 `~/.bashrc` 仍可能
 * 被 source，nvm 初始化就是这种），前缀噪声因此不会走进解析。
 *
 * 命令里**只出现窗口上界**，不出现文件大小：`tail -c <windowBytes>` 的语义就是「最多这么多字节」。
 */
export function buildRemoteSessionWindowCommand(input: { remotePath: string; windowBytes: number; endOffset?: number; nonce: string }): string {
	const remotePath = validateRemoteSessionHistoryPath(input?.remotePath);
	if (remotePath === undefined) throw stable(REMOTE_SESSION_HISTORY_CODES.pathInvalid);
	if (!Number.isSafeInteger(input?.windowBytes) || input.windowBytes <= 0 || input.windowBytes > REMOTE_SESSION_HISTORY_WINDOW_BYTES) throw stable(REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID);
	const marker = `printf '${remoteSessionHistoryMarker(input?.nonce)}'`;
	const stat = `(stat -c '%i|%s|%y' '${remotePath}' 2>/dev/null || stat -f '%i|%z|%m' '${remotePath}')`;
	const trailer = `readStatus=$?; printf '${remoteSessionHistoryMarker(input?.nonce)}_END'; ${stat}; exit "$readStatus"`;
	if (input.endOffset === undefined) return `${marker}; ${stat}; tail -c ${input.windowBytes} -- '${remotePath}'; ${trailer}`;
	if (!Number.isSafeInteger(input.endOffset) || input.endOffset < 1) throw stable(REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID);
	const start = Math.max(1, input.endOffset - input.windowBytes + 1);
	const count = input.endOffset - start + 1;
	return `${marker}; ${stat}; tail -c +${start} -- '${remotePath}' | head -c ${count}; ${trailer}`;
}

/** 一条**完整**行（含它在文件里的 1-based 起始偏移，用于下一页游标）。 */
export type RemoteSessionHistoryLine = { text: string; offset: number };

export type RemoteSessionHistoryWindow = {
	/** 本窗口在文件里的 1-based 起始偏移（首字节）。 */
	windowStart: number;
	/** 完整行的起始偏移（不含被丢掉的半截行）。 */
	lines: RemoteSessionHistoryLine[];
	/** 下一段更早历史的游标（1-based 起始偏移）：通常是窗口首完整行的偏移；整窗口无完整行时
	 *  退化为窗口起点（读不到内容不等于到文件头）。undefined = 确实没有更早历史。 */
	nextBefore: number | undefined;
	/** 起点落在行中间：当页丢掉了半截首行。 */
	droppedLeadingPartial: boolean;
	/** 终点被窗口截断：当页丢掉了半截尾行。 */
	droppedTrailingPartial: boolean;
	/** 文件在远端文件系统里的 inode。 */
	fileIdentity: string;
	/** mtime 的数字指纹；追加会变化，但同体积 mtime 变化说明文件被原位重写。 */
	modifiedAt: string;
	/** 文件身份或可见文件代际在窗口读取期间变化；调用方丢弃本页并重读一次。 */
	changedDuringRead: boolean;
	/** 文件字节数，用于发现截断与识别追加。 */
	size: number;
};

/**
 * 解析一次窗口读取的 stdout（纯函数）。
 *
 * 两种命令形状输出**同一形状**：`<marker><inode>|<size>|<mtime>\n<payload><marker>_END<inode>|<size>|<mtime>\n`（Linux/GNU 的 mtime 带亚秒精度，BSD stat 退化为秒）。
 * 差别只在 payload 的终点：
 * - 形状一（`windowEnd` 缺省）：payload 直到文件尾 ⇒ 尾行即使没有换行也是完整的；
 * - 形状二（`windowEnd` = 本窗口末字节）：payload 的终点是**下一页已经展示过的内容**前面 ⇒
 *   payload 不以换行结尾时尾行必是半截（它的后半段在上一次读的窗口里）。
 *
 * 起点落在行中间（`windowStart > 1`）时首行必是半截：它属于上一行，不能当一个新行解析。
 * `windowEnd` 超过文件大小（文件在往回读的这段时间被截断/重写）时按真实大小夹住，
 * 调用方据 `size` 与请求位置的关系判定「跨代」并重读。
 */
export function parseRemoteSessionWindow(stdout: string, input: { marker: string; windowBytes: number; windowEnd?: number }): RemoteSessionHistoryWindow {
	if (typeof stdout !== "string") throw stable(REMOTE_SESSION_HISTORY_CODES.markerMissing);
	if (!Number.isSafeInteger(input?.windowBytes) || input.windowBytes <= 0 || input.windowBytes > REMOTE_SESSION_HISTORY_WINDOW_BYTES) throw stable(REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID);
	const markerIndex = input?.marker === undefined ? -1 : stdout.indexOf(input.marker);
	if (markerIndex < 0) throw stable(REMOTE_SESSION_HISTORY_CODES.markerMissing);
	const rest = stdout.slice(markerIndex + input.marker.length);
	const parseMetadata = (line: string) => /^(\d+)\|(\d{1,20})\|(.+)$/.exec(line);
	const metadataEnd = rest.indexOf("\n");
	const metadata = metadataEnd < 0 ? null : parseMetadata(rest.slice(0, metadataEnd));
	const size = metadata?.[2] === undefined ? Number.NaN : Number(metadata[2]);
	const modifiedAt = metadata?.[3]?.replace(/\D/g, "");
	if (metadata === null || !Number.isSafeInteger(size) || !modifiedAt) throw stable(REMOTE_SESSION_HISTORY_CODES.metadataInvalid);
	const trailerMarker = `${input.marker}_END`;
	const trailerIndex = stdout.indexOf(trailerMarker, markerIndex + input.marker.length + metadataEnd + 1);
	if (trailerIndex < 0) throw stable(REMOTE_SESSION_HISTORY_CODES.metadataInvalid);
	const trailerStart = trailerIndex + trailerMarker.length;
	const trailerEnd = stdout.indexOf("\n", trailerStart);
	const trailer = parseMetadata(stdout.slice(trailerStart, trailerEnd < 0 ? undefined : trailerEnd));
	const trailerSize = trailer?.[2] === undefined ? Number.NaN : Number(trailer[2]);
	const trailerModifiedAt = trailer?.[3]?.replace(/\D/g, "");
	if (trailer === null || !Number.isSafeInteger(trailerSize) || !trailerModifiedAt) throw stable(REMOTE_SESSION_HISTORY_CODES.metadataInvalid);
	const fileIdentity = trailer[1];
	const payloadStart = metadataEnd + 1;
	const payload = stdout.slice(markerIndex + input.marker.length + payloadStart, trailerIndex);
	const changedDuringRead = fileIdentity !== metadata[1] || trailerSize < size || (trailerSize === size && trailerModifiedAt !== modifiedAt) || (input.windowEnd === undefined && trailerSize !== size);
	const payloadBytes = Buffer.byteLength(payload, "utf8");
	// 窗口起点：本窗口末字节（缺省 = 文件尾）向前推 payload 长度。用实际 payload 长度而不是请求长度：
	// 文件被截断时远端 `head -c` 只会少给，算出来的起点仍是真实起点。
	const requestedEnd = input.windowEnd === undefined ? trailerSize : Math.min(input.windowEnd, trailerSize);
	const windowStart = Math.max(1, requestedEnd - payloadBytes + 1);
	const windowEnd = windowStart + payloadBytes - 1;
	// 读到（或越过）文件尾时尾行是完整的：即便文件没有尾换行。
	const reachedEof = windowEnd >= trailerSize;
	// 以换行结尾的 payload 末尾会多出一个空段：它不是行。同时这也说明**尾行是完整的**——
	// 形状二的窗口终点就是下一条已展示行的换行符，那里恰好是一行的结尾。
	const payloadEndsWithNewline = payload.endsWith("\n");
	const segments = payload.split("\n");
	if (payloadEndsWithNewline) segments.pop();
	const lines: RemoteSessionHistoryLine[] = [];
	let offset = windowStart;
	const droppedLeadingPartial = windowStart > 1 && segments.length > 0;
	let droppedTrailingPartial = false;
	for (let index = 0; index < segments.length; index += 1) {
		const isFirst = index === 0;
		const isLast = index === segments.length - 1;
		const segmentBytes = Buffer.byteLength(segments[index], "utf8");
		if (isFirst && droppedLeadingPartial) {
			// 半截首行：计入偏移后丢弃（它的后半段属于上一次读到的窗口）。
			offset += segmentBytes + 1;
			continue;
		}
		if (isLast && !payloadEndsWithNewline && !reachedEof) {
			// 窗口在行中间结束：这一行只读到一半，它的结尾在更新的一页里。
			droppedTrailingPartial = true;
			break;
		}
		lines.push({ text: segments[index], offset });
		offset += segmentBytes + 1;
	}
	// 游标 = 最早一条完整行的起始偏移；等于 1 说明窗口已经贴到文件头，没有更早的历史。
	// 一条完整行都没有（整个窗口落在一条超长行内部）时退化为**窗口起点**：读不到内容不等于到了文件头。
	// 旧实现这里返回 undefined（= 到顶），于是渲染层的「加载更早」在那条超长行之前永久消失——
	// 用户的真实症状是「往上翻翻不上去，我发过的消息都找不到」（带图消息就是这种超长行）。
	const cursor = lines[0]?.offset ?? (windowStart > 1 ? windowStart : undefined);
	return {
		windowStart,
		lines,
		nextBefore: cursor !== undefined && cursor > 1 ? cursor : undefined,
		fileIdentity,
		size: trailerSize,
		modifiedAt: trailerModifiedAt,
		changedDuringRead,
		droppedLeadingPartial,
		droppedTrailingPartial,
	};
}

/**
 * 一条远端会话记录（locator）→ 远端绝对路径。
 *
 * 绝对写法直接用（`attachRemoteLocatorEntry` 吸收 runtime 握手时写的就是 pi 上报的绝对路径）；
 * 相对写法必须经过会话根解析，解析不出就 fail-closed——猜一个 `<home>/.pi/agent/sessions` 会在配了
 * 自定义 `sessionDir` 的机器上读错文件（那是「读到了别人的历史」级别的问题，不是少读一点）。
 *
 * 为什么是**导出**的纯函数而不是读取器内部的闭包：远端读（本模块）与远端写（`RemoteSessionArchive` 的
 * 归档/恢复）必须用同一份「locator → 绝对路径」实现。各拼一次会在配了自定义会话根的机器上把文件
 * 归到另一个目录，而那种错「看起来一切正常」。路径**判据**（绝对/规范化/无控制字节/无单引号）与
 * 本函数同源，见 `validateRemoteSessionHistoryPath`。
 */
export async function resolveRemoteSessionPath(input: { hostId: string; locator: SshSessionLocator; resolveSessionRoot?: RemoteSessionHistoryRootPort }): Promise<string> {
	const locator = input?.locator;
	if (locator === undefined) throw stable(REMOTE_SESSION_HISTORY_CODES.locatorInvalid);
	const remotePath = locator.remotePath;
	if (typeof remotePath === "string" && remotePath.startsWith("/")) {
		const validated = validateRemoteSessionHistoryPath(remotePath);
		if (validated === undefined) throw stable(REMOTE_SESSION_HISTORY_CODES.pathInvalid);
		return validated;
	}
	const relative = remotePath ?? locator.remoteSessionId;
	if (typeof relative !== "string" || relative.length === 0) throw stable(REMOTE_SESSION_HISTORY_CODES.pathUnresolved);
	const resolveRoot = input.resolveSessionRoot;
	if (resolveRoot === undefined) throw stable(REMOTE_SESSION_HISTORY_CODES.pathUnresolved);
	const resolved = await resolveRoot(input.hostId);
	if (!resolved.ok) throw stable(resolved.code);
	const joined = joinRemoteSessionRoot(resolved.root, relative);
	if (joined === undefined) throw stable(REMOTE_SESSION_HISTORY_CODES.pathInvalid);
	return joined;
}

/**
 * 远端窗口读取端口：由装配注入（生产实现走 pinned SSH 短命令）。
 *
 * 超时**归传输层**：生产传输是 `SshClientRuntime.run`，它的 `execFile` 自带 30 s 上限；输出缓冲缺省
 * 256 KiB，装配处（`mediaSessionStack`）把历史读取显式放宽到 `REMOTE_SESSION_HISTORY_TRANSPORT_BYTES`
 * （窗口上界就是为后者留的余量）。端口不另给一个调用侧 deadline——两个 deadline 只会互相掩盖。
 */
export type RemoteSessionHistoryTransportPort = {
	readRemoteWindow(input: { hostId: string; remoteCommand: string }): Promise<{ exitCode: number; stdout: string }>;
};

/**
 * 会话根解析端口（可选）：ssh locator 的 `remotePath` 有两种写法——runtime 上报的**绝对路径**，
 * 以及扫描登记时的**相对会话根路径**。后者要拼出绝对路径就必须用与 scanner 同一份根判定
 * （pi 的 user-level `settings.json` 可以把会话根换掉），所以这里只要一个函数，不在远端模块里再抄一遍。
 */
export type RemoteSessionHistoryRootPort = (hostId: string) => Promise<{ ok: true; root: string } | { ok: false; code: string }>;

/** 消息投影端口：复用本地同一条投影管线（`AgentMessageProjector`），不另造消息形状。 */
export type RemoteSessionHistoryProjector = (rawMessages: unknown[], activeEntryIds?: string[]) => ChatMessage[];

export type RemoteSessionHistoryReaderPorts = {
	transport: RemoteSessionHistoryTransportPort;
	project: RemoteSessionHistoryProjector;
	/** 相对身份需要它；缺失时相对 identity 以 `PATH_UNRESOLVED` fail-closed（绝不猜会话根）。 */
	resolveSessionRoot?: RemoteSessionHistoryRootPort;
	/** 只记录诊断（损坏行计数、失败码），不记录路径与命令行。 */
	logger?: { warn(message: string, details?: Record<string, unknown>): void };
	/** 只允许调小（测试用）；缺省 `REMOTE_SESSION_HISTORY_WINDOW_BYTES`。 */
	windowBytes?: number;
};

export type RemoteSessionHistoryReader = {
	/** 读一页远端历史（有界窗口）。任何失败都返回/抛出稳定码，绝不裸异常。 */
	readPage(input: { hostId: string; locator: SshSessionLocator; before?: number; beforeEntryId?: string }): Promise<SessionMessagePage>;
};

/** 一行的解析结果：原始 pi 消息 + 它所在的条目（parentId 链要用）。 */
type ParsedEntry = { id: string; parentId: string | null; type?: string; message?: { role?: string }; raw?: unknown };

function createReader(ports: RemoteSessionHistoryReaderPorts): RemoteSessionHistoryReader {
	const windowBytes = ports.windowBytes ?? REMOTE_SESSION_HISTORY_WINDOW_BYTES;
	if (!Number.isSafeInteger(windowBytes) || windowBytes <= 0 || windowBytes > REMOTE_SESSION_HISTORY_WINDOW_BYTES) throw stable(REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID);
	if (typeof ports?.transport?.readRemoteWindow !== "function" || typeof ports?.project !== "function") throw stable(REMOTE_SESSION_HISTORY_READER_OPTIONS_INVALID);

	/**
	 * 一条远端会话记录 → 远端绝对路径（唯一实现在模块级 `resolveRemoteSessionPath`，读取与归档共用）。
	 */
	async function resolveRemotePath(hostId: string, locator: SshSessionLocator): Promise<string> {
		return await resolveRemoteSessionPath({ hostId, locator, resolveSessionRoot: ports.resolveSessionRoot });
	}

	return {
		async readPage(input) {
			const hostId = input?.hostId;
			const locator = readSshSessionLocator(input?.locator);
			if (locator === undefined) throw stable(REMOTE_SESSION_HISTORY_CODES.locatorInvalid);
			if (typeof hostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(hostId) || locator.hostId !== hostId) throw stable(REMOTE_SESSION_HISTORY_CODES.hostIdInvalid);
			const before = Number.isSafeInteger(input?.before) && (input.before as number) > 0 ? (input.before as number) : undefined;
			// 上一页递来的活动链叶子种子（与本地 `nextBeforeEntryId` 同义）：窗口最后一行未必在活动链上，
			// 没有它，跨页的分支归属就会回退成「拿窗口尾行的回溯结果当活动链」（旧分支被当成正文）。
			const seedEntryId = typeof input?.beforeEntryId === "string" && input.beforeEntryId.trim().length > 0 && input.beforeEntryId.length <= 256 ? input.beforeEntryId : undefined;
			// 游标 1（= 文件首字节）意味着没有更早的历史：不发起任何远端请求，直接答「到顶」。
			// 否则 `endOffset = 0` 会变成一个看起来像装配错误的稳定码，而它其实是一个合法查询结果。
			if (before === 1) return { messages: [], total: 0, nextBefore: null };
			const remotePath = await resolveRemotePath(hostId, locator);
			// 一页 = 连续的若干窗口（最多 1 + REMOTE_SESSION_HISTORY_WINDOW_SKIPS 个）。页边界按字节对齐，
			// 单个超长行（带图用户消息）可能把整窗口吞掉：这种窗口没有可解析的行，但**位置仍然往前**。
			// 继续向前读直到带回可呈现的消息或真正到文件头，否则渲染层看到的就是「点一次毫无变化」，
			// 极端情况下（窗口全在一条行内）永远停在那一页。
			const lines: RemoteSessionHistoryLine[] = [];
			let cursor = before;
			// indexVersion 用 inode + mtime + **真实文件体积**：原子替换换 inode，同体积原位重写改 mtime，截断会缩小体积，追加只增大体积。
			let fileIdentity: string | undefined;
			let fileModifiedAt: string | undefined;
			let fileSize: number | undefined;
			let generationRetried = false;
			const pageOf = (messages: ChatMessage[], nextBefore: number | undefined, anchorParentId: string | undefined) => ({
				messages,
				// 说明见文件头「已知取舍」：远端不读整文件就只能给出窗口计数（下界），
				// 「还有更早历史」只由 nextBefore 决定（渲染层同样只看它）。
				total: messages.length,
				nextBefore: nextBefore ?? null,
				// 跨页活动链：把「链在窗口外的第一个祖先」交给下一页当叶子种子。
				// 没有它，下一页只能从窗口尾行回溯；尾行恰好是 rewind 掉的旧分支时，
				// 那一页就会显示旧分支、并把大量本该显示的消息排除在外。
				...(typeof anchorParentId === "string" ? { nextBeforeEntryId: anchorParentId } : {}),
				// 没有它，渲染层的 disk → runtime 交接会因「无法证明同代」把整页历史丢掉：
				// 会话被运行时接管后只剩窗口段（用户实拍：重开远端会话只看得到最后一条）。
				// 空页同样带版本：renderer 必须校验每个游标页，不能让中间的空页抹掉代际证据。
				...(fileIdentity !== undefined && fileModifiedAt !== undefined && fileSize !== undefined ? { indexVersion: `remote:${fileIdentity}:${fileModifiedAt}:${fileSize}` } : {}),
			});
			for (let attempt = 0; attempt <= REMOTE_SESSION_HISTORY_WINDOW_SKIPS; attempt += 1) {
				const nonce = randomBytes(16).toString("hex");
				const remoteCommand = buildRemoteSessionWindowCommand({ remotePath, windowBytes, nonce, ...(cursor !== undefined ? { endOffset: cursor - 1 } : {}) });
				const marker = remoteSessionHistoryMarker(nonce);
				let result: { exitCode: number; stdout: string };
				try {
					result = await ports.transport.readRemoteWindow({ hostId, remoteCommand });
				} catch (error) {
					// 连接层自己的稳定码（SSH_HOST_NOT_READY / SSH_HOST_ROUTE_CHANGED …）原样转述。
					throw stable(codeOf(error, REMOTE_SESSION_HISTORY_CODES.transportFailed));
				}
				if (!isRecord(result) || typeof result.stdout !== "string") throw stable(REMOTE_SESSION_HISTORY_CODES.transportFailed);
				if (result.exitCode !== 0) throw stable(REMOTE_SESSION_HISTORY_CODES.commandFailed);
				const window = parseRemoteSessionWindow(result.stdout, { marker, windowBytes, ...(cursor === undefined ? {} : { windowEnd: cursor - 1 }) });
				// 文件被替换、截断，或读取期间跨到另一代：之前算出的偏移可能失效，不能拼接。
				if (window.changedDuringRead || (fileSize !== undefined && (window.fileIdentity !== fileIdentity || window.size < fileSize || (window.size === fileSize && window.modifiedAt !== fileModifiedAt)))) {
					if (generationRetried) throw stable(REMOTE_SESSION_HISTORY_CODES.stale);
					generationRetried = true;
					lines.length = 0;
					cursor = before;
					fileIdentity = undefined;
					fileModifiedAt = undefined;
					fileSize = undefined;
					continue;
				}
				fileIdentity = window.fileIdentity;
				fileModifiedAt = window.modifiedAt;
				fileSize = window.size;
				// 每轮读的是「更早」的一段：串起来要保持文件顺序（更早的在前），且两轮的行区间不重叠
				// （游标是首完整行的偏移，上一轮丢掉的半行会在下一轮尾部完整读回）。
				lines.unshift(...window.lines);
				const parsed = parseWindowEntries(lines, seedEntryId);
				if (parsed.corruptLines > 0) ports.logger?.warn("remote session history has unparsable lines", { hostId, corruptLines: parsed.corruptLines, lines: lines.length });
				const messages = parsed.rawMessages.length === 0 ? [] : ports.project(parsed.rawMessages, parsed.activeEntryIds);
				const next = window.nextBefore;
				// 到文件头：没有更早内容可读，到此为止（页首可能是半轮，这是文件边界）。
				if (next === undefined) return pageOf(messages, next, parsed.branchAnchorParentId);
				// 种子还没出现在累积行里（窗口边界把上一页的链根切在更早的位置）：继续往前读，
				// 不能用窗口尾行代替叶子——那正是「旧分支被当成正文」的成因。
				if (typeof seedEntryId === "string" && !parsed.seedApplied) {
					cursor = next;
					continue;
				}
				// 本页还没有可呈现内容（整窗口落在一行内、窗口里全是非角色条目）：继续往前。
				if (messages.length === 0) {
					cursor = next;
					continue;
				}
				// 有可呈现内容就交页：页边界按字节/行切分，**不**强行对齐到「轮起点」——
				// 实测工具输出密集的会话里两条 user 常隔开不止 2 MiB，对齐只会多读窗口而仍对不齐
				// （ZCode 能做到是因为它的 row 自带 turnHeader 标签）。跨页连续性由渲染层按消息顺序拼接，
				// 扩窗按页内实际轮数（max(1, turns)）承接。
				return pageOf(messages, next, parsed.branchAnchorParentId);
			}
			// 连续跨完预算仍然没有可呈现的行（单行比一页上界还大，或整段都是非角色条目）：
			// 给出**推进后的游标**而不是 null，让下一次「加载更早」接着往前走，不再永久卡在同一位置。
			return {
				messages: [],
				total: 0,
				nextBefore: cursor ?? null,
				...(typeof seedEntryId === "string" ? { nextBeforeEntryId: seedEntryId } : {}),
				...(fileIdentity !== undefined && fileModifiedAt !== undefined && fileSize !== undefined ? { indexVersion: `remote:${fileIdentity}:${fileModifiedAt}:${fileSize}` } : {}),
			};
		},
	};
}

/**
 * 窗口内的完整行 → pi 条目 + 投影输入。
 *
 * - 单行 JSON 坏掉（截断、非法 UTF-8 被替换、非对象、缺 id）：跳过并计数（fail-soft，当页照常返回）；
 * - 只有 `type === "message"` 且 role 是角色消息的行进入投影输入，且必须能在 parentId 链上走通
 *   （`buildActiveBranchEntryIds`，与本地显示分支同一份实现）：被 rewind/fork 甩掉的旧分支条目
 *   不会混进当页。
 * - **叶子可以是上一页递来的 `seedEntryId`**：窗口的最后一行未必在活动链上（它可能是 rewind 之前的
 *   旧分支条目，文件是 append-only 的，旧分支就在中间）。上一页把「链在窗口外的第一个祖先 id」递下来，
 *   这一页从它回溯，活动链才能跨页连续——否则那一页会把旧分支当活动链，用户看到的是「顺序乱、
 *   夹着别处的对话」以及一大批本来该显示的消息被排除。
 * - **必须用 `buildTimelineProjection` 应用 `context_edit`（但不裁剪 compaction）**：远端编辑/删除是追加
 *   context_edit（原文行保留），只把消息行原样交给消息投影器会让编辑后的正文永远停在原文、删除的
 *   消息继续显示。这里复用与本地/离线 Viewer 同一份投影纯函数，再按活动链把已生效的消息交给消息
 *   投影器；entryId 槽位同步只包含实际投影的消息，避免被排除的消息让后续 meta.entryId 整体错位。
 *   不能用 `buildSessionProjection`：它会按「窗口内最后一条 compaction」裁剪，而窗口里看不到更新的那条
 *   compaction 时，那段历史就被错误地当成「已被摘要替代」——真机现象是远端上翻时整段自己的消息消失。
 */
function parseWindowEntries(lines: readonly RemoteSessionHistoryLine[], seedEntryId?: string): { rawMessages: unknown[]; activeEntryIds: string[] | undefined; corruptLines: number; branchAnchorParentId: string | undefined; seedApplied: boolean } {
	const entries: ParsedEntry[] = [];
	let corruptLines = 0;
	for (const line of lines) {
		if (line.text.trim().length === 0) continue;
		let record: unknown;
		try {
			record = JSON.parse(line.text);
		} catch {
			corruptLines += 1;
			continue;
		}
		if (!isRecord(record) || typeof record.id !== "string" || record.id.length === 0) {
			corruptLines += 1;
			continue;
		}
		entries.push({
			id: record.id,
			parentId: typeof record.parentId === "string" ? record.parentId : null,
			...(typeof record.type === "string" ? { type: record.type } : {}),
			...(isRecord(record.message) ? { message: { role: typeof record.message.role === "string" ? record.message.role : undefined } } : {}),
			raw: record,
		});
	}
	const seed = typeof seedEntryId === "string" && seedEntryId.length > 0 && entries.some((entry) => entry.id === seedEntryId) ? seedEntryId : undefined;
	const leaf = seed === undefined ? entries[entries.length - 1] : entries.find((entry) => entry.id === seed);
	// 链在窗口外的第一个祖先：交给下一页当叶子种子（无就不传，下一页退回自己的最后一行）。
	const branchAnchorParentId = leaf === undefined ? seedEntryId : traceBranchAnchorParent(entries, leaf.id);
	const activeEntryIds = leaf === undefined ? undefined : buildActiveBranchEntryIds(entries, leaf.id);
	const activeSet = activeEntryIds === undefined ? undefined : new Set(activeEntryIds);
	// 窗口内叶节点的上下文投影：应用 context_edit（替换正文 / 移出时间线），与本地读同一套语义。
	const projection =
		leaf === undefined
			? undefined
			: buildTimelineProjection(
					entries.flatMap((entry) => (isRecord(entry.raw) ? [entry.raw] : [])),
					leaf.id,
				);
	const projectedById = new Map<string, ProjectedSessionEntry>();
	for (const projected of projection?.projectedEntries ?? []) projectedById.set(projected.entryId, projected);
	const rawMessages: unknown[] = [];
	const projectedEntryIds: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (!isRoleMessageRole(role)) continue;
		// 链上走不通（窗口外的祖先/失效分支）：不投影。宁可少显示一条，也不把分支归属编出来。
		if (activeSet !== undefined && !activeSet.has(entry.id)) continue;
		const projected = projectedById.get(entry.id);
		// 被 context_edit 的 replacement:null 移出上下文（远端删除）、或已被压缩区间裁掉：不显示。
		if (projected === undefined || projected.excluded || projected.messages.length === 0) continue;
		rawMessages.push(projected.messages[0]);
		projectedEntryIds.push(entry.id);
	}
	return { rawMessages, activeEntryIds: projectedEntryIds, corruptLines, branchAnchorParentId, seedApplied: seed !== undefined };
}

/**
 * 从叶子回溯，返回「第一个落在窗口外的祖先 id」。
 *
 * 这个 id 是下一页的叶子种子：本页的链走到窗口边界就断了，下一页接着往下走，活动链才能跨页连续。
 * 走到 parentId=null 说明真到了文件头；碰到环（脏文件）时放弃种子，不冒死循环风险。
 */
function traceBranchAnchorParent(entries: readonly ParsedEntry[], leafId: string): string | undefined {
	const entryById = new Map<string, ParsedEntry>();
	for (const entry of entries) entryById.set(entry.id, entry);
	const seen = new Set<string>();
	let current: string | null = leafId;
	while (current !== null) {
		if (seen.has(current)) return undefined;
		seen.add(current);
		const entry = entryById.get(current);
		if (entry === undefined) return current;
		current = entry.parentId;
	}
	return undefined;
}

/** 构造远端历史读取器（构造期校验端口，任何非法装配立刻抛出）。 */
export function createRemoteSessionHistoryReader(ports: RemoteSessionHistoryReaderPorts): RemoteSessionHistoryReader {
	return createReader(ports);
}
