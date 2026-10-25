import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { FileTreeIndentGuides } = loadTsCommonJs("src/renderer/src/components/session/FileTreeIndentGuides.tsx");

/** 从实际组件的公开渲染结果读取祖先线数量。 */
function renderGuides(depth) {
	return renderToStaticMarkup(createElement(FileTreeIndentGuides, { depth }));
}

test("根目录没有虚构的祖先引导线", () => {
	assert.equal(renderGuides(0), "");
});

test("每行只渲染自身深度对应的祖先引导线", () => {
	for (const depth of [1, 2, 4]) {
		const markup = renderGuides(depth);
		const levels = [...markup.matchAll(/data-file-tree-guide-level="(\d+)"/g)].map((match) => Number(match[1]));
		assert.deepEqual(
			levels,
			Array.from({ length: depth }, (_, level) => level),
		);
	}
});

test("引导线是对辅助技术隐藏的装饰，不成为额外交互目标", () => {
	const markup = renderGuides(3);
	assert.match(markup, /aria-hidden="true"/);
	assert.doesNotMatch(markup, /<(?:button|input|a)\b/);
	assert.doesNotMatch(markup, /tabindex=/i);
});
