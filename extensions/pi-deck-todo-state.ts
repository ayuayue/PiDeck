/**
 * PiDeck Todo 三态状态纯模块（v3 快照）。
 *
 * 本模块不 import 任何 pi API、不注册工具、不持久化：只做 v3 快照解码、
 * 操作 reducer、预算与输出格式化、压缩后补注判定。pi-deck-todo.ts 扩展在真实变更时把
 * v3 快照 appendEntry 到会话文件；读取时只接受 version===3 且全量合法的快照，
 * 其余（legacy `{todos,nextId}`、v2 `done`、未知版本、坏项）一律视为无计划：
 * 不迁移、不写回、不静默截断。
 *
 * reducer 是纯函数：输入 current 视为不可变，失败只返回错误、不产生新状态，
 * 保证「校验失败保留之前计划与撤销槽」的原子性契约。
 *
 * @packageDocumentation
 */

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
	id: number;
	text: string;
	status: TodoStatus;
}

export interface TodoPlan {
	id: number;
	todos: TodoItem[];
}

/** 持久化 v3 快照。零项时没有 `activePlan`。 */
export interface TodoState {
	version: 3;
	activePlan?: TodoPlan;
	previousPlan?: TodoPlan;
	nextPlanId: number;
	nextTodoId: number;
}

/** 输入预算：单项 text 上限（UTF-16 code units）与计划条数上限。 */
export const MAX_TODO_TEXT_LENGTH = 1000;
export const MAX_TODO_COUNT = 100;

/** 模型可见正文输出预算：防止 100 项 × 1000 字无限拼接上下文。 */
export const MAX_MODEL_VISIBLE_ITEMS = 30;

// ---------------------------------------------------------------------------
// 基元
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return value === "pending" || value === "in_progress" || value === "completed";
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** text 校验只分「缺失」与「超长」，具体错误文案由调用方按 action 拼装。 */
type TextCheck = { ok: true; text: string } | { ok: false; reason: "missing" | "too-long" };

function checkTodoText(value: unknown): TextCheck {
	if (typeof value !== "string") return { ok: false, reason: "missing" };
	const text = value.trim();
	if (!text) return { ok: false, reason: "missing" };
	if (text.length > MAX_TODO_TEXT_LENGTH) return { ok: false, reason: "too-long" };
	return { ok: true, text };
}

/**
 * status 可选但给了就必须是三态之一；未给时用 fallback 兜底（add/replace 默认
 * pending，update 保持原状态）。ok 分支必带 status，调用处不需要 as 强转。
 */
function checkedTodoStatus(
	value: unknown,
	label: string,
	fallback: TodoStatus,
): { ok: true; status: TodoStatus } | { ok: false; error: string } {
	if (value === undefined) return { ok: true, status: fallback };
	if (isTodoStatus(value)) return { ok: true, status: value };
	return { ok: false, error: `${label} must be one of: ${TODO_STATUSES.join(", ")}` };
}

// ---------------------------------------------------------------------------
// 解码（只读，从不写回）
// ---------------------------------------------------------------------------

function decodeTodoItem(value: unknown): TodoItem | undefined {
	if (!isRecord(value)) return undefined;
	const id = positiveSafeInteger(value.id);
	const text = nonEmptyString(value.text);
	const status = isTodoStatus(value.status) ? value.status : undefined;
	return id !== undefined && text !== undefined && status !== undefined
		? { id, text, status }
		: undefined;
}

function decodeTodoPlan(value: unknown): TodoPlan | undefined {
	if (!isRecord(value)) return undefined;
	const id = positiveSafeInteger(value.id);
	if (id === undefined || !Array.isArray(value.todos) || value.todos.length === 0) return undefined;
	const todos: TodoItem[] = [];
	for (const raw of value.todos) {
		const item = decodeTodoItem(raw);
		// 全量合法才接受：坏项整体拒绝，而不是丢项后继续（旧数据不静默截断）。
		if (!item) return undefined;
		todos.push(item);
	}
	return { id, todos };
}

