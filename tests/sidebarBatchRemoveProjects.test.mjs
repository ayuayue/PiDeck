import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { removeProjectsSequentially } = loadTsCommonJs("src/renderer/src/utils/batchProjectRemoval.ts");

/** Radix Dialog 的内容走 portal，SSR 不产出内容；这里只换掉弹层容器，行与勾选仍是生产实现。 */
const { BatchRemoveProjectsDialog } = loadTsCommonJs("src/renderer/src/components/sidebar/BatchRemoveProjectsDialog.tsx", {
	stubs: {
		"../ui-shadcn/dialog": {
			Dialog: (props) => createElement(Fragment, null, props.children),
			DialogContent: (props) => createElement("div", null, props.children),
			DialogHeader: (props) => createElement("div", null, props.children),
			DialogTitle: (props) => createElement("h2", null, props.children),
			DialogDescription: (props) => createElement("p", null, props.children),
			DialogFooter: (props) => createElement("div", null, props.children),
		},
	},
});

function localProject(index, extra = {}) {
	return { id: `project-${index}`, name: `proj-${index}`, path: `C:/work/proj-${index}`, ...extra };
}

function renderDialog(projects) {
	return renderToStaticMarkup(createElement(BatchRemoveProjectsDialog, { projects, onRemove: async () => ({ removed: 0, failed: 0 }), onClose: () => {} }));
}

function countMatches(text, pattern) {
	return [...text.matchAll(pattern)].length;
}

test("批量移除逐个执行，全部成功时按次数汇总并回报进度", async () => {
	const ids = ["a", "b", "c"];
	const calls = [];
	const progress = [];
	const outcome = await removeProjectsSequentially(
		ids,
		async (projectId) => {
			calls.push(projectId);
		},
		(done, total) => progress.push(`${done}/${total}`),
	);
	assert.deepEqual(calls, ids);
	// 返回值来自 vm realm，跨 realm 的对象原型不同，逐字段比较。
	assert.equal(outcome.removed, 3);
	assert.equal(outcome.failed, 0);
	assert.deepEqual(progress, ["1/3", "2/3", "3/3"]);
});

test("中间项目失败只计数，不中断后续项目（批量不能因为一个运行中的 Agent 全盘放弃）", async () => {
	const ids = ["ok-1", "blocked", "ok-2"];
	const calls = [];
	const outcome = await removeProjectsSequentially(ids, async (projectId) => {
		calls.push(projectId);
		if (projectId === "blocked") throw new Error("PROJECT_HAS_RUNNING_AGENT");
	});
	assert.deepEqual(calls, ["ok-1", "blocked", "ok-2"]);
	assert.equal(outcome.removed, 2);
	assert.equal(outcome.failed, 1);
});

test("空清单不触发任何移除调用，返回 0/0", async () => {
	let calls = 0;
	const outcome = await removeProjectsSequentially([], async () => {
		calls += 1;
	});
	assert.equal(calls, 0);
	assert.equal(outcome.removed, 0);
	assert.equal(outcome.failed, 0);
});

test("弹窗分页只渲染当前页项目，并给出跨页全选与未选提示", () => {
	const projects = Array.from({ length: 23 }, (_, index) => localProject(index));
	const html = renderDialog(projects);
	// 第一页 10 行：每行渲染自己的目录路径，第 11 个项目（proj-10）不在第一页。
	assert.equal(countMatches(html, /title="C:\/work\/proj-\d+"/g), 10);
	assert.match(html, /C:\/work\/proj-9</);
	assert.doesNotMatch(html, /C:\/work\/proj-10</);
	// 全选文案带总数（勾的是整个清单，不是当前页）；未选时主按钮禁用并显示 0。
	assert.match(html, /全选（共 23 项）/);
	assert.match(html, /已选 0 \/ 23/);
	assert.match(html, />移除 0 个</);
	assert.match(html, /disabled=""/);
});

test("弹窗没有项目时给出空态，而不是空列表加可点按钮", () => {
	const html = renderDialog([]);
	assert.match(html, /没有可移除的项目记录/);
	assert.doesNotMatch(html, /全选（共/);
});

test("弹窗行区分目录缺失与远端项目：缺失打标，远端显示远端路径", () => {
	const projects = [localProject(1, { missing: true }), { id: "remote-1", name: "remote", kind: "remote", locator: { kind: "ssh", hostId: "host-1", remotePath: "/srv/remote-proj" } }];
	const html = renderDialog(projects);
	assert.match(html, /目录不存在/);
	assert.match(html, /\/srv\/remote-proj/);
});

