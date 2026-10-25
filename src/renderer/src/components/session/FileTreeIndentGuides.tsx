/**
 * 对应 VS Code TreeRenderer 的逐行祖先引导线：起点 16px，每级 8px。
 * 线只占当前行的高度，默认悬停时显示，不在整个子树容器上拉常驻长线。
 *
 * 颜色用正文色的淡出（foreground/28）而不是 border-subtle：后者在各主题下比底色只亮/暗一档，
 * 实测对比度低到 1.14～1.6（浅色 sea-blue 最差），悬停时也看不见（用户反馈「悬停不显示」）；
 * 正文色是每个主题（含自制外观）都保证与底色有足够反差的那个色，28% 后仍稳定在 1.7～2.4（与 VS Code 的活动态描边相近），
 * 相当于 VS Code 「描边色与背景混合」的 treeIndentGuidesStroke 思路。
 */
export function FileTreeIndentGuides({ depth }: { depth: number }) {
	if (depth === 0) return null;
	return (
		<span data-file-tree-guides="" aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-4 flex opacity-0 transition-opacity duration-fast group-hover/file-tree:opacity-100">
			{Array.from({ length: depth }, (_, level) => (
				<span key={level} data-file-tree-guide-level={level} className="h-full w-2 shrink-0 border-l border-foreground/28" />
			))}
		</span>
	);
}
