import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// issue #311：ModelsTab 在 JSX 内联构造预填对象，父组件刷新会给 AddProviderDialog 传
// 「内容相同、引用不同」的 initial；初始化 effect 原按 initial 引用做依赖，一刷新就把
// 用户未保存的 API 类型 / User-Agent 草稿和测试结果整体冲回旧配置（openai-responses
// 回退 openai-completions、custom-client/2.0 回退 codex-cli/1.0.0）。守卫两层：
//   1) 纯函数 providerDialogResetKey：重置只由「编辑对象身份 + 页面模式」决定；
//   2) 源码契约：初始化 effect 依赖身份键，不再按 initial 引用重置；初始化语义保留。
// 正则空白容忍（AGENTS.md 门禁）；断言禁止的旧模式字面量不得出现在源码注释里。
const dialogSource = readFileSync("src/renderer/src/config/AddProviderDialog.tsx", "utf8");

test("issue #311 源码契约：初始化 effect 依赖身份键 resetKey，不再依赖 initial 引用", () => {
	// 旧模式（依赖数组以 initial 引用开头）禁止回归——父组件刷新即整体重置草稿
	assert.doesNotMatch(dialogSource, /\},\s*\[props\.initial[\s,]/);
	// 新模式：resetKey 由纯函数从「模式 + initial」计算，effect 只依赖该原始值
	assert.match(dialogSource, /const\s+resetKey\s*=\s*providerDialogResetKey\(\s*props\.mode,\s*props\.initial\s*\)\s*;/);
	assert.match(dialogSource, /\},\s*\[resetKey\]\s*\)\s*;/);
	// 初始化语义保留：effect 体内仍读 initial 预填并清测试态（切换供应商/模式/重进页面时正确初始化）
	const initEffectStart = dialogSource.indexOf("const initial = props.initial");
	const initEffectEnd = dialogSource.indexOf("}, [resetKey]);");
	assert.ok(initEffectStart > 0 && initEffectEnd > initEffectStart, "初始化 effect 必须存在");
	const initEffect = dialogSource.slice(initEffectStart, initEffectEnd);
	assert.match(initEffect, /setApi\(initial\?\.api\s*\?\?\s*""\)/);
	assert.match(initEffect, /setUserAgent\(initial\?\.userAgent\s*\?\?\s*""\)/);
	assert.match(initEffect, /setTestResult\(null\)/);
});

test("providerDialogResetKey：同一供应商同一模式内父组件刷新不换键（草稿存活）", () => {
	const { providerDialogResetKey } = loadTsCommonJs("src/renderer/src/config/addProviderDraft.ts", { stubs: {} });
	// structuredClone 模拟父组件刷新：内容相同、引用不同的 initial → 键不变 → 不重置
	const first = { name: "acme", api: "openai-responses", userAgent: "custom-client/2.0" };
	const refreshed = structuredClone(first);
	assert.equal(providerDialogResetKey("edit", first), providerDialogResetKey("edit", refreshed));
	// 切换供应商 / 模式切换 → 换键 → 重新初始化
	assert.notEqual(providerDialogResetKey("edit", { name: "acme" }), providerDialogResetKey("edit", { name: "beta" }));
	assert.notEqual(providerDialogResetKey("edit", { name: "acme" }), providerDialogResetKey("add", undefined));
	// add 模式忽略预填：即使父级误传 initial 也不据此换键
	assert.equal(providerDialogResetKey("add", { name: "acme" }), providerDialogResetKey("add", undefined));
	// 编辑对象消失（provider 被外部删除）→ 键变化 → 重置为空表单
	assert.notEqual(providerDialogResetKey("edit", { name: "acme" }), providerDialogResetKey("edit", undefined));
});
