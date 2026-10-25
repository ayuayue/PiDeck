/**
 * 拖拽影像（drag image）工厂：原生 DnD 的默认影像是被拖的那个小按钮（⠿ 手柄图标十几像素），
 * 拖起来不知道自己拿着什么。克隆整行当影像——贴上卡片同款底色/边框/投影，视觉上
 * 「手里拿着这一行」。供应商卡片 / 快捷消息 / 回复快捷操作三处共用同一份样式。
 *
 * 生命周期约定：本函数把影像节点挂到 body，调用方拿住返回的 node，在 dragend /
 * 弹框关闭 / 组件卸载时 remove——Chromium 在整个拖动期间引用该节点截图，提前移除影像会失效。
 *
 * tr 特例：表格行脱离 table 上下文无法渲染（单元格排版丢失），克隆后包一层 table/tbody 还原；
 * 列宽定义在原表的 colgroup 上、不随 tr 克隆，逐个单元格把实际宽度快照成内联样式。
 * input/select 的当前值是 DOM property 而非 attribute，cloneNode 拷不走，逐个回填影像才有内容。
 */
export function createDragGhost(source: HTMLElement): { node: HTMLDivElement; x: number; y: number } {
	const rect = source.getBoundingClientRect();
	const clone = source.cloneNode(true) as HTMLElement;
	clone.classList.remove("cursor-pointer");
	if (clone instanceof HTMLTableRowElement && source instanceof HTMLTableRowElement) {
		for (let i = 0; i < source.cells.length && i < clone.cells.length; i++) {
			clone.cells[i].style.width = `${source.cells[i].getBoundingClientRect().width}px`;
		}
	}
	const sourceInputs = source.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select");
	const cloneInputs = clone.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select");
	sourceInputs.forEach((input, index) => {
		const target = cloneInputs[index];
		if (!target) return;
		if (target instanceof HTMLSelectElement) target.selectedIndex = input instanceof HTMLSelectElement ? input.selectedIndex : 0;
		else target.value = input.value;
	});
	const node = document.createElement("div");
	node.style.cssText = `position:fixed;top:-9999px;left:-9999px;width:${rect.width}px;pointer-events:none;border-radius:8px;border:1px solid var(--color-border-subtle);background:var(--color-bg-panel);box-shadow:0 12px 28px rgb(0 0 0 / 0.28);`;
	if (clone instanceof HTMLTableRowElement) {
		const table = document.createElement("table");
		const tbody = document.createElement("tbody");
		tbody.appendChild(clone);
		table.appendChild(tbody);
		node.appendChild(table);
	} else {
		node.appendChild(clone);
	}
	document.body.appendChild(node);
	// 影像锚点：横向落在手柄附近、纵向取行高中线——整行「握」在指针右下方，而不是被指针完全盖住。
	return { node, x: 24, y: rect.height / 2 };
}
