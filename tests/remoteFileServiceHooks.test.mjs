/**
 * F（Phase B）草稿与文件写操作的接线行为测试。
 *
 * - useRemoteFileDraft：readText 的 version 是保存输入；缺 version 时原样交给 provider 拒绝，
 *   不取 entry 令牌、不自动重试；unknown/失败都保留草稿。
 * - useRemoteProjectEntries：新建/同父改名/删除走 ProjectFileService；跨目录移动仍是 entry 令牌薄壳；
 *   单飞、unknown、回收站收据与干净草稿回收保持。
 *
 * 用确定性 React 宿主 + 假 services / jotai 存储，不渲染 DOM、不触达真实 IPC。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function createAtomStore() {
	const atom = { value: new Map() };
	const store = {
		get: (token) => token.value,
		set: (token, next) => {
			token.value = typeof next === "function" ? next(token.value) : next;
		},
	};
	const jotai = {
		useAtom: (token) => [token.value, (next) => store.set(token, next)],
		useStore: () => store,
	};
	return { atom, store, jotai };
}

function draftHarness(overrides = {}) {
	const host = quickMessageHookHost();
	const { atom, jotai } = createAtomStore();
	const calls = { read: [], write: [] };
	const services = {
		projectId: "p1",
		generation: "ssh:h:0:g1",
		kind: "remote",
		files: {
			readText: async (target) => {
				calls.read.push(target);
				return overrides.read ? overrides.read(target) : { content: "disk", version: "v1" };
			},
			writeText: async (target, content, version) => {
				calls.write.push({ target, content, version });
				if (!overrides.write) return { version: "v2" };
				return overrides.write(target, content, version);
			},
		},
	};
	const { useRemoteFileDraft } = loadTsCommonJs("src/renderer/src/hooks/useRemoteFileDraft.ts", {
		stubs: {
			react: host.react,
			jotai,
			"../atoms/remote-file-atoms": { remoteFileDraftsAtom: atom },
		},
	});
	let view = null;
	const render = () => (view = host.render(() => useRemoteFileDraft(services, "a.txt")));
	const draft = () => atom.value.get(JSON.stringify(["p1", "a.txt"]));
	return { host, render, view: () => view, calls, atom, draft };
}

const VERSION_REQUIRED = () => Object.assign(new Error("PROJECT_SERVICE_VERSION_REQUIRED"), { code: "PROJECT_SERVICE_VERSION_REQUIRED", outcome: "rejected" });
const UNKNOWN = () => Object.assign(new Error("REMOTE_FILE_RESULT_UNCONFIRMED"), { code: "REMOTE_FILE_RESULT_UNCONFIRMED", outcome: "unknown" });

test("草稿经 readText 加载并保留 version；保存把同一 version 原样交给 writeText，成功后推进新 version", async () => {
	const h = draftHarness();
	h.render();
	await flush();
	h.render();
	assert.deepEqual(plain(h.calls.read), [{ projectId: "p1", relativePath: "a.txt" }]);
	assert.equal(h.draft().phase, "ready");
	assert.equal(h.draft().version, "v1");
	assert.equal(h.draft().content, "disk");
	h.view().change("edited");
	h.render();
	await h.view().save();
	h.render();
	assert.equal(h.calls.write.length, 1);
	assert.equal(h.calls.write[0].version, "v1");
	assert.equal(h.calls.write[0].content, "edited");
	assert.equal(h.draft().version, "v2");
	assert.equal(h.draft().content, "edited");
	assert.equal(h.draft().savedContent, "edited");
	assert.equal(h.draft().phase, "ready");
	h.host.unmount();
});

test("readText 缺 version：保存原样传空串由 provider 拒绝，不补 entry 令牌、不重试，草稿完整保留", async () => {
	const h = draftHarness({
		read: () => ({ content: "disk" }),
		write: async () => {
			throw VERSION_REQUIRED();
		},
	});
	h.render();
	await flush();
	h.render();
	assert.equal(h.draft().version, "");
	h.view().change("my edits");
	h.render();
	await h.view().save();
	h.render();
	assert.equal(h.calls.write.length, 1, "缺 version 时不得补取令牌后重试");
	assert.equal(h.calls.write[0].version, "");
	assert.equal(h.calls.read.length, 1, "不得重新 open 取 version");
	assert.equal(h.draft().content, "my edits");
	assert.equal(h.draft().savedContent, "disk");
	assert.equal(h.draft().phase, "ready");
	assert.equal(h.draft().blocked, true);
	assert.equal(h.draft().errorCode, "PROJECT_SERVICE_VERSION_REQUIRED");
	h.host.unmount();
});

test("写结果 unknown：不重试、不重开，草稿与已保存基准保持", async () => {
	const h = draftHarness({
		write: async () => {
			throw UNKNOWN();
		},
	});
	h.render();
	await flush();
	h.render();
	h.view().change("draft after unknown");
	h.render();
	await h.view().save();
	h.render();
	assert.equal(h.calls.write.length, 1);
	assert.equal(h.calls.read.length, 1);
	assert.equal(h.draft().content, "draft after unknown");
	assert.equal(h.draft().savedContent, "disk");
	assert.equal(h.draft().phase, "ready");
	assert.equal(h.draft().blocked, true);
	assert.equal(h.draft().errorCode, "REMOTE_FILE_RESULT_UNCONFIRMED");
	h.host.unmount();
});

/** 文件写命令 hook 宿主：假 services + 假 preload 薄壳（移动/回收站）。 */
function entriesHarness(overrides = {}) {
	const host = quickMessageHookHost();
	const { atom, store, jotai } = createAtomStore();
	const calls = { service: [], shell: [] };
	const services = {
		projectId: "p1",
		generation: "ssh:h:0:g1",
		kind: "remote",
		files: {
			createEntry: overrides.createEntry ?? (async (parent, name, kind) => ({ target: { projectId: "p1", relativePath: parent.relativePath.length === 0 ? name : parent.relativePath + "/" + name }, kind })),
			renameEntry: overrides.renameEntry ?? (async (target, newName) => ({ target: { projectId: "p1", relativePath: (target.relativePath.includes("/") ? target.relativePath.slice(0, target.relativePath.lastIndexOf("/") + 1) : "") + newName } })),
			deleteEntry: overrides.deleteEntry ?? (async (target) => ({ target, trashId: "trash-1" })),
			moveEntry: overrides.moveEntry ?? (async (target) => ({ target: { projectId: "p1", relativePath: "moved/" + target.relativePath } })),
		},
	};
	const remoteHosts = {
		statProjectEntry: overrides.statProjectEntry ?? (async () => ({ ok: true, value: { stat: { kind: "file" }, version: "entry-token" } })),
		renameProjectEntry:
			overrides.renameProjectEntry ??
			(async (projectId, source, target, version) => {
				calls.shell.push({ kind: "rename", projectId, source, target, version });
				return { ok: true, value: { relativePath: target } };
			}),
		restoreProjectTrash: async () => ({ ok: true, value: { relativePath: "x" } }),
		pruneProjectTrash: async () => ({ ok: true, value: { kept: [] } }),
	};
	const wraps = {
		createEntry: (parent, name, kind) => {
			calls.service.push({ kind: "create", parent, name, entryKind: kind });
			return services.files.createEntry(parent, name, kind);
		},
		renameEntry: (target, newName) => {
			calls.service.push({ kind: "rename", target, newName });
			return services.files.renameEntry(target, newName);
		},
		deleteEntry: (target) => {
			calls.service.push({ kind: "delete", target });
			return services.files.deleteEntry(target);
		},
		moveEntry: (target, destinationRelativePath) => {
			calls.service.push({ kind: "move", target, destinationRelativePath });
			return services.files.moveEntry(target, destinationRelativePath);
		},
	};
	const { useRemoteProjectEntries } = loadTsCommonJs("src/renderer/src/hooks/useRemoteProjectEntries.ts", {
		stubs: {
			react: host.react,
			jotai,
			"../desktopApi": { desktopApi: { remoteHosts } },
			"../i18n": { t: (key, params) => (params === undefined ? key : key + ":" + JSON.stringify(params)) },
			"../atoms/remote-file-atoms": { remoteFileDraftsAtom: atom },
		},
	});
	let view = null;
	let reloads = 0;
	const render = () =>
		(view = host.render(() =>
			useRemoteProjectEntries({
				services: { ...services, files: wraps },
				reload: async () => {
					reloads += 1;
				},
			}),
		));
	return { host, render, view: () => view, calls, atom, reloads: () => reloads };
}

