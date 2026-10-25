import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// shared/modelThinkingLevels：pi settings.json 的「每模型默认思考档位」读写工具。
// 三个消费方（主进程默认解析 / 配置页模型表 / 引导页展示）共用这一份纯逻辑，
// 这里锁住键格式、脏形状降级与不可变写回语义，防止任一路径自行漂移。
const {
	MODEL_THINKING_LEVELS,
	modelThinkingLevelsKey,
	orderModelThinkingLevels,
	parseModelThinkingLevels,
	modelThinkingLevelOf,
	modelThinkingLevelOfMap,
	withModelThinkingLevelDefault,
	replaceModelThinkingLevels,
	pruneModelThinkingLevelOrphans,
	modelThinkingLevelState,
	enabledModelThinkingLevels,
	withModelThinkingLevelEnabled,
	formatModelThinkingLevelsSummary,
} = loadTsCommonJs("src/shared/modelThinkingLevels.ts");

// vm 独立 realm 里创建的对象/数组原型不同，deepEqual 会误报；JSON 往返归一到宿主 realm。
const plain = (value) => JSON.parse(JSON.stringify(value));

// ── 键格式：与 pi settings-manager 完全一致（provider/modelId） ──

test("modelThinkingLevelsKey 用 provider/modelId 拼接，不做转义", () => {
	assert.equal(modelThinkingLevelsKey("openai", "gpt-5.2"), "openai/gpt-5.2");
	// 模型 id 本身含斜杠（中转站常见别名）时也必须原样拼接，否则查不到 pi 写的键。
	assert.equal(modelThinkingLevelsKey("router9", "qd/qfmodel"), "router9/qd/qfmodel");
});

// ── 解析：脏形状逐级降级 ──

test("parseModelThinkingLevels 只保留非空字符串值并裁剪两端空白", () => {
	const parsed = parseModelThinkingLevels({
		modelThinkingLevels: {
			"openai/gpt-5.2": "high",
			"zhipu/glm-5": "  max  ",
			// 以下都不算有效档位：非字符串 / 空串 / 纯空白 / 数组
			"a/1": 3,
			"a/2": "",
			"a/3": "   ",
			"a/4": ["high"],
		},
	});
	assert.deepEqual(plain(parsed), { "openai/gpt-5.2": "high", "zhipu/glm-5": "max" });
});

test("parseModelThinkingLevels 对缺失/空表/非对象返回 undefined（调用方回退全局默认）", () => {
	for (const settings of [null, undefined, 42, "high", [], {}, { modelThinkingLevels: null }, { modelThinkingLevels: [] }, { modelThinkingLevels: {} }, { modelThinkingLevels: { "a/b": "" } }]) {
		assert.equal(parseModelThinkingLevels(settings), undefined);
	}
});

test("modelThinkingLevelOf / modelThinkingLevelOfMap 按 provider+modelId 取，缺项与脏值返回 undefined", () => {
	const settings = { modelThinkingLevels: { "openai/gpt-5.2": " xhigh " } };
	assert.equal(modelThinkingLevelOf(settings, "openai", "gpt-5.2"), "xhigh");
	assert.equal(modelThinkingLevelOf(settings, "openai", "gpt-4"), undefined);
	assert.equal(modelThinkingLevelOf(settings, "zhipu", "gpt-5.2"), undefined);
	// provider/modelId 缺失（旧数据半结构）不猜键。
	assert.equal(modelThinkingLevelOf(settings, undefined, "gpt-5.2"), undefined);
	assert.equal(modelThinkingLevelOf(settings, "openai", undefined), undefined);
	assert.equal(modelThinkingLevelOf(settings, "openai", ""), undefined);
	// 映射表本身脏形状时按「无表」处理。
	assert.equal(modelThinkingLevelOfMap(null, "openai", "gpt-5.2"), undefined);
	assert.equal(modelThinkingLevelOfMap({ "openai/gpt-5.2": 7 }, "openai", "gpt-5.2"), undefined);
});

