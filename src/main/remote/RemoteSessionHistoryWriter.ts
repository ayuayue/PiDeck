/**
 * 远端会话 JSONL 的**受控改写**（P4.5c：编辑消息 / 删除消息 / 准备重发）。
 *
 * 为什么偏远端也要自己改写文件：pi 的 RPC 没有 edit/delete/truncate 类命令（远端会话的历史改写只能由
 * PiDeck 做），而远端 JSONL 在远端机器上，本机 fs 读不到。三条操作改写的是**同一条** JSONL，也共用
 * 同一套冲突与原子性规则，所以本切片是一个 single-seam：拆成三份等于把写面实现三次。
 *
 * 通道（本切片的核心变化）：**一条 host 级 helper 请求** `session.maintain`。过去这里是「整份下载 →
 * 本机改内存 → 4 KiB 分块上传」，命令数随文件字节线性增长；现在 main 只发操作、新正文、候选 id 与它
 * 读到的 revision，远端在同一份文件上流式完成改写/删除/重发，只回 `{ revision, draft }`。冻结的线上
 * 形状在 `RemoteHelperContract.RemoteSessionMaintainParams`，请求客户端在 `RemoteSessionMaintenance`；
 * 本模块只负责「谁、改哪台主机上的哪个文件、失败时怎么说话」。
 *
 * 仍然留在 main 的两件事，都不是改写规则：
 * - **路径判据**：只走 `resolveRemoteSessionPath` / `validateRemoteSessionHistoryPath`（与读取侧同源）；
 * - **revision 快照**：仍由既有 pinned SSH 守卫命令（`buildRemoteSessionWriteGuardCommand` 的 snapshot）
 *   读出 mode/size/dev/ino/uid/gid/mtimeNs/ctimeNs/digest，原样作为 `expected` 交给远端做
 *   compare-and-swap。snapshot 的摘要上界与会话维护的文件上界同源（`REMOTE_SESSION_WRITE_MAX_BYTES`，
 *   守卫脚本拒绝比它更大的上界），所以大会话只需付一次 O(文件) 的摘要，不再付整文传输。
 *
 * 定位（谁都不在 main 里重算）：`meta.entryId` 提示的投影 id → 裸提示 id → 渲染层消息 id，去重后
 * 最多 3 条、最具体在前；活动分支、过程链、`context_edit`/墓碑语义全部由远端用同一份文件判定。
 *
 * 不变量：
 * - **先判后发**：hostId/locator/操作/路径/候选 id 不合法时一个远端请求都不发；
 * - **失败即停**：破坏性动作不自动重试。请求没发出去 ⇒ `transportFailed`（或连接层自己的稳定码）；
 *   帧可能已写出但回执丢了 ⇒ `resultUnconfirmed`，必须重新加载核对，既不谎报成功也不提示重试；
 * - **未找到**：delete 只有「没找到 **且** 没有停止前身份摘要」才是 no-op，其余一律报未找到；
 * - **脱敏**：本模块自己不记日志；路径、正文都不返回给调用方也不落日志，调用方只按稳定码记录。
 */
import { randomBytes } from "node:crypto";
// hostId 与 ssh 身份判据只允许有一份：与持久化边界共用 shared 的权威取值域。
import { PROJECT_HOST_ID_PATTERN, readSshSessionLocator, type SshSessionLocator } from "../../shared/projectLocation";
import type { ImageContent } from "../../shared/types";
import type { StoppedMessageIdentity } from "../pi/stoppedMessageIdentity";
import { buildRemoteSessionWriteGuardCommand, parseRemoteSessionWriteGuardResult, REMOTE_SESSION_WRITE_MAX_BYTES, type RemoteSessionFileRevision } from "./RemoteSessionWriteGuard";
import { REMOTE_SESSION_HISTORY_CODES, remoteSessionHistoryMarker, resolveRemoteSessionPath, type RemoteSessionHistoryRootPort } from "./RemoteSessionHistoryReader";
import { buildRemoteSessionMaintainCandidates, createRemoteSessionMaintenance, remoteSessionMaintenanceFailure, REMOTE_SESSION_MAINTENANCE_CODES, REMOTE_SESSION_MAINTENANCE_OPTIONS_INVALID, type RemoteSessionMaintenanceDraft, type RemoteSessionMaintenancePort } from "./RemoteSessionMaintenance";

