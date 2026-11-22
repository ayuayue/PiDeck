import assert from "node:assert/strict";
import test from "node:test";
import { latestRemoteFolderReveal, publishRemoteFolderReveal, subscribeRemoteFolderReveal, subscribeRemoteFolderRevealForProject } from "../src/renderer/src/utils/remoteFolderReveal.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 远端目录链接没有本机文件管理器入口：App 侧切到文件抽屉并发布「定位这个目录」请求。
// 请求带 projectId（抽屉跟随当前项目）与 nonce（同一目录连点两次也要再次定位）。

test("定位请求保留最近一次并通知订阅者，nonce 递增", () => {
	const seen = [];
	const unsubscribe = subscribeRemoteFolderReveal((request) => seen.push(request));
	publishRemoteFolderReveal("project-1", "src/main");
	publishRemoteFolderReveal("project-1", "src/main");
	publishRemoteFolderReveal("project-2", "");
	unsubscribe();

	assert.deepEqual(
		seen.map((request) => [request.projectId, request.relativePath]),
		[
			["project-1", "src/main"],
			["project-1", "src/main"],
			["project-2", ""],
		],
	);
	assert.ok(seen[1].nonce > seen[0].nonce);
	const latest = latestRemoteFolderReveal();
	assert.equal(latest.projectId, "project-2");
	assert.equal(latest.relativePath, "");
	assert.equal(latest.nonce, seen[2].nonce);
});

test("没有项目身份的请求直接丢弃，退订后不再投递", () => {
	const before = latestRemoteFolderReveal()?.nonce ?? 0;
	publishRemoteFolderReveal("", "src");
	assert.equal(latestRemoteFolderReveal()?.nonce ?? 0, before);

	let calls = 0;
	const unsubscribe = subscribeRemoteFolderReveal(() => {
		calls += 1;
	});
	publishRemoteFolderReveal("project-3", "docs");
	assert.equal(calls, 1);
	unsubscribe();
	publishRemoteFolderReveal("project-3", "docs");
	assert.equal(calls, 1);
});

test("目录树补消费最近请求，只展开匹配项目并在退订后停止", () => {
	const seen = [];
	publishRemoteFolderReveal("project-4", "queued/path");
	const unsubscribe = subscribeRemoteFolderRevealForProject("project-4", (path) => seen.push(path));
	assert.deepEqual(seen, ["queued/path"]);

	publishRemoteFolderReveal("project-5", "other-project");
	publishRemoteFolderReveal("project-4", "src/main");
	assert.deepEqual(seen, ["queued/path", "src/main"]);

	unsubscribe();
	publishRemoteFolderReveal("project-4", "after-unsubscribe");
	assert.deepEqual(seen, ["queued/path", "src/main"]);
});

test("会话文件链接打开远端目录时切换文件抽屉并发布项目定位", async () => {
	const published = [];
	const { useSessionFileLinks } = loadTsCommonJs("src/renderer/src/hooks/workspace/useSessionFileLinks.ts", {
		stubs: {
			react: { useCallback: (callback) => callback },
			"../../i18n": { t: (key) => key },
			"../../utils/filePathLinks": { resolveFileLinkPath: () => null, isFilePathInsideRoot: () => false },
			"../../../../shared/projectLocation": { isRemoteProject: () => true },
			"../../utils/remoteProjectPath": { remoteProjectTarget: () => null },
			"../../utils/remoteFolderReveal": { publishRemoteFolderReveal: (...args) => published.push(args) },
			"../../utils/rendererHomeDir": { getRendererHomeDir: () => "/home/tester" },
			"../useSessionFilePathOpener": {
				useSessionFilePathOpener:
					({ onOpenRemoteDirectory }) =>
					async (target) =>
						onOpenRemoteDirectory(target),
			},
			"../useExternalPathOpenGate": { useExternalPathOpenGate: () => ({ requestExternalPathOpen: async () => {}, dialog: null }) },
		},
	});
	const opened = [];
	const workspace = {
		drawer: "git",
		drawerCollapsed: false,
		openDrawer: (panel) => opened.push(panel),
		closeDrawer: () => {},
	};
	const links = useSessionFileLinks({
		activeAgent: undefined,
		activeProject: undefined,
		projects: [],
		currentSessionId: undefined,
		activeProjectId: "project-4",
		showToast: () => {},
		setPreviewImage: () => {},
		viewFilePath: () => {},
		workspace,
		gitDrawerDiff: null,
		closeGitDiff: () => {},
		refreshVisibleFiles: () => {},
		restoreExpandedDirs: async () => false,
	});

	await links.openSessionFilePath({ projectId: "project-4", relativePath: "src/main" });
	assert.deepEqual(opened, ["files"]);
	assert.deepEqual(published, [["project-4", "src/main"]]);
});
