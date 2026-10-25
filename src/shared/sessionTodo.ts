/**
 * 会话 todo 快照解析（跨进程共用纯函数）。
 *
 * pi-deck-todo.ts 扩展在每次 todo 变更时通过 pi.appendEntry("pi-deck-todo", state)
 * 把 version-3 三态快照持久化到会话文件；分支上最后一条即最新状态。
 * 本模块供 main（会话 todo 快照 IPC）解析快照 data，无运行时依赖，可被 node 单测直接加载。
 *
 * 只接受 version===3 的快照：旧格式（legacy `{todos,nextId}`、v2 `done`、未知版本）
 * 一律视为无计划返回 undefined，不迁移、不转换、不写回（与扩展读取口径一致）。
 */
import type { SessionTodoSnapshot } from "./types/sessionTodo.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 pi-deck-todo 快照 data：
 * - 仅接受 version===3 且带 activePlan 的快照；clear 后无 activePlan、
 *   legacy/v2/未知版本等旧格式一律 → undefined（渲染层显示空态）；
 * - todos 逐项校验（id 正安全整数、text 非空字符串、status 三态之一，与扩展解码同口径），
 *   坏项丢弃而非整体失败。
 */
export function parseTodoSnapshotData(data: unknown): SessionTodoSnapshot | undefined {
	if (!isRecord(data)) return undefined;
	if (data.version !== 3) return undefined;
	const plan = isRecord(data.activePlan) ? data.activePlan : undefined;
	if (!plan) return undefined;
	const planId = typeof plan.id === "number" && Number.isSafeInteger(plan.id) && plan.id > 0 ? plan.id : 0;
	if (!Array.isArray(plan.todos)) return { planId, todos: [] };
	const todos: SessionTodoSnapshot["todos"] = [];
	for (const raw of plan.todos) {
		if (!isRecord(raw)) continue;
		const id = raw.id;
		if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;
		const text = raw.text;
		if (typeof text !== "string" || !text.trim()) continue;
		const status = raw.status;
		if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
		todos.push({ id, text, status });
	}
	return { planId, todos };
}