/**
 * 快照的字节上界（等于守卫脚本自己的上界）：超出 fail-closed，**绝不**为了「先看看」而无界读远端文件。
 * 这个值只影响发请求之前的 revision 复核，不是远端改写能力的上界。
 */
export const REMOTE_SESSION_HISTORY_WRITE_MAX_BYTES = REMOTE_SESSION_WRITE_MAX_BYTES;

/** 本模块的稳定码词汇（协调器/渲染层按它分类，术语不能两边各写一份）。 */
export const REMOTE_SESSION_HISTORY_WRITER_CODES = {
	/** 源文件在读取/写入之间变化：拒绝覆盖外部修改，调用方应重读后显式操作。 */
	fileChanged: "REMOTE_SESSION_HISTORY_WRITER_FILE_CHANGED",
	/** hostId 不是可用的诊断身份/传输键。 */
	hostIdInvalid: "REMOTE_SESSION_HISTORY_WRITER_HOST_ID_INVALID",
	/** locator 不是合法 ssh 身份。 */
	locatorInvalid: "REMOTE_SESSION_HISTORY_WRITER_LOCATOR_INVALID",
	/** 远端路径不可用（非绝对/含单引号/控制字节/超长）：绝不把它拼进命令行。 */
	pathInvalid: "REMOTE_SESSION_HISTORY_WRITER_PATH_INVALID",
	/** 远端路径既不是绝对路径、也推不出会话根（相对身份 + 没有根解析端口）。 */
	pathUnresolved: "REMOTE_SESSION_HISTORY_WRITER_PATH_UNRESOLVED",
	/** 传输层失败（ssh 起不来、管理器未就绪、输出超上界）且自身不带稳定码：目标未改动。 */
	transportFailed: "REMOTE_SESSION_HISTORY_WRITER_TRANSPORT_FAILED",
	/**
	 * 请求**确定没有生效**的远端失败（对端亲自拒绝：请求不合法、权限、IO、提交前的守卫冲突）：
	 * 目标文件没被改动，本机状态必须原样不动，调用方可以安全地重读后重试。
	 *
	 * 提交点不适用这条保证：见 `resultUnconfirmed`。
	 */
	commandFailed: "REMOTE_SESSION_HISTORY_WRITER_COMMAND_FAILED",
	/**
	 * 请求已经发出、但它的回执丢了（超时/连接中断/对端崩溃）：**改写可能已经生效**。
	 *
	 * 为什么需要独立码：把所有失败都报成 `commandFailed`/「目标文件没被改动」，用户会被误导为
	 * 「什么都没发生，重试即可」。这个码的语义是「结果未确认」——必须重新加载远端会话核对，
	 * **不自动重试**（重试可能基于旧快照再写一次）。
	 */
	resultUnconfirmed: "REMOTE_SESSION_HISTORY_WRITER_RESULT_UNCONFIRMED",
	/** revision 快照的输出不可信（标记缺失/形状非法）：发请求前就拒绝，绝不拿半份身份去发请求。 */
	transferInvalid: "REMOTE_SESSION_HISTORY_WRITER_TRANSFER_INVALID",
	/** 文件超出 main 侧 revision 快照的上界（守卫脚本的硬上界）。 */
	fileTooLarge: "REMOTE_SESSION_HISTORY_WRITER_FILE_TOO_LARGE",
	/** 内容不是本机链路能处理的那种 JSONL（非法 UTF-8 / 非对象行 / 重复 id / 会话头数量不符 / 父链断裂或成环）。 */
	fileInvalid: "REMOTE_SESSION_HISTORY_WRITER_FILE_INVALID",
	/** 文件里没有这条消息（或它不在活动分支上）。delete 对这种情形是 no-op，与在本机链路一致。 */
	messageNotFound: "REMOTE_SESSION_HISTORY_WRITER_MESSAGE_NOT_FOUND",
	/** 消息角色不允许该操作（edit 只允许 user/assistant；resend 只允许 user）。 */
	roleInvalid: "REMOTE_SESSION_HISTORY_WRITER_ROLE_INVALID",
	/** 操作不在取值域内（"edit" | "delete" | "resend"）。 */
	operationInvalid: "REMOTE_SESSION_HISTORY_WRITER_OPERATION_INVALID",
	/**
	 * 历史**没有被改动**，但重发要带回输入框的草稿（正文 + 参考图）超过远端上界。
	 *
	 * 为什么单独成码：这是 tri-state 的第三种结果——不是成功（草稿丢了），也不是「写失败可以重试」
	 * （文件确实没变，重试还是同一份草稿）。谎报成功会让用户以为重发的是原文。
	 */
	draftTooLarge: "REMOTE_SESSION_HISTORY_WRITER_DRAFT_TOO_LARGE",
	/** helper 不认识 `session.maintain`（版本过旧）：稳定码而不是落回本机路径分支，也不是「文件没改所以重试」。 */
	unavailable: "REMOTE_SESSION_HISTORY_WRITER_UNAVAILABLE",
} as const;

