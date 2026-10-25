/**
 * 文件抽屉 / Git 变更列表渲染预算契约（性能回归）。
 *
 * 背景（用户反馈「文件列表没用虚拟滚动，文件多了就卡」）：
 * - 文件树对根层与每个目录的 children 全量 `.map`，单目录上限 2000（shared/fileTree.ts），
 *   一次展开/打开就是同步挂满整棵子树；
 * - 行组件没有 memo，且每行订阅 activeEditorFileAtom；App 根又逐条订阅
 *   currentSessionMessagesAtom（消息 flush 最高 20 次/秒）→ 抽屉开着时全树持续重渲。
 *
 * 本测试锁的是「已被验证有效的第一档渲染预算」：
 * 1. 文件树行组件 memo 化，活跃文件 atom 只在面板订阅一次；
 * 2. 根层与每个目录的 children 走 useLazyListWindow 分批挂载（每批 200）；
 * 3. App 根不再订阅逐条消息数组，改订阅内容稳定的 modifiedFiles 投影；
 * 4. Git 变更树 FileTree memo 化，行内操作回调引用稳定（commit composer 每键重渲不再重建整树）。
 *
 * 正则必须空白容忍（AGENTS.md：新增源码扫描契约测试禁止字面空格）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

// 行组件域已从面板文件整块迁出（WorkspaceSurface > 600 行红线）：分批预算常量与行 memo 在新模块，
// 根层窗口与面板接线仍在 WorkspaceSurface。两个文件合起来看才等价于拆分前的单文件断言。
const surface = readFileSync("src/renderer/src/components/session/WorkspaceSurface.tsx", "utf8");
const rows = readFileSync("src/renderer/src/components/session/FileTreeRows.tsx", "utf8");
// 分批预算常量后来从行组件再搬到 utils：组件模块只能导出组件/hook（Fast Refresh），
// 面板与行组件都从这里 import。
const renderBudget = readFileSync("src/renderer/src/utils/fileTreeRenderBudget.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const outlineAtoms = readFileSync("src/renderer/src/atoms/session-outline-atoms.ts", "utf8");
const gitResourceTree = readFileSync("src/renderer/src/components/app/git/GitResourceTree.tsx", "utf8");
const gitPanel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");

test("文件树行组件 memo 化，活跃文件 atom 只由面板订阅一次", () => {
	assert.match(renderBudget, /export\s+const\s+FILE_TREE_RENDER_BATCH\s*=\s*200\s*;/);
	// 组件模块导出非组件常量会让 dev 下改该文件整页刷新（Fast Refresh 只认组件/hook 导出）。
	assert.doesNotMatch(rows, /export\s+const\s+FILE_TREE_RENDER_BATCH/, "分批预算常量不得从组件模块导出（破坏 Fast Refresh）");
	assert.match(rows, /import\s*\{\s*FILE_TREE_RENDER_BATCH\s*\}\s*from\s*"\.\.\/\.\.\/utils\/fileTreeRenderBudget"/, "行组件从 utils 取分批预算");
	assert.match(surface, /import\s*\{\s*FILE_TREE_RENDER_BATCH\s*\}\s*from\s*"\.\.\/\.\.\/utils\/fileTreeRenderBudget"/, "面板从 utils 取分批预算");
	assert.match(rows, /const\s+FileRow\s*=\s*memo\(/, "文件行必须 memo：否则流式消息 flush 会重渲每一行");
	assert.match(rows, /const\s+DirectoryRow\s*=\s*memo\(/, "目录行必须 memo");
	assert.match(rows, /const\s+FileTreeNodeRow\s*=\s*memo\(/, "行分发器必须 memo");
	// 订阅次数按「面板 + 行组件」合计：拆文件后逐行订阅要照样能被抓到
	const atomSubscriptions = `${surface}\n${rows}`.match(/useAtomValue\(\s*activeEditorFileAtom\s*\)/g) ?? [];
	assert.equal(atomSubscriptions.length, 1, "activeEditorFileAtom 只能在 FilesPanel 订阅一次，行组件逐行订阅会让点一次文件全树重渲");
});

test("文件树根层与每个目录的 children 都走分批增量窗口", () => {
	assert.match(surface, /useLazyListWindow\(\s*displayFiles\s*,\s*\{\s*pageSize:\s*FILE_TREE_RENDER_BATCH/, "根层必须分批挂载");
	assert.match(rows, /useLazyListWindow<FileTreeNode>\(\s*node\.children\s*\?\?\s*EMPTY_FILE_TREE_CHILDREN\s*,\s*\{\s*pageSize:\s*FILE_TREE_RENDER_BATCH/, "展开目录的 children 必须分批挂载");
	// 两个窗口都要渲染哨兵，否则永远只显示第一批
	const sentinels = `${surface}\n${rows}`.match(/sentinelRef/g) ?? [];
	assert.ok(sentinels.length >= 2, "根层与目录层都要挂 IntersectionObserver 哨兵");
	assert.match(surface, /rootWindow\.hasMore/);
	assert.match(rows, /childWindow\.hasMore/);
});

test("App 根不再订阅逐条消息数组，修改文件清单用内容稳定投影", () => {
	assert.doesNotMatch(app, /useAtomValue\(\s*currentSessionMessagesAtom\s*\)/, "App 根订阅消息数组会让每条 flush 重渲整棵树（文件抽屉几千行时持续卡顿）");
	assert.match(app, /const\s+modifiedFiles\s*=\s*useAtomValue\(\s*modifiedFilesAtom\s*\)/);
	// 投影缓存：内容相同必须复用旧数组引用，否则 jotai 仍会叫醒 App 根。
	assert.match(outlineAtoms, /sameModifiedFiles\(/);
	assert.match(outlineAtoms, /modifiedFilesProjection\.messages\s*===\s*messages/);
	assert.match(outlineAtoms, /EMPTY_MESSAGES/);
});

test("Git 变更树 FileTree memo 化，行内操作回调引用稳定", () => {
	assert.match(gitResourceTree, /export\s+const\s+FileTree\s*=\s*memo\(function\s+FileTree/);
	assert.match(gitPanel, /const\s+actRef\s*=\s*useRef\(act\)/);
	assert.match(gitPanel, /stageFile=\{stageFile\}/);
	assert.match(gitPanel, /unstageFile=\{unstageFile\}/);
	assert.match(gitPanel, /discardFile=\{discardFile\}/);
	assert.doesNotMatch(gitPanel, /stageFile=\{\(path\)\s*=>/, "行内回调每次重渲都会重建，会让 FileTree memo 失效");
});

test("e2e 渲染预算守卫存在", () => {
	const specPath = "e2e/file-tree-dom-budget.spec.ts";
	assert.ok(existsSync(specPath), "文件树 DOM 上限需要 e2e 守卫，防止有人退回全量 map");
	const spec = readFileSync(specPath, "utf8");
	assert.match(spec, /ROOT_FILE_COUNT\s*=\s*\d+/);
	assert.match(spec, /\.file-node-row/);
	assert.match(spec, /scrollTop\s*=\s*element\.scrollHeight|scrollTop\s*=\s*panel\.scrollHeight/);
});
