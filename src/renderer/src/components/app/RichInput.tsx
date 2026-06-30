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
 * 核心设计：
 * - 单一数据源：外部 value 字符串，chip 在字符串中以 @path / /command 内联表示。
 * - contentEditable 是受控渲染层：token 渲染为 contenteditable=false 的 chip span。
 * - 光标偏移统一用纯文本偏移，chip 贡献 data-raw 长度，与 textarea selectionStart 语义一致。
 *
 * 已处理的边界：
 * 1. IME 中文：composition 期间锁定，不回写 value、不触发 onChange。
 * 2. 受控回写：DOM 纯文本与 value 一致时跳过重渲染；不一致时渲染并恢复光标。
 * 3. 粘贴：只取纯文本，防止富文本污染。
 * 4. 换行：Enter 未被上层 consume 时手动插入 \n，保持 DOM 扁平。
 * 5. token 内编辑：光标在 token 内部时不 chip 化，允许继续输入。
 */

// ── 类型 ──────────────────────────────────────────────────

export type RichInputChip = {
	start: number;
	end: number;
	raw: string;
	kind: "file" | "skill";
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
 * 将 prompt 字符串解析为 chip 列表（展示层，比输入时的 detectTrigger 更严格）。
 *
 * 收紧规则（避免任意输入被误识别为引用）：
 * - 触发符 @ / 必须出现在行首或空白之后，
 *   这样 "a/b""user@host""hello/world" 等文本中的 / @ 不会被识别为 chip。
 * - /skill：skill 名只允许字母开头 + 字母数字/连字符（skill 命名规范），
 *   且 token 后一字符不能是 /（排除 /usr/bin 这类路径）。
 * - @path：路径内允许 / . _ -，不允许空白与 @。
 *
 * 注意：输入时唤出引用菜单的 detectTrigger 仍保留更宽松的前置（允许字母数字前插），
 * 因为那是交互层；这里只负责把最终文本里真正的引用片段渲染成 chip。
 * URL 中的路径段（如 https://example.com/foo）不会被识别为 chip。
 */
export function parseRichInputChips(text: string): RichInputChip[] {
	const chips: RichInputChip[] = [];
	const urlSpans = findUrlSpans(text);

	// /skill：前置行首或空白；slash 命令整体 = 命令名 + 可选的 :参数名（如 /skill:writing-plans、/template:doc）。
	// 冒号后须字母开头 + 字母数字/连字符，避免匹配 /a:b:c 这种异常文本。
	// 后一字符若为 /，说明是路径（如 /usr/bin），不当作 skill。
	const slashRe = /(^|\s)(\/[a-zA-Z][a-zA-Z0-9_-]*(?::[a-zA-Z][a-zA-Z0-9_-]*)?)/g;
	let m: RegExpExecArray | null;
	while ((m = slashRe.exec(text)) !== null) {
		const start = m.index + m[1].length;
		const end = start + m[2].length;
		if (text[end] === "/") continue;
		if (!overlapsUrl(start, end, urlSpans)) {
			chips.push({ start, end, raw: m[2], kind: "skill", label: m[2].slice(1) });
		}
		if (m.index === slashRe.lastIndex) slashRe.lastIndex++;
	}

	// @path：前置行首或空白；必须像文件路径（含 /、\\ 或 .），避免普通 @mention 被误渲染成不可编辑 chip。
	const atRe = /(^|\s)(@[^\s@]+)/g;
	while ((m = atRe.exec(text)) !== null) {
		const start = m.index + m[1].length;
		const end = start + m[2].length;
		if (!overlapsUrl(start, end, urlSpans)) {
			const seg = m[2].slice(1);
			if (!/[\\/.]/.test(seg)) continue;
			const normalized = seg.replace(/\\/g, "/");
			const label = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
			chips.push({ start, end, raw: m[2], kind: "file", label: label || seg });
		}
		if (m.index === atRe.lastIndex) atRe.lastIndex++;
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

/** 从 DOM 读取纯文本（chip 用 data-raw 还原）。 */
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

// ── RichInput 组件 ────────────────────────────────────────

export const RichInput = forwardRef<HTMLDivElement, RichInputProps>(
	function RichInput(props, ref) {
		const {
			value, onChange, onCursorChange, onKeyDown,
			onPaste, onDrop, onDragOver, onFocus, onBlur,
			disabled, placeholder, className, caretRef,
			onChipClick,
		} = props;

		const rootRef = useRef<HTMLDivElement | null>(null);
		const composingRef = useRef(false);
		const pendingCaretRef = useRef<number | null>(null);

		// 合并外部 ref 与内部 rootRef
		const setRef = useCallback(
			(node: HTMLDivElement | null) => {
				rootRef.current = node;
				if (typeof ref === "function") ref(node);
				else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
			},
			[ref],
		);

		const chips = useMemo(() => parseRichInputChips(value), [value]);

		/** 全量渲染 DOM：清空 root，按 value + chips 重建文本节点 + chip span。 */
		const renderDom = useCallback(() => {
			const root = rootRef.current;
			if (!root) return;

			// 缓存光标偏移：程序化 > 手动 > 当前光标
			const restoreCaret =
				caretRef?.current ?? pendingCaretRef.current ?? getCaretOffset(root);

			// 重建 DOM
			root.textContent = "";
			let cursor = 0;
			for (const chip of chips) {
				if (chip.start > cursor) {
					root.appendChild(document.createTextNode(value.slice(cursor, chip.start)));
				}
				const span = document.createElement("span");
				span.setAttribute("contenteditable", "false");
				span.setAttribute("data-type", chip.kind);
				span.setAttribute("data-raw", chip.raw);
				span.title = chip.raw;
				span.className = `input-chip input-chip--${chip.kind}`;

				const icon = document.createElement("span");
				icon.className = "input-chip__icon";
				icon.textContent = chip.kind === "file" ? "@" : "/";
				const label = document.createElement("span");
				label.className = "input-chip__label";
				label.textContent = chip.label;
				span.appendChild(icon);
				span.appendChild(label);
				root.appendChild(span);
				cursor = chip.end;
			}
			// 末尾文本节点（即使为空也保留，确保光标锚定）
			if (cursor <= value.length) {
				root.appendChild(document.createTextNode(value.slice(cursor)));
			}

			// 消费程序化光标
			if (caretRef) caretRef.current = null;
			pendingCaretRef.current = null;

			// 下一帧恢复光标
			requestAnimationFrame(() => {
				const el = rootRef.current;
				if (!el) return;
				const runs = collectTextRuns(el);
				const pos = resolveOffset(runs, Math.min(restoreCaret, value.length));
				if (pos) placeCaretAt(pos);
			});
		}, [chips, value, caretRef]);

		// 受控同步：仅在需要时重渲染
		// - caretRef 非空（程序化变更）→ 强制渲染
		// - 光标在 token 内部 → 只过滤该 token，其余 chip 正常渲染
		// - DOM chip 区间与期望不一致 → 渲染
		useLayoutEffect(() => {
			if (caretRef?.current !== null) { renderDom(); return; }
			const root = rootRef.current;
			if (!root) return;

			const caret = getCaretOffset(root);

			// 光标是否在某个 token 内部（含末尾，允许继续输入）
			const insideActiveToken = chips.some(
				(c) => caret > c.start && caret <= c.end,
			);

			// DOM 中已存在的 chip 区间
			const existingRanges = collectChipRanges(root);

			// 期望的 chip 区间（光标在 token 内时排除该 token）
			const desiredChips = insideActiveToken
				? chips.filter((c) => !(caret > c.start && caret <= c.end))
				: chips;

			const rangesSame =
				existingRanges.length === desiredChips.length &&
				existingRanges.every((r, i) =>
					r.start === desiredChips[i].start && r.end === desiredChips[i].end,
				);

			// chip 区间一致但纯文本不同（如发送后清空），仍须重渲染
			const textSame = collectFlatText(root) === value;
			if (!rangesSame || !textSame) renderDom();
			// renderDom 变化时 chips/value 也变，无遗漏依赖
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [value, chips]);

		// 挂载时首次渲染
		useLayoutEffect(() => { renderDom(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

		/** 用户输入后：从 DOM 读取纯文本 + 光标偏移，回写上层。 */
		const handleInput = useCallback(() => {
			if (composingRef.current) return;
			const root = rootRef.current;
			if (!root) return;
			onChange(collectFlatText(root), getCaretOffset(root));
		}, [onChange]);

		/** 光标/选区变化：通知上层光标位置。 */
		const handleSelect = useCallback(() => {
			if (composingRef.current) return;
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
			document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
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
				const kind = chip.getAttribute("data-type") as "file" | "skill" | null;
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

		/** Enter：上层未 consume（非发送）时手动插入 \n，保持扁平 DOM。 */
		const handleKeyDown = useCallback(
			(event: React.KeyboardEvent<HTMLDivElement>) => {
				onKeyDown(event);
				if (event.defaultPrevented || composingRef.current) return;

				if (event.key === "Enter") {
					event.preventDefault();
					document.execCommand("insertText", false, "\n");
				}
			},
			[onKeyDown, onChange, chips],
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
