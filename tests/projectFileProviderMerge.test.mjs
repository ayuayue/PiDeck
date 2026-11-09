import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const fileServiceSource = readFileSync("src/renderer/src/services/projectFileService.ts", "utf8");
const servicesSource = readFileSync("src/renderer/src/services/projectServices.ts", "utf8");
const { createProjectFileService, localProjectFilePorts, remoteProjectFilePorts } = loadTsCommonJs("src/renderer/src/services/projectFileService.ts");
const { PROJECT_SERVICE_CODES } = loadTsCommonJs("src/renderer/src/services/projectServiceContracts.ts");
const { opOk } = loadTsCommonJs("src/shared/op.ts");

/**
 * 位置分派收口的终点：**只有一个文件 provider**。
 *
 * 合并后本机与远端的差异只剩注入的端口（文本通道、系统打开、传输），所以这里钉两件事：
 * 1. 源码里不能再出现 `createLocal/RemoteProjectFileService` 二选一；
 * 2. 同一个 `createProjectFileService` 在两种端口下行为仍与合并前一致（文本来源、缺 version 拒绝、
 *    没有的能力显式 unsupported、远端删除带 trashId）。
 */
const projectId = "project";
const target = { projectId, relativePath: "src/a.ts" };
const fence = { generation: "generation-1", slot: { current: "generation-1" } };
const plain = (value) => JSON.parse(JSON.stringify(value));

/** vm 里创建的 Error 不是宿主 Error：按 code/message 断言。 */
async function rejectsWith(run, expected) {
	try {
		await run();
	} catch (error) {
		const code = error?.code ?? String(error?.message ?? error);
		assert.match(String(code), new RegExp(expected));
		return;
	}
	assert.fail("expected rejection: " + expected);
}

function stub(overrides = {}) {
	const calls = [];
	const api = {
		files: {
			directoryPage: async () => ({ ok: true, value: { entries: [], truncated: false, revision: 1, generation: "generation-1" } }),
			searchContent: async () => null,
			stat: async () => ({ availability: "present", exists: true, isDirectory: false }),
			readContent: async (fileTarget, maxBytes) => {
				calls.push(["files.readContent", fileTarget.relativePath, maxBytes]);
				return "local-content";
			},
			writeContent: async (fileTarget, content, _revision, expectedVersion) => {
				calls.push(["files.writeContent", fileTarget.relativePath, content, expectedVersion]);
			},
			open: async (fileTarget) => {
				calls.push(["files.open", fileTarget.relativePath]);
			},
			showInFolder: async (fileTarget) => {
				calls.push(["files.showInFolder", fileTarget.relativePath]);
			},
			delete: async () => opOk(undefined),
			...overrides.files,
		},
		remoteHosts: {
			openProjectText: async () => ({ ok: true, value: { document: { content: "remote-content", version: "v1" } } }),
			saveProjectText: async (...args) => {
				calls.push(["remoteHosts.saveProjectText", ...args]);
				return { ok: true, value: { version: "v2" } };
			},
			...overrides.remoteHosts,
		},
	};
	return { api, calls };
}

test("源码：只有一个文件 provider，位置差异只允许出现在端口注入处", () => {
	assert.match(fileServiceSource, /export function createProjectFileService\(/);
	assert.doesNotMatch(fileServiceSource, /export function create(?:Local|Remote)ProjectFileService\(/, "两个 provider 的实现不允许回来");
	assert.doesNotMatch(servicesSource, /create(?:Local|Remote)ProjectFileService/, "createProjectServices 不再二选一");
	assert.match(servicesSource, /createProjectFileService\(project\.id, api, fence, remote \? remoteProjectFilePorts/, "位置只决定注入哪组端口");
});

test("同一个 provider：本机端口读 files.*、系统打开可用、传输显式 unsupported", async () => {
	const { api, calls } = stub();
	const files = createProjectFileService(projectId, api, fence, localProjectFilePorts(projectId, api));
	const read = await files.readText(target, { maxBytes: 1024 });
	assert.deepEqual(plain(read), { content: "local-content" });
	assert.deepEqual(plain(calls), [["files.readContent", "src/a.ts", 1024]], "本机文本读仍走 files.readContent");

	await files.openInEditor(target);
	await files.showInFolder(target);
	assert.deepEqual(plain(calls.slice(1)), [
		["files.open", "src/a.ts"],
		["files.showInFolder", "src/a.ts"],
	]);

	await rejectsWith(() => files.uploadFiles(target, { kind: "picker" }), PROJECT_SERVICE_CODES.unsupported);
	await rejectsWith(() => files.downloadFile(target), PROJECT_SERVICE_CODES.unsupported);
});

test("同一个 provider：远端端口读令牌化通道、缺 version 零调用拒绝、系统打开 unsupported", async () => {
	const { api, calls } = stub();
	const files = createProjectFileService(projectId, api, fence, remoteProjectFilePorts(projectId, api));
	const read = await files.readText(target);
	assert.deepEqual(plain(read), { content: "remote-content", version: "v1" }, "远端文本读带 version");

	await rejectsWith(() => files.writeText(target, "next", undefined), PROJECT_SERVICE_CODES.versionRequired);
	assert.equal(calls.length, 0, "缺 version 时一个写都不发");

	await files.writeText(target, "next", "v1");
	assert.deepEqual(plain(calls), [["remoteHosts.saveProjectText", "project", "src/a.ts", "next", "v1"]]);

	await rejectsWith(() => files.openInEditor(target), "project has no local path|PROJECT_SERVICE_UNSUPPORTED");
});

test("跨目录改名只发一次 move-to：不再有 move+rename 的中间残局（P1-2）", async () => {
	const calls = [];
	const { api } = stub({
		files: {
			moveTo: async (source, destination) => {
				calls.push(["moveTo", source.relativePath, destination.relativePath]);
				return { ok: true, value: destination };
			},
			move: async () => {
				calls.push(["move"]);
				return { ok: true, value: [] };
			},
			rename: async () => {
				calls.push(["rename"]);
				return { ok: true, value: target };
			},
		},
	});
	const files = createProjectFileService(projectId, api, fence, remoteProjectFilePorts(projectId, api));
	const receipt = await files.moveEntry(target, "lib/b.ts");
	assert.deepEqual(calls, [["moveTo", "src/a.ts", "lib/b.ts"]], "一次写：既没有先 move 也没有第二步 rename");
	assert.deepEqual(plain(receipt.target), { projectId, relativePath: "lib/b.ts" });
});

test("同一个 provider：远端删除带回 trashId，本机删除没有该字段", async () => {
	const remote = stub({ files: { delete: async () => opOk({ trashId: "trash-1" }) } });
	const remoteFiles = createProjectFileService(projectId, remote.api, fence, remoteProjectFilePorts(projectId, remote.api));
	assert.deepEqual(plain(await remoteFiles.deleteEntry(target)), { target, trashId: "trash-1" });

	const local = stub();
	const localFiles = createProjectFileService(projectId, local.api, fence, localProjectFilePorts(projectId, local.api));
	assert.deepEqual(plain(await localFiles.deleteEntry(target)), { target });
});
