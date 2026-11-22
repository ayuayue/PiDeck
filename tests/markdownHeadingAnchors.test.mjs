/**
 * README/长文档目录跳转（`- [架构](#架构)` 点击后滚到对应标题）的回归。
 *
 * 三条链路缺一不可，这里分别锁住：
 * 1. 标题拿到 GitHub 兼容的 slug id（锚点是作者按 GitHub 效果手写的，必须同口径）
 * 2. id 能活过 sanitize 白名单（写错位置会被 rehype-sanitize 整条摘掉）
 * 3. 链接侧把 `#xxx` 当页内跳转，而不是交给 onOpenExternal 打开浏览器
 */
import assert from "node:assert/strict";
import test from "node:test";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { toHtml } from "hast-util-to-html";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { githubHeadingSlug, anchorIdFromHref } = loadTsCommonJs("src/renderer/src/components/session/markdownHeadingAnchors.ts");
const { UNTRUSTED_MARKDOWN_REHYPE_PLUGINS } = loadTsCommonJs("src/renderer/src/components/session/markdownSanitize.ts");

/** 与 MarkdownStream settle 路径同构：raw → 摘危险子树 → sanitize → 标题锚点。 */
function render(markdown) {
	const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).use(UNTRUSTED_MARKDOWN_REHYPE_PLUGINS);
	return toHtml(processor.runSync(processor.parse(markdown)));
}

test("slug 与 GitHub 同口径：中英文、行内代码、标点、emoji", () => {
	assert.equal(githubHeadingSlug("架构总览"), "架构总览");
	assert.equal(githubHeadingSlug("API Reference"), "api-reference");
	// 序号点号被丢弃，空格换连字符
	assert.equal(githubHeadingSlug("1. 安装 Install"), "1-安装-install");
	// 行内代码的文本参与 slug（反引号本身由 markdown 解析剥离）
	assert.equal(githubHeadingSlug("使用 `pnpm` 安装"), "使用-pnpm-安装");
	// 下划线与连字符保留，其余 ASCII 标点丢弃
	assert.equal(githubHeadingSlug("a_b-c (草稿)"), "a_b-c-草稿");
	// 中文标点/emoji 丢弃
	assert.equal(githubHeadingSlug("🎉 发布！"), "-发布");
});

test("标题写出 id，重名依次追加 -1/-2；作者手写 id 保留", () => {
	const html = render('# 架构\n\n## 配置\n\n## 配置\n\n## 配置\n\n<h2 id="keep-me">自定义</h2>');
	assert.match(html, /<h1 id="架构">/);
	assert.match(html, /<h2 id="配置">/);
	assert.match(html, /<h2 id="配置-1">/);
	assert.match(html, /<h2 id="配置-2">/);
	// 原始 HTML 标题的 id 被 sanitize 加了 user-content- 前缀（GitHub 同款防重名），
	// 内容不被覆盖，也不参与去重计数；滚动侧会按前缀再找一次
	assert.match(html, /<h2 id="user-content-keep-me">/);
});

test('纯符号标题不生成空 id（否则会渲染出 id=""）', () => {
	const html = render("# ###\n\n## 🎉");
	assert.doesNotMatch(html, /<h1 id="">/);
	assert.doesNotMatch(html, /<h2 id="">/);
});

test("目录链接原样保留（点击语义交给 MarkdownLink）", () => {
	const html = render("# 架构\n\n- [架构](#架构)\n- [编码](#%E7%BC%96%E7%A0%81)\n");
	assert.match(html, /<h1 id="架构">/);
	// 标题 id 是原文字面值，目录 href 被 remark-rehype 百分号编码（anchorIdFromHref 负责解码）
	assert.match(html, /href="#%E6%9E%B6%E6%9E%84"/);
	// 百分号编码的锚点不能被 sanitize/urlTransform 清空
	assert.match(html, /href="#%E7%BC%96%E7%A0%81"/);
});

test("anchorIdFromHref：只有 # 页内锚点算跳转，外链/本地文件/空锚点不算", () => {
	assert.equal(anchorIdFromHref("#架构"), "架构");
	assert.equal(anchorIdFromHref("#%E6%9E%B6%E6%9E%84"), "架构");
	assert.equal(anchorIdFromHref("  #架构  "), "架构");
	// 非法百分号编码不抛错，原样当 id
	assert.equal(anchorIdFromHref("#100%覆盖"), "100%覆盖");
	assert.equal(anchorIdFromHref("#"), null);
	assert.equal(anchorIdFromHref(""), null);
	assert.equal(anchorIdFromHref(undefined), null);
	assert.equal(anchorIdFromHref("https://example.com/a.md#x"), null);
	assert.equal(anchorIdFromHref("docs/guide.md#x"), null);
});
