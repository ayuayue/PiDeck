import { useMemo, useState } from "react";
import { read, utils } from "@e965/xlsx";
import { t } from "../../../i18n";

const MAX_PREVIEW_ROWS = 200;
const MAX_PREVIEW_COLS = 40;

type SheetPreviewData = {
	name: string;
	rows: string[][];
	totalRows: number;
	totalCols: number;
};

type ParsedWorkbook = { sheets: SheetPreviewData[]; error: string | null };

/**
 * Excel（.xlsx/.xlsm/.xls）只读预览：SheetJS 解析成二维文本后按 200 行 × 40 列渲染。
 * 不保留公式/样式，只求「快速看一眼内容」；大表只显示截断提示，不阻塞整页。
 */
export default function SheetPreview(props: { bytes: Uint8Array }) {
	const [activeIndex, setActiveIndex] = useState(0);

	const parsed = useMemo<ParsedWorkbook>(() => {
		try {
			// type:"array" 让 SheetJS 直接吃 Uint8Array；xls 也走同一条解析路径。
			const workbook = read(props.bytes, { type: "array", cellDates: true });
			const sheets = workbook.SheetNames.map((name) => {
				const sheet = workbook.Sheets[name];
				const bounds = sheet?.["!ref"] ? utils.decode_range(sheet["!ref"]) : null;
				const totalRows = bounds ? bounds.e.r + 1 : 0;
				const totalCols = bounds ? bounds.e.c + 1 : 0;
				// 只转换要展示的窗口（A1:AN200）：大表不把整张 sheet 展开成字符串矩阵，避免打开即卡死。
				const range = bounds ? `A1:${utils.encode_col(Math.min(MAX_PREVIEW_COLS, totalCols) - 1)}${Math.min(MAX_PREVIEW_ROWS, totalRows)}` : null;
				const matrix = (sheet && range && totalRows > 0 && totalCols > 0
					? utils.sheet_to_json<string[]>(sheet, {
							header: 1,
							raw: false,
							defval: "",
							blankrows: false,
							range,
						})
					: []) as unknown as string[][];
				return {
					name,
					rows: matrix.slice(0, MAX_PREVIEW_ROWS).map((row) => (Array.isArray(row) ? row.slice(0, MAX_PREVIEW_COLS).map((cell) => (cell == null ? "" : String(cell))) : [])),
					totalRows,
					totalCols,
				};
			});
			return { sheets, error: null };
		} catch (e) {
			return { sheets: [], error: e instanceof Error ? e.message : String(e) };
		}
	}, [props.bytes]);

	if (parsed.error) return <div className="file-diff-error">{t("editor.previewFailed", { error: parsed.error })}</div>;
	if (parsed.sheets.length === 0) return <div className="file-diff-error">{t("editor.sheetEmpty")}</div>;

	const active = parsed.sheets[Math.min(activeIndex, parsed.sheets.length - 1)];
	const truncated = active.totalRows > active.rows.length || active.totalCols > MAX_PREVIEW_COLS;
	// 行尾空列不渲染：Excel 的 usedRange 常比实际内容宽，避免整屏空白格。
	const colCount = active.rows.reduce((max, row) => Math.max(max, row.length), 0);

	return (
		<div className="flex h-full w-full flex-col overflow-hidden">
			{parsed.sheets.length > 1 && (
				<div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
					{parsed.sheets.map((sheet, index) => (
						<button key={`${sheet.name}:${index}`} type="button" onClick={() => setActiveIndex(index)} className={`max-w-48 shrink-0 truncate rounded px-2 py-1 text-caption ${index === activeIndex ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`} title={sheet.name}>
							{sheet.name}
						</button>
					))}
				</div>
			)}
			{colCount === 0 ? (
				<div className="file-diff-error">{t("editor.sheetEmpty")}</div>
			) : (
				/* scroll-ok: text —— 单个表格的二维滚动，行集合由预览行数上限约束，没有可虚拟化的长列表。 */
				<div className="min-h-0 flex-1 overflow-auto">
					<table className="border-collapse text-caption">
						<tbody>
							{active.rows.map((row, rowIndex) => (
								<tr key={rowIndex} className="hover:bg-muted/40">
									<th className="sticky left-0 z-10 border border-border bg-muted px-2 py-1 text-right font-normal text-muted-foreground">{rowIndex + 1}</th>
									{Array.from({ length: colCount }, (_, colIndex) => (
										<td key={colIndex} className="max-w-[320px] truncate border border-border px-2 py-1 align-top whitespace-pre" title={row[colIndex] || undefined}>
											{row[colIndex] ?? ""}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			<div className="shrink-0 border-t border-border px-3 py-1 text-caption text-muted-foreground">
				{truncated
					? t("editor.sheetTruncated", {
							rows: Math.min(active.totalRows, MAX_PREVIEW_ROWS),
							cols: Math.min(active.totalCols, MAX_PREVIEW_COLS),
							totalRows: active.totalRows,
							totalCols: active.totalCols,
						})
					: `${active.totalRows} × ${active.totalCols}`}
			</div>
		</div>
	);
}
