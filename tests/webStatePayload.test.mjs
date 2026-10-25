import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { gunzipSync } from "node:zlib";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// /api/state 载荷治理（Web 走查 #6/#7）：
//  - #6 会话按 Web 可见字段投影，桌面端专用字段（filePath/environment/preview/
//    messageCount/dshSessionId/agentPreset）不下发；
//  - #7 大响应按 accept-encoding 走 gzip，未声明/小响应保持明文。
// 只测行为契约：从 HTTP 边界断言，不依赖内部字段名。

/** 起一个真 server（与 webServiceBodyLimit 同装配），跑完即停。 */
async function withServer(run, { sessionCount = 1 } = {}) {
	const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts", { globals: { fetch: globalThis.fetch } });
	const session = {
		id: "session-1",
		projectId: "project-1",
		title: "Session 1",
		source: "pi",
		environment: "native",
		filePath: "C:/sessions/session-1.jsonl",
		preview: "preview text",
		messageCount: 12,
		status: "active",
		model: { provider: "deepseek", modelId: "deepseek-flash" },
		thinkingLevel: "low",
		permissionPreset: "workspace-write",
		dshSessionId: "dsh-1",
		agentPreset: "standard",
		createdAt: 1,
		updatedAt: 2,
	};
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
		listProjects: () => [{ id: "project-1", name: "Project", path: "C:/project" }],
		listCatalogSessions: async () => Array.from({ length: sessionCount }, (_, index) => (index === 0 ? session : { ...session, id: `session-${index + 1}`, title: `Session ${index + 1}` })),
		listSessionRuntimes: () => [{ sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1, status: "idle", cwd: "C:/project", projectId: "project-1", createdAt: 3 }],
		listPendingUiRequests: () => [],
	});
	await manager.start("127.0.0.1", 0, false);
	const baseUrl = `http://127.0.0.1:${manager.current.port}`;
	try {
		await run({ baseUrl });
	} finally {
		await manager.stop();
	}
}

/** 原始 HTTP GET：Node fetch 会自动解 gzip 并剥掉 content-encoding，看不出服务端是否真压了。 */
function rawGet(url, headers = {}) {
	return new Promise((resolve, reject) => {
		const request = http.get(url, { headers }, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
		});
		request.on("error", reject);
	});
}

test("state sessions are projected to the web-visible field set", async () => {
	await withServer(async ({ baseUrl }) => {
		const { body } = await rawGet(`${baseUrl}/api/state`);
		const state = JSON.parse(body.toString("utf8"));
		assert.equal(state.sessions.length, 1);
		const session = state.sessions[0];
		// 保留：渲染层读取的字段
		assert.deepEqual(
			{ id: session.id, projectId: session.projectId, title: session.title, status: session.status, updatedAt: session.updatedAt, permissionPreset: session.permissionPreset },
			{ id: "session-1", projectId: "project-1", title: "Session 1", status: "active", updatedAt: 2, permissionPreset: "workspace-write" },
		);
		// 裁剪：Web 端零消费的桌面端专用字段
		for (const dropped of ["filePath", "environment", "preview", "messageCount", "dshSessionId", "agentPreset", "source"]) {
			assert.equal(dropped in session, false, `${dropped} must not be sent to the web client`);
		}
	});
});

test("large JSON responses are gzipped when the client asks for it", async () => {
	// 400 条会话 → 快照远超 8KB 压缩阈值（单条会话的 state 太小，压了反而亏）
	await withServer(
		async ({ baseUrl }) => {
			const big = await rawGet(`${baseUrl}/api/state`, { "accept-encoding": "gzip" });
			const plain = await rawGet(`${baseUrl}/api/state`);
			assert.equal(big.headers["content-encoding"], "gzip");
			assert.equal(plain.headers["content-encoding"], undefined);
			assert.equal(big.headers.vary, "accept-encoding");
			// 压缩后必须能还原成同一份快照
			const decompressed = JSON.parse(gunzipSync(big.body).toString("utf8"));
			assert.deepEqual(decompressed, JSON.parse(plain.body.toString("utf8")));
			assert.ok(big.body.byteLength < plain.body.byteLength, "gzipped body must be smaller");
		},
		{ sessionCount: 400 },
	);
});

test("gzip is skipped for small payloads and for q=0 clients", async () => {
	await withServer(
		async ({ baseUrl }) => {
			const small = await rawGet(`${baseUrl}/api/sessions/runtimes`, { "accept-encoding": "gzip" });
			assert.equal(small.headers["content-encoding"], undefined, "tiny payloads are not worth a 6ms gzip round");
			// q=0 显式拒绝 gzip：即便载荷够大也必须明文
			const refused = await rawGet(`${baseUrl}/api/state`, { "accept-encoding": "gzip;q=0, identity" });
			assert.equal(refused.headers["content-encoding"], undefined);
		},
		{ sessionCount: 400 },
	);
});

