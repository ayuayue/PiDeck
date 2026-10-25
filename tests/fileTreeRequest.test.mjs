import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { loadProjectFileTree, shouldApplyFileTreeResult } = loadTsCommonJs("src/renderer/src/utils/fileTreeLazy.ts");

function file(name, path) {
	return { name, path, relativePath: name, type: "file" };
}

test("shouldApplyFileTreeResult rejects a stale project or generation", () => {
	assert.equal(shouldApplyFileTreeResult("a", "a", 2, 2), true);
	// 项目已切走：旧 listing 即使代次碰巧相同也不能写入。
	assert.equal(shouldApplyFileTreeResult("a", "b", 2, 2), false);
	// 同项目但已发起更新的请求：旧代次必须丢弃。
	assert.equal(shouldApplyFileTreeResult("a", "a", 1, 2), false);
});

test("loadProjectFileTree returns null when the request is superseded mid-flight", async () => {
	let current = "A";
	let resolveA;
	const pendingA = new Promise((resolve) => {
		resolveA = resolve;
	});

	const stale = loadProjectFileTree(
		async () => pendingA,
		[],
		() => current === "A",
	);

	// 模拟用户在 A 的 IPC 返回前切到 B。
	current = "B";
	resolveA([file("from-a.txt", "/a/from-a.txt")]);

	assert.equal(await stale, null);
});

test("project file tree refresh and expand drop stale listings", () => {
	const sync = readFileSync("src/renderer/src/hooks/useProjectSync.ts", "utf8");
	// 切项目时的树清空/代次闸门已迁入 useProjectFileTreeController。
	const app = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");

	// #159：切项目后旧 files:list 仍可能很晚返回，必须按代次/当前项目丢弃。
	assert.match(sync, /loadProjectFileTree/);
	assert.match(sync, /fileTreeGenerationRef/);
	assert.match(sync, /beginFileTreeRequest/);
	assert.match(app, /setFiles\(\(current\) => \(current\.length === 0 \? current : \[\]\)\)/);
	assert.match(app, /beginFileTreeRequest\(\)/);
	assert.match(app, /isFileTreeRequestCurrent\(generation, projectId\)/);
});

test("展开目录的 IPC 不在 setFiles updater 里（StrictMode 双跑不得发两次 files:list）", () => {
	const app = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");
	const start = app.indexOf("function toggleDirectory(");
	const end = app.indexOf("function collapseAllDirectories(");
	assert.ok(start > 0 && end > start, "toggleDirectory 必须可定位");
	const body = app.slice(start, end);
	// updater 必须是纯函数：React StrictMode 会跑两遍，副作用写进 updater 就发两次 IPC。
	// 旧实现是 setFiles((current) => { if (已加载) return; void api.files.list(...); return current; })。
	assert.doesNotMatch(body, /setFiles\(\s*\([^)]*\)\s*=>\s*\{[^}]*api\.files/, "setFiles updater 里不得发 IPC");
	assert.doesNotMatch(body, /setFiles\(\s*\([^)]*\)\s*=>\s*\{[^}]*console\./, "setFiles updater 里不得写日志");
	// 「已加载就跳过」的判据直接在作用域里读当前树（而不是在 updater 里读 current）。
	assert.match(body, /if\s*\(findLoadedDirectory\(files, path\)\) return;/, "跳过判据必须在 updater 之外");
	// 拉回来的 merge 本身幂等，重复点击不会把树重建一遍。
	assert.match(body, /setFiles\(\(tree\) => mergeFileTreeChildren\(tree, path, children\)\)/);
});

test("missing project directories clear stale files and refresh project presence", () => {
	const sync = readFileSync("src/renderer/src/hooks/useProjectSync.ts", "utf8");
	const app = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");
	const i18n = [readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"), readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8")].join("\n");

	assert.match(sync, /message\.includes\("PROJECT_DIRECTORY_MISSING"\)/);
	// 目录被外部删除时必须清掉陈旧文件树，且这一清空要落在 PROJECT_DIRECTORY_MISSING 分支里；
	// 已经是空树时复用原数组（内容没变就不推进文件树内容代次，避免白跑一轮 Git 着色重拉）。
	assert.match(sync, /if\s*\(projectDirectoryMissing\)\s*\{[\s\S]*?setFiles\(\s*\(current\)\s*=>\s*\(current\.length === 0 \? current : \[\]\)\s*\)/);
	assert.match(sync, /void refreshProjects\(\)\.catch\(\(\) => undefined\);/);
	assert.match(app, /projectDirectoryMissing[\s\S]*?refreshProjects\(\)\.catch/);
	// PROJECT_DIRECTORY_MISSING 的项目自愈/提示文案在文件树控制器里。
	const controller = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");
	assert.match(controller, /projectDirectoryMissing[\s\S]*?refreshProjects\(\)\.catch/);
	assert.match(i18n, /"app\.projectDirectoryMissing"/);
});

test("file deletion failures are shown to the user instead of only logged", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const deleteBlock = app.match(/await api\.files\.delete\(node\.path, true\);[\s\S]*?\n\s*}\n\s*},/);
	assert.ok(deleteBlock, "file drawer delete handler should be discoverable");
	// 实参可能被格式化换行：容忍 showToast( 与 t(...) 之间的空白。
	assert.match(deleteBlock[0], /showToast\(\s*t\("app\.fileDeleteFailed"/);
	// showToast 参数可跨行且带尾逗号：5000 与 kind 字面量之间容忍空白与可选逗号。
	assert.match(deleteBlock[0], /5000,\s*"error",?/);
	assert.doesNotMatch(deleteBlock[0], /console\.error/);
});

test("project file tree effect does not retrigger on an unstable toast helper", () => {
	// 文件树切换 effect 已迁入 useProjectFileTreeController；showToast 由 App 的
	// useCallback 传入，但 effect deps 仍不得包含它。
	const app = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");
	const appShell = readFileSync("src/renderer/src/App.tsx", "utf8");
	// 文件树 effect 只应跟当前项目走。showToast 若是每次 render 新建的函数
	// 又写进 deps，会每帧 setFiles([]) 把 React 更新深度打满——点击会话后
	// 设置/关窗点不动，正是 applog 里 Maximum update depth 的根因。
	const effectStart = app.indexOf("先立刻清空旧树");
	assert.notEqual(effectStart, -1, "file-tree switch effect should still exist");
	const deps = app.slice(effectStart, effectStart + 2500).match(/\}, \[activeProjectId[^\]]*\]\)/);
	assert.ok(deps, "file-tree effect should keep an explicit dependency list");
	assert.doesNotMatch(deps[0], /showToast|refreshProjects/);
	assert.match(appShell, /const showToast = useCallback\(/);
});
