import assert from "node:assert/strict";
import test from "node:test";
import { CSV_PREVIEW_MAX_COLS, CSV_PREVIEW_MAX_ROWS, parseCsvGrid, replaceCsvCell, serializeCsvCell, sniffCsvDelimiter } from "../src/renderer/src/utils/csvGrid.ts";

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

test("cell spans point at the raw token, quotes included", () => {
	const text = 'a,b\n"1,2",3\n';
	const grid = parseCsvGrid(text);
	assert.equal(text.slice(grid.headerSpans[0].start, grid.headerSpans[0].end), "a");
	assert.equal(text.slice(grid.headerSpans[1].start, grid.headerSpans[1].end), "b");
	assert.equal(text.slice(grid.rowSpans[0][0].start, grid.rowSpans[0][0].end), '"1,2"');
	assert.equal(text.slice(grid.rowSpans[0][1].start, grid.rowSpans[0][1].end), "3");
	// 表头值不带引号（解析结果），但区间含引号（原文 token）
	assert.equal(grid.header[0], "a");
	assert.equal(grid.rows[0][0], "1,2");
});

test("replaceCsvCell rewrites exactly one token and keeps the rest byte-identical", () => {
	const text = 'name,note\r\n张三,"含,逗号"\r\nLi,"say ""hi"""\r\n';
	const grid = parseCsvGrid(text);
	// 改普通格：CRLF、引号风格、其它列全不动
	const one = replaceCsvCell(text, grid.rowSpans[0][0], "李四", grid.delimiter);
	assert.equal(one, 'name,note\r\n李四,"含,逗号"\r\nLi,"say ""hi"""\r\n');
	// 新值含分隔符 → 自动加引号
	const two = replaceCsvCell(text, grid.rowSpans[1][0], "a,b", grid.delimiter);
	assert.equal(two, 'name,note\r\n张三,"含,逗号"\r\n"a,b","say ""hi"""\r\n');
	// 新值含引号 → 双写转义
	const three = replaceCsvCell(text, grid.rowSpans[1][1], 'x"y', grid.delimiter);
	assert.equal(three, 'name,note\r\n张三,"含,逗号"\r\nLi,"x""y"\r\n');
	// 改成空串：整个 token 消失，不留 ""
	const four = replaceCsvCell(text, grid.rowSpans[0][0], "", grid.delimiter);
	assert.equal(four, 'name,note\r\n,"含,逗号"\r\nLi,"say ""hi"""\r\n');
});

test("replaceCsvCell respects a BOM offset and missing spans", () => {
	const text = '\uFEFFa,b\n1,2\n';
	const grid = parseCsvGrid(text);
	assert.equal(replaceCsvCell(text, grid.rowSpans[0][1], "9", grid.delimiter), '\uFEFFa,b\n1,9\n');
	// 区间缺失（列被截断 / 该行没有这一列）时原样返回
	assert.equal(replaceCsvCell(text, undefined, "9", grid.delimiter), text);
	assert.equal(replaceCsvCell(text, null, "9", grid.delimiter), text);
	// 截断掉的列没有区间
	const narrow = parseCsvGrid("a,b\n1,2\n", { maxCols: 1 });
	assert.equal(narrow.rowSpans[0].length, 1);
	assert.equal(narrow.rowSpans[0][1], undefined);
});

test("replaceCsvCell quotes only when the value needs it", () => {
	assert.equal(serializeCsvCell("plain", ","), "plain");
	assert.equal(serializeCsvCell("a,b", ","), '"a,b"');
	assert.equal(serializeCsvCell('a"b', ","), '"a""b"');
	assert.equal(serializeCsvCell("a\nb", ","), '"a\nb"');
	assert.equal(serializeCsvCell("", ","), "");
	// 分隔符是制表符时，逗号不需要引号
	assert.equal(serializeCsvCell("a,b", "\t"), "a,b");
});
