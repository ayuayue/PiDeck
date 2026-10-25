/**
 * 会话 JSONL 里的非对话过程事件。
 * 时间线只投影 user/assistant/tool；轨迹复盘单独读这些条目，不改聊天渲染。
 */
export type SessionProcessEventKind = "session" | "sessionInfo" | "modelChange" | "thinkingChange" | "compaction" | "custom" | "import" | "retry" | "usage" | "systemPrompt";

/**
 * 轨迹账本的系统提示词快照（两后端同形）：
 * - pi：会话文件里 `message.role === "system"` 的条目是可累积的表面
 *   （content + sections 补丁 + toolsAdded/toolsRemoved），按文件顺序重放即装载变化；
 *   压缩条目的 `systemMessage` 是压缩边界的全量快照。
 * - dsh：`system/message`（V4 表面）与 `request/header`（旧版请求头）携带
 *   harness 在请求时组装好的真实提示词；`request/header` 另有工具目录。
 * 只保留「装载真的变了」的快照，避免每次请求都刷一条空记录。
 */
export type SessionPromptSnapshot = {
	/** initial = 会话首个提示词；update = 后续追加/补丁/替换；snapshot = 压缩边界全量快照。 */
	kind: "initial" | "update" | "snapshot";
	/** 提示词全文（content + 各 section 按声明顺序拼接）；空串 = 上游显式清空。 */
	text: string;
	/** 当前生效的工具名（升序，给账本「工具 ×N」与检查器清单用）。 */
	tools: string[];
	/** 相对上一份快照的变化；首份快照不带 diff 字段。 */
	toolsAdded?: string[];
	toolsRemoved?: string[];
	sectionsAdded?: string[];
	sectionsUpdated?: string[];
	sectionsRemoved?: string[];
	/** text 是否被长度上限截断（账本只保证可读，不保证全文回传）。 */
	truncated?: boolean;
};

export type SessionProcessEvent = {
	id: string;
	kind: SessionProcessEventKind;
	timestamp: number;
	summary: string;
	detail?: string;
	cwd?: string;
	parentSession?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	customType?: string;
	tokensBefore?: number;
	/** 事件序号（DSH SessionEvent.seq）；账本按 seq 而不是墙钟排，对齐 dsh-web layout.ts。 */
	seq?: number;
	/** llm/retry：第几次重试（1-based）。 */
	retry?: number;
	maxRetries?: number;
	retryDelayMs?: number;
	/** kind=systemPrompt：提示词快照（含相对上一份的变更）。 */
	prompt?: SessionPromptSnapshot;
	/** kind=usage：pi `usage` 条目的分类（如 cache_warm）。 */
	usageKind?: string;
};

/**
 * 事实读取的覆盖范围（账本据此区分「真的没有」与「没读到」）。
 *
 * 为什么四个维度分开：来源没覆盖开头（DSH 尾页、fork 祖先缺失）与预算读不完
 * （提示词链太长）是完全不同的缺失，渲染层要给不同提示，不能都画成「无提示词」。
 */
export type SessionFactsCoverage = {
	/** 来源是否覆盖会话开头（DSH host 页从会话开头才有初始提示词）。 */
	fromStart: boolean;
	/** 活动链是否完整（pi fork 祖先缺失/未授权时前缀不可见）。 */
	chainComplete: boolean;
	/** 预算内是否读完候选（512 候选 / 8MiB 正文 / 单行 1MiB）。 */
	readComplete: boolean;
	/** 返回事件是否被保留上限裁剪（提示词快照是固定项，不会被裁）。 */
	eventsTrimmed: boolean;
	/** 结构化缺失原因：用于渲染层文案与日志排查。 */
	reason?: "history-window" | "ancestor-missing" | "budget" | "unsupported" | "unavailable";
};

/** `sessions:catalog-read-process-events` 的返回：事件 + 内容版本 + 覆盖范围。 */
export type SessionFactsResult = {
	events: SessionProcessEvent[];
	/**
	 * 规范化事实内容版本：相同内容 → 相同字符串 → 渲染层保持引用不重建。
	 * 与源文件版本无关（普通消息追加但事实未变时它不变）。
	 */
	version: string;
	coverage: SessionFactsCoverage;
};
