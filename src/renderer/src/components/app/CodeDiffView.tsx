import { memo, useMemo } from "react";
import { MultiFileDiff, Virtualizer, WorkerPoolContextProvider, type FileContents } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { t } from "../../i18n";
import { getDiffRenderPlan } from "../../utils/diffRenderPlan";

/**
 * 文件差异对比视图（只读）：基于 @pierre/diffs 的 MultiFileDiff 渲染，
 * 支持分栏 / 单栏两种布局。
 *
 * 视觉约定（GitHub 风格）：
 * - 行级背景一层颜色：添加=绿（--color-success-soft）、删除=红（--color-danger-soft）
 * - 行号列跟随变更着色（浅底 + 语义色数字）
 * - 变更指示 = 分栏中缝的红/绿竖条（diffIndicators: bars），无 +/- 字符
 * - 折叠区 = hunk 分隔条（hunkSeparators: line-info），GitHub 式 @@ 行号信息
 * - 行内 diff 关闭（lineDiffType: none）：纯行级红绿标注，不做 word 级二次对比
 *
 * 性能与内存策略（大文件不必降级为纯文本提示）：
 * - 紧凑模式：只显示变更行。未变化段超过 collapsedContextThreshold（0 = 任何未变化行）
 *   折叠为展开条，点击展开才加载该段（expansionLineCount 限制单次加载行数）；
 *   parseDiffOptions.context=0 连 hunk 内上下文也去掉，所见即变更。
 *   注：库默认就是折叠（expandUnchanged=false），旧配置显式 expandUnchanged:true 导致全量展示。
 * - 虚拟化：Virtualizer 只挂载可视区行，未变化大段零 DOM。
 * - Worker 高亮：WorkerPoolContextProvider 把 diff 计算 + Shiki tokenize 放
 *   worker 线程（单例池，最多 2 个 worker），主线程只渲染；
 *   池最后一个使用方卸载时自动 terminate，资源全部释放。
 * - tokenizeMaxLength 限制高亮额度，超出的行自动降级纯文本。
 * - 档位由 getDiffRenderPlan 决定（见 utils/diffRenderPlan.ts）：
 *   两侧 ≤ 50k 行全功能；≤ 200k 行降质；再大才提示 git diff。
 */

export type CodeDiffViewMode = "split" | "unified";

/** 折叠阈值：hunk 间未变化行超过该值时折叠为展开条（≤ 阈值直接显示 context）。
 * 0 = 最紧凑：任何未变化行都折叠，只保留变更行 + 展开条。 */
const COLLAPSED_CONTEXT_THRESHOLD = 0;

/** worker 池大小：1 个足以串行处理，2 个兼顾并发分屏，避免默认 8 个占内存。 */
const WORKER_POOL_SIZE = 2;

