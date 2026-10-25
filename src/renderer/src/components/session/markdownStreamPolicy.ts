/**
 * MarkdownStream 渲染策略（纯函数，无 React 依赖，可单测）。
 *
 * 背景（2026-08 内存/CPU 治理）：
 * - 流式期间若消息「不可冻结」（未闭合代码围栏 / 内容块 ≤ 2 个，
 *   IncrementalMarkdownFrontier 返回 prefixEnd=0），Streamdown 会退化为
 *   每帧全量解析 + 全量 DOM 重建——大代码块流式输出时 GC 追不上，
 *   渲染进程原生内存持续爬升（实测可达 200-450MB/min）。
 * - settle 后整篇全量渲染（高亮逐 token span）会把超大代码块的 DOM
 *   永久留在时间线里（GB 级）。
 * 两个阈值分别把这两条路径拉回轻量渲染。
 */

/** 流式超长兜底阈值：marked 解析成本随累积文本线性增长（实测 30K≈2.3ms/帧），
 * 超过后流式期间整体回退纯文本，settle 后再全量渲染。
 * 2026-08 内存治理后恢复 40K：冻结前缀走 memo（边界不动零重解析）、增量重扫
 * O(delta)、尾部只留最后一块，>40K 的冻结路径每帧成本已与文本长度无关；
 * 40K 上限只兜底「回退纯文本」路径的 layout 成本（该路径由 split-plain 把
 * 每帧变更限制在 ≤4K 文本节点）。 */
export const STREAM_LIGHT_MAX_CHARS = 40_000;

/** 流式不可冻结兜底阈值：prefixEnd=0（未闭合围栏等）时每帧都是全量重渲染，
 * 超过该小阈值即回退纯文本；更小的消息每帧全量渲染成本可忽略，保持富渲染。 */
export const STREAM_UNFREEZABLE_MIN_CHARS = 8_000;

/** settle 全量渲染内容上限：超过后保持轻量插件（无逐 token 高亮/mermaid），
 * 防止超大代码块一次渲染留下 GB 级 DOM。 */
export const SETTLE_FULL_MAX_CHARS = 150_000;

export function shouldRenderStreamPlain(input: {
	isStreaming: boolean;
	textLength: number;
	/** 冻结切分结果：undefined = 未运行（超长跳过扫描）；0 = 不可冻结 */
	prefixEnd: number | undefined;
}): boolean {
	if (!input.isStreaming) return false;
	// 整体超长：无条件纯文本（现有兜底契约）
	if (input.textLength > STREAM_LIGHT_MAX_CHARS) return true;
	// 不可冻结且超过小阈值：每帧全量重渲染的代价不值得，流式期纯文本
	return input.prefixEnd === 0 && input.textLength > STREAM_UNFREEZABLE_MIN_CHARS;
}

export function shouldKeepLightOnSettle(textLength: number): boolean {
	return textLength > SETTLE_FULL_MAX_CHARS;
}

/** settle 后默认折叠的超长正文阈值：超过后正文只渲染预览前缀 + 「展开全文」，
 * 展开前不构建完整 markdown DOM。
 * 背景（2026-10 DSH 长回合卡顿）：单个 turn 可持续数十分钟、产出 100-200KB 的
 * 单条 assistant 正文（数千段落 + 数十个代码围栏）。settle 后全量渲染会把
 * 数万~数十万 DOM 节点永久留在时间线里（turn 级窗口按轮折叠，帮不上单轮内的
 * 巨型消息），滚动/布局全程卡顿、内存压力拖慢整机。该阈值把常驻 DOM 封顶在
 * 预览长度量级；用户点「展开全文」才付出全量渲染成本（展开后仍受
 * SETTLE_FULL_MAX_CHARS 轻量插件上限约束）。正常回复远小于该值，不受影响。 */
export const SETTLED_COLLAPSE_MIN_CHARS = 30_000;

/** 折叠态预览前缀长度：预览足够读清结论，又保证渲染/布局成本可忽略。 */
export const SETTLED_COLLAPSE_PREVIEW_CHARS = 6_000;

/** settle 正文是否默认折叠（流式路径不受影响——流式已有 >40K 纯文本兜底）。 */
export function shouldCollapseSettledText(textLength: number): boolean {
	return textLength > SETTLED_COLLAPSE_MIN_CHARS;
}

/** 折叠态预览切片：优先回退到段落边界（避免半个代码围栏/表格进预览），
 * 前半找不到空行（超长单段）就原样截断——纯展示副本，不改写消息原文。 */
export function settledCollapsePreview(text: string): string {
	const raw = text.slice(0, SETTLED_COLLAPSE_PREVIEW_CHARS);
	const cut = raw.lastIndexOf("\n\n");
	return cut >= SETTLED_COLLAPSE_PREVIEW_CHARS / 2 ? raw.slice(0, cut) : raw;
}