// ── 写回：不可变更新，空值 = 删键 ──

test("withModelThinkingLevelDefault 写入新键并保留 settings 其它字段与表内其它键", () => {
	const settings = { defaultThinkingLevel: "low", modelThinkingLevels: { "zhipu/glm-5": "high" }, defaultProvider: "openai" };
	const next = withModelThinkingLevelDefault(settings, "openai", "gpt-5.2", "xhigh");
	assert.deepEqual(plain(next), {
		defaultThinkingLevel: "low",
		defaultProvider: "openai",
		modelThinkingLevels: { "zhipu/glm-5": "high", "openai/gpt-5.2": "xhigh" },
	});
	// 不可变：原对象不被改动（React setState 依赖这一点）。
	assert.deepEqual(plain(settings.modelThinkingLevels), { "zhipu/glm-5": "high" });
});

test("withModelThinkingLevelDefault 空值/空白 = 删键；表清空时连子表一起删", () => {
	const one = withModelThinkingLevelDefault({ modelThinkingLevels: { "openai/gpt-5.2": "high" } }, "openai", "gpt-5.2", "");
	assert.equal("modelThinkingLevels" in one, false);
	assert.deepEqual(plain(one), {});

	const blank = withModelThinkingLevelDefault({ modelThinkingLevels: { "openai/gpt-5.2": "high" } }, "openai", "gpt-5.2", "   ");
	assert.equal("modelThinkingLevels" in blank, false);

	const kept = withModelThinkingLevelDefault({ modelThinkingLevels: { "openai/gpt-5.2": "high", "zhipu/glm-5": "max" } }, "openai", "gpt-5.2", "");
	assert.deepEqual(plain(kept.modelThinkingLevels), { "zhipu/glm-5": "max" });
});

// ── 展示顺序：规范档位顺序，未知档位追加在后 ──

test("orderModelThinkingLevels 按 pi 规范档位排序，未知档位原序追加", () => {
	assert.deepEqual(plain(orderModelThinkingLevels(["high", "off", "medium"])), ["off", "medium", "high"]);
	assert.deepEqual(plain(orderModelThinkingLevels(MODEL_THINKING_LEVELS)), [...MODEL_THINKING_LEVELS]);
	// 未来 pi 新增档位：不丢项，按原序排在后面。
	assert.deepEqual(plain(orderModelThinkingLevels(["ultra", "low"])), ["low", "ultra"]);
	assert.deepEqual(plain(orderModelThinkingLevels([])), []);
});

// ── 档位勾选态：与 pi getSupportedThinkingLevels 同一套判定 ──

test("modelThinkingLevelState：默认可用档位按 pi 规则推导（xhigh/max 需显式值）", () => {
	// 未声明推理能力：pi 只给 off（其余档位靠勾选开启推理后才出现）
	const unknown = { reasoning: undefined, thinkingLevelMap: undefined };
	assert.deepEqual(plain(enabledModelThinkingLevels(unknown)), ["off"]);
	assert.equal(modelThinkingLevelState(unknown, "xhigh").enabled, false);
	// 推理模型：off..high 默认开放，xhigh/max 不在默认集里
	const reasoning = { reasoning: true, thinkingLevelMap: undefined };
	assert.deepEqual(plain(enabledModelThinkingLevels(reasoning)), ["off", "minimal", "low", "medium", "high"]);
	// 显式 null = 不可用（pi 表达不支持档位的唯一方式）；显式字符串 = 可用
	const mapped = { reasoning: true, thinkingLevelMap: { off: null, high: "HIGH", xhigh: "xhigh", max: null } };
	assert.deepEqual(plain(enabledModelThinkingLevels(mapped)), ["minimal", "low", "medium", "high", "xhigh"]);
	// 非恒等上游值要暴露出来给界面提示；恒等映射不重复展示
	assert.equal(modelThinkingLevelState(mapped, "high").wireValue, "HIGH");
	assert.equal(modelThinkingLevelState({ reasoning: true, thinkingLevelMap: { low: "low" } }, "low").wireValue, "");
	assert.equal(modelThinkingLevelState(mapped, "off").wireValue, "");
});

