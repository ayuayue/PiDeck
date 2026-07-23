import {
	forwardRef,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";

/**
 * RichInput —— contentEditable 输入区，替代 textarea。
 *
 * 架构原则（React Issue #2047 — contentEditable 不应做受控组件）：
 * - 浏览器通过 contentEditable 自主管理文本节点和光标，React 零干预。
 * - Chip（@file、/command、&session）是挂在文本节点之间的装饰层，由 React 局部维护。
 * - 仅在 chip 真正变化时，对受影响的文本节点做最小拆分/合并，其余文本节点和光标不受影响。
 * - 外部程序化变更（建议选择、历史恢复、发送清空）触发全量 DOM 重建，此时不处于用户打字状态。
 *
 * 已处理的边界：
 * 1. IME 中文：composition 期间锁定，不回写 value、不触发 onChange。
 * 2. Chip 同步：diff 新旧 chip，局部拆分文本节点插入/移除 span，不重建整个 DOM。
 * 3. 粘贴：只取纯文本，防止富文本污染。
 * 4. 换行：Enter 未被上层 consume 时让浏览器原生处理，随后 input 事件同步 value。
 * 5. 光标在 chip 内部：contenteditable=false 阻止浏览器进入，无需额外处理。
 */

// ── 类型 ──────────────────────────────────────────────────

export type RichInputChip = {
	start: number;
	end: number;
	raw: string;
	kind: "file" | "skill" | "session";
	label: string;
};

export type RichInputProps = {
	value: string;
	onChange: (value: string, cursor: number) => void;
	onCursorChange: (cursor: number) => void;
	onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
	onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
	onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
	onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
	onFocus?: (event: React.FocusEvent<HTMLDivElement>) => void;
	onBlur?: (event: React.FocusEvent<HTMLDivElement>) => void;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
	/** 受控重渲染后光标应恢复到的纯文本偏移（非 null 时优先于 DOM 当前光标） */
	caretRef?: React.MutableRefObject<number | null>;
	/** chip 点击回调，传递被点击 chip 的解析信息 */
	onChipClick?: (chip: RichInputChip) => void;
	/** 有效命令名集合，白名单：不在集合内的 / 命令不渲染 chip */
	validCommandNames?: Set<string>;
	/** 有效文件路径集合，白名单：不在集合内的 @ 引用不渲染 chip */
	validFilePaths?: Set<string>;
	validSessionRefs?: Set<string>;
};

type TextNodeRun = {
	node: Text;
	start: number;
	end: number;
};

// ── Token 解析 ────────────────────────────────────────────

/** 提取文本中所有 URL 区间，后续 chip 解析跳过这些区间。 */
function findUrlSpans(text: string): { start: number; end: number }[] {
	const urlRe = /https?:\/\/\S+/g;
	const spans: { start: number; end: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = urlRe.exec(text)) !== null) {
		spans.push({ start: m.index, end: m.index + m[0].length });
	}
	return spans;
}

/** 判断区间是否与任一 URL 区间重叠（含部分重叠）。 */
function overlapsUrl(
	start: number,
	end: number,
	urlSpans: { start: number; end: number }[],
): boolean {
	return urlSpans.some((s) => start < s.end && end > s.start);
}

/**
 * 将 prompt 字符串解析为 chip 列表（展示层，与 detectTrigger 规则对齐）。
 *
 * 规则：
 * - /skill 触发符 / 前一个字符不能是 : / 或字母/数字/下划线（\w），
 *   避免路径段（如 Agent/PiDeck、a/b）被误识别。
 * - @path 触发符 @ 前同样排除 : / 和 \w。
 * - /skill：skill 名只允许字母开头 + 字母数字/连字符（skill 命名规范），
 *   且 token 后一字符不能是 /（排除 /usr/bin 这类路径）。
 * - @path：路径内允许 / . _ -，不允许空白与 @。
 *
 * URL 中的路径段（如 https://example.com/foo）不会被识别为 chip。
 */
