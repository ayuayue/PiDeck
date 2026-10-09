/**
 * 飞书连接层日志出口契约（AGENTS.md：日志走主进程 logging 模块）。
 *
 * 缺陷（红测复现）：FeishuConnection 的 log/warn/logErr 包装只写 console——
 * 打包版 Electron 主进程的 stdout 不落盘，长连接断开（WSClient onError）、
 * 消息处理异常、连接测试失败等关键故障在诊断报告（pideck-doctor）里完全不可见。
 * CardStream 的 patch 重试/失败日志同样只走 console.error/warn。
 * 契约：包装与重试日志必须同时落 appLogger（feishu scope），console 可保留供
 * dev 终端直接可见。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const connectionSource = () => readFileSync("src/main/feishu/FeishuConnection.ts", "utf8");
const cardStreamSource = () => readFileSync("src/main/feishu/CardStream.ts", "utf8");

/** 提取顶层包装函数体（const xxx = (...args: unknown[]) => { ... };，indexOf 定位避免转义坑）。 */
function wrapperBody(source, name) {
	const start = source.indexOf(`const ${name} = (...args`);
	if (start < 0) return "";
	const end = source.indexOf("\n};", start);
	return end > start ? source.slice(start, end + 3) : "";
}

test("FeishuConnection 的 log/warn/logErr 包装必须落 appLogger（console-only 是诊断盲区）", () => {
	const source = connectionSource();
	// 契约链：log/warn/logErr → toAppLog → getAppLogger（feish scope）。
	const hubStart = source.indexOf("const toAppLog = (level");
	const hubEnd = hubStart >= 0 ? source.indexOf("\n};", hubStart) : -1;
	const hub = hubEnd > hubStart ? source.slice(hubStart, hubEnd + 3) : "";
	assert.ok(hub.length > 0, "toAppLog 汇聚包装应存在于 FeishuConnection.ts 顶层");
	assert.match(hub, /getAppLogger\(\)\?\.\[level\]\("feishu"/, "toAppLog 必须写 appLogger（feishu scope）");
	for (const name of ["log", "warn", "logErr"]) {
		const body = wrapperBody(source, name);
		assert.ok(body.length > 0, `包装 ${name} 应存在于 FeishuConnection.ts 顶层`);
		assert.match(body, new RegExp(`toAppLog\\("(info|warn|error)", args\\)`), `${name} 包装必须经 toAppLog 落 appLogger`);
	}
});

test("CardStream 的 patch 重试与终态失败日志必须落 appLogger", () => {
	const source = cardStreamSource();
	const sendMatch = source.match(/private async sendUpdate\(card: object\): Promise<void> \{[\s\S]*?\n\t\}/);
	assert.ok(sendMatch, "sendUpdate 方法应存在");
	const sendUpdate = sendMatch[0];
	assert.match(sendUpdate, /getAppLogger\(\)\?\.(error|warn)\("feishu"/, "sendUpdate 重试/失败路径必须写 appLogger");
});
