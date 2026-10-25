/**
 * 页面内小脚本构造器：只做"取状态 / 解析 ref / 滚动 / 聚焦"这类无副作用或可重复执行的操作。
 * 所有参数都经 JSON.stringify 注入，ref 在调用前已由 BrowserController 用 /^e\d+$/ 校验。
 */

const REF_SELECTOR = (ref: string) => `[data-pideck-ref=${JSON.stringify(ref)}]`;

export function buildPageStateExpression(): string {
	return "(() => ({ url: location.href, title: document.title, viewport: { width: window.innerWidth, height: window.innerHeight }, scroll: { x: window.scrollX, y: window.scrollY }, scrollHeight: Math.max(0, document.documentElement ? document.documentElement.scrollHeight : 0), scrollWidth: Math.max(0, document.documentElement ? document.documentElement.scrollWidth : 0), devicePixelRatio: window.devicePixelRatio, iframeCount: document.querySelectorAll('iframe').length }))()";
}

export type ResolvedRefNode = {
	found: boolean;
	visible?: boolean;
	disabled?: boolean;
	tag?: string;
	name?: string;
	rect?: { x: number; y: number; width: number; height: number };
};

export function buildResolveRefExpression(ref: string): string {
	const selector = REF_SELECTOR(ref);
	return `(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		if (!el) return { found: false };
		const rect = el.getBoundingClientRect();
		const style = window.getComputedStyle(el);
		const visible = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
		const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
		// 名称解析链与快照脚本（browserSnapshotScript 的 nameOf）保持一致：只认 aria-label/innerText 时，
		// 纯 placeholder 撑起来的输入框在审批框里会显示成空名，用户无法判断批的是什么。
		const nameOf = (node) => {
			const ariaLabel = node.getAttribute("aria-label");
			if (ariaLabel && ariaLabel.trim()) return ariaLabel;
			const labelledBy = node.getAttribute("aria-labelledby");
			if (labelledBy) {
				const labelNode = document.getElementById(labelledBy.split(/\s+/)[0]);
				if (labelNode && labelNode.innerText) return labelNode.innerText;
			}
			if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
				const labels = node.labels;
				if (labels && labels.length > 0 && labels[0].innerText) return labels[0].innerText;
			}
			const placeholder = node.getAttribute("placeholder");
			if (placeholder && placeholder.trim()) return placeholder;
			const title = node.getAttribute("title");
			if (title && title.trim()) return title;
			const alt = node.getAttribute("alt");
			if (alt && alt.trim()) return alt;
			// 兜底与快照脚本一致用 textContent：身份比对两边必须同源，innerText/textContent 的差异会造成误判 stale。
			return node.textContent || "";
		};
		const label = nameOf(el) || "";
		return { found: true, visible, disabled, tag: el.tagName.toLowerCase(), name: label.replace(/\s+/g, " ").trim().slice(0, 120), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
	})()`;
}

/** 仅聚焦（不清空）：输入动作前的标准准备。 */
export function buildFocusExpression(ref: string): string {
	return `(() => { const el = document.querySelector(${JSON.stringify(REF_SELECTOR(ref))}); if (!el) return false; if (el instanceof HTMLElement) el.focus(); return true; })()`;
}

/** 把元素滚到视口中央，点击前调用，保证 rect 是视口内坐标。 */
export function buildScrollIntoViewExpression(ref: string): string {
	return `(() => { const el = document.querySelector(${JSON.stringify(REF_SELECTOR(ref))}); if (!el) return false; el.scrollIntoView({ block: "center", inline: "center" }); return true; })()`;
}

/** 聚焦并全选（清空输入框/可编辑区的前置动作）。 */
export function buildFocusAndSelectExpression(ref: string): string {
	return `(() => {
		const el = document.querySelector(${JSON.stringify(REF_SELECTOR(ref))});
		if (!el) return false;
		if (el instanceof HTMLElement) el.focus();
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { el.select(); return true; }
		if (el instanceof HTMLElement && el.isContentEditable) {
			const range = document.createRange();
			range.selectNodeContents(el);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			return true;
		}
		return true;
	})()`;
}

/** CDP 不可用时的降级点击：DOM click()（非 trusted、无 hover 序列）。 */
export function buildFallbackClickExpression(ref: string): string {
	return `(() => { const el = document.querySelector(${JSON.stringify(REF_SELECTOR(ref))}); if (!el) return false; if (el instanceof HTMLElement) el.click(); return true; })()`;
}

/** 降级输入：直接写 value / textContent 并派发 input+change。clear=false 时在末尾追加（对齐 CDP 路径 insertText 的追加语义，直接覆盖会吞掉已有内容）。 */
export function buildFallbackTypeExpression(ref: string, text: string, clear: boolean): string {
	const clearLiteral = JSON.stringify(clear);
	return `(() => {
		const el = document.querySelector(${JSON.stringify(REF_SELECTOR(ref))});
		if (!el) return false;
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = ${clearLiteral} ? ${JSON.stringify(text)} : el.value + ${JSON.stringify(text)};
		else if (el instanceof HTMLElement && el.isContentEditable) {
			if (${clearLiteral} && el.textContent) el.textContent = "";
			el.appendChild(document.createTextNode(${JSON.stringify(text)}));
		} else return false;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		return true;
	})()`;
}