export function parseRichInputChips(
	text: string,
	validCommandNames?: Set<string>,
	validFilePaths?: Set<string>,
	validSessionRefs?: Set<string>,
): RichInputChip[] {
	const chips: RichInputChip[] = [];
	const urlSpans = findUrlSpans(text);

	// /skill：前置排除 : / 和 \w（字母/数字/下划线），避免路径段误识别；slash 命令整体 = 命令名 + 可选的 :参数名（如 /skill:writing-plans、/template:doc）。
	// 冒号后须字母开头 + 字母数字/连字符，避免匹配 /a:b:c 这种异常文本。
	// 后一字符若为 /，说明是路径（如 /usr/bin），不当作 skill。
	// 名称支持 Unicode 字母（中文、日文等），使用 \p{L} + u flag。
	const slashRe = /(?<![:/.\w#!~])(\/[\p{L}][\p{L}\p{N}_-]*(?::[\p{L}][\p{L}\p{N}_-]*)?)/gu;
	let m: RegExpExecArray | null;
	while ((m = slashRe.exec(text)) !== null) {
		const start = m.index;
		const end = start + m[1].length;
		if (text[end] === "/") continue;
		if (!overlapsUrl(start, end, urlSpans)) {
			const label = m[1].slice(1);
			if (!validCommandNames || validCommandNames.has(label)) {
				chips.push({ start, end, raw: m[1], kind: "skill", label });
			}
		}
		if (m.index === slashRe.lastIndex) slashRe.lastIndex++;
	}

	// @path：前置排除 : / 和 \w；必须像文件路径（含 /、\\ 或 .），避免普通 @mention 被误渲染成不可编辑 chip。
	const atRe = /(?<![:/.\w#!~])(@[^\s@]+)/g;
	while ((m = atRe.exec(text)) !== null) {
		const start = m.index;
		const end = start + m[1].length;
		if (!overlapsUrl(start, end, urlSpans)) {
			const seg = m[1].slice(1);
			if (!/[\\/.]/.test(seg)) continue;
			const normalized = seg.replace(/\\/g, "/");
			// 路径白名单检查：去掉 ./ 前缀后校验文件是否存在
			const pathKey = normalized.startsWith("./") ? normalized.slice(2) : normalized;
			if (validFilePaths && !validFilePaths.has(pathKey)) continue;
			const label = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
			chips.push({ start, end, raw: m[1], kind: "file", label: label || seg });
		}
		if (m.index === atRe.lastIndex) atRe.lastIndex++;
	}

	// &session：捕获 & 后到换行/末尾的全部文本，再从白名单中按前缀匹配出会话名。
	// 白名单优先（取最长匹配），无白名单时取第一个空格前的单词。会话名可包含 &
	const ampRe = /(?<![:/.#!~?=&])(&[^\n]+)/gu;
	while ((m = ampRe.exec(text)) !== null) {
		const start = m.index;
		const captured = m[1].slice(1);
		let name = "";
		if (validSessionRefs && validSessionRefs.size > 0) {
			for (const ref of validSessionRefs) {
				if (captured === ref || captured.startsWith(ref + " ")) {
					if (ref.length > name.length) name = ref;
				}
			}
		}
		if (!name) {
			name = captured.split(/\s/)[0] ?? "";
		}
		if (!name) { if (m.index === ampRe.lastIndex) ampRe.lastIndex++; continue; }
		const raw = `&${name}`;
		const end = start + raw.length;
		if (!overlapsUrl(start, end, urlSpans)) {
			chips.push({ start, end, raw, kind: "session", label: name });
		}
		if (m.index === ampRe.lastIndex) ampRe.lastIndex++;
	}

	// 去重叠：保留先出现的，剔除被包含的
	chips.sort((a, b) => a.start - b.start || b.end - a.end);
	const merged: RichInputChip[] = [];
	let coverEnd = -1;
	for (const c of chips) {
		if (c.start >= coverEnd) { merged.push(c); coverEnd = c.end; }
	}
	return merged;
}

// ── DOM 扁平文本模型 ──────────────────────────────────────

/**
 * 遍历 contentEditable root 的「纯文本模型」。
 * 按文档序依次回调每个文本段和 chip，自动跳过 chip 内部（contenteditable=false）。
 * onBreak 在遇到 <br> 或浏览器粘贴产生的块级分隔时回调，供调用方在纯文本中插入换行符。
 */
function walkFlat(
	root: HTMLElement,
	onText: (node: Text, start: number, end: number) => void,
	onChip: (el: HTMLElement, start: number, end: number) => void,
	onBreak?: (start: number, end: number) => void,
): void {
	let offset = 0;
	let lastWasBreak = false;
	const blockTags = new Set(["DIV", "P", "LI"]);
	function appendBreak(): void {
		onBreak?.(offset, offset + 1);
		offset += 1;
		lastWasBreak = true;
	}
	function visit(node: Node): void {
		if (node.nodeType === Node.TEXT_NODE) {
			const value = node.nodeValue ?? "";
			const len = value.length;
			onText(node as Text, offset, offset + len);
			offset += len;
			if (len > 0) lastWasBreak = value.endsWith("\n") || value.endsWith("\r");
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const el = node as HTMLElement;
			if (el.getAttribute("contenteditable") === "false") {
				const rawLen = el.getAttribute("data-raw")?.length ?? 0;
				onChip(el, offset, offset + rawLen);
				offset += rawLen;
				if (rawLen > 0) lastWasBreak = false;
			} else if (el.tagName === "BR") {
				appendBreak();
			} else {
				const isBlock = blockTags.has(el.tagName);
				// contentEditable 粘贴多行时常生成 <div>/<p> 块而不是文本节点中的 \n；
				// 块前补一个分隔即可保留用户原始换行，同时避免连续块/BR 叠加出多余空行。
				if (isBlock && offset > 0 && !lastWasBreak) appendBreak();
				node.childNodes.forEach(visit);
			}
		}
	}
	root.childNodes.forEach(visit);
}

/** 计算单节点子树的纯文本长度（用于 getCaretOffset 元素节点分支）。 */
function nodeFlatLength(node: Node): number {
	if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.length ?? 0;
	const el = node as HTMLElement;
	if (el.getAttribute?.("contenteditable") === "false") return el.getAttribute("data-raw")?.length ?? 0;
	if (el.tagName === "BR") return 1;
	let len = 0;
	node.childNodes.forEach((c) => { len += nodeFlatLength(c); });
	return len;
}

/** 收集所有文本节点运行列表，用于偏移 → DOM 位置转换。 */
function collectTextRuns(root: HTMLElement): TextNodeRun[] {
	const runs: TextNodeRun[] = [];
	walkFlat(root, (node, s, e) => runs.push({ node, start: s, end: e }), () => {});
	return runs;
}

/**
 * 从 DOM 读取纯文本（chip 用 data-raw 还原）。
 * 注意：浏览器可能将 contentEditable 中的 \n 存为 \r\n 或 <br>，
 * 这里统一将 \r\n 和 \r 归一化为 \n，确保发送的纯文本使用一致换行符。
 */
function collectFlatText(root: HTMLElement): string {
	let text = "";
	walkFlat(
		root,
		(node) => { text += (node.nodeValue ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n"); },
		(el) => { text += el.getAttribute("data-raw") ?? ""; },
		() => { text += "\n"; },
	);
	return text;
}

/** 从 DOM 收集所有 chip 元素及其纯文本区间。 */
function collectChipRanges(root: HTMLElement): { start: number; end: number }[] {
	const chips: { start: number; end: number }[] = [];
	walkFlat(root, () => {}, (_el, s, e) => chips.push({ start: s, end: e }));
	return chips;
}

/** 纯文本偏移 → DOM Range 定位。 */
function resolveOffset(
	runs: TextNodeRun[],
	offset: number,
): { node: Node; offset: number } | null {
	if (runs.length === 0) return null;
	for (const run of runs) {
		if (offset >= run.start && offset <= run.end) {
			return { node: run.node, offset: offset - run.start };
		}
	}
	const last = runs[runs.length - 1];
	return { node: last.node, offset: last.node.nodeValue?.length ?? 0 };
}

/** 将光标放置在给定的 DOM 位置。 */
function placeCaretAt(pos: { node: Node; offset: number }): void {
	const sel = window.getSelection();
	if (!sel) return;
	sel.removeAllRanges();
	const r = document.createRange();
	r.setStart(pos.node, pos.offset);
	r.collapse(true);
	sel.addRange(r);
}

function insertPlainTextAtSelection(root: HTMLElement, text: string): void {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0 || !root.contains(sel.getRangeAt(0).commonAncestorContainer)) {
		root.appendChild(document.createTextNode(text));
		return;
	}
	const range = sel.getRangeAt(0);
	range.deleteContents();
	const node = document.createTextNode(text);
	range.insertNode(node);
	range.setStartAfter(node);
	range.collapse(true);
	sel.removeAllRanges();
	sel.addRange(range);
}

// ── 公共光标 API ──────────────────────────────────────────

/** 获取当前光标在 root 中的纯文本偏移。 */
export function getCaretOffset(root: HTMLElement): number {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return 0;
	const range = sel.getRangeAt(0);
	if (!root.contains(range.startContainer)) return 0;

	// 文本节点：直接通过 run 定位
	if (range.startContainer.nodeType === Node.TEXT_NODE) {
		const runs = collectTextRuns(root);
		for (const run of runs) {
			if (run.node === range.startContainer) {
				return run.start + Math.min(range.startOffset, run.node.nodeValue?.length ?? 0);
			}
		}
		return 0;
	}

	// 元素节点（光标在 chip 之间或边界）：按子节点索引累加长度
	const el = range.startContainer as HTMLElement;
	if (el === root || root.contains(el)) {
		const children = Array.from(el.childNodes);
		const idx = Math.min(range.startOffset, children.length);
		let acc = 0;
		for (let i = 0; i < idx; i++) acc += nodeFlatLength(children[i]);
		return acc;
	}
	return 0;
}

/** 命令式将光标恢复到指定纯文本偏移（供建议选中后恢复选区）。 */
export function setRichInputCaret(root: HTMLElement, offset: number): void {
	const runs = collectTextRuns(root);
	const pos = resolveOffset(runs, Math.min(offset, collectFlatText(root).length));
	if (pos) placeCaretAt(pos);
}

/** 计算光标的屏幕坐标，用于菜单锚定。 */
export function getRichInputCaretCoords(
	root: HTMLElement,
	offset: number,
): { top: number; left: number } {
	const runs = collectTextRuns(root);
	const pos = resolveOffset(runs, offset);
	if (!pos) {
		const rect = root.getBoundingClientRect();
		return { top: rect.top, left: rect.left };
	}
	const range = document.createRange();
	range.setStart(pos.node, pos.offset);
	range.collapse(true);
	const rect = range.getBoundingClientRect();
	if (rect.top === 0 && rect.left === 0) {
		const r = root.getBoundingClientRect();
		return { top: r.top, left: r.left };
	}
	return { top: rect.top, left: rect.left };
}

// ── Chip DOM 操作（局部修补，不重建整个 DOM） ──────────────

/** 创建一个 chip span 元素（不含文本，文本由相邻文本节点承载）。 */
function createChipSpan(chip: RichInputChip): HTMLSpanElement {
	const span = document.createElement("span");
	span.setAttribute("contenteditable", "false");
	span.setAttribute("data-type", chip.kind);
	span.setAttribute("data-raw", chip.raw);
	span.title = chip.raw;
	span.className = `input-chip input-chip--${chip.kind}`;

	const icon = document.createElement("span");
	icon.className = "input-chip__icon";
	icon.textContent = chip.kind === "file" ? "@" : chip.kind === "session" ? "&" : "/";
	const label = document.createElement("span");
	label.className = "input-chip__label";
	label.textContent = chip.label;
	if (icon.textContent) span.appendChild(icon);
	span.appendChild(label);
	return span;
}

/**
 * 在 root 的指定文本偏移处插入 chip span。
 * 拆分覆盖 [chip.start, chip.end) 的文本节点，
 * 将中间的文本段替换为 chip span（文本不变，chip.raw 承载对应字符语义）。
 */
function insertChipSpan(root: HTMLElement, chip: RichInputChip): void {
	const runs = collectTextRuns(root);

	// 定位 chip.start 所在的文本运行
	let startRun: TextNodeRun | null = null;
	let startRunIdx = -1;
	for (let i = 0; i < runs.length; i++) {
		const r = runs[i];
		if (chip.start >= r.start && chip.start < r.end) {
			startRun = r;
			startRunIdx = i;
			break;
		}
	}
	if (!startRun) return;

	// 拆分第一个文本节点：chip.start 处
	const offsetInStart = chip.start - startRun.start;
	const afterStart = startRun.node.splitText(offsetInStart);

	// 定位 chip.end 所在的文本运行（拆分后重新收集，因为 DOM 已变）
	const runsAfterSplit = collectTextRuns(root);
	let endRun: TextNodeRun | null = null;
	for (const r of runsAfterSplit) {
		if (chip.end > r.start && chip.end <= r.end) {
			endRun = r;
			break;
		}
	}
	if (!endRun) return;

	// 拆分 chip.end 处
	const offsetInEnd = chip.end - endRun.start;
	const afterEnd = endRun.node.splitText(offsetInEnd);

	// 收集 chip 区间内的文本节点（在 start 拆分后的第二个节点到 end 拆分的第一个节点之间）
	const chipTextNodes: Text[] = [];
	walkFlat(root, (node, s) => {
		if (s >= chip.start && s < chip.end && node.nodeValue != null) {
			chipTextNodes.push(node);
		}
	}, () => {});

	// 移除 chip 区间内的文本节点，用 chip span 替代
	const span = createChipSpan(chip);
	if (chipTextNodes.length > 0) {
		const firstText = chipTextNodes[0];
		firstText.parentNode!.insertBefore(span, firstText);
		for (const tn of chipTextNodes) {
			if (tn.parentNode) tn.parentNode.removeChild(tn);
		}
	}
}

/**
 * 收集 DOM 中所有 chip 元素的映射：{el, start, end, raw, kind}。
 */
function collectChipEntries(root: HTMLElement): Array<{
	el: HTMLElement;
	start: number;
	end: number;
	raw: string;
	kind: string;
}> {
	const entries: Array<{ el: HTMLElement; start: number; end: number; raw: string; kind: string }> = [];
	walkFlat(
		root,
		() => {},
		(el, s, e) => {
			entries.push({
				el,
				start: s,
				end: e,
				raw: el.getAttribute("data-raw") ?? "",
				kind: el.getAttribute("data-type") ?? "",
			});
		},
	);
	return entries;
}

/**
 * 将 chip span 还原为纯文本节点（用 data-raw 内容替换 span），
 * 并合并相邻文本节点，保持 DOM 扁平。
 *
 * 注意：合并时会 removeChild 相邻文本节点。调用方应在操作前后
 * 保存/恢复光标（参考 syncChipsToDom）。
 */
function unwrapChipSpan(el: HTMLElement): void {
	const raw = el.getAttribute("data-raw") ?? "";
	const textNode = document.createTextNode(raw);
	const parent = el.parentNode;
	if (!parent) return;

	// 先收集相邻文本节点引用和内容（在 DOM 变更前完成，避免引用失效）
	const prevText: Text | null =
		el.previousSibling?.nodeType === Node.TEXT_NODE
			? (el.previousSibling as Text)
			: null;
	const nextText: Text | null =
		el.nextSibling?.nodeType === Node.TEXT_NODE
			? (el.nextSibling as Text)
			: null;

	// 插入新文本节点，移除 chip span
	parent.insertBefore(textNode, el);
	parent.removeChild(el);

	// 将相邻文本内容转移到新节点，再移除旧节点。
	// 内容转移在前、节点移除在后，确保纯文本始终不丢失。
	if (prevText) {
		textNode.textContent = prevText.textContent + textNode.textContent;
		parent.removeChild(prevText);
	}
	if (nextText) {
		textNode.textContent += nextText.textContent;
		parent.removeChild(nextText);
	}
}

/**
 * 局部同步 chip span：diff 当前 DOM 中的 chip 与期望 chip，
 * 仅移除/新增/更新变化的 chip span，不触碰任何文本节点内容。
 *
 * 关键：chip 的增删会拆分/合并文本节点，可能使浏览器 Selection 丢失。
 * 因此在操作前缓存光标偏移，操作后恢复，确保光标不漂移。
 */
function syncChipsToDom(root: HTMLElement, desiredChips: RichInputChip[]): void {
	// 缓存光标偏移：DOM 操作（splitText / removeChild / 合并相邻文本节点）
	// 会破坏浏览器原生光标位置，必须在操作前保存、操作后恢复。
	const savedCaret = getCaretOffset(root);

	const existingEntries = collectChipEntries(root);

	// 双指针 diff（两者均按 start 升序）
	const toRemove: typeof existingEntries = [];
	const toAdd: RichInputChip[] = [];
	let ei = 0;
	let di = 0;

	while (ei < existingEntries.length || di < desiredChips.length) {
		const existing = existingEntries[ei];
		const desired = desiredChips[di];

		if (!existing) {
			toAdd.push(desired);
			di++;
		} else if (!desired) {
			toRemove.push(existing);
			ei++;
		} else if (existing.start === desired.start && existing.end === desired.end) {
			// 位置相同：仅属性变化时原地更新 span
			if (existing.raw !== desired.raw || existing.kind !== desired.kind) {
				const newSpan = createChipSpan(desired);
				existing.el.parentNode!.replaceChild(newSpan, existing.el);
			}
			ei++;
			di++;
		} else if (existing.start < desired.start) {
			toRemove.push(existing);
			ei++;
		} else {
			toAdd.push(desired);
			di++;
		}
	}

	// 先逆向移除旧的 chip（避免索引偏移影响后续插入）
	for (let i = toRemove.length - 1; i >= 0; i--) {
		unwrapChipSpan(toRemove[i].el);
	}

	// 再按文本偏移顺序插入新的 chip
	for (const chip of toAdd) {
		insertChipSpan(root, chip);
	}

	// 恢复光标到 DOM 操作前的位置。纯文本模型在 chip 增删前后保持一致
	// （chip.raw === 被替换的文本内容），因此 savedCaret 仍然有效。
	setRichInputCaret(root, savedCaret);
}

// ── RichInput 组件 ────────────────────────────────────────

export const RichInput = forwardRef<HTMLDivElement, RichInputProps>(
	function RichInput(props, ref) {
		const {
			value, onChange, onCursorChange, onKeyDown,
			onPaste, onDrop, onDragOver, onFocus, onBlur,
			disabled, placeholder, className, caretRef,
			onChipClick, validCommandNames, validFilePaths,
			validSessionRefs,
		} = props;

		const rootRef = useRef<HTMLDivElement | null>(null);
		const composingRef = useRef(false);

		// contentEditable 先原生更新 DOM，再通过 input 事件回传最新值。
		// 保存最后一次 handleInput 捕获的原生文本与光标偏移，
		// 供外部变更检测和光标参考。
		const nativeInputValueRef = useRef<string | null>(null);
		const nativeInputCaretRef = useRef<number | null>(null);

		// 程序化 DOM 重建期间（rebuildDom），textContent 清空会触发 input 事件；
		// suppressInputRef 要求 handleInput 静默跳过，防止将空值写回上层形成反馈循环。
		const suppressInputRef = useRef(false);

		// 合并外部 ref 与内部 rootRef
		const setRef = useCallback(
			(node: HTMLDivElement | null) => {
				rootRef.current = node;
				if (typeof ref === "function") ref(node);
				else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
			},
			[ref],
		);

		const chips = useMemo(
			() => parseRichInputChips(value, validCommandNames, validFilePaths, validSessionRefs),
			[value, validCommandNames, validFilePaths, validSessionRefs],
		);

		/**
		 * 全量重建 DOM：仅在挂载或外部程序化变更时使用。
		 * 清空 root，按 value + chips 重建文本节点和 chip span，恢复光标。
		 *
		 * 注意：此函数通过 textContent="" 破坏性清空 DOM，
		 * 仅在用户不处于打字状态时调用（挂载、建议选择、发送清空等）。
		 */
		const rebuildDom = useCallback(
			(restoreCaret?: number | null) => {
				const root = rootRef.current;
				if (!root) return;

				// 缓存光标优先级：显式传入 > handleInput 按键瞬间记录 > 当前 DOM 反推。
				// nativeInputCaretRef 在 handleInput 中于用户按键瞬间同步记录，
				// 不受后续浏览器 DOM 规范化（合并文本节点、拼写检查标记等）影响，
				// 是打字场景下最准确的光标来源。
				const caret = restoreCaret
					?? nativeInputCaretRef.current
					?? getCaretOffset(root);

				// 阻止清空触发的 input 事件污染上层
				suppressInputRef.current = true;
				root.textContent = "";
				suppressInputRef.current = false;

				// 清除 DOM 已重置后的输入快照（光标已缓存到 caret 变量）
				nativeInputValueRef.current = null;
				nativeInputCaretRef.current = null;

				let cursor = 0;
				for (const chip of chips) {
					if (chip.start > cursor) {
						root.appendChild(document.createTextNode(value.slice(cursor, chip.start)));
					}
					root.appendChild(createChipSpan(chip));
					cursor = chip.end;
				}
				if (cursor <= value.length) {
					root.appendChild(document.createTextNode(value.slice(cursor)));
				}

				// 恢复光标
				const runs = collectTextRuns(root);
				const pos = resolveOffset(runs, Math.min(caret, value.length));
				if (pos) placeCaretAt(pos);

				// 消费程序化光标标记
				if (caretRef) caretRef.current = null;
			},
			[value, chips, caretRef],
		);

		/**
		 * 三条同步路径，按优先级互斥：
		 *
		 * 1. caretRef 非空 → 外部程序化变更（建议选择、历史恢复）
		 *    执行全量 rebuildDom，光标由 caretRef 指定。
		 *
		 * 2. value 与 DOM 文本不一致 → 外部非打字变更（发送清空等）
		 *    执行全量 rebuildDom，光标尽可能保留。
		 *
		 * 3. chip 区间变化 → 浏览器的文本不变，仅 chip 装饰需更新
		 *    执行局部 syncChipsToDom，文本节点和光标不受影响。
		 *
		 * 4. 全部一致 → 不做任何 DOM 操作。
		 */
		useLayoutEffect(() => {
			const root = rootRef.current;
			if (!root) return;

			// Path 1：程序化变更
			const caretTarget = caretRef?.current;
			if (caretTarget != null) {
				rebuildDom(caretTarget);
				return;
			}

			// Path 2：外部文本变更（value 与 DOM 不一致，且非来自最近一次 handleInput）
			const nativeInputValue = nativeInputValueRef.current;
			const domText = collectFlatText(root);

			if (value !== domText) {
				// 如果 value 与 handleInput 刚回传的原生值一致，说明 React 正在确认用户输入，
				// 不做任何操作——DOM 已经是最新的，等待下一个 effect 清理 nativeInputValue 标记。
				if (nativeInputValue !== null && value === nativeInputValue) {
					nativeInputValueRef.current = null;
					nativeInputCaretRef.current = null;
					return;
				}
				// 否则是真正的「外部变更」：发送清空、建议恢复等 → 全量重建
				rebuildDom(null);
				return;
			}

			// Path 3：仅 chip 变化，文本不变 → 局部修补
			const existingRanges = collectChipRanges(root);
			const rangesSame =
				existingRanges.length === chips.length &&
				existingRanges.every((r, i) =>
					r.start === chips[i].start && r.end === chips[i].end,
				);

			if (!rangesSame) {
				suppressInputRef.current = true;
				syncChipsToDom(root, chips);
				suppressInputRef.current = false;
				return;
			}

			// Path 4：全部一致，无操作
			// 清理 handleInput 快照（上层已确认）
			if (nativeInputValue === value) {
				nativeInputValueRef.current = null;
				nativeInputCaretRef.current = null;
			}
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [value, chips]);

		// 挂载时首次渲染
		useLayoutEffect(() => {
			rebuildDom(null);
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);

		/** 用户输入后：从 DOM 读取纯文本 + 光标偏移，回写上层。 */
		const handleInput = useCallback(() => {
			if (composingRef.current) return;
			// rebuildDom / syncChipsToDom 期间的 input 事件应静默跳过
			if (suppressInputRef.current) return;
			const root = rootRef.current;
			if (!root) return;
			const nextValue = collectFlatText(root);
			const nextCaret = getCaretOffset(root);
			nativeInputValueRef.current = nextValue;
			nativeInputCaretRef.current = nextCaret;
			onChange(nextValue, nextCaret);
		}, [onChange]);

		/** 光标/选区变化：通知上层光标位置。 */
		const handleSelect = useCallback(() => {
			if (composingRef.current) return;
			// chip DOM 操作期间光标临时失效，跳过以避免传播错误偏移
			if (suppressInputRef.current) return;
			const root = rootRef.current;
			if (!root) return;
			onCursorChange(getCaretOffset(root));
		}, [onCursorChange]);

		/** 粘贴：图片交给上层处理，其余强制纯文本。 */
		const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
			if (onPaste) {
				const hasImage = Array.from(event.clipboardData.items).some(
					(i) => i.type.startsWith("image/"),
				);
				if (hasImage) { onPaste(event); return; }
			}
			event.preventDefault();
			const root = rootRef.current;
			if (!root) return;
			insertPlainTextAtSelection(root, event.clipboardData.getData("text/plain"));
			handleInput();
		};

		/** chip 点击：检测点击目标是否为 chip，是则回调上层 */
		const handleClick = useCallback(
			(event: React.MouseEvent<HTMLDivElement>) => {
				handleSelect();
				if (!onChipClick) return;
				const target = event.target as HTMLElement;
				const chip = target.closest?.(".input-chip") as HTMLElement | null;
				if (!chip) return;
				const raw = chip.getAttribute("data-raw");
				const kind = chip.getAttribute("data-type") as RichInputChip["kind"] | null;
				const label =
					chip.querySelector(".input-chip__label")?.textContent ??
					raw?.slice(1) ??
					"";
				if (raw && kind) {
					onChipClick({ start: 0, end: raw.length, raw, kind, label });
				}
			},
			[handleSelect, onChipClick],
		);

		/** Enter：上层未 consume（非发送）时，让浏览器原生处理换行，随后 input 事件同步 value。 */
		const handleKeyDown = useCallback(
			(event: React.KeyboardEvent<HTMLDivElement>) => {
				onKeyDown(event);
				if (event.defaultPrevented) return;

				if (event.key === "Enter") {
					// IME 合成期间只有 Shift+Enter 允许换行（跳过 IME 提交），
					// 普通 Enter 交给 IME 确认候选词，不插入 \n。
					if (composingRef.current && !event.shiftKey) return;
					// 不 preventDefault，让浏览器原生的 contentEditable Enter 行为
					// 处理换行（插入 <br> 并正确放置光标），随后触发 input 事件同步 value。
				}
			},
			[onKeyDown],
		);

		const handleCompositionStart = () => { composingRef.current = true; };
		const handleCompositionEnd = () => { composingRef.current = false; handleInput(); };

		const classNames = [
			"rich-input",
			disabled && "is-disabled",
			className,
		].filter(Boolean).join(" ");

		return (
			<div
				ref={setRef}
				className={classNames}
				contentEditable={!disabled}
				suppressContentEditableWarning
				role="textbox"
				aria-multiline="true"
				aria-disabled={disabled}
				data-placeholder={placeholder ?? ""}
				onInput={handleInput}
				onKeyDown={handleKeyDown}
				onKeyUp={handleSelect}
				onClick={handleClick}
				onFocus={onFocus}
				onBlur={onBlur}
				onPaste={handlePaste}
				onDrop={onDrop}
				onDragOver={onDragOver}
				onCompositionStart={handleCompositionStart}
				onCompositionEnd={handleCompositionEnd}
				onSelect={handleSelect}
			/>
		);
	},
);
