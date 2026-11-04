/**
 * G4b 共用 GitPanel 能力门禁。
 *
 * 契约：新增可选 prop `gitCapabilities?: Partial<ProjectGitCapabilities>`，缺省 = 全可用（现有调用方零行为变化）。
 * 传入关闭项时：对应按钮 disabled / 行内动作不提供，且切换 handler 不发调用；能力条只在确有不可用项时置顶。
 *
 * 做法：server render 真实 GitPanel，但把重子组件（变更树、图谱、ui 原语、jotai、i18n）替身为可观测桩，
 * 这样断言的是面板自己的门禁逻辑（disabled / handler 有无 / 是否调用），不是桩的行为。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const source = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
const h = React.createElement;

/** Observable stubs: the panel renders for real, its heavy children are recorded instead. */
const calls = {
	buttons: [],
	textareas: [],
	inputs: [],
	changeGroups: [],
	autoRefresh: [],
	graph: [],
};
const writes = [];
function resetCalls() {
	for (const key of Object.keys(calls)) calls[key] = [];
	writes.length = 0;
}

const passthrough = ({ children }) => h(React.Fragment, null, children);
const StubButton = (props) => {
	const { variant, size, loading, ref, children, ...rest } = props;
	calls.buttons.push(props);
	return h("button", rest, children);
};
const StubInput = (props) => {
	calls.inputs.push(props);
	return h("input", {
		value: props.value ?? "",
		onChange: props.onChange,
		placeholder: props.placeholder,
		"data-testid": props["data-testid"],
	});
};
const StubTextarea = (props) => {
	calls.textareas.push(props);
	return h("textarea", {
		value: props.value ?? "",
		onChange: props.onChange,
		onKeyDown: props.onKeyDown,
		"data-testid": props["data-testid"],
	});
};
const StubChangesGroupsStack = (props) => {
	calls.changeGroups.push(props);
	return null;
};
const colors = new Proxy({}, { get: () => () => null });

const atoms = {
	EMPTY_GIT_COMMIT_COMPOSER: { message: "", generating: false },
	gitCommitComposerByScopeAtom: {
		initialValue: { "project:project": { message: "fix: message" } },
	},
	gitCommitScopeKey: (projectId, repoScopeKey) => projectId + ":" + repoScopeKey,
	openSettingsAtom: {},
	patchGitCommitComposer: () => {},
};

const stubs = {
	react: React,
	jotai: {
		useAtom: (atom) => [atom.initialValue ?? {}, () => {}],
		useSetAtom: () => () => {},
	},
	"lucide-react": colors,
	"../../atoms": atoms,
	"../../i18n": { t: (key) => key },
	"../../hooks/useAnimationWindow": { useAnimationWindow: () => false },
	"../../hooks/git/useGitAutoRefresh": {
		LOCAL_GIT_AUTO_REFRESH: {
			statusPoll: true,
			refsWatch: true,
			autoFetch: true,
		},
		useGitAutoRefresh: (options) => {
			calls.autoRefresh.push(options);
		},
	},
	"../../utils/notice": { showNotice: () => {}, dismissNotice: () => {} },
	"../../utils/clipboard": {
		writeClipboard: async () => {},
		htmlToPlainText: (value) => value,
		readClipboardHtmlConsistent: () => "",
		readClipboardText: () => "",
	},
	"./AppParts": { ConfirmDialog: () => null },
	"./git/GitResourceTree": {
		fileNameOnly: (path) => String(path).split("/").pop(),
		ChangesGroupsStack: StubChangesGroupsStack,
		getCollapsibleChangeDirs: () => [],
		ResourceRow: () => null,
	},
	"./git/GitPanelControls": {
		GitCompactFilter: () => null,
		PaneHeader: (props) => h("div", { "data-pane-header": props.title }, props.children),
	},
	"./git/GitGraph": {
		SourceControlGraph: (props) => {
			calls.graph.push(props);
			return null;
		},
	},
	"../ui-shadcn/button": { Button: StubButton },
	"../ui-shadcn/input": { Input: StubInput },
	"../ui-shadcn/textarea": { Textarea: StubTextarea },
	"../ui-shadcn/progress": { Progress: () => null },
	"../ui-shadcn/virtual-stack": { VirtualStack: () => null },
	"../ui-shadcn/alert-dialog": {
		AlertDialog: passthrough,
		AlertDialogContent: passthrough,
		AlertDialogHeader: passthrough,
		AlertDialogFooter: passthrough,
		AlertDialogTitle: passthrough,
		AlertDialogDescription: passthrough,
		AlertDialogCancel: StubButton,
		AlertDialogAction: StubButton,
	},
	"../ui-shadcn/context-menu": {
		ContextMenu: passthrough,
		ContextMenuContent: passthrough,
		ContextMenuItem: passthrough,
		ContextMenuTrigger: passthrough,
	},
	"../../components/ui-shadcn/label": { Label: passthrough },
};

