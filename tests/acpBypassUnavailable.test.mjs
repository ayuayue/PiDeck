import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * #556：工具勾了「bypass 权限」但 agent 的模式枚举里没有 bypass 档（agy 只有
 * default / accept-edits / plan）时，PiDeck 的下发是空操作。原先静默返回，用户会以为
 * 已经放行、实际每次工具调用仍弹确认。现在提示一次，且同工具不重复打扰。
 */
const { AcpConfigOptions } = loadTsCommonJs("src/main/acp/AcpConfigOptions.ts");
const { acpBypassUnavailableNotice } = loadTsCommonJs("src/main/acp/acpToolConfig.ts");

const AGY_MODES = [
	{ value: "default", name: "Default" },
	{ value: "accept-edits", name: "Accept edits" },
	{ value: "plan", name: "Plan" },
];

function createOptions(configOptions, tool = { id: "agy", name: "agy", bypassPermissions: true }) {
	const notices = [];
	const runtime = { tool, tab: { id: "agent-1" }, configOptions };
	const options = new AcpConfigOptions({
		requireRuntime: () => runtime,
		ownsRuntime: () => true,
		notifyBypassUnavailable: (notice) => notices.push({ ...notice, i18nParams: { ...notice.i18nParams } }),
	});
	return { options, runtime, notices };
}

test("没有 bypass 档时提示一次，并带上 agent 的全部模式值", async () => {
	const { options, runtime, notices } = createOptions([{ id: "mode", name: "Mode", type: "select", currentValue: "default", options: AGY_MODES }]);
	await options.applyBypassPermissionDefault(runtime);
	assert.equal(notices.length, 1);
	assert.equal(notices[0].i18nKey, "notice.acpBypassUnavailable");
	assert.deepEqual(notices[0].i18nParams, { tool: "agy", modes: "default / accept-edits / plan" });
	assert.equal(notices[0].kind, "warning");
});

test("同一工具的提示不会每次开会话都弹", async () => {
	const { options, runtime, notices } = createOptions([{ id: "mode", name: "Mode", type: "select", currentValue: "default", options: AGY_MODES }]);
	await options.applyBypassPermissionDefault(runtime);
	await options.applyBypassPermissionDefault(runtime);
	assert.equal(notices.length, 1);
});

test("有 bypass 档且已在档上：不提示（正常 agent 不受影响）", async () => {
	const { options, runtime, notices } = createOptions([{ id: "mode", name: "Mode", type: "select", currentValue: "yolo", options: [{ value: "auto" }, { value: "yolo" }] }]);
	await options.applyBypassPermissionDefault(runtime);
	assert.deepEqual(notices, []);
});

test("没有模式枚举、或没勾 bypass：都不提示", async () => {
	const noMode = createOptions(undefined);
	await noMode.options.applyBypassPermissionDefault(noMode.runtime);
	assert.deepEqual(noMode.notices, []);

	const off = createOptions([{ id: "mode", name: "Mode", type: "select", currentValue: "default", options: AGY_MODES }], { id: "agy", name: "agy", bypassPermissions: false });
	await off.options.applyBypassPermissionDefault(off.runtime);
	assert.deepEqual(off.notices, []);
});

test("提示文案在渲染层字典中可用（toast 用 t() 解析）", () => {
	const key = acpBypassUnavailableNotice("agy", ["default"]).i18nKey;
	const zhCN = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
	const enUS = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts").enUS;
	for (const [locale, copy] of [
		["zh-CN", zhCN],
		["en-US", enUS],
	]) {
		assert.ok(Object.hasOwn(copy, key), `${locale} 缺 ${key}`);
	}
	assert.match(zhCN[key], /\{tool\}.*\{modes\}/, "占位符要和 agents:notice 的 i18nParams 对齐");
});
