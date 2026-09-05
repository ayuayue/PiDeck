import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * DSH host boot 失败错误信息单测：exit 早于 host-ready 时，错误信息必须携带
 * 真实失败原因（host-error 详情 / stderr 尾部），而不是只有笼统的 exit code——
 * 这是「概览页报 DSH host process exited before ready (code=1) 且重试无效、
 * 用户不知道原因」问题的可测部分（纯函数，无 electron 依赖）。
 */

const { formatBootExitError } = loadTsCommonJs("src/main/dsh/DshHostProcess.ts", {
	stubs: {
		"../logging/sharedLogger": { getAppLogger: () => null },
	},
});

test("formatBootExitError 保留原有的笼统格式（无失败详情时）", () => {
	assert.equal(
		formatBootExitError(1, null),
		"DSH host process exited before ready (code=1)",
	);
});

test("formatBootExitError 附带 host-error 详情（用户能看到真实原因）", () => {
	assert.equal(
		formatBootExitError(1, "Error: Cannot find module '@deepseek-ai/dsh-app-boot'"),
		"DSH host process exited before ready (code=1): Error: Cannot find module '@deepseek-ai/dsh-app-boot'",
	);
});

test("formatBootExitError 附带多行 stderr 尾部（host 崩溃未发 host-error 时兜底）", () => {
	const detail = "TypeError: x is not a function\n    at boot (hostEntry.js:12:3)";
	assert.match(
		formatBootExitError(1, detail),
		/^DSH host process exited before ready \(code=1\): TypeError: x is not a function/,
	);
});
