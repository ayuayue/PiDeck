/**
 * agentCodeTokenCache 单测 —— 高亮缓存的上限行为（内存策略的回归保护）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheTokens, getCachedTokens, tokenCacheSize, MAX_TOKEN_CACHE_ENTRIES } from "../src/renderer/src/components/agents/agentCodeTokenCache.ts";

test("cacheTokens 写入后可读回", () => {
	const lines = [{ content: "const a = 1", offset: 0 }];
	cacheTokens("json\u0000{}", lines);
	assert.equal(getCachedTokens("json\u0000{}"), lines);
});

test("未命中的 key 返回 undefined（调用方走完整高亮）", () => {
	assert.equal(getCachedTokens("nope\u0000nothing"), undefined);
});

test("超过上限时清空重建，缓存不无限增长（防 JS 堆泄漏）", () => {
	// 灌入 2 倍上限的条目（上限边界内清空会多次触发）
	for (let i = 0; i < MAX_TOKEN_CACHE_ENTRIES * 2; i++) {
		cacheTokens(`k-${i}`, [{ content: "x", offset: 0 }]);
	}
	// 核心不变量：size 有界，不可能随写入次数线性增长
	assert.ok(tokenCacheSize() <= MAX_TOKEN_CACHE_ENTRIES, `size=${tokenCacheSize()} 超过上限 ${MAX_TOKEN_CACHE_ENTRIES}`);
	// 最新条目必须可读；较早条目可能已被清空（可重算，不损失正确性）
	assert.ok(getCachedTokens(`k-${MAX_TOKEN_CACHE_ENTRIES * 2 - 1}`));
});