test("新建/同父改名/删除走 ProjectFileService；删除收据保留 trashId；成功后显式刷新", async () => {
	const h = entriesHarness();
	h.render();
	const created = await h.view().createEntry("dir", "file", "a.txt");
	h.render();
	assert.equal(created.ok, true);
	assert.deepEqual(plain(h.calls.service[0]), { kind: "create", parent: { projectId: "p1", relativePath: "dir" }, name: "a.txt", entryKind: "file" });
	assert.equal(h.view().state.phase, "idle");
	assert.equal(h.reloads(), 1);

	// 拖拽移动（改父目录）走 ProjectFileService.moveEntry：provider 负责 local move / remote entry 令牌。
	const moved = await h.view().renameEntry("a.txt", "dir/a.txt");
	h.render();
	assert.equal(moved.ok, true);
	assert.deepEqual(plain(h.calls.service.find((call) => call.kind === "move")), { kind: "move", target: { projectId: "p1", relativePath: "a.txt" }, destinationRelativePath: "dir/a.txt" });
	assert.equal(h.calls.shell.length, 0, "移动不再由渲染层直连 preload");

	// 同父改名走服务，newName 而不是整条路径。
	const renamed = await h.view().renameEntry("dir/b.txt", "dir/c.txt");
	h.render();
	assert.equal(renamed.ok, true);
	const renameCall = h.calls.service.find((call) => call.kind === "rename");
	assert.deepEqual(plain(renameCall), { kind: "rename", target: { projectId: "p1", relativePath: "dir/b.txt" }, newName: "c.txt" });

	const deleted = await h.view().deleteEntry("dir/c.txt");
	h.render();
	assert.equal(deleted.ok, true);
	assert.equal(deleted.value.trashId, "trash-1");
	assert.deepEqual(plain(h.calls.service.filter((call) => call.kind === "delete")), [{ kind: "delete", target: { projectId: "p1", relativePath: "dir/c.txt" } }]);
	h.host.unmount();
});

