/**
 * PiDeck Todo Extension
 *
 * This extension owns a branch-scoped, durable current work plan. A plan changes
 * only through an explicit tool action: `replace` starts a new plan, `restore`
 * swaps back the immediately superseded plan, and `clear` intentionally removes
 * it. Completion, idle time, normal user messages, and session startup never
 * infer a plan boundary.
 *
 * Actions: list | add | update | delete | replace | restore | clear. The legacy flip
 * action and the `done` boolean field are gone; explicit old calls are rejected
 * by throwing, never silently accepted. Validation failures throw from execute
 * without writing a snapshot or changing state.
 *
 * State is persisted as v3 custom entries (TodoState from
 * `./pi-deck-todo-state.ts`) and rebuilt on both `session_start` and
 * `session_tree`, so switching a session branch restores that branch's plan.
 * Reading only ever accepts full v3 snapshots: legacy `{todos,nextId}` and v2
 * `done` snapshots are treated as no plan and are never re-persisted.
 *
 * The widget stays line-based for the existing pi RPC transport; its first
 * machine-readable line carries the active plan identity and is ignored only by
 * PiDeck's own todo-widget parser. It therefore participates in the renderer's
 * dismiss fingerprint even if two plans have identical visible task text.
 *
 * `context` 不再注入任何每轮提醒。历史上提醒曾以「删旧追新」浮动尾注入（冻结
 * 中转站缓存于 36,480 / 19,200），后改为固定早位，但计划每次变更仍会使槽位之后
 * 的前缀失效一次（实测跌落到 17,024 = developer 块边界）。当前为**零失效**设计：
 *
 * - 模型对计划的最新视图由**最近一次变更的 toolResult** 携带（execute 在真实
 *   变更后附加计划全文）。toolResult 是 append-only 历史的一部分，天然不打断
 *   提示前缀缓存（与 pi 官方示例 todo.ts 的「状态活在工具结果里」同一模式）。
 * - 唯一会冲掉计划可见性的是压缩/分支摘要（firstKeptEntryId 之前的历史被摘要
 *   替换），而它们本身已使缓存全部失效。`before_agent_start` 用
 *   `todoBriefNeededAfterCompaction` 检测「压缩比最后一次计划可见点更新」，
 *   此时才持久追加一条计划简报（`{message}` 返回值 = 写入会话历史，goal-mode
 *   同款机制），对缓存零额外成本，且补注幂等、下次压缩后自愈。
 *
 * 私有快照/标记条目（appendEntry）不发给模型，只用于状态重建与补注判定。
 *
 * This is intentionally independent from `pi-deck-plan-mode.ts`: plan mode has
 * a separate lifecycle and continues to publish the `pi-deck-plan-todos` widget.
 *
 * @packageDocumentation
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	countTodoStatuses,
	decodeTodoState,
	emptyTodoState,
	formatTodoPlanModelText,
	formatTodoWidgetLine,
	reduceTodoState,
	TODO_BRIEF_ENTRY_TYPE,
	TODO_SNAPSHOT_ENTRY_TYPE,
	TODO_STATUSES,
	todoBriefNeededAfterCompaction,
	VALID_TODO_ACTIONS,
	type TodoPlan,
	type TodoState,
	type TodoUpdateFields,
} from "./pi-deck-todo-state";

// Widget key stays stable so existing clients keep working; entry types come from
// the pure state module so the visibility scan and the writer cannot drift apart.
const WIDGET_KEY = "pi-deck-todo";
const ENTRY_TYPE = TODO_SNAPSHOT_ENTRY_TYPE;
const OWN_EXTENSION_FILE = "pi-deck-todo.ts";
// 旧版「每轮临时提醒」的类型。已停止生产；context 保留防御性剥离，防止降级/
// 历史进程混入的同类消息进入出站请求。
const TODO_CONTEXT_ENTRY_TYPE = "pi-deck-todo-context";
// This is a private PiDeck widget-line contract, not user-facing text. Keep it first in the array.
const PLAN_METADATA_PREFIX = "[[pid:todo-plan:";
const PLAN_METADATA_SUFFIX = "]]";

const TodoParams = Type.Object(
	{
		action: StringEnum(VALID_TODO_ACTIONS),
		text: Type.Optional(Type.String({ description: "Todo text (for add / update)" })),
		status: Type.Optional(StringEnum(TODO_STATUSES)),
		id: Type.Optional(Type.Number({ description: "Todo ID (for update / delete)" })),
		items: Type.Optional(
			Type.Array(
				Type.Object({
					text: Type.String({ description: "Todo text in a replacement plan" }),
					status: Type.Optional(StringEnum(TODO_STATUSES)),
				}),
				{ description: "Complete replacement plan (required for replace)" },
			),
		),
	},
	{ additionalProperties: false },
);

type SuccessResult = Extract<ReturnType<typeof reduceTodoState>, { ok: true }>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTodoPlanContextMessage(message: unknown): boolean {
	return isRecord(message) && message.customType === TODO_CONTEXT_ENTRY_TYPE;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export default function piDeckTodoExtension(pi: ExtensionAPI): void {
	// 内存单一真源：只读恢复（decode）与每次成功变更（reducer）都在这里。
	let state: TodoState = emptyTodoState();
	// A third-party `todo` tool owns the name once it replaces ours. Stop publishing widget/reminders.
	let yielded = false;

	function resetState(): void {
		state = emptyTodoState();
	}

	function ownExtensionPath(): string {
		// pi 用 jiti 以 CommonJS 包装加载扩展：__filename 指向扩展自身文件。
		if (typeof __filename === "string" && __filename.length > 0) return __filename;
		return "";
	}

	function normalizeExtensionPath(value: string): string {
		return value.replace(/\\/g, "/").toLowerCase();
	}

	function basenameOf(normalized: string): string {
		const slash = normalized.lastIndexOf("/");
		return slash >= 0 ? normalized.slice(slash + 1) : normalized;
	}

	/**
	 * 工具归属精确比较：与自身路径规范化后相等，或 basename 恰好等于自身（缺失
	 * 自身路径时对比约定部署文件名）。不做任何子串匹配——近似命名第三方不被误认。
	 */
	function isOwnTodo(): boolean {
		const tool = pi.getAllTools().find((candidate) => candidate.name === "todo");
		const sourceInfo = isRecord(tool?.sourceInfo) ? tool.sourceInfo : undefined;
		const path = typeof sourceInfo?.path === "string" ? sourceInfo.path : "";
		if (!path) return false;
		const candidate = normalizeExtensionPath(path);
		const own = normalizeExtensionPath(ownExtensionPath());
		return own !== ""
			? candidate === own
			: basenameOf(candidate) === OWN_EXTENSION_FILE;
	}

	function clonePlan(plan: TodoPlan): TodoPlan {
		return { id: plan.id, todos: plan.todos.map((item) => ({ ...item })) };
	}

	function persistState(): void {
		pi.appendEntry(ENTRY_TYPE, {
			version: 3,
			...(state.activePlan ? { activePlan: clonePlan(state.activePlan) } : {}),
			...(state.previousPlan ? { previousPlan: clonePlan(state.previousPlan) } : {}),
			nextPlanId: state.nextPlanId,
			nextTodoId: state.nextTodoId,
		});
	}

	function planMetadataLine(scopeId: string | undefined, planId: number): string {
		const identity = scopeId ? `${encodeURIComponent(scopeId)}:${planId}` : String(planId);
		return `${PLAN_METADATA_PREFIX}${identity}${PLAN_METADATA_SUFFIX}`;
	}

	/** Extensions always publish complete item rows. Disclosure is renderer-owned. */
	function updateWidget(ctx: ExtensionContext): void {
		const activePlan = state.activePlan;
		if (!activePlan) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, [
			planMetadataLine(nonEmptyString(ctx.sessionManager.getLeafId()), activePlan.id),
			...activePlan.todos.map((item) => formatTodoWidgetLine(item)),
		]);
	}

	/** Restore only the latest custom snapshot in the selected session branch. */
	function reconstructState(ctx: ExtensionContext): void {
		let lastData: unknown;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!isRecord(entry)) continue;
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) lastData = entry.data;
		}
		// 只读 v3：旧格式/非法快照解码为 undefined → 无计划，不迁移、不写回。
		const decoded = decodeTodoState(lastData);
		state = decoded ?? emptyTodoState();
	}

	function restoreForCurrentBranch(ctx: ExtensionContext): void {
		if (!isOwnTodo()) {
			yielded = true;
			resetState();
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		yielded = false;
		reconstructState(ctx);
		updateWidget(ctx);
	}

	/** 压缩后补注的简报正文（与旧提醒同款指引；不再每轮注入）。 */
	function planBriefContent(plan: TodoPlan): string {
		return [
			`[CURRENT TODO PLAN #${plan.id}]`,
			"This is the current plan, not a history-based task boundary. Continue it with add/update while it still applies. Remove one obsolete item with action=delete and its id. For a new or materially re-scoped request, call action=replace with the complete new plan even if old items are unfinished. Do not clear because items are complete or because a new user message arrived. Use action=restore after an accidental replacement. If an id is uncertain, call action=list first.",
			"",
			formatTodoPlanModelText(plan),
		].join("\n");
	}

	function todoCountSuffix(count: number): string {
		return count === 1 ? " (1 todo in plan)" : ` (${count} todos in plan)`;
	}

	function todoResultText(action: string, result: SuccessResult): string {
		switch (action) {
			case "list":
				return formatTodoPlanModelText(state.activePlan);
			case "add":
				return `Added todo #${result.addedItem?.id}: ${result.addedItem?.text}${todoCountSuffix(result.todoCount)}`;
			case "update": {
				const item = result.updatedItem;
				const fields: TodoUpdateFields | undefined = result.updatedFields;
				if (fields && !fields.status && !fields.text) {
					return `Todo #${item?.id} already ${item?.status}${todoCountSuffix(result.todoCount)}`;
				}
				const changes: string[] = [];
				if (fields?.status) changes.push(`→ ${item?.status}`);
				if (fields?.text) changes.push(`text: ${item?.text}`);
				return `Updated todo #${item?.id} ${changes.join(", ")}${todoCountSuffix(result.todoCount)}`;
			}
			case "replace":
				return `Replaced the current plan with ${result.todoCount} todos`;
			case "delete":
				return `Deleted todo #${result.deletedItem?.id}: ${result.deletedItem?.text}${todoCountSuffix(result.todoCount)}`;
			case "restore":
				return `Restored todo plan #${result.activePlanId}${todoCountSuffix(result.todoCount)}`;
			default:
				return "Cleared the current todo plan";
		}
	}

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage the current todo plan. Actions: list, add, update (id + status/text), delete (id, removing a single item), replace (atomically begin a new plan), restore (undo the latest replacement), and clear (intentionally remove it).",
		promptSnippet: "List or change the current todo plan (list / add / update / delete / replace / restore / clear)",
		promptGuidelines: [
			"Maintain the actionable plan with the todo tool. After finishing an item, call action=update with its id and status=completed. Remove one obsolete item with action=delete and its id. Use action=replace only to rebuild the whole plan. If an id is uncertain, call action=list first.",
			"Start a new or materially re-scoped task with one action=replace call containing the complete new plan. Never infer that boundary from completed items, idle time, a user message, or session start.",
			"If a replacement was mistaken, call action=restore immediately. Use action=clear only when intentionally discarding the active plan.",
			"Todo state is per-branch: switching branches restores that branch's plan.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mutation = {
				action: params.action,
				text: params.text,
				status: params.status,
				id: params.id,
				items: params.items,
			};
			const result = reduceTodoState(state, mutation);
			if (!result.ok) {
				// 校验失败抛错：不写快照、不改状态；由 pi 转 isError。
				throw new Error(result.error);
			}
			if (result.changed) {
				state = result.state;
				persistState();
			}
			updateWidget(ctx);
			// 模型可见的计划视图由最近一次变更的 toolResult 携带（append-only，
			// 前缀缓存零影响）：每次真实变更后附加计划全文，替代旧版每轮注入提醒。
			let text = todoResultText(params.action, result);
			if (result.changed && state.activePlan) {
				text += `\n\n${formatTodoPlanModelText(state.activePlan)}`;
			}
			return {
				content: [{ type: "text" as const, text }],
			};
		},
	});

	pi.registerCommand("todo", {
		description: "查看、清空或恢复当前分支待办计划",
		handler: async (args, ctx) => {
			if (!isOwnTodo()) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.notify("Todo 工具由其他扩展提供，请使用其对应命令（如 /todos）查看。", "info");
				return;
			}
			const command = String(args ?? "").trim().toLowerCase();
			if (command === "clear") {
				const result = reduceTodoState(state, { action: "clear" });
				if (!result.ok || !result.changed) {
					ctx.ui.notify("当前没有待办计划可清空。", "info");
					return;
				}
				state = result.state;
				persistState();
				updateWidget(ctx);
				ctx.ui.notify("已清空当前待办计划。", "info");
				return;
			}
			if (command === "restore") {
				const result = reduceTodoState(state, { action: "restore" });
				if (!result.ok) {
					ctx.ui.notify("没有可恢复的被替换计划。", "info");
					return;
				}
				state = result.state;
				persistState();
				updateWidget(ctx);
				ctx.ui.notify(`已恢复待办计划 #${state.activePlan?.id}。`, "info");
				return;
			}
			if (command === "collapse" || command === "expand") {
				ctx.ui.notify("待办计划可在 PiDeck 输入框上方展开或折叠。", "info");
				return;
			}
			if (!state.activePlan) {
				ctx.ui.notify("还没有待办计划，可以告诉 AI 添加或替换计划。", "info");
				return;
			}
			const todos = state.activePlan.todos;
			const counts = countTodoStatuses(todos);
			ctx.ui.notify(
				`Todos ${counts.completed}/${todos.length}\n${todos.map((item) => formatTodoWidgetLine(item)).join("\n")}`,
				"info",
			);
		},
	});

	pi.on("context", async (event, ctx) => {
		// 本扩展不再通过 context 注入任何内容（零失效设计，见文件头）。保留两件事：
		// 1) 防御性剥离旧版「每轮临时提醒」类型的消息（已停止生产，防降级混入）；
		// 2) 第三方扩展接管 `todo` 工具时的让位状态维护。
		const messages = event.messages.filter((message) => !isTodoPlanContextMessage(message));
		const removedLegacy = messages.length !== event.messages.length;

		if (!isOwnTodo()) {
			if (!yielded) {
				yielded = true;
				resetState();
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			}
			return removedLegacy ? { messages } : undefined;
		}

		if (yielded) {
			yielded = false;
			reconstructState(ctx);
			updateWidget(ctx);
		}
		return removedLegacy ? { messages } : undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		// 压缩/分支摘要会冲掉历史里的计划视图（toolResult 被摘要替换），而该事件
		// 本身已使提示缓存全部失效——此刻持久追加一条简报是零缓存成本的。
		// 返回值 {message} 会写入会话历史（goal-mode 同款持久机制），配合
		// appendEntry 的可见性标记，保证每轮判定幂等、不会重复追加。
		if (!isOwnTodo()) return;
		if (!state.activePlan) return;
		if (!todoBriefNeededAfterCompaction(ctx.sessionManager.getBranch())) return;
		pi.appendEntry(TODO_BRIEF_ENTRY_TYPE, { reason: "post-compaction" });
		return {
			message: {
				customType: TODO_BRIEF_ENTRY_TYPE,
				content: planBriefContent(state.activePlan),
				display: false,
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreForCurrentBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreForCurrentBranch(ctx);
	});
}