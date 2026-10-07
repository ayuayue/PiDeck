/**
 * Web 会话路由纯函数契约测试。
 * 覆盖：前缀解析、非法字符拒绝、尾部斜杠容忍、序列化往返、空 id 回根路径。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const { sessionFromPath, sessionPath } = load(resolve(import.meta.dirname, "../src/renderer/src/web/webSessionRoute.ts"));

test("sessionFromPath: 解析 /s/<id> 并返回会话 id", () => {
	assert.equal(sessionFromPath("/s/ab12cd34"), "ab12cd34");
});

test("sessionFromPath: 非前缀路径返回空串", () => {
	assert.equal(sessionFromPath("/"), "");
	assert.equal(sessionFromPath("/s"), "");
	assert.equal(sessionFromPath("/index.html"), "");
	assert.equal(sessionFromPath("/api/chat"), "");
});

test("sessionFromPath: 空 id、非法字符、查询串残留一律拒绝", () => {
	assert.equal(sessionFromPath("/s/"), "");
	assert.equal(sessionFromPath("/s/..%2fetc"), "");
	// 正则只允许 [A-Za-z0-9_-]，斜杠/点/百分号被拆段或拒绝
	assert.equal(sessionFromPath("/s/abc/def"), "abc"); // 取首段
	assert.equal(sessionFromPath("/s/a.b"), "");
	assert.equal(sessionFromPath("/s/a b"), "");
});

test("sessionFromPath: 合法字符集完整接受（uuid 前缀、下划线、连字符）", () => {
	assert.equal(sessionFromPath("/s/AbC_123-xYz"), "AbC_123-xYz");
});

test("sessionPath: 会话 id 序列化为 /s/<id>，空 id 回根路径", () => {
	assert.equal(sessionPath("ab12cd34"), "/s/ab12cd34");
	assert.equal(sessionPath(""), "/");
});

test("sessionPath: encodeURIComponent 保证特殊字符安全", () => {
	assert.equal(sessionPath("a%b"), "/s/a%25b");
});

test("sessionPath ↔ sessionFromPath 往返一致（合法 id 集合）", () => {
	for (const id of ["ab12cd34", "SESSION_1", "x-9", "00000000"]) {
		assert.equal(sessionFromPath(sessionPath(id)), id);
	}
});

test("源码契约：WebChatApp 接线了 boot 恢复 / pushState 同步 / popstate 三段路由逻辑", () => {
	const src = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/web/WebChatApp.tsx"), "utf8");
	assert.match(src, /routeRestoredRef/);
	assert.match(src, /window\.history\.pushState/);
	assert.match(src, /window\.history\.replaceState/);
	assert.match(src, /addEventListener\("popstate"/);
	assert.match(src, /sessionFromPath\(window\.location\.pathname\)/);
});

test("源码契约：服务端静态映射对无扩展名路径回落 web.html，/s/* 无需服务端路由", () => {
	const src = readFileSync(resolve(import.meta.dirname, "../src/main/web/WebServiceManager.ts"), "utf8");
	// 无扩展名 → web.html（SPA fallback）；带扩展名的静态资源走文件直出
	assert.match(src, /web\.html/);
});

// createTsSandbox 返回 load 函数本身；模块无相对依赖，直接取 exports
