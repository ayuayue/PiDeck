import { useMemo } from "react";
import { t } from "../../../i18n";
import { CSV_PREVIEW_MAX_COLS, parseCsvGrid } from "../../../utils/csvGrid";

/**
 * CSV/TSV 只读预览：首行当表头、行号列固定、表头吸顶。
 *
 * 预览默认视角是「表格」而不是源码（与 xlsx/docx 一致）：绝大多数人打开 csv
 * 是想看内容分布，不是看逗号。顶栏的「源码」按钮仍可切回原始文本。
 */
export default function CsvPreview(props: { content: string }) {
	const grid = useMemo(() => parseCsvGrid(props.content), [props.content]);

	if (grid.header.length === 0 && grid.rows.length === 0) return <div className="file-diff-error">{t("editor.csvEmpty")}</div>;
	const colCount = grid.colCount;

	return (
		<div className="flex h-full w-full flex-col overflow-hidden">
			{/* scroll-ok: text —— 单个表格的二维滚动，行数由预览上限约束，没有可虚拟化的长列表。 */}
			<div className="min-h-0 flex-1 overflow-auto">
				<table className="border-collapse text-caption">
					<thead>
						<tr>
							<th className="sticky left-0 top-0 z-20 w-10 border border-border bg-muted px-2 py-1 text-right font-normal text-muted-foreground">#</th>
							{Array.from({ length: colCount }, (_, colIndex) => (
								<th key={colIndex} className="sticky top-0 z-10 max-w-[320px] truncate border border-border bg-muted px-2 py-1 text-left font-medium text-foreground" title={grid.header[colIndex] || undefined}>
									{grid.header[colIndex] ?? ""}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{grid.rows.map((row, rowIndex) => (
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
			<div className="shrink-0 border-t border-border px-3 py-1 text-caption text-muted-foreground">
				{grid.truncatedRows || grid.truncatedCols ? t("editor.csvTruncated", { rows: grid.rowCount, cols: Math.min(colCount, CSV_PREVIEW_MAX_COLS) }) : `${grid.rowCount} × ${colCount}`}
			</div>
		</div>
	);
}
