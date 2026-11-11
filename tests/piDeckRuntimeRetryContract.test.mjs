/**
 * 运行时契约测试：内置重试扩展的改写，必须在**真正跑会话的两个运行时**里都成立。
 *
 * 这不是「扩展内部逻辑」的单元测试（那部分在 piDeckRetryNoBody.test.mjs），
 * 而是产品级契约：改写后的 errorMessage 必须
 *
 *   1. 桌面端：被 `@deepseek-ai/dsh-llm-pi-ai` 的 `classifyPiAiError` 判成
 *      `RATE_LIMIT` / `SERVER` / `TRANSPORT` / `TIMEOUT` 之一（dsh 只重试这几个码）；
 *   2. CLI 路径：被 `@earendil-works/pi-ai` 的 `isRetryableAssistantError` 判为可重试，
 *      且不被 `isContextOverflow` 抢走。
 *
 * 两个判定都直接取自 node_modules 里的真实实现：dsh 的分类器未导出，这里按源码
 * 提取（上游改实现会让本测试显式失败并提示更新），pi 的判定直接 import。
 * 这样测试与运行时不会各自漂移——历史上正是漂移导致 `overloaded` 标注在桌面端
 * 完全不生效（pi 认、dsh 不认）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EMPTY_RESPONSE_CODE, isQuotaExceededError, QUOTA_EXCEEDED_CODE } from "@deepseek-ai/dsh-llm";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import ts from "typescript";

const require = createRequire(import.meta.url);
const readUtf8 = (path) => readFileSync(path, "utf8");

// ---------------------------------------------------------------------------
// 1. 真实扩展（TS → ESM；用仓库自带的 typescript，不引入额外依赖）
// ---------------------------------------------------------------------------

const extensionSource = readUtf8(new URL("../resources/extensions/pi-deck-retry-no-body.ts", import.meta.url));
const transpiled = ts.transpileModule(extensionSource, {
	compilerOptions: {
		module: ts.ModuleKind.ESNext,
		target: ts.ScriptTarget.ES2022,
		isolatedModules: true,
	},
}).outputText;
const extension = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);

/** 模拟 pi 宿主，捕获 message_end 处理器并跑一条 assistant 错误消息。 */
function applyExtension(message) {
	let handler;
	extension.default({
		on(event, fn) {
			assert.equal(event, "message_end");
			handler = fn;
		},
	});
	assert.equal(typeof handler, "function", "扩展必须注册 message_end 监听");
	const result = handler({ message });
	return result?.message?.errorMessage;
}

// ---------------------------------------------------------------------------
// 2. 桌面端：从 dsh-llm-pi-ai 源码中提取 classifyPiAiError
// ---------------------------------------------------------------------------

const adapterSource = readUtf8(require.resolve("@deepseek-ai/dsh-llm-pi-ai"));
const classifyMatch = adapterSource.match(/function classifyPiAiError\(message\) \{([\s\S]*?)\n\}/);
assert.ok(classifyMatch, "无法从 @deepseek-ai/dsh-llm-pi-ai 提取 classifyPiAiError —— 上游实现可能已改动，请更新本测试");
const classifyPiAiError = new Function("isQuotaExceededError", "QUOTA_EXCEEDED_CODE", `return function classifyPiAiError(message) {${classifyMatch[1]}\n};`)(isQuotaExceededError, QUOTA_EXCEEDED_CODE);

/** dsh 的重试策略只重试这些码（从 @deepseek-ai/dsh-llm 源码提取，避免硬编码漂移）。 */
const llmSource = readUtf8(require.resolve("@deepseek-ai/dsh-llm"));
const codesMatch = llmSource.match(/const DEFAULT_RETRYABLE_CODES = Object\.freeze\(\[([\s\S]*?)\]\)/);
assert.ok(codesMatch, "无法从 @deepseek-ai/dsh-llm 提取 DEFAULT_RETRYABLE_CODES");
const RETRYABLE_CODES = new Set(["EMPTY_RESPONSE_CODE".includes("EMPTY") ? EMPTY_RESPONSE_CODE : null]);
for (const quoted of codesMatch[1].match(/"[A-Z_]+"/g) ?? []) RETRYABLE_CODES.add(quoted.slice(1, -1));
assert.ok(RETRYABLE_CODES.has("TRANSPORT") && RETRYABLE_CODES.has("RATE_LIMIT"));

