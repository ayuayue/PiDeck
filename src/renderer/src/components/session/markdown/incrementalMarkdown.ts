/**
 * 流式 Markdown 冻结切分（学 dsh IncrementalMarkdownParser）。
 *
 * 业务规则：CommonMark 块级解析是行基的，追加文本只会重塑「解析前沿」
 * （末段段落可能变 setext 标题、列表延续、未闭合 fence 吞行）。
 * 因此只把尾部 UNSTABLE_TAIL_BLOCKS 个内容块留在热路径，前面的稳定块
 * 按源 offset 切开，交给各自 memo 的 Streamdown，避免每帧全量重解析。
 *
 * 边界：
 * - 不引入 marked（它只活在 streamdown 内部）；本模块只做顶层块分界扫描。
 * - 未闭合围栏始终算不稳定，不会被冻进 prefix。
 * - 非 append（text 不以 prev 为前缀）时 generation +1，调用方丢弃旧冻结节点。
 * - remend/引用链接跨冻结边界可能字面渲染，settle 后整篇重渲自愈。
 *
 * 2026-08 内存/CPU 治理（增量重扫 + 尾块收窄）：
 * - 追加文本只能重塑「最后一个块」：setext 下划线并入前段、列表懒延续、
 *   未闭合 fence 吞行——追溯影响不超过最后一个内容块。因此 update 时不必
 *   全量重扫：从「上一个冻结块的起点」重扫即可（该块可能被追溯吞并，必须
 *   重新判定；更早的块结构不可能被追加改变）。
 * - UNSTABLE_TAIL_BLOCKS 从 2 收到 1：尾部 = 最后一个内容块。此前第 2 个
 *   尾块（如已闭合的大代码块）会滞留 tail 并在每次内容到达时被 Streamdown
 *   整块重解析（30K≈2.3ms/帧量级，主线程满载 → IPC 积压 → 原生内存 GB 级
 *   爬升）。收到 1 后它随边界前移进冻结 prefix，只随 key 变化一次性重解析。
 *   代价：setext/列表懒延续的追溯重分类最多滞后一帧（下帧重扫即纠正），
 *   冻结块边界前移时整段 prefix 一次性重解析（块切换频率 ≈ 空行频率，均摊可忽略）。
 */

/** 尾部保留的不稳定内容块数：0 不够（追加行的追溯影响至少波及最后一块），
 * 2 会让已稳定的大块长期滞留 tail 每帧重解析；1 即「最后一块」最小热路径。 */
export const UNSTABLE_TAIL_BLOCKS = 1;

export type MarkdownBlockKind = "fence" | "heading" | "list" | "quote" | "hr" | "html" | "paragraph" | "blank";

export type MarkdownBlockSpan = {
	start: number;
	end: number;
	kind: MarkdownBlockKind;
	/** 围栏尚未闭合：禁止冻进 prefix，必须留在 tail。 */
	open?: boolean;
};

export type FrozenMarkdownSplit = {
	prefixEnd: number;
	prefix: string;
	tail: string;
	frozenBlocks: MarkdownBlockSpan[];
	generation: number;
};

type LineSlice = {
	raw: string;
	trimmed: string;
	start: number;
	next: number;
};

function readLine(text: string, from: number): LineSlice {
	const nl = text.indexOf("\n", from);
	const end = nl === -1 ? text.length : nl;
	const raw = text.slice(from, end);
	const trimmed = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
	return { raw, trimmed, start: from, next: nl === -1 ? text.length : nl + 1 };
}

function isBlankLine(line: string): boolean {
	return /^\s*$/.test(line);
}

function isFenceOpen(line: string): { marker: string; len: number } | undefined {
	const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
	if (!match) return undefined;
	return { marker: match[2][0], len: match[2].length };
}

function isFenceClose(line: string, open: { marker: string; len: number }): boolean {
	const match = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(line);
	if (!match) return false;
	return match[2][0] === open.marker && match[2].length >= open.len;
}

function isAtxHeading(line: string): boolean {
	return /^ {0,3}#{1,6}(?:\s|$)/.test(line);
}

function isThematicBreak(line: string): boolean {
	return /^ {0,3}(?:(?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:\*[\t ]*){3,})\s*$/.test(line);
}

function isListItem(line: string): boolean {
	return /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:\s|$)/.test(line);
}

function isQuote(line: string): boolean {
	return /^ {0,3}>/.test(line);
}

function isIndentedCode(line: string): boolean {
	return /^(?: {4}|\t)/.test(line) && !isBlankLine(line);
}

function isHtmlBlock(line: string): boolean {
	return /^ {0,3}</.test(line);
}

