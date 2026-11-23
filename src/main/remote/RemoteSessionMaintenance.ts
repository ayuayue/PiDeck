/**
 * 远端会话历史改写的唯一传输：一条 host 级 helper 请求（`session.maintain`，helper 1.38.0）。
 *
 * 为什么换掉整份搬运：过去 main 把整份远端 JSONL 分块读回、在本机改内存、再 4 KiB 分块上传——一条
 * 1 MiB 的会话就是上百条 SSH 命令，成本随字节线性增长。改写规则本身（活动分支、过程链、
 * `context_edit`、墓碑）只依赖那台机器上的文件，所以它们整体搬进 helper；main 只发一次请求：
 * 操作、候选 id、新正文、允许根，以及 **main 读到的 revision**，拿回 `{ revision, draft }`。
 *
 * 本模块是那条通道的**薄**客户端（不 spawn、不碰本机文件系统、不知道会话根）：
 * - 组装参数：候选 id 最具体优先、`allowedRoots` = 目标文件自己的目录、revision 原样回传；
 * - 发**一次**请求（破坏性动作不重试：重试可能基于旧快照再写一遍）；
 * - 严格复核回答形状（缺字段/多字段/类型错/草案超界一律拒绝）：helper 的回答是**远端数据**；
 * - 把失败折叠成稳定码，并区分「确定没改」与「可能已改」——后者只有一个说法，绝不谎报成功或提示重试。
 *
 * 不变量：
 * - **先判后发**：候选 id 为空/超长含控制字节、路径非规范都一个请求都不发；
 * - 候选 id 顺序就是定位顺序（`meta.entryId` 的投影 id → 裸 entryId → 渲染层消息 id）。main **不**
 *   在这里重算活动分支/指纹：谁是这条消息由远端决定，同一判据只能有一份实现；
 * - 失败分类是穷尽的：帧可能已写出的一切失败 →「未确认」；帧没写出 / 对端亲自回答的码 → 原样透出，
 *   交给写入侧按既有词汇映射。
 */
import type { ImageContent } from "../../shared/types";
import {
	REMOTE_HELPER_ERROR_CODES,
	REMOTE_HELPER_MAX_ID_LENGTH,
	REMOTE_HELPER_METHOD_SESSION_MAINTAIN,
	REMOTE_SESSION_MAINTAIN_MAX_ALLOWED_ROOTS,
	REMOTE_SESSION_MAINTAIN_MAX_CANDIDATE_IDS,
	REMOTE_SESSION_MAINTAIN_MAX_DRAFT_BYTES,
	REMOTE_SESSION_MAINTAIN_MAX_ENTRIES,
	REMOTE_SESSION_MAINTAIN_MAX_FILE_BYTES,
	REMOTE_SESSION_MAINTAIN_MAX_LINE_BYTES,
	REMOTE_SESSION_MAINTAIN_REQUEST_TIMEOUT_MS,
	type RemoteFileRevisionWire,
	type RemoteSessionMaintainOperation,
	type RemoteSessionMaintainParams,
} from "./RemoteHelperContract";
import { validateRemoteSessionHistoryPath } from "./RemoteSessionHistoryReader";
import { readRemoteSessionFileRevision } from "./RemoteSessionWriteGuard";

/**
 * 本模块自己的稳定码（helper 的码原样透出，这些只描述**请求发不出去**或**回执不可信**）。
 *
 * 与 helper 词汇互补而不是替代：`SESSION_MAINTAIN_*` 是对端亲自回答的确定结论（没改 / 可能已改），
 * 这里三个码描述的是围栏本身（参数、回执形状、装配）。**没有**「请求失败、请重试」这一类：
 * 帧写出之后我们无法证明「什么都没发生」，所以那一侧只有 `resultUnconfirmed` 一种说法。
 */
export const REMOTE_SESSION_MAINTENANCE_CODES = {
	/** 本地参数不合法（候选 id 为空/超长、操作不在域内、路径不是绝对目录下的文件）：一个请求都不发。 */
	inputInvalid: "REMOTE_SESSION_MAINTAIN_REQUEST_INVALID",
	/** 帧已写出、回执没拿到（超时、连接中断、对端崩溃、没有稳定码的抛出）：**可能已经提交**，必须重读核对。 */
	resultUnconfirmed: "REMOTE_SESSION_MAINTAIN_RESULT_UNCONFIRMED",
	/** 回执形状非法（缺字段/多字段/类型错/草案超界）：输出不可信，绝不据此宣称成功。 */
	responseInvalid: "REMOTE_SESSION_MAINTAIN_RESPONSE_INVALID",
} as const;

/** 构造期装配不合法（与其它远端模块一致：构造即抛，不等到第一次改写）。 */
export const REMOTE_SESSION_MAINTENANCE_OPTIONS_INVALID = "REMOTE_SESSION_MAINTAIN_OPTIONS_INVALID";

