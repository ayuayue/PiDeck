import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { validateListParams, toCommandView, commandsBridgeRpc, handleCommandsBridgeFetch } = loadTsCommonJs("src/main/dsh/pideckCommandsBridge.ts", { globals: { Response } });

test("validateListParams：sessionId 必填，其余字段忽略", () => {
	const ok = validateListParams({ sessionId: "session-1", extra: 42 });
	assert.equal(ok.ok, true);
	assert.equal(ok.ok && ok.value.sessionId, "session-1");
	assert.equal(validateListParams({ sessionId: "" }).ok, false);
	assert.equal(validateListParams({}).ok, false);
	assert.equal(validateListParams(null).ok, false);
	assert.equal(validateListParams("session-1").ok, false);
	assert.equal(validateListParams(["session-1"]).ok, false);
});

test("toCommandView：CommandDescriptor 映射为安全 JSON 视图", () => {
	const view = toCommandView({
		name: "permission",
		description: "Switch permission preset",
		input: { hint: "preset name" },
	});
	assert.equal(view.name, "permission");
	assert.equal(view.description, "Switch permission preset");
	assert.equal(view.inputHint, "preset name");

	const noInput = toCommandView({ name: "plan", description: "Plan mode" });
	assert.equal(noInput.name, "plan");
	assert.equal(noInput.inputHint, undefined);

	assert.equal(toCommandView(null), undefined);
	assert.equal(toCommandView({ name: "x" }), undefined);
	assert.equal(toCommandView({ name: 1, description: "d" }), undefined);
	assert.equal(toCommandView({ name: "", description: "d" }), undefined);
});

test("commandsBridgeRpc：list 分发到服务，未知方法/缺服务返回结构化错误", async () => {
	const service = {
		list: () => ({ ok: true, value: [{ name: "plan", description: "Plan mode" }] }),
	};
	assert.deepEqual(await commandsBridgeRpc(service, "list", { sessionId: "s" }), {
		ok: true,
		value: [{ name: "plan", description: "Plan mode" }],
	});
	assert.equal((await commandsBridgeRpc(service, "execute", {})).ok, false);
	assert.equal((await commandsBridgeRpc(undefined, "list", {})).ok, false);
});

test("handleCommandsBridgeFetch：POST JSON 协议、非 POST/坏 JSON/缺服务/无 live Agent 都返回结构化 4xx", async () => {
	// 有 live Agent + 命令注册表：返回视图列表
	const agent = { id: "session-1" };
	const ctx = {
		get: (key) => {
			if (key === "pideckCommandsBridge") {
				return {
					list: (input) => {
						const validated = validateListParams(input);
						if (!validated.ok) return validated;
						return { ok: true, value: [{ name: "plan", description: "Plan mode" }] };
					},
				};
			}
			return undefined;
		},
	};
	const ok = await handleCommandsBridgeFetch(ctx, {
		method: "POST",
		body: JSON.stringify({ method: "list", params: { sessionId: "s" } }),
	});
	assert.equal(ok.status, 200);
	assert.deepEqual(JSON.parse(await ok.text()), { ok: true, value: [{ name: "plan", description: "Plan mode" }] });

	// 缺服务：400 + 结构化错误
	const missingService = await handleCommandsBridgeFetch(
		{ get: () => undefined },
		{
			method: "POST",
			body: JSON.stringify({ method: "list", params: { sessionId: "s" } }),
		},
	);
	assert.equal(missingService.status, 400);
	assert.equal(JSON.parse(await missingService.text()).ok, false);

	// 非 POST：400
	const badMethod = await handleCommandsBridgeFetch(ctx, { method: "GET" });
	assert.equal(badMethod.status, 400);
	assert.equal(JSON.parse(await badMethod.text()).ok, false);

	// 坏 JSON：400
	const badJson = await handleCommandsBridgeFetch(ctx, { method: "POST", body: "{nope" });
	assert.equal(badJson.status, 400);
	assert.equal(JSON.parse(await badJson.text()).ok, false);

	// 缺 sessionId：400（校验在边界）
	const noSession = await handleCommandsBridgeFetch(ctx, {
		method: "POST",
		body: JSON.stringify({ method: "list", params: {} }),
	});
	assert.equal(noSession.status, 400);
	assert.equal(JSON.parse(await noSession.text()).ok, false);
});
