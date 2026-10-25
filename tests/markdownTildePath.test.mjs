import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkLinkifyPaths } from "../src/renderer/src/components/session/MarkdownLinkCore.ts";

/**
 * 回归：带 `~` 的路径不能被 markdown 单波浪线删除线劈开。
 *
 * 背景：remark-gfm 默认 singleTilde:true，`~1` 会被当作删除线定界符，
 * `C:\Users\ADMINI~1\...\file.md` 被撕成 `C:\Users\ADMINI` + `1\...`（del 节点），
 * 随后 remarkLinkifyPaths 只能拿到 `\AppData\...` 残缺路径 → 点击打开空文件。
 * 修复：会话 markdown 统一 singleTilde:false（GitHub 行为，`~~` 删除线不受影响）。
 */

const SRC = "反斜杠 C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\proj\\docs\\a.md 正斜杠 C:/Users/ADMINI~1/AppData/Local/Temp/proj/docs/b.md";

/** 与 MarkdownStream 相同的插件顺序跑一次 unified 管线（remark-parse → gfm → linkify） */
function runPipeline(text, gfmOptions) {
	const processor = unified().use(remarkParse).use(remarkGfm, gfmOptions).use(remarkLinkifyPaths);
	return processor.runSync(processor.parse(text));
}

function collect(node, out) {
	if (!node || typeof node !== "object") return;
	if (node.type === "link") out.links.push(node.url ?? "");
	if (node.type === "delete") out.deletes.push(renderText(node));
	if (Array.isArray(node.children)) {
		for (const child of node.children) collect(child, out);
	}
}

function renderText(node) {
	if (node.type === "text") return node.value ?? "";
	if (node.children) return node.children.map(renderText).join("");
	return "";
}

test("singleTilde:false keeps ~ in paths intact and linkifies full path (regression)", () => {
	const tree = runPipeline(SRC, { singleTilde: false });
	const out = { links: [], deletes: [] };
	collect(tree, out);
	// 不再产生删除线节点
	assert.equal(out.deletes.length, 0, `不应再出现 delete 节点：${out.deletes}`);
	// 两条绝对路径都被完整链接化（含 ~1 与盘符）
	assert.equal(out.links.length, 2, `应产出 2 个链接：${out.links}`);
	const urls = out.links.join(" ");
	// 反斜杠形态：file://C:%5CUsers%5CADMINI~1%5C...（encodeURIComponent + %3A→:）
	assert.match(urls, /file:\/\/C:%5CUsers%5CADMINI~1%5C/, `反斜杠路径应完整保留：${urls}`);
	// 正斜杠形态：file://C:/Users/ADMINI~1/...
	assert.match(urls, /file:\/\/C:\/Users\/ADMINI~1\//, `正斜杠路径应完整保留：${urls}`);
});

test("@@double tilde strikethrough still works with singleTilde:false", () => {
	const tree = runPipeline("这是 ~~删除线~~ 文本", { singleTilde: false });
	const out = { links: [], deletes: [] };
	collect(tree, out);
	assert.equal(out.deletes.length, 1);
	assert.match(out.deletes[0], /删除线/);
});

test("default singleTilde:true reproduces the bug (path gets split at ~)", () => {
	// 对照：旧配置（默认）确实把 ~1 路径撕碎——证明本条测试守护的是真实回归
	const tree = runPipeline(SRC, { singleTilde: true });
	const out = { links: [], deletes: [] };
	collect(tree, out);
	assert.ok(out.deletes.length > 0, "默认 gfm 会把 ~ 路径误判为删除线");
	// 且链接指向残缺路径（\\AppData 起头 / /AppData 起头）
	const mangled = out.links.some((url) => url.includes("file://%5CAppData") || url.includes("file:///AppData"));
	assert.ok(mangled, `默认 gfm 下链接指向残缺路径：${out.links}`);
});
