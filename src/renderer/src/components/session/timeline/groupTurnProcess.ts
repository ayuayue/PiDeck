/**
 * 把一轮的扁平展示序列（`buildTurnDisplay` 输出）切成「过程组 + 一级行」序列。
 *
 * 展示语义（与用户确认，对齐 DSH `standard` 模式）：
 * - 大折叠栏内，内容严格按原始时序交替：中间回复 → 过程组 → 中间回复 → 过程组 → …
 * - **过程组**把连续的过程条目（思考 / 工具调用）合并成一组，组头给类别摘要，组体默认收起；
 * - **中间回复**是组的一级兄弟节点（不折进组内），视觉沿用 `InterimAnswer`；
 * - **重试 / 错误诊断**与中间回复同级：它们自己是一级行，并**截断**前后两个组
 *   （对齐 DSH 把 model-retry / turn-error 当独立节点的规则）。
 *
 * 为什么重试/错误要截断组：它们代表「这一轮中途出了状况/换了次重试」，把它混进
 * 一个组里会让「读取文件 → 失败重试 → 再读取」看起来像同一段连续作业。
 * 护栏（`AppUtils.ts:148-171` 的历史教训）：必须是**严格原位的轻量单行**，
 * 不能重回「时间线独立大卡片 + 与工具顺序错乱」的旧形态。
 *
 * 纯函数、无 React 依赖（node 单测直接加载）。
 */
import type { ChatMessage } from "../../../../../shared/types";
import { getToolName } from "../../../../../shared/fileChanges";
import { activityCountsFromToolNames, type ActivityCount } from "./toolCategory";
import type { TurnDisplayItem, TurnProcessEntry } from "./types";

/**
 * 一级过程行只可能是「重试 / 错误诊断」两种（`isStandaloneEntry` 保证）。
 * 用类型把这条不变量表达出来：下游就不必为不可能的分支写兜底，也不会漏收窄。
 */
export type TurnStandaloneEntry = Extract<TurnProcessEntry, { kind: "retry-entry" | "error-entry" }>;

/** 大折叠栏内的一个节点：中间回复 / 一级过程行 / 过程组。 */
export type TurnProcessNode =
	| { kind: "interim"; id: string; message: ChatMessage }
	/** 一组连续的过程条目（思考 / 工具），组头显示 `counts` 摘要。 */
	| { kind: "group"; id: string; members: TurnProcessEntry[]; counts: ActivityCount[]; toolCount: number; hasThinking: boolean }
	/** 与中间回复同级的一级过程行（重试 / 错误诊断），同时作为组边界。 */
	| { kind: "entry"; id: string; entry: TurnStandaloneEntry };

/** 该条目里的工具名（思考条目没有工具名；重试/错误不是组员，误用时返回空数组）。 */
export function toolNamesOfEntry(entry: TurnProcessEntry): string[] {
	if (entry.kind !== "tool-entry") return [];
	const names: string[] = [];
	for (const message of entry.group.messages) {
		const name = getToolName(message);
		if (name) names.push(name);
	}
	return names;
}

/** 重试 / 错误诊断：一级行 + 组边界。类型谓词，让调用处的 `entry` 收窄成 `TurnStandaloneEntry`。 */
function isStandaloneEntry(entry: TurnProcessEntry): entry is TurnStandaloneEntry {
	return entry.kind === "retry-entry" || entry.kind === "error-entry";
}

function flushGroup(members: TurnProcessEntry[], nodes: TurnProcessNode[]): void {
	if (members.length === 0) return;
	const toolNames: string[] = [];
	let hasThinking = false;
	for (const member of members) {
		if (member.kind === "thinking-entry") hasThinking = true;
		else toolNames.push(...toolNamesOfEntry(member));
	}
	nodes.push({
		kind: "group",
		// 组 id 用首成员 id：只要该组内容不变，流式增量重算时 id 稳定
		// （组开合状态、React key、滚动锚点都挂在它上面，必须稳定）。
		id: `grp:${members[0].id}`,
		members,
		counts: activityCountsFromToolNames(toolNames),
		toolCount: toolNames.length,
		hasThinking,
	});
}

/**
 * 分组主入口。
 *
 * 边界规则：
 * - `final-answer` 不参与分组（由 `FinalAnswer` 在大折叠栏外常驻渲染）；
 * - 有文本的中间回复 → 先 flush 当前组，再产出一条一级 `interim`；
 * - **空文本中间回复不作边界也不产出**（live 骨架挂载点 / 空 error 占位，产出一行会凭空多出空组头，
 *   `segmentSummary.ts:31-36` 已有同类防呆）；
 * - 重试 / 错误 → 先 flush，再产出一条一级 `entry`；
 * - 其余过程条目（思考 / 工具）→ 并入当前组；工具类别变化**不拆组**。
 */
export function groupTurnProcess(items: readonly TurnDisplayItem[]): TurnProcessNode[] {
	const nodes: TurnProcessNode[] = [];
	let current: TurnProcessEntry[] = [];

	for (const item of items) {
		if (item.kind === "final-answer") continue;
		if (item.kind === "interim-answer") {
			// 空文本：live 骨架 / 占位，不作边界也不产出
			if (!item.message.text.trim()) continue;
			flushGroup(current, nodes);
			current = [];
			nodes.push({ kind: "interim", id: item.id, message: item.message });
			continue;
		}
		const entry = item.entry;
		if (isStandaloneEntry(entry)) {
			flushGroup(current, nodes);
			current = [];
			nodes.push({ kind: "entry", id: entry.id, entry });
			continue;
		}
		current.push(entry);
	}

	flushGroup(current, nodes);
	return nodes;
}

/** 该轮最后一个过程组（组头在流式中显示实时活动）。 */
export function lastProcessGroup(nodes: readonly TurnProcessNode[]): Extract<TurnProcessNode, { kind: "group" }> | undefined {
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		const node = nodes[index];
		if (node?.kind === "group") return node;
	}
	return undefined;
}

/** 该轮最后一个过程组在 nodes 里的下标（-1 表示没有组）。 */
export function lastProcessGroupIndex(nodes: readonly TurnProcessNode[]): number {
	for (let index = nodes.length - 1; index >= 0; index -= 1) {
		if (nodes[index]?.kind === "group") return index;
	}
	return -1;
}
