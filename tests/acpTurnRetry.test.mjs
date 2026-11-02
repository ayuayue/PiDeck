/**
 * ACP 回合自动重试的判定口径单测（纯函数层）。
 *
 * 另外锁住一个易漂移点：设置页那三个输入（`acpRetryInput.ts`）与主进程默认值/区间必须一致 ——
 * 渲染层不能 import 主进程模块，两边各写一份常量，所以这里直接对比。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ACP_TURN_RETRY_DEFAULTS, ACP_TURN_RETRY_LIMITS, resolveAcpTurnRetrySettings, decideAcpTurnRetry } = loadTsCommonJs("src/main/acp/acpTurnRetry.ts");
const ui = loadTsCommonJs("src/renderer/src/components/app/settings/acpRetryInput.ts");

const SETTINGS = resolveAcpTurnRetrySettings();

/** 一个「什么都正常、只是失败了」的基准输入，各用例只改需要的那一项。 */
function attemptInput(overrides = {}) {
	return {
		error: new Error("read ECONNRESET"),
		settings: SETTINGS,
		attemptsMade: 0,
		hasOutput: false,
		cancelled: false,
		escalated: false,
		connectionAlive: true,
		authRequired: false,
		timedOut: false,
		...overrides,
	};
}

test("默认口径:开启、2 次重试、2s 起、30s 封顶", () => {
	assert.deepEqual({ ...ACP_TURN_RETRY_DEFAULTS }, { enabled: true, maxRetries: 2, baseDelayMs: 2_000, maxDelayMs: 30_000 });
	assert.deepEqual({ ...SETTINGS }, { ...ACP_TURN_RETRY_DEFAULTS });
});

test("resolveAcpTurnRetrySettings:脏值回落默认、超界钳制、显式 false 保留", () => {
	assert.deepEqual({ ...resolveAcpTurnRetrySettings({}) }, { ...ACP_TURN_RETRY_DEFAULTS });
	assert.equal(resolveAcpTurnRetrySettings({ enabled: false }).enabled, false);
	// 0 是合法值（= 关掉重试），不能被当成「缺省」
	assert.equal(resolveAcpTurnRetrySettings({ maxRetries: 0 }).maxRetries, 0);
	assert.equal(resolveAcpTurnRetrySettings({ maxRetries: 99 }).maxRetries, ACP_TURN_RETRY_LIMITS.maxRetries.max);
	assert.equal(resolveAcpTurnRetrySettings({ maxRetries: -1 }).maxRetries, 0);
	assert.equal(resolveAcpTurnRetrySettings({ baseDelayMs: 1 }).baseDelayMs, ACP_TURN_RETRY_LIMITS.baseDelayMs.min);
	assert.equal(resolveAcpTurnRetrySettings({ maxRetries: Number.NaN }).maxRetries, ACP_TURN_RETRY_DEFAULTS.maxRetries);
	// 非整数向下取整（settings 里出现过 2.7 这种脏值）
	assert.equal(resolveAcpTurnRetrySettings({ maxRetries: 2.7 }).maxRetries, 2);
});

test("decideAcpTurnRetry:瞬时故障 → 允许重发并给出退避", () => {
	const decision = decideAcpTurnRetry(attemptInput());
	assert.equal(decision.retry, true);
	assert.equal(decision.attempt, 1);
	assert.equal(decision.maxAttempts, 2);
	assert.equal(decision.delayMs, 2_000);
	assert.equal(decision.kind, "network");
});

