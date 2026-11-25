import { writeClipboardImage } from "./clipboard";

/**
 * 「复制为图片」导出链路的共用预处理（单轮复制 + 多选分享）。
 *
 * 两个必须绕过 html-to-image 的地方（issue #601）：
 *
 * 1. **字号被改写**。html-to-image 在复制 computed style 时对 font-size 有一个硬编码补丁
 *    （dist 里 `if (name === "font-size" && value.endsWith("px")) value = Math.floor(px) - 0.1 + "px"`，
 *    用来规避 foreignObject 里文字被裁）。于是 16.5px 正文在导出图里变成 15.9px（Chrome 序列化时
 *    又把它折叠进 `font` 简写），整段拉丁文的字宽等比收缩，单词间距与屏幕上不一致。
 *    解决方式是把 "font-size" 从 includeStyleProperties 里摘掉（html-to-image 就不会再写它），
 *    同时我们自己把每个元素的计算字号固化成 inline style——inline 样式会跟着内部 clone 进图，
 *    且不会再被那段补丁 floor 一遍。子节点逐个固化而不是只钉根节点：字号来源是逐元素的
 *    （正文/代码/行末元信息各不同），靠继承拿不回来。
 *    ⚠️ includeStyleProperties 在 html-to-image 内部是**模块级缓存**（首次调用的列表生效），
 *    所以本项目所有 html-to-image 调用点必须都走本模块；否则谁先不带这列表跑一步，导出的字号
 *    就会静默退回 15.9px。tests/exportImageCopy.test.mjs 针对这一点做了调用点扫描。
 *
 *    字距另加一道 text-rendering: geometricPrecision（同样逐元素设置，不能只设根节点：
 *    复制循环会把每个子节点的 text-rendering 写成 computed 值 auto，根上的继承被打掉）。
 *
 * 2. **折叠态泄漏**。执行过程折叠栏（.execution-summary）连同其展开内容会被一起截进图里：
 *    同一轮在展开与收起两种状态导出两张不同的图，展开态还会把整张图拉长、底部留大片空白。
 *    导出内容必须与折叠态无关，所以克隆阶段就把整个折叠栏摘掉（而不是只靠 filter 让她不入图——
 *    filter 只作用于内部 clone，画布尺寸仍按含折叠栏的克隆量，白边就是这么来的）。
 *    这是产品决策、**不提供「包含执行过程」开关**（2026-11 与产品确认）：同一轮的图要可复现，
 *    不能取决于点复制那一刻折叠栏开着还是关着；需要过程内容时用多选逐条选。
 */

/** 导出时整体摘掉的子树：交互态 UI 与可折叠的执行过程，都不属于「这轮回复长什么样」。 */
export const EXPORT_EXCLUDED_SELECTORS = [".execution-summary", ".turn-row-actions", ".user-turn-actions", ".copy-menu-popover"] as const;

type ClassListLike = { contains?: (token: string) => boolean };

function classListOf(node: unknown): ClassListLike | null {
	const list = (node as { classList?: ClassListLike } | null | undefined)?.classList;
	return list && typeof list.contains === "function" ? list : null;
}

/** 该节点是否整体排除在导出图之外（文本节点等无 classList 的节点一律保留）。 */
export function isExportExcludedNode(node: unknown): boolean {
	const list = classListOf(node);
	if (!list) return false;
	return EXPORT_EXCLUDED_SELECTORS.some((selector) => list.contains?.(selector.slice(1)) ?? false);
}

/**
 * html-to-image 的 filter：返回 false 的节点既不进图也不进遍历。
 * 与 prepareExportClone 的摘除重复是刻意的：filter 是最后一道闸（例如运行期才插入的子树）。
 */
export function exportImageFilter(node: unknown): boolean {
	return !isExportExcludedNode(node);
}

/**
 * html-to-image 的 includeStyleProperties：documentElement 的全部计算属性 **去掉 font-size**。
 * 传 undefined 会让它走默认列表（含 font-size），字号就被那段 `floor - 0.1` 补丁改掉了。
 */
export function exportIncludeStyleProperties(properties?: Iterable<string>): string[] {
	const source = properties ?? getDocumentStyleProperties();
	return Array.from(source).filter((name) => name !== "font-size");
}

function getDocumentStyleProperties(): string[] {
	// 只读一次：html-to-image 的默认口径同样是「documentElement 的计算属性全集」。
	if (typeof document === "undefined") return [];
	return Array.from(window.getComputedStyle(document.documentElement));
}

/**
 * 把克隆子树的排版固化成 inline 样式：逐元素钉住计算字号 + geometricPrecision。
 *
 * 必须在克隆已挂到文档里之后调用（否则 getComputedStyle 拿不到真实字号）。
 * `readStyle` 只为测试可注入，生产一律走 getComputedStyle。
 */
