import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const stage = readFileSync("src/renderer/src/components/workspace/WorkbenchStage.tsx", "utf8");
const content = readFileSync("src/renderer/src/components/workspace/WorkbenchContent.tsx", "utf8");
const fileEditor = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
const drawer = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
const settings = readFileSync("src/shared/types/settings.ts", "utf8");
const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const commonTab = readFileSync("src/renderer/src/components/app/settings/CommonTab.tsx", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");

test("settings expose workspace content open mode; split orientation removed", () => {
	assert.match(settings, /WorkspaceContentOpenMode = "split" \| "maximize"/);
	assert.match(settings, /workspaceContentOpenMode: WorkspaceContentOpenMode/);
	assert.match(store, /workspaceContentOpenMode: "split"/);
	// workspaceContentOpenMode 设置项位于常用设置 tab（CommonTab，自 SettingsModal 拆分）
	assert.match(commonTab, /workspaceContentOpenMode/);
	assert.match(zh, /"settings\.workspaceContentOpenMode"/);
	assert.match(en, /"settings\.workspaceContentOpenMode"/);
	// 分屏方向设置已移除：中间栏固定左右分屏，不允许上下分屏
	assert.doesNotMatch(settings, /WorkspaceSplitOrientation/);
	assert.doesNotMatch(settings, /workspaceSplitOrientation/);
	assert.doesNotMatch(store, /workspaceSplitOrientation/);
	assert.doesNotMatch(settingsModal, /workspaceSplitOrientation/);
	assert.doesNotMatch(app, /workspaceSplitOrientation/);
	assert.doesNotMatch(zh, /workspaceSplitOrientation/);
	assert.doesNotMatch(en, /workspaceSplitOrientation/);
	assert.match(surfaces, /\.workbench-stage\s*\{/);
	assert.match(surfaces, /\.workbench-stage-split/);
	assert.match(surfaces, /\.workbench-stage\s*>\s*\.session-tabs-bar/);
	assert.match(surfaces, /\.workbench-stage-body/);
	assert.doesNotMatch(surfaces, /\.workbench-stage-solo\s*>\s*\*\s*\{[^}]*height:\s*100%/, "solo must not force every Fragment child to height 100% (breaks empty-state layout)");
	// 文件 Tab 不再用 accent 绿条顶边；并入 session-tabs-bar
	assert.doesNotMatch(surfaces, /\.file-diff-tab-bar\s*\{[^}]*border-top:\s*2px solid var\(--color-accent\)/);
});

test("WorkbenchStage hosts session + content with collapse-safe maximize", () => {
	assert.match(stage, /export function WorkbenchStage/);
	assert.match(stage, /layout === "maximize"/);
	assert.match(stage, /panel\.collapse\(\)/);
	assert.match(stage, /panel\.expand\(\)/);
	assert.match(stage, /chrome\?:/);
	assert.match(stage, /from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/types"/);
	// 分屏固定左右：不接受 props.orientation，面板组硬编码 horizontal，无 vertical 分支
	assert.doesNotMatch(stage, /props\.orientation/);
	assert.match(stage, /orientation="horizontal"/);
	assert.match(app, /<WorkbenchStage/);
	assert.match(app, /workbenchHasContent/);
	assert.match(app, /WorkbenchContent/);
	assert.match(app, /chrome=\{sessionTabsBarNode\}/);
	// 尺寸必须字符串百分比 + defaultSize 恒定：react-resizable-panels v4 约束派生把
	// 数字按 px 解析（minSize={20} → 2%），且 defaultSize 随 layout 切换会触发 Panel
	// 重注册、丢失 expandToSize，导致 maximize→split 恢复成窄缝（回归点）。
	assert.match(stage, /collapsedSize="0%"/);
	assert.match(stage, /minSize="20%"/);
	assert.match(stage, /defaultSize="48%"/);
	assert.doesNotMatch(stage, /defaultSize=\{props\.layout === "maximize" \? 0 : 48\}/);
	// 阅读面静态引入 FileDiffViewer：避免 lazy 动态 import 在 Electron/Vite 下偶发失败且无法重试恢复
	assert.doesNotMatch(app, /lazy\(\(\) => import\("\.\/components\/app\/FileDiffViewer"/);
	assert.doesNotMatch(content, /lazy\(\(\) =>/);
	assert.match(content, /import \{ FileDiffViewer \} from "\.\.\/app\/FileDiffViewer"/);
});

test("file view and git diff open into workbench modes, not drawer overlays", () => {
	assert.match(fileEditor, /editorMode: WorkspaceContentOpenMode/);
	assert.match(fileEditor, /gitDiffDisplayMode: WorkspaceContentOpenMode/);
	assert.match(fileEditor, /contentOpenMode: WorkspaceContentOpenMode/);
	// 打开文件不再切抽屉到 editor
	const viewBlock = fileEditor.slice(fileEditor.indexOf("const viewFilePath = useCallback"), fileEditor.indexOf("const diffFilePath = useCallback"));
	assert.doesNotMatch(viewBlock, /setDrawer\("editor"\)/);
	assert.match(viewBlock, /contentOpenModeRef\.current/);
	// Git Diff 不再要求 drawer 叠层
	assert.doesNotMatch(drawer, /git-drawer-detail/);
	assert.doesNotMatch(drawer, /displayMode="drawer"/);
	// App 不再挂 body modal 阅读面
	assert.doesNotMatch(app, /editorMode === "modal"/);
	assert.doesNotMatch(app, /gitDiffDisplayMode === "modal"/);
	assert.match(content, /displayMode=\{props\.gitDiffDisplayMode\}/);
	assert.match(content, /displayMode=\{props\.editorMode\}/);
});

test("closing git diff dismisses the whole workbench reading surface", () => {
	// 关 Diff 时一并清文件 tab，避免优先渲染切回 editor 像「关不掉」
	assert.match(fileEditor, /dismissWorkbenchContent/);
	assert.match(fileEditor, /closeGitDiff:\s*dismissWorkbenchContent/);
	const openWorkspace = fileEditor.slice(fileEditor.indexOf("const openWorkspaceFileDiffFn"), fileEditor.indexOf("const openCommitFileDiffFn"));
	assert.match(openWorkspace, /setActiveTabId\(null\)/);
	assert.match(openWorkspace, /setEditorTabs\(\[\]\)/);
});

test("file viewer header repeats the current filename beside the actions", () => {
	const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
	const headerStart = viewer.indexOf('<div className="file-diff-header">');
	const actionsStart = viewer.indexOf('<div className="file-diff-header-actions">', headerStart);
	assert.ok(headerStart >= 0 && actionsStart > headerStart, "file header must contain its action area");
	const header = viewer.slice(headerStart, actionsStart);
	// Tab 栏仍负责切换，但蓝色操作区也要给当前文件一个稳定的标题锚点。
	assert.match(header, /\{fileName\}/);
	assert.doesNotMatch(header, /FileTypeIcon|fileIcon|dangerouslySetInnerHTML/);
	assert.doesNotMatch(header, /props\.chromeTabsExternal \|\| showInlineTabs \?/);
});

test("file tabs use preview/permanent strategy owned by useFileEditor", () => {
	// 策略在 utils/editorTabs；hook 拥有 previewEditorTabId；打开文件不清掉已有 tab
	assert.match(fileEditor, /from "\.\.\/utils\/editorTabs"/);
	assert.match(fileEditor, /previewEditorTabId/);
	assert.match(fileEditor, /openMode: EditorTabOpenMode = "permanent"/);
	const viewBlock = fileEditor.slice(fileEditor.indexOf("const viewFilePath = useCallback"), fileEditor.indexOf("const diffFilePath = useCallback"));
	assert.match(viewBlock, /openMode: EditorTabOpenMode = "preview"/);
	assert.match(viewBlock, /dismissGitDiffOnly/);
	assert.doesNotMatch(viewBlock, /dismissWorkbenchContent/);

	// 文件 Tab 并入 SessionTabsBar，内容区不再渲染第二套 Tab 栏
	const tabsBar = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	assert.match(tabsBar, /editorTabs\?:/);
	assert.match(tabsBar, /EditorWorkbenchTab/);
	assert.match(content, /chromeTabsExternal/);
	assert.match(app, /editorTabs=\{workbenchEditorTabs\}/);

	const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
	// 编辑/退出编辑按钮已移除（diff 只读、view 源码即编辑），不存在退出编辑与关闭叉撞车问题
	assert.doesNotMatch(viewer, /PencilOff/);
	assert.doesNotMatch(viewer, /Edit3/);
	assert.doesNotMatch(viewer, /title=\{t\("app.exitEdit"\)\}/);
	// 关闭按钮始终渲染：即使 Tab 上收总栏（chromeTabsExternal），右上角也要有
	// 明确的关闭入口（需求：DIFF/文件预览右上角关闭按钮）。
	assert.doesNotMatch(viewer, /!props\.chromeTabsExternal && \(/);
	assert.match(viewer, /onClick=\{handleClose\}/);
	assert.match(viewer, /aria-label=\{t\("common.close"\)\}/);

	const surface = readFileSync("src/renderer/src/components/session/WorkspaceSurface.tsx", "utf8");
	assert.match(surface, /if \(fileActionTarget\) props\.onViewFile\?\.\(fileActionTarget, "permanent"\)/);
});
