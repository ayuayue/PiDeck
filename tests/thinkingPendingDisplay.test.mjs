import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { computeThinkingDisplay, resolveComposerThinkingLevel } = loadTsCommonJs("src/renderer/src/utils/thinkingDisplay.ts");

// vm realm 对象原型与测试 realm 不同，deepStrictEqual 会误判，改用 JSON 比较
function assertDisplay(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

/**
 * 思考档位的展示与模型选择同源：会话/引导页偏好是唯一权威，运行态只负责执行。
 */
test("computeThinkingDisplay: 有当前档位时展示当前档位", () => {
	assertDisplay(computeThinkingDisplay("xhigh"), {
		levels: ["xhigh"],
		pending: false,
	});
});

test("computeThinkingDisplay: 无任何档位信息时返回空序列", () => {
	assertDisplay(computeThinkingDisplay(undefined), {
		levels: [],
		pending: false,
	});
});

test("resolveComposerThinkingLevel: 会话保存的选择优先于 runtime 和 fallback", () => {
	assert.equal(
		resolveComposerThinkingLevel({
			state: "xhigh",
			record: "max",
			fallback: "off",
			isLive: true,
		}),
		"max",
	);
});

test("resolveComposerThinkingLevel: 无会话记录时只使用引导页 fallback", () => {
	assert.equal(
		resolveComposerThinkingLevel({
			state: "xhigh",
			fallback: "off",
			isLive: true,
		}),
		"off",
	);
});

test("契约: thinking 按钮运行中可点，启动中禁用", () => {
	const components = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	// 模板/模式仍随 disabled 禁用；thinking / 模型按钮有独立禁用位
	assert.match(components, /disabled=\{props\.disabled\}/);
	assert.match(components, /disabled=\{props\.thinkingDisabled\}/);
	assert.match(components, /disabled=\{props\.modelDisabled \?\? props\.disabled\}/);
	assert.doesNotMatch(components, /thinkingPending|ThinkingLevelPending|thinkingDisplay\.levels\.map/);
});

test("契约: ComposerArea 不预先限制运行中的思考强度修改", () => {
	const area = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	// Pi/DSH 是否支持当前回合由后端决定，renderer 只在启动中禁用入口。
	assert.match(area, /disabled=\{composer\.isStarting\}/);
	assert.match(area, /thinkingDisabled=\{composer\.isStarting\}/);
	assert.match(area, /modelDisabled=\{composer\.isStarting\}/);
});

test("契约: 活动 Pi 会话将 get_state 返回的有效档位写入会话记录", () => {
	const picker = readFileSync("src/renderer/src/hooks/useSessionPreferenceController.ts", "utf8");
	assert.match(picker, /applied\.value\.thinkingLevel/);
	assert.doesNotMatch(picker, /appliedThinkingLevel/);
	assert.doesNotMatch(picker, /thinkingPending|setThinkingPending/);
});
