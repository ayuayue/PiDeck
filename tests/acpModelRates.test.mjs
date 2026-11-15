/**
 * ACP 模型倍率注解：解析本机 magpie provider 缓存 → 挂到模型选择项。
 * 数据源是 magpie 私有文件，所以全部走纯函数 + 可注入读取器，缺文件必须 fail-open。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseMagpieProviderRates, annotateAcpModelRates, annotateAcpLockedOptions, createMagpieRateSource } = loadTsCommonJs("src/main/acp/acpModelRates.ts");
const { readAcpLockedReason } = loadTsCommonJs("src/main/acp/acpProtocol.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const PROVIDERS = [
	{
		id: "codebuddy",
		models: [
			{ id: "glm-5.3", name: "GLM-5.3", rate: 0.69, rateWas: 0, free: false },
			{ id: "hy3", name: "Hy3", rate: 0, rateWas: 0, free: true },
			{ id: "auto", name: "Auto", rate: 0, rateWas: 0, free: false },
			{ id: "step-5", name: "Step", rate: 0.2, rateWas: 0.5, free: false },
		],
	},
	{ id: "other", models: [{ id: "glm-5.3", name: "GLM", rate: 0.9, free: false }] },
];

test("解析 provider 缓存：rate/rateWas/free 映射成精确键，rate=0 且非 free 的别名不产生倍率", () => {
	const catalogue = parseMagpieProviderRates(PROVIDERS);
	assert.equal(catalogue.exact.get("codebuddy/glm-5.3").rate, 0.69);
	assert.equal(catalogue.exact.get("codebuddy/step-5").was, 0.5);
	assert.deepEqual(plain(catalogue.exact.get("codebuddy/hy3")), { rate: 0, free: true });
	assert.equal(catalogue.exact.has("codebuddy/auto"), false, "0 且非 free 的别名不展示 0×");
});

test("裸模型名只在唯一时才可用于匹配，重名记 null", () => {
	const catalogue = parseMagpieProviderRates(PROVIDERS);
	assert.deepEqual(plain(catalogue.bare.get("step-5")), { rate: 0.2, was: 0.5 }, "唯一裸名可用");
	assert.equal(catalogue.bare.has("glm-5.3"), true);
	assert.equal(catalogue.bare.get("glm-5.3"), null, "两个 provider 都有 glm-5.3：不猜");
});

test("注解只动 model 选项，值按 provider/model 精确匹配；不修改原数组", () => {
	const options = [
		{
			id: "model",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: "codebuddy/glm-5.3",
			options: [
				{ value: "codebuddy/glm-5.3", name: "GLM-5.3" },
				{ value: "codebuddy/hy3", name: "Hy3" },
				{ value: "auto/deepseek-v4.1-flash", name: "Auto" },
			],
		},
		{ id: "mode", name: "Mode", category: "mode", type: "select", options: [{ value: "codebuddy/glm-5.3", name: "Same value" }] },
	];
	const annotated = annotateAcpModelRates(options, parseMagpieProviderRates(PROVIDERS));
	assert.deepEqual(plain(annotated[0].options[0].rate), { rate: 0.69 });
	assert.deepEqual(plain(annotated[0].options[1].rate), { rate: 0, free: true });
	assert.equal(annotated[0].options[2].rate, undefined, "路由组/未知模型不挂倍率");
	assert.equal(annotated[1], options[1], "非 model 选项原样返回");
	assert.equal(options[0].options[0].rate, undefined, "不得原地改 agent 数据");
});

test("分组选项的每个取值同样注解", () => {
	const options = [{ id: "model", name: "Model", category: "model", type: "select", options: [{ group: "codebuddy", name: "CodeBuddy", options: [{ value: "codebuddy/glm-5.3", name: "GLM-5.3" }] }] }];
	const annotated = annotateAcpModelRates(options, parseMagpieProviderRates(PROVIDERS));
	assert.deepEqual(plain(annotated[0].options[0].options[0].rate), { rate: 0.69 });
});

test("读取器：文件缺失 fail-open；同一 mtime 走缓存", () => {
	let reads = 0;
	const source = createMagpieRateSource({
		homeDir: () => "/home/test",
		statFile: (path) => {
			if (path.endsWith("plugin-providers.json")) return { mtimeMs: 7, size: 1 };
			throw new Error("missing");
		},
		readFile: () => {
			reads += 1;
			return JSON.stringify(PROVIDERS);
		},
	});
	assert.equal(source().exact.get("codebuddy/glm-5.3").rate, 0.69);
	assert.equal(source().exact.get("codebuddy/glm-5.3").rate, 0.69);
	assert.equal(reads, 1, "mtime 未变不重复读盘");

	const missing = createMagpieRateSource({
		homeDir: () => "/home/none",
		statFile: () => {
			throw new Error("missing");
		},
	});
	assert.deepEqual([...missing().exact.keys()], []);
});

test("单项锁定：只认 codebuddy.ai/locked 的非空字符串，其余 _meta 一律不算锁定", () => {
	assert.equal(readAcpLockedReason({ "codebuddy.ai/locked": "output style is pinned by --output-style X" }), "output style is pinned by --output-style X");
	assert.equal(readAcpLockedReason({ "codebuddy.ai/locked": "   " }), undefined, "空白原因不算锁定");
	assert.equal(readAcpLockedReason({ "codebuddy.ai/locked": true }), undefined, "boolean 不是本协议的形态");
	assert.equal(readAcpLockedReason({ "other.vendor/locked": "x" }), undefined, "未知厂商 key 不能当锁定");
	assert.equal(readAcpLockedReason(undefined), undefined);

	const options = [
		{ id: "output_style", name: "Output Style", currentValue: "A", options: [{ value: "A", name: "A" }], _meta: { "codebuddy.ai/locked": "forced by plugin" } },
		{ id: "thought_level", name: "Thinking", currentValue: "high", options: [{ value: "high", name: "high" }] },
	];
	const annotated = plain(annotateAcpLockedOptions(options));
	assert.equal(annotated[0].lockedReason, "forced by plugin");
	assert.equal(Object.hasOwn(annotated[1], "lockedReason"), false, "没有 metadata 的项维持原样");
	// 解锁是运行期事件：下一次快照不再带原因时必须把旧值丢掉，而不是沿用。
	assert.equal(Object.hasOwn(plain(annotateAcpLockedOptions([{ id: "output_style", name: "Output Style", currentValue: "A" }]))[0], "lockedReason"), false);
});
