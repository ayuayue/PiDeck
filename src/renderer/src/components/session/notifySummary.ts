/**
 * notifySummary — 「扩展通知」类 custom 消息的纯解析与展示判定。
 *
 * 背景：pi 用 `sendCustomMessage(customType, content, { display })` 给界面发扩展消息，
 * 会话文件里落成 `custom_message` 条目。子代理插件在后台任务完成时正是用这条通道
 * 唤醒父会话（`triggerTurn`），所以这条消息既是「通知」，也是**回合边界**。
 * 旧实现整条丢弃（projector 只认 user/assistant/toolResult），导致唤醒不可见、
 * 两个回合被并进同一个 run，上一轮「最终回答」退化成「中间回答」被折叠。
 *
 * 本模块只做两件纯事：
 * 1. 白名单判定：只把面向用户的「通知」类 customType 渲染成卡片。像
 *    `pi-deck-plan-mode-context` 这类 display:false 的内部上下文注入（实测 22 条）
 *    继续不显示——否则时间线会多出一整类噪声卡片。
 * 2. 文案解析：把插件固定格式的首行解析成状态与子代理名，供折叠行展示；
 *    解析不出来就退化成「首行原文」，绝不隐藏信息。
 *
 * 纯函数，无 React 依赖；tests/sessionNotifySummary.test.mjs 覆盖。
 */

/**
 * 白名单：会被渲染成时间线卡片的 customType。
 *
 * subagent-notify / subagent-notification：pi-subagents 后台任务完成/失败/暂停/停止
 * （notify.ts 的 sendCompletion 使用 `subagent-notify`，历史版本用过另一种命名）。
 * subagent_control_notice / subagent_supervisor_request：子代理控制与请求父代理介入。
 */
export const NOTIFY_CUSTOM_TYPES: ReadonlySet<string> = new Set(["subagent-notify", "subagent-notification", "subagent_control_notice", "subagent_supervisor_request"]);

/** customType 是否为需要展示的通知类消息。 */
export function isNotifiableCustomType(customType: unknown): boolean {
	return typeof customType === "string" && NOTIFY_CUSTOM_TYPES.has(customType);
}

/** 通知语义状态；解析不出来时为 unknown（卡片退化成原文展示）。 */
export type NotifySummaryStatus = "completed" | "failed" | "paused" | "stopped" | "unknown";

export type NotifySummary = {
	status: NotifySummaryStatus;
	/** 首行中 `**名称**` 标记的子代理名（分组通知会有多个）。 */
	agents: string[];
	/** 首个非空行（原文，不截断）：折叠行解析失败时展示它，保证信息不丢。 */
	headline: string;
	/** 首行之后的正文（session/任务明细），仅展开时展示。 */
	body: string;
};

// 状态词表：顺序即优先级。中英双写——插件当前是英文模板
// （`Background task completed: **agent**`），但上下游都可能本地化，多认一种成本极低。
const STATUS_PATTERNS: ReadonlyArray<{ status: NotifySummaryStatus; pattern: RegExp }> = [
	{ status: "completed", pattern: /完成|completed?\b/i },
	{ status: "failed", pattern: /失败|failed?\b/i },
	{ status: "paused", pattern: /暂停|paused?\b/i },
	{ status: "stopped", pattern: /停止|中止|stopped?\b/i },
];

/**
 * 解析通知文案。
 *
 * 状态只从首行「冒号之前」的前缀段里找（`Background tasks completed (2): ...`），
 * 避免正文里的 completed/failed 把本次通知的状态带偏；前缀段没命中才回退整行搜索。
 */
export function parseNotifySummary(text: string): NotifySummary {
	const rawLines = (text ?? "").split("\n");
	const headlineIndex = rawLines.findIndex((line) => line.trim().length > 0);
	const headline = headlineIndex >= 0 ? rawLines[headlineIndex].trim() : "";
	const body =
		headlineIndex >= 0
			? rawLines
					.slice(headlineIndex + 1)
					.join("\n")
					.trim()
			: "";

	const colonIndex = headline.search(/[:：]/);
	const prefix = colonIndex > 0 ? headline.slice(0, colonIndex) : headline;
	let status: NotifySummaryStatus = "unknown";
	const matchIn = (scope: string) => {
		for (const candidate of STATUS_PATTERNS) {
			if (candidate.pattern.test(scope)) return candidate.status;
		}
		return "unknown" as const;
	};
	status = matchIn(prefix);
	if (status === "unknown") status = matchIn(headline);

	const agents = [...headline.matchAll(/\*\*(.+?)\*\*/g)].map((match) => match[1].trim()).filter((name) => name.length > 0);

	return { status, agents, headline, body };
}
