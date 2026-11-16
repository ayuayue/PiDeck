import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { rendererAppSource } from "./helpers/rendererAppSources.mjs";

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

test("project file tree switch clears the projection and fences late loads", () => {
	// 切项目时的树清空已迁入 useProjectFileTreeController；迟到结果由 lazyDirTree 的按目录代次丢弃。
	const app = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");
	const core = readFileSync("src/renderer/src/utils/lazyDirTree.ts", "utf8");

	assert.match(app, /createLazyDirTreeController/);
	assert.match(app, /controller\.dispose\(\)/);
	assert.match(app, /setFiles\(\(current\) => \(current\.length === 0 \? current : \[\]\)\)/);
	assert.match(app, /migrateExpandedDirKeys/);
	assert.match(core, /generations\.get\(dir\) !== request/);
	assert.match(core, /epoch \+= 1/);
});

test("展开目录只改 controller，不在 setFiles updater 里发 IPC", () => {
	const app = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");
	const start = app.indexOf("const toggleDirectory = useCallback(");
	const end = app.indexOf("const collapseAllDirectories = useCallback(");
	assert.ok(start > 0 && end > start, "toggleDirectory 必须可定位");
	const body = app.slice(start, end);
	// StrictMode 双跑不得发两次 files:list：toggle 只同步 controller，加载由 controller 的代次管。
	assert.doesNotMatch(body, /setFiles|api\.files/);
	assert.match(body, /controller\.toggle\(relative\)/);
	assert.match(body, /drillCompactChain/);
});

test("missing project directories clear stale files and refresh project presence", () => {
	const app = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");
	const i18n = [readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"), readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8")].join("\n");

	// 目录被外部删除时：清掉陈旧投影（空树复用原引用，避免推进内容代次），并刷新项目 presence。
	assert.match(app, /setFiles\(\(current\) => \(current\.length === 0 \? current : \[\]\)\)/);
	assert.match(app, /code\.includes\("PROJECT_DIRECTORY_MISSING"\)/);
	assert.match(app, /if \(projectDirectoryMissing\) void refreshProjectsRef\.current\(\)\.catch\(\(\) => undefined\);/);
	// presence 已标缺失时不再重复弹：切回缺目录项目不该每次都刷一遍 toast。
	assert.match(app, /if \(projectDirectoryMissing && activeProjectMissingRef\.current\) return;/);
	assert.match(rendererAppSource, /activeProjectMissing: activeProject\?\.missing === true/);
	assert.match(i18n, /"app\.projectDirectoryMissing"/);
});

test("file deletion failures are shown to the user instead of only logged", () => {
	const app = rendererAppSource;
	const deleteBlock = app.match(/await api\.files\.delete\(target, true\);[\s\S]*?\n\s*}\n\s*},/);
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
	const appShell = rendererAppSource;
	// 文件树 effect 只应跟当前项目走。showToast 若是每次 render 新建的函数
	// 又写进 deps，会每帧 setFiles([]) 把 React 更新深度打满——点击会话后
	// 设置/关窗点不动，正是 applog 里 Maximum update depth 的根因。
	const effectStart = app.indexOf("项目切换：先清空旧树");
	assert.notEqual(effectStart, -1, "file-tree switch effect should still exist");
	const deps = app.slice(effectStart).match(/\}, \[activeProjectId[^\]]*\]\)/);
	assert.ok(deps, "file-tree effect should keep an explicit dependency list");
	assert.doesNotMatch(deps[0], /showToast|refreshProjects/);
	assert.match(appShell, /const showToast = useCallback\(/);
});

test("目录缺失时的项目 presence 刷新不会让文件树 effect 自激循环", () => {
	// reportError 对 PROJECT_DIRECTORY_MISSING 会调 refreshProjects：projects:list 每次
	// 返回新数组，App 的 isLocalProjectId（useCallback deps=[projects]）随之换引用。
	// 它若留在 effect deps，目录缺失就会「加载失败 → 刷新项目 → effect 重跑 → 再失败」，
	// 无限叠「项目目录不存在」toast。必须经 ref 取最新值。
	const app = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");
	const effectStart = app.indexOf("项目切换：先清空旧树");
	assert.notEqual(effectStart, -1, "file-tree switch effect should still exist");
	const deps = app.slice(effectStart).match(/\}, \[activeProjectId[^\]]*\]\)/);
	assert.ok(deps, "file-tree effect should keep an explicit dependency list");
	assert.doesNotMatch(deps[0], /isLocalProjectId\b/);
	assert.match(app, /const isLocalProjectIdRef = useRef\(isLocalProjectId\);/);
	assert.match(app, /isLocalProjectIdRef\.current\(projectId\)/);
	assert.match(app, /if \(projectDirectoryMissing\) void refreshProjectsRef\.current\(\)/);
	// git refs 订阅 effect 同理：projects 一刷新就重装 watch/unwatch 订阅，
	// 期间 refs 事件又会触发 refreshVisibleFiles → reportError → refreshProjects。
	const gitWatch = app.slice(app.indexOf("git refs 变了")).match(/\}, \[[^\]]*\]\);/);
	assert.ok(gitWatch, "git refs effect should keep an explicit dependency list");
	assert.doesNotMatch(gitWatch[0], /isLocalProjectId\b/);
});