test("decideAcpTurnRetry:各道安全门都不重试", () => {
	const gates = [
		[{ settings: resolveAcpTurnRetrySettings({ enabled: false }) }, "disabled"],
		[{ cancelled: true }, "cancelled"],
		[{ escalated: true }, "escalated"],
		[{ connectionAlive: false }, "connection-dead"],
		[{ hasOutput: true }, "has-output"],
		[{ authRequired: true }, "auth-required"],
		[{ timedOut: true }, "turn-timeout"],
		[{ attemptsMade: 2 }, "exhausted"],
		[{ error: new Error("insufficient_quota") }, "fatal:quota"],
		[{ error: new Error("401 Unauthorized") }, "fatal:auth"],
	];
	for (const [overrides, reason] of gates) {
		const decision = decideAcpTurnRetry(attemptInput(overrides));
		assert.equal(decision.retry, false, `应拒绝重试: ${reason}`);
		assert.equal(decision.reason, reason);
	}
});

test("decideAcpTurnRetry:退避指数增长并封顶", () => {
	const settings = resolveAcpTurnRetrySettings({ maxRetries: 4, baseDelayMs: 200, maxDelayMs: 1_000 });
	const delays = [0, 1, 2, 3].map((attemptsMade) => decideAcpTurnRetry(attemptInput({ settings, attemptsMade })).delayMs);
	assert.deepEqual(delays, [200, 400, 800, 1_000], "200→400→800→封顶 1000");
});

test("decideAcpTurnRetry:HTTP 状态码优先于文本", () => {
	assert.equal(decideAcpTurnRetry(attemptInput({ error: new Error("weird"), status: 503 })).retry, true);
	assert.equal(decideAcpTurnRetry(attemptInput({ error: new Error("weird"), status: 422 })).reason, "fatal:invalid-request");
});

test("设置页输入与主进程默认值/区间不漂移", () => {
	assert.equal(ui.ACP_RETRY_DEFAULT_ENABLED, ACP_TURN_RETRY_DEFAULTS.enabled);
	assert.equal(ui.ACP_RETRY_DEFAULT_MAX_RETRIES, ACP_TURN_RETRY_DEFAULTS.maxRetries);
	assert.equal(ui.ACP_RETRY_DEFAULT_BASE_DELAY_MS, ACP_TURN_RETRY_DEFAULTS.baseDelayMs);
	assert.deepEqual({ ...ui.ACP_RETRY_MAX_RETRIES_RANGE }, { ...ACP_TURN_RETRY_LIMITS.maxRetries });
	// UI 用秒表达退避，最小 1s 必须落在主进程允许区间内，否则用户填 1 会被静默改成 200ms
	assert.ok(ui.ACP_RETRY_BASE_DELAY_SECONDS.min * 1_000 >= ACP_TURN_RETRY_LIMITS.baseDelayMs.min);
	assert.ok(ui.ACP_RETRY_BASE_DELAY_SECONDS.max * 1_000 <= ACP_TURN_RETRY_LIMITS.baseDelayMs.max);
});

test("设置页输入:文本 ↔ settings patch（0 合法、脏值不写盘）", () => {
	// 缺省键显示生效中的默认值，用户不改就不写盘
	assert.equal(ui.acpRetryMaxRetriesText(undefined), "2");
	assert.equal(ui.acpRetryBaseDelayText(undefined), "2");
	assert.equal(ui.acpRetryMaxRetriesText(0), "0");
	assert.equal(ui.acpRetryBaseDelayText(4_500), "5", "四舍五入到整秒");

	assert.deepEqual({ ...ui.acpRetryMaxRetriesPatch("0") }, { acpTurnRetryMaxRetries: 0 });
	assert.deepEqual({ ...ui.acpRetryMaxRetriesPatch("3") }, { acpTurnRetryMaxRetries: 3 });
	assert.deepEqual({ ...ui.acpRetryBaseDelayPatch("5") }, { acpTurnRetryBaseDelayMs: 5_000 });
	for (const raw of ["", "abc", "11", "-1", "2.5"]) assert.equal(ui.acpRetryMaxRetriesPatch(raw), undefined, `拒绝 ${JSON.stringify(raw)}`);
	assert.equal(ui.acpRetryBaseDelayPatch("0"), undefined, "退避最小 1s");
	assert.equal(ui.acpRetryBaseDelayPatch("61"), undefined);
});