const { GitPanel } = loadTsCommonJs("src/renderer/src/components/app/GitPanel.tsx", { stubs });

const resource = (path) => ({
	path,
	status: 5,
	letter: "M",
	target: { projectId: "project", relativePath: path },
});
const groups = {
	merge: [],
	index: [resource("/repo/staged.txt")],
	workingTree: [resource("/repo/changed.txt")],
	untracked: [],
};

function baseProps(overrides = {}) {
	return {
		projectId: "project",
		repoScopeKey: "project",
		getStatus: async () => {
			writes.push("status");
			return groups;
		},
		stageFiles: async () => {
			writes.push("stage");
		},
		unstageFiles: async () => {
			writes.push("unstage");
		},
		discardFile: async () => {
			writes.push("discard");
		},
		discardFiles: async () => {
			writes.push("discardFiles");
		},
		commit: async () => {
			writes.push("commit");
		},
		branches: ["main", "dev"],
		currentBranch: "main",
		commitLog: async () => {
			writes.push("commitLog");
			return [];
		},
		commitCount: async () => 0,
		commitDetail: async () => null,
		onOpenCommitFileDiff: () => {},
		onOpenWorkspaceFileDiff: () => {},
		branchCompare: async () => {
			writes.push("branchCompare");
			return { ahead: 0, behind: 0, files: [] };
		},
		onCreateBranch: () => {},
		onSwitchBranch: () => {},
		cherryPick: async () => {
			writes.push("cherryPick");
		},
		revert: async () => {
			writes.push("revert");
		},
		reset: async () => {
			writes.push("reset");
		},
		dropCommit: async () => {
			writes.push("dropCommit");
		},
		push: async () => {
			writes.push("push");
		},
		pull: async () => {
			writes.push("pull");
		},
		fetch: async () => {
			writes.push("fetch");
		},
		gitInit: async () => {
			writes.push("init");
		},
		aheadBehind: async () => null,
		watchRefs: async () => "watch",
		unwatchRefs: async () => {},
		onRefsChanged: () => () => {},
		deleteFiles: async () => {
			writes.push("deleteFiles");
		},
		...overrides,
	};
}

function render(overrides = {}) {
	resetCalls();
	const html = renderToStaticMarkup(h(GitPanel, baseProps(overrides)));
	return { html, ...calls };
}
const buttonByLabel = (buttons, label) => buttons.find((props) => props["aria-label"] === label);
const buttonByText = (buttons, text) => buttons.find((props) => props.children === text);

test("缺省全可用：不渲染能力条，同步/刷新入口都可用（零行为变化）", () => {
	const { html, buttons, autoRefresh, graph } = render();
	assert.ok(!html.includes("remote-git-capabilities"), "without the prop the banner must not render");
	assert.equal(buttonByLabel(buttons, "common.refresh").disabled, false);
	assert.equal(buttonByLabel(buttons, "git.push").disabled, false);
	assert.equal(buttonByLabel(buttons, "git.pull").disabled, false);
	// 提交按钮此刻置灰是因为「没有可提交的变更」（SSR 不跑 effect，没有事实），不是能力：缺省写能力必须打开。
	assert.equal(calls.changeGroups.length, 1, "the virtualized changes shell mounts without effects");
	assert.equal(calls.changeGroups[0].groups.length, 0, "no facts are published without effects; row-level entries are covered by the source contract");
	assert.deepEqual({ ...autoRefresh.at(-1).capabilities }, { statusPoll: true, refsWatch: true, autoFetch: true });
	assert.equal(graph.length, 1, "graph pane still mounts");
	assert.equal(typeof graph[0].cherryPick, "function", "graph write actions default to open");
});