const dshRetries = (errorMessage) => RETRYABLE_CODES.has(classifyPiAiError(errorMessage));
const piRetries = (errorMessage) => isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage }) && !isContextOverflow({ role: "assistant", stopReason: "error", errorMessage }, undefined);

// ---------------------------------------------------------------------------
// 3. 真实故障样本（全部取自本机会话历史里「没被重试」的错误文案）
// ---------------------------------------------------------------------------

/** [原始文案, api] —— 断言：改写前两个运行时都不重试，改写后都重试。 */
const RESCUED_CASES = [
	["Error Code server_is_overloaded: Our servers are currently overloaded. Please try again later.", "openai-completions"],
	['{"message":"Service temporarily unavailable","type":"api_error"}', "openai-completions"],
	["Service is temporarily unavailable, please try again later.", "openai-completions"],
	["juzi-r4: The host is configured as a Cloudflare Tunnel, but Cloudflare is currently unable to reach it.", "openai-completions"],
	["您的账户已达到速率限制，请您控制请求频率", "openai-completions"],
	["模型服务暂时不可用，请稍后重试", "openai-completions"],
	["服务暂时不可用，请稍后重试", "openai-completions"],
	["400 status code (no body)", "openai-completions"],
	["413 status code (no body)", "openai-completions"],
	["unexpected EOF", "openai-completions"],
	["stream_read_error: connection reset by peer", "openai-completions"],
];

/** 确定性失败：扩展不得改写，否则会把「重试必然复现」变成无意义的重试风暴。 */
const UNTOUCHED_CASES = [
	"403 status code (no body)",
	"401 status code (no body)",
	"429 rate limit exceeded",
	"503 status code (no body)",
	"insufficient_quota: You exceeded your current quota",
	"Request was aborted.",
	"501 Not Implemented",
	"Upstream request failed: [403] This model is not available in your region.",
	"Invalid API key provided",
	"error code: 1027",
];

test("真实故障：至少一个运行时不重试 → 改写后两个运行时都重试", () => {
	for (const [raw, api] of RESCUED_CASES) {
		// 历史事实：这些文案至少有一个运行时不重试（桌面端 8 类漏网，pi 侧漏 overloaded 之外的中文/边缘层）
		assert.ok(!(dshRetries(raw) && piRetries(raw)), `两个运行时本来就重试，无需扩展: ${raw}`);

		const rewritten = applyExtension({
			role: "assistant",
			stopReason: "error",
			api,
			errorMessage: raw,
		});
		assert.ok(rewritten, `扩展必须改写: ${raw}`);
		assert.equal(dshRetries(rewritten), true, `桌面端改写后应重试: ${raw} → ${rewritten}`);
		assert.equal(piRetries(rewritten), true, `pi 改写后应重试: ${raw} → ${rewritten}`);
	}
});

test("确定性失败：扩展不改写（避免重试风暴）", () => {
	for (const raw of UNTOUCHED_CASES) {
		assert.equal(applyExtension({ role: "assistant", stopReason: "error", api: "openai-completions", errorMessage: raw }), undefined, `不应改写: ${raw}`);
	}
});

test("改写保留原始文案，便于会话历史诊断", () => {
	for (const [raw] of RESCUED_CASES) {
		const rewritten = applyExtension({
			role: "assistant",
			stopReason: "error",
			api: "openai-completions",
			errorMessage: raw,
		});
		// 400/413 空响应会把状态码降级为 4xx（桌面端分类器优先匹配 400/413），
		// 其余文案必须原样保留在开头。
		const body = rewritten.replace(/^transient upstream fault: /, "");
		const preserved = raw.startsWith("400 status code") || raw.startsWith("413 status code") ? raw.replace(/^4(?:00|13)/, "4xx") : raw;
		assert.ok(body.startsWith(preserved), `原文应保留: ${raw} → ${rewritten}`);
	}
});