function isSetextUnderline(line: string): boolean {
	return /^ {0,3}(?:=+|-+)\s*$/.test(line) && !isThematicBreak(line);
}

/**
 * 扫描顶层块分界。只关心「下一块从哪开始」，不复刻完整 CommonMark。
 * 空白行单独成块，方便冻结切在内容块 end、tail 从下一内容块 start 起。
 *
 * from 支持从中间偏移续扫（增量重扫）：from 必须是块边界（上一个冻结块的
 * 起点），偏移之前的行结构由调用方以「前次冻结块」补齐，不在此处重复判定。
 */
export function splitTopLevelMarkdownBlocks(text: string, from = 0): MarkdownBlockSpan[] {
	const blocks: MarkdownBlockSpan[] = [];
	let offset = from;
	while (offset < text.length) {
		const first = readLine(text, offset);
		if (isBlankLine(first.trimmed)) {
			let next = first.next;
			while (next < text.length) {
				const look = readLine(text, next);
				if (!isBlankLine(look.trimmed)) break;
				next = look.next;
			}
			blocks.push({ start: offset, end: next, kind: "blank" });
			offset = next;
			continue;
		}

		const fence = isFenceOpen(first.trimmed);
		if (fence) {
			let next = first.next;
			let closed = false;
			while (next < text.length) {
				const look = readLine(text, next);
				next = look.next;
				if (isFenceClose(look.trimmed, fence)) {
					closed = true;
					break;
				}
			}
			blocks.push({
				start: offset,
				end: next,
				kind: "fence",
				open: closed ? undefined : true,
			});
			offset = next;
			continue;
		}

		if (isAtxHeading(first.trimmed) || isThematicBreak(first.trimmed)) {
			blocks.push({
				start: offset,
				end: first.next,
				kind: isAtxHeading(first.trimmed) ? "heading" : "hr",
			});
			offset = first.next;
			continue;
		}

		if (isQuote(first.trimmed) || isListItem(first.trimmed) || isIndentedCode(first.trimmed) || isHtmlBlock(first.trimmed)) {
			const kind: MarkdownBlockKind = isQuote(first.trimmed) ? "quote" : isListItem(first.trimmed) ? "list" : isHtmlBlock(first.trimmed) ? "html" : "paragraph";
			let next = first.next;
			while (next < text.length) {
				const look = readLine(text, next);
				if (isBlankLine(look.trimmed)) break;
				// 列表/引用允许懒延续；新围栏/标题/hr 必须切开，避免把后续结构吞进当前块。
				if (isFenceOpen(look.trimmed) || isAtxHeading(look.trimmed) || isThematicBreak(look.trimmed)) break;
				if (kind === "list" && (isQuote(look.trimmed) || isHtmlBlock(look.trimmed))) break;
				next = look.next;
			}
			blocks.push({ start: offset, end: next, kind: kind === "paragraph" && isIndentedCode(first.trimmed) ? "paragraph" : kind });
			offset = next;
			continue;
		}

		// 段落：吃到空行；若下一行是 setext 下划线，并进本块（可能把段变成标题——所以必须留在 tail）。
		let next = first.next;
		while (next < text.length) {
			const look = readLine(text, next);
			if (isBlankLine(look.trimmed)) break;
			if (isSetextUnderline(look.trimmed)) {
				next = look.next;
				break;
			}
			if (isFenceOpen(look.trimmed) || isAtxHeading(look.trimmed) || isThematicBreak(look.trimmed) || isListItem(look.trimmed) || isQuote(look.trimmed)) {
				break;
			}
			next = look.next;
		}
		blocks.push({ start: offset, end: next, kind: "paragraph" });
		offset = next;
	}
	return blocks;
}

/**
 * 由「内容块列表」计算可冻结前缀终点：去掉尾部 N 个内容块 + 任何未闭合围栏。
 * 独立成纯函数供全量/增量两条路径共用，保证两者结果一致。
 */
export function computeFrozenEnd(content: MarkdownBlockSpan[], unstableTail: number = UNSTABLE_TAIL_BLOCKS): { prefixEnd: number; frozenBlocks: MarkdownBlockSpan[] } {
	if (content.length === 0) return { prefixEnd: 0, frozenBlocks: [] };

	let lastUnstableIndex = content.length;
	for (let i = content.length - 1; i >= 0; i -= 1) {
		if (content[i].open) lastUnstableIndex = i;
	}
	const keepFrom = Math.min(lastUnstableIndex, Math.max(0, content.length - unstableTail));
	if (keepFrom <= 0) return { prefixEnd: 0, frozenBlocks: [] };

	const frozenBlocks = content.slice(0, keepFrom);
	return { prefixEnd: frozenBlocks[frozenBlocks.length - 1].end, frozenBlocks };
}

