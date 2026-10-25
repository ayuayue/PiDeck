/**
 * 页面内快照采集脚本。
 *
 * 关键约束：这个函数必须**自包含**（不引用模块作用域的常量/函数），
 * 因为它会被 toString() 后注入 webview 主世界执行；外部标识符在页面里不存在。
 * 因此辅助函数都内嵌在函数体内，选择器也写死在里面。
 */

export type SnapshotScriptOptions = {
	maxElements: number;
	includeBoxes: boolean;
	/** 识别可视化：给本轮收录的元素画框 + ref 标签（默认开，纯视觉、自动淡出）。 */
	renderOverlay: boolean;
};

export function collectBrowserSnapshotInPage(rawOptions: { maxElements?: unknown; includeBoxes?: unknown; renderOverlay?: unknown }): unknown {
	const maxElements = typeof rawOptions.maxElements === "number" && rawOptions.maxElements > 0 ? Math.floor(rawOptions.maxElements) : 200;
	const includeBoxes = rawOptions.includeBoxes === true;
	const renderOverlay = rawOptions.renderOverlay !== false;
	const selector = "a[href], button, input:not([type='hidden']), textarea, select, summary, label, [role], [contenteditable=''], [contenteditable='true'], [onclick], [tabindex]:not([tabindex='-1'])";
	const MAX_SCAN = 4000;
	const MAX_ROOTS = 30;

	// 可见性判断同时把 rect 带出来：后续 box 直接复用，不再为同一次快照二次 gBCR。
	const visibleRect = (el: Element): { x: number; y: number; width: number; height: number } | null => {
		const style = window.getComputedStyle(el);
		if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return null;
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return null;
		return rect;
	};

	const roleOf = (el: Element): string => {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit;
		const tag = el.tagName.toLowerCase();
		if (tag === "a") return "link";
		if (tag === "button" || tag === "summary") return "button";
		if (tag === "textarea") return "textbox";
		if (tag === "select") return "combobox";
		if (tag === "label") return "text";
		if (tag === "input") {
			const type = (el.getAttribute("type") || "text").toLowerCase();
			if (type === "checkbox") return "checkbox";
			if (type === "radio") return "radio";
			if (type === "submit" || type === "button" || type === "reset") return "button";
			if (type === "search") return "searchbox";
			return "textbox";
		}
		if (el instanceof HTMLElement && el.isContentEditable) return "textbox";
		return tag;
	};

	const nameOf = (el: Element): string => {
		const ariaLabel = el.getAttribute("aria-label");
		if (ariaLabel && ariaLabel.trim()) return ariaLabel;
		const labelledBy = el.getAttribute("aria-labelledby");
		if (labelledBy) {
			const firstId = labelledBy.split(/\s+/)[0];
			const labelNode = firstId ? document.getElementById(firstId) : null;
			if (labelNode && labelNode.innerText) return labelNode.innerText;
		}
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
			const labels = el.labels;
			if (labels && labels.length > 0 && labels[0].innerText) return labels[0].innerText;
		}
		const placeholder = el.getAttribute("placeholder");
		if (placeholder && placeholder.trim()) return placeholder;
		const title = el.getAttribute("title");
		if (title && title.trim()) return title;
		const alt = el.getAttribute("alt");
		if (alt && alt.trim()) return alt;
		// 容器兜底用 textContent：innerText 会强制 layout 并序列化整棵子树（一个 role="main" 就是整页正文）。
		// textContent 不触发 layout；代价是可能带上隐藏文本，名字随后截断，可接受。
		return el.textContent || "";
	};

	const valueOf = (el: Element): string => {
		if (el instanceof HTMLInputElement) {
			if (el.type === "password") return "[password]";
			if (el.type === "file") return "[file]";
			return el.value;
		}
		if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
		if (el instanceof HTMLElement && el.isContentEditable) return el.innerText;
		return "";
	};

	// 无障碍名缺失的纯布局容器不进快照：它们的"名字"只能是整棵子树文本，
	// 挤占 maxElements 预算（深层按钮被 truncate 掉）还产生一堆压缩正文行。
	const CONTAINER_ROLES = new Set(["presentation", "none", "generic", "main", "banner", "region", "complementary", "contentinfo", "form", "navigation", "article", "section", "group", "toolbar", "menubar", "menu", "directory", "feed", "document", "application", "search"]);
	const hasExplicitName = (el: Element): boolean => {
		const ariaLabel = el.getAttribute("aria-label");
		if (ariaLabel && ariaLabel.trim()) return true;
		if (el.getAttribute("aria-labelledby")) return true;
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
			const labels = el.labels;
			if (labels && labels.length > 0) return true;
		}
		const placeholder = el.getAttribute("placeholder");
		if (placeholder && placeholder.trim()) return true;
		const title = el.getAttribute("title");
		if (title && title.trim()) return true;
		return false;
	};

	// 元素自身 opacity/display/visibility 检查覆盖不了祖先链：opacity:0 的子树里
	// 子元素自身 computed opacity=1 且 rect 非零，用户看不见却能被快照/点击（视觉欺骗面）。
	// 只对准备收录的元素走（≤maxElements × 24 跳上限），保持纯读不破坏两段式。
	const hiddenByAncestor = (el: Element): boolean => {
		let node = el.parentElement;
		let hops = 0;
		while (node && hops < 24) {
			const style = window.getComputedStyle(node);
			if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return true;
			node = node.parentElement;
			hops += 1;
		}
		return false;
	};

	// 收集 document + 开放 shadow root：closed shadow root 无法访问，v1 明确不支持。
	const roots: Array<Document | ShadowRoot> = [];
	const pendingRoots: Array<Document | ShadowRoot> = [document];
	for (let rootIndex = 0; rootIndex < pendingRoots.length && roots.length < MAX_ROOTS; rootIndex += 1) {
		const root = pendingRoots[rootIndex];
		roots.push(root);
		const all = root.querySelectorAll("*");
		for (let i = 0; i < all.length && i < MAX_SCAN; i += 1) {
			const shadow = all[i].shadowRoot;
			if (shadow) pendingRoots.push(shadow);
		}
	}

	// 清掉上一轮 ref，避免页面残留属性让旧 ref 指到新元素。
	for (const root of roots) {
		const stale = root.querySelectorAll("[data-pideck-ref]");
		for (let i = 0; i < stale.length; i += 1) stale[i].removeAttribute("data-pideck-ref");
	}

	const seen = new Set<Element>();
	const candidates: Element[] = [];
	for (const root of roots) {
		const matches = root.querySelectorAll(selector);
		for (let i = 0; i < matches.length; i += 1) {
			const candidate = matches[i];
			if (seen.has(candidate)) continue;
			seen.add(candidate);
			candidates.push(candidate);
		}
	}

	// 两段式（性能关键）：先纯读（可见性/rect/名称/值），再纯写（批量 setAttribute）。
	// 读写交错时每个 setAttribute 都会弄脏样式，下一轮 getComputedStyle/getBoundingClientRect
	// 被迫整页重算——maxElements=200 就是 200 次强制布局，复杂页面会冻结数百毫秒（用户感知为卡顿）。
	// 两段式把布局重算摊平为一次，回归由 tests/browser/browserSnapshotScript.test.mjs 锁定。
	const elements: Array<Record<string, unknown>> = [];
	const refAssignments: Array<{ el: Element; ref: string }> = [];
	// 覆盖层需要每个收录元素的 rect：与 includeBoxes 无关，读阶段顺带留存。
	const boxRects: Array<{ ref: string; rect: { x: number; y: number; width: number; height: number } }> = [];
	let visibleCount = 0;
	for (const el of candidates) {
		const rect = visibleRect(el);
		if (!rect) continue;
		const role = roleOf(el);
		if (!hasExplicitName(el) && CONTAINER_ROLES.has(role)) continue;
		visibleCount += 1;
		if (elements.length >= maxElements) continue;
		if (hiddenByAncestor(el)) continue;
		const ref = `e${elements.length + 1}`;
		const node: Record<string, unknown> = {
			ref,
			role,
			name: nameOf(el).slice(0, 200),
			tag: el.tagName.toLowerCase(),
		};
		const value = valueOf(el);
		if (value) node.value = value.slice(0, 120);
		if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") node.disabled = true;
		if (includeBoxes) node.box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
		elements.push(node);
		refAssignments.push({ el, ref });
		boxRects.push({ ref, rect });
	}
	for (const { el, ref } of refAssignments) el.setAttribute("data-pideck-ref", ref);

	// 识别可视化（用户侧的「选取效果」）：给本轮收录的元素画蓝色框 + ref 标签，约 2s 淡出。
	// 纯视觉增强：pointer-events:none、不进快照数据；页面异常时静默跳过，绝不影响采集结果。
	try {
		const OVERLAY_ID = "__pideck_agent_boxes";
		const previous = document.getElementById(OVERLAY_ID);
		if (previous) previous.remove();
		if (renderOverlay && boxRects.length > 0) {
			const overlay = document.createElement("div");
			overlay.id = OVERLAY_ID;
			overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;transition:opacity .4s ease 1.6s;opacity:1;";
			for (const item of boxRects) {
				const mark = document.createElement("div");
				mark.style.cssText = "position:fixed;left:" + Math.round(item.rect.x) + "px;top:" + Math.round(item.rect.y) + "px;width:" + Math.round(item.rect.width) + "px;height:" + Math.round(item.rect.height) + "px;border:1px solid rgba(59,130,246,.85);border-radius:3px;";
				const tag = document.createElement("span");
				tag.textContent = item.ref;
				tag.style.cssText = "position:absolute;top:-13px;left:-1px;padding:0 4px;border-radius:2px;background:rgba(59,130,246,.95);color:#fff;font:600 10px/13px ui-monospace,monospace;";
				mark.appendChild(tag);
				overlay.appendChild(mark);
			}
			(document.body || document.documentElement).appendChild(overlay);
			setTimeout(() => {
				overlay.style.opacity = "0";
			}, 40);
			setTimeout(() => {
				const stale = document.getElementById(OVERLAY_ID);
				if (stale) stale.remove();
			}, 2300);
		}
	} catch {
		// 可视化失败（怪异 DOM/CSP）不算快照失败。
	}

	return {
		url: location.href,
		title: document.title,
		viewport: { width: window.innerWidth, height: window.innerHeight },
		scroll: { x: window.scrollX, y: window.scrollY },
		devicePixelRatio: window.devicePixelRatio,
		iframeCount: document.querySelectorAll("iframe").length,
		elements,
		totalElements: visibleCount,
		truncated: visibleCount > elements.length,
	};
}

/** 生成可注入 Runtime.evaluate 的表达式（参数经 JSON 序列化，避免注入页面代码）。 */
export function buildSnapshotExpression(options: SnapshotScriptOptions): string {
	const payload = JSON.stringify({ maxElements: options.maxElements, includeBoxes: options.includeBoxes, renderOverlay: options.renderOverlay });
	return `(${collectBrowserSnapshotInPage.toString()})(${payload})`;
}
