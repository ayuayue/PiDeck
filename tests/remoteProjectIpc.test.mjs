import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * G1 拆分守卫：hosts 域与项目域各自注册自己的通道，且两个文件都在体量红线内。
 *
 * 这里只断言「域边界」与「体量」两件事；每个 handler 的行为验证仍在 tests/remoteHostIpc.test.mjs
 * （其中项目域那部分已改为从 remoteProjectIpc.ts 注册）。行数用文件自身统计，避免把体量债又欠回去。
 */

const HOSTS_FILE = "src/main/ipc/remoteHostIpc.ts";
const PROJECT_FILE = "src/main/ipc/remoteProjectIpc.ts";
const PROJECT_READ_FILE = "src/main/ipc/remoteProjectReadIpc.ts";
const HOST_CHANNELS = ["remote:hosts-list", "remote:connect", "remote:disconnect", "remote:diagnostics", "remote:scan-config", "remote:add", "remote:repair-diagnose", "remote:repair-run", "remote:repair-answer"];
const PROJECT_CHANNELS = ["remote:project-enroll", "remote:project-answer", "remote:project-list", "remote:project-read", "remote:project-search", "remote:project-root-status"];

function registeredChannels(file, registerName, input) {
	const handlers = new Map();
	const module = loadTsCommonJs(file, {
		stubs: {
			// 下载通道用到保存对话框 / 窗口归属；这里只需要「不炸」，断言的是通道注册归属。
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, dialog: { showSaveDialog: async () => ({ canceled: true }) }, BrowserWindow: { fromWebContents: () => null } },
			"../remote/RemoteBrowseRoot": { resolveRemoteBrowseRoot: async ({ userPath }) => ({ canonicalPath: userPath }) },
			"../remote/RemoteSearchReader": {
				REMOTE_SEARCH_READER_CODES: { queryInvalid: "QUERY_INVALID", requestFailed: "REMOTE_WORKSPACE_REQUEST_FAILED", optionsInvalid: "REMOTE_WORKSPACE_READER_OPTIONS_INVALID" },
				createRemoteSearchReader: () => ({ search: async () => ({ entries: [], scanned: 0, truncated: false }) }),
			},
			"../remote/RemoteWorkspaceReader": { createRemoteWorkspaceReader: () => ({ list: async () => ({ entries: [] }), readFile: async () => ({ content: Buffer.alloc(0), bytes: 0, mtimeMs: 0 }) }) },
		},
	});
	module[registerName](input);
	return handlers;
}

test("hosts 域与项目域各自注册自己的通道，互不越界", () => {
	const hosts = registeredChannels(HOSTS_FILE, "registerRemoteHostIpc", { enabled: true, userDataDir: "/tmp/ignored", list: async () => ({ snapshot: { status: "ready", profiles: [] }, findings: [] }) });
	for (const channel of HOST_CHANNELS) assert.ok(hosts.has(channel), "hosts 域应注册 " + channel);
	for (const channel of PROJECT_CHANNELS) assert.ok(!hosts.has(channel), "hosts 域不应注册 " + channel);

	const projects = registeredChannels(PROJECT_FILE, "registerRemoteProjectIpc", { enabled: true, userDataDir: "/tmp/ignored" });
	for (const channel of PROJECT_CHANNELS) assert.ok(projects.has(channel), "项目域应注册 " + channel);
	for (const channel of HOST_CHANNELS) assert.ok(!projects.has(channel), "项目域不应注册 " + channel);
});

test("hosts 文件不再携带项目域（搬迁必须搬干净，不留第二份实现）", () => {
	const hosts = readFileSync(HOSTS_FILE, "utf8");
	for (const symbol of ["registerRemoteProjectIpc", "projectReadTarget", "sessionPort", "readerPath(", "readRelativePath", "createRemoteWorkspaceReader", "createRemoteSearchReader", "resolveRemoteBrowseRoot", "RemoteProject"]) {
		assert.ok(!hosts.includes(symbol), "hosts 文件不应再出现 " + symbol);
	}
	assert.ok(!/projects\s*\??:/.test(hosts), "hosts 注册入口不应再接受 projects 端口");
});

test("项目域文件按写面/读面拆分，各自都在体量红线内", () => {
	const project = readFileSync(PROJECT_FILE, "utf8");
	const read = readFileSync(PROJECT_READ_FILE, "utf8");
	const hosts = readFileSync(HOSTS_FILE, "utf8");
	for (const symbol of ["remoteProjectEnroll", "remoteProjectAnswer"]) assert.ok(project.includes(symbol), "项目写面应注册 " + symbol);
	for (const symbol of ["remoteProjectList", "remoteProjectRead", "remoteProjectSearch"]) assert.ok(read.includes(symbol), "项目读面应注册 " + symbol);
	assert.ok(!project.includes("remoteProjectList"), "读面 handler 不应留在写面文件");
	assert.ok(!project.includes("remoteHostConnect"), "项目域不应注册 hosts 域通道");
	const projectLines = project.split(String.fromCharCode(10)).length;
	const readLines = read.split(String.fromCharCode(10)).length;
	const hostsLines = hosts.split(String.fromCharCode(10)).length;
	assert.ok(projectLines < 400, "remoteProjectIpc.ts 应 <400 行，实际 " + projectLines);
	assert.ok(readLines < 400, "remoteProjectReadIpc.ts 应 <400 行，实际 " + readLines);
	assert.ok(hostsLines < 600, "remoteHostIpc.ts 应 <600 行，实际 " + hostsLines);
});

test("装配层同时注册两个域", () => {
	const main = readFileSync("src/main/index.ts", "utf8");
	assert.match(main, /import\s*\{\s*registerRemoteProjectIpc\s*\}\s*from\s*"\.\/ipc\/remoteProjectIpc"/);
	assert.match(main, /registerRemoteProjectIpc\(\{[\s\S]{0,300}?enabled:\s*remoteFeatureEnabled/);
	assert.match(main, /registerRemoteHostIpc\(\{[\s\S]{0,400}?enabled:\s*remoteFeatureEnabled/);
});
