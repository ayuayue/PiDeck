/**
 * W3 加固回归测试：安全与健壮性修复的源码契约 + 401 广播行为。
 * 覆盖：
 * 1. sendError 的 headersSent 防护（流式响应已写头后失败不再二次 writeHead）
 * 2. 非法 JSON body → 400（WebInvalidJsonError 哨兵 + readJson try/catch + 统一 catch 映射）
 * 3. serveRenderer 的 rendererRoot 前缀分隔符边界（兄弟目录不放行）
 * 4. 遗留内嵌页 data-* 属性插值走 escapeHtml
 * 5. WebI18n 三字典 key 完整（invalidJson/toolRunning/toolComplete）
 * 6. 渲染层 401 兜底：webApi 广播事件行为（真实 vm 沙箱）+ WebChatApp 横幅
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import vm from "node:vm";

// ── 服务端源码契约 ──

// 响应工具已迁出到 WebHttpResponders；契约分别落在「工具实现」与「manager 统一 catch 映射」两侧。
const respondersSource = readFileSync("src/main/web/WebHttpResponders.ts", "utf8");
const managerSource = readFileSync("src/main/web/WebServiceManager.ts", "utf8");
const pageTemplateSource = readFileSync("src/main/web/webPageTemplate.ts", "utf8");
const staticAssetsSource = readFileSync("src/main/web/WebStaticAssets.ts", "utf8");

test("sendError guards against headersSent (streaming routes already wrote head)", () => {
	assert.match(respondersSource, /if \(response\.headersSent\)/, "sendError must check headersSent before writeHead");
});

test("invalid JSON body maps to 400 via WebInvalidJsonError sentinel", () => {
	assert.match(respondersSource, /class WebInvalidJsonError extends Error/, "sentinel class must exist");
	assert.match(respondersSource, /throw new WebInvalidJsonError\(\)/, "readJson must throw sentinel on parse failure");
	assert.match(managerSource, /error instanceof WebInvalidJsonError/, "unified catch must map the sentinel");
	assert.match(managerSource, /webError\.invalidJson/, "mapped to the 400 error code");
	// JSON.parse 必须被 try/catch 包住（哨兵在 catch 里抛出）
	assert.match(respondersSource, /try \{\s*\r?\n\s*return JSON\.parse\(Buffer\.concat\(chunks\)/);
});

test("serveRenderer prefix check enforces path-separator boundary", () => {
	// 静态产物出口已迁到 WebStaticAssets（Wave 2）。
	const source = staticAssetsSource;
	assert.match(source, /rendererRootPrefix = normalize\(this\.rendererRoot\) \+ sep/, "prefix must end with path separator");
	assert.match(source, /startsWith\(rendererRootPrefix\)/, "startsWith must use the bounded prefix");
});

test("legacy embedded page escapes data-* attribute interpolations", () => {
	// A1 兜底页模板已迁到 webPageTemplate.ts（Wave 1）。
	const source = pageTemplateSource;
	// 源码是模板字符串：插值写作 \\${escapeHtml(...)}（反斜杠转义的美元符），正则需匹配字面反斜杠。
	assert.match(source, /data-project="\\\$\{escapeHtml\(project\.id\)\}"/);
	assert.match(source, /data-session="\\\$\{escapeHtml\(session\.id\)\}"/);
	assert.match(source, /data-close-session="\\\$\{escapeHtml\(session\.id\)\}"/);
});

test("WebI18n dictionaries carry the new keys in zh-CN/en-US/zh-TW", () => {
	const zhCn = readFileSync("src/main/web/WebI18n.ts", "utf8");
	assert.match(zhCn, /"webError\.invalidJson"/);
	assert.match(zhCn, /"web\.toolRunning"/);
	assert.match(zhCn, /"web\.toolComplete"/);
	const zhTw = readFileSync("src/main/web/WebI18n.zh-TW.ts", "utf8");
	assert.match(zhTw, /"webError\.invalidJson"/);
	assert.match(zhTw, /"web\.toolRunning"/);
	assert.match(zhTw, /"web\.toolComplete"/);
});

// ── 渲染层 401 兜底行为（真实 vm 沙箱跑 webApi.ts）──

function loadWebApi(fetchImpl) {
	const source = readFileSync("src/renderer/src/web/webApi.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const dispatched = [];
	class CustomEventPolyfill {
		constructor(type) {
			this.type = type;
		}
	}
	const sandbox = {
		exports: {},
		fetch: fetchImpl,
		URLSearchParams,
		CustomEvent: CustomEventPolyfill,
		window: {
			location: { search: "" },
			localStorage: { getItem: () => null, setItem: () => {} },
			dispatchEvent: (event) => dispatched.push(event.type),
		},
		require: () => {
			throw new Error("webApi.ts should not need runtime requires (type-only imports)");
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "webApi.ts" });
	return { api: sandbox.exports, dispatched };
}

function jsonResponse(status) {
	return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
}

test("401 response broadcasts auth-failed event exactly once until a success resets it", async () => {
	const calls = [];
	const { api, dispatched } = loadWebApi(async () => {
		const status = calls.shift();
		return jsonResponse(status);
	});
	calls.push(401);
	await api.fetchState().catch(() => {});
	calls.push(401);
	await api.fetchState().catch(() => {});
	assert.deepEqual(dispatched, ["pideck-web-auth-failed"], "repeated 401s dispatch once, not per poll");
	calls.push(200);
	await api.fetchState().catch(() => {});
	calls.push(401);
	await api.fetchState().catch(() => {});
	assert.equal(dispatched.length, 2, "success resets the flag so a later 401 re-notifies");
});

test("WebChatApp renders auth-expired banner wired to the broadcast event", () => {
	const app = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
	assert.match(app, /addEventListener\("pideck-web-auth-failed"/);
	assert.match(app, /web\.authExpired/);
	assert.match(app, /web\.authExpiredRetry/);
	const zhCn = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const enUs = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.match(zhCn, /"web\.authExpired"/);
	assert.match(enUs, /"web\.authExpired"/);
});
