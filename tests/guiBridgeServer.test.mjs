/**
 * GUI 扩展桥端点（BridgeServer）的运行时测试。
 *
 * 用**真实 HTTP 往返**验证协议，而不是 mock：
 * - 多 agent 会话隔离（token 各自独立）
 * - 更新上行 / 事件下行（一次往返完成双向，§9.2）
 * - 未知 token / 错误方法 / 非法 JSON 的降级行为
 * - 注销后不再接受数据
 *
 * 加载方式：Node 原生 TS 类型擦除直接 import 源文件（仓库无 node_modules 也能跑）。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

// 生产代码用仓库约定的无扩展名相对 import（jiti/bundler 可解析，Node ESM 不可），
// 测试侧补一层解析钩子。
import "./helpers/tsResolveHook.mjs";

const serverMod = await import("../src/main/pi/bridge/BridgeServer.ts");

/** 起一个真实端点，返回句柄。 */
async function startServer() {
	const server = new serverMod.BridgeServer();
	const info = await server.start();
	assert.ok(info, "端点应启动成功");
	return { server, baseUrl: info.baseUrl };
}

/** 发一次桥请求，返回响应体。 */
async function post(url, body, headers = {}) {
	const response = await fetch(`${url}/ui`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	return { status: response.status, body: await response.json().catch(() => null) };
}

describe("BridgeServer: 端点与协议", () => {
	let server;
	let baseUrl;

	before(async () => {
		const started = await startServer();
		server = started.server;
		baseUrl = started.baseUrl;
	});

	after(() => {
		server?.stop();
	});

	it("只绑回环地址（不对外暴露）", () => {
		assert.ok(baseUrl.startsWith("http://127.0.0.1:"), `端点应在 127.0.0.1 上，实际 ${baseUrl}`);
	});

	it("注册 agent 返回独享 URL 与 token", () => {
		const a = server.registerAgent("agent-a", () => {});
		const b = server.registerAgent("agent-b", () => {});
		assert.ok(a.url.endsWith(a.token), "URL 末尾应是 token");
		assert.notEqual(a.token, b.token, "不同 agent 必须拿到不同 token（多会话隔离）");
		assert.ok(server.ready);
	});

	it("更新上行：桥推的 updates 被转发给 onUpdate", async () => {
		const received = [];
		const { url } = server.registerAgent("agent-up", (update) => received.push(update));
		const result = await post(url, { updates: [{ type: "status", key: "k", text: "v" }] });
		assert.equal(result.status, 200);
		assert.equal(received.length, 1, "应收到 1 条更新");
		assert.equal(received[0].type, "status");
		assert.equal(received[0].key, "k");
	});

	it("事件下行：响应体带回待处理事件（一次往返双向）", async () => {
		const { url } = server.registerAgent("agent-down", () => {});
		// 渲染层排入两个事件
		assert.equal(server.pushEvent("agent-down", { type: "select", nodeId: "n1", index: 2 }), true);
		assert.equal(server.pushEvent("agent-down", { type: "action", actionId: "a1" }), true);
		// 桥的一次轮询取走它们
		const result = await post(url, { updates: [] });
		assert.equal(result.body.events.length, 2);
		assert.equal(result.body.events[0].type, "select");
		assert.equal(result.body.events[1].type, "action");
		// 取走后队列清空
		const second = await post(url, { updates: [] });
		assert.equal(second.body.events.length, 0, "事件应被取走，不重复投递");
	});

	it("会话隔离：事件只投递给对应 token", async () => {
		const a = server.registerAgent("iso-a", () => {});
		const b = server.registerAgent("iso-b", () => {});
		server.pushEvent("iso-a", { type: "key", nodeId: "na", key: "enter" });
		const resultB = await post(b.url, { updates: [] });
		assert.equal(resultB.body.events.length, 0, "B 不该拿到 A 的事件");
		const resultA = await post(a.url, { updates: [] });
		assert.equal(resultA.body.events.length, 1, "A 应拿到自己的事件");
	});

	it("未知 token：接受请求但静默不做事（不报错、不打断桥）", async () => {
		const result = await post(`${baseUrl}/no-such-token`, { updates: [{ type: "resync" }] });
		assert.equal(result.status, 200, "未知 token 不应让桥侧收到错误（避免重试风暴）");
		assert.deepEqual(result.body.events, []);
	});

	it("非法 JSON：当作空更新，不打断轮询", async () => {
		const received = [];
		const { url } = server.registerAgent("agent-badjson", (u) => received.push(u));
		const result = await post(url, "{ this is not json");
		assert.equal(result.status, 200);
		assert.equal(received.length, 0);
		assert.deepEqual(result.body.events, []);
	});

	it("空 body：可接受（桥空闲轮询取事件）", async () => {
		const { url } = server.registerAgent("agent-empty", () => {});
		const result = await post(url, "");
		assert.equal(result.status, 200);
	});

	it("token 头不匹配 → 403", async () => {
		const { url, token } = server.registerAgent("agent-token", () => {});
		const result = await post(url, { updates: [] }, { "x-pideck-bridge-token": "wrong-token" });
		assert.equal(result.status, 403);
		assert.ok(token);
	});

	it("token 头匹配 → 正常", async () => {
		const { url, token } = server.registerAgent("agent-token-ok", () => {});
		const result = await post(url, { updates: [] }, { "x-pideck-bridge-token": token });
		assert.equal(result.status, 200);
	});

	it("非 POST → 405", async () => {
		const response = await fetch(`${baseUrl}/whatever/ui`, { method: "GET" });
		assert.equal(response.status, 405);
	});

	it("错误路径 → 404", async () => {
		const response = await fetch(`${baseUrl}/wrong/path`, { method: "POST", body: "{}" });
		assert.equal(response.status, 404);
	});

	it("onUpdate 抛错不影响其他更新与桥", async () => {
		let calls = 0;
		const { url } = server.registerAgent("agent-throw", () => {
			calls += 1;
			throw new Error("forward boom");
		});
		const result = await post(url, { updates: [{ type: "resync" }, { type: "resync" }] });
		assert.equal(result.status, 200, "单条转发失败不应让请求失败");
		assert.equal(calls, 2, "后续更新仍应被处理");
	});

	it("注销后不再接受该 agent 的数据", async () => {
		const received = [];
		const { url } = server.registerAgent("agent-unreg", (u) => received.push(u));
		server.unregisterAgent("agent-unreg");
		const result = await post(url, { updates: [{ type: "resync" }] });
		// token 已注销 → 走「未知 token」路径：200 + 空事件，不转发
		assert.equal(result.status, 200);
		assert.equal(received.length, 0, "注销后不应再转发更新");
	});

	it("isAgentConnected：有往来即视为连接", async () => {
		const { url } = server.registerAgent("agent-conn", () => {});
		await post(url, { updates: [] });
		assert.equal(server.isAgentConnected("agent-conn"), true);
		assert.equal(server.isAgentConnected("never-seen"), false, "未注册的 agent 视为未连接");
	});

	it("事件队列有上限（防渲染层刷屏顶爆内存）", async () => {
		const { url } = server.registerAgent("agent-flood", () => {});
		for (let i = 0; i < 600; i += 1) {
			server.pushEvent("agent-flood", { type: "key", nodeId: "n", key: "up" });
		}
		const result = await post(url, { updates: [] });
		assert.ok(result.body.events.length <= 500, `队列应有上限，实际 ${result.body.events.length}`);
	});

	it("重复注册同一 agent 复用 token", () => {
		const first = server.registerAgent("agent-reuse", () => {});
		const second = server.registerAgent("agent-reuse", () => {});
		assert.equal(first.token, second.token, "同 agent 重复注册应复用 token（重启/重连场景）");
	});

	it("stop() 后 ready 为 false", () => {
		const temp = new serverMod.BridgeServer();
		temp.stop();
		assert.equal(temp.ready, false);
	});

	it("pushEvent 对未注册 agent 返回 false", () => {
		assert.equal(server.pushEvent("no-such-agent", { type: "resync" }), false);
	});
});