// ── 会话内全文检索端点（Web 走查 #13）────────────────────────────────────────
// 契约：恒 200；未装配 / 空 query / 超长 query / 后端抛错 一律 `{ result: null }`
// （前端据此回退本地已加载搜索，不能把「读不到」渲染成「没有命中」）。
async function withSearchServer(run, searchSessionMessages) {
	const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts", { globals: { fetch: globalThis.fetch } });
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
		listProjects: () => [],
		listCatalogSessions: async () => [],
		listSessionRuntimes: () => [],
		listPendingUiRequests: () => [],
		searchSessionMessages,
	});
	await manager.start("127.0.0.1", 0, false);
	const baseUrl = `http://127.0.0.1:${manager.current.port}`;
	try {
		await run({ baseUrl });
	} finally {
		await manager.stop();
	}
}

test("session search endpoint returns backend hits for the whole session", async () => {
	const calls = [];
	await withSearchServer(
		async ({ baseUrl }) => {
			const res = await fetch(`${baseUrl}/api/sessions/session-1/search?q=needle`);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.result.sessions[0].matches[0].messageId, "line-42");
			assert.equal(body.result.sessions[0].hitCount, 7);
			assert.equal(body.result.totalHitSessions, 1);
		},
		async (sessionId, query) => {
			calls.push([sessionId, query]);
			return { sessions: [{ filePath: "C:/sessions/session-1.jsonl", updatedAtMs: 1, hitCount: 7, matches: [{ messageId: "line-42", role: "assistant", timestampMs: 2, snippet: "…needle…" }] }], totalHitSessions: 1, truncated: true };
		},
	);
	assert.deepEqual(calls, [["session-1", "needle"]]);
});

test("session search degrades to null instead of failing the request", async () => {
	let calls = 0;
	await withSearchServer(
		async ({ baseUrl }) => {
			// 空 query / 超长 query 不打后端（避免无意义全量扫描）
			const empty = await (await fetch(`${baseUrl}/api/sessions/session-1/search?q=%20%20`)).json();
			assert.equal(empty.result, null);
			const tooLong = await (await fetch(`${baseUrl}/api/sessions/session-1/search?q=${"x".repeat(300)}`)).json();
			assert.equal(tooLong.result, null);
			assert.equal(calls, 0);
			// 后端抛错仍然是 200 + null（可降级，不是错误）
			const res = await fetch(`${baseUrl}/api/sessions/session-1/search?q=boom`);
			assert.equal(res.status, 200);
			assert.equal((await res.json()).result, null);
		},
		async () => {
			calls += 1;
			throw new Error("index exploded");
		},
	);
});

// ── 供应商额度用量端点（Web 走查 m02502）────────────────────────────────────
// 契约：恒 200 + `{ result }`；未装配 / 空 provider / 超长 provider / 探针抛错
// 一律降级成 `success: false, disabled: true`（用量查询是用户显式开关的能力，
// 「没开」必须与「查不到」区分开，且绝不能让 Web 端拿到内部错误文案）。
async function withUsageServer(run, fetchProviderUsage) {
	const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts", { globals: { fetch: globalThis.fetch } });
	const manager = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
		listProjects: () => [],
		listCatalogSessions: async () => [],
		listSessionRuntimes: () => [],
		listPendingUiRequests: () => [],
		fetchProviderUsage,
	});
	await manager.start("127.0.0.1", 0, false);
	const baseUrl = `http://127.0.0.1:${manager.current.port}`;
	try {
		await run({ baseUrl });
	} finally {
		await manager.stop();
	}
}

test("provider usage endpoint returns the probe result", async () => {
	const calls = [];
	await withUsageServer(
		async ({ baseUrl }) => {
			const res = await fetch(`${baseUrl}/api/usage/deepseek?backend=pi`);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.result.success, true);
			assert.equal(body.result.kind, "balance");
			assert.equal(body.result.balance.value, 12.34);
			// 缺省 backend 按 pi 处理
			const plain = await (await fetch(`${baseUrl}/api/usage/deepseek`)).json();
			assert.equal(plain.result.success, true);
		},
		async (provider, backend) => {
			calls.push([provider, backend]);
			return { success: true, provider, kind: "balance", balance: { value: 12.34, currency: "CNY" }, at: 1 };
		},
	);
	assert.deepEqual(calls, [
		["deepseek", "pi"],
		["deepseek", "pi"],
	]);
});

test("provider usage degrades to a disabled result instead of failing", async () => {
	await withUsageServer(
		async ({ baseUrl }) => {
			// 空 provider / 超长 provider 不打后端
			const missing = await (await fetch(`${baseUrl}/api/usage/%20%20`)).json();
			assert.equal(missing.result.success, false);
			assert.equal(missing.result.disabled, true);
			const tooLong = await (await fetch(`${baseUrl}/api/usage/${"x".repeat(200)}`)).json();
			assert.equal(tooLong.result.disabled, true);
			// 探针抛错仍是 200 + disabled（不可弹 toast 也不回内部错误）
			const res = await fetch(`${baseUrl}/api/usage/boom`);
			assert.equal(res.status, 200);
			const body = await res.json();
			assert.equal(body.result.success, false);
			assert.equal(body.result.provider, "boom");
			assert.equal(body.result.error, undefined);
		},
		async () => {
			throw new Error("probe exploded");
		},
	);
});

test("provider usage stays disabled when the dependency is not wired", async () => {
	await withUsageServer(async ({ baseUrl }) => {
		const res = await fetch(`${baseUrl}/api/usage/deepseek`);
		assert.equal(res.status, 200);
		assert.equal((await res.json()).result.disabled, true);
	}, undefined);
});
