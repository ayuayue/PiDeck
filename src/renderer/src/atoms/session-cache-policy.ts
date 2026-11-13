/**
 * 会话消息缓存的裁剪策略（纯函数 + 常量，无 jotai 依赖）。
 *
 * 从 `session-atoms.ts` 原样搬家而来（拆分，行为零变化）：LRU 保留集、单条消息
 * 驻留字节估算、已关闭 Tab 的字节预算淘汰、非写入时机的裁剪计划。
 * 入口 `session-atoms.ts` 用 `export *` 转出，所有既有 import 不变。
 */
import type { ChatMessage } from "../../../shared/types";

/**
 * 渲染层会话消息缓存上限（LRU）。
 * 6 → 8（2026-12 会话切换闪屏修复）：4 个分屏常驻 + 3 个预览 + 1 个切换缓冲；
 * 切回被淘汰的会话要重新走磁盘读取，大会话（几十 MB）会先闪骨架屏/起始页，
 * 放宽到 8 在内存可接受范围内减少淘汰频次；
 * 淘汰的会话切回时走激活分页（尾部 9 轮）重新拉取，成本可控。
 */
export const SESSION_MESSAGE_CACHE_LIMIT = 8;

/**
 * 会话消息缓存 LRU 裁剪策略：打开着的会话 Tab（预览/常驻）永不裁剪，
 * 其余按最近写入顺序补足剩余名额（未打开部分受 limit 约束）。
 *
 * 为什么：渲染层把「缓存条目存在」视为「内容已加载」（见 deriveSessionSurfaceRuntime
 * 的 ready && !hasCachedEntry 判据）。打开中的会话若因其它会话写入被挤出 8 槽，
 * 切回瞬间会重读盘并闪「正在加载历史」骨架——生图会话等没有 runtime 事件持续
 * touch 的会话最容易被挤出，且重读期间只要再被挤出就会形成「挤掉→重读→再挤掉」
 * 循环闪（重启后多个 Tab 恢复、大会话读盘慢时最明显）。Tab 关闭后不再受保护
 * （用户已不引用），按 limit 正常回收。
 */
export function selectRetainedCacheEntryIds(lru: readonly string[], openedTabIds: ReadonlySet<string>, limit: number): string[] {
	// 打开着的 Tab 全部保留（即使数量超过 limit：已打开的会话是用户在看的，
	// 宁可在内存上稍微超额，也绝不挤掉正在显示的会话）；
	// 未打开的按最近写入顺序占剩余名额（不足时一个不留）。
	const open = lru.filter((id) => openedTabIds.has(id));
	const closed = lru.filter((id) => !openedTabIds.has(id));
	const closedBudget = Math.max(0, limit - open.length);
	return [...open, ...closed.slice(0, closedBudget)];
}
/**
 * 已关闭 Tab 条目的合计字节预算（2026-10 内存轮）。
 * 条目数有 LRU 上限、单条目消息数有 DISK_HISTORY_MESSAGE_LIMIT 封顶，但消息的
 * **内容体积**没有界：大代码块/长思考/内联 base64 的会话单条目可达数十 MB，
 * 8 条「浏览过又关掉」的会话就是数百 MB 常驻。已关闭的条目不值得为回切流畅性
 * 全额保留——超预算按最旧先淘汰，切回时与 LRU 淘汰同路径重读盘（尾部 9 轮）。
 * 只作用于已关闭 Tab 的条目：打开中的 Tab 保持无条件保护（上面 selectRetained 的
 * 语义不变，挤掉正在看的会话会闪骨架屏）。
 */
export const SESSION_CACHE_CLOSED_ENTRY_BYTE_BUDGET = 64 * 1024 * 1024;

/** 单条消息的固定开销估计（字符数口径）：id/agentId/meta/时间戳与对象头等，与内容无关。 */
const CHAT_MESSAGE_FIXED_OVERHEAD_CHARS = 128;
/** 图片 ref 形态（非 base64）的元数据量级估计（字符数）。 */
const IMAGE_REF_OVERHEAD_CHARS = 64;

/**
 * 估算缓存条目的驻留字节量（UTF-16 口径：字符数 × 2，V8 两字节字符串上界）。
 * 只数大字段（text/thinking/images.data），不做序列化——估算值只服务预算淘汰，
 * 偏差一个量级不影响决策；length 读取是 O(1)，整遍扫描 O(消息数)，相对写入路径
 * 既有的整缓存浅拷贝可忽略。
 */
