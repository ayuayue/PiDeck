/**
 * 用户检查点目录（右侧导轨）的共享契约。
 *
 * 为什么单独一个类型文件：主进程从会话索引派生、preload 转发、渲染层合并展示，
 * 三层必须同一份结构；`messageIndex` 是 activeMessageEntries 坐标（分页续接的唯一锚点），
 * 不是 JSONL 行号也不是过滤后的序号。
 */
export type SessionOutlineEntry = {
	entryId: string;
	messageIndex: number;
	/** 第几个用户发言权（从 0 起）；连发 user 各自计数，用于估算距离。 */
	turnOrdinal: number;
	timestamp?: string;
	/**
	 * 用户消息首段文本（建索引时带走的预览，≤120 码点）。
	 * 导轨用它在消息未加载时也显示真实提问，不再靠序号占位。
	 */
	preview?: string;
};

export type SessionOutlineSnapshot = {
	entries: SessionOutlineEntry[];
	/** 活动链上的用户检查点总数（可能大于返回条数）。 */
	total: number;
	/** 是否因预算裁剪（保留首项与最近检查点）。 */
	truncated: boolean;
};
