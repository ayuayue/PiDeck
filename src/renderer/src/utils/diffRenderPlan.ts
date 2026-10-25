/**
 * 大文件 diff 渲染分档策略（纯函数，可单测）。
 *
 * @pierre/diffs 支持 GitHub 式 hunk 渲染：未变化段超过 collapsedContextThreshold
 * 时折叠为展开条（点击才加载该段），配合虚拟化（只挂载可视区行）与 worker
 * 高亮（diff 计算 + Shiki tokenize 都在 worker 线程），行数不再是「能不能渲染」
 * 的硬门槛，只影响质量档位：
 *
 * - hunk：默认档。完整能力：行内 word 级 diff、默认高亮额度、单次展开 200 行。
 * - hunk-limited：超大文件降质档。关闭行内 diff、高亮额度收窄到 30k token、
 *   单次展开 100 行 —— 保证 worker 内存与计算量可控。
 * - fallback：超出安全上限，不渲染，提示用 git diff 查看。
 *
 * 档位只由两侧行数决定；diff 计算量（Myers O(N·D)）在 worker 中执行，
 * 主线程只承担虚拟化后的可视区 DOM，因此此处不做变更量预估。
 */

/** 两侧行数均不超过该值时使用完整 hunk 档（原 5_000 行硬门槛的替代）。 */
export const HUNK_RENDER_MAX_LINES = 50_000;

/** 任一侧行数超过该值时放弃渲染（防 diff 计算 + tokenize 内存失控）。 */
export const HUNK_LIMITED_MAX_LINES = 200_000;

/** 完整档高亮额度：@pierre/diffs 默认值，超出的行自动降级纯文本。 */
export const TOKENIZE_MAX_LENGTH_DEFAULT = 100_000;

/** 降质档高亮额度：大文件收紧，防 worker 内存膨胀。 */
export const TOKENIZE_MAX_LENGTH_LIMITED = 30_000;

/** 完整档单次展开行数（GitHub 单次展开约 20 行，此处取 200 兼顾大文件）。 */
export const EXPANSION_LINE_COUNT_DEFAULT = 200;

/** 降质档单次展开行数。 */
export const EXPANSION_LINE_COUNT_LIMITED = 100;

export type DiffRenderPlan =
	| {
			mode: "hunk";
			tokenizeMaxLength: number;
			expansionLineCount: number;
	  }
	| {
			mode: "hunk-limited";
			tokenizeMaxLength: number;
			expansionLineCount: number;
	  }
	| { mode: "fallback" };

export function getDiffRenderPlan(oldLineCount: number, newLineCount: number): DiffRenderPlan {
	const maxSide = Math.max(oldLineCount, newLineCount);
	if (maxSide > HUNK_LIMITED_MAX_LINES) {
		return { mode: "fallback" };
	}
	if (maxSide > HUNK_RENDER_MAX_LINES) {
		return {
			mode: "hunk-limited",
			tokenizeMaxLength: TOKENIZE_MAX_LENGTH_LIMITED,
			expansionLineCount: EXPANSION_LINE_COUNT_LIMITED,
		};
	}
	return {
		mode: "hunk",
		tokenizeMaxLength: TOKENIZE_MAX_LENGTH_DEFAULT,
		expansionLineCount: EXPANSION_LINE_COUNT_DEFAULT,
	};
}
