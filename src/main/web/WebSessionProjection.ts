/**
 * /api/state 会话投影（Web 端专用）。
 *
 * 背景：`/api/state` 的会话数组占整个快照 ~99%（525 条会话 ≈ 295KB），其中
 * `filePath` / `environment` / `dshSessionId` / `agentPreset` / `preview` /
 * `messageCount` 等字段 Web 端（React A2 与 legacy A1 兜底页）从不读取——它们只服务
 * 桌面端主进程内部逻辑。局域网/外网访问时这些字节是纯浪费，故在此按「Web 真正消费的
 * 字段集」投影一次，快照体积降到原来的 ~1/3。
 *
 * 边界：只投影 `/api/state`（含 /api/events 的 SSE 快照，两者共用 getState）。
 * 新增 Web 端读取字段时必须同步加进这里，否则渲染层拿到 undefined。
 */
import type { SessionModelPreference, SessionRecord } from "../../shared/types/session";
import type { AgentBackend } from "../../shared/types/agent";

/** Web 端可见的会话形状：字段集与渲染层 `webTypes.ts` 的 `WebSession` 对齐。 */
export type WebPublicSession = {
	id: string;
	projectId: string;
	title: string;
	status: string;
	projectPath?: string;
	model?: SessionModelPreference;
	thinkingLevel?: string;
	/** 运行时后端（pi/dsh；缺省 pi），侧栏/头部徽标展示用 */
	backend?: AgentBackend;
	/** 最近活动时间（毫秒时间戳），会话列表按此降序 */
	updatedAt?: number;
	/** 分支导航：fork 自哪条会话 / 是否为 fork 产物 / 创建时间 */
	parentSessionId?: string;
	forked?: boolean;
	createdAt?: number;
	/** DSH 权限预设（与 SessionRecord 同名，原样投影） */
	permissionPreset?: string;
};

/**
 * 会话记录 → Web 可见投影。
 *
 * 只挑字段、不做任何语义加工：服务端保持单一数据源，渲染层拿到的值与桌面端一致。
 */
export function toPublicSession(record: SessionRecord): WebPublicSession {
	return {
		id: record.id,
		projectId: record.projectId,
		title: record.title,
		status: record.status,
		projectPath: record.projectPath,
		model: record.model,
		thinkingLevel: record.thinkingLevel,
		backend: record.backend,
		updatedAt: record.updatedAt,
		parentSessionId: record.parentSessionId,
		forked: record.forked,
		createdAt: record.createdAt,
		permissionPreset: record.permissionPreset,
	};
}

export function toPublicSessions(records: readonly SessionRecord[]): WebPublicSession[] {
	return records.map(toPublicSession);
}