test("幂等：同一消息重复进 message_end 不会叠加标注", () => {
	for (const [raw] of RESCUED_CASES) {
		const once = applyExtension({
			role: "assistant",
			stopReason: "error",
			api: "openai-completions",
			errorMessage: raw,
		});
		const twice = applyExtension({
			role: "assistant",
			stopReason: "error",
			api: "openai-completions",
			errorMessage: once,
		});
		// 第二次直接放行（返回 undefined）：宿主保留原消息，不会叠加前缀
		assert.equal(twice, undefined, `重复进入必须放行: ${once} → ${twice}`);
	}
});

// ---------------------------------------------------------------------------
// 4. 真实会话语料自检：扩展改写过的任何一条，都必须在两个运行时里可重试
// （本机没有历史会话时自动跳过，不影响 CI）
// ---------------------------------------------------------------------------

const SESSION_ROOT = join(homedir(), ".pi", "agent", "sessions");
const MAX_FILES = 120;

/**
 * 固化语料：真实会话里出现过的错误文案 + 两条本就该被救的样本。
 * 本机语料只作补充——它决定不了门禁颜色（换台机器就变），fixture 才是那条
 * 「至少救回一条」的确定性来源，也顺手钉住「不该救的别乱改」。
 */
const CORPUS_FIXTURE = readUtf8(new URL("./fixtures/piDeckRuntimeRetryCorpus.jsonl", import.meta.url))
	.split("\n")
	.filter((line) => line.trim())
	.map((line) => JSON.parse(line).errorMessage);

function readSessionErrors() {
	if (!existsSync(SESSION_ROOT)) return [];
	const seen = new Set();
	for (const dir of readdirSync(SESSION_ROOT)) {
		const dirPath = join(SESSION_ROOT, dir);
		let files;
		try {
			files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of files.slice(0, MAX_FILES)) {
			const path = join(dirPath, file);
			let text;
			try {
				text = readUtf8(path);
			} catch {
				continue;
			}
			for (const line of text.split("\n")) {
				if (!line.includes('"stopReason":"error"')) continue;
				const match = line.match(/"errorMessage":"((?:[^"\\]|\\.)*)"/);
				if (!match) continue;
				try {
					seen.add(JSON.parse(`"${match[1]}"`));
				} catch {
					/* 忽略损坏行 */
				}
			}
		}
	}
	return [...seen];
}

/**
 * 「这条文案本来就该被救」的独立判据：与扩展里的 RETRYABLE_SERVER_STATUS_PATTERN 同源，
 * 但故意在这里另写一份——直接 import 扩展内部函数会让断言变成同义反复（它不改写，
 * 判据也跟着说不该改写，永远绿）。这里要回答的是「语料里有没有本来就该救的样本」。
 */
const RECOVERABLE_SIGNAL = /overload(?:ed)?|server_is_overloaded|servers? (?:are|is) (?:currently )?(?:busy|overloaded)|currently experiencing high demand|model is at capacity/i;

test("真实会话语料：扩展改写的内容在两个运行时都必须可重试", () => {
	const errors = [...new Set([...CORPUS_FIXTURE, ...readSessionErrors()])];
	if (errors.length === 0) return; // fixture 缺失时退回「无本机语料即跳过」
	let rewrittenCount = 0;
	const missed = [];
	for (const raw of errors) {
		const rewritten = applyExtension({
			role: "assistant",
			stopReason: "error",
			api: "openai-completions",
			errorMessage: raw,
		});
		if (!rewritten) {
			if (RECOVERABLE_SIGNAL.test(raw)) missed.push(raw);
			continue;
		}
		rewrittenCount += 1;
		assert.equal(dshRetries(rewritten), true, `桌面端改写后不可重试: ${raw} → ${rewritten}`);
		assert.equal(piRetries(rewritten), true, `pi 改写后不可重试: ${raw} → ${rewritten}`);
	}
	// 语料里必须至少有一条被救回。fixture 固定提供两条「该救」样本，所以这条不再看本机
	// 会话的脸色，但仍然能抓住「扩展整体不再改写」这种回归。
	assert.ok(rewrittenCount > 0, `扫描 ${errors.length} 条错误文案，却没有一条被改写`);
	// 逐条漏救判据：命中了可救信号却没被改写 → 红（比数条数更严）。
	assert.deepEqual(missed, [], `这些文案带可救信号却没被改写: ${missed.join(" | ")}`);
});