export function estimateSessionCacheEntryBytes(messages: readonly ChatMessage[], history?: readonly ChatMessage[]): number {
	let chars = 0;
	const visit = (list: readonly ChatMessage[]) => {
		for (const message of list) {
			chars += CHAT_MESSAGE_FIXED_OVERHEAD_CHARS + message.text.length + (message.thinking?.length ?? 0);
			// 图片：base64 data（正在生成/发送的临时形态）按字符串长度计；ref 形态
			// 只有引用串（真实位图不在 JS 堆上），按常量量级计。
			for (const image of message.images ?? []) {
				chars += typeof image.data === "string" ? image.data.length : IMAGE_REF_OVERHEAD_CHARS;
			}
		}
	};
	visit(messages);
	if (history) visit(history);
	return chars * 2;
}

/**
 * 已关闭 Tab 条目的字节预算裁剪：从 retainedIds 的最旧端（数组尾部，见
 * selectRetainedCacheEntryIds 的 [...open, ...closed 新→旧] 布局）开始淘汰关闭条目，
 * 直到关闭条目合计字节 ≤ budget。打开中的条目一律不淘汰。
 * bytesById 缺条目按 0 计（调用方应先补算，见 cacheSessionMessagesAtom）。
 */
export function selectByteBudgetEvictions(retainedIds: readonly string[], bytesById: ReadonlyMap<string, number>, openedTabIds: ReadonlySet<string>, budget: number): { retained: string[]; evicted: string[] } {
	let closedBytes = 0;
	const closed = new Set<string>();
	for (const id of retainedIds) {
		if (openedTabIds.has(id)) continue;
		closed.add(id);
		closedBytes += bytesById.get(id) ?? 0;
	}
	if (closedBytes <= budget) return { retained: [...retainedIds], evicted: [] };
	const evicted: string[] = [];
	const retained = [...retainedIds];
	for (let index = retained.length - 1; index >= 0 && closedBytes > budget; index -= 1) {
		const id = retained[index];
		if (!closed.has(id)) continue;
		closedBytes -= bytesById.get(id) ?? 0;
		evicted.push(id);
		retained.splice(index, 1);
	}
	return { retained, evicted };
}

/**
 * 消息缓存条目的保护集（issue #519：关掉 Agent 不释放内存）。
 *
 * 只有「还能被重新激活的打开 Tab」与「当前聚焦会话」值得常驻内存：
 * 运行时已停止（detach）的会话即使 Tab 还开着，它的全部内容也已在磁盘上，
 * 切回时会走与淘汰条目相同的重读盘路径（尾部窗口页），不该继续无条件占着堆。
 * 聚焦会话例外——屏幕上正显示它的消息，清掉只会立刻触发一次重读盘。
 */
export function selectSessionCacheProtectedIds(input: { tabIds: readonly string[]; stoppedIds: ReadonlySet<string>; focusedSessionId?: string }): Set<string> {
	const protectedIds = new Set<string>();
	for (const id of input.tabIds) {
		if (!input.stoppedIds.has(id)) protectedIds.add(id);
	}
	if (input.focusedSessionId) protectedIds.add(input.focusedSessionId);
	return protectedIds;
}

/**
 * 一次缓存裁剪计划：先把 LRU 顺序与实际驻留键对齐，再套「保护集 → 条数上限 → 已关闭条目字节预算」。
 *
 * 与写入路径的裁剪同语义，供运行时停止 / 会话切换 / 关 Tab 这些**非写入**时机复用
 *（此前淘汰只在写入路径触发，关闭后停在原地的会话会一直驻留）。
 */
export function planSessionCacheTrim(input: { lruIds: readonly string[]; cacheIds: readonly string[]; protectedIds: ReadonlySet<string>; limit: number; bytesById: ReadonlyMap<string, number>; closedByteBudget: number }): { retained: string[]; evicted: string[] } {
	const cacheIds = new Set(input.cacheIds);
	// 缺 LRU 记录的条目（历史写入路径 / 旧缓存）按最旧处理：顺序表漏项不能让条目永久驻留。
	const ordered = [...input.lruIds.filter((id) => cacheIds.has(id)), ...input.cacheIds.filter((id) => !input.lruIds.includes(id))];
	const retainedIds = selectRetainedCacheEntryIds(ordered, input.protectedIds, input.limit);
	const trimmed = selectByteBudgetEvictions(retainedIds, input.bytesById, input.protectedIds, input.closedByteBudget);
	const retained = new Set(trimmed.retained);
	return { retained: trimmed.retained, evicted: ordered.filter((id) => !retained.has(id)) };
}
