/**
 * DSH `agentTeam` projection 解析（agent-team 实验预设，默认关）。
 *
 * 数据面取舍（P1 调研结论）：官方 client-ui-agent-team 面板读 lead 会话投影 map 的
 * `agentTeam` 键（TeamProjection：members roster + 任务板 + failure），发布通道与
 * todos/inbox 同一条 `session/control` 投影帧 + `session.history` 尾页 projections
 * baseline——PiDeck 投影管线（DshAgentManager.applyProjectionFrame/applyProjectionBaseline）
 * 已消费这两个来源，因此不需要新增 RPC 查询封装，只把该 key 加进白名单并在此解析。
 *
 * 解析规则与 parseDshTodoList/parseDshInboxProjection 同风格：
 * - null → null（显式清空）；
 * - members/tasks 缺失或非数组 → undefined（脏帧，调用方保持原值，不得半清）；
 * - 单项非法只跳过该项（roster 行/任务行相互独立，一条脏项不应掩盖其余可操作行）；
 * - 字段收窄到面板所需（成员 id/name/role/phase/error，任务 id/subject/description/
 *   status/ownerName/ready），blockedBy/writeScopes 等细节数组不透传给渲染层。
 */
import type { DshTeamMember, DshTeamState, DshTeamTask } from "../../shared/types/agent";

/** 运行时收窄：仅当值是对象且非数组时返回。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMember(raw: unknown): DshTeamMember | undefined {
	if (!isRecord(raw)) return undefined;
	const id = typeof raw.id === "string" ? raw.id : "";
	const name = typeof raw.name === "string" ? raw.name : "";
	const role = raw.role;
	const phase = raw.phase;
	if (!id || !name) return undefined;
	if (role !== "lead" && role !== "teammate") return undefined;
	if (phase !== "provisioning" && phase !== "active" && phase !== "failed") return undefined;
	return { id, name, role, phase, ...(typeof raw.error === "string" && raw.error ? { error: raw.error } : {}) };
}

function parseTask(raw: unknown): DshTeamTask | undefined {
	if (!isRecord(raw)) return undefined;
	const id = typeof raw.id === "string" ? raw.id : "";
	const subject = typeof raw.subject === "string" ? raw.subject : "";
	if (!id || !subject) return undefined;
	const status = raw.status;
	if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "deleted") return undefined;
	return {
		id,
		subject,
		description: typeof raw.description === "string" ? raw.description : "",
		status,
		...(typeof raw.ownerName === "string" && raw.ownerName ? { ownerName: raw.ownerName } : {}),
		ready: raw.ready === true,
	};
}

/**
 * 整值解析官方 `agentTeam` 投影（TeamProjection）。
 * - null：显式清空；
 * - 合法对象：归一化 DshTeamState（单项脏行跳过，可展示其余行）；
 * - 其余（非对象 / members/tasks 非数组）：undefined，调用方保持原值。
 */
export function parseDshTeamProjection(value: unknown): DshTeamState | null | undefined {
	if (value === null) return null;
	if (!isRecord(value)) return undefined;
	const { members, tasks } = value;
	if (!Array.isArray(members) || !Array.isArray(tasks)) return undefined;
	const parsedMembers = members.flatMap((raw) => {
		const parsed = parseMember(raw);
		return parsed ? [parsed] : [];
	});
	const parsedTasks = tasks.flatMap((raw) => {
		const parsed = parseTask(raw);
		return parsed ? [parsed] : [];
	});
	return {
		members: parsedMembers,
		tasks: parsedTasks,
		...(typeof value.failure === "string" && value.failure ? { failure: value.failure } : {}),
	};
}