// ── 勾选写回：pi 语义下的最小配置增量 ──

test("withModelThinkingLevelEnabled：勾选 xhigh/max 写同名值，其余档位走 pi 恒等默认", () => {
	// xhigh/max 必须显式给值才存在；off..high 删掉条目即为默认可用
	assert.deepEqual(plain(withModelThinkingLevelEnabled(undefined, "xhigh", true)), { xhigh: "xhigh" });
	assert.deepEqual(plain(withModelThinkingLevelEnabled(undefined, "max", true)), { max: "max" });
	assert.equal(withModelThinkingLevelEnabled(undefined, "high", true), undefined);
	// 取消 off..high 写 null（唯一表达方式）；取消 xhigh/max 直接删条目（缺条目与 null 等价）
	assert.deepEqual(plain(withModelThinkingLevelEnabled(undefined, "minimal", false)), { minimal: null });
	assert.equal(withModelThinkingLevelEnabled({ xhigh: "xhigh" }, "xhigh", false), undefined);
});

test("withModelThinkingLevelEnabled：保留既有上游 wire 值，不整表重建", () => {
	const map = { off: "none", low: "LOW", xhigh: "xhigh", max: null };
	// 勾选已有自定义值的档位：值原样保留（不去覆盖成恒等）
	assert.deepEqual(plain(withModelThinkingLevelEnabled(map, "off", true)), map);
	// 勾选残留 null 的档位：off..high 删键、xhigh/max 写同名值
	assert.deepEqual(plain(withModelThinkingLevelEnabled({ max: null, minimal: null }, "max", true)), { minimal: null, max: "max" });
	// 勾选 off..high 会删掉残留的 null 条目；删空后返回 undefined（调用方据此删字段，不留空对象）
	assert.equal(withModelThinkingLevelEnabled({ low: null }, "low", true), undefined);
	// 取消一个档位不动其它键；不可变（原对象不被改写，React setState 依赖这一点）
	const next = withModelThinkingLevelEnabled(map, "low", false);
	assert.deepEqual(plain(next), { off: "none", low: null, xhigh: "xhigh", max: null });
	assert.deepEqual(plain(map), { off: "none", low: "LOW", xhigh: "xhigh", max: null });
	// 取消 off..high 只会写 null（永远不会因此清空表）；只有取消 xhigh/max 才删键
	assert.deepEqual(plain(withModelThinkingLevelEnabled({ low: "low" }, "low", false)), { low: null });
});

test("勾选态往返不产生多余条目（空表 → 勾选 xhigh → 取消）", () => {
	const enabledMap = withModelThinkingLevelEnabled(undefined, "xhigh", true);
	assert.deepEqual(plain(enabledMap), { xhigh: "xhigh" });
	assert.equal(withModelThinkingLevelEnabled(enabledMap, "xhigh", false), undefined);
});

// ── 摘要：连续档位折叠成范围（对齐 CC Switch 的档位编辑器） ──

test("formatModelThinkingLevelsSummary：只写首尾（连续用 →，有跳档用省略号）", () => {
	assert.equal(formatModelThinkingLevelsSummary([...MODEL_THINKING_LEVELS]), "off → max");
	assert.equal(formatModelThinkingLevelsSummary(["off", "minimal", "low", "medium", "high"]), "off → high");
	assert.equal(formatModelThinkingLevelsSummary(["low", "medium"]), "low → medium");
	// 有跳档：省略号，不谎称中间连续（完整清单在悬停提示与弹层里）
	assert.equal(formatModelThinkingLevelsSummary(["off", "low", "high", "max"]), "off…max");
	assert.equal(formatModelThinkingLevelsSummary(["low", "max"]), "low…max");
	// 单档只写自己；空列表返回空串（调用方回落「未设置」）
	assert.equal(formatModelThinkingLevelsSummary(["max"]), "max");
	assert.equal(formatModelThinkingLevelsSummary([]), "");
	// 非规范顺序 / 未知档位：退化成逗号列表，不做猜测
	assert.equal(formatModelThinkingLevelsSummary(["high", "low"]), "high, low");
	assert.equal(formatModelThinkingLevelsSummary(["low", "ultra"]), "low, ultra");
});