test("侧栏 ⋯ 菜单把批量删除接到 App 的 removeMany，弹窗清单取自工作区项目", () => {
	const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
	assert.match(projectTree, /import \{ BatchRemoveProjectsDialog \} from "\.\/BatchRemoveProjectsDialog";/);
	assert.match(projectTree, /<DropdownMenuItem variant="destructive" onSelect=\{\(\) => setBatchRemoveOpen\(true\)\}>/);
	assert.match(projectTree, /<Trash2 className="size-3\.5" aria-hidden="true" \/>/);
	assert.match(projectTree, /t\("app\.projectsBatchRemove"\)/);
	assert.match(projectTree, /<BatchRemoveProjectsDialog projects=\{workspaceProjects\} onRemove=\{props\.actions\.projects\.removeMany\} onClose=\{\(\) => setBatchRemoveOpen\(false\)\} \/>/);

	const sidebarContent = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
	assert.match(sidebarContent, /removeMany: \(projectIds: readonly string\[\], onProgress\?: \(done: number, total: number\) => void\) => Promise<BatchProjectRemovalOutcome>;/);

	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(app, /removeMany: removeSidebarProjects,/);
	// 逐项 IPC 走既有 projects.remove（主进程负责会话索引与 worktree 清理），不新开通道。
	assert.match(app, /await removeProjectsSequentially\(/);
	assert.match(app, /const next = await api\.projects\.remove\(projectId\);/);
	assert.match(app, /updateAfterProjectRemoved\(projectId, next\);/);
});

/** 钩子替身宿主：只提供 useState/useId 等槽位，组件体按普通函数执行、可反复重渲染。 */
function createHookHost() {
	let slots = [];
	let cursor = 0;
	const react = {
		useState(initial) {
			const index = cursor++;
			slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
			return [
				slots[index].value,
				(next) => {
					slots[index].value = typeof next === "function" ? next(slots[index].value) : next;
				},
			];
		},
		useMemo(factory) {
			return factory();
		},
		useId() {
			return `slot-${cursor++}`;
		},
	};
	return {
		react,
		render(callback) {
			cursor = 0;
			return callback();
		},
		reset() {
			slots = [];
			cursor = 0;
		},
	};
}

/** 展开 JSX 元素树（子组件不执行）：弹窗自己的勾选控件、按钮与 Pagination 属性都在这一层。 */
function walkTree(node, ancestors = [], out = []) {
	if (node === null || node === undefined || typeof node === "boolean") return out;
	if (Array.isArray(node)) {
		for (const child of node) walkTree(child, ancestors, out);
		return out;
	}
	if (typeof node === "object") {
		out.push({ node, ancestors });
		walkTree(node.props?.children, [...ancestors, node], out);
	}
	return out;
}

function textContent(node) {
	const parts = [];
	for (const element of walkTree(node).map((entry) => entry.node)) {
		for (const child of [element.props?.children].flat(Infinity)) {
			if (typeof child === "string" || typeof child === "number") parts.push(String(child));
		}
	}
	return parts.join("");
}

/** 真实交互：勾选行、跨页全选、翻页、提交，都走组件自己的 onCheckedChange/onClick/onPageChange。 */
function createInteractionHarness(initialProjects, onRemove = async () => ({ removed: 0, failed: 0 })) {
	const host = createHookHost();
	const closed = [];
	const removalCalls = [];
	const { BatchRemoveProjectsDialog } = loadTsCommonJs("src/renderer/src/components/sidebar/BatchRemoveProjectsDialog.tsx", {
		stubs: {
			react: host.react,
			"../ui-shadcn/dialog": Object.fromEntries(["Dialog", "DialogContent", "DialogHeader", "DialogFooter"].map((name) => [name, (props) => props.children])),
			"../ui-shadcn/button": { Button: "button" },
			"../ui-shadcn/checkbox": { Checkbox: "checkbox" },
			"../ui-shadcn/pagination": { Pagination: "pagination" },
		},
	});
	let projects = initialProjects;
	const entries = () =>
		walkTree(
			host.render(() =>
				BatchRemoveProjectsDialog({
					projects,
					onRemove: (ids, onProgress) => (removalCalls.push([...ids]), onRemove(ids, onProgress)),
					onClose: () => closed.push(true),
				}),
			),
		);
	// 行与全选都是 label 包 Checkbox：label 的文案（也就是父节点的可读文本）用来定位。
	const checkboxBy = (predicate) => entries().find(({ node, ancestors }) => typeof node.props?.onCheckedChange === "function" && predicate(textContent(ancestors[ancestors.length - 1])));
	const confirmButton = () => entries().find(({ node }) => typeof node.props?.onClick === "function" && /^移除 \d+ 个$/.test(textContent(node)));
	const statusText = () => textContent(entries().find(({ node }) => node.props?.role === "status").node);
	return {
		status: statusText,
		removalCalls,
		closed,
		setProjects(next) {
			projects = next;
			entries();
		},
		clickRow(index) {
			checkboxBy((text) => text.includes(`C:/work/proj-${index}`)).node.props.onCheckedChange();
			entries();
		},
		clickSelectAll() {
			checkboxBy((text) => text.startsWith("全选（共")).node.props.onCheckedChange();
			entries();
		},
		async clickConfirm() {
			confirmButton().node.props.onClick();
			await new Promise((resolve) => setImmediate(resolve));
			entries();
		},
		confirmDisabled() {
			return confirmButton().node.props.disabled === true;
		},
		confirmLabel() {
			return textContent(confirmButton().node);
		},
		/** 当前页渲染出的行（按目录路径识别），用于验证分页切片。 */
		visiblePaths() {
			return entries()
				.filter(({ node }) => node.type === "checkbox")
				.map(({ ancestors }) => textContent(ancestors[ancestors.length - 1]))
				.filter((text) => text.includes("C:/work/proj-"))
				.map((text) => text.slice(text.indexOf("C:/work/proj-")));
		},
		goToPage(page) {
			entries()
				.find(({ node }) => typeof node.props?.onPageChange === "function")
				.node.props.onPageChange(page);
			entries();
		},
	};
}

test("点行勾选立刻反映到已选计数与按钮文案，再点一次取消", () => {
	const projects = Array.from({ length: 12 }, (_, index) => localProject(index));
	const harness = createInteractionHarness(projects);
	assert.match(harness.status(), /已选 0 \/ 12/);
	assert.equal(harness.confirmDisabled(), true);
	harness.clickRow(3);
	assert.match(harness.status(), /已选 1 \/ 12/);
	assert.equal(harness.confirmDisabled(), false);
	harness.clickRow(3);
	assert.match(harness.status(), /已选 0 \/ 12/);
	assert.equal(harness.confirmDisabled(), true);
});

test("全选勾的是整个清单（含未显示的页），再点一次清空", () => {
	const projects = Array.from({ length: 23 }, (_, index) => localProject(index));
	const harness = createInteractionHarness(projects);
	harness.clickSelectAll();
	assert.match(harness.status(), /已选 23 \/ 23/);
	harness.clickSelectAll();
	assert.match(harness.status(), /已选 0 \/ 23/);
});

test("翻页只换当前页的行，已选跨页保留", () => {
	const projects = Array.from({ length: 23 }, (_, index) => localProject(index));
	const harness = createInteractionHarness(projects);
	harness.clickRow(1);
	harness.goToPage(2);
	assert.deepEqual(
		harness.visiblePaths(),
		Array.from({ length: 10 }, (_, offset) => `C:/work/proj-${10 + offset}`),
	);
	harness.goToPage(3);
	assert.deepEqual(harness.visiblePaths(), ["C:/work/proj-20", "C:/work/proj-21", "C:/work/proj-22"]);
	assert.match(harness.status(), /已选 1 \/ 23/);
});

test("确认后按勾选的 id 批量移除，全部成功后关闭弹窗", async () => {
	const projects = Array.from({ length: 5 }, (_, index) => localProject(index));
	const harness = createInteractionHarness(projects);
	harness.clickRow(0);
	harness.clickRow(4);
	await harness.clickConfirm();
	assert.deepEqual(harness.removalCalls, [["project-0", "project-4"]]);
	assert.equal(harness.closed.length, 1);
});

test("部分失败时留在弹窗里显示汇总，成功项不再计入已选", async () => {
	const projects = Array.from({ length: 3 }, (_, index) => localProject(index));
	const harness = createInteractionHarness(projects, async () => ({ removed: 1, failed: 1 }));
	harness.clickSelectAll();
	await harness.clickConfirm();
	assert.equal(harness.closed.length, 0);
	assert.match(harness.status(), /已移除 1 个，1 个未移除/);
	// 父层移除成功一项后的新清单：失败项仍勾选，可以只对剩下的重试（按钮文案跟着减到 1）。
	harness.setProjects([projects[1]]);
	assert.equal(harness.confirmLabel(), "移除 1 个");
	assert.equal(harness.confirmDisabled(), false);
});
