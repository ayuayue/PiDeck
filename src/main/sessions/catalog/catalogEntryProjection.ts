import { sessionLocatorFromLegacy } from "../../../shared/locationAdapters";
import { createSessionModelPreference } from "../../../shared/modelDisplayName";
import { readSshSessionLocator } from "../../../shared/projectLocation";
import { getImportedSessionSourceId, getSessionEnvironment } from "../../../shared/sessionIdentity";
import type { SessionLocator, SessionModelPreference, SessionRecord, SessionSummary } from "../../../shared/types";
import type { SessionCatalogEntry } from "../SessionCatalog";
import { catalogDisplayTitle } from "./catalogTitleOwnership";

export function cloneModelPreference(model: SessionModelPreference | undefined): SessionModelPreference | undefined {
	return model ? createSessionModelPreference(model.provider, model.modelId, model.modelName) : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSessionLocator(value: unknown): value is SessionLocator {
	if (!isRecord(value)) return false;
	if (value.kind === "local") {
		// 本地 locator 不得携带 hostId：那是一条扫描看不见的主机引用（与项目域同一判据）。放行会把
		// 「指向某主机」读成「本地会话 ⇒ 没有引用」，退役流程据此硬删仍被引用的主机。
		if (value.hostId !== undefined) return false;
		return (
			(value.environment === "native" || value.environment === "wsl") &&
			(value.filePath === undefined || (typeof value.filePath === "string" && value.filePath.length <= 4096)) &&
			(value.wslDistro === undefined || (typeof value.wslDistro === "string" && value.wslDistro.length <= 256)) &&
			(value.wslUser === undefined || (typeof value.wslUser === "string" && value.wslUser.length <= 256))
		);
	}
	if (value.kind !== "ssh") return false;
	// ssh 分支的唯一判据在 shared `readSshSessionLocator`（hostId 与项目域同一个权威值域）。
	// 这里不再写第二套规则：catalog 读取、登记写入与主机引用扫描同判，才不会出现
	// 「codec 放行、扫描抛错」这种同一记录两种结论。
	return readSshSessionLocator(value) !== undefined;
}

export function cloneSessionLocator(locator: SessionLocator | undefined): SessionLocator | undefined {
	if (!locator) return undefined;
	if (locator.kind === "ssh") return { ...locator, ...(locator.remotePathAliases ? { remotePathAliases: [...locator.remotePathAliases] } : {}) };
	return { ...locator };
}

export function cloneEntry(entry: SessionCatalogEntry): SessionCatalogEntry {
	return {
		...entry,
		...(entry.locator ? { locator: cloneSessionLocator(entry.locator) } : {}),
		model: cloneModelPreference(entry.model),
	};
}

export function normalizeEntryLocator(entry: SessionCatalogEntry): SessionCatalogEntry {
	const normalized = cloneEntry(entry);
	if (normalized.locator?.kind === "ssh") {
		normalized.filePath = undefined;
		normalized.originKey = undefined;
		normalized.piSessionId = undefined;
		normalized.wslDistro = undefined;
		normalized.wslUser = undefined;
		normalized.parentSessionPath = undefined;
	} else if (normalized.locator?.kind === "local") {
		normalized.filePath = normalized.locator.filePath;
		normalized.environment = normalized.locator.environment;
		normalized.wslDistro = normalized.locator.wslDistro;
		normalized.wslUser = normalized.locator.wslUser;
	}
	return normalized;
}

export function setLocalSessionFilePath(entry: SessionCatalogEntry, filePath: string | undefined): void {
	if (entry.locator?.kind === "ssh") throw new Error("UNSUPPORTED_PROJECT_LOCATION");
	if (entry.noSession || entry.backend === "dsh" || entry.backend === "imagegen") {
		entry.filePath = undefined;
		entry.locator = undefined;
		return;
	}
	entry.filePath = filePath;
	entry.locator = filePath
		? sessionLocatorFromLegacy({
				environment: entry.environment,
				filePath,
				wslDistro: entry.wslDistro,
				wslUser: entry.wslUser,
			})
		: undefined;
}

/** ssh 分支的 locator 类型；用 Extract 而不是再抄一遍结构，避免与 shared 契约漂移。 */
/** 写事务入口的入参形状：与宿主 enqueueMutation 的 mutate 逐字同形。 */
export type CatalogMutation<T> = (entries: SessionCatalogEntry[]) => { value: T; changed: boolean } | Promise<{ value: T; changed: boolean }>;

export type SshSessionLocator = Extract<SessionLocator, { kind: "ssh" }>;

/**
 * 同主机 + 同一条远端会话文件。
 *
 * 判据刻意只用 `remotePath`：远端 runtime 只上报这一条绝对路径（`remoteSessionId` 是相对会话根的
 * 推导结果，属于登记侧的产物），而 `ensureRemoteSession` 命中已有条目时会把两种写法收敛成上报值 ——
 * 所以「同一远端会话」在这里就是「同一主机上的同一个远端文件」。
 */
export function sameRemoteSessionPath(locator: SessionLocator | undefined, hostId: string, remotePath: string): boolean {
	return locator?.kind === "ssh" && locator.hostId === hostId && locator.remotePath === remotePath;
}

/** ssh locator 的身份字段比较（不含 alias：本批不读也不写 alias）。 */
export function sameSshLocator(left: SessionLocator | undefined, right: SshSessionLocator): boolean {
	if (left === undefined || left.kind !== "ssh") return false;
	return left.hostId === right.hostId && left.remoteSessionId === right.remoteSessionId && left.remotePath === right.remotePath;
}

/** 远端定位字段一旦变化就必须落盘；本地镜像字段非空说明读入路径没清干净，也要写回修掉。 */
export function remoteSessionEntryChanged(entry: SessionCatalogEntry, locator: SshSessionLocator, title: string | undefined, updatedAt: number): boolean {
	return (
		!sameSshLocator(entry.locator, locator) ||
		(title !== undefined && entry.title !== title) ||
		entry.updatedAt !== updatedAt ||
		entry.filePath !== undefined ||
		entry.originKey !== undefined ||
		entry.piSessionId !== undefined ||
		entry.wslDistro !== undefined ||
		entry.wslUser !== undefined ||
		entry.parentSessionPath !== undefined
	);
}

/** 控制字节：与 shared 的 SessionLocator 校验同域（路径里出现即非法）。 */
export const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export function equalModel(left?: SessionModelPreference, right?: SessionModelPreference): boolean {
	return left?.provider === right?.provider && left?.modelId === right?.modelId;
}

export function sessionLocatorForEntry(entry: SessionCatalogEntry, summary?: SessionSummary): SessionLocator | undefined {
	if (entry.locator?.kind === "ssh") return cloneSessionLocator(entry.locator);
	if (entry.noSession || entry.backend === "dsh" || entry.backend === "imagegen") return undefined;
	if (entry.locator) return cloneSessionLocator(entry.locator);
	if (summary?.locator) return cloneSessionLocator(summary.locator);
	const filePath = summary?.filePath ?? entry.filePath;
	if (!filePath) return undefined;
	return sessionLocatorFromLegacy({
		environment: summary ? getSessionEnvironment(summary) : entry.environment,
		filePath,
		wslDistro: entry.wslDistro,
		wslUser: entry.wslUser,
	});
}

export function recordFromEntry(entry: SessionCatalogEntry, summary?: SessionSummary): SessionRecord {
	const locator = sessionLocatorForEntry(entry, summary);
	const recordSummary = locator?.kind === "ssh" ? undefined : summary;
	return {
		id: entry.id,
		projectId: entry.projectId,
		title: catalogDisplayTitle(entry.title) || "Untitled",
		noSession: entry.noSession,
		source: recordSummary?.source ?? entry.source,
		environment: recordSummary ? getSessionEnvironment(recordSummary) : entry.environment,
		channel: entry.channel,
		backend: entry.backend,
		sideTask: entry.sideTask,
		...(locator ? { locator } : {}),
		filePath: locator ? (locator.kind === "local" ? locator.filePath : undefined) : (recordSummary?.filePath ?? entry.filePath),
		wslDistro: locator?.kind === "ssh" ? undefined : entry.wslDistro,
		wslUser: locator?.kind === "ssh" ? undefined : entry.wslUser,
		importedSourceId: recordSummary ? getImportedSessionSourceId(recordSummary) : entry.importedSourceId,
		parentSessionPath: locator?.kind === "ssh" ? undefined : (recordSummary?.parentSessionPath ?? entry.parentSessionPath),
		forked: entry.forked,
		supersededBy: entry.supersededBy,
		mergedSessionIds: entry.mergedSessionIds ? [...entry.mergedSessionIds] : undefined,
		projectPath: locator?.kind === "ssh" ? undefined : recordSummary?.projectPath,
		preview: recordSummary?.preview ?? "",
		messageCount: recordSummary?.messageCount ?? 0,
		status: entry.status,
		model: entry.model ? { ...entry.model } : undefined,
		thinkingLevel: entry.thinkingLevel,
		permissionPreset: entry.permissionPreset,
		agentPreset: entry.agentPreset,
		acpToolId: entry.acpToolId,
		dshSessionId: entry.dshSessionId,
		acpSessionId: entry.acpSessionId,
		proxy: entry.proxy ? { ...entry.proxy } : undefined,
		createdAt: entry.createdAt,
		// 返回记录与持久化活动时间同口径，不能让旧扫描摘要把刚保住的排序时间又投影回去。
		updatedAt: Math.max(entry.updatedAt, recordSummary?.updatedAt ?? entry.updatedAt),
		wsl: locator?.kind === "ssh" ? undefined : recordSummary?.wsl,
		codexSessionId: recordSummary?.codexSessionId,
		codexThreadSource: recordSummary?.codexThreadSource,
		codexParentThreadId: recordSummary?.codexParentThreadId,
		codexAgentRole: recordSummary?.codexAgentRole,
		codexAgentNickname: recordSummary?.codexAgentNickname,
	};
}

/**
 * 远端会话身份的写入口（`attachRuntime` 的 ssh 分支）。语义与上面本机「文件配对」分支**一一对应**：
 *
 * - 本机：draft 拿到 filePath 后按 originKey 吸收同一文件已有的重复条目；
 * - 远端：draft 拿到 pi 上报的远端路径后按 (hostId, remotePath) 吸收握手登记（`ensureRemoteSession`）
 *   先立的那条记录。
 *
 * 两条分支的落点相同：**渲染层手上那个 sessionId 必须是唯一存活的记录**，否则侧栏出现两条。
 * 差别只在「身份是什么」：本机是路径 originKey，远端是 ssh 身份，因此远端分支绝不碰 filePath /
 * originKey / piSessionId —— 由 `normalizeEntryLocator` 的 ssh 分支统一清空本地镜像字段。
 *
 * 相对身份（remoteSessionId）由被吸收的记录带过来：会话根在哪由 `RemoteRuntimePort` 判定，catalog
 * 不复刻那套规则（配了自定义 `sessionDir` 的机器上会算错）；这条条目自己已有的身份同样保留
 * （恢复同一会话时不能因为「只回写了路径」把相对身份/别名丢掉）。
 */
export function attachRemoteLocatorEntry(entries: SessionCatalogEntry[], entry: SessionCatalogEntry, remoteLocator: SshSessionLocator): { value: SessionCatalogEntry; changed: boolean } {
	// 身份只经 shared 的唯一判据（hostId 值域与项目域/扫描/引用审计同一处）。
	const locator = readSshSessionLocator(remoteLocator);
	const remotePath = locator?.remotePath;
	if (!locator || remotePath === undefined) throw new Error("REMOTE_SESSION_IDENTITY_INVALID");
	const currentLocator = entry.locator?.kind === "ssh" ? entry.locator : undefined;
	const duplicateIndex = entries.findIndex((candidate) => candidate.id !== entry.id && sameRemoteSessionPath(candidate.locator, locator.hostId, remotePath));
	const duplicate = duplicateIndex >= 0 ? entries[duplicateIndex] : undefined;
	const duplicateLocator = duplicate?.locator?.kind === "ssh" ? duplicate.locator : undefined;
	// 已经是同一身份的条目：locator 原样保留（包括 remoteSessionId 与 remotePathAliases）——恢复同一
	// 会话时的回写是幂等的，不能因为它没带相对身份就把已存的身份冲掉。
	const sameIdentity = currentLocator !== undefined && sameRemoteSessionPath(currentLocator, locator.hostId, remotePath);
	const inheritedRemoteSessionId = duplicateLocator?.remoteSessionId ?? currentLocator?.remoteSessionId;
	const next = normalizeEntryLocator({
		...entry,
		locator: sameIdentity ? currentLocator : { ...locator, ...(inheritedRemoteSessionId !== undefined ? { remoteSessionId: inheritedRemoteSessionId } : {}) },
	});
	if (duplicate) {
		// 补空缺顺序与本机分支一致：只填本记录没有的值，已有值（用户选择/更早的创建时间）优先。
		next.model ??= duplicate.model;
		next.thinkingLevel ??= duplicate.thinkingLevel;
		next.importedSourceId ??= duplicate.importedSourceId;
		next.createdAt = Math.min(next.createdAt, duplicate.createdAt);
		entries.splice(duplicateIndex, 1);
	}
	next.status = "active";
	next.updatedAt = Date.now();
	// 用 id 回填：上面的 splice 会让下标整体前移，按下标写会写错条目。
	const targetIndex = entries.findIndex((candidate) => candidate.id === entry.id);
	if (targetIndex < 0) throw new Error("REMOTE_SESSION_IDENTITY_INVALID");
	entries[targetIndex] = next;
	return { value: cloneEntry(next), changed: true };
}
