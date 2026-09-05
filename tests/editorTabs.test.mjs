import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 编辑器文件 Tab 预览/常驻纯策略（与 sessionTabs 同语义）。
 */

function loadEditorTabs() {
	const source = readFileSync("src/renderer/src/utils/editorTabs.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: "editorTabs.ts",
	}).outputText;
	const sandbox = { exports: {}, require: () => ({}) };
	vm.runInNewContext(output, sandbox, { filename: "editorTabs.ts" });
	return sandbox.exports;
}

const json = (value) => JSON.stringify(value);

function tab(id, filePath, tabKey, projectId) {
	const value = tabKey === undefined
		? { id, filePath }
		: { id, filePath, tabKey };
	return projectId === undefined
		? value
		: { ...value, fileAccessScope: { projectId } };
}

test("openPreviewEditorTab: 单击替换预览，不降级常驻 Tab", () => {
	const { openPreviewEditorTab } = loadEditorTabs();
	const first = openPreviewEditorTab(
		[tab("a", "/a.ts")],
		null,
		tab("b", "/b.ts"),
	);
	assert.equal(json(first.tabs.map((t) => t.id)), json(["a", "b"]));
	assert.equal(first.previewId, "b");
	assert.equal(first.activeId, "b");

	const replaced = openPreviewEditorTab(
		first.tabs,
		first.previewId,
		tab("c", "/c.ts"),
	);
	assert.equal(json(replaced.tabs.map((t) => t.id)), json(["a", "c"]));
	assert.equal(replaced.previewId, "c");

	const resident = openPreviewEditorTab(
		[tab("a", "/a.ts"), tab("c", "/c.ts")],
		"c",
		tab("new-a", "/a.ts"),
	);
	assert.equal(json(resident.tabs.map((t) => t.id)), json(["a", "c"]));
	assert.equal(resident.previewId, "c");
	assert.equal(resident.activeId, "a");
});

test("openPermanentEditorTab: 双击升格预览为常驻", () => {
	const { openPermanentEditorTab } = loadEditorTabs();
	const next = openPermanentEditorTab(
		[tab("a", "/a.ts"), tab("b", "/b.ts")],
		"b",
		tab("b", "/b.ts"),
	);
	assert.equal(json(next.tabs.map((t) => t.id)), json(["a", "b"]));
	assert.equal(next.previewId, null);
	assert.equal(next.activeId, "b");
});

test("openPermanentEditorTab: 新文件追加且保留其它预览", () => {
	const { openPermanentEditorTab } = loadEditorTabs();
	const next = openPermanentEditorTab(
		[tab("a", "/a.ts"), tab("p", "/p.ts")],
		"p",
		tab("b", "/b.ts"),
	);
	assert.equal(json(next.tabs.map((t) => t.id)), json(["a", "p", "b"]));
	assert.equal(next.previewId, "p");
	assert.equal(next.activeId, "b");
});

test("promotePreviewEditorTab: 仅清匹配的预览 id", () => {
	const { promotePreviewEditorTab } = loadEditorTabs();
	assert.equal(promotePreviewEditorTab("b", "b"), null);
	assert.equal(promotePreviewEditorTab("b", "a"), "b");
	assert.equal(promotePreviewEditorTab(null, "a"), null);
});

test("openPreviewEditorTab: 同 path+tabKey 才视为同一文件", () => {
	const { openPreviewEditorTab } = loadEditorTabs();
	const next = openPreviewEditorTab(
		[tab("a", "/a.ts", "k1")],
		null,
		tab("b", "/a.ts", "k2"),
	);
	assert.equal(json(next.tabs.map((t) => t.id)), json(["a", "b"]));
	assert.equal(next.previewId, "b");
});

test("editor tab identity keeps project-scoped buffers separate", () => {
	const { openPermanentEditorTab } = loadEditorTabs();
	const differentProject = openPermanentEditorTab(
		[tab("a", "/shared/file.ts", undefined, "project-a")],
		null,
		tab("b", "/shared/file.ts", undefined, "project-b"),
	);
	assert.equal(
		json(differentProject.tabs.map((t) => t.id)),
		json(["a", "b"]),
		"the same host path under another project authorization must get its own buffer",
	);

	const sameProject = openPermanentEditorTab(
		[tab("a", "/shared/file.ts", undefined, "project-a")],
		null,
		tab("b", "/shared/file.ts", undefined, "project-a"),
	);
	assert.equal(json(sameProject.tabs.map((t) => t.id)), json(["a"]));
	assert.equal(sameProject.activeId, "a");
});