/**
 * 解码 v3 快照。只接受 version===3 且 activePlan/previousPlan（若存在）全量合法；
 * 其余一律返回 undefined（视为无计划）。计数器缺失时按已读内容保持单调递增。
 */
export function decodeTodoState(value: unknown): TodoState | undefined {
	if (!isRecord(value) || value.version !== 3) return undefined;
	const hasActive = isRecord(value.activePlan);
	const hasPrevious = isRecord(value.previousPlan);
	const activePlan = hasActive ? decodeTodoPlan(value.activePlan) : undefined;
	const previousPlan = hasPrevious ? decodeTodoPlan(value.previousPlan) : undefined;
	// 声明的计划必须合法，否则整份快照不信任。
	if ((hasActive && activePlan === undefined) || (hasPrevious && previousPlan === undefined)) {
		return undefined;
	}
	const largestPlanId = Math.max(activePlan?.id ?? 0, previousPlan?.id ?? 0);
	const highestTodoId = Math.max(
		0,
		...(activePlan?.todos ?? []).map((item) => item.id),
		...(previousPlan?.todos ?? []).map((item) => item.id),
	);
	return {
		version: 3,
		...(activePlan ? { activePlan } : {}),
		...(previousPlan ? { previousPlan } : {}),
		nextPlanId: Math.max(positiveSafeInteger(value.nextPlanId) ?? 1, largestPlanId + 1),
		nextTodoId: Math.max(positiveSafeInteger(value.nextTodoId) ?? 1, highestTodoId + 1),
	};
}

/** 无任何计划、计数从 1 开始的全新状态。 */
export function emptyTodoState(): TodoState {
	return { version: 3, nextPlanId: 1, nextTodoId: 1 };
}

function cloneTodoPlan(plan: TodoPlan): TodoPlan {
	return { id: plan.id, todos: plan.todos.map((item) => ({ ...item })) };
}

// ---------------------------------------------------------------------------
// 操作 reducer（纯函数，失败不改变输入）
// ---------------------------------------------------------------------------

export const VALID_TODO_ACTIONS = [
	"list",
	"add",
	"update",
	"delete",
	"replace",
	"restore",
	"clear",
] as const;

/** 一次状态操作的输入；字段保持 unknown，确保 reducer 自身守住持久化边界。 */
export interface TodoMutation {
	action: string;
	/** add 用正文 */
	text?: unknown;
	/** add / update 用状态 */
	status?: unknown;
	/** update / delete 用的目标 ID */
	id?: unknown;
	/** replace 用的完整新计划 */
	items?: unknown;
}

export interface TodoUpdateFields {
	status: boolean;
	text: boolean;
}

export type TodoReduceResult =
	| {
		ok: true;
		state: TodoState;
		/** 是否需要持久化新快照（list 与幂等 update 为 false）。 */
		changed: boolean;
		addedItem?: TodoItem;
		updatedItem?: TodoItem;
		updatedFields?: TodoUpdateFields;
		deletedItem?: TodoItem;
		activePlanId?: number;
		todoCount: number;
	}
	| { ok: false; error: string };

/** 未知 id 的错误必须可操作：附当前可用 id 列表；超过上限截断并提示 call list。 */
const MAX_ERROR_LISTED_IDS = 10;

function formatUnknownIdError(id: number, plan: TodoPlan | undefined): string {
	const ids = plan?.todos.map((item) => item.id) ?? [];
	if (ids.length === 0) return `#${id} not found; current ids: none`;
	if (ids.length <= MAX_ERROR_LISTED_IDS) {
		return `#${id} not found; current ids: ${ids.join(", ")}`;
	}
	const prefix = ids.slice(0, MAX_ERROR_LISTED_IDS).join(", ");
	const hidden = ids.length - MAX_ERROR_LISTED_IDS;
	return `#${id} not found; current ids: ${prefix}, … (${hidden} more; call list)`;
}

