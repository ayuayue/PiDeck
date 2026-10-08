import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import vm from "node:vm";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

// FeishuI18n 现在带运行时依赖（繁体词典 ./FeishuI18n.zh-TW + 简繁判定 shared/types/settings），
// 交给统一加载器按源文件目录解析；手写沙箱少了 require 桥就会整片失败。
const i18n = createTsSandbox()("src/main/feishu/FeishuI18n.ts");

function transpile(path) {
	const source = readFileSync(path, "utf8");
	return ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadRichTextModule() {
	const sandbox = { exports: {}, Buffer };
	vm.runInNewContext(transpile("src/main/feishu/rich-text.ts"), sandbox, { filename: "rich-text.ts" });
	return sandbox.exports;
}

function loadCardRendererModule() {
	const richText = loadRichTextModule();
	const sandbox = {
		exports: {},
		require: (name) => {
			if (name === "./rich-text") return richText;
			if (name === "./FeishuI18n") return i18n;
			throw new Error(`unexpected require: ${name}`);
		},
	};
	vm.runInNewContext(transpile("src/main/feishu/CardRenderer.ts"), sandbox, { filename: "CardRenderer.ts" });
	return sandbox.exports;
}

const tableMarkdown = ["工作区里目前有这些文件：", "", "| 文件 | 大小 | 时间 |", "|------|------|------|", "| `temp.pdf` | 360KB | 6月29日 |"].join("\n");

test("streaming run card renders output markdown tables as Feishu table elements", () => {
	const { renderRunCard } = loadCardRendererModule();
	const card = renderRunCard({
		blocks: [],
		reasoning: { content: "", active: false },
		footer: null,
		terminal: "done",
		startedAt: Date.now(),
		meta: { durationMs: 1200 },
		trail: [],
		outputText: tableMarkdown,
	});
	const table = card.elements.find((element) => element.tag === "table");

	assert.ok(table, "expected streaming card output to contain a Feishu table element");
	assert.deepEqual(
		Array.from(table.columns, (column) => column.display_name),
		["文件", "大小", "时间"],
	);
	assert.deepEqual(
		{ ...table.rows[0] },
		{
			col_0: "temp.pdf",
			col_1: "360KB",
			col_2: "6月29日",
		},
	);
	assert.equal(
		card.elements.some((element) => element.tag === "markdown" && /\|------\|/.test(element.content)),
		false,
	);
});
