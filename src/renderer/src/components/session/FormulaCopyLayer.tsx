import { useEffect } from "react";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

/**
 * 通用公式复制（行内 $...$ 点公式本体、块级 $$...$$ 按钮常显）。
 *
 * streamdown/@streamdown/math 无自带公式复制（interactive controls 只覆盖
 * images/tables/code/mermaid），而 rehype-katex 输出是纯 HTML span、不进
 * Components map——旧实现只能在 p 层拦截「段落唯一子元素是 .katex」的罕见
 * 场景，真正的块级公式（math-display，p 外）与行内公式都无法复制。
 *
 * 实现：DOM 直插按钮/挂点击（非 React 管理）+ MutationObserver 跟随流式重渲染
 * （KaTeX 每帧重建容器，挂载随旧元素销毁、对新元素自动补齐）。
 * - 块级公式（.math-display 容器，独占一行）：按钮插在容器末尾，公式 flex
 *   居中 + 按钮靠右（容器 flex 化见 surfaces.css）
 * - 行内公式（文本流中）：不插独立按钮——公式本体加细边框“框”成可点击
 *   目标，直接点击公式即复制 LaTeX。连续多个公式时不会出现一排按钮块，
 *   观感更干净（框的样式用 Tailwind utility，见 INLINE_BOX_CLASS）
 *
 * LaTeX 源码取自 KaTeX 的 MathML annotation（rehype-katex 固定输出
 * annotation[encoding="application/x-tex"]）。全局单次监听，多实例共享。
 */

// 图标用 lucide 官方 path 内联（非 React 环境无法用组件）
const COPY_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

// 块级按钮：公式容器末尾，常显半透明（仿代码块 actions 观感）；
// 间距由 .math-display 容器 gap 提供，按钮自身不留外边距
const BLOCK_BUTTON_CLASS = "flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-text-tertiary opacity-55 transition-opacity hover:opacity-100 hover:text-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]";
// 行内公式“框”样式（Tailwind utility 全部走 utilities 层，可压过 KaTeX 的
// vendor 层样式）：细边框 + 弱底色常显，hover 边框转 accent 提示可点击。
// 底色用 --color-bg-muted、边框用 --color-border-subtle 语义 token，暗色自动适配。
const INLINE_BOX_BORDER_BG = ["border-[var(--color-border-subtle)]", "bg-[var(--color-bg-muted)]"];
const INLINE_BOX_COPIED_BORDER_BG = ["border-[var(--color-success)]", "bg-[var(--color-success-soft)]"];
const INLINE_BOX_CLASS = ["inline-block", "cursor-pointer", "rounded-xs", "border", "px-[5px]", "py-[1px]", "transition-colors", "hover:border-[var(--color-accent)]", ...INLINE_BOX_BORDER_BG];

/** 复制 LaTeX 源码（KaTeX MathML annotation），返回是否成功。 */
function copyTexFrom(root: Element): Promise<boolean> {
	const tex = root.querySelector('.katex-mathml annotation[encoding="application/x-tex"]')?.textContent?.trim() ?? "";
	if (!tex) return Promise.resolve(false);
	return navigator.clipboard
		.writeText(tex)
		.then(() => true)
		.catch(() => false);
}

function attachCopyHandlers(button: HTMLButtonElement, root: Element) {
	button.addEventListener("click", () => {
		void copyTexFrom(root).then((ok) => {
			if (!ok) {
				showNotice(t("copy.failed"), 2000);
				return;
			}
			button.innerHTML = CHECK_SVG;
			window.setTimeout(() => {
				button.innerHTML = COPY_SVG;
			}, 1500);
			showNotice(t("copy.formulaCopied"), 1200);
		});
	});
}

/** 块级公式：容器末尾插按钮（幂等）。 */
function attachBlockButton(container: HTMLElement) {
	if (container.querySelector("[data-math-copy-btn]")) return;
	const button = document.createElement("button");
	button.type = "button";
	button.dataset.mathCopyBtn = "";
	button.title = t("copy.formula");
	button.setAttribute("aria-label", t("copy.formula"));
	button.className = BLOCK_BUTTON_CLASS;
	button.innerHTML = COPY_SVG;
	attachCopyHandlers(button, container);
	container.appendChild(button);
}

/** 行内公式：公式本体加“框”并挂点击复制（幂等）。
 * 点击目标就是 .katex 本身，不再插入独立按钮。 */