export function reduceTodoState(current: TodoState, mutation: TodoMutation): TodoReduceResult {
	switch (mutation.action) {
		case "list": {
			return {
				ok: true,
				state: current,
				changed: false,
				todoCount: current.activePlan?.todos.length ?? 0,
			};
		}

		case "add": {
			const textCheck = checkTodoText(mutation.text);
			if (!textCheck.ok) {
				return {
					ok: false,
					error: textCheck.reason === "missing"
						? "text required for add"
						: `todo text exceeds ${MAX_TODO_TEXT_LENGTH} character limit`,
				};
			}
			const statusCheck = checkedTodoStatus(mutation.status, "status", "pending");
			if (!statusCheck.ok) return statusCheck;
			const item: TodoItem = { id: current.nextTodoId, text: textCheck.text, status: statusCheck.status };
			const activePlan = current.activePlan;
			if (activePlan) {
				if (activePlan.todos.length >= MAX_TODO_COUNT) {
					return { ok: false, error: `todo plan is full (max ${MAX_TODO_COUNT} items)` };
				}
				return {
					ok: true,
					state: {
						version: 3,
						activePlan: { id: activePlan.id, todos: [...activePlan.todos, item] },
						...(current.previousPlan ? { previousPlan: cloneTodoPlan(current.previousPlan) } : {}),
						nextPlanId: current.nextPlanId,
						nextTodoId: current.nextTodoId + 1,
					},
					changed: true,
					addedItem: item,
					todoCount: activePlan.todos.length + 1,
				};
			}
			return {
				ok: true,
				state: {
					version: 3,
					activePlan: { id: current.nextPlanId, todos: [item] },
					...(current.previousPlan ? { previousPlan: cloneTodoPlan(current.previousPlan) } : {}),
					nextPlanId: current.nextPlanId + 1,
					nextTodoId: current.nextTodoId + 1,
				},
				changed: true,
				addedItem: item,
				todoCount: 1,
			};
		}

		case "update": {
			const id = mutation.id;
			if (id === undefined) return { ok: false, error: "id required for update" };
			if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
				return { ok: false, error: "id must be a positive safe integer" };
			}
			if (mutation.status === undefined && mutation.text === undefined) {
				return { ok: false, error: "update requires status or text" };
			}
			const activePlan = current.activePlan;
			if (!activePlan) return { ok: false, error: formatUnknownIdError(id, undefined) };
			const target = activePlan.todos.find((item) => item.id === id);
			if (!target) return { ok: false, error: formatUnknownIdError(id, activePlan) };

			let nextText = target.text;
			let nextStatus = target.status;
			let changedStatus = false;
			let changedText = false;
			if (mutation.status !== undefined) {
				const statusCheck = checkedTodoStatus(mutation.status, "status", target.status);
				if (!statusCheck.ok) return statusCheck;
				nextStatus = statusCheck.status;
				changedStatus = nextStatus !== target.status;
			}
			if (mutation.text !== undefined) {
				const textCheck = checkTodoText(mutation.text);
				if (!textCheck.ok) {
					return {
						ok: false,
						error: textCheck.reason === "missing"
							? "text required for update"
							: `todo text exceeds ${MAX_TODO_TEXT_LENGTH} character limit`,
					};
				}
				nextText = textCheck.text;
				changedText = nextText !== target.text;
			}

			const updatedItem: TodoItem = { id: target.id, text: nextText, status: nextStatus };
			if (!changedStatus && !changedText) {
				return {
					ok: true,
					state: current,
					changed: false,
					updatedItem,
					updatedFields: { status: false, text: false },
					todoCount: activePlan.todos.length,
				};
			}
			const todos = activePlan.todos.map((item) => (item.id === id ? updatedItem : { ...item }));
			return {
				ok: true,
				state: {
					version: 3,
					activePlan: { id: activePlan.id, todos },
					...(current.previousPlan ? { previousPlan: cloneTodoPlan(current.previousPlan) } : {}),
					nextPlanId: current.nextPlanId,
					nextTodoId: current.nextTodoId,
				},
				changed: true,
				updatedItem,
				updatedFields: { status: changedStatus, text: changedText },
				todoCount: todos.length,
			};
		}

		case "delete": {
			const id = mutation.id;
			if (id === undefined) return { ok: false, error: "id required for delete" };
			if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
				return { ok: false, error: "id must be a positive safe integer" };
			}
			const activePlan = current.activePlan;
			const target = activePlan?.todos.find((item) => item.id === id);
			if (!target || !activePlan) return { ok: false, error: formatUnknownIdError(id, activePlan) };
			const todos = activePlan.todos.filter((item) => item.id !== id);
			return {
				ok: true,
				state: {
					version: 3,
					...(todos.length > 0 ? { activePlan: { id: activePlan.id, todos } } : {}),
					...(current.previousPlan ? { previousPlan: cloneTodoPlan(current.previousPlan) } : {}),
					nextPlanId: current.nextPlanId,
					nextTodoId: current.nextTodoId,
				},
				changed: true,
				deletedItem: target,
				todoCount: todos.length,
			};
		}

		case "replace": {
			const items = mutation.items;
			if (!Array.isArray(items) || items.length === 0) {
				return { ok: false, error: "items required for replace" };
			}
			if (items.length > MAX_TODO_COUNT) {
				return { ok: false, error: `plan exceeds ${MAX_TODO_COUNT} items` };
			}
			const todos: TodoItem[] = [];
			let candidateId = current.nextTodoId;
			for (let index = 0; index < items.length; index += 1) {
				const item = items[index];
				if (!isRecord(item)) {
					return { ok: false, error: `items[${index}].text required for replace` };
				}
				// 旧字段显式出现必须报错，不能假成功或默默消费 done。
				if (Object.prototype.hasOwnProperty.call(item, "done")) {
					return { ok: false, error: `items[${index}].done is not supported; use status` };
				}
				const textCheck = checkTodoText(item.text);
				if (!textCheck.ok) {
					return {
						ok: false,
						error: textCheck.reason === "missing"
							? `items[${index}].text required for replace`
							: `items[${index}].text exceeds ${MAX_TODO_TEXT_LENGTH} character limit`,
					};
				}
				const statusCheck = checkedTodoStatus(item.status, `items[${index}].status`, "pending");
				if (!statusCheck.ok) return statusCheck;
				todos.push({ id: candidateId, text: textCheck.text, status: statusCheck.status });
				candidateId += 1;
			}
			const previousPlan = current.activePlan ? cloneTodoPlan(current.activePlan) : undefined;
			const planId = current.nextPlanId;
			return {
				ok: true,
				state: {
					version: 3,
					activePlan: { id: planId, todos },
					...(previousPlan ? { previousPlan } : {}),
					nextPlanId: current.nextPlanId + 1,
					nextTodoId: current.nextTodoId + todos.length,
				},
				changed: true,
				todoCount: todos.length,
			};
		}

		case "restore": {
			if (!current.previousPlan) {
				return { ok: false, error: "no replaced plan is available to restore" };
			}
			const outgoingPlan = current.activePlan ? cloneTodoPlan(current.activePlan) : undefined;
			const restoredPlan = cloneTodoPlan(current.previousPlan);
			return {
				ok: true,
				state: {
					version: 3,
					activePlan: restoredPlan,
					...(outgoingPlan ? { previousPlan: outgoingPlan } : {}),
					nextPlanId: current.nextPlanId,
					nextTodoId: current.nextTodoId,
				},
				changed: true,
				activePlanId: restoredPlan.id,
				todoCount: restoredPlan.todos.length,
			};
		}

		case "clear": {
			const changed = current.activePlan !== undefined || current.previousPlan !== undefined;
			if (!changed) {
				return { ok: true, state: current, changed: false, todoCount: 0 };
			}
			return {
				ok: true,
				state: { version: 3, nextPlanId: current.nextPlanId, nextTodoId: current.nextTodoId },
				changed: true,
				todoCount: 0,
			};
		}

		default:
			return {
				ok: false,
				error: `unknown action: ${mutation.action}; valid actions: ${VALID_TODO_ACTIONS.join(", ")}`,
			};
	}
}

