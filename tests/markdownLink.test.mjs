import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as markdownCore from "../src/renderer/src/components/session/MarkdownLinkCore.ts";
const { remarkLinkifyPaths } = markdownCore;

/**
 * 链接处理修复回归（issue #115 链接问题）：
 * 1. 全角标点不再被吞进路径（src/a.ts， 只匹配 src/a.ts）
 * 2. 中文/Unicode 目录与文件名支持
 * 3. 真实路径仍被识别为 file:// 链接
 * 4. 代码块/行内代码/link 节点不被处理
 */

/** 用 remarkLinkifyPaths 处理 mdast 树，返回转换后的链接列表 */
function linkify(text) {
	const tree = {
		type: "root",
		children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
	};
	const plugin = remarkLinkifyPaths();
	plugin(tree);
	const links = [];
	const walk = (node) => {
		if (!node || typeof node !== "object") return;
		if (node.type === "link") links.push(node.url);
		if (Array.isArray(node.children)) node.children.forEach(walk);
	};
	walk(tree);
	return links;
}

test("real paths still linkify (relative, absolute, unicode)", () => {
	assert.deepEqual(linkify("看 src/main/index.ts"), ["file://src/main/index.ts"]);
	// 中文/反斜杠经 encodeURIComponent 编码（解码后还原原路径）
	const absLinks = linkify("路径 D:\\项目\\文件.ts");
	assert.equal(absLinks.length, 1);
	assert.ok(absLinks[0].startsWith("file://D:%5C"));
	assert.equal(decodeURIComponent(absLinks[0].slice(7)), "D:\\项目\\文件.ts");
	assert.deepEqual(linkify("参考 ./docs/guide.md"), ["file://./docs/guide.md"]);
	assert.deepEqual(linkify("上级 ../src/a.ts"), ["file://../src/a.ts"]);
	// 中文目录与文件名
	// 中文目录与文件名（编码后解码还原）
	const zhLinks = linkify("模块 src/项目/工具.ts 已更新");
	assert.equal(zhLinks.length, 1);
	assert.equal(decodeURIComponent(zhLinks[0].slice(7)), "src/项目/工具.ts");
	// 多级目录
	assert.deepEqual(linkify("组件 src/components/Button.tsx"), ["file://src/components/Button.tsx"]);
});

test("full-width punctuation is not swallowed into the path", () => {
	// 修复前：src/a.ts， 会匹配 src/a.ts， （全角逗号被吞）→ 点击打开不存在的文件
	assert.deepEqual(linkify("改了 src/a.ts，src/b.ts"), ["file://src/a.ts", "file://src/b.ts"]);
	assert.deepEqual(linkify("见 foo/bar.md：说明"), ["file://foo/bar.md"]);
	assert.deepEqual(linkify("a.ts）说明"), []);
	assert.deepEqual(linkify("完成（src/ok.ts）了"), ["file://src/ok.ts"]);
	assert.deepEqual(linkify("参考 docs/guide.md。"), ["file://docs/guide.md"]);
});

test("special symbols are excluded (arrows, multiplication, ellipsis)", () => {
	assert.deepEqual(linkify("升级 src/a.ts → src/b.ts"), ["file://src/a.ts", "file://src/b.ts"]);
	assert.deepEqual(linkify("对比 a.ts × b.ts"), []);
	assert.deepEqual(linkify("见 src/x.ts…"), ["file://src/x.ts"]);
});

test("code blocks stay inert while inline-code file references become links", () => {
	const tree = {
		type: "root",
		children: [
			{ type: "code", value: "const p = 'src/a.ts';" },
			{
				type: "paragraph",
				children: [
					{ type: "inlineCode", value: "src/b.ts:12" },
					{ type: "text", value: " and " },
					{ type: "inlineCode", value: "foo()" },
				],
			},
		],
	};
	const plugin = remarkLinkifyPaths();
	plugin(tree);
	const links = [];
	const walk = (node) => {
		if (!node || typeof node !== "object") return;
		if (node.type === "link") links.push(node);
		if (Array.isArray(node.children)) node.children.forEach(walk);
	};
	walk(tree);
	assert.equal(links.length, 1);
	assert.equal(decodeURIComponent(links[0].url.slice(7)), "src/b.ts:12");
	assert.deepEqual(links[0].children, [{ type: "inlineCode", value: "src/b.ts:12" }]);
});

