/**
 * 打字机内容变更分类（从 useSmoothStream 抽出，pi / DSH 同一套）。
 *
 * 主进程偶发把 partial 全文发成比本地累积更短的快照。若一律整段替换，
 * 已打出的字会瞬间缩回去。规则：
 * - 追加：正常入队
 * - 回退到 displayed 的前缀：钳到更短权威文本（真回退）
 * - 更短快照是 displayed 的后缀：忽略（partial 只带了最后一块）
 * - 完全无关：才整段替换
 */
export type SmoothStreamChange = { kind: "none" } | { kind: "append"; delta: string } | { kind: "rewind"; text: string } | { kind: "ignore" } | { kind: "replace"; text: string };

export function classifySmoothStreamChange(prevContent: string, displayed: string, nextContent: string): SmoothStreamChange {
	if (nextContent === prevContent) return { kind: "none" };
	if (nextContent.startsWith(prevContent)) {
		const delta = nextContent.slice(prevContent.length);
		return delta ? { kind: "append", delta } : { kind: "none" };
	}
	if (displayed.startsWith(nextContent)) {
		return { kind: "rewind", text: nextContent };
	}
	if (nextContent.length > 0 && nextContent.length < displayed.length && displayed.endsWith(nextContent)) {
		return { kind: "ignore" };
	}
	return { kind: "replace", text: nextContent };
}
