import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const local = { id: "project", path: "/local", name: "local" };
const remote = { id: "project", locator: { kind: "ssh", hostId: "host", remotePath: "/remote" }, name: "remote" };
const empty = () => null;

function drawer(project, collapsed = false, enabled = true) {
	const mounts = [];
	const { DrawerSurface } = loadTsCommonJs("src/renderer/src/components/workspace/DrawerSurface.tsx", {
		stubs: {
			// DrawerSurface 的按钮链路经合并后的 ui-shadcn/button 引用渲染层别名路径；
			// vm CJS loader 不解析 @/ 别名，补一个最小 cn 实现（与 tsconfig paths 同义）。
			"@/lib/utils": { cn: (...classes) => classes.filter(Boolean).join(" ") },
			// DrawerSurface 的依赖链在合并后经 message-scroller 引入投递跟随 hook；
			// 本测试只关心 git 抽屉挂载哪个面板，不需要真实滚动引擎。
			"@/lib/stick-to-bottom": { useStickToBottom: () => ({}), isFollowEscapeEdge: () => false, isFollowSnapshotFresh: () => false },
			"./ProjectGitDrawer": {
				ProjectGitDrawer: ({ project }) => {
					mounts.push(project?.locator?.kind === "ssh" ? "remote" : "native");
					return React.createElement("div", null, project?.locator?.kind ?? "native");
				},
			},
			"../session/RemoteProjectPanel": { RemoteProjectPanel: empty },
			"./BrowserSurface": { BrowserSurface: empty },
			"./RewindPanel": { RewindPanel: empty },
			"../app/AppParts": { DrawerContent: empty },
			"../session/trajectory/SessionTrajectoryPanel": { SessionTrajectoryPanel: empty },
			// 其余抽屉面板与本测试无关：整块替身，避免加载它们背后的消息渲染链（streamdown 是 ESM-only）。
			"./RpcLogPanel": { RpcLogPanel: empty },
			"../scratchPad/ScratchPadDrawer": { ScratchPadDrawer: empty },
			"./SideTaskPanel": { SideTaskPanel: empty },
			"../session/branch/SessionBranchTreePanel": { SessionBranchTreePanel: empty },
			"../../hooks/useLazyComponent": { LazyWrapper: empty },
			"../../i18n": { t: (key) => key },
		},
	});
	renderToStaticMarkup(React.createElement(DrawerSurface, { drawer: "git", drawerCollapsed: collapsed, git: { activeProjectId: project.id, enableGitManagement: enabled }, files: { activeProject: project }, chrome: {}, browser: {} }));
	return mounts;
}

test("DrawerSurface forwards the active project to the single Git drawer entry", () => {
	assert.deepEqual(drawer(remote), ["remote"]);
	assert.deepEqual(drawer(local), ["native"]);
	assert.deepEqual(drawer(remote, true), []);
	assert.deepEqual(drawer(remote, false, false), []);
});
