// pi-deck-model-trace 扩展（resources/extensions/pi-deck-model-trace.ts）的测试。
//
// 两个层面：
// 1. **行为**（真实执行扩展代码）：用 createTsSandbox 加载 .ts（Node 类型擦除 + vm），
//    注入假 process.env / fetch，捕获 pi.on 注册的 handler，验证——
//    env 缺失整体不工作、请求帧字段与截断、请求↔响应按会话配对、fetch 失败不冒泡、
//    并发上限丢弃；以及 handler **必须返回 undefined**（pi 的 runner 串行 await，
//    返回非 undefined 会替换 provider payload）。
// 2. **契约**：扩展帧里的字段名必须是 src/shared/types/modelTrace.ts 的
//    ModelTraceRequestInput / ModelTraceResponseInput 声明过的子集——扩展是自包含 .ts
//    （不能 import 共享类型，只能 import type），字段漂移不会有编译错误兜底。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const TRACE_URL = "http://127.0.0.1:45999/trace/token-abc";
const TRACE_TOKEN = "token-abc";

/** 载入扩展并注册到假 pi API，返回捕获的 handler 与 fetch 调用记录。 */
function loadExtension({ env = { PIDECK_MODEL_TRACE_URL: TRACE_URL, PIDECK_MODEL_TRACE_TOKEN: TRACE_TOKEN }, fetchImpl } = {}) {
	const handlers = new Map();
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
	};
	const fetchCalls = [];
	const stderr = [];
	const sandbox = createTsSandbox({
		globals: {
			process: { env, pid: 4242, stderr: { write: (line) => stderr.push(String(line)) } },
			fetch: (...args) => {
				fetchCalls.push({ url: args[0], options: args[1] });
				return fetchImpl ? fetchImpl(...args) : Promise.resolve({ ok: true, status: 200 });
			},
		},
	});
	const extension = sandbox("resources/extensions/pi-deck-model-trace.ts");
	extension.default(pi);
	return { handlers, fetchCalls, stderr, extension };
}

/** 假 ExtensionContext：只提供扩展实际读取的字段。 */
function makeContext({ sessionId = "session-1", model = { id: "claude-sonnet-4", provider: "anthropic" } } = {}) {
	return { sessionManager: { getSessionId: () => sessionId }, model };
}

function parseFrame(call) {
	return JSON.parse(call.options.body);
}

test("env 缺失时整体不工作（纯终端跑 pi / trace 端点未就绪）", () => {
	const noUrl = loadExtension({ env: {} });
	assert.equal(noUrl.handlers.size, 0, "没有 trace 环境变量就不该注册任何 handler");
	const noToken = loadExtension({ env: { PIDECK_MODEL_TRACE_URL: TRACE_URL } });
	assert.equal(noToken.handlers.size, 0, "缺 token 同样整体不工作");
});

test("before_provider_request：推请求帧且返回 undefined（不得替换 payload）", async () => {
	const { handlers, fetchCalls } = loadExtension();
	const payload = { model: "claude-sonnet-4", system: "你是一个编码助手", messages: [{ role: "user", content: "hi" }], tools: [{ name: "bash" }, { name: "read" }] };
	const result = handlers.get("before_provider_request")({ type: "before_provider_request", payload }, makeContext());
	assert.equal(result, undefined, "返回值必须 undefined：非 undefined 会被 pi 当作替换后的 payload");
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(fetchCalls.length, 1);
	assert.equal(fetchCalls[0].url, TRACE_URL);
	assert.equal(fetchCalls[0].options.method, "POST");
	assert.equal(fetchCalls[0].options.headers["x-pideck-model-trace-token"], TRACE_TOKEN);
	const frame = parseFrame(fetchCalls[0]);
	assert.equal(frame.kind, "request");
	assert.match(frame.traceId, /^[A-Za-z0-9_-]{1,64}$/);
	assert.equal(frame.model, "claude-sonnet-4");
	assert.equal(frame.provider, "anthropic");
	assert.equal(frame.sessionId, "session-1");
	assert.equal(frame.payloadJson, JSON.stringify(payload));
	assert.equal(frame.payloadBytes, Buffer.byteLength(JSON.stringify(payload), "utf8"));
	assert.equal(frame.truncated, false);
	assert.equal(frame.messageCount, 1);
	assert.equal(frame.toolCount, 2);
});

test("after_provider_response：按会话配对到请求的 traceId，带上状态与耗时", async () => {
	const { handlers, fetchCalls } = loadExtension();
	handlers.get("before_provider_request")({ payload: { messages: [] } }, makeContext());
	const result = handlers.get("after_provider_response")({ type: "after_provider_response", status: 200, headers: {} }, makeContext());
	assert.equal(result, undefined);
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(fetchCalls.length, 2);
	const request = parseFrame(fetchCalls[0]);
	const response = parseFrame(fetchCalls[1]);
	assert.equal(response.kind, "response");
	assert.equal(response.traceId, request.traceId, "响应帧必须配到同一次请求");
	assert.equal(response.status, 200);
	assert.ok(Number.isFinite(response.durationMs) && response.durationMs >= 0);
});