test("同步能力关闭：push/pull 置灰且点击不发调用；刷新与提交入口不受连坐", () => {
	const baseline = render();
	const baselineCommit = buttonByText(baseline.buttons, "git.commit").disabled;
	const { buttons } = render({ gitCapabilities: { sync: false } });
	const push = buttonByLabel(buttons, "git.push");
	const pull = buttonByLabel(buttons, "git.pull");
	assert.equal(push.disabled, true);
	assert.equal(pull.disabled, true);
	push.onClick?.();
	pull.onClick?.();
	assert.deepEqual(
		writes.filter((entry) => entry === "push" || entry === "pull"),
		[],
	);
	assert.equal(buttonByText(buttons, "git.commit").disabled, baselineCommit, "commit is a write entry, not a sync entry");
	assert.equal(buttonByLabel(buttons, "common.refresh").disabled, false);
});

test("刷新手势里的 fetch 还要显式允许自动联网（sync 真、autoFetch 假 → 刷新不 fetch）", async () => {
	const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
	// 远端能力：sync 可用，但 autoFetch 恒 false —— 刷新不是显式同步，绝不能变成自动 fetch。
	const scoped = render({ gitCapabilities: { sync: true, autoFetch: false } });
	buttonByLabel(scoped.buttons, "common.refresh").onClick?.();
	await tick();
	assert.ok(!writes.includes("fetch"), "a refresh gesture must not become an automatic fetch");
	assert.ok(writes.includes("status"), "the refresh still re-reads the worktree");
	// 对照：本机缺省（autoFetch 打开）保持既有行为——刷新会顺带 fetch 校正 behind。
	const local = render();
	buttonByLabel(local.buttons, "common.refresh").onClick?.();
	await tick();
	assert.ok(writes.includes("fetch"), "the local panel keeps its existing refresh fetch");
});

test("写能力关闭：提交按钮置灰，Ctrl/Cmd+Enter 既不提交也不插入换行", () => {
	const { buttons, textareas, graph } = render({
		gitCapabilities: { write: false },
	});
	assert.equal(buttonByText(buttons, "git.commit").disabled, true);
	assert.equal(textareas.length, 1, "the commit composer stays reachable (typing a message is not a write)");
	const composer = textareas[0];
	let prevented = 0;
	composer.onKeyDown({
		ctrlKey: true,
		key: "Enter",
		preventDefault: () => (prevented += 1),
	});
	composer.onKeyDown({
		metaKey: true,
		key: "Enter",
		preventDefault: () => (prevented += 1),
	});
	assert.equal(prevented, 2, "the shortcut still consumes the key");
	assert.deepEqual(
		writes.filter((entry) => entry === "commit" || entry === "stage"),
		[],
	);
});

test("读能力关闭：刷新按钮置灰且点击不发起 status 读", () => {
	const { buttons, autoRefresh } = render({
		gitCapabilities: { read: false, statusPoll: false },
	});
	const refresh = buttonByLabel(buttons, "common.refresh");
	assert.equal(refresh.disabled, true);
	refresh.onClick?.();
	assert.deepEqual(
		writes.filter((entry) => entry === "status"),
		[],
	);
	assert.equal(autoRefresh.at(-1).capabilities.statusPoll, false, "the auto status poll follows git.statusPoll");
});

test("refs watch / autoFetch 能力关闭时不再注册对应副作用（与既有 capabilities 取交集）", () => {
	const { autoRefresh } = render({
		capabilities: { refsWatch: false },
		gitCapabilities: { refsWatch: true, autoFetch: false },
	});
	assert.equal(autoRefresh.at(-1).capabilities.refsWatch, false, "the narrower of both capability layers wins");
	assert.equal(autoRefresh.at(-1).capabilities.autoFetch, false);
	assert.equal(autoRefresh.at(-1).capabilities.statusPoll, true);
});

