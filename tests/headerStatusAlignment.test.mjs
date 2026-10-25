import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionViewSource = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const headerSource = readFileSync("src/renderer/src/components/session/SessionHeader.tsx", "utf8");

function componentInvocation(source, componentName) {
	const start = source.indexOf(`<${componentName}`);
	const end = source.indexOf("/>", start);
	assert.notEqual(start, -1, `${componentName} invocation must exist`);
	assert.notEqual(end, -1, `${componentName} invocation must be self-closing`);
	return source.slice(start, end + 2);
}

test("header actions stay right-aligned; status detail lives in the composer meter", () => {
	// 会话状态明细已统一收口到输入框的上下文圆环：头部不再挂任何状态徽章
	// （原 SessionStatus 三 chip 与圆环均从头部移除，避免双入口）
	assert.doesNotMatch(headerSource, /<SessionStatus/);
	assert.doesNotMatch(headerSource, /<SessionContextMeter/);
	const sessionHeader = componentInvocation(sessionViewSource, "SessionHeader");
	assert.doesNotMatch(sessionHeader, /runtimeState=\{activeRuntimeState\}/);
	// pure official：右对齐由 Tailwind justify-end 承担，不再依赖 CSS justify-self；
	// 运行控制已迁入 Tab 下拉，不再有独立的 session-actions 按钮组
	assert.match(headerSource, /chat-header-actions flex min-w-0 items-center justify-end/);
	assert.doesNotMatch(headerSource, /header-actions-right/);
});