// ---------------------------------------------------------------------------
// 输出格式化
// ---------------------------------------------------------------------------

export function formatTodoStatusMarker(status: TodoStatus): string {
	return status === "completed" ? "☑" : status === "in_progress" ? "◐" : "☐";
}

/** widget 行：`☑/◐/☐ #id text`（pi-deck-todo 私有行契约，首行必须是元数据行）。 */
export function formatTodoWidgetLine(item: TodoItem): string {
	return `${formatTodoStatusMarker(item.status)} #${item.id} ${item.text}`;
}

/** 模型可见行：`[status] #id: text` — 编号与状态显式给出，不依赖 details 猜 id。 */
export function formatTodoModelLine(item: TodoItem): string {
	return `[${item.status}] #${item.id}: ${item.text}`;
}

export function countTodoStatuses(todos: readonly TodoItem[]): {
	completed: number;
	inProgress: number;
	pending: number;
} {
	let completed = 0;
	let inProgress = 0;
	let pending = 0;
	for (const item of todos) {
		if (item.status === "completed") completed += 1;
		else if (item.status === "in_progress") inProgress += 1;
		else pending += 1;
	}
	return { completed, inProgress, pending };
}

/**
 * 模型可见的计划正文：首行统计 + 逐行 `[status] #id: text`。
 * 超过 MAX_MODEL_VISIBLE_ITEMS 时截断并明确提示，避免无限拼接上下文。
 */