/**
 * waitFor 的页面内判定：只回布尔，不把整页 innerText 拉回主进程。
 * 此前每 250ms 一次 returnByValue 全文回传（文本页几百 KB × 120 次 ≈ 数十 MB 序列化），
 * 现在匹配发生在页面里，主进程只收 true/false。
 */
export function buildWaitForTextExpression(text: string): string {
	return `!!(document.body && document.body.innerText.includes(${JSON.stringify(text)}))`;
}

/**
 * 动作可视化：给 agent 正在操作的目标元素画琥珀色高亮框 + 「ref · 名称」标签，
 * 约 1.5s 后淡出移除。纯视觉增强：pointer-events:none、best-effort（失败由调用方吞掉，
 * 不影响动作本身）。用户由此能看到 agent「选取」了哪个元素（browser-use 式体验）。
 */
export function buildHighlightExpression(ref: string, label: string): string {
	return `(() => {
		const el = document.querySelector(${JSON.stringify(REF_SELECTOR(ref))});
		if (!el) return false;
		const id = "__pideck_agent_highlight";
		const old = document.getElementById(id);
		if (old) old.remove();
		const rect = el.getBoundingClientRect();
		const box = document.createElement("div");
		box.id = id;
		box.style.cssText = "position:fixed;left:" + (rect.x - 3) + "px;top:" + (rect.y - 3) + "px;width:" + (rect.width + 6) + "px;height:" + (rect.height + 6) + "px;border:2px solid #f59e0b;border-radius:4px;background:rgba(245,158,11,.14);box-shadow:0 0 0 3px rgba(245,158,11,.25);pointer-events:none;z-index:2147483647;transition:opacity .45s ease .95s;opacity:1;";
		const tag = document.createElement("div");
		tag.textContent = ${JSON.stringify(label)};
		tag.style.cssText = "position:absolute;top:-20px;left:-2px;padding:1px 6px;border-radius:3px;background:#f59e0b;color:#1f2937;font:600 11px/1.5 ui-sans-serif,system-ui,sans-serif;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;";
		box.appendChild(tag);
		(document.body || document.documentElement).appendChild(box);
		setTimeout(() => { box.style.opacity = "0"; }, 40);
		setTimeout(() => { if (document.getElementById(id) === box) box.remove(); }, 1600);
		return true;
	})()`;
}

/** 清掉 agent 可视化覆盖层（识别框/查找框/高亮框）：截图前调用，避免辅助框进入模型视觉。 */
export function buildClearOverlaysExpression(): string {
	return `(() => { for (const id of ["__pideck_agent_boxes", "__pideck_agent_highlight", "__pideck_agent_find"]) { const node = document.getElementById(id); if (node) node.remove(); } return true; })()`;
}

/**
 * browser_find 的匹配可视化：把命中的元素批量画琥珀色框 + ref 标签（一次表达式完成，
 * 逐个高亮会是 N 次 CDP 往返）。纯视觉、pointer-events:none、自动淡出。
 */
export function buildFindHighlightExpression(refs: readonly string[]): string {
	return `(() => {
		const wanted = new Set(${JSON.stringify(refs)});
		const id = "__pideck_agent_find";
		const old = document.getElementById(id);
		if (old) old.remove();
		const overlay = document.createElement("div");
		overlay.id = id;
		overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646;transition:opacity .4s ease 1.8s;opacity:1;";
		const marked = document.querySelectorAll("[data-pideck-ref]");
		for (let i = 0; i < marked.length; i += 1) {
			const el = marked[i];
			const ref = el.getAttribute("data-pideck-ref");
			if (!ref || !wanted.has(ref)) continue;
			const rect = el.getBoundingClientRect();
			const mark = document.createElement("div");
			mark.style.cssText = "position:fixed;left:" + (rect.x - 2) + "px;top:" + (rect.y - 2) + "px;width:" + (rect.width + 4) + "px;height:" + (rect.height + 4) + "px;border:2px solid rgba(245,158,11,.9);border-radius:3px;";
			const tag = document.createElement("span");
			tag.textContent = ref;
			tag.style.cssText = "position:absolute;top:-14px;left:-2px;padding:0 4px;border-radius:2px;background:rgba(245,158,11,.95);color:#1f2937;font:600 10px/13px ui-monospace,monospace;";
			mark.appendChild(tag);
			overlay.appendChild(mark);
		}
		if (overlay.childNodes.length > 0) {
			(document.body || document.documentElement).appendChild(overlay);
			setTimeout(() => { overlay.style.opacity = "0"; }, 40);
			setTimeout(() => { const stale = document.getElementById(id); if (stale) stale.remove(); }, 2500);
		}
		return true;
	})()`;
}

export function buildFallbackScrollExpression(deltaX: number, deltaY: number): string {
	return `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)}), true`;
}

export function buildFallbackKeyExpression(key: string): string {
	return `(() => { const el = document.activeElement || document.body; if (!el) return false; el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true })); el.dispatchEvent(new KeyboardEvent("keyup", { key: ${JSON.stringify(key)}, bubbles: true })); return true; })()`;
}