// ── 供应商页的替换式写入与保存前的孤儿清理 ──

test("replaceModelThinkingLevels：按最终名字替换该 provider 的档位（删模型删档位、改名清旧名）", () => {
	const settings = { defaultThinkingLevel: "medium", modelThinkingLevels: { "relay/a": "max", "relay/gone": "low", "other/b": "high" } };
	// 页内快照只含现存的模型：模型删掉后它的档位随之消失（设置跟着模型走），其它 provider 不受影响
	const next = replaceModelThinkingLevels(settings, "relay", "relay", { a: "high" });
	assert.deepEqual(plain(next.modelThinkingLevels), { "other/b": "high", "relay/a": "high" });
	assert.equal(next.defaultThinkingLevel, "medium");
	// 改名：旧名字下的键整体清掉，改由新名字承载
	const renamed = replaceModelThinkingLevels(settings, "relay", "relay2", { a: "high" });
	assert.deepEqual(plain(renamed.modelThinkingLevels), { "other/b": "high", "relay2/a": "high" });
	// 新增供应商（没有旧名字）：只追加
	const added = replaceModelThinkingLevels({ modelThinkingLevels: { "other/b": "high" } }, "", "fresh", { x: "low" });
	assert.deepEqual(plain(added.modelThinkingLevels), { "other/b": "high", "fresh/x": "low" });
	// 空快照 = 该 provider 不再有默认档位，其它 provider 保留
	const cleared = replaceModelThinkingLevels({ modelThinkingLevels: { "relay/a": "max", "other/b": "high" } }, "relay", "relay", {});
	assert.deepEqual(plain(cleared.modelThinkingLevels), { "other/b": "high" });
});

test("replaceModelThinkingLevels：无实质变化时返回同一引用（调用方据此决定脏标记）", () => {
	const settings = { modelThinkingLevels: { "relay/a": "high" } };
	// 值相同、值带空白（保存前归一）、空值（= 删键）都要判成「没变」
	assert.equal(replaceModelThinkingLevels(settings, "relay", "relay", { a: "high" }), settings);
	assert.equal(replaceModelThinkingLevels(settings, "relay", "relay", { a: " high " }), settings);
	// 真的变了才返回新对象；清成「跟随全局设置」= 删键，表空则连子表一起删
	assert.notEqual(replaceModelThinkingLevels(settings, "relay", "relay", { a: "low" }), settings);
	const cleared = replaceModelThinkingLevels(settings, "relay", "relay", { a: "" });
	assert.equal("modelThinkingLevels" in cleared, false);
});

test("pruneModelThinkingLevelOrphans：只清「provider 在 models.json、模型 id 不在其列表」的键", () => {
	const settings = { modelThinkingLevels: { "relay/a": "max", "relay/gone": "low", "builtin/model": "high" } };
	// builtin 不在模型索引里（pi 内置 provider）→ 一律不碰
	const pruned = pruneModelThinkingLevelOrphans(settings, new Map([["relay", new Set(["a"])]]));
	assert.deepEqual(plain(pruned.modelThinkingLevels), { "relay/a": "max", "builtin/model": "high" });
	// 没命中孤儿 → 原样返回入参；没有这张表 → 也原样返回
	assert.equal(pruneModelThinkingLevelOrphans(settings, new Map([["relay", new Set(["a", "gone"])]])), settings);
	const empty = { foo: 1 };
	assert.equal(pruneModelThinkingLevelOrphans(empty, new Map()), empty);
});