test("写操作单飞：busy 期间第二个命令返回 REMOTE_FILE_BUSY 且不触达服务", async () => {
	const host = quickMessageHookHost();
	const { atom, jotai } = createAtomStore();
	let resolveCreate;
	const calls = [];
	const services = {
		projectId: "p1",
		generation: "g1",
		kind: "remote",
		files: {
			createEntry: (parent, name) => {
				calls.push(name);
				return new Promise((resolve) => {
					resolveCreate = () => resolve({ target: { projectId: "p1", relativePath: name }, kind: "file" });
				});
			},
			renameEntry: async () => ({}),
			deleteEntry: async () => ({}),
		},
	};
	const { useRemoteProjectEntries } = loadTsCommonJs("src/renderer/src/hooks/useRemoteProjectEntries.ts", {
		stubs: {
			react: host.react,
			jotai,
			"../desktopApi": { desktopApi: { remoteHosts: {} } },
			"../i18n": { t: (key) => key },
			"../atoms/remote-file-atoms": { remoteFileDraftsAtom: atom },
		},
	});
	let view = null;
	const render = () => (view = host.render(() => useRemoteProjectEntries({ services, reload: async () => {} })));
	render();
	const first = view.createEntry("", "file", "a.txt");
	render();
	const second = await view.createEntry("", "file", "b.txt");
	assert.equal(second.ok, false);
	assert.equal(second.code, "REMOTE_FILE_BUSY");
	assert.deepEqual(calls, ["a.txt"]);
	resolveCreate();
	await first;
	render();
	assert.equal(view.state.phase, "idle");
	host.unmount();
});

test("unknown 结果保留草稿与提示，不自动重放；成功改名只回收干净草稿", async () => {
	const h = entriesHarness({
		deleteEntry: async () => {
			throw UNKNOWN();
		},
	});
	// 干净草稿（rename 源）+ 脏草稿（同目录另一文件）：成功改名只删干净的。
	h.atom.value.set(JSON.stringify(["p1", "dir/clean.txt"]), { projectId: "p1", path: "dir/clean.txt", content: "same", savedContent: "same", version: "v", generation: 1, phase: "ready" });
	h.atom.value.set(JSON.stringify(["p1", "dir/dirty.txt"]), { projectId: "p1", path: "dir/dirty.txt", content: "edit", savedContent: "", version: "v", generation: 1, phase: "ready" });
	h.render();
	await h.view().renameEntry("dir/clean.txt", "dir/renamed.txt");
	h.render();
	assert.equal(h.atom.value.has(JSON.stringify(["p1", "dir/clean.txt"])), false);
	assert.equal(h.atom.value.has(JSON.stringify(["p1", "dir/dirty.txt"])), true);

	const result = await h.view().deleteEntry("dir/dirty.txt");
	h.render();
	assert.equal(result.ok, false);
	assert.equal(result.outcome, "unknown");
	assert.equal(h.view().state.phase, "unknown");
	assert.equal(h.view().outcome.kind, "unknown");
	assert.equal(h.atom.value.get(JSON.stringify(["p1", "dir/dirty.txt"])).content, "edit", "unknown 不得回收草稿");
	h.host.unmount();
});