export const CodeDiffView = memo(function CodeDiffView(props: { oldContent: string; newContent: string; filePath: string; viewMode: CodeDiffViewMode; theme?: "light" | "dark" }) {
	const theme = props.theme ?? (typeof document !== "undefined" ? (document.documentElement.dataset.theme === "dark" ? "dark" : "light") : "light");

	const oldLines = useMemo(() => countLines(props.oldContent), [props.oldContent]);
	const newLines = useMemo(() => countLines(props.newContent), [props.newContent]);
	// 档位只依赖行数（纯函数），diff 计算量由 worker 承载，不在此预估
	const plan = useMemo(() => getDiffRenderPlan(oldLines, newLines), [oldLines, newLines]);

	const oldFile: FileContents = useMemo(
		() => ({
			name: props.filePath,
			contents: props.oldContent,
		}),
		[props.filePath, props.oldContent],
	);

	const newFile: FileContents = useMemo(
		() => ({
			name: props.filePath,
			contents: props.newContent,
		}),
		[props.filePath, props.newContent],
	);

	const options = useMemo(() => {
		// fallback 已在下方提前 return，此处仅为类型收窄（hunk 两档都带这些字段）
		if (plan.mode === "fallback") return null;
		return {
			diffStyle: props.viewMode,
			theme: { dark: "one-dark-pro" as const, light: "one-light" as const },
			disableFileHeader: true,
			diffIndicators: "bars" as const,
			hunkSeparators: "line-info" as const,
			overflow: "scroll" as const,
			themeType: theme as "light" | "dark" | "system",
			// GitHub 式折叠：未变化段超阈值折叠，点击展开（每次最多 expansionLineCount 行）
			collapsedContextThreshold: COLLAPSED_CONTEXT_THRESHOLD,
			// 紧凑模式：关闭全量展开（旧值 true 会让所有未变化行强制展示，折叠形同虚设）
			expandUnchanged: false,
			// hunk 内上下文 0 行：jsdiff 默认 context=3，传 0 让变更块之间即使相隔 1 行也拆成独立 hunk
			parseDiffOptions: { context: 0 },
			expansionLineCount: plan.expansionLineCount,
			// 行内 diff 保持关闭（word 级）：实测收益有限且增加额外对比计算，
			// 当前纯行级红绿标注足够直观（GitHub 式折叠/展开不受影响）
			lineDiffType: "none" as const,
			tokenizeMaxLength: plan.tokenizeMaxLength,
			// 颜色全部引用应用 token（明暗随 data-theme 自动切换），不写死色值
			unsafeCSS: `
			:root, :host {
				--diffs-bg: transparent;
				--diffs-addition-base: var(--color-success);
				--diffs-deletion-base: var(--color-danger);
				--diffs-addition-bg: var(--color-success-soft);
				--diffs-deletion-bg: var(--color-danger-soft);
				--diffs-separator-bg: var(--color-bg-panel);
				--diffs-gap-style: 3px solid var(--color-border-subtle);
				--diffs-scrollbar-thumb: color-mix(in srgb, var(--color-border-strong) 70%, transparent);
				--diffs-scrollbar-thumb-hover: var(--color-text-tertiary);
			}
			[data-line-type="change-addition"] {
				background-color: var(--diffs-addition-bg) !important;
			}
			[data-line-type="change-deletion"] {
				background-color: var(--diffs-deletion-bg) !important;
			}
			[data-line-type="change-addition"] [data-column-number],
			[data-line-type="change-addition"] [data-gutter-buffer]:not([data-gutter-buffer="buffer"]) {
				color: var(--diffs-addition-base) !important;
				background-color: var(--diffs-addition-bg) !important;
			}
			[data-line-type="change-deletion"] [data-column-number],
			[data-line-type="change-deletion"] [data-gutter-buffer]:not([data-gutter-buffer="buffer"]) {
				color: var(--diffs-deletion-base) !important;
				background-color: var(--diffs-deletion-bg) !important;
			}
			[data-gutter-buffer="buffer"] {
				background: none !important;
			}
			[data-line-type="context"] [data-column-number],
			[data-line-type="metadata"] [data-column-number],
			[data-line-type="expanded"] [data-column-number],
			[data-gutter] {
				background-color: var(--color-bg-panel) !important;
			}
		`,
		};
	}, [props.viewMode, theme, plan]);

	if (plan.mode === "fallback") {
		return (
			<div className="flex h-full items-center justify-center overflow-auto bg-[var(--color-bg-panel)]">
				<div className="px-4 text-center text-[var(--color-text-secondary)]">
					<p className="mb-1 text-control font-medium">{t("editor.diffTooLarge")}</p>
					<p className="text-caption">
						{t("editor.diffTooLargeDetail", {
							old: oldLines.toLocaleString(),
							new: newLines.toLocaleString(),
						})}
					</p>
				</div>
			</div>
		);
	}

	// WorkerPool：单例池（最多 2 worker），diff 计算 + Shiki 高亮不占主线程；
	// 本组件卸载（diff 面板关闭）且无其他使用方时，池自动 terminate 释放内存。
	// Virtualizer：只挂载可视区行，滚动窗口外零 DOM（行高用库默认 20px）。
	return (
		<WorkerPoolContextProvider
			poolOptions={{
				poolSize: WORKER_POOL_SIZE,
				workerFactory: () => new DiffWorker(),
			}}
			highlighterOptions={{
				theme: { dark: "one-dark-pro" as const, light: "one-light" as const },
			}}
		>
			<Virtualizer className="code-diff-view h-full overflow-auto bg-[var(--color-bg-panel)]">{options !== null && <MultiFileDiff oldFile={oldFile} newFile={newFile} options={options} className="h-full" />}</Virtualizer>
		</WorkerPoolContextProvider>
	);
});

function countLines(content: string): number {
	if (!content) return 0;
	let count = 1;
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\n") count++;
	}
	return count;
}
