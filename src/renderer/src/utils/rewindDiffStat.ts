/**
 * 解析 `git diff-tree --stat` 输出的变更统计（纯函数，供检查点列表提炼摘要行）。
 *
 * diff-tree --stat 的输出末尾有一条汇总行，形如：
 *   " 2 files changed, 5 insertions(+), 3 deletions(-)"
 * 或仅文件数：" 1 file changed"（纯模式变更时无增删计数）。
 * 两棵树相同（无差异）时输出为空串，返回 null 表示「无差异」。
 */

export interface DiffStatSummary {
	/** 变更文件数（汇总行出现时恒 ≥1）。 */
	files: number;
	/** 插入行数；汇总行无 +N 段时缺省。 */
	insertions?: number;
	/** 删除行数；汇总行无 -N 段时缺省。 */
	deletions?: number;
}

const SUMMARY_RE = /(\d+)\s+files? changed(?:, (\d+)\s+insertions?\(\+\))?(?:, (\d+)\s+deletions?\(-\))?/;

/** 从 diff --stat 文本提取汇总；无汇总行（空输出/异常文本）返回 null。 */
export function parseDiffStatSummary(text: string): DiffStatSummary | null {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	// 汇总行在 stat 末尾，从后往前找第一条命中；前面的逐文件行不匹配此模式。
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = lines[i].match(SUMMARY_RE);
		if (m) {
			const stat: DiffStatSummary = { files: parseInt(m[1], 10) };
			// 汇总行可能只带其中一段（纯模式变更无增删计数），缺的键不写入，
			// 避免 undefined 键污染对象形状（deepEqual 对比更干净）。
			if (m[2] !== undefined) stat.insertions = parseInt(m[2], 10);
			if (m[3] !== undefined) stat.deletions = parseInt(m[3], 10);
			return stat;
		}
	}
	return null;
}
