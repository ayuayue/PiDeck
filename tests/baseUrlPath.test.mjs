import assert from "node:assert/strict";
import test from "node:test";
import {
	extractVersionedBaseFromRequestUrl,
	hasApiVersionPath,
	needsSessionBaseUrlVersionHint,
	stripOpenAiVersionPath,
	suggestNormalizedBaseUrl,
} from "../src/main/config/baseUrlPath.ts";

test("hasApiVersionPath detects /v1 /v1beta /api", () => {
	assert.equal(hasApiVersionPath("https://api.openai.com/v1"), true);
	assert.equal(hasApiVersionPath("https://api.openai.com/v1/"), true);
	assert.equal(hasApiVersionPath("https://generativelanguage.googleapis.com/v1beta"), true);
	assert.equal(hasApiVersionPath("http://localhost:11434/api"), true);
	assert.equal(hasApiVersionPath("https://proxy.example.com"), false);
	assert.equal(hasApiVersionPath("https://proxy.example.com/openai"), false);
});

test("extractVersionedBaseFromRequestUrl strips endpoint suffix", () => {
	assert.equal(
		extractVersionedBaseFromRequestUrl("https://api.openai.com/v1/chat/completions"),
		"https://api.openai.com/v1",
	);
	assert.equal(
		extractVersionedBaseFromRequestUrl("https://host.example/proxy/v1/models"),
		"https://host.example/proxy/v1",
	);
	assert.equal(
		extractVersionedBaseFromRequestUrl(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=x",
		),
		"https://generativelanguage.googleapis.com/v1beta",
	);
	assert.equal(
		extractVersionedBaseFromRequestUrl("https://host.example/models"),
		null,
	);
});

test("only rewrite when versioned path actually worked", () => {
	// 根路径 /models 成功 → 不改写
	assert.equal(
		needsSessionBaseUrlVersionHint("https://proxy.example.com", "https://proxy.example.com/models"),
		false,
	);
	assert.equal(
		suggestNormalizedBaseUrl("https://proxy.example.com", "https://proxy.example.com/models"),
		null,
	);

	// /v1 成功 → 自动补 /v1
	assert.equal(
		needsSessionBaseUrlVersionHint(
			"https://proxy.example.com",
			"https://proxy.example.com/v1/chat/completions",
		),
		true,
	);
	assert.equal(
		suggestNormalizedBaseUrl(
			"https://proxy.example.com",
			"https://proxy.example.com/v1/chat/completions",
		),
		"https://proxy.example.com/v1",
	);

	// 已有 /v1 → 不改
	assert.equal(
		suggestNormalizedBaseUrl(
			"https://proxy.example.com/v1",
			"https://proxy.example.com/v1/models",
		),
		null,
	);
});

test("google root base suggests v1beta when request used it", () => {
	assert.equal(
		suggestNormalizedBaseUrl(
			"https://generativelanguage.googleapis.com",
			"https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
			"google-generative-ai",
		),
		"https://generativelanguage.googleapis.com/v1beta",
	);
});

test("stripOpenAiVersionPath removes trailing version segment and keeps sub-prefix", () => {
	assert.equal(stripOpenAiVersionPath("https://88api.ai/v1"), "https://88api.ai");
	assert.equal(stripOpenAiVersionPath("https://88api.ai/v1/"), "https://88api.ai");
	assert.equal(stripOpenAiVersionPath("https://host.proxy.example/proxy/v1"), "https://host.proxy.example/proxy");
	assert.equal(
		stripOpenAiVersionPath("https://generativelanguage.googleapis.com/v1beta"),
		"https://generativelanguage.googleapis.com",
	);
	assert.equal(stripOpenAiVersionPath("https://host.example/api"), "https://host.example");
	assert.equal(stripOpenAiVersionPath("https://host.example"), "https://host.example");
});
