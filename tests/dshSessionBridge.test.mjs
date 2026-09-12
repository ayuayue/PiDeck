import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * pideckSessionBridge 回归（0.1.5 session/page 的 throughSeq cursor 来源）。
 *
 * 背景：`session/page` 的 throughSeq 必须 ≤ 会话 cursor，官方约定它来自 follow
 * 开帧快照；PiDeck 的历史浏览是冷读路径（不能 follow，promote 会激活 Agent），
 * 因此由本桥把 sessionQuery observation cursor 暴露给主进程。任何对 throughSeq
 * 语义的误用（MAX_SAFE_INTEGER、负数等）都会让历史读取静默变空——见
 * docs/dsh-0.1.5-typert-migration.md 与 DshAgentManager.historyPage 注释。
 */
const { sessionBridgeRpc, handleSessionBridgeFetch, PIDECK_SESSION_BRIDGE_SERVICE } = loadTsCommonJs(
	"src/main/dsh/pideckSessionBridge.ts",
	// Node 22 只在主 realm 给 Symbol 打 dispose polyfill，vm 新 realm 里
	// Symbol.dispose === undefined（属性访问被 coerce 成字符串 "undefined"），
	// 被测代码的 Symbol.dispose 调用在 vm 里永远落空 → 注入宿主 Symbol。
	{ globals: { Response, Symbol: globalThis.Symbol } },
);
const { apply } = loadTsCommonJs("src/main/dsh/pideckSessionBridge.ts", {
	globals: { Response, Symbol: globalThis.Symbol },
});

/** 构造可注入替身的桥上下文。 */
function makeCtx(overrides = {}) {
	const ctx = {
		provided: {},
		get(key) {
			// apply() 经 provide 登记的桥服务优先；overrides 供注入替身服务/ctx 能力。
			return ctx.provided[key] ?? overrides[key];
		},
		provide(key, value) {
			ctx.provided[key] = value;
		},
	};
	return ctx;
}

test("cursor：返回冷读 observation 的 cursor 并释放 lease", async () => {
	let disposed = false;
	const ctx = makeCtx({
		sessionQuery: {
			async observeSession(sessionId, options) {
				assert.equal(sessionId, "s1");
				// 与官方 session/page 读取姿势一致：不计算/不写投影缓存。
				assert.equal(options.projectionMode, "none");
				return {
					cursor: 12,
					[Symbol.dispose]() {
						disposed = true;
					},
				};
			},
		},
	});
	apply(ctx);
	const result = await sessionBridgeRpc(ctx.provided[PIDECK_SESSION_BRIDGE_SERVICE], "cursor", { sessionId: "s1" });
	// vm realm 对象与测试字面量 prototype 不同，deepStrictEqual 会误报（仓库惯例：逐字段断言）
	assert.equal(result.ok, true);
	assert.equal(result.value.cursor, 12);
	assert.equal(disposed, true, "observation lease 必须释放，不能长期 pin 冷读缓存");
});

test("cursor：空日志返回 -1（与 SessionObservation.cursor 语义一致）", async () => {
	const ctx = makeCtx({
		sessionQuery: {
			async observeSession() {
				return { cursor: -1, [Symbol.dispose]() {} };
			},
		},
	});
	apply(ctx);
	const result = await sessionBridgeRpc(ctx.provided[PIDECK_SESSION_BRIDGE_SERVICE], "cursor", { sessionId: "s1" });
	assert.equal(result.ok, true);
	assert.equal(result.value.cursor, -1);
});