test("inline-code file references reject URI schemes and tolerate standalone filenames", () => {
	const { isStandaloneFileReference } = markdownCore;
	assert.equal(isStandaloneFileReference("src/main/index.ts:42"), true);
	assert.equal(isStandaloneFileReference("package.json:1"), true);
	assert.equal(isStandaloneFileReference("C:\\\\project\\\\main.ts:20"), true);
	assert.equal(isStandaloneFileReference("https://example.com/src/main.ts"), false);
	assert.equal(isStandaloneFileReference("file://src/main.ts"), false);
	assert.equal(isStandaloneFileReference("vscode://file/src/main.ts"), false);
	assert.equal(isStandaloneFileReference("main.ts"), true);
	assert.equal(isStandaloneFileReference("not a file.ts"), false);
	assert.equal(isStandaloneFileReference("src/main/index.ts extra"), false);
});

test("markdown links (link nodes) are not double-processed", () => {
	const tree = {
		type: "root",
		children: [
			{
				type: "paragraph",
				children: [
					{
						type: "link",
						url: "docs/guide.md",
						children: [{ type: "text", value: "guide" }],
					},
				],
			},
		],
	};
	const plugin = remarkLinkifyPaths();
	plugin(tree);
	const links = [];
	const walk = (node) => {
		if (!node || typeof node !== "object") return;
		if (node.type === "link") links.push(node.url);
		if (Array.isArray(node.children)) node.children.forEach(walk);
	};
	walk(tree);
	// link 节点原样保留（无 file:// 前缀），由 MarkdownLink 点击时按本地路径处理
	assert.deepEqual(links, ["docs/guide.md"]);
});

test("file name without directory segment is not linkified (avoid false positives)", () => {
	assert.deepEqual(linkify("file.ts 和 main.ts 都改了"), []);
	assert.deepEqual(linkify("版本 2.0 发布"), []);
});

// issue #229 第二项：无后缀目录 / 白名单无后缀文件也要能点击（识别层放宽）。
test("suffix-less directories and nameless files linkify end to end", () => {
	assert.deepEqual(linkify("改 src/main/ipc 里的实现"), ["file://src/main/ipc"]);
	assert.deepEqual(linkify("看 src/renderer/src/components 与 docs/"), ["file://src/renderer/src/components", "file://docs/"]);
	assert.deepEqual(linkify("配置在 Makefile 和 .gitignore"), ["file://Makefile", "file://.gitignore"]);
	assert.deepEqual(linkify("看 C:\\proj\\src"), ["file://C:%5Cproj%5Csrc"]);
	// 目录候选不得截断更长的文件路径
	assert.deepEqual(linkify("入口 src/main/index.ts"), ["file://src/main/index.ts"]);
	// 行内代码里的目录/无后缀文件（反引号包裹是模型最常用的写法）
	const { isStandaloneFileReference } = markdownCore;
	assert.equal(isStandaloneFileReference("src/main/ipc"), true);
	assert.equal(isStandaloneFileReference("docs/"), true);
	assert.equal(isStandaloneFileReference("Makefile"), true);
});

// 放宽识别后最容易出问题的是英文散文与斜杠列表：端到端锁住「不产生链接」。
test("prose slash lists and bare words stay inert after widening recognition", () => {
	for (const text of ["and/or 关系", "TCP/IP 协议", "CI/CD 流水线", "24/7 全天候", "components 目录", "改 src/main 目录"]) {
		assert.deepEqual(linkify(text), [], text);
	}
	const { isStandaloneFileReference } = markdownCore;
	assert.equal(isStandaloneFileReference("and/or"), false);
	assert.equal(isStandaloneFileReference("TCP/IP"), false);
	assert.equal(isStandaloneFileReference("main"), false);
	assert.equal(isStandaloneFileReference("xMakefile"), false);
});