/** 构造期参数不合法（与其它远端模块一致，构造即抛，不等到第一次改写）。 */
export const REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID = "REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID";

/**
 * 路径类稳定码的折叠：读取侧与本模块共用同一个解析实现（硬要求），但两边的码各有取值域，
 * 所以这里显式映射，而不是让 `REMOTE_SESSION_HISTORY_PATH_INVALID` 从写面接口里冒出来。
 */
const READER_PATH_CODE_TO_WRITER_CODE: Record<string, string> = {
	[REMOTE_SESSION_HISTORY_CODES.pathInvalid]: REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid,
	[REMOTE_SESSION_HISTORY_CODES.pathUnresolved]: REMOTE_SESSION_HISTORY_WRITER_CODES.pathUnresolved,
};

/**
 * 请求层的稳定码 → 本模块词汇。helper 的每一个 `SESSION_MAINTAIN_*` 码都自带确定结论（「没改」或
 * 「可能已改」），本表只做翻译，不改变语义方向：`COMMIT_UNCONFIRMED` 永远只能是 `resultUnconfirmed`，
 * 绝不落进「可重试」的那一侧。
 */
const MAINTENANCE_FAILURE_CODES: Readonly<Record<string, string>> = {
	SESSION_MAINTAIN_MESSAGE_NOT_FOUND: REMOTE_SESSION_HISTORY_WRITER_CODES.messageNotFound,
	SESSION_MAINTAIN_FILE_CHANGED: REMOTE_SESSION_HISTORY_WRITER_CODES.fileChanged,
	SESSION_MAINTAIN_FILE_TOO_LARGE: REMOTE_SESSION_HISTORY_WRITER_CODES.fileTooLarge,
	SESSION_MAINTAIN_FILE_INVALID: REMOTE_SESSION_HISTORY_WRITER_CODES.fileInvalid,
	SESSION_MAINTAIN_ROLE_INVALID: REMOTE_SESSION_HISTORY_WRITER_CODES.roleInvalid,
	SESSION_MAINTAIN_DRAFT_TOO_LARGE: REMOTE_SESSION_HISTORY_WRITER_CODES.draftTooLarge,
	SESSION_MAINTAIN_COMMIT_UNCONFIRMED: REMOTE_SESSION_HISTORY_WRITER_CODES.resultUnconfirmed,
	// 请求本身被对端判为不合法（main 侧校验漏了）：确定什么都没改，但仍是我们这边的问题。
	SESSION_MAINTAIN_INPUT_INVALID: REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed,
	// helper 亲自拒绝的路径：与读取侧同一条判据，只是这一侧才发现（我们发请求前已经校验过一次）。
	SESSION_MAINTAIN_PATH_INVALID: REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid,
	// 对端亲自回答的「没改」类：目标文件一个字节都没动。
	PERMISSION_DENIED: REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed,
	IO_ERROR: REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed,
	PROTOCOL_INVALID: REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed,
	// 版本过旧：没有这个 op。
	METHOD_NOT_FOUND: REMOTE_SESSION_HISTORY_WRITER_CODES.unavailable,
	// 本模块围栏自己的码。回执形状非法与「回执丢了」同路：请求已经发出，我们无法证明改写没发生，
	// 所以只能是「结果未确认」（让用户重新加载核对），不能是「目标未改动，请重试」。
	[REMOTE_SESSION_MAINTENANCE_CODES.inputInvalid]: REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed,
	[REMOTE_SESSION_MAINTENANCE_CODES.resultUnconfirmed]: REMOTE_SESSION_HISTORY_WRITER_CODES.resultUnconfirmed,
	[REMOTE_SESSION_MAINTENANCE_CODES.responseInvalid]: REMOTE_SESSION_HISTORY_WRITER_CODES.resultUnconfirmed,
	[REMOTE_SESSION_MAINTENANCE_OPTIONS_INVALID]: REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID,
};

