/**
 * WebServiceManager dev 代理回归测试：模块请求绝不回退/转发 HTML。
 *
 * 背景（issue：web 服务打开后白屏，控制台报 "Failed to load module script:
 * ... MIME type of text/html"）：
 * 1. vite 对不存在的路径按 SPA fallback 返回 200 + index.html；
 * 2. vite 对 deps 重新优化期间的旧 URL 返回 504 Outdated Optimize Dep。
 * 旧实现把这两种响应都原样转发/回退成 HTML 页面，浏览器按 module script
 * 解析 HTML 即报 MIME 错误、整页白屏。修复后：模块/资源请求只接受 JS 类
 * 响应（非 200 透传状态、200+HTML 判 404），仅文档请求允许回退 A1 内嵌页。
 */
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadWebServiceManager() {
	return loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		// VM 沙箱默认没有 fetch（Node 18+ 全局），dev 代理测试需要它
		globals: {
			fetch: globalThis.fetch,
			Response: globalThis.Response,
			ReadableStream: globalThis.ReadableStream,
		},
	}).WebServiceManager;
}

/** 起一个可控响应内容的假 vite dev server */
async function startMockVite(handler) {
	const server = createHttpServer((req, res) => handler(req, res));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

/** 精简 deps：dev 代理路径只触及 subscribePiEvents（start 时绑定）与 devRendererUrl */
function makeDeps(devRendererUrl) {
	return {
		subscribePiEvents: () => () => undefined,
		devRendererUrl,
	};
}

async function withManager(devRendererUrl, run) {
	const WebServiceManager = loadWebServiceManager();
	const manager = new WebServiceManager(makeDeps(devRendererUrl));
	await manager.start("127.0.0.1", 0);
	try {
		await run(`http://127.0.0.1:${manager.current.port}`);
	} finally {
		await manager.stop();
	}
}

test("dev 代理：模块请求遇 vite 504（deps 重新优化）→ 透传 504，不回退 HTML", async () => {
	const vite = await startMockVite((req, res) => {
		// vite 对旧 hash deps URL 的真实响应：504 + 空 body
		res.writeHead(504, { "content-type": "text/plain" });
		res.end();
	});
	try {
		await withManager(vite.url, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/@fs/C:/proj/node_modules/.vite/deps/@ai-sdk_react.js?v=stale-hash`);
			assert.equal(res.status, 504, "应透传上游 504");
			const type = res.headers.get("content-type") ?? "";
			assert.ok(!type.includes("text/html"), "模块请求绝不能拿到 HTML（MIME 白屏根因）");
		});
	} finally {
		await vite.close();
	}
});

test("dev 代理：模块请求遇 vite SPA fallback（200+HTML，资源不存在）→ 返回 404", async () => {
	const vite = await startMockVite((req, res) => {
		// vite 对不存在的路径返回 200 + index.html
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<!doctype html><html><body>vite index fallback</body></html>");
	});
	try {
		await withManager(vite.url, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/src/ghost-module.tsx`);
			assert.equal(res.status, 404, "模块请求拿到 HTML 应判定资源不存在");
			assert.ok(!(res.headers.get("content-type") ?? "").includes("text/html"));
		});
	} finally {
		await vite.close();
	}
});

test("dev 代理：/@vite/client 等 vite 内部模块（无扩展名）遇 504 → 透传而非按文档回退", async () => {
	const vite = await startMockVite((req, res) => {
		res.writeHead(504, { "content-type": "text/plain" });
		res.end();
	});
	try {
		await withManager(vite.url, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/@vite/client`);
			assert.equal(res.status, 504, "/@* 是模块请求，应透传上游状态");
		});
	} finally {
		await vite.close();
	}
});

test("dev 代理：文档请求（/web.html）正常转发上游 HTML", async () => {
	const vite = await startMockVite((req, res) => {
		assert.equal(req.url, "/web.html");
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<!doctype html><html><body>A2 web page</body></html>");
	});
	try {
		await withManager(vite.url, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/web.html`);
			assert.equal(res.status, 200);
			assert.ok((res.headers.get("content-type") ?? "").includes("text/html"));
			assert.ok((await res.text()).includes("A2 web page"));
		});
	} finally {
		await vite.close();
	}
});

test("dev 代理：文档请求上游非 200 → 回退 A1 内嵌页（保持兼容）", async () => {
	const vite = await startMockVite((req, res) => {
		res.writeHead(404, { "content-type": "text/html" });
		res.end("not found");
	});
	try {
		await withManager(vite.url, async (baseUrl) => {
			const res = await fetch(`${baseUrl}/web.html`);
			assert.equal(res.status, 200);
			const body = await res.text();
			assert.ok(body.includes("PiDeck Web Service"), "应回退 A1 vanilla 内嵌页");
		});
	} finally {
		await vite.close();
	}
});

test("dev 代理：dev server 未就绪 → 文档回退 A1、模块请求 503", async () => {
	// 先占一个端口再释放，之后请求同一端口必然 ECONNREFUSED
	const probe = await startMockVite((req, res) => res.end());
	const deadUrl = probe.url;
	await probe.close();
	await withManager(deadUrl, async (baseUrl) => {
		const doc = await fetch(`${baseUrl}/`);
		assert.equal(doc.status, 200);
		assert.ok((await doc.text()).includes("PiDeck Web Service"));
		const mod = await fetch(`${baseUrl}/src/web-main.tsx`);
		assert.equal(mod.status, 503, "模块请求应 503 而非 HTML");
		assert.ok(!(mod.headers.get("content-type") ?? "").includes("text/html"));
	});
});
