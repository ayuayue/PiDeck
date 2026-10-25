import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { chipIconDomSpec, CHIP_ICON_PATHS } = loadTsCommonJs("src/renderer/src/components/session/composer/chipIcons.ts");

const SVG_NS = "http://www.w3.org/2000/svg";
const CHIP_KINDS = ["file", "skill", "session", "quote"];

/**
 * 回归（用户实测：输入框 chip 只剩色块、引号不见了）：
 * ProseMirror 的 renderSpec 只在 tagName 含空格时才走 createElementNS
 * （见 prosemirror-model renderSpec：`tagName.indexOf(" ")` → xmlNS）。
 * 旧 spec 写成 ["svg", …] 会 `createElement("svg")` 建出 HTML 命名空间的伪 svg，
 * 其 path 子节点同样不在 SVG 命名空间 → 图标完全不渲染。
 * 旧版靠 @ / & ❝ 文字前缀掩盖了这个 bug；对齐 Proma 去掉前缀后彻底暴露。
 */
test("chip icon DOM spec declares the SVG namespace on the tag", () => {
	for (const kind of CHIP_KINDS) {
		const spec = chipIconDomSpec(kind);
		assert.equal(spec[0], `${SVG_NS} svg`, `${kind} icon tag must be namespaced`);
	}
	const attrs = chipIconDomSpec("quote")[1];
	assert.equal(attrs.class, "input-chip__icon");
	assert.equal(attrs.stroke, "currentColor");
	assert.equal(attrs.width, "12px");
	assert.equal(attrs.height, "12px");
	assert.equal(attrs.viewBox, "0 0 24 24");
});

test("path children keep the namespace and carry the icon data", () => {
	for (const kind of CHIP_KINDS) {
		const children = chipIconDomSpec(kind).slice(2);
		assert.ok(children.length > 0, `${kind} icon must have path children`);
		for (const child of children) {
			assert.equal(child[0], "path");
			assert.ok(child[1].d.length > 0);
		}
	}
});

test("directory file chips switch to the folder icon", () => {
	const directory = chipIconDomSpec("file", { isDirectory: true });
	assert.equal(directory[0], `${SVG_NS} svg`);
	const folderPaths = directory.slice(2).map((child) => child[1].d);
	assert.deepEqual(folderPaths, CHIP_ICON_PATHS.folder);

	const file = chipIconDomSpec("file");
	assert.deepEqual(
		file.slice(2).map((child) => child[1].d),
		CHIP_ICON_PATHS.file,
	);
});

test("every chip kind (plus folder) ships icon path data", () => {
	for (const kind of [...CHIP_KINDS, "folder"]) {
		assert.ok(CHIP_ICON_PATHS[kind].length > 0, `${kind} must have path data`);
	}
});