export function formatTodoPlanModelText(plan: TodoPlan | undefined): string {
	if (!plan) return "No todos";
	const counts = countTodoStatuses(plan.todos);
	const header = `Todo plan #${plan.id}: ${counts.completed} completed, ${counts.inProgress} in progress, ${counts.pending} pending (${plan.todos.length} items)`;
	const visible = plan.todos.slice(0, MAX_MODEL_VISIBLE_ITEMS);
	const lines = visible.map((item) => formatTodoModelLine(item));
	if (plan.todos.length > visible.length) {
		lines.push(`… ${plan.todos.length - visible.length} more items (output truncated)`);
	}
	return `${header}\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// 会话条目类型与压缩后补注判定（前缀缓存零失效设计）
// ---------------------------------------------------------------------------

/** 扩展私有的 v3 状态快照条目（appendEntry，不发给模型）。 */
export const TODO_SNAPSHOT_ENTRY_TYPE = "pi-deck-todo";
/**
 * 压缩后补注的可见性标记：既是 appendEntry 私有条目类型，也是 before_agent_start
 * 返回的持久 custom_message 的 customType。后者会进入模型上下文（goal-mode 同款机制）。
 */
export const TODO_BRIEF_ENTRY_TYPE = "pi-deck-todo-brief";

/**
 * 判断是否需要在压缩后补注计划简报。
 *
 * 设计目标：正常对话期间对模型上下文**零注入**——计划的最新视图永远由最近一次
 * todo 变更的 toolResult 携带（append-only 历史，天然不打断前缀缓存）。唯一会
 * 冲掉计划可见性的是压缩（firstKeptEntryId 之前的历史被摘要替换）与分支摘要，
 * 而这两者本身就会使缓存全部失效——此刻补注一条持久简报是零缓存成本的。
 *
 * 判定规则：扫描当前分支条目，取最后一次压缩/分支摘要的下标与最后一次
 * 「计划可见性标记」（v3 快照条目或已补注的简报条目）的下标；仅当压缩比
 * 标记更新时才需要补注。补注自身会写入新标记，因此每轮 before_agent_start
 * 幂等（不会重复追加），且下次压缩后自愈。
 */
export function todoBriefNeededAfterCompaction(branch: readonly unknown[]): boolean {
	let lastInvalidating = -1;
	let lastVisible = -1;
	for (let index = 0; index < branch.length; index += 1) {
		const entry = branch[index];
		if (!isRecord(entry)) continue;
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			lastInvalidating = index;
			continue;
		}
		if (
			entry.type === "custom" &&
			(entry.customType === TODO_SNAPSHOT_ENTRY_TYPE || entry.customType === TODO_BRIEF_ENTRY_TYPE)
		) {
			lastVisible = index;
		}
	}
	return lastInvalidating >= 0 && lastInvalidating > lastVisible;
}