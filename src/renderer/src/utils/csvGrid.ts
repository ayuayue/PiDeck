/**
 * CSV/TSV 预览解析：把纯文本切成「预览窗口」内的二维单元格。
 *
 * 为什么不复用 SheetJS：SheetJS 吃的是工作簿二进制，CSV 是纯文本，为看一眼内容
 * 把这份解析器拉进渲染路径不划算。这里只实现 CSV 里真实存在的必要语义
 * （引号包裹、`""` 转义、CRLF/BOM、分隔符嗅探），够覆盖 Excel/导出工具产出的文件。
 *
 * 截断在解析阶段就做：命中行上限后停止扫描，5MB 的文件不会先展开成几十万行再裁掉。
 */

export const CSV_PREVIEW_MAX_ROWS = 200;
export const CSV_PREVIEW_MAX_COLS = 40;

/** 候选分隔符：逗号（欧美）、制表符（TSV）、分号（欧洲 Excel）、竖线（部分导出工具）。 */
const CANDIDATE_DELIMITERS = [",", "\t", ";", "|"] as const;

export type CsvGrid = {
	/** 表头（文件首行）；空文件为 [] */
	header: string[];
	/** 数据行（不含表头），最多 CSV_PREVIEW_MAX_ROWS 行 */
	rows: string[][];
	/** 数据行数（不含表头） */
	rowCount: number;
	/** 展示列数（表头与数据行的最大宽度，最多 CSV_PREVIEW_MAX_COLS） */
	colCount: number;
	/** 文件还有更多行被丢弃 */
	truncatedRows: boolean;
	/** 有行超过 CSV_PREVIEW_MAX_COLS 列被丢弃 */
	truncatedCols: boolean;
	/** 实际使用的分隔符 */
	delimiter: string;
	/** 表头每格在原文中的原始 token 区间（含引号），与 header 同下标 */
	headerSpans: (CsvCellSpan | null)[];
	/** 数据行每格的原始 token 区间，与 rows 同形 */
	rowSpans: (CsvCellSpan | null)[][];
};

/** 单元格原始 token（含包裹引号）在原文中的半开区间 [start, end)。 */
export type CsvCellSpan = { start: number; end: number };

/**
 * 按首行猜分隔符：统计引号外各候选符号的出现次数，取最多的一个。
 * 一个都没有时退回逗号（单列文件反正不会有影响）。
 */
export function sniffCsvDelimiter(text: string): string {
	const counts = new Map<string, number>(CANDIDATE_DELIMITERS.map((candidate) => [candidate, 0]));
	let inQuotes = false;
	// 只看首行：多行样本会把「正文里的逗号比表头的制表符多」误判成分隔符。
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === '"') {
			if (inQuotes && text[i + 1] === '"') i += 1;
			else inQuotes = !inQuotes;
			continue;
		}
		if (!inQuotes && (ch === "\n" || ch === "\r")) break;
		if (!inQuotes && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	}
	let best = ",";
	let bestCount = 0;
	for (const candidate of CANDIDATE_DELIMITERS) {
		const count = counts.get(candidate) ?? 0;
		if (count > bestCount) {
			best = candidate;
			bestCount = count;
		}
	}
	return best;
}