export function pinExportTypography(clone: HTMLElement, readStyle: (element: HTMLElement) => { fontSize: string } = (element) => window.getComputedStyle(element)): void {
	const nodes: HTMLElement[] = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("*"))];
	for (const node of nodes) {
		const { fontSize } = readStyle(node);
		if (fontSize) node.style.fontSize = fontSize;
		node.style.textRendering = "geometricPrecision";
	}
}

/**
 * 导出前的克隆统一处理：摘掉不该进图的子树 → 固化排版。
 * 调用时机：克隆已插入文档（同位置或 body 下均可），且在 toBlob 之前。
 * `readStyle` 只为测试可注入，生产一律走 getComputedStyle。
 */
export function prepareExportClone(clone: HTMLElement, readStyle?: (element: HTMLElement) => { fontSize: string }): void {
	for (const selector of EXPORT_EXCLUDED_SELECTORS) {
		for (const node of Array.from(clone.querySelectorAll(selector))) node.remove();
	}
	pinExportTypography(clone, readStyle);
}

/**
 * 单轮「复制为图片」：克隆 → 内边距/底色 → 摘除折叠栏与操作栏 → 固化排版 → 写剪贴板。
 *
 * 克隆节点 + 内边距 + 临时注入 body 的方式与多选分享保持一致，避免直接截图导致图片
 * 紧贴内容边缘、缺少留白。html-to-image 按需加载：只有点「复制为图片」才拉这个包。
 */
export async function copyElementAsPng(element: HTMLElement): Promise<void> {
	// 使用 toBlob 而非 toPng+fetch 避免 CSP 拒绝连接 data: URL。
	const clone = element.cloneNode(true) as HTMLElement;
	clone.style.padding = "24px";
	clone.style.background = getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || "#fff";
	// 将 clone 插入到原元素旁边，确保 CSS 样式正确继承（父层选择器、CSS 变量、rem 等）
	if (element.parentElement) {
		// 克隆节点不能参与原布局，否则插入时会短暂撑开时间线导致闪动。
		// 复用多选分享的隐藏方式（.multi-select-image-export：absolute + left/top 归零 + z-index:-1）：
		// absolute 脱离文档流、不撑开布局；不能用 left:-100000px 把节点推出视口——
		// html-to-image 会把 clone 的 computed style 复制进 SVG foreignObject，负偏移会让
		// 内容整体渲染到 viewBox 之外，导致截图空白（「复制为图片空白」的根因）。
		clone.classList.add("multi-select-image-export");
		clone.style.width = `${element.getBoundingClientRect().width}px`;
		element.parentElement.insertBefore(clone, element.nextSibling);
	}
	// cacheBust 只给单轮复制：它重截同一个元素，资源可能刚变；多选分享保持共享缓存。
	await captureExportClone(clone, { cacheBust: true, label: "message" });
}

/**
 * 多选「分享为图片」：克隆 .message-list、只留选中项（含虚拟化包装层），再走同一套导出预处理。
 *
 * 只认 dataset.messageId 会把虚拟化包装 div 全判成「未选中」删掉（导出空白图）：
 * 这类包装层没有 data-message-id，唯一 id 落在 data-solid-run-id / data-virtual-run-id 上。
 */
export async function copySelectedMessagesAsPng(source: HTMLElement, captureIds: ReadonlySet<string>): Promise<void> {
	const clone = source.cloneNode(true) as HTMLElement;
	for (const item of Array.from(clone.children)) {
		if (!(item instanceof HTMLElement)) continue;
		const id = item.dataset.messageId ?? item.dataset.solidRunId ?? item.dataset.virtualRunId;
		if (!id || !captureIds.has(id)) item.remove();
	}
	clone.classList.add("multi-select-image-export");
	clone.style.width = `${Math.max(source.clientWidth, source.scrollWidth)}px`;
	clone.style.padding = "24px";
	clone.style.background = getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || "#fff";
	document.body.appendChild(clone);
	await captureExportClone(clone, { cacheBust: false, label: "selected messages" });
}

/** 克隆已就位：摘折叠栏/操作栏 → 固化字号 → 出图 → 写剪贴板。两条导出路径的最后一段。 */
async function captureExportClone(clone: HTMLElement, options: { cacheBust: boolean; label: string }): Promise<void> {
	let blob: Blob | null = null;
	try {
		prepareExportClone(clone);
		const { toBlob } = await import("html-to-image");
		blob = await toBlob(clone, {
			cacheBust: options.cacheBust,
			pixelRatio: Math.min(2, window.devicePixelRatio || 1),
			backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || undefined,
			includeStyleProperties: exportIncludeStyleProperties(),
			filter: exportImageFilter,
		});
	} finally {
		clone.remove();
	}
	// html-to-image 在 oklch / canvas / 失焦时可能返回 null 且不抛错；
	// 这里必须失败给调用方，否则 CopyMenu 会 toast「已复制」但剪贴板是空的。
	if (!blob) throw new Error(`Unable to capture ${options.label} as PNG`);
	const written = await writeClipboardImage(blob);
	if (!written) throw new Error("Unable to write PNG to clipboard");
}
