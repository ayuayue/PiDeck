import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import vm from "node:vm";

function loadRichTextModule() {
	const source = readFileSync("src/main/feishu/rich-text.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {}, Buffer };
	vm.runInNewContext(outputText, sandbox, { filename: "rich-text.ts" });
	return sandbox.exports;
}

const tableMarkdown = ["当前工作区有以下文件：", "", "| 文件 | 大小 | 日期 |", "|------|------|------|", "| `temp.pdf` | 352KB | 06-29 |"].join("\n");

test("routes markdown tables to interactive cards with table elements", () => {
	const { chooseMessageMode } = loadRichTextModule();

	assert.equal(chooseMessageMode(tableMarkdown), "interactive");
});

test("renders markdown tables as Feishu card table elements", () => {
	const { buildMarkdownCards } = loadRichTextModule();
	const [card] = buildMarkdownCards(tableMarkdown);
	const elements = card.body.elements;
	const table = elements.find((element) => element.tag === "table");

	assert.ok(table, "expected a Feishu table element");
	assert.deepEqual(
		Array.from(table.columns, (column) => column.display_name),
		["文件", "大小", "日期"],
	);
	assert.deepEqual(
		{ ...table.rows[0] },
		{
			col_0: "temp.pdf",
			col_1: "352KB",
			col_2: "06-29",
		},
	);
	assert.equal(
		elements.some((element) => element.tag === "markdown" && /\|------\|/.test(element.content)),
		false,
	);
});
