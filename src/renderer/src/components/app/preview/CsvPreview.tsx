import { useMemo, useState } from "react";
import { t } from "../../../i18n";
import { CSV_PREVIEW_MAX_COLS, parseCsvGrid, replaceCsvCell } from "../../../utils/csvGrid";

/** 正在编辑的格子：row = -1 表示表头。 */
type EditingCell = { row: number; col: number };

/**
 * CSV/TSV 预览：首行当表头、行号列固定、表头吸顶；有 onChange 时双击单元格就地改值。
 *
 * 预览默认视角是「表格」而不是源码（与 xlsx/docx 一致）：绝大多数人打开 csv
 * 是想看内容分布，不是看逗号。顶栏的「源码」按钮仍可切回原始文本。
 *
 * 单元格编辑走「定点替换」（utils/csvGrid replaceCsvCell）：只重写这一格的原始
 * token，别的列、换行风格、引号风格一个字节都不动——否则改一格会让整份文件进 diff，
 * 用户回滚时也分不清哪些是自己改的。
 */
export default function CsvPreview(props: { content: string; onChange?: (next: string) => void }) {
	const grid = useMemo(() => parseCsvGrid(props.content), [props.content]);
	const editable = props.onChange !== undefined;
	const [editing, setEditing] = useState<EditingCell | null>(null);
	const [draft, setDraft] = useState("");

	const spanOf = (cell: EditingCell) => (cell.row < 0 ? grid.headerSpans[cell.col] : grid.rowSpans[cell.row]?.[cell.col]);
	const valueOf = (cell: EditingCell) => (cell.row < 0 ? grid.header[cell.col] : grid.rows[cell.row]?.[cell.col]) ?? "";

	const startEdit = (cell: EditingCell) => {
		if (!editable || !spanOf(cell)) return;
		setDraft(valueOf(cell));
		setEditing(cell);
	};

	const cancelEdit = () => setEditing(null);

	const commitEdit = () => {
		const cell = editing;
		if (!cell) return;
		setEditing(null);
		const next = replaceCsvCell(props.content, spanOf(cell), draft, grid.delimiter);
		// 值没变就不要制造一次「脏」状态和一次落盘。
		if (next !== props.content) props.onChange?.(next);
	};

	const cellBody = (cell: EditingCell, value: string) => {
		const active = editing !== null && editing.row === cell.row && editing.col === cell.col;
		if (!active) {
			return editable && spanOf(cell) ? (
				<span className="cursor-text select-text" onDoubleClick={() => startEdit(cell)} title={t("editor.csvCellHint")}>
					{value}
				</span>
			) : (
				value
			);
		}
		return <CellEditor value={draft} onDraft={setDraft} onCommit={commitEdit} onCancel={cancelEdit} />;
	};

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
								<th key={colIndex} className="sticky top-0 z-10 max-w-[320px] truncate border border-border bg-muted px-2 py-1 text-left font-medium text-foreground">
									{cellBody({ row: -1, col: colIndex }, grid.header[colIndex] ?? "")}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{grid.rows.map((row, rowIndex) => (
							<tr key={rowIndex} className="hover:bg-muted/40">
								<th className="sticky left-0 z-10 border border-border bg-muted px-2 py-1 text-right font-normal text-muted-foreground">{rowIndex + 1}</th>
								{Array.from({ length: colCount }, (_, colIndex) => (
									<td key={colIndex} className="max-w-[320px] truncate border border-border px-2 py-1 align-top whitespace-pre">
										{cellBody({ row: rowIndex, col: colIndex }, row[colIndex] ?? "")}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<div className="shrink-0 border-t border-border px-3 py-1 text-caption text-muted-foreground">
				{grid.truncatedRows || grid.truncatedCols ? t("editor.csvTruncated", { rows: grid.rowCount, cols: Math.min(colCount, CSV_PREVIEW_MAX_COLS) }) : `${grid.rowCount} × ${colCount}`}
				{editable && <span className="ml-2 text-muted-foreground/80">{t("editor.csvEditHint")}</span>}
			</div>
		</div>
	);
}

/**
 * 单元格编辑器：Enter / 失焦提交、Esc 取消。
 * 值里本来就有换行（引号包裹的多行字段）时用 textarea，避免 input 把换行吃掉——
 * 那等于用户在不知情的情况下改了数据形状。
 */
function CellEditor(props: { value: string; onDraft: (value: string) => void; onCommit: () => void; onCancel: () => void }) {
	const multiline = props.value.includes("\n");
	const stopKeys = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			props.onCancel();
			return;
		}
		if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			props.onCommit();
		}
	};
	const className = "w-full min-w-[6rem] resize-none bg-background px-1 py-0.5 text-caption text-foreground outline-none ring-1 ring-ring";
	if (multiline) {
		return <textarea rows={Math.min(6, props.value.split("\n").length)} className={className} value={props.value} autoFocus onChange={(e) => props.onDraft(e.target.value)} onBlur={props.onCommit} onKeyDown={stopKeys} />;
	}
	return <input type="text" className={className} value={props.value} autoFocus onChange={(e) => props.onDraft(e.target.value)} onBlur={props.onCommit} onKeyDown={stopKeys} />;
}
