import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { projectFileSearchPageFromRemote, projectFileSearchPageFromLocal } = loadTsCommonJs("src/main/files/ProjectFileSearchPage.ts");
const { createProjectFileService, localProjectFilePorts, remoteProjectFilePorts } = loadTsCommonJs("src/renderer/src/services/projectFileService.ts");

/**
 * 位置分派收口（第一片）：文件名搜索只走公共 `files:search-page`。
 *
 * 验收点：
 * 1. 投影两端同形，`truncated/scanned` 不丢；远端 `kind:"other"` 只留在 entries，不伪装成 file；
 * 2. renderer provider 不再出现位置分支——本机与远端都只调 `api.files.searchPage`；
 * 3. `remoteHosts.searchProject` 在这两条链路上不再被触达（兼容壳仍留在 preload）。
 */
const projectId = "project";
const plain = (value) => JSON.parse(JSON.stringify(value));
const fence = { generation: "generation-1", slot: { current: "generation-1" } };

test("远端投影：file/directory 进 results，other 只留在 entries，元数据不丢", () => {
	const page = projectFileSearchPageFromRemote(projectId, {
		entries: [
			{ path: "src/a.ts", name: "a.ts", kind: "file" },
			{ path: "src", name: "src", kind: "directory" },
			{ path: "bin/tool", name: "tool", kind: "other", bytes: 12 },
		],
		scanned: 42,
		truncated: true,
	});
	assert.deepEqual(plain(page.results), [
		{ name: "a.ts", path: "src/a.ts", relativePath: "src/a.ts", displayPath: "src/a.ts", target: { projectId, relativePath: "src/a.ts" }, type: "file" },
		{ name: "src", path: "src", relativePath: "src", displayPath: "src", target: { projectId, relativePath: "src" }, type: "directory" },
	]);
	assert.deepEqual(
		plain(page.entries).map((entry) => entry.kind),
		["file", "directory", "other"],
		"原始条目保留 other/bytes",
	);
	assert.equal(page.truncated, true);
	assert.equal(page.scanned, 42);
});

test("本机投影：结果原样，不伪造 truncated/scanned", () => {
	const page = projectFileSearchPageFromLocal([{ name: "a.ts", path: "C:\\p\\a.ts", relativePath: "a.ts", type: "file" }]);
	assert.equal(page.results.length, 1);
	assert.equal(Object.hasOwn(page, "truncated"), false, "本机没有截断元数据：不填 false 冒充完整");
	assert.equal(Object.hasOwn(page, "scanned"), false);
	assert.equal(Object.hasOwn(page, "entries"), false);
});

function api(searchPage) {
	return {
		files: {
			searchPage,
			async search() {
				throw new Error("files:search 不应再被 provider 触达");
			},
		},
		remoteHosts: {
			async searchProject() {
				throw new Error("remoteHosts.searchProject 不应再被 provider 触达");
			},
		},
	};
}

test("远端 provider：只调公共 searchPage，投影沿用同一份元数据", async () => {
	const calls = [];
	const apiStub = api(async (id, query) => {
		calls.push([id, query]);
		return { ok: true, value: { results: [{ name: "a.ts", relativePath: "src/a.ts", displayPath: "src/a.ts", path: "src/a.ts", type: "file" }], truncated: true, scanned: 7, entries: [{ path: "src/a.ts", name: "a.ts", kind: "file" }] } };
	});
	const files = createProjectFileService(projectId, apiStub, fence, remoteProjectFilePorts(projectId, apiStub));
	const page = await files.searchFiles("a");
	assert.deepEqual(calls, [[projectId, "a"]]);
	assert.equal(page.truncated, true);
	assert.equal(page.scanned, 7);
	assert.deepEqual(plain(page.entries), [{ path: "src/a.ts", name: "a.ts", kind: "file" }]);
});

test("本机 provider：同样只调 searchPage，位置分支消失", async () => {
	const calls = [];
	const apiStub = api(async (id, query) => {
		calls.push([id, query]);
		return { ok: true, value: { results: [{ name: "a.ts", path: "/p/a.ts", relativePath: "a.ts", type: "file" }] } };
	});
	const files = createProjectFileService(projectId, apiStub, fence, localProjectFilePorts(projectId, apiStub));
	const page = await files.searchFiles("a");
	assert.deepEqual(calls, [[projectId, "a"]]);
	assert.equal(page.results.length, 1);
	assert.equal(Object.hasOwn(page, "truncated"), false);
});
