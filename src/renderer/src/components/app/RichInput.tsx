import {
	forwardRef,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";

/**
 * RichInput —— 替换 composer textarea 的 contentEditable 输入区。
 *
 * 设计核心:单一数据源仍是外部传入的 `value`(字符串),chip 在字符串里
 * 以 `@path` / `/command` 内联文本表示。contentEditable 只是这个字符串的
 * 受控渲染层:把命中的 token 渲染成 contenteditable=false 的 chip span,
 * 其余作为普通文本节点。这样 sendPrompt / shell 模式判断 / 命令历史 /
 * detectTrigger / applySuggestion 全部沿用纯文本偏移逻辑,无需改后端协议。
 *
 * 光标偏移统一用「纯文本偏移」:chip 贡献其 data-raw 的字符数,与 textarea
 * 的 selectionStart 语义一致,保证 Phase 1 的光标相关触发检测可直接复用。
 *
 * 换行策略:contentEditable 默认按 Enter 会插入 <div>/<br>,破坏纯文本模型。
 * 这里拦截 Enter(当上层未把它当作「发送」preventDefault 时),手动插入 \n
 * 文本节点 + white-space:pre-wrap 渲染,保持 DOM 始终是「文本节点 + chip」
 * 的扁平结构,让纯文本偏移 ↔ DOM 互转简单可靠。
 *
 * 三个易错点已分别处理:
 *  1. IME 中文:compositionstart/end 期间锁定 composingRef,不回写 value、
 *     不触发 onChange,避免 composition 中途被 React 重渲染打断丢字。
 *  2. 受控回写冲突:当外部 value 与 DOM 纯文本一致时跳过重渲染,避免用户
 *     刚输入就被回写导致光标跳回开头;不一致时重渲染并按缓存偏移恢复选区。
 *  3. 粘贴富文本:拦截 paste,只取纯文本插入,防止外部样式污染 contentEditable。
 */

export type RichInputChip = {
	/** token 在纯文本中的起始偏移 */
	start: number;
	/** token 在纯文本中的结束偏移(不含) */
	end: number;
	/** 序列化文本,如 `@src/main.ts` 或 `/ppt-master` */
	raw: string;
	/** chip 类型,决定颜色:文件=蓝、skill=紫 */
	kind: "file" | "skill";
	/** chip 展示标签,通常是文件名或命令名 */
	label: string;
};

/**
 * 把 prompt 字符串解析为 chip 列表。chip 的 raw 即原文中的子串,
 * start/end 为纯文本偏移。
 *
 * 解析规则与 Phase 1 的 detectTrigger 保持一致:
 *  - /command:前置字符须为空白/起始/([,命令名内无空白无 /
 *  - @path:前置字符非字母数字(避免 email@host),路径内允许 / 但不允许空白与 @
 * 重叠时保留先出现的,避免同一段文本被两条规则重复命中。
 */
export function parseRichInputChips(text: string): RichInputChip[] {
	const chips: RichInputChip[] = [];
	// / 命令：前一字符不能是 : 或 /（避免 URL :// 与路径分隔符 /usr/ 误触），
	// 但允许字母数字前置（与 detectTrigger 保持一致）。
	const slashRe = /(^|[^:/])(\/[^\s/]+)/g;
	let m: RegExpExecArray | null;
	while ((m = slashRe.exec(text)) !== null) {
		const prefixLen = m[1].length;
		const start = m.index + prefixLen;
		const raw = m[2];
		const name = raw.slice(1);
		chips.push({
			start,
			end: start + raw.length,
			raw,
			kind: "skill",
			label: name,
		});
		if (m.index === slashRe.lastIndex) slashRe.lastIndex++;
	}
	// @ 路径：前一字符不能是 : 或 /（与 / 规则对称，允许字母数字前置）。
	const atRe = /(^|[^:/])(@[^\s@]+)/g;
	while ((m = atRe.exec(text)) !== null) {
		const prefixLen = m[1].length;
		const start = m.index + prefixLen;
		const raw = m[2];
		const seg = raw.slice(1);
		const label = seg.includes("/") ? seg.slice(seg.lastIndexOf("/") + 1) : seg;
		chips.push({
			start,
			end: start + raw.length,
			raw,
			kind: "file",
			label: label || seg,
		});
		if (m.index === atRe.lastIndex) atRe.lastIndex++;
	}
	// 处理重叠:同一段文本若被两条规则同时命中,保留先出现的;剔除被包含的。
	chips.sort((a, b) => a.start - b.start || b.end - a.end);
	const merged: RichInputChip[] = [];
	let coverEnd = -1;
	for (const c of chips) {
		if (c.start >= coverEnd) {
			merged.push(c);
			coverEnd = c.end;
		}
	}
	return merged;
}

/** DOM 容器内所有文本节点的扁平序列,用于纯文本偏移 ↔ DOM 位置互转。 */
type TextNodeRun = {
	node: Text;
	/** 该文本节点在纯文本中的起始偏移 */
	start: number;
	/** 该文本节点在纯文本中的结束偏移(不含) */
	end: number;
};

/**
 * 收集容器内所有「参与纯文本」的文本节点。
 * chip 是 contenteditable=false,其内部文本不计入纯文本偏移(它们贡献 data-raw
 * 的长度,但 data-raw 由 chip 元素自身携带,不通过 TextNode 计数),故跳过。
 * 关键:遍历时必须累加 chip 的 data-raw 长度,否则 chip 之后的文本偏移全部错位。
 */
function collectTextRuns(root: HTMLElement): TextNodeRun[] {
	const runs: TextNodeRun[] = [];
	let offset = 0;
	function walk(node: Node) {
		if (node.nodeType === Node.TEXT_NODE) {
			const len = node.nodeValue?.length ?? 0;
			runs.push({ node: node as Text, start: offset, end: offset + len });
			offset += len;
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const el = node as HTMLElement;
			if (el.getAttribute("contenteditable") === "false") {
				// chip 自身贡献 data-raw 长度,不进入子节点(其内部文本不参与纯文本偏移)
				offset += el.getAttribute("data-raw")?.length ?? 0;
			} else {
				node.childNodes.forEach(walk);
			}
		}
	}
	root.childNodes.forEach(walk);
	return runs;
}

/** 把纯文本偏移转换为 DOM Range 定位{node, offset}。 */
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

/** 读取当前选区起点的纯文本偏移。 */
export function getCaretOffset(root: HTMLElement): number {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return 0;
	const range = sel.getRangeAt(0);
	if (!root.contains(range.startContainer)) return 0;
	// 文本节点:直接定位
	if (range.startContainer.nodeType === Node.TEXT_NODE) {
		const runs = collectTextRuns(root);
		for (const run of runs) {
			if (run.node === range.startContainer) {
				return run.start + Math.min(range.startOffset, run.node.nodeValue?.length ?? 0);
			}
		}
		return 0;
	}
	// 元素节点(光标在 chip 之间或边界):按子节点累加纯文本长度定位
	const el = range.startContainer as HTMLElement;
	if (el === root || root.contains(el)) {
		const children = Array.from(el.childNodes);
		const idx = Math.min(range.startOffset, children.length);
		let acc = 0;
		for (let i = 0; i < idx; i++) acc += textLengthOfNode(children[i]);
		return acc;
	}
	return 0;
}

/** 计算单个 DOM 节点贡献的纯文本长度(chip 用 data-raw,文本用 nodeValue)。 */
function textLengthOfNode(node: Node): number {
	if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.length ?? 0;
	const el = node as HTMLElement;
	if (el.getAttribute && el.getAttribute("contenteditable") === "false") {
		return el.getAttribute("data-raw")?.length ?? 0;
	}
	let len = 0;
	node.childNodes.forEach((c) => {
		len += textLengthOfNode(c);
	});
	return len;
}

/** 把纯文本偏移设置为 RichInput 的光标位置(供 App 在建议选中后命令式恢复选区)。 */
export function setRichInputCaret(root: HTMLElement, offset: number): void {
	const runs = collectTextRuns(root);
	const pos = resolveOffset(runs, Math.min(offset, collectRunsText(root).length));
	if (!pos) return;
	const sel = window.getSelection();
	if (!sel) return;
	sel.removeAllRanges();
	const r = document.createRange();
	r.setStart(pos.node, pos.offset);
	r.collapse(true);
	sel.addRange(r);
}

/**
 * 读取容器的纯文本(chip 用 data-raw 还原,文本节点取 nodeValue)。
 * 用于判断 DOM 当前内容是否与受控 value 一致,决定是否需要重渲染。
 */
function collectRunsText(root: HTMLElement): string {
	let out = "";
	root.childNodes.forEach((node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			out += node.nodeValue ?? "";
		} else if (
			node.nodeType === Node.ELEMENT_NODE &&
			(node as HTMLElement).getAttribute("contenteditable") === "false"
		) {
			out += (node as HTMLElement).getAttribute("data-raw") ?? "";
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			// 兜底:若存在未预期的元素结构(如残留 <br>),取其文本贡献
			const el = node as HTMLElement;
			if (el.tagName === "BR") out += "\n";
			else out += collectRunsText(el);
		}
	});
	return out;
}

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
	/** 用于把 shell 模式前缀的视觉差异透传到 class */
	className?: string;
	/** 受控重渲染后光标应恢复到的纯文本偏移(ref)。非 null 时优先于 DOM 当前光标。 */
	caretRef?: React.MutableRefObject<number | null>;
};

