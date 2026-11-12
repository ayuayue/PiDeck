import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rendererAppSource } from "./helpers/rendererAppSources.mjs";

const menuSource = readFileSync("src/renderer/src/components/session/ComposerOverlayComponents.tsx", "utf8");
const appSource = rendererAppSource;

/** 从 indexOf(start) 到 indexOf(end) 之间截一段源码，缺失时直接失败而不是切出空串。 */
function sliceBetween(source, start, end) {
	const from = source.indexOf(start);
	assert.ok(from !== -1, `源码里找不到起点：${start}`);
	const to = source.indexOf(end, from);
	assert.ok(to > from, `源码里找不到终点：${end}`);
	return source.slice(from, to);
}

// 文件树右键「新建文件/新建文件夹」曾在文件侧栏重写时整体丢失（e8af29d01 引入、WorkspaceSurface 迁移时消失）。
// 这里守住两件事：入口回到菜单里，且点击后真的调用创建 API 并刷新树。
test("FileContextMenu：右键菜单在引用之前提供新建文件/新建文件夹", () => {
	assert.match(menuSource, /onCreate\?: \(targetDir: string \| ProjectFileTarget, kind: "file" \| "directory"\) => void;/);
	// 目标目录复用「粘贴」那条换算（目录=自身、文件=父目录）；节点没有可写目标时整组不出现
	const createBlock = sliceBetween(menuSource, "props.onCreate && targetDir && (", "<DropdownMenuItem onSelect={props.onAttach}>");
	assert.match(createBlock, /props\.onCreate\?\.\(targetDir, "file"\)[\s\S]*\{t\("drawer\.newFile"\)\}/);
	assert.match(createBlock, /props\.onCreate\?\.\(targetDir, "directory"\)[\s\S]*\{t\("drawer\.newFolder"\)\}/);
	// 新建与后续只读操作之间要分隔，避免误点
	assert.match(createBlock, /<DropdownMenuSeparator \/>/);
});

test("App：菜单回调打开新建对话框并按当前节点目标目录建条目", () => {
	const createHandler = sliceBetween(appSource, "onCreate={(target, kind) => {", "onDelete={() => {");
	assert.match(createHandler, /setCreatingFile\(\{ target, kind \}\)/);
	assert.match(createHandler, /setFileMenu\(null\)/);

	const dialog = sliceBetween(appSource, "fileCreate={", "fileRename={");
	assert.match(dialog, /api\.files\s*\.create\(creatingFile\.target, name, creatingFile\.kind\)/);
	// 建完必须刷新文件树（静默，不再叠一层「已刷新」提示），否则新条目看不见；失败要让用户看到原因
	assert.match(dialog, /refreshVisibleFiles\(undefined, true\)/);
	assert.match(dialog, /"app\.folderCreated" : "app\.fileCreated"/);
	assert.match(dialog, /"app\.fileCreateFailed"/);
});
