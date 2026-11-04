import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ProjectFileBackendRouter } = loadTsCommonJs("src/main/files/ProjectFileBackend.ts");

function locator(kind, environment) {
	return kind === "ssh" ? { kind: "ssh", hostId: "h1", remotePath: "/srv/p" } : { kind: "local", environment, localPath: "/p" };
}

test("router selects the WSL backend only for local locators whose environment is wsl", () => {
	const local = { locationKind: "local", marker: "local" };
	const wsl = { locationKind: "local", marker: "wsl" };
	const locators = { wsl: locator("local", "wsl"), win: locator("local", "windows"), ssh: locator("ssh") };
	const router = new ProjectFileBackendRouter(local, (id) => locators[id], wsl);
	assert.strictEqual(router.forProject("wsl"), wsl);
	assert.strictEqual(router.forProject("win"), local);
	assert.throws(() => router.forProject("ssh"), /UNSUPPORTED_PROJECT_LOCATION/);
	assert.throws(() => router.forProject("unknown"), /PROJECT_NOT_FOUND/);

	// 未装配 WSL backend 时保持今天的本地行为（单测/不启动 WSL 的场景）。
	const localOnly = new ProjectFileBackendRouter(local, (id) => locators[id]);
	assert.strictEqual(localOnly.forProject("wsl"), local);
});

function createWslFilesIpc({ settings, project, pool }) {
	const handlers = new Map();
	const localCalls = [];
	const electron = {
		app: {},
		dialog: {},
		ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
		shell: { openPath: async () => "", showItemInFolder: () => undefined },
	};
	const { registerFilesIpc } = loadTsCommonJs("src/main/ipc/filesIpc.ts", { stubs: { electron } });
	registerFilesIpc({
		fileSystemService: {
			listTree: async () => {
				localCalls.push("listTree");
				return [{ name: "from-local", relativePath: "from-local", type: "file" }];
			},
			listTreePage: async () => {
				localCalls.push("listTreePage");
				return { nodes: [], truncated: false };
			},
			searchNames: async () => {
				localCalls.push("searchNames");
				return [];
			},
			create: async () => undefined,
			delete: async () => undefined,
			rename: async () => undefined,
		},
		projectStore: { get: (id) => (id === project.id ? project : undefined) },
		settingsStore: { get: () => settings },
		appLogger: { info: async () => undefined, error: async () => undefined },
		openExternalUrl: async () => undefined,
		wslHelperPool: pool,
	});
	const call = (channel, ...args) => {
		const handler = handlers.get(channel);
		assert.ok(handler, `handler for ${channel}`);
		return handler({}, ...args);
	};
	return { call, localCalls };
}

function createFakePool() {
	const calls = [];
	return {
		calls,
		async request(target, method, params) {
			calls.push({ target, method, params });
			if (method === "fs.list")
				return {
					entries: [
						{ name: "a.txt", kind: "file", bytes: 3 },
						{ name: "sub", kind: "directory" },
					],
				};
			if (method === "fs.statMany") return { entries: params.paths.map((path) => ({ path, kind: path === "sub" ? "directory" : "file", bytes: 3, mtimeMs: 1_700_000_000_000 })) };
			if (method === "fs.stat") return { kind: "file", bytes: 3, mtimeMs: 1_700_000_000_000 };
			if (method === "fs.read") return { chunk: Buffer.from("hi!").toString("base64"), bytes: 3, eof: true };
			throw new Error("PROTOCOL_INVALID");
		},
		async cancel() {},
		async close() {},
		closeAll() {},
		activeCount: () => 1,
	};
}

const WSL_PROJECT = { id: "project-wsl", name: "WSL", path: "/root/proj", environment: "wsl", lastOpenedAt: 0 };
const WSL_SETTINGS = { wslEnabled: true, wslDistro: "Debian", wslUser: "root" };
// 回退到本机 backend 的用例需要一个 Windows 侧真实可 realpath 的根；`/root/proj` 的 UNC 在本机就是 EPERM。
const LOCAL_FALLBACK_PROJECT = { ...WSL_PROJECT, path: process.cwd() };

// WSL 身份解析不走 wsl.exe，但 filesIpc 按 process.platform 决定是否启用 helper；非 Windows 主机上项目路径不可达。
const wslHost = { skip: process.platform !== "win32" };

test("files:list for a WSL project is served by the in-distro helper, not the UNC path", wslHost, async () => {
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const pool = createFakePool();
	const { call, localCalls } = createWslFilesIpc({ settings: WSL_SETTINGS, project: WSL_PROJECT, pool });
	const nodes = await call(ipcChannels.filesList, { projectId: WSL_PROJECT.id, relativePath: "" });
	const plain = JSON.parse(JSON.stringify(nodes));
	assert.deepEqual(
		plain.map((node) => [node.name, node.type, node.relativePath]),
		[
			["sub", "directory", "sub"],
			["a.txt", "file", "a.txt"],
		],
	);
	assert.deepEqual(plain[1].target, { projectId: WSL_PROJECT.id, relativePath: "a.txt" });
	assert.deepEqual(JSON.parse(JSON.stringify(pool.calls[0].target)), { distro: "Debian", user: "root", root: "/root/proj" });
	assert.deepEqual(localCalls, []);
});

test("files:directory-page and files:read-content for a WSL project route through the helper", wslHost, async () => {
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const pool = createFakePool();
	const { call, localCalls } = createWslFilesIpc({ settings: WSL_SETTINGS, project: WSL_PROJECT, pool });
	const page = await call(ipcChannels.filesDirectoryPage, { projectId: WSL_PROJECT.id, relativePath: "" });
	assert.equal(page.ok, true);
	assert.equal(page.value.generation, "wsl");
	// 目录页保留 helper 的条目顺序（与 SSH 侧一致）；本机 listTreePage 才做目录优先排序。
	assert.deepEqual(JSON.parse(JSON.stringify(page.value.entries.map((entry) => [entry.relativePath, entry.hasChildren]))), [
		["a.txt", false],
		["sub", "unknown"],
	]);
	assert.equal(await call(ipcChannels.filesReadContent, { projectId: WSL_PROJECT.id, relativePath: "a.txt" }), "hi!");
	assert.deepEqual(localCalls, []);
});

test("WSL projects stay on the UNC local backend when the helper pool is not assembled", wslHost, async () => {
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const { call, localCalls } = createWslFilesIpc({ settings: WSL_SETTINGS, project: LOCAL_FALLBACK_PROJECT, pool: undefined });
	const nodes = await call(ipcChannels.filesList, { projectId: WSL_PROJECT.id, relativePath: "" });
	const plain = JSON.parse(JSON.stringify(nodes));
	assert.deepEqual(
		plain.map((node) => node.name),
		["from-local"],
	);
	assert.deepEqual(localCalls, ["listTree"]);
});

test("a disabled WSL setting keeps the local backend even with a pool", wslHost, async () => {
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const pool = createFakePool();
	const { call, localCalls } = createWslFilesIpc({ settings: { ...WSL_SETTINGS, wslEnabled: false }, project: LOCAL_FALLBACK_PROJECT, pool });
	await call(ipcChannels.filesList, { projectId: WSL_PROJECT.id, relativePath: "" });
	assert.deepEqual(localCalls, ["listTree"]);
	assert.equal(pool.calls.length, 0);
});