/** 计算可冻结前缀终点（全量扫描入口；增量路径见 IncrementalMarkdownFrontier）。 */
export function resolveFrozenPrefixEnd(text: string, unstableTail: number = UNSTABLE_TAIL_BLOCKS): { prefixEnd: number; frozenBlocks: MarkdownBlockSpan[] } {
	const blocks = splitTopLevelMarkdownBlocks(text);
	const content = blocks.filter((block) => block.kind !== "blank");
	return computeFrozenEnd(content, unstableTail);
}

/**
 * 增量冻结器：同一实例跟一段流式文本。
 * update 对相同输入幂等；非 append 升 generation，调用方必须丢弃旧冻结 React 节点。
 *
 * 增量重扫（2026-08 内存/CPU 治理）：append 时从上一个冻结块的起点续扫，
 * 前面的冻结块直接复用，避免每帧全量 O(n) 扫描（100K 文本实测 1.18ms/次，
 * 60fps 下光扫描占 70% CPU，是渲染进程主线程满载 → IPC 积压 → GB 级原生
 * 内存爬升的根源）。正确性依据见文件头注释：追加只影响最后一个内容块。
 */
export class IncrementalMarkdownFrontier {
	private prevText = "";
	private generation = 0;
	private cached: FrozenMarkdownSplit | undefined;

	update(text: string): FrozenMarkdownSplit {
		if (this.cached && text === this.prevText) return this.cached;
		// 非追加（回退、整段替换、新一轮）会让已冻结块的源区间失效。
		// 首个 update（prevText 为空）不算非追加：generation 保持 0。
		const appended = this.prevText !== "" && text.startsWith(this.prevText);
		const shrinkToPrefix = this.prevText !== "" && this.prevText.startsWith(text);
		// 更短前缀是真回退，不升 generation：已冻结块仍有效，避免整段收回重铺。
		// 完全无关的替换才升 generation。
		if (this.prevText !== "" && !appended && !shrinkToPrefix) {
			this.generation += 1;
		}
		this.prevText = text;
		const split = appended && this.cached ? this.rescanAppend(text, this.cached) : this.fullScan(text);
		// 冻结边界未动且 generation 未变时复用上一次的 prefix 字符串对象：
		// 流式每帧追加 6~12 字，若每帧 slice 都会新分配一个大字符串
		// （V8 对 slice 可能生成引用父串的 SlicedString，使旧串无法及时回收），
		// 长时间流式会持续积累分配压力；边界移动时内容才真正变化，必须重 slice。
		if (this.cached && appended && this.cached.generation === split.generation && this.cached.prefixEnd === split.prefixEnd) {
			split.prefix = this.cached.prefix;
		}
		this.cached = split;
		return split;
	}

	/** 全量重扫：首个 update / 非 append / 无冻结块可续（prefixEnd=0）时使用。 */
	private fullScan(text: string): FrozenMarkdownSplit {
		const { prefixEnd, frozenBlocks } = resolveFrozenPrefixEnd(text);
		return {
			prefixEnd,
			prefix: text.slice(0, prefixEnd),
			tail: text.slice(prefixEnd),
			frozenBlocks,
			generation: this.generation,
		};
	}

	/**
	 * 增量重扫：从上一个冻结块的起点续扫。该块可能被追加文本追溯吞并
	 * （setext 下划线并入前段 / 列表懒延续 / 引用吞行），必须重新判定；
	 * 更早的冻结块结构不可能被追加改变，直接复用其 span。
	 */
	private rescanAppend(text: string, prev: FrozenMarkdownSplit): FrozenMarkdownSplit {
		const prevFrozen = prev.frozenBlocks;
		const resumeFrom = prevFrozen.length > 0 ? prevFrozen[prevFrozen.length - 1].start : 0;
		const newBlocks = splitTopLevelMarkdownBlocks(text, resumeFrom);
		// 续扫块 + 之前冻结块（最后一个除外，它从 resumeFrom 起已被重扫）。
		// 前次冻结块恒为内容块（无 blank），结构不会被追加改变，offset 保持有效。
		const allBlocks = [...prevFrozen.slice(0, -1), ...newBlocks];
		const content = allBlocks.filter((block) => block.kind !== "blank");
		const { prefixEnd, frozenBlocks } = computeFrozenEnd(content);
		return {
			prefixEnd,
			prefix: text.slice(0, prefixEnd),
			tail: text.slice(prefixEnd),
			frozenBlocks,
			generation: this.generation,
		};
	}

	reset(): void {
		this.prevText = "";
		this.cached = undefined;
	}
}