/** 发起一次 helper 请求的入口：与 `RemoteWorkspaceReader` / `RemoteSearchReader` 同形。 */
export type RemoteSessionMaintenancePort = {
	request: (hostId: string, method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
};

export type RemoteSessionMaintenanceCall = {
	hostId: string;
	/** 已按读取侧同一判据解析/校验过的**绝对**远端会话文件路径。 */
	path: string;
	operation: RemoteSessionMaintainOperation;
	/** 定位顺序：最具体在前（见 `buildRemoteSessionMaintainCandidates`）。 */
	candidateIds: readonly string[];
	/** edit 的新正文；delete/resend 必须是空串（冻结契约）。 */
	newText: string;
	/** main 在发请求前读到并复核过的 revision：远端据此做 compare-and-swap。 */
	expected: RemoteFileRevisionWire;
	/** 复核回执 revision 的字节上界（与 main 快照的守卫上界同源，只允许调小）。 */
	maxFileBytes: number;
};

/** 一次改写的结果：resend 带回原文草稿（正文 + 参考图），其余操作没有返回值。 */
export type RemoteSessionMaintenanceDraft = { text: string; images?: ImageContent[] };

export type RemoteSessionMaintenance = {
	maintain(call: RemoteSessionMaintenanceCall): Promise<RemoteSessionMaintenanceDraft | undefined>;
};

/** 稳定码错误：`message` 就是码（远端 IPC 一系的既有约定），`details` 只带展示参数（体积）。 */
export class RemoteSessionMaintenanceError extends Error {
	readonly details?: Record<string, unknown>;

	constructor(code: string, details?: Record<string, unknown>) {
		super(code);
		this.name = "RemoteSessionMaintenanceError";
		this.details = details;
	}
}

/** 把任意错误折叠成「稳定码 + 展示参数」（跨 realm 取不到 instanceof，按 message 形状认码）。 */
export function remoteSessionMaintenanceFailure(error: unknown): { code: string; details?: Record<string, unknown> } {
	const details = isRecord(error) && isRecord(error.details) ? error.details : undefined;
	const code = stableCodeOf(error) ?? REMOTE_SESSION_MAINTENANCE_CODES.resultUnconfirmed;
	return details === undefined ? { code } : { code, details };
}

function stableCodeOf(error: unknown): string | undefined {
	if (!isRecord(error)) return undefined;
	const message = error.message;
	return typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : undefined;
}

function refuse(code: string, details?: Record<string, unknown>): never {
	throw new RemoteSessionMaintenanceError(code, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 候选 id 的形状：可打印 ASCII、无空白/控制字节、不超过契约的单 id 长度。 */
const CANDIDATE_ID = new RegExp(`^[\\x21-\\x7E]{1,${REMOTE_HELPER_MAX_ID_LENGTH}}$`);
/** 草案里的图片：mime 是 `type/subtype`，载荷是 base64 字符集（命令/帧里因此不需要转义）。 */
const MIME_TYPE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/i;
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 渲染层合成消息 id（`${agentId}-history-${entryId}`）→ agentId。
 *
 * 与读取侧把同一个合成 id 解析成 entryId 是同一条规则的两个方向：只有从 UI 手里那个 id 里取回 agentId，
 * 才能为 `meta.entryId` 提示拼出**同一条投影身份**（远端因此不必猜测前缀形状）。
 */
function historyAgentIdOf(messageId: string): string | undefined {
	const marker = "-history-";
	const index = messageId.lastIndexOf(marker);
	return index > 0 ? messageId.slice(0, index) : undefined;
}

/**
 * 候选 id，最具体在前：`meta.entryId` 提示的投影 id → 裸提示 id → 渲染层消息 id。
 *
 * 为什么是这个顺序：live 消息的 id 是随机 UUID，文件里只认 entryId；投影 id 与裸 id 都可能是文件里
 * 真正的 `id`，而渲染层原始 id 只是最后的兜底（旧会话没有 `message.id` 时它自己就是 entryId）。
 * 去重、丢掉空的与形状非法的（它们不可能是文件里的 id），最多 3 条——冻结契约的上界。
 * 提示来自 `input.entryId`，没有时用协调器停止前留存的 `stoppedIdentity.entryId`：两者同义。
 * 合成 id 的解析（`-history-` 后面那段 entryId）与活动分支判定都在远端：这里只按顺序交名字。
 */
export function buildRemoteSessionMaintainCandidates(input: { messageId: string; entryIdHint?: string }): string[] {
	const hint = input.entryIdHint;
	const agentId = historyAgentIdOf(input.messageId);
	const candidates = [hint !== undefined && agentId !== undefined ? `${agentId}-history-${hint}` : undefined, hint, input.messageId];
	const result: string[] = [];
	for (const candidate of candidates) {
		if (typeof candidate !== "string" || !CANDIDATE_ID.test(candidate) || result.includes(candidate)) continue;
		result.push(candidate);
		if (result.length === REMOTE_SESSION_MAINTAIN_MAX_CANDIDATE_IDS) break;
	}
	return result;
}

/**
 * 组装请求参数（纯函数：测试直接断言线上形状）。`allowedRoots` 只有**目标文件自己的目录**：
 * 会话文件只能被它所在目录下的 realpath 改写进/写出，多给目录等于放宽这一条。
 */
export function buildRemoteSessionMaintainParams(call: RemoteSessionMaintenanceCall): RemoteSessionMaintainParams {
	const path = validateRemoteSessionHistoryPath(call?.path);
	if (path === undefined) refuse(REMOTE_SESSION_MAINTENANCE_CODES.inputInvalid);
	const operation = call?.operation;
	if (operation !== "edit" && operation !== "delete" && operation !== "resend") refuse(REMOTE_SESSION_MAINTENANCE_CODES.inputInvalid);
	const candidateIds = call.candidateIds;
	if (!Array.isArray(candidateIds) || candidateIds.length === 0 || candidateIds.length > REMOTE_SESSION_MAINTAIN_MAX_CANDIDATE_IDS) refuse(REMOTE_SESSION_MAINTENANCE_CODES.inputInvalid);
	for (const candidate of candidateIds) if (typeof candidate !== "string" || !CANDIDATE_ID.test(candidate)) refuse(REMOTE_SESSION_MAINTENANCE_CODES.inputInvalid);
	if (typeof call.newText !== "string") refuse(REMOTE_SESSION_MAINTENANCE_CODES.inputInvalid);
	if (!isRecord(call.expected)) refuse(REMOTE_SESSION_MAINTENANCE_CODES.inputInvalid);
	const separator = path.lastIndexOf("/");
	const directory = separator > 0 ? path.slice(0, separator) : "";
	const allowedRoots = validateRemoteSessionHistoryPath(directory) === undefined ? [] : [directory];
	if (allowedRoots.length === 0 || allowedRoots.length > REMOTE_SESSION_MAINTAIN_MAX_ALLOWED_ROOTS) refuse(REMOTE_SESSION_MAINTENANCE_CODES.inputInvalid);
	return {
		path,
		operation,
		candidateIds: [...candidateIds],
		newText: operation === "edit" ? call.newText : "",
		allowedRoots,
		expected: call.expected,
		// 这些是 helper 自己的界（契约常量），不是第二套策略：main 已经把 revision 钉在它读到的版本上。
		limits: {
			maxFileBytes: REMOTE_SESSION_MAINTAIN_MAX_FILE_BYTES,
			maxLineBytes: REMOTE_SESSION_MAINTAIN_MAX_LINE_BYTES,
			maxEntries: REMOTE_SESSION_MAINTAIN_MAX_ENTRIES,
			maxDraftBytes: REMOTE_SESSION_MAINTAIN_MAX_DRAFT_BYTES,
		},
	};
}

/** 只接受契约里列出的键：多一个键就说明对端不是这个版本，回执整体不可信。 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * 复核回执里的 revision：复用守卫模块的严格重建（同一个 revision 定义、同一条「只认白名单字段」规则），
 * 但把它的失败折成本模块的「回执不可信」——这里判断的是**回答**，不是本机命令的输出。
 */
function readAnswerRevision(value: unknown, maxFileBytes: number): RemoteFileRevisionWire {
	try {
		return readRemoteSessionFileRevision(value, maxFileBytes);
	} catch {
		return refuse(REMOTE_SESSION_MAINTENANCE_CODES.responseInvalid);
	}
}

/** 复核 resend 的草稿：正文 + 参考图，且总量必须小于 helper 自己的草案上界（本地再算一次，不信声明值）。 */
function readAnswerDraft(value: unknown): RemoteSessionMaintenanceDraft {
	if (!isRecord(value) || !hasExactKeys(value, ["text", "images"]) || typeof value.text !== "string" || !Array.isArray(value.images)) refuse(REMOTE_SESSION_MAINTENANCE_CODES.responseInvalid);
	let size = Buffer.byteLength(value.text, "utf8");
	const images: ImageContent[] = [];
	for (const entry of value.images) {
		if (!isRecord(entry) || !hasExactKeys(entry, ["mime", "dataBase64"])) refuse(REMOTE_SESSION_MAINTENANCE_CODES.responseInvalid);
		const { mime, dataBase64 } = entry;
		// base64 长度必须是 4 的倍数：被截断的载荷解码出来是坏图片，宁可整份不信。
		if (typeof mime !== "string" || !MIME_TYPE.test(mime) || typeof dataBase64 !== "string" || !BASE64_PAYLOAD.test(dataBase64) || dataBase64.length % 4 !== 0) refuse(REMOTE_SESSION_MAINTENANCE_CODES.responseInvalid);
		size += dataBase64.length;
		images.push({ type: "image", mimeType: mime, data: dataBase64 });
	}
	// helper 自己的上界：它必须在截断历史**之前**拒绝（`SESSION_MAINTAIN_DRAFT_TOO_LARGE`）。收到更大的
	// 草稿说明对端不是这份契约，输出不可信——宁可让用户重新加载核对，也不偷偷把半份草稿交给重发。
	if (size > REMOTE_SESSION_MAINTAIN_MAX_DRAFT_BYTES) refuse(REMOTE_SESSION_MAINTENANCE_CODES.responseInvalid);
	return images.length > 0 ? { text: value.text, images } : { text: value.text };
}

/**
 * 复核整个回执：edit/delete 的 `draft` 必须是 `null`（没有正文可回），resend 必须是草稿对象。
 * 类型对不上就是违约：宁可报「回执不可信」，也不把 null 当成功、或把一份草稿塞进删除的返回值。
 */
function readAnswer(value: unknown, operation: RemoteSessionMaintainOperation, maxFileBytes: number): RemoteSessionMaintenanceDraft | undefined {
	if (!isRecord(value) || !hasExactKeys(value, ["revision", "draft"])) refuse(REMOTE_SESSION_MAINTENANCE_CODES.responseInvalid);
	readAnswerRevision(value.revision, maxFileBytes);
	if (operation !== "resend") {
		if (value.draft !== null) refuse(REMOTE_SESSION_MAINTENANCE_CODES.responseInvalid);
		return undefined;
	}
	return readAnswerDraft(value.draft);
}

/**
 * 帧写出**之前**就能证明什么都没发生的码：连接未就绪 / 管理器已释放。
 * 它们必须在原样透出（与本机其它远端模块同一条诊断口径），不能被折叠成「结果未确认」。
 */
const NEVER_SENT_CODES = new Set<string>(["SSH_CONNECTION_NOT_READY", "SSH_CONNECTION_MANAGER_DISPOSED"]);

/**
 * 对端**亲自回答**的码：每一个都自带确定结论（没改，或只有 `SESSION_MAINTAIN_COMMIT_UNCONFIRMED`
 * 表示可能已改），所以原样透出，由写入侧按既有词汇映射。
 *
 * 不在这个集合里的任何失败（`REQUEST_TIMEOUT`、`REMOTE_CONNECTION_LOST`、`HELPER_INTERNAL`、没有稳定
 * 码的抛出、未知码）都意味着「帧可能已经写出、回执没拿到」——那正是结果未确认的前提，
 * 绝不折叠成可重试的失败。
 */
const ANSWERED_CODES = new Set<string>([...REMOTE_HELPER_ERROR_CODES.filter((code) => code.startsWith("SESSION_MAINTAIN_")), "METHOD_NOT_FOUND", "PERMISSION_DENIED", "IO_ERROR", "PROTOCOL_INVALID"]);

/** 请求失败的三分类（见上面两个集合的注释）。 */
function classifyRequestFailure(error: unknown): RemoteSessionMaintenanceError {
	const { code, details } = remoteSessionMaintenanceFailure(error);
	if (NEVER_SENT_CODES.has(code) || ANSWERED_CODES.has(code)) return new RemoteSessionMaintenanceError(code, details);
	return new RemoteSessionMaintenanceError(REMOTE_SESSION_MAINTENANCE_CODES.resultUnconfirmed, details);
}

/**
 * 发一次 `session.maintain`。
 *
 * 时限用契约常量：传输不再随文件大小增长，所以一个固定预算就够；不传 `onRequestId`，因为这里没有
 * 「取消一次破坏性写入」这种动作（本地放弃等待不等于回滚，只会制造「以为取消了其实已经改了」）。
 */
export function createRemoteSessionMaintenance(port: RemoteSessionMaintenancePort): RemoteSessionMaintenance {
	if (!isRecord(port) || typeof port.request !== "function") refuse(REMOTE_SESSION_MAINTENANCE_OPTIONS_INVALID);
	return {
		async maintain(call) {
			const params = buildRemoteSessionMaintainParams(call);
			let answer: unknown;
			try {
				answer = await port.request(call.hostId, REMOTE_HELPER_METHOD_SESSION_MAINTAIN, params, { timeoutMs: REMOTE_SESSION_MAINTAIN_REQUEST_TIMEOUT_MS });
			} catch (error) {
				throw classifyRequestFailure(error);
			}
			return readAnswer(answer, params.operation, call.maxFileBytes);
		},
	};
}
