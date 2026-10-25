/**
 * skill-hub 搜索入参契约：preload 与主进程 handler 必须使用同一份 SkillHubSearchOptions（query/limit）。
 *
 * 回归背景：preload 曾把 api.skillhub.cn 时代的分页/排序参数 (query, page, pageSize, sortBy, order)
 * 透传给只读 { query, limit } 的主进程 handler——面板 `skillHub.search(q, 50)` 的第二个参数落到 page
 * 上被静默丢弃，limit 永远走默认 50，调用方以为自己在控制条数。本用例从 preload 捕获真实 IPC payload，
 * 再喂给注册出来的主进程 handler，锁住「第二个参数 → limit → skills.sh URL」整条链。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

/** 用 electron stub 捕获 contextBridge 暴露的 piDesktop，并记录每次 ipcRenderer.invoke。 */
function capturePreloadApi() {
	const invocations = [];
	let captured = null;
	const electron = {
		contextBridge: { exposeInMainWorld: (name, api) => (captured = { name, api }) },
		ipcRenderer: {
			invoke: (channel, ...args) => {
				invocations.push({ channel, args });
				return Promise.resolve({ query: "", total: 0, items: [] });
			},
			on: () => () => {},
			once: () => {},
			removeListener: () => {},
			send: () => {},
			sendSync: () => ({}),
		},
		webUtils: { getPathForFile: () => "" },
	};
	const preload = loadTsCommonJs("src/preload/index.ts", { stubs: { electron } });
	const api = preload.__pideckPreloadCapture?.api ?? captured?.api;
	assert.ok(api, "preload 捕获失败：contextBridge.exposeInMainWorld 未被调用");
	return { api, invocations };
}

/** 注册 storeIpc，注入假 netFetch（记录请求 URL，按 skills.sh 响应形状返回两条乱序数据）。 */
function registerSkillHubIpc() {
	const handlers = new Map();
	const urls = [];
	const electron = { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
	const { registerStoreIpc } = loadTsCommonJs("src/main/ipc/storeIpc.ts", { stubs: { electron } });
	registerStoreIpc({
		promptManager: {},
		skillManager: {},
		xuePromptManager: {},
		projectResourceManager: {},
		extensionManager: {},
		netFetch: async (url) => {
			urls.push(url);
			return {
				ok: true,
				status: 200,
				json: async () => ({
					skills: [
						{ id: "acme/low", skillId: "low", name: "low", installs: 5, source: "acme" },
						{ id: "acme/high", skillId: "high", name: "high", installs: 9, source: "acme" },
					],
				}),
			};
		},
		appLogger: { info: async () => {}, warn: async () => {} },
		mainCopy: (key) => key,
	});
	const handler = handlers.get(ipcChannels.skillHubSearch);
	assert.equal(typeof handler, "function", "skill-hub:search handler 未注册");
	return { handler, urls };
}

test("preload skillHub.search 只发送 { query, limit }（不再透传分页/排序遗留参数）", async () => {
	const { api, invocations } = capturePreloadApi();
	await api.skillHub.search("pdf ocr", 20);
	assert.equal(invocations.length, 1);
	assert.equal(invocations[0].channel, ipcChannels.skillHubSearch);
	const payload = invocations[0].args[0];
	assert.deepEqual(Object.keys(payload).sort(), ["limit", "query"]);
	assert.equal(payload.query, "pdf ocr");
	assert.equal(payload.limit, 20);
});

test("preload → 主进程端到端：第二个参数落到 limit，而不是被 page 吞掉", async () => {
	const { api, invocations } = capturePreloadApi();
	await api.skillHub.search("pdf", 20);
	const { handler, urls } = registerSkillHubIpc();
	const result = await handler({}, invocations[0].args[0]);
	// 回归点：修前 payload 是 { query, page: 20 }，主进程读不到 limit，URL 只能退回默认 limit=50。
	assert.equal(urls[0], "https://www.skills.sh/api/search?q=pdf&limit=20");
	assert.equal(result.query, "pdf");
	assert.equal(result.total, 2);
	assert.deepEqual(
		result.items.map((item) => [item.slug, item.downloads, item.ownerName]),
		[
			["acme/high", 9, "acme"],
			["acme/low", 5, "acme"],
		],
	);
});

test("主进程 limit 缺省 50：只传 query 的调用保持旧行为", async () => {
	const { handler, urls } = registerSkillHubIpc();
	const result = await handler({}, { query: "pdf" });
	assert.equal(urls[0], "https://www.skills.sh/api/search?q=pdf&limit=50");
	assert.equal(result.query, "pdf");
});