test("cursor：入参校验在边界（sessionId 必填非空字符串）", async () => {
	const ctx = makeCtx({
		sessionQuery: {
			async observeSession() {
				return { cursor: 0, [Symbol.dispose]() {} };
			},
		},
	});
	apply(ctx);
	const service = ctx.provided[PIDECK_SESSION_BRIDGE_SERVICE];
	assert.equal((await sessionBridgeRpc(service, "cursor", undefined)).ok, false);
	assert.equal((await sessionBridgeRpc(service, "cursor", {})).ok, false);
	assert.equal((await sessionBridgeRpc(service, "cursor", { sessionId: "" })).ok, false);
	assert.equal((await sessionBridgeRpc(service, "cursor", { sessionId: 42 })).ok, false);
	assert.equal((await sessionBridgeRpc(service, "cursor", { sessionId: "  s1  " })).ok, true, "合法 id 允许收尾空白并裁剪");
});
test("cursor：sessionQuery 未挂载 / observation 抛错 / cursor 非法 → 结构化错误，不抛异常", async () => {
	const missing = makeCtx({});
	apply(missing);
	const noQuery = await sessionBridgeRpc(missing.provided[PIDECK_SESSION_BRIDGE_SERVICE], "cursor", { sessionId: "s1" });
	assert.equal(noQuery.ok, false);
	assert.equal(noQuery.error, "sessionQuery service is not mounted");

	// 老日志迁移拒绝（subagent/descriptor 版本不兼容）等观察期错误必须原样回传。
	const throwing = makeCtx({
		sessionQuery: {
			async observeSession() {
				throw new Error("subagent/descriptor 0 uses unsupported descriptor version 2");
			},
		},
	});
	apply(throwing);
	const failed = await sessionBridgeRpc(throwing.provided[PIDECK_SESSION_BRIDGE_SERVICE], "cursor", { sessionId: "s1" });
	assert.equal(failed.ok, false);
	assert.match(failed.error, /unsupported descriptor version 2/);

	const badCursor = makeCtx({
		sessionQuery: {
			async observeSession() {
				return { cursor: "12", [Symbol.dispose]() {} };
			},
		},
	});
	apply(badCursor);
	const invalid = await sessionBridgeRpc(badCursor.provided[PIDECK_SESSION_BRIDGE_SERVICE], "cursor", { sessionId: "s1" });
	assert.equal(invalid.ok, false);
	assert.equal(invalid.error, "session observation returned an invalid cursor");
});

test("fetch 路由：仅 POST + JSON body → 结构化响应；未知方法报错", async () => {
	const ctx = makeCtx({
		sessionQuery: {
			async observeSession() {
				return { cursor: 3, [Symbol.dispose]() {} };
			},
		},
	});
	apply(ctx);
	const get = await handleSessionBridgeFetch(ctx, { method: "GET" });
	const getBody = JSON.parse(await get.text());
	assert.equal(get.status, 400);
	assert.equal(getBody.ok, false);

	const ok = await handleSessionBridgeFetch(ctx, {
		method: "POST",
		body: JSON.stringify({ method: "cursor", params: { sessionId: "s1" } }),
	});
	assert.equal(ok.status, 200);
	const okBody = JSON.parse(await ok.text());
	assert.equal(okBody.ok, true);
	assert.equal(okBody.value.cursor, 3);

	const unknown = await handleSessionBridgeFetch(ctx, {
		method: "POST",
		body: JSON.stringify({ method: "nope", params: {} }),
	});
	assert.equal(unknown.status, 400);
	assert.match(JSON.parse(await unknown.text()).error, /unknown session bridge method/);

	const badBody = await handleSessionBridgeFetch(ctx, { method: "POST", body: "not-json" });
	assert.equal(badBody.status, 400);
});

/** 回归守卫：历史分页适配层不得再出现固定超大 throughSeq 用法（0.1.5 契约违反的旧写法）。 */
test("守卫：DshRemoteClient/DshAgentManager 不再使用 Number.MAX_SAFE_INTEGER 作为 page 切点", () => {
	const root = resolve(import.meta.dirname, "..");
	for (const file of ["src/main/dsh/dshRemoteClient.ts", "src/main/dsh/DshAgentManager.ts"]) {
		const source = readFileSync(resolve(root, file), "utf8");
		assert.doesNotMatch(source, /Number\.MAX_SAFE_INTEGER/, `${file} 不得残留 Number.MAX_SAFE_INTEGER 用法`);
		assert.match(source, /throughSeq/, `${file} 必须沿用 throughSeq 契约`);
	}
});