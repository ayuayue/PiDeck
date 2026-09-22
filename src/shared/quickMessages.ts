/**
 * 快捷消息（composer 底栏「快捷消息」弹框里一键插入 / 直发的一句话指令）。
 *
 * 数据流（2026-09 起改为「配置文件为准」）：
 * - 唯一数据源是用户配置文件 `userData/quick-messages.json`（主进程 QuickMessageStore 读写，用户可直接编辑）；
 * - 内置清单放在随包资源 `resources/quick-messages.default.json`，**不再硬编码在代码里**——
 *   改出厂条目只需改 JSON，不必动 TS；文件缺失时首次读取会用它种子化用户配置文件；
 * - 本模块只放两端共用的「上限 / 文件名 / 清洗」，settings.json 里的同名旧字段已废弃，
 *   仅作为首次迁移的种子（见 QuickMessageStore）。
 *
 * 为什么清洗放 shared：主进程读写文件、渲染层增删条目都走同一份规则，
 * 两处各写一份必然会漂移成「界面允许但落盘被截掉」。
 */

/** 上界：弹框一屏放得下十几条，再多就该用提示词模板；同时挡住配置文件被塞爆。 */
export const MAX_QUICK_MESSAGES = 30;

/**
 * 单条长度上限：快捷消息是「一句话」。
 * 超长内容（整段任务描述）应写成提示词模板，否则弹框里每条都要折行、点击区域也失去辨识度。
 */
export const MAX_QUICK_MESSAGE_LENGTH = 200;

/** 用户配置文件（userData 下）与出厂资源文件的文件名，主进程与文档共用同一常量避免写错。 */
export const QUICK_MESSAGES_FILE_NAME = "quick-messages.json";
export const QUICK_MESSAGES_DEFAULT_RESOURCE_NAME = "quick-messages.default.json";

/** 配置文件结构版本；将来结构变更时用它做迁移判据（当前只为可读性写入）。 */
export const QUICK_MESSAGES_FILE_VERSION = 1;

/** 配置文件结构：`{ version, items }`；items 顺序即弹框展示顺序。 */
export type QuickMessagesFile = {
	version: number;
	items: string[];
};

/**
 * 清洗条目：主进程加载 / 保存、渲染层增删都走这里，保证各入口结果一致。
 *
 * 规则与理由：
 * - 非数组或字段缺失 → 空数组（**不再回退出厂清单**：出厂清单在资源文件里，
 *   由 QuickMessageStore 决定要不要种子化；显式空数组就是「用户清空了」）；
 * - 空白条目直接丢弃（误触回车留下的空行，留着重启后就是一个点不出效果的按钮）；
 * - 超长按上限截断而非丢弃（用户写了长句说明他确实想用，只是超了界面能接受的量级）；
 * - 去重（大小写无关）：弹框里两条一模一样的条目只会让人点错；
 * - 超出上限的部分丢弃：上限是防御性的，正常维护到不了。
 */
export function normalizeQuickMessages(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const text = item.trim();
		if (!text) continue;
		const clipped = text.slice(0, MAX_QUICK_MESSAGE_LENGTH);
		const dedupeKey = clipped.toLowerCase();
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		result.push(clipped);
		if (result.length >= MAX_QUICK_MESSAGES) break;
	}
	return result;
}

/**
 * 解析配置文件内容。
 *
 * 返回 null 表示「这不是一份可识别的快捷消息配置」——调用方据此走种子化流程；
 * 返回 `{ items: [] }` 是合法结果，代表用户主动清空（不能与「文件损坏」混为一谈，否则清空后重启会复活出厂清单）。
 * 同时接受裸数组写法（`["继续","提交"]`）：用户手写配置时最自然的形式，没必要逼他包一层对象。
 */
export function sanitizeQuickMessagesFile(raw: unknown): QuickMessagesFile | null {
	if (Array.isArray(raw)) return { version: QUICK_MESSAGES_FILE_VERSION, items: normalizeQuickMessages(raw) };
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	if (!("items" in record)) return null;
	// items 不是数组 = 文件被改坏了，**不是**「清空」：交给调用方备份 + 重建，
	// 否则手写的 `"items": "继续"` 会被静默当成空清单，用户内容消失且连 .bak 都没有。
	if (!Array.isArray(record.items)) return null;
	const version = typeof record.version === "number" && Number.isFinite(record.version) ? record.version : QUICK_MESSAGES_FILE_VERSION;
	return { version, items: normalizeQuickMessages(record.items) };
}
