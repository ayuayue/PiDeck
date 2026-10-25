/**
 * 渲染层日志桥（utils/rendererLog）：把「后台功能为什么什么都没发生」写进主进程应用日志。
 *
 * 约定：日志永远不能让功能出错——没有 preload（浏览器预览 / LAN 网页）、rendererLog 同步抛错、
 * 返回 rejected promise，三种情况都必须安静吞掉。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

function loadWith(windowValue) {
	return loadTsCommonJs("src/renderer/src/utils/rendererLog.ts", { globals: { window: windowValue } });
}

test("有 preload 时按 level/scope/message/detail 转发", () => {
	const calls = [];
	const { logFromRenderer } = loadWith({
		piDesktop: {
			app: {
				rendererLog: (level, scope, message, detail) => {
					calls.push([level, scope, message, detail]);
					return Promise.resolve();
				},
			},
		},
	});
	logFromRenderer("warn", "suggest", "输入预测失败（model-error）：boom", { runId: "run-1" });
	assert.equal(calls.length, 1);
	assert.deepEqual(plain(calls[0]), ["warn", "suggest", "输入预测失败（model-error）：boom", { runId: "run-1" }]);
});

test("没有 preload / 没有 rendererLog 通道时不抛（非 Electron 运行时）", () => {
	for (const windowValue of [undefined, {}, { piDesktop: {} }, { piDesktop: { app: {} } }]) {
		const { logFromRenderer } = loadWith(windowValue);
		assert.doesNotThrow(() => logFromRenderer("debug", "suggest", "未预测：上下文为空"), JSON.stringify(windowValue));
	}
});

test("rendererLog 同步抛错或异步失败都不外溢（日志不能反过来影响功能）", async () => {
	const throwing = loadWith({
		piDesktop: {
			app: {
				rendererLog: () => {
					throw new Error("no channel");
				},
			},
		},
	});
	assert.doesNotThrow(() => throwing.logFromRenderer("debug", "suggest", "x"));

	const rejecting = loadWith({ piDesktop: { app: { rendererLog: () => Promise.reject(new Error("boom")) } } });
	assert.doesNotThrow(() => rejecting.logFromRenderer("debug", "suggest", "x"));
	// 等一拍：未 catch 的 rejection 会被 node:test 记成本用例失败。
	await new Promise((resolve) => setImmediate(resolve));
});