test("传入能力且确有不可用项时顶部渲染同一条能力条（worktree 用整句说明）", () => {
	const { html } = render({
		gitCapabilities: { write: false, sync: false, worktree: false },
	});
	assert.ok(html.includes('data-testid="remote-git-capabilities"'));
	assert.ok(html.includes("remoteGit.capabilityWrite"));
	assert.ok(html.includes("remoteGit.capabilitySync"));
	assert.ok(html.includes("remoteGit.capabilityBlocked"));
	assert.ok(html.includes("remoteGit.worktreeUnsupported"));
	// 未传入能力（缺省）或传入且全可用时都不渲染能力条；只有确有不可用项时才出现。
	assert.ok(!render({}).html.includes("remote-git-capabilities"), "without the prop there is no capability banner");
	const allOpen = render({ gitCapabilities: {} }).html;
	assert.ok(!allOpen.includes("remote-git-capabilities"), "all-available must not render the banner");
});

test("面板源码契约：每个门禁点都读 gitCapabilities，能力条只在传入时渲染", () => {
	assert.match(source, /gitCapabilities\?: Partial<ProjectGitCapabilities>/);
	assert.match(source, /normalizeGitCapabilities\(props\.gitCapabilities\)/);
	// 同步三处 + 显式刷新里的 fetch：能力关闭时不发网络请求。
	assert.match(source, /if \(!props\.push \|\| !gitCapabilitiesRef\.current\.sync/);
	assert.match(source, /if \(!props\.pull \|\| !gitCapabilitiesRef\.current\.sync/);
	// 刷新手势的 fetch：sync 与 autoFetch 双闸（M4：刷新不是显式同步，绝不能变成自动 fetch）。
	assert.match(source, /if \(!gitCapabilitiesRef\.current\.sync \|\| !gitCapabilitiesRef\.current\.autoFetch\) return;/);
	// 写：提交与 init 的守卫 + 快捷键。
	assert.match(source, /if \(!gitCapabilitiesRef\.current\.write\) return;/);
	assert.match(source, /if \(!props\.gitInit \|\| !gitCapabilitiesRef\.current\.init\) return;/);
	assert.match(source, /if \(!gitCapabilities\.write\) return;/);
	// 行内动作与批量动作：能力关闭时不提供入口。
	assert.match(source, /readOnly: !gitCapabilities\.write/);
	assert.match(source, /gitCapabilities\.write\s*\?\s*\(\) =>/);
	assert.match(source, /deleteFile: props\.deleteFiles && gitCapabilities\.deleteFiles \? deleteFile : undefined/);
	assert.match(source, /cherryPick=\{gitCapabilities\.write \? props\.cherryPick : undefined\}/);
	assert.match(source, /revert=\{gitCapabilities\.write \? props\.revert : undefined\}/);
	assert.match(source, /reset=\{gitCapabilities\.write \? props\.reset : undefined\}/);
	assert.match(source, /dropCommit=\{gitCapabilities\.write \? props\.dropCommit : undefined\}/);
	// 自动刷新 effect 取交集；首轮读受 read 约束。
	assert.match(source, /statusPoll: \(props\.capabilities\?\.statusPoll \?\? LOCAL_GIT_AUTO_REFRESH\.statusPoll\) && gitCapabilities\.statusPoll/);
	assert.match(source, /refsWatch: \(props\.capabilities\?\.refsWatch \?\? LOCAL_GIT_AUTO_REFRESH\.refsWatch\) && gitCapabilities\.refsWatch/);
	assert.match(source, /autoFetch: \(props\.capabilities\?\.autoFetch \?\? LOCAL_GIT_AUTO_REFRESH\.autoFetch\) && gitCapabilities\.autoFetch/);
	assert.match(source, /if \(!gitCapabilities\.read\) return;\s*void refresh\(\);/);
	// 对比：整块门禁 + 不发调用的守卫。
	assert.match(source, /enabled=\{gitCapabilities\.compare\}/);
	assert.match(source, /if \(!props\.enabled\) return;/);
	assert.match(source, /disabled=\{!props\.enabled \|\| !base/);
	// 能力条：只在真正传入能力时渲染（缺省零变化）。
	assert.match(source, /props\.gitCapabilities === undefined \? null : <RemoteGitCapabilityBanner/);
	// 兜底：不得回退到 backend 分支或新的能力判定。
	assert.doesNotMatch(source, /backend === "ssh"/);
});
