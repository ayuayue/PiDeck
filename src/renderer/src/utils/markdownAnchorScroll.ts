/**
 * Markdown 页内锚点的滚动定位（README 目录 `[架构](#架构)` → 跳到该标题）。
 *
 * 只处理 DOM，id 形态由 `components/session/markdownHeadingAnchors.ts` 的
 * `anchorIdFromHref` 决定，两边不重复实现解析。
 *
 * 三个必须处理的现实情况：
 * 1. 同一窗口里可能同时有多份 markdown 正文（会话时间线、文件预览、分屏、公告抽屉），
 *    标题 id 会重复——所以先在「点击位置自己所在的正文/滚动容器」内找，找不到才回退到 document。
 * 2. 大文档（>40K）由 MarkdownStream 的空闲分块渐进挂载，目标标题可能还没进 DOM：
 *    按帧重试有限次数，挂上来就滚（不阻塞点击，也不再动）。
 * 3. 滚动容器不一定就是 document：文件预览是 `overflow-y-auto` 面板，会话正文是虚拟化时间线，
 *    直接 scrollIntoView 会连带滚动外层容器。这里算相对于最近滚动容器的偏移，只动那一个。
 */

/** 标题停在容器顶端时留出的空隙（否则标题紧贴边框，看起来像被切掉）。 */
const ANCHOR_TOP_GAP = 12;
/** 目标标题尚未挂载时的重试帧数（≈500ms，覆盖 settled 分块的 rIC 挂载窗口）。 */
const ANCHOR_RETRY_FRAMES = 30;

function isScrollable(element: HTMLElement): boolean {
	const { overflowY } = window.getComputedStyle(element);
	return (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && element.scrollHeight - element.clientHeight > 1;
}

/** 由内向外收集候选查找范围：正文根（同一份 markdown）与可滚动容器优先，最后才是整页。 */
function anchorScopes(source: HTMLElement | null): ParentNode[] {
	const scopes: ParentNode[] = [];
	for (let node = source?.parentElement ?? null; node; node = node.parentElement) {
		if (node.classList.contains("markdown-body") || isScrollable(node)) scopes.push(node);
	}
	scopes.push(document);
	return scopes;
}

function findAnchorTarget(id: string, source: HTMLElement | null): HTMLElement | null {
	// 第二个候选：作者手写的原始 HTML id（`<h2 id="x">` / `<a name="x">`）会被
	// rehype-sanitize 统一加上 `user-content-` 前缀（GitHub 同款防重名处理），
	// 而文档里的目录链接仍写 `#x`——按前缀再找一次。
	const selector = `#${CSS.escape(id)}, #${CSS.escape(`user-content-${id}`)}`;
	for (const scope of anchorScopes(source)) {
		const found = scope.querySelector(selector);
		if (found instanceof HTMLElement) return found;
	}
	return null;
}

function nearestScroller(element: HTMLElement): HTMLElement | null {
	for (let node = element.parentElement; node; node = node.parentElement) {
		if (isScrollable(node)) return node;
	}
	return null;
}

/** 滚到目标标题：只动它的滚动容器，尊重系统「减少动效」。 */
function scrollToTarget(target: HTMLElement): void {
	const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
	const scroller = nearestScroller(target);
	if (!scroller) {
		target.scrollIntoView({ block: "start", behavior });
		return;
	}
	const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - ANCHOR_TOP_GAP;
	scroller.scrollTo({ top: Math.max(0, top), behavior });
}

/**
 * 点击页内锚点后的滚动入口。目标暂不在 DOM（大文档分块挂载中）时按帧重试，
 * 超过重试窗口就放弃——不做任何可见提示：锚点失配是文档自身的问题，静默比弹错更合适。
 */
export function scrollToMarkdownAnchor(source: HTMLElement | null, id: string): void {
	let attempt = 0;
	const step = () => {
		const target = findAnchorTarget(id, source);
		if (target) {
			scrollToTarget(target);
			return;
		}
		attempt += 1;
		if (attempt <= ANCHOR_RETRY_FRAMES) requestAnimationFrame(step);
	};
	step();
}