test("会话隔离：没有配对请求的响应不发孤儿帧", async () => {
	const { handlers, fetchCalls } = loadExtension();
	handlers.get("after_provider_response")({ status: 200, headers: {} }, makeContext({ sessionId: "other-session" }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(fetchCalls.length, 0);
});

test("超上限的 payload 按字节截断，payloadBytes 保留原始大小", async () => {
	const { handlers, fetchCalls, extension } = loadExtension();
	const big = "x".repeat(extension.MAX_PAYLOAD_BYTES + 100_000);
	const payload = { messages: [{ role: "user", content: big }] };
	handlers.get("before_provider_request")({ payload }, makeContext());
	await new Promise((resolve) => setTimeout(resolve, 0));

	const frame = parseFrame(fetchCalls[0]);
	assert.equal(frame.truncated, true);
	assert.ok(frame.payloadBytes > extension.MAX_PAYLOAD_BYTES, "payloadBytes 是截断前的真实字节数");
	assert.ok(Buffer.byteLength(frame.payloadJson, "utf8") <= extension.MAX_PAYLOAD_BYTES, "落盘文本不得超过上限");
	assert.ok(frame.payloadJson.startsWith('{"messages"'), "保留头部（system/tools/消息开头是最有诊断价值的部分）");
});

test("循环引用等无法序列化的 payload：这一条缺席，不抛错", async () => {
	const { handlers, fetchCalls, stderr } = loadExtension();
	const payload = {};
	payload.self = payload;
	const result = handlers.get("before_provider_request")({ payload }, makeContext());
	assert.equal(result, undefined);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(fetchCalls.length, 0);
	assert.ok(
		stderr.some((line) => line.includes("采集失败")),
		"失败要留一行 stderr 说明",
	);
});

test("trace 端点不可用时（fetch 拒绝）不产生未处理拒绝，pi 照常", async () => {
	const { handlers } = loadExtension({ fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")) });
	handlers.get("before_provider_request")({ payload: { messages: [] } }, makeContext());
	handlers.get("after_provider_response")({ status: 200, headers: {} }, makeContext());
	// 等两轮微任务 + 宏任务：未捕获的 rejection 会在这里变成进程级错误
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(true);
});

test("并发上限：宿主迟滞时丢弃后续快照而不是无限堆积", async () => {
	const { handlers, fetchCalls, stderr } = loadExtension({ fetchImpl: () => new Promise(() => {}) });
	for (let i = 0; i < 10; i += 1) handlers.get("before_provider_request")({ payload: { messages: [] } }, makeContext());
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(fetchCalls.length, 4, "in-flight 上限 4，其余丢弃");
	assert.ok(
		stderr.some((line) => line.includes("丢弃")),
		"首次丢弃要给一行提示",
	);
});

test("扩展帧字段是共享类型 ModelTraceRequestInput/ResponseInput 的子集", async () => {
	const traceTypes = readFileSync("src/shared/types/modelTrace.ts", "utf8");
	const typeKeys = (typeName) => {
		const block = traceTypes.match(new RegExp(`export type ${typeName} = \\{([\\s\\S]*?)\\n\\};`));
		assert.ok(block, `${typeName} 未找到`);
		return new Set([...block[1].matchAll(/(\w+)\??:/g)].map((match) => match[1]));
	};

	// 用真实执行产出的帧（而不是扫源码文本）：简写属性、条件字段都能被覆盖到
	const { handlers, fetchCalls } = loadExtension();
	handlers.get("before_provider_request")({ payload: { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }], tools: [{ name: "bash" }] } }, makeContext());
	handlers.get("after_provider_response")({ status: 200, headers: {} }, makeContext());
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.equal(fetchCalls.length, 2);
	const [request, response] = fetchCalls.map(parseFrame);
	const requestTypeKeys = typeKeys("ModelTraceRequestInput");
	const responseTypeKeys = typeKeys("ModelTraceResponseInput");
	const unknownRequestKeys = Object.keys(request).filter((key) => !requestTypeKeys.has(key));
	const unknownResponseKeys = Object.keys(response).filter((key) => !responseTypeKeys.has(key));
	assert.deepEqual(unknownRequestKeys, [], "请求帧有共享类型未声明的字段");
	assert.deepEqual(unknownResponseKeys, [], "响应帧有共享类型未声明的字段");
	// 宿主校验器（ModelTraceServer.isModelTraceInput）依赖的必填字段必须真的发出去
	for (const required of ["kind", "traceId", "ts", "payloadJson", "payloadBytes", "truncated"]) assert.ok(required in request, `请求帧缺必填字段 ${required}`);
	for (const required of ["kind", "traceId", "ts", "status"]) assert.ok(required in response, `响应帧缺必填字段 ${required}`);
	// 完整请求体绝不能以字段形式混进响应帧（响应只有状态与耗时）
	assert.equal("payloadJson" in response, false);
});

test("宿主路由与扩展的端点约定一致（/trace/<token> 直连 + token 头）", () => {
	const server = readFileSync("src/main/pi/modelTrace/ModelTraceServer.ts", "utf8");
	assert.match(server, /\\\/trace\\\//, "宿主必须解析 /trace/<token> 路径");
	assert.match(server, /x-pideck-model-trace-token/, "宿主强校验 token 头");
	const extension = readFileSync("resources/extensions/pi-deck-model-trace.ts", "utf8");
	assert.match(extension, /PIDECK_MODEL_TRACE_URL/);
	assert.match(extension, /x-pideck-model-trace-token/);
});
