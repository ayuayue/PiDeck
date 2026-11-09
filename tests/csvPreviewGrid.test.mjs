import assert from "node:assert/strict";
import test from "node:test";
import { CSV_PREVIEW_MAX_COLS, CSV_PREVIEW_MAX_ROWS, parseCsvGrid, sniffCsvDelimiter } from "../src/renderer/src/utils/csvGrid.ts";

/**
 * 文件预览把 CSV 从原始文本换成表格后，这些契约必须成立：
 * 1. 引号内的分隔符/换行是数据，不是结构（Excel 导出的地址、备注一定会踩到）；
 * 2. 分隔符按首行嗅探，TSV/欧洲分号导出不能退化成单列；
 * 3. 截断在解析阶段完成，行/列上限之外的内容不进 DOM。
 */

test("csv grid keeps quoted delimiters and escaped quotes", () => {
	const grid = parseCsvGrid('name,note,city\n张三,"含,逗号",北京\nLi Si,"say ""hi""",上海\n');
	assert.deepEqual(grid.header, ["name", "note", "city"]);
	assert.deepEqual(grid.rows, [
		["张三", "含,逗号", "北京"],
		["Li Si", 'say "hi"', "上海"],
	]);
	assert.equal(grid.rowCount, 2);
	assert.equal(grid.colCount, 3);
	assert.equal(grid.truncatedRows, false);
});

test("csv grid tolerates CRLF, BOM and missing trailing newline", () => {
	const grid = parseCsvGrid("\uFEFFa,b\r\n1,2\r\n3,4");
	assert.deepEqual(grid.header, ["a", "b"]);
	assert.deepEqual(grid.rows, [
		["1", "2"],
		["3", "4"],
	]);
});

test("csv grid sniffs tsv and semicolon exports", () => {
	assert.equal(sniffCsvDelimiter("a\tb\tc\n1\t2\t3"), "\t");
	assert.equal(sniffCsvDelimiter("a;b;c\n1;2;3"), ";");
	// 首行没有分隔符时退回逗号，而不是被正文的制表符带偏
	assert.equal(sniffCsvDelimiter("single\n1\t2"), ",");
	const tsv = parseCsvGrid("a\tb\n1\t2\n");
	assert.deepEqual(tsv.header, ["a", "b"]);
	assert.deepEqual(tsv.rows, [["1", "2"]]);
});

test("csv grid truncates rows and columns at the preview window", () => {
	const lines = [Array.from({ length: CSV_PREVIEW_MAX_COLS + 5 }, (_, i) => `h${i}`).join(",")];
	for (let i = 0; i < CSV_PREVIEW_MAX_ROWS + 10; i += 1) lines.push(`v${i}`);
	const grid = parseCsvGrid(lines.join("\n"));
	assert.equal(grid.colCount, CSV_PREVIEW_MAX_COLS);
	assert.equal(grid.rowCount, CSV_PREVIEW_MAX_ROWS);
	assert.equal(grid.truncatedRows, true);
	assert.equal(grid.truncatedCols, true);
});

test("csv grid reports an empty file instead of a phantom row", () => {
	const grid = parseCsvGrid("");
	assert.deepEqual(grid.header, []);
	assert.deepEqual(grid.rows, []);
	assert.equal(grid.colCount, 0);
	const blank = parseCsvGrid("\n\n,\n");
	assert.equal(blank.rows.length, 0);
});