function attachInlineCopy(katex: HTMLElement) {
	if (katex.dataset.mathCopyAttached) return;
	katex.dataset.mathCopyAttached = "1";
	katex.title = t("copy.formula");
	katex.classList.add(...INLINE_BOX_CLASS);
	katex.addEventListener("click", (event) => {
		// 拖选文本时 mouseup 会落在公式上触发 click，有选区则视为选择而非复制
		const selection = window.getSelection();
		if (selection && !selection.isCollapsed) return;
		// 公式若在链接内，阻止默认跳转，避免“复制”误触发导航
		// （不用 stopPropagation：公式可能位于弹层内，不能截断外层点击关闭类监听）
		event.preventDefault();
		void copyTexFrom(katex).then((ok) => {
			if (!ok) {
				showNotice(t("copy.failed"), 2000);
				return;
			}
			// 短暂把边框/底色切成 success 色作复制成功反馈，再恢复常态
			katex.classList.remove(...INLINE_BOX_BORDER_BG);
			katex.classList.add(...INLINE_BOX_COPIED_BORDER_BG);
			window.setTimeout(() => {
				katex.classList.remove(...INLINE_BOX_COPIED_BORDER_BG);
				katex.classList.add(...INLINE_BOX_BORDER_BG);
			}, 1400);
			showNotice(t("copy.formulaCopied"), 1200);
		});
	});
}

/** 为 root 及其后代补齐公式复制挂载（幂等）：块级插按钮，行内本体加框。 */
function ensureFormulaButtons(root: Element) {
	// 行内公式：所有 .katex 中不在 .math-display 容器内的（块级已由容器统一处理）
	for (const el of root.querySelectorAll(".katex")) {
		if (!el.closest(".math-display")) attachInlineCopy(el as HTMLElement);
	}
	if (root.classList.contains("katex") && !root.closest(".math-display")) {
		attachInlineCopy(root as HTMLElement);
	}
	for (const el of root.querySelectorAll(".math-display")) {
		attachBlockButton(el as HTMLElement);
	}
	if (root.classList.contains("math-display")) attachBlockButton(root as HTMLElement);
}

/** 当前挂载的 FormulaCopyLayer 数量：全部卸载后断开观察，避免全应用常驻空转。 */
let layerMountCount = 0;
/** 本帧待补齐的子树（合并同帧多次 DOM 增删，流式 tick 下只扫一遍）。 */
const pendingRoots = new Set<Element>();
let pendingFrame: number | null = null;
let bodyObserver: MutationObserver | null = null;

function flushFormulaRoots() {
	pendingFrame = null;
	const roots = [...pendingRoots];
	pendingRoots.clear();
	for (const root of roots) {
		// 节点可能已被后续 React 提交移除：跳过（其公式随之销毁，无需挂载）。
		if (!root.isConnected) continue;
		ensureFormulaButtons(root);
	}
}

function scheduleFormulaRoot(root: Element) {
	pendingRoots.add(root);
	if (pendingFrame !== null) return;
	pendingFrame = window.requestAnimationFrame(flushFormulaRoots);
}

function initFormulaButtons() {
	if (!(typeof document !== "undefined")) return;
	layerMountCount += 1;
	if (bodyObserver) return;
	// 初始补齐一次（页面已有渲染完成的公式），之后观察流式重渲染增量补齐
	ensureFormulaButtons(document.body);
	bodyObserver = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.type !== "childList") continue;
			for (const node of mutation.addedNodes) {
				if (!(node instanceof Element)) continue;
				// 快速粗筛（2026 内存排查）：observer 挂在 document.body 上，
				// 侧栏/文件树/流式 tick 等任何 DOM 增删都会进回调；多数与公式无关，
				// 先短路判断节点自身/子树是否带 .katex/.math-display 再进扫描，
				// 避免每次 tick 对无关子树跑完整挂载逻辑。
				const hasMath = node.matches?.(".katex, .math-display") || Boolean(node.querySelector?.(".katex, .math-display"));
				if (hasMath) scheduleFormulaRoot(node);
			}
		}
	});
	bodyObserver.observe(document.body, { childList: true, subtree: true });
}

/** 卸载一个挂载者：最后一个卸载时断开观察并丢弃本帧待办（2027-02 性能治理）。 */
function releaseFormulaButtons() {
	layerMountCount = Math.max(0, layerMountCount - 1);
	if (layerMountCount > 0) return;
	bodyObserver?.disconnect();
	bodyObserver = null;
	if (pendingFrame !== null) {
		window.cancelAnimationFrame(pendingFrame);
		pendingFrame = null;
	}
	pendingRoots.clear();
}

/** 公式复制层：挂在 MarkdownStream 内，不渲染任何 DOM。
 * 块级按钮为 DOM 直插（非 React），行内挂载为对 .katex 元素加类/事件，
 * 均随 KaTeX 元素生命周期自动销毁/重建。 */
export function FormulaCopyLayer() {
	useEffect(() => {
		initFormulaButtons();
		// 2027-02：观察者按挂载者计数复用，最后一个卸载时断开——原先
		// document.body 上的 subtree MutationObserver 永不 disconnect，
		// 侧栏/文件树/流式的任何 DOM 增删都常驻进入回调。
		return () => releaseFormulaButtons();
	}, []);
	return null;
}