/** 解析 CSV/TSV 文本为预览网格：引号感知、CRLF/BOM 兼容、按行列上限截断。 */
export function parseCsvGrid(text: string, options: { delimiter?: string; maxRows?: number; maxCols?: number } = {}): CsvGrid {
	const maxRows = Math.max(1, options.maxRows ?? CSV_PREVIEW_MAX_ROWS);
	const maxCols = Math.max(1, options.maxCols ?? CSV_PREVIEW_MAX_COLS);
	const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const delimiter = options.delimiter ?? sniffCsvDelimiter(source);

	const allRows: string[][] = [];
	// 每行格子原始 token 的区间，与 allRows 同形（只服务于单元格编辑）。
	const allSpans: (CsvCellSpan | null)[][] = [];
	// 有 BOM 时 source 比 text 少一个字符：span 统一回到 text 坐标，调用方直接对 text 拼接。
	const offsetBase = text.length - source.length;
	let row: string[] = [];
	let rowSpans: (CsvCellSpan | null)[] = [];
	let field = "";
	let inQuotes = false;
	let truncatedRows = false;
	let truncatedCols = false;
	// 当前格原始 token 的起点（含开引号）：终止于分隔符 / 换行的下标。
	let tokenStart = 0;
	// 需要保留的首行数 = 表头 + maxRows 数据行；多出第一行就说明被截断了。
	const rowBudget = maxRows + 1;

	/** 收一格：超出列上限的格子只记截断标记，不给区间（无法定点编辑）。 */
	const pushField = (tokenEnd: number): void => {
		if (row.length < maxCols) {
			row.push(field);
			rowSpans.push({ start: tokenStart + offsetBase, end: tokenEnd + offsetBase });
		} else truncatedCols = true;
		field = "";
	};

	/** 收一行；返回 true 表示行数已超预算，调用方应立即停止扫描。 */
	const endRow = (): boolean => {
		const cells = row;
		const spans = rowSpans;
		row = [];
		rowSpans = [];
		// 空行（含末尾换行产生的幽灵行）不计入表格，也不占行预算。
		if (cells.every((cell) => cell === "")) return false;
		allRows.push(cells);
		allSpans.push(spans);
		if (allRows.length <= rowBudget) return false;
		truncatedRows = true;
		return true;
	};

	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		if (inQuotes) {
			if (ch === '"') {
				if (source[i + 1] === '"') {
					field += '"';
					i += 1;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			continue;
		}
		if (ch === delimiter) {
			pushField(i);
			tokenStart = i + 1;
			continue;
		}
		if (ch === "\r" || ch === "\n") {
			// CRLF 先记住换行起点的下标：i 被推过 \n 后，区间会把 \r 也包进来。
			const lineEnd = i;
			if (ch === "\r" && source[i + 1] === "\n") i += 1;
			pushField(lineEnd);
			if (endRow()) break;
			tokenStart = i + 1;
			continue;
		}
		field += ch;
	}
	// 文件末尾没有换行时补上最后一行
	if (!truncatedRows && (field !== "" || row.length > 0)) {
		pushField(source.length);
		endRow();
	}

	const header = allRows[0] ?? [];
	const rows = allRows.slice(1, rowBudget);
	const colCount = rows.reduce((max, current) => Math.max(max, current.length), header.length);
	return {
		header: header.slice(0, maxCols),
		headerSpans: (allSpans[0] ?? []).slice(0, maxCols),
		rows,
		rowSpans: allSpans.slice(1, rowBudget),
		rowCount: rows.length,
		colCount: Math.min(colCount, maxCols),
		truncatedRows,
		truncatedCols,
		delimiter,
	};
}

/** 把单元格值序列化成 CSV token：只在真正需要时加引号（Excel 同款规则）。 */
export function serializeCsvCell(value: string, delimiter: string): string {
	if (value === "") return "";
	const needsQuotes = value.includes(delimiter) || value.includes('"') || value.includes("\n") || value.includes("\r");
	return needsQuotes ? `"${value.split('"').join('""')}"` : value;
}

/**
 * 定点替换一个单元格：只重写这一格的原始 token，其余字节（其它列、换行风格、
 * 引号风格、行尾内容）原样保留——改一格不该让整份文件进 diff。
 * 区间缺失（列被截断、该行没这一列）时返回原文，调用方无需额外判空。
 */
export function replaceCsvCell(text: string, span: CsvCellSpan | null | undefined, value: string, delimiter: string): string {
	if (!span) return text;
	return text.slice(0, span.start) + serializeCsvCell(value, delimiter) + text.slice(span.end);
}