/** 稳定码错误：`message` 本身就是码（远端 IPC 一系的既有约定），可选携带**展示参数**（体积）。 */
export class RemoteSessionHistoryWriteError extends Error {
	readonly details?: Record<string, unknown>;

	constructor(code: string, details?: Record<string, unknown>) {
		super(code);
		this.name = "RemoteSessionHistoryWriteError";
		this.details = details;
	}
}

/**
 * 把任意错误折叠成「稳定码 + 展示参数」（跨 realm 的 Error 取不到 instanceof，所以按 message 形状认码）。
 * 调用方据此把码映射成会话命令错误码，不需要知道本模块内部的异常类型。
 */
export function remoteSessionHistoryWriteFailure(error: unknown): { code: string; details?: Record<string, unknown> } {
	const code = stableCodeOf(error);
	const details = isRecord(error) && isRecord(error.details) ? error.details : undefined;
	if (code === undefined) return { code: REMOTE_SESSION_HISTORY_WRITER_CODES.transportFailed };
	return details === undefined ? { code } : { code, details };
}

function stableCodeOf(error: unknown): string | undefined {
	if (!isRecord(error)) return undefined;
	const message = error.message;
	return typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : undefined;
}

function stable(code: string, details?: Record<string, unknown>): RemoteSessionHistoryWriteError {
	return new RemoteSessionHistoryWriteError(code, details);
}