// 线上回归（中文散文被误识别成目录 → 存在性判否 → 灰字）：整段真实回复必须零链接。
test("Chinese prose paragraphs stay inert end to end", () => {
	const paragraph = "学术上早就有定论：MSR/Princeton 的 VideoStorm（NSDI'17）就是专门研究这个问题——视频分析算力永远不够，必须靠近似（降分辨率/抽帧）和延迟容忍来在集群上同时服务成千上万条查询。";
	assert.deepEqual(linkify(paragraph), []);
	assert.deepEqual(linkify("隐私合规（GDPR/《个保法》，Toronto Sidewalk Labs 就是被社区抵制而夭折）三道墙都过不去。"), []);
	assert.deepEqual(linkify("1080p @ 4Mbps ≈ 1.3 TB/摄像头/30 天"), []);
	// 真路径仍然链接化：全 ASCII 多段目录紧贴中文也认
	assert.deepEqual(linkify("改 src/main/和 utils/ 里的实现"), ["file://src/main/", "file://utils/"]);
});

// 失效链接的降级形态（组件需要 React 渲染，按仓库既有做法锁源码契约）：
// file:// 是 remarkLinkifyPaths 自动识别的裸路径，作者从未声明成链接，误识别/幻觉
// 路径必须按普通正文渲染；无协议 href 才是作者显式写的链接，失效时保留灰字提示。
test("missing auto-linkified paths degrade to plain text, explicit links keep the gray hint", () => {
	const source = readFileSync("src/renderer/src/components/session/MarkdownLink.tsx", "utf8");
	assert.match(source, /pathExists === false[\s\S]{0,200}?isFileLink\s*\?\s*<>\{children\}<\/>\s*:\s*<span[\s\S]{0,40}?className="text-text-tertiary">\{children\}<\/span>/);
});

test("isLocalPathRef: protocol-less hrefs are local paths, real URLs are not", () => {
	const { isLocalPathRef } = markdownCore;
	assert.equal(isLocalPathRef("docs/guide.md"), true);
	assert.equal(isLocalPathRef("./src/a.ts"), true);
	assert.equal(isLocalPathRef("D:/x/y.md"), true);
	assert.equal(isLocalPathRef("https://example.com/a.md"), false);
	assert.equal(isLocalPathRef("http://x"), false);
	assert.equal(isLocalPathRef("mailto:a@b.com"), false);
	assert.equal(isLocalPathRef("file:///x"), false);
	assert.equal(isLocalPathRef("javascript:alert(1)"), false);
	assert.equal(isLocalPathRef("#section"), false);
	assert.equal(isLocalPathRef("//cdn.example.com/x"), false);
	assert.equal(isLocalPathRef(""), false);
});

test("defaultUrlTransform keeps local file hrefs on win/mac/linux and clears unsafe protocols", () => {
	const { defaultUrlTransform } = markdownCore;
	// Windows：裸盘符（F:/、F:\\）+ 行号不能当协议清空（回归：href 被清 → 点击无反应）
	assert.equal(defaultUrlTransform("F:/PiDeck/packages/dsh-tool-pwsh-persistent/src/index.ts:309"), "F:/PiDeck/packages/dsh-tool-pwsh-persistent/src/index.ts:309");
	assert.equal(defaultUrlTransform("C:\\Users\\x\\a.ts:12"), "C:\\Users\\x\\a.ts:12");
	// mac/linux：POSIX 绝对路径（/ 开头 + 行号）本就被「首个冒号在斜杠后」规则放行
	assert.equal(defaultUrlTransform("/Users/x/proj/src/app.py:12:4"), "/Users/x/proj/src/app.py:12:4");
	assert.equal(defaultUrlTransform("/home/u/proj/a.md"), "/home/u/proj/a.md");
	// 相对路径与行号
	assert.equal(defaultUrlTransform("src/main/index.ts"), "src/main/index.ts");
	assert.equal(defaultUrlTransform("docs/guide.md:8"), "docs/guide.md:8");
	// 外链照常、危险协议照常拦截
	assert.equal(defaultUrlTransform("https://example.com/a.md"), "https://example.com/a.md");
	assert.equal(defaultUrlTransform("javascript:alert(1)"), "");
	assert.equal(defaultUrlTransform("ftp://x/y"), "");
});
