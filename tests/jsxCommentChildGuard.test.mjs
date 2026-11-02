import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import ts from "typescript";

/**
 * JSX 子节点注释守卫。
 *
 * 为什么：在 JSX 的 children 位置写 `// 注释`（而不是 `{/* 注释 *\/}`），那不是注释，
 * 是**文本子节点**。两种后果都会真实发生：
 *   1. 那段说明文字被渲染进 DOM，出现在用户界面上；
 *   2. 父元素变成「两个子节点」，一旦外面套了 Radix 的 `asChild`（Slot 只接受单个
 *      React 元素），渲染期直接抛 `Primitive.div failed to slot onto its children`，
 *      整个渲染树崩掉。2026-11 就是因为 select.tsx 里一行 `// scroll-ok: …` 落在
 *      <SelectPrimitive.Portal> 的 children 位置，冷启动即白屏。
 *
 * 判据：用 TS 解析器取 JsxText children，任何一行 trim 后以 `//` 开头就是缺陷。
 * 只认 AST，不认正则——`"<div>// 不是注释</div>"` 这种字符串、以及开标签属性位置上的
 * `//`（那里确实是 JS 注释）都不该误判。
 */

const ROOT = process.cwd();
const RENDERER_SRC = join(ROOT, "src/renderer/src");

/** 扫一个 tsx 源码文本，返回 JSX 文本子节点里以 // 开头的行。 */
export function scanSource(fileName, text) {
	const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const violations = [];
	const visit = (node) => {
		if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
			for (const child of node.children) {
				if (child.kind !== ts.SyntaxKind.JsxText) continue;
				const raw = child.getText();
				for (const line of raw.split(/\r?\n/)) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("//")) continue;
					violations.push({ line: sf.getLineAndCharacterOfPosition(child.getStart()).line + 1, text: trimmed.slice(0, 100) });
					break;
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return violations;
}

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith(".tsx")) out.push(full);
	}
	return out;
}

test("JSX children 里不许出现 // 注释（会变成文本子节点，asChild 下直接抛错）", () => {
	const violations = [];
	for (const file of walk(RENDERER_SRC)) {
		for (const v of scanSource(file, readFileSync(file, "utf8"))) {
			violations.push(`${relative(ROOT, file).replace(/\\/g, "/")}:${v.line}  ${v.text}`);
		}
	}
	assert.deepEqual(violations, [], "这些 // 写在 JSX children 位置，等于渲染一段文字：改成 {/* … */}，或把注释挪到 return 之前");
});

test("判据自己的反例样本：children 位置的 // 必须被抓到", () => {
	const bad = ["const A = () => (", "  <Portal>", "    // scroll-ok: bounded 说明文字", "    <Content />", "  </Portal>", ");"].join("\n");
	assert.equal(scanSource("Bad.tsx", bad).length, 1);

	// 一行里既有元素又有 // 文本，同样算缺陷
	const inline = ["const B = () => (", "  <div>", "    // 说明", "    <span />", "  </div>", ");"].join("\n");
	assert.equal(scanSource("Inline.tsx", inline).length, 1);
});

test("判据不误伤：JSX 注释、属性位置的 //、字符串里的 // 都不算", () => {
	const good = ["const C = () => (", "  <Portal>", "    {/* scroll-ok: bounded 说明文字 */}", "    <Content", "      // 属性位置：这里是真的 JS 注释", '      side="top"', "    >", '      {"// 字符串里的斜杠不是注释"}', "    </Content>", "  </Portal>", ");"].join("\n");
	assert.deepEqual(scanSource("Good.tsx", good), []);
});