/** 只让本身已经是稳定码的 message 通过；其余折叠成 fallback（路径/命令行/errno/正文永不外传）。 */
function foldStable(error: unknown, fallback: string): RemoteSessionHistoryWriteError {
	const code = stableCodeOf(error) ?? fallback;
	const details = isRecord(error) && isRecord(error.details) ? error.details : undefined;
	return stable(code, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// 端口与入口
// ---------------------------------------------------------------------------

/** 快照端口：与读取/归档同一条 pinned SSH 通道，只跑 revision 快照（不传正文）。 */
export type RemoteSessionHistoryWriterTransportPort = {
	runRemoteCommand(input: { hostId: string; remoteCommand: string }): Promise<{ exitCode: number; stdout: string }>;
};

export type RemoteSessionHistoryWriterPorts = {
	transport: RemoteSessionHistoryWriterTransportPort;
	/** 唯一的改写通道：一条 host 级 helper 请求（`session.maintain`）。 */
	maintenance: RemoteSessionMaintenancePort;
	/** 既有连接服务已验证的远端 Node：守卫快照只能由它执行，不能临时走 PATH 或本机解释器兜底。 */
	resolveNodePath: (hostId: string) => Promise<string>;
	/** 相对身份需要它；缺失时相对 identity 以 `PATH_UNRESOLVED` fail-closed（绝不猜会话根）。 */
	resolveSessionRoot?: RemoteSessionHistoryRootPort;
	/** 只允许调小（测试用）；缺省 = 守卫脚本自己的上界。 */
	maxFileBytes?: number;
};

export type RemoteSessionMessageOperation = "edit" | "delete" | "resend";

export type RemoteSessionMessageMutationInput = {
	hostId: string;
	locator: SshSessionLocator;
	operation: RemoteSessionMessageOperation;
	/** 渲染层消息 id（live randomUUID 或合成 `${agentId}-history-${entryId}`）。 */
	messageId: string;
	/** 渲染层消息携带的文件条目 id（meta.entryId），首选锚点。 */
	entryId?: string;
	/** 协调器在停止前留存的有界身份摘要；仅内部传递，渲染层不能提供它。 */
	stoppedIdentity?: StoppedMessageIdentity;
	/** edit 的新正文；其余操作忽略。 */
	newText?: string;
};

/** 协调器依赖的窄接口：三条操作都只经这一个写面。 */
export type RemoteSessionMessageMutationPort = {
	mutate(input: RemoteSessionMessageMutationInput): Promise<{ text: string; images?: ImageContent[] } | undefined>;
};

export type RemoteSessionHistoryWriter = RemoteSessionMessageMutationPort;

export function createRemoteSessionHistoryWriter(ports: RemoteSessionHistoryWriterPorts): RemoteSessionHistoryWriter {
	if (!isRecord(ports) || typeof ports.transport?.runRemoteCommand !== "function" || typeof ports.resolveNodePath !== "function" || !isRecord(ports.maintenance) || typeof ports.maintenance.request !== "function") throw stable(REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID);
	const maxFileBytes = ports.maxFileBytes ?? REMOTE_SESSION_HISTORY_WRITE_MAX_BYTES;
	if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > REMOTE_SESSION_HISTORY_WRITE_MAX_BYTES) throw stable(REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID);
	const maintenance = createRemoteSessionMaintenance(ports.maintenance);

	/** hostId 要在发帧前就能当诊断身份与传输键用；非法值不回显（与读取侧同判据）。 */
	function readHostId(value: unknown): string | undefined {
		return typeof value === "string" && PROJECT_HOST_ID_PATTERN.test(value) ? value : undefined;
	}

	/** 发一条远端命令：失败一律折叠成稳定码，stderr 不外传（连接层自己的稳定码原样转述）。 */
	async function runRemoteCommand(hostId: string, command: string): Promise<{ exitCode: number; stdout: string }> {
		let result: { exitCode: number; stdout: string };
		try {
			result = await ports.transport.runRemoteCommand({ hostId, remoteCommand: command });
		} catch (error) {
			throw foldStable(error, REMOTE_SESSION_HISTORY_WRITER_CODES.transportFailed);
		}
		if (!isRecord(result) || typeof result.stdout !== "string" || !Number.isSafeInteger(result.exitCode)) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.transportFailed);
		return { exitCode: result.exitCode, stdout: result.stdout };
	}

	/**
	 * 发请求前读一次 revision（mode/size/dev/ino/uid/gid/mtimeNs/ctimeNs/digest）。
	 *
	 * 快照是**唯一**的冲突基线：远端据此做 compare-and-swap，文件只要不是这一版就 `fileChanged`。
	 * 守卫脚本亲自报告的码（fileTooLarge/commandFailed/…）带各自的确定含义，原样外传；
	 * 输出不可信（标记缺失/形状非法）折成 `transferInvalid`，绝不拿半份身份去发请求。
	 */
	async function snapshot(hostId: string, nodePath: string, remotePath: string): Promise<RemoteSessionFileRevision> {
		const nonce = randomBytes(8).toString("hex");
		const result = await runRemoteCommand(hostId, buildRemoteSessionWriteGuardCommand({ operation: "snapshot", nodePath, remotePath, nonce, maxBytes: maxFileBytes }));
		if (result.exitCode !== 0) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.commandFailed);
		const revision = parseRemoteSessionWriteGuardResult(result.stdout, remoteSessionHistoryMarker(nonce));
		if (revision === undefined) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.transferInvalid);
		return revision;
	}

	async function resolveRemotePath(input: { hostId: string; locator: SshSessionLocator }): Promise<string> {
		try {
			return await resolveRemoteSessionPath({ hostId: input.hostId, locator: input.locator, resolveSessionRoot: ports.resolveSessionRoot });
		} catch (error) {
			const code = stableCodeOf(error) ?? REMOTE_SESSION_HISTORY_CODES.pathInvalid;
			throw stable(READER_PATH_CODE_TO_WRITER_CODE[code] ?? REMOTE_SESSION_HISTORY_WRITER_CODES.pathInvalid);
		}
	}

	/** 请求层的稳定码 → 本模块词汇；没有专属映射的连接层码原样透出（与改动前的诊断口径一致）。 */
	function maintenanceFailure(error: unknown): RemoteSessionHistoryWriteError {
		const failure = remoteSessionMaintenanceFailure(error);
		return stable(MAINTENANCE_FAILURE_CODES[failure.code] ?? failure.code, failure.details);
	}

	return {
		async mutate(input) {
			const hostId = readHostId(input?.hostId);
			if (hostId === undefined) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.hostIdInvalid);
			const locator = readSshSessionLocator(input?.locator);
			if (locator === undefined || locator.hostId !== hostId) throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.locatorInvalid);
			const operation = input?.operation;
			if (operation !== "edit" && operation !== "delete" && operation !== "resend") throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.operationInvalid);
			const messageId = typeof input?.messageId === "string" ? input.messageId : "";
			const entryId = typeof input?.entryId === "string" && input.entryId.length > 0 ? input.entryId : undefined;
			const stoppedIdentity = input?.stoppedIdentity;
			// 先判后发：路径解析成功之前一条远端命令都不发。
			const remotePath = await resolveRemotePath({ hostId, locator });
			// 候选 id 是「谁」的唯一来源：空/形状非法 ⇒ 文件里不可能有这条消息，一个请求都不发，
			// 语义与远端回 MESSAGE_NOT_FOUND 完全相同（delete 仍是 no-op，其余报未找到）。
			const candidateIds = buildRemoteSessionMaintainCandidates({ messageId, entryIdHint: entryId ?? stoppedIdentity?.entryId });
			if (candidateIds.length === 0) {
				if (operation === "delete" && stoppedIdentity === undefined) return undefined;
				throw stable(REMOTE_SESSION_HISTORY_WRITER_CODES.messageNotFound);
			}
			let nodePath: string;
			try {
				nodePath = await ports.resolveNodePath(hostId);
			} catch (error) {
				throw foldStable(error, REMOTE_SESSION_HISTORY_WRITER_CODES.unavailable);
			}
			const expected = await snapshot(hostId, nodePath, remotePath);
			let draft: RemoteSessionMaintenanceDraft | undefined;
			try {
				draft = await maintenance.maintain({ hostId, path: remotePath, operation, candidateIds, newText: operation === "edit" ? (input.newText ?? "") : "", expected, maxFileBytes });
			} catch (error) {
				const failure = maintenanceFailure(error);
				// 文件里没有这条消息：delete 是 no-op（消息本来就不在历史里，不产生任何远端改动）。但协调器
				// 留过停止前身份摘要时，「找不到」也可能是定位缺陷，delete 必须拒绝，不能把缺陷伪装成删除成功。
				if (failure.message === REMOTE_SESSION_HISTORY_WRITER_CODES.messageNotFound && operation === "delete" && stoppedIdentity === undefined) return undefined;
				throw failure;
			}
			return draft;
		},
	};
}
