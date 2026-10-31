/**
 * 本地文件树 Phase B 接线：useProjectFileTreeController 只经 ProjectServices.files.listDirectory。
 *
 * 覆盖：公共目录页条目映射回 FileTreeNode（绝对路径/排序元数据/hasChildren），
 * 截断仍按旧的“目录过大”提示拒绝半棵树，IPC 失败按稳定码上报。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(pageFactory) {
	const host = quickMessageHookHost();
	const reads = [];
	const sets = [];
	const toasts = [];
	const projectsRefreshed = [];
	const services = {
		projectId: "p1",
		generation: "local",
		kind: "local",
		files: {
			listDirectory: async (target, options) => {
				reads.push({ target, options });
				return pageFactory(target, options);
			},
		},
	};
	const { useProjectFileTreeController } = loadTsCommonJs("src/renderer/src/hooks/files/useProjectFileTreeController.ts", {
		stubs: {
			react: host.react,
			"../../desktopApi": { desktopApi: { git: { onRefsChanged: () => () => undefined, watchRefs: async () => null, unwatchRefs: async () => undefined } } },
			"../../i18n": { t: (key) => key },
			"../../utils/expandedDirsPersistence": { legacyAgentIdsForProject: () => [], loadExpandedDirsFromStorage: () => new Set(), saveExpandedDirsToStorage: () => undefined },
		},
	});
	let rendered;
	const render = () =>
		(rendered = host.render(() =>
			useProjectFileTreeController({
				setFiles: (next) => sets.push({ nodes: typeof next === "function" ? next([]) : next }),
				activeProjectId: "p1",
				services,
				isLocalProjectId: () => true,
				compactMiddlePackagesEnabled: false,
				agentsRef: { current: [] },
				refreshProjects: async () => {
					projectsRefreshed.push(true);
				},
				showToast: (message) => toasts.push(message),
			}),
		));
	return { host, render, rendered: () => rendered, reads, sets, toasts, projectsRefreshed };
}

const PAGE = {
	entries: [
		{ target: { projectId: "p1", relativePath: "src" }, relativePath: "src", type: "directory", hasChildren: true, path: "D:\\p\\src", mtimeMs: 11, size: 0 },
		{ target: { projectId: "p1", relativePath: "a.txt" }, relativePath: "a.txt", type: "file", hasChildren: false, path: "D:\\p\\a.txt", mtimeMs: 22, size: 5 },
	],
	truncated: false,
	revision: 3,
	generation: "local",
};

test("本地目录页映射回 FileTreeNode：绝对路径、排序元数据与 hasChildren 全部保留", async () => {
	const h = harness(async () => PAGE);
	h.render();
	await flush();
	const nodes = [...h.sets].reverse().find((entry) => entry.nodes.length > 0)?.nodes;
	assert.deepEqual(plain(nodes), [
		{ name: "src", path: "D:\\p\\src", displayPath: "D:\\p\\src", relativePath: "src", target: { projectId: "p1", relativePath: "src" }, type: "directory", hasChildren: true, mtimeMs: 11, size: 0 },
		{ name: "a.txt", path: "D:\\p\\a.txt", displayPath: "D:\\p\\a.txt", relativePath: "a.txt", target: { projectId: "p1", relativePath: "a.txt" }, type: "file", mtimeMs: 22, size: 5 },
	]);
	assert.deepEqual(plain(h.reads[0].target), { projectId: "p1", relativePath: "" });
	h.host.unmount();
});

test("单层超限仍按旧的“目录过大”提示拒绝半棵树，不静默少显示", async () => {
	const h = harness(async () => ({ ...PAGE, truncated: true, totalEntries: 2501 }));
	h.render();
	await flush();
	assert.ok(h.toasts.includes("app.filesDirectoryTooLarge"));
	assert.equal(
		h.sets.some((entry) => entry.nodes.length > 0),
		false,
	);
	h.host.unmount();
});

test("目录页失败按稳定码上报；项目目录缺失触发 presence 刷新", async () => {
	const h = harness(async () => {
		throw Object.assign(new Error("PROJECT_DIRECTORY_MISSING"), { code: "PROJECT_DIRECTORY_MISSING" });
	});
	h.render();
	await flush();
	assert.ok(h.toasts.includes("app.projectDirectoryMissing"));
	assert.equal(h.projectsRefreshed.length, 1);
	h.host.unmount();
});
