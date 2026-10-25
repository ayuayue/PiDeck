/**
 * 回复快捷操作（最新回复尾部的建议条）跨进程契约。
 *
 * 与快捷消息同构：数据源是用户配置文件 `userData/reply-actions.json`，
 * 主进程 ReplyActionRuleStore 读写；渲染层只拿快照、只提交规则数组。
 *
 * 规则是**声明式**的：渲染层把「最新一轮回复」的信号（失败 / stopReason / 助手结尾文本）
 * 与规则里的 trigger 条件求值，命中即展示该条 suggestion。内置的提交/推送意图推断
 * 不再写死在组件里，出厂规则资源 resources/reply-actions.default.json 与用户文件同一套结构。
 */
export type ReplyActionTriggerKind = "onFailure" | "onStop" | "always" | "textMatch";

/**
 * 单条规则的触发条件（可组合；全部满足才展示）。
 * - onFailure：最新一轮以失败收场（请求级错误 / stopReason 表明中断）。
 * - onStop：最新一轮正常收场（有助手结语文本且未失败）。
 * - always：新一轮收场后就总是显示（成功、失败、被中止都算；运行中仍不显示）。
 * - textMatch：助手结尾文本命中任意正则（大小写不敏感；正则解析失败按「永不命中」处理）。
 *
 * 设置页把前三个 kind 收敛成「何时显示」下拉（三选一 + 命中关键词）；文件里保留可组合结构，
 * 手写多 trigger 的规则依旧要求全部命中，语义不回退。
 */
export type ReplyActionTrigger = {
	kind: ReplyActionTriggerKind;
	/** 仅 textMatch 使用：命中任一即算命中 */
	patterns?: string[];
};

export type ReplyActionRule = {
	/** 展示在按钮上的文案（发送给 pi 的就是这段文本，与快捷消息同语义） */
	text: string;
	/** 触发条件（可多条，全部满足才展示） */
	triggers: ReplyActionTrigger[];
};

export type ReplyActionsSnapshot = {
	/** 当前生效的规则（顺序即展示顺序）；空数组 = 用户清空 */
	items: ReplyActionRule[];
	/** 出厂规则（随包资源 reply-actions.default.json），设置页「恢复默认」用 */
	defaults: ReplyActionRule[];
	/** 用户配置文件绝对路径 */
	filePath: string;
	/** 本次读取是否刚生成/重置过配置文件（同 QuickMessagesSnapshot.seeded） */
	seeded: boolean;
	/** 出厂资源是否可读 */
	defaultsAvailable: boolean;
};

export type ReplyActionsSaveResult = { ok: true; snapshot: ReplyActionsSnapshot } | { ok: false; error: string };