export const RichInput = forwardRef<HTMLDivElement, RichInputProps>(
	function RichInput(props, ref) {
		const {
			value,
			onChange,
			onCursorChange,
			onKeyDown,
			onPaste,
			onDrop,
			onDragOver,
			onFocus,
			onBlur,
			disabled,
			placeholder,
			className,
			caretRef,
		} = props;

		const rootRef = useRef<HTMLDivElement | null>(null);
		// 把外部 ref 与内部 rootRef 同步:外部拿到的是 contentEditable 根 div。
		const setRef = useCallback(
			(node: HTMLDivElement | null) => {
				rootRef.current = node;
				if (typeof ref === "function") ref(node);
				else if (ref)
					(ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
			},
			[ref],
		);
		// IME composition 锁:composition 期间不回写 value、不触发 onChange。
		const composingRef = useRef(false);
		// 重渲染后光标应恢复到的纯文本偏移;null 表示沿用重渲染前位置。
		const pendingCaretRef = useRef<number | null>(null);

	const chips = useMemo(() => parseRichInputChips(value), [value]);

	/** 把 value 字符串渲染为「文本节点 + chip span」的扁平 DOM 结构。 */
	const renderDom = useCallback(() => {
		const root = rootRef.current;
		if (!root) return;
		const restoreCaret =
			(caretRef?.current ?? null) ??
			pendingCaretRef.current ??
			getCaretOffset(root);
		root.textContent = "";
		let cursor = 0;
		for (const chip of chips) {
			if (chip.start > cursor) {
				root.appendChild(
					document.createTextNode(value.slice(cursor, chip.start)),
				);
			}
			const span = document.createElement("span");
			span.setAttribute("contenteditable", "false");
			span.setAttribute("data-type", chip.kind);
			span.setAttribute("data-raw", chip.raw);
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
		if (cursor <= value.length) {
			// 即便剩余为空字符串也追加文本节点,确保光标恢复时 collectTextRuns 有可锚定的 run。
			root.appendChild(document.createTextNode(value.slice(cursor)));
		}
			caretRef && (caretRef.current = null);
		pendingCaretRef.current = null;
		// 下一帧恢复光标到缓存偏移
		requestAnimationFrame(() => {
			const el = rootRef.current;
			if (!el) return;
			const runs = collectTextRuns(el);
			const pos = resolveOffset(runs, Math.min(restoreCaret, value.length));
			if (pos) {
				const sel = window.getSelection();
				if (sel) {
					sel.removeAllRanges();
					const r = document.createRange();
					r.setStart(pos.node, pos.offset);
					r.collapse(true);
					sel.addRange(r);
				}
			}
		});
	}, [chips, value]);

	// 受控同步:光标不在活动 token 内部时才 chip 化,避免用户输入到一半
	// (如 @src|)就被 chip 化导致光标被推出 token 末尾无法继续输入。
	// - 手动输完 @path 后光标移开 → 自动 chip 化
	// - 菜单选中走 applySuggestion → caretRef 非空,跳过光标判断直接强制渲染
	// - 正在 token 内部编辑 → 保持纯文本可编辑
	useLayoutEffect(() => {
		// caretRef 非空说明是程序化变更(applySuggestion/clearSuggestionTrigger),
		// 此时 value 已更新但 DOM 仍是旧文本,必须立即全量重渲染,不能走光标感知跳过。
		if (caretRef?.current !== null) {
			renderDom();
			return;
		}
		const root = rootRef.current;
		if (!root) return;
		const caret = getCaretOffset(root);
		// 光标在 token 内部(含末尾):严格 > start && <= end,
		// 即光标恰好在末尾时也算「正在编辑 token」,不 chip 化打断输入。
		const insideActiveToken = chips.some(
			(chip) => caret > chip.start && caret <= chip.end,
		);
		// DOM 当前已有 chip 的区间集合
		const existingChipRanges = Array.from(
			root.querySelectorAll('[contenteditable="false"]'),
		).map((el) => {
			const raw = el.getAttribute("data-raw") ?? "";
			let start = 0;
			// 估算该 chip 在纯文本中的起始偏移:累加它之前的节点文本长度
			let node = el.previousSibling;
			while (node) {
				if (node.nodeType === Node.TEXT_NODE) start += node.nodeValue?.length ?? 0;
				else if (
					node.nodeType === Node.ELEMENT_NODE &&
					(node as HTMLElement).getAttribute("contenteditable") === "false"
				) {
					start += (node as HTMLElement).getAttribute("data-raw")?.length ?? 0;
				}
				node = node.previousSibling;
			}
			return { start, end: start + raw.length };
		});
		// 期望的 chip 区间集合(过滤掉光标正在编辑的那个)
		const desiredChips = insideActiveToken
			? chips.filter((c) => !(caret > c.start && caret <= c.end))
			: chips;
		const same =
			existingChipRanges.length === desiredChips.length &&
			existingChipRanges.every(
				(r, i) =>
					r.start === desiredChips[i].start &&
					r.end === desiredChips[i].end,
			);
		if (!same) {
			renderDom();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value, chips]);

	// 挂载时初次渲染
	useLayoutEffect(() => {
		renderDom();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const readDomText = useCallback(() => {
		const root = rootRef.current;
		if (!root) return value;
		return collectRunsText(root);
	}, [value]);

	/** 用户输入后:读取 DOM 纯文本 + 光标偏移,回写给上层。 */
	const handleInput = useCallback(() => {
		if (composingRef.current) return;
		const root = rootRef.current;
		if (!root) return;
		const text = collectRunsText(root);
		const cursor = getCaretOffset(root);
		onChange(text, cursor);
	}, [onChange]);

	const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
		// 上层 onPaste 负责图片粘贴;有图片时交给它处理。
		if (onPaste) {
			const hasImage = Array.from(event.clipboardData.items).some((i) =>
				i.type.startsWith("image/"),
			);
			if (hasImage) {
				onPaste(event);
				return;
			}
		}
		// 强制纯文本插入,避免富文本污染 contentEditable。
		event.preventDefault();
		const text = event.clipboardData.getData("text/plain");
		document.execCommand("insertText", false, text);
	};

	const handleCompositionStart = () => {
		composingRef.current = true;
	};
	const handleCompositionEnd = () => {
		composingRef.current = false;
		handleInput();
	};

	const handleSelect = useCallback(() => {
		if (composingRef.current) return;
		const root = rootRef.current;
		if (!root) return;
		onCursorChange(getCaretOffset(root));
	}, [onCursorChange]);

	/**
	 * 键盘事件:先交给上层(处理发送/历史导航/建议选择/Escape)。
	 * 若上层未 preventDefault 且是 Enter 换行场景,手动插入 \n,
	 * 避免浏览器默认生成 <div>/<br> 破坏扁平文本模型。
	 */
	const handleKeyDownInternal = (event: React.KeyboardEvent<HTMLDivElement>) => {
		onKeyDown(event);
		if (event.defaultPrevented) return;
		if (composingRef.current) return;
		if (event.key === "Enter") {
			// 走到这里说明上层判定为「换行」(非发送)。统一插入 \n 文本节点,
			// 配合 white-space:pre-wrap 渲染,保持 DOM 扁平结构。
			event.preventDefault();
			document.execCommand("insertText", false, "\n");
		}
	};

	return (
		<div
			ref={setRef}
			className={`rich-input${disabled ? " is-disabled" : ""}${
				className ? ` ${className}` : ""
			}`}
			contentEditable={!disabled}
			suppressContentEditableWarning
			role="textbox"
			aria-multiline="true"
			aria-disabled={disabled}
			data-placeholder={placeholder ?? ""}
			onInput={handleInput}
			onKeyDown={handleKeyDownInternal}
			onKeyUp={handleSelect}
			onClick={handleSelect}
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

/** 暴露给上层:计算光标的屏幕坐标,用于菜单锚定定位(Phase 1 遗留 #10)。 */
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
