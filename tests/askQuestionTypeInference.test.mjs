import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 回归来源：flash 档模型批量提问时常省略可推导的 type 字段（2026-09 统计约
// 1/6 调用缺 type），pi 校验层硬失败导致整批 reject、模型整批重发。
// 修复：QuestionSchema.type 改为 Optional，执行时按问题形状推断默认
// （带 options → select，不带 → input）。这里从工具的公开 execute 边界断言。
const { default: registerAskQuestion } = loadTsCommonJs("resources/extensions/pi-deck-ask-question.ts", {
	stubs: {
		// pi-ai 是 ESM-only 包，CommonJS 测试环境无法 require；StringEnum 的实现
		// 与 pi bundle 内源码一致（{type:"string", enum:values, ...options}）。
		"@earendil-works/pi-ai": {
			StringEnum: (values, options) => ({
				type: "string",
				enum: values,
				...(options?.description ? { description: options.description } : {}),
				...(options?.default !== undefined ? { default: options.default } : {}),
			}),
		},
		// `typebox` 由 pi 在加载扩展时注入（pi 自带 1.3.27），仓库本身不装它，测试进程
		// require 不到；这里只实现本扩展用到的构造器，语义与 typebox 一致：Optional
		// 只影响直属 Object 的 required 计算，不出现在输出的 JSON Schema 里。
		typebox: (() => {
			const OPTIONAL = Symbol("optional");
			const primitive = (type) => (options) => ({ type, ...options });
			return {
				Type: {
					Object: (properties, options) => ({
						type: "object",
						properties,
						required: Object.keys(properties).filter((key) => properties[key]?.[OPTIONAL] !== true),
						...options,
					}),
					Optional: (schema) => ({ ...schema, [OPTIONAL]: true }),
					Union: (schemas, options) => ({ anyOf: schemas, ...options }),
					Array: (items, options) => ({ type: "array", items, ...options }),
					String: primitive("string"),
					Number: primitive("number"),
					Boolean: primitive("boolean"),
				},
			};
		})(),
	},
});

/** 注册扩展拿到工具定义；注册期间隔离 PIDECK_FEISHU_LINKED 环境变量。 */
function registerTool() {
	const previous = process.env.PIDECK_FEISHU_LINKED;
	delete process.env.PIDECK_FEISHU_LINKED;
	try {
		let tool;
		registerAskQuestion({
			registerTool: (t) => {
				tool = t;
			},
		});
		assert.ok(tool, "registerTool 应被调用");
		return tool;
	} finally {
		if (previous !== undefined) process.env.PIDECK_FEISHU_LINKED = previous;
	}
}

/** 捕获 console.warn：无害未知字段只 warn 不抛错，用例要能同时断言渲染结果与文案。 */
async function captureWarnings(run) {
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));
	try {
		return { result: await run(), warnings };
	} finally {
		console.warn = originalWarn;
	}
}

/** 构造 ctx：批量信封走 ui.input(title, placeholder)，同步捕获 envelope。 */
function runBatch(tool, params) {
	let envelope = null;
	const ctx = {
		hasUI: true,
		ui: {
			select: async () => "",
			confirm: async () => true,
			input: async (title) => {
				envelope = JSON.parse(title);
				// 模拟桌面端：按 envelope 里的 questions 逐题作答
				return JSON.stringify({
					cancelled: false,
					answers: envelope.questions.map((q) => ({ id: q.id, type: q.type, value: "ok" })),
				});
			},
			editor: async () => "text",
		},
	};
	const result = tool.execute("call_1", params, undefined, undefined, ctx);
	return { promise: result, envelope: () => envelope };
}

/** 断言 schema 层面已放行：items 的 required 只保留 question（id/type 均可省略）。 */
test("QuestionSchema：required 只含 question；id/type 省略不触发校验失败", () => {
	const tool = registerTool();
	const itemsRequired = JSON.parse(JSON.stringify(tool.parameters.properties.questions.items.required));
	assert.ok(!itemsRequired.includes("type"), `required 不应包含 type，实际: ${itemsRequired}`);
	assert.ok(!itemsRequired.includes("id"), `required 不应包含 id（toQuestions 会按序号兑底），实际: ${itemsRequired}`);
	assert.ok(itemsRequired.includes("question"));
	// 顶层单问题模式的 type 同样不强制（根级属性全部 Optional，required 键可能被省略）
	const topRequired = JSON.parse(JSON.stringify(tool.parameters.required ?? []));
	assert.ok(!topRequired.includes("type"));
});

test("批量 item 缺 type 但带 options：推断为 select，选项原样进入 envelope", async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{
				id: "q1",
				question: "主线选哪个？",
				options: ["A", "B"],
			},
		],
	});
	const result = await promise;
	const questions = envelope().questions;
	assert.equal(questions[0].type, "select");
	// normalizeOptions 会把字符串简写展开为 {label, value} 对象（既有行为）
	assert.deepEqual(
		JSON.parse(JSON.stringify(questions[0].options)),
		JSON.parse(
			JSON.stringify([
				{ label: "A", value: "A" },
				{ label: "B", value: "B" },
			]),
		),
	);
	assert.equal(result.content[0].text, "q1: ok");
});

test("批量 item 缺 type 且无 options：推断为 input", async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [{ id: "q1", question: "请填写路径" }],
	});
	await promise;
	assert.equal(envelope().questions[0].type, "input");
});

test("显式 type 不被推断覆盖：confirm / multi_select / editor 原样生效", async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", type: "confirm", question: "继续吗？" },
			{ id: "b", type: "multi_select", question: "多选", options: ["X", "Y"] },
			{ id: "c", type: "editor", question: "写点什么" },
		],
	});
	await promise;
	const types = envelope().questions.map((q) => q.type);
	assert.deepEqual(JSON.parse(JSON.stringify(types)), ["confirm", "multi_select", "editor"]);
});

test("单问题模式也走批量信封：带 options 推断 select、无 options 推断 input，形态与批量一致", async () => {
	const tool = registerTool();
	// 带 options → select：与批量同样的 envelope 载荷（1 题卡）
	{
		const { promise, envelope } = runBatch(tool, { question: "选一个", options: ["A", "B"] });
		await promise;
		const questions = envelope().questions;
		assert.equal(questions.length, 1);
		assert.equal(questions[0].type, "select");
		// 自定义输入恒定显示：不再依赖模型传 allowOther
		assert.equal(questions[0].allowOther, true);
	}
	// 无 options → input
	{
		const { promise, envelope } = runBatch(tool, { question: "填个名字" });
		await promise;
		const questions = envelope().questions;
		assert.equal(questions[0].type, "input");
		assert.equal(questions[0].allowOther, undefined);
	}
});

test("allowOther:false 传值被接受但不再隐藏自定义输入（恒定显示）", async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [{ id: "q1", question: "选一个", options: ["A", "B"], allowOther: false }],
	});
	await promise;
	assert.equal(envelope().questions[0].allowOther, true);
});

/**
 * 回归（2026-11-02 实发）：模型把「多选」写成 `multi_select: true`（而不是
 * `type: "multi_select"`）时，旧实现只读 `raw.type`，把这个键静默忽略 →
 * 带 options 的问题被推断成 select。单题 select 卡是「点选项即提交」
 * （askUi.shouldAutoAdvanceBatchAnswer），于是用户看到一个多选问题却点一下就交卷，
 * 且模型全程拿不到任何反馈。
 *
 * 测试边界：本文件直接调 tool.execute，绕过 pi 校验层（pi-ai 的 validateToolArguments
 * 会先用 TypeBox 严格校验参数）。type 的写法变体（multiSelect / multi-select / multi）
 * 在那一层就被拒、到不了 inferType，所以这里不断言「别名归一」——改由下面的 schema
 * enum 用例钉住「别名到不了执行层」这件事。
 */
test("布尔意图字段 multi_select: true 按多选处理（不再静默降级成 select）", async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [{ id: "q1", question: "接下来做哪些？", options: ["A", "B"], multi_select: true }],
	});
	await promise;
	assert.equal(envelope().questions[0].type, "multi_select");
});

test("题级 type 在校验层只收 5 个规范值（别名到不了执行层）", () => {
	const tool = registerTool();
	const typeSchema = tool.parameters.properties.questions.items.properties.type;
	assert.deepEqual(JSON.parse(JSON.stringify(typeSchema.enum)), ["select", "multi_select", "confirm", "input", "editor"]);
	// 校验层拒绝后模型只能靠 description 纠正，因此「多选怎么写」必须写在这句话里。
	// 只匹 /multi_select/ 会被同句的 `confirm/editor/multi_select` 命中——把这条给模型的写法指引整句删掉照样绿。
	assert.match(typeSchema.description, /多选必须写 type: "multi_select"（不要写 multi_select: true）/);
	// 本文件全部用例的前提：未声明的逐题键（`multi_select: true` / `checkbox: true` / `multiline: true`…）
	// 能原样到达 execute。有人给 QuestionSchema 加上 `additionalProperties: false`（`pi-deck-todo.ts` 就是
	// 这么写的）时，这些输入会在校验层被拒、实现里的意图兜底整条失效，而断言仍全绿——所以在这里钉住前提。
	assert.equal(tool.parameters.properties.questions.items.additionalProperties, undefined);
	assert.equal(tool.parameters.additionalProperties, undefined);
});

test("像多选拼错的未知字段报错并指出正确写法（曾把多选题静默降级）", async () => {
	const tool = registerTool();
	await assert.rejects(runBatch(tool, { questions: [{ id: "q1", question: "多选", options: ["A"], multiChoice: true }] }).promise, /"multiChoice": true[\s\S]*type: "multi_select"/);
});

test("其余未知字段只 warn 不报错（描述性冗余不该让整批重发）", async () => {
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [{ id: "q1", question: "选一个", options: ["A"], description: "冗余说明", default: "A" }],
		});
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "select");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /questions\[0\] 忽略未知字段 "description", "default"/);
	// 文案里的字段清单必须覆盖代码实际接受的键，别让模型按警告改出一份不存在的字段表。
	assert.match(warnings[0], /multi_select/);
	assert.match(warnings[0], /id \/ type \/ question \/ options/);
});

test("显式给了规范 type 时，多选样冗余键只 warn 不抛错（渲染已定，不必打断整批）", async () => {
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [{ id: "q1", type: "multi_select", question: "选哪些？", options: ["A", "B"], allowMultiple: true }],
		});
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "multi_select");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /"allowMultiple"/);
});

test("意图键已声明多选时，多选样冗余键只 warn 不抛错（与规范 type 同判据）", async () => {
	// 旧判据只看 raw.type：`multi_select: true` 旁边再写一个拼错的冗余键就被硬拒，
	// 但这一题的渲染早就是多选——报错文案要求的正是它已经写下的写法，整批重发纯属白耗。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], multi_select: true, checkbox: true }],
		});
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "multi_select");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /"checkbox"/);
});

test("单问题模式同样：意图键声明过就不再因冗余键整批硬失败", async () => {
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { question: "选哪些？", options: ["A"], multi_select: true, checkbox: true });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "multi_select");
	assert.equal(warnings.length, 1);
});

test("多行文本意图键已声明时，多选样冗余键也不把本题翻成多选", async () => {
	// `multiline: true` 是 editor 的声明：旁边一个拼错的 `checkbox: true` 既不该硬报错，
	// 也不该让「多选样判据」把这一题改成多选卡。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [{ id: "q1", question: "补充说明", multiline: true, checkbox: true }],
		});
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "editor");
	assert.equal(warnings.length, 1);
});

test("multi_select:false 不误伤：仍按形状推断成单选，且不报错", async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [{ id: "q1", question: "选一个", options: ["A", "B"], multi_select: false }],
	});
	await promise;
	assert.equal(envelope().questions[0].type, "select");
});

test('布尔意图键的真值放宽到 "true" / 1（未知键不经校验层强转，会原样到达）', async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "多选 A", options: ["X"], multi_select: "true" },
			{ id: "b", question: "多选 B", options: ["Y"], multiple: 1 },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["multi_select", "multi_select"],
	);
});

test("checkbox:true 同样按「像多选拼错」报错（不只 multiChoice 一个样本）", async () => {
	const tool = registerTool();
	await assert.rejects(runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A"], checkbox: true }] }).promise, /"checkbox": true[\s\S]*type: "multi_select"/);
});

test("顶层老调用形态的 type 别名收口成规范值（不许静默降级，也不许把别名传进 envelope）", async () => {
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { type: "multiSelect", question: "选哪些？", options: ["A", "B"] });
		return promise.then(() => envelope().questions[0].type);
	});
	// 既不能把 "multiSelect" 传下去（否则整封 envelope 被 extensionUiGate 白名单过滤，退回纯文本弹框），
	// 也不能当成「没给」推成 select（题库是老调用形态，校验层的 StringEnum 拦不到它）。
	assert.equal(result, "multi_select");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /type "multiSelect" 不是规范写法，已按 multi_select 处理/);
});

test("多选同族的 type 取值（multipleChoice / multi-choice / checklist）同样收口成 multi_select", async () => {
	// 同一拼写作为 key 已被 MULTI_LIKE_KEY 认；作为 type 取值若走「没写」分支就会
	// 推成 select → 点一下即交卷。两个入口必须同判，否则多留一条静默降级路径。
	const tool = registerTool();
	for (const written of ["multipleChoice", "multiple_choice", "multiple-choice", "multiChoice", "checklist"]) {
		const { promise, envelope } = runBatch(tool, { type: written, question: "选哪些？", options: ["A", "B"] });
		await promise;
		assert.equal(envelope().questions[0].type, "multi_select", `type: "${written}" 应收口成 multi_select`);
		assert.equal(envelope().questions[0].options.length, 2);
	}
});

test("顶层别名的分隔符/大小写变体与规范值用同一张归一表", async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [],
		type: "MULTI-SELECT",
		question: "选哪些？",
		options: ["A"],
	});
	await promise;
	assert.equal(envelope().questions[0].type, "multi_select");
});

test("顶层规范值的大小写变体同样收口（SELECT 不该落成「不是规范值」的日志）", async () => {
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { type: "SELECT", question: "选一个", options: ["A"] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "select");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /不是规范写法，已按 select 处理/);
});

test("原型链上的名字（constructor / __proto__）不会被当成 type 别名", async () => {
	// 直接下标查表会拿到 Object/Object.prototype，函数型 type 传进 envelope 后会被 JSON 抹成 {}。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { type: "constructor", question: "选一个", options: ["A"] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "select");
	assert.equal(typeof result, "string");
	assert.match(warnings[0], /不是规范值/);
});

test("multiline: true 按多行文本处理（不能误判成「多选」并被要求改成 multi_select）", async () => {
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "贴代码", multiline: true }] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "editor");
	// 已知键：既不报错也不该产生「未知字段」日志。
	assert.deepEqual(warnings, []);
});

test("形似多选但其实是多行文本的键（allowMultiline / multiLines）不报多选错误", async () => {
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "选一个", options: ["A"], allowMultiline: true },
				{ id: "b", question: "选一个", options: ["B"], multiLines: true },
			],
		});
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["select", "select"]);
	// 每道题各一条 warn，但都不能是「多选必须写 type: "multi_select"」那条错误。
	assert.equal(warnings.length, 2);
	assert.match(warnings.join("\n"), /allowMultiline/);
	assert.match(warnings.join("\n"), /multiLines/);
	assert.doesNotMatch(warnings.join("\n"), /多选必须写/);
});

test('意图键的非标准真值（"yes" / 2）仍按多选处理，0 视为没表达意图', async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "多选 A", options: ["X"], multi_select: "yes" },
			{ id: "b", question: "多选 B", options: ["Y"], multi: 2 },
			{ id: "c", question: "选一个", options: ["Z"], multi_select: 0 },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["multi_select", "multi_select", "select"],
	);
});

test('意图键的否定真值（"False" / "no" / "n/a"）不升级成多选', async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multi_select: "False" },
			{ id: "b", question: "选一个", options: ["B"], multiple: "no" },
			{ id: "c", question: "选一个", options: ["C"], multi_select: "n/a" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select", "select"],
	);
});

test("multiline:false 不变成 editor（否定真值同样适用）", async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiline: false },
			{ id: "b", question: "说两句", multiline: "false" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "input"],
	);
});

test('数组/对象类的多选样未知键（choices / choice:"single"）只 warn，不整批硬失败', async () => {
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "选一个", options: ["A"], choices: ["A"] },
				{ id: "b", question: "选一个", options: ["B"], choice: "single" },
			],
		});
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["select", "select"]);
	assert.equal(warnings.length, 2);
	assert.doesNotMatch(warnings.join("\n"), /多选必须写/);
});

test("未知的多选样键取否定值只 warn：不能因为「键名命中」就把整批提问拒掉", async () => {
	// 判据是 `isIntentSwitch(value)`：`checkbox: false` / `multiChoice: "no"` / `allowMultiple: 0` 没表达多选意图，
	// 按形状渲染 select 即可。写成「键名命中即算意图」时，模型明确否认的字段也会硬报错、一整批提问白重发。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(async () => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "选一个", options: ["A"], checkbox: false },
				{ id: "b", question: "选一个", options: ["B"], multiChoice: "no" },
				{ id: "c", question: "选一个", options: ["C"], allowMultiple: 0 },
			],
		});
		await promise;
		return envelope().questions.map((q) => q.type);
	});
	assert.deepEqual(result, ["select", "select", "select"]);
	assert.equal(warnings.length, 3);
	assert.doesNotMatch(warnings.join("\n"), /多选必须写/);
});

test("只有 choice 词根的冗余键只 warn，不整批硬失败（allowCustomChoice / showChoices / choiceList）", async () => {
	// 这些写法说的是「这是一道选择题」，不是多选：按多选抛错会把一整批能正常渲染的 select 卡打回，
	// 而它们改前就是被静默忽略、照常渲染的——同一个冗余键从「无影响」变成「整批一张卡都不出」。
	// 带 multi / checkbox 词根的照旧报错（见 multiChoice / checkboxGroup 用例）。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(async () => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "用哪个包管理器", options: ["npm", "pnpm"], allowCustomChoice: true },
				{ id: "b", question: "选一个", options: ["A"], showChoices: true },
				{ id: "c", question: "选一个", options: ["B"], choiceList: 1 },
			],
		});
		await promise;
		return envelope().questions.map((q) => q.type);
	});
	assert.deepEqual(result, ["select", "select", "select"]);
	assert.equal(warnings.length, 3);
	assert.doesNotMatch(warnings.join("\n"), /多选必须写/);
});

test('键名只有 choice 词根、取值自己写着多选（choiceMode: "multiple"）仍按多选拼错报错', async () => {
	// 反向钉子：把「choice 词根不算多选」写成「取值也不看」，这题会静默渲染成 select——模型明写了 multiple，
	// 而单选卡点一个选项即交卷。取值侧的补判（isMultiValueWord）不能跟着键名一起放宽。
	const tool = registerTool();
	await assert.rejects(runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A"], choiceMode: "multiple" }] }).promise, /"choiceMode": "multiple"[\s\S]*type: "multi_select"/);
});

test('中文否定真值（multiple: "否"）不把单选翻成多选，且与多行意图键同判', async () => {
	// `isIntentOn` 对字符串是 fail-open（除否定词外一律算「已表达意图」），所以否定词表是唯一门禁：
	// 漏一个中文「否」就把模型明确否认的题静默翻成多选卡（用户看到勾选框、模型收到数组），而且零日志。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(async () => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "只在当前分支提交？", options: ["是", "否"], multiple: "否" },
				{ id: "b", question: "补充说明", multiline: "否" },
				{ id: "c", question: "选哪些", options: ["A", "B"], multiple: "多选" },
			],
		});
		await promise;
		return envelope().questions.map((q) => q.type);
	});
	assert.deepEqual(result, ["select", "input", "multi_select"]);
	assert.equal(warnings.length, 0);
});

test("multiLineSelect:true 不会被 line 族排除放行（真多选拼写仍要报错）", async () => {
	const tool = registerTool();
	await assert.rejects(runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A"], multiLineSelect: true }] }).promise, /"multiLineSelect": true[\s\S]*type: "multi_select"/);
});

test("multiSelectLines / multiChoiceLines 与 multiLineSelect 同判（语序不该改变结论）", async () => {
	// 两个词序语义相同：一个报错一个放行，就是「多选题静默变单选」的另一条入口。
	const tool = registerTool();
	await assert.rejects(runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A"], multiSelectLines: true }] }).promise, /"multiSelectLines": true[\s\S]*type: "multi_select"/);
	await assert.rejects(runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A"], multiChoiceLines: true }] }).promise, /"multiChoiceLines": true[\s\S]*type: "multi_select"/);
});

test("明确表达单选的冗余键（singleChoice / exclusivePick）不报多选错误，也不连坐整批", async () => {
	// 这类键本来就是单选，不存在降级风险；拿「请改 multi_select」整批 reject 只会白白重发。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "选一个", options: ["A"], singleChoice: true },
				{ id: "b", question: "选一个", options: ["B"], exclusivePick: true },
			],
		});
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["select", "select"]);
	assert.equal(warnings.length, 2);
	assert.doesNotMatch(warnings.join("\n"), /多选必须写/);
});

test("多行文本族的其余拼写（multipleLines / multi_line_enabled / multilineHint）不报多选错误，且无 options 时落到 editor", async () => {
	// 它们表达的都是「多行文本」（正确写法 type: "editor"）：报「请改 multi_select」会把模型引向错的多选卡。
	// 旧实现的 line 族正则只认 multi(s)line(s)[text|input] 收尾，multipleLines 这类成了假阳性硬失败；
	// 而在无 options 时压成单行 input，等于把「要一段多行内容」静默换成单行框——与多选变单选同一类。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "贴日志", multipleLines: true },
				{ id: "b", question: "贴代码", multi_line_enabled: true },
				{ id: "c", question: "补充说明", multilineHint: true },
			],
		});
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["editor", "editor", "editor"]);
	assert.equal(warnings.length, 3);
	assert.doesNotMatch(warnings.join("\n"), /多选必须写/);
});

test("顶层 type 不是字符串（null / 数字）不算「写错 type」，不留噪音日志", async () => {
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { type: 42, question: "选一个", options: ["A"] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "select");
	assert.deepEqual(warnings, []);
});

test("多行文本样键落实成 editor 时不再被日志说成「已忽略」（渲染已改，日志不许撒谎）", async () => {
	// 旧日志只说「忽略未知字段 multipleLines」：题实际被渲染成多行框，日志却把改渲染的那个键
	// 归入丢弃项，还把它排除在受支持字段之外——排查时两个结论互相矛盾。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "a", question: "贴日志", multipleLines: true }] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "editor");
	const joined = warnings.join("\n");
	assert.match(joined, /已按 editor 渲染/);
	assert.doesNotMatch(joined, /忽略未知字段/);
	assert.doesNotMatch(joined, /字段只支持[^\n]*multipleLines/);
});

test("带 options 时多行文本样键确实没参与渲染，日志如实报「已忽略」", async () => {
	// 与上一条对称：形状优先于这类形状提示，键没被消费，就不许说成「已按 editor 渲染」。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "a", question: "选哪个", options: ["A"], multipleLines: true }] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "select");
	const joined = warnings.join("\n");
	assert.match(joined, /忽略未知字段 "multipleLines"/);
	assert.doesNotMatch(joined, /已按 editor 渲染/);
});

test("写在工具参数外层的多行文本样键仍如实报「已忽略」（外层不折叠这种形状提示）", async () => {
	// 外层没有本题的形状可推，多行样未知键不参与折叠；把它从「已忽略」里摘掉等于让日志吞掉一个真丢了的键。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { multipleLines: true, questions: [{ id: "a", question: "贴日志" }] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "input");
	assert.match(warnings.join("\n"), /顶层字段 忽略未知字段 "multipleLines"/);
});

test("multiline: true 与 options 同写不吞选项：按形状走 select，并留一条日志", async () => {
	// 意图键同理不许吞 options：选项整组丢掉、用户从「点选项」退回「手打」比多行框更贵
	// （与「多行文本样未知键带 options 时不压选项」同一条取舍）；但不能默默吞，否则就是静默换形态。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "a", question: "选哪个", options: ["A", "B"], multiline: true }] });
		return promise.then(() => ({ type: envelope().questions[0].type, options: envelope().questions[0].options.length }));
	});
	assert.deepEqual(result, { type: "select", options: 2 });
	assert.match(warnings.join("\n"), /多行文本意图键，但本题带 options/);
});

test("顶层拼错的 type 日志写出实际采用的类型（意图键优先于形状）", async () => {
	const tool = registerTool();
	const { warnings } = await captureWarnings(async () => {
		// 取值本身不是多选样（"grid" 与多选无关），所以实际采用的类型来自意图键而不是 type 字段：
		// 日志里的类型必须是这个最终结果，不能写着 type 字面量。
		const { promise } = runBatch(tool, { type: "grid", question: "选哪些？", options: ["A"], multi_select: true });
		await promise;
	});
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /实际按 multi_select 处理/);
});

test("意图键写在工具参数最外层：当作各题默认 type，不许静默降级成单选", async () => {
	// 线上故障同构：外层 multi_select 被丢掉 → 带 options 的题推成 select → 点选项即交卷，模型无反馈。
	// warn 只进 pi stderr，模型看不到，所以靠 warn 兜不住。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "选哪些？", options: ["A"] },
				{ id: "b", question: "选哪些？", options: ["B"], type: "select" },
			],
			multi_select: true,
		});
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	// 题上显式写的 type 仍然优先，外层意图只补缺。
	assert.deepEqual(result, ["multi_select", "select"]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /已当作各题默认 type（multi_select/);
});

test("外层选择题意图只折叠到带 options 的题：无 options 的题退成 input，不能把整批打回", async () => {
	// 无 options 的题折成 multi_select 会撞 execute 的「必须有 options」护栏 → cancelled、一张卡都不渲染，
	// 那比该题原本拿到的 input 文本档更差（input 不存在点一下即交卷的风险）。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选哪些？", options: ["A", "B"] },
			{ id: "b", question: "补充说明" },
		],
		multi_select: true,
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["multi_select", "input"],
	);
});

test("外层纯文本式 type 不吞掉带 options 的题：形状优先，选项原样进入信封", async () => {
	// 反向护栏：外层 type: "input" 若无条件折叠到带 options 的题，模型给的选项会被整组丢掉
	// （用户从「点选项」退回「手打」），比改动前的形状推断（select）更糟。
	const tool = registerTool();
	for (const outer of ["input", "confirm", "editor"]) {
		const { result, warnings } = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, {
				questions: [
					{ id: "a", question: "选哪个？", options: ["A", "B"] },
					{ id: "b", question: "补充说明" },
				],
				type: outer,
			});
			return promise.then(() => envelope().questions);
		});
		assert.deepEqual(JSON.parse(JSON.stringify(result.map((q) => q.type))), ["select", outer], `外层 ${outer}`);
		assert.deepEqual(JSON.parse(JSON.stringify(result[0].options.map((o) => o.label))), ["A", "B"], `外层 ${outer}`);
		assert.equal(warnings.length, 1, `外层 ${outer}`);
	}
});

test("工具参数外层的 stray options 不许吃掉外层多行文本意图（那层的 options 已声明忽略）", async () => {
	// `declaredTypeOf` 的 editor 分支拿 `hasPickableOptions(raw)` 判「带 options 时不压选项」：在题级
	// 那个 options 是真实形状信号，在工具参数外层却是同一句日志里刚说「已忽略」的逐题字段。
	// 不分开这两层，外层 `multiline: true` 会被自己的 stray options 反推成无意图 → 题落成 input，
	// 而且日志反过来声称「没有可识别的 type / 意图键」——同一意图换个拼写（type: "multiline"）又是 editor，
	// 正是本分支要消灭的「同一意思两种形态」。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "a", question: "贴代码" }], multiline: true, options: ["A"] });
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(JSON.parse(JSON.stringify(result)), ["editor"], "外层 multiline 要当默认 type");
	const joined = warnings.join("\n");
	assert.match(joined, /已当作各题默认 type（editor/, "日志要说明意图真的被采纳了");
	assert.doesNotMatch(joined, /没有可识别的 type \/ 意图键/, "意图明明在，不许说没有");
	// 同一组字段两处判据必须同判：`outerType` 已按「options 不是形状」把外层判成 editor，`consumedMulti`
	// 就不能再拿那个被忽略的 options 把拼错键记成「已消费」（同一个输入两个 verdict，正是下一次漂移的入口）。
	// 上面那题没有 options、折成 editor；带 options 的题折不动，按形状落 select——两种都要求拼错键如实报忽略。
	for (const [label, question, expected] of [
		["无选项题", { id: "b", question: "贴代码" }, "editor"],
		["带选项题", { id: "c", question: "选哪些？", options: ["A", "B"] }, "select"],
	]) {
		const mixed = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, { questions: [question], multiline: true, options: ["A"], checkbox: true });
			return promise.then(() => envelope().questions.map((q) => q.type));
		});
		assert.deepEqual(JSON.parse(JSON.stringify(mixed.result)), [expected], `${label}：外层 multiline 折不动时按形状走`);
		assert.match(mixed.warnings.join("\n"), /忽略未知字段 "checkbox"/, `${label}：没参与渲染的键要如实报忽略`);
	}
});

test("外层意图键推出的文本式 type 同样只折叠到无 options 的题", async () => {
	// 与上一条同一条折叠规则，只是外层意图来自意图键（multiline: true → editor）而非 type 字段。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "选哪个？", options: ["A", "B"] },
				{ id: "b", question: "贴代码" },
			],
			multiline: true,
		});
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(JSON.parse(JSON.stringify(result)), ["select", "editor"]);
	assert.equal(warnings.length, 1);
});

test("options 为空数组与不写 options 同判：外层选择题意图不折叠（否则撞护栏、一张卡都不渲染）", async () => {
	// `options: []` 也是「本题没有选项」：折成 pick 会被 execute 的 options 护栏整批打回。
	// 这条钉住 hasOptions 的 `length > 0`，别让后来者简化成 `Array.isArray`。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "选哪些？", options: ["A", "B"] },
				{ id: "b", question: "补充说明" },
				{ id: "c", question: "没有选项", options: [] },
			],
			multi_select: true,
		});
		return promise.then((res) => ({ types: envelope().questions.map((q) => q.type), text: res.content[0].text }));
	});
	assert.deepEqual(JSON.parse(JSON.stringify(result.types)), ["multi_select", "input", "input"]);
	assert.doesNotMatch(result.text, /未执行/);
	assert.equal(warnings.length, 1);
});

test("外层多选样拼错键（checkbox / multiChoice）折叠成多选，与题级同判据", async () => {
	// 同一拼写作为 type 取值已收口成多选，作为外层 key 却静默变单选，会留下同类漏洞。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"] }],
		checkbox: true,
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["multi_select"],
	);
});

test("外层写 type/options：type（含别名）当默认值，options 逐题字段仍只忽略", async () => {
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { type: "multi-select", options: ["A"], questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"] }] });
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["multi_select"]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /顶层字段的 type \/ options 不属于工具参数级/);
});

test("单问题（legacy 顶层字段）模式同样把已消费的多行样键从「已忽略」里摘掉", async () => {
	// 题级与 legacy 是两个独立 call site（applyLineLikeIntent 各用默认值）：只测批量路径时，
	// 谁把 legacy 那处也改成 false，前一条用例仍全绿。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { question: "贴日志", multipleLines: true });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "editor");
	const joined = warnings.join("\n");
	assert.match(joined, /顶层字段写了多行文本样字段，已按 editor 渲染/);
	assert.doesNotMatch(joined, /忽略未知字段/);
});

test("headless（hasUI:false）时多选样未知键不抛错，直接返回不可用说明", async () => {
	const tool = registerTool();
	const result = await tool.execute("call_headless", { questions: [{ id: "q1", question: "选哪些？", options: ["A"], multiChoice: true }] }, undefined, undefined, {
		hasUI: false,
		ui: { input: async () => "" },
	});
	assert.match(result.content[0].text, /不支持交互式 UI/);
});

test("headless 的 ctx 缺 hasUI 字段时也不抛错（与 hasUI:false 同判）", async () => {
	const tool = registerTool();
	const result = await tool.execute("call_headless", { questions: [{ id: "q1", question: "选哪些？", options: ["A"], checkbox: true }] }, undefined, undefined, {
		ui: { input: async () => "" },
	});
	assert.match(result.content[0].text, /不支持交互式 UI/);
	assert.equal(result.details.questions[0].type, "multi_select");
});

test("headless 的 ctx 整个缺失时也不抛错（与缺 hasUI 字段同判）", async () => {
	const tool = registerTool();
	for (const ctx of [undefined, null]) {
		const result = await tool.execute("call_headless", { questions: [{ id: "q1", question: "选哪些？", options: ["A"], checkbox: true }] }, undefined, undefined, ctx);
		assert.match(result.content[0].text, /不支持交互式 UI/);
		assert.equal(result.details.questions[0].type, "multi_select");
	}
});

test("headless / 飞书：拼错键的猜测真进了 details，就不许同时说「已忽略」", async () => {
	// 非交互场景不会抛错，拼错键经 explicitTypeOf 的猜测真的决定了 type（进 details）；
	// 与有 UI 的升级路径同一类消费，日志不能一边说“已忽略”一边把它渲染成多选。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() =>
		tool.execute("call_headless", { questions: [{ id: "q1", question: "选哪些？", options: ["A"], checkbox: true }] }, undefined, undefined, {
			hasUI: false,
			ui: { input: async () => "" },
		}),
	);
	assert.equal(result.details.questions[0].type, "multi_select");
	assert.doesNotMatch(warnings.join("\n"), /忽略未知字段/);
});

test("报错文案回显模型实际写的值，并给出单选写法", async () => {
	const tool = registerTool();
	const error = await runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A"], multiChoice: 1 }] }).promise.then(
		() => null,
		(err) => err.message,
	);
	assert.match(error, /"multiChoice": 1/);
	assert.doesNotMatch(error, /"multiChoice": true/);
	assert.match(error, /单选写 type: "select"/);
});

test("飞书会话：多选样未知键不抛错，仍返回「写进回复文本」的指引", async () => {
	const previous = process.env.PIDECK_FEISHU_LINKED;
	process.env.PIDECK_FEISHU_LINKED = "1";
	try {
		let tool;
		registerAskQuestion({
			registerTool: (t) => {
				tool = t;
			},
		});
		const result = await tool.execute("call_feishu", { questions: [{ id: "q1", question: "选哪些？", options: ["A"], multiChoice: true }] }, undefined, undefined, {
			hasUI: true,
			ui: { input: async () => "" },
		});
		assert.match(result.content[0].text, /飞书/);
	} finally {
		if (previous === undefined) delete process.env.PIDECK_FEISHU_LINKED;
		else process.env.PIDECK_FEISHU_LINKED = previous;
	}
});

test("顶层单问题模式同样识别布尔意图键、同样只对多选样未知字段报错", async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, { question: "接下来做哪些？", options: ["A", "B"], multi_select: true });
	await promise;
	assert.equal(envelope().questions[0].type, "multi_select");
	await assert.rejects(runBatch(tool, { question: "多选", options: ["A"], multipleChoice: true }).promise, /顶层字段 出现 "multipleChoice": true/);
});

test("顶层 type 的多选样拼写不再靠别名表枚举：multiSelection / multiAnswers / checkboxGroup 同判", async () => {
	// 同一个拼写作为 key 会被要求改写 type: "multi_select"（见上面 multiChoice 的用例），
	// 作为 type 取值却没有同谓词兜底 → 推成 select → 点一下即交卷。手工表列不全，两个空间必须同谓词。
	const tool = registerTool();
	await captureWarnings(async () => {
		for (const written of ["multiSelection", "multiSelections", "multiAnswers", "checkboxGroup", "checkboxes"]) {
			const { promise, envelope } = runBatch(tool, { type: written, question: "选哪些？", options: ["A", "B"] });
			await promise;
			assert.equal(envelope().questions[0].type, "multi_select", `type: "${written}" 应收口成 multi_select`);
		}
	});
});

test("裸 choice / choices 不当多选：单数说的是「这是一道选择题」，交给形状判", async () => {
	const tool = registerTool();
	for (const written of ["choice", "choices"]) {
		const { promise, envelope } = runBatch(tool, { type: written, question: "选哪个？", options: ["A", "B"] });
		await promise;
		assert.equal(envelope().questions[0].type, "select", `type: "${written}" 应保持单选`);
		assert.equal(envelope().questions[0].options.length, 2);
	}
});

test("type 取值里的多行文本样拼写同样按 editor 收口（无 options 时与 multiline 键同判）", async () => {
	const tool = registerTool();
	for (const written of ["multipleLines", "allowMultiline", "multilineHint"]) {
		const { promise, envelope } = runBatch(tool, { type: written, question: "贴日志" });
		await promise;
		assert.equal(envelope().questions[0].type, "editor", `type: "${written}" 应收口成 editor`);
	}
});

test("多行文本样 type 拼写带 options：按声明渲染 editor，但必须留一条「选项不会渲染」的日志", async () => {
	// 键与 type 取值在这里**故意不对称**（键让位给形状、选项优先；取值按声明压掉 options）。压掉选项有据可依，
	// 但一句日志都没有就成了「选项凭空消失」——与本次要消灭的静默降级同一类，只是没有 warn 就搜不到。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(async () => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "a", question: "贴代码", type: "multiline", options: ["A"] }] });
		await promise;
		return envelope().questions[0].type;
	});
	assert.equal(result, "editor");
	assert.match(warnings.join("\n"), /选项不会渲染/);
});

test("规范 type: editor 带 options 同样留一条「选项不会渲染」的日志", async () => {
	// 别名拼写有 warn、规范写法反而零输出时，事后按日志搜不到「选项整组丢失」；docblock 要求取值侧一律留痕。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(async () => {
		const { promise, envelope } = runBatch(tool, { question: "贴代码", type: "editor", options: ["A"] });
		await promise;
		return envelope().questions[0].type;
	});
	assert.equal(result, "editor");
	assert.match(warnings.join("\n"), /选项不会渲染/);
	assert.equal(warnings.length, 1);
});

test("批量题的 type 写错同样留日志（单题路径有线索，questions[i] 不许静默收口）", async () => {
	// 这是一条只服务于事后排查的线索，但两条路径里少一条，按日志就搜不全同一个现象；而 `questions` 才是
	// schema 推荐的主路径（单题也放进数组），漏掉的恰好是最常走的那一条。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(async () => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "a", question: "选哪个", options: ["A"], type: "SELECT" }] });
		await promise;
		return envelope().questions[0].type;
	});
	assert.equal(result, "select");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /questions\[0\]的 type "SELECT" 不是规范写法，已按 select 处理/);
});

test("数组 / 对象取值不算「表达了意图」：multiline: [] 不许把带 options 的题折成纯文本", async () => {
	// 非标量按真值处理会让 `multiline: []` 静默换掉渲染形态、把选项整组丢掉——
	// 与本次要消灭的「静默变单选」同一类问题，只是方向相反。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选哪个", options: ["A"], multiline: [] },
			{ id: "b", question: "选哪些", options: ["B"], multi_select: {} },
			{ id: "c", question: "贴代码", multiline: [] },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select", "input"],
	);
	assert.deepEqual(
		envelope().questions[0].options.map((o) => o.label),
		["A"],
	);
});

test('键名命中多选样、取值自己写着多选（multipleSelect: "multiple"）同样按多选拼错报错', async () => {
	// 取值词表只有 true/yes/on/1 时，这个写法既不报错也不折叠 → 静默推成 select（点一下即交卷）。
	const tool = registerTool();
	await captureWarnings(() => assert.rejects(runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A"], multipleSelect: "multiple" }] }).promise, /"multipleSelect": "multiple"[\s\S]*type: "multi_select"/));
});

test('取值自己写着单选（multiple: "single"）不算多选意图：同一个词两个空间不许相反', async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiple: "single" },
			{ id: "b", question: "选一个", options: ["B"], multi_select: "单选" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select"],
	);
});

test("裸 choice / choices: true 只 warn 不报错：它可能只是强调「这是一道选择题」", async () => {
	// 按多选拒掉整批提问（一张卡都不渲染、模型整批重发）比这行冗余键本身贵得多；
	// 与取值空间「裸 choice → select」同判，两个空间不再相反。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "选哪个", options: ["A"], choice: true },
				{ id: "b", question: "选哪些", options: ["B"], choices: true },
			],
		});
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["select", "select"]);
	assert.equal(warnings.length, 2);
	assert.doesNotMatch(warnings.join("\n"), /多选必须写/);
});

test("批量里第 2 题拼错时，报错定位到 questions[1]", async () => {
	const tool = registerTool();
	const { result: error } = await captureWarnings(() =>
		runBatch(tool, {
			questions: [
				{ id: "a", question: "没问题", options: ["A"] },
				{ id: "b", question: "多选", options: ["B"], multiChoice: true },
			],
		}).promise.then(
			() => null,
			(err) => err.message,
		),
	);
	assert.match(error, /questions\[1\]/);
});

test("选项写成 choices（不叫 options）时选项整组丢失：输入卡 + warn，不是「本来能正常渲染」", async () => {
	// 钉住现状，别让注释再承诺「把选项写成 choices 的调用本来能正常渲染」——choices 不在 schema 里，
	// 形状推断只看 options，所以这里只能落到 input，并留一条 warn 让人按提示改成 options。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { question: "选一个", choices: ["A", "B"] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "input");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /"choices"/);
});

test("信封里的 type 恒在桌面端白名单内（extensionUiGate 只认 5 值，否则整题被过滤）", async () => {
	const tool = registerTool();
	const { result: envelope } = await captureWarnings(async () => {
		const { promise, envelope } = runBatch(tool, {
			questions: [{ question: "选一个", options: ["A"] }, { question: "选哪些", options: ["B"], multi_select: true }, { question: "继续吗", type: "confirm" }, { question: "说两句" }, { question: "贴代码", multiline: true }, { question: "拼错键", options: ["C"], selection: true }],
			review: true,
		});
		await promise;
		return envelope;
	});
	const allowed = ["select", "multi_select", "confirm", "input", "editor"];
	assert.deepEqual(
		envelope().questions.map((q) => allowed.includes(q.type)),
		[true, true, true, true, true, true],
		`unexpected type: ${JSON.stringify(envelope().questions.map((q) => q.type))}`,
	);
});

/** 跑一次工具，返回题目最终 type；整批未执行（撞 options 护栏）返回 NOENV；抛错（题级拼错键）返回 THROW。 */
async function resolvedType(tool, params) {
	const { promise, envelope } = runBatch(tool, params);
	let res;
	try {
		res = await promise;
	} catch (error) {
		// 只有「题级多选样拼错键」这一种抛错是表里预期的（`THROW` 列）：任何别的异常（TypeError、护栏误抛…）
		// 都必须炸出来，否则 `expected = "THROW"` 那几行连「崩溃」都算通过，报错文案换成什么都不影响结果。
		if (!/多选必须写 type: "multi_select"/.test(String(error?.message))) throw error;
		return "THROW";
	}
	const parsed = envelope();
	if (parsed) return parsed.questions[0].type;
	return res.content[0].text.includes("未执行") ? "NOENV" : "??";
}

test("同一拼写 × 两个空间同判（表驱动：key 与 type 取值不许各自得出相反结论）", async () => {
	// 这一组不一致是上面几条缺陷的共同根因：只测「取值 → X」或「键 → Y」时，两侧相反也全绿。
	// 两处**有意**的不对称，不许被这条用例误钉：
	// - 题级「多选样未知键」（multiSelection / checkboxGroup…）故意抛错让模型改写 type，而取值侧静默收口；
	// - 「多行文本样未知键」只是形状提示，带 options 时不压选项（取值侧 type 是显式声明，像 type:"editor" 一样压掉）。
	const tool = registerTool();
	const rows = [
		// [拼写, 取值-side 带 options, 取值-side 无 options, key-side 带 options, key-side 无 options]
		["multiple", "multi_select", "NOENV", "multi_select", "NOENV"],
		["multi_select", "multi_select", "NOENV", "multi_select", "NOENV"],
		["choice", "select", "input", "select", "input"],
		["choices", "select", "input", "select", "input"],
		["allowCustomChoice", "select", "input", "select", "input"],
		["choiceList", "select", "input", "select", "input"],
		["multipleLines", "editor", "editor", "select", "editor"],
		["allowMultiline", "editor", "editor", "select", "editor"],
		["multiSelection", "multi_select", "NOENV", "THROW", "THROW"],
		["checkboxGroup", "multi_select", "NOENV", "THROW", "THROW"],
	];
	await captureWarnings(async () => {
		for (const [written, valueWith, valueWithout, keyWith, keyWithout] of rows) {
			assert.equal(await resolvedType(tool, { type: written, question: "q", options: ["A", "B"] }), valueWith, `type:"${written}" 带 options`);
			assert.equal(await resolvedType(tool, { type: written, question: "q" }), valueWithout, `type:"${written}" 无 options`);
			assert.equal(await resolvedType(tool, { questions: [{ question: "q", options: ["A", "B"], [written]: true }] }), keyWith, `"${written}": true 带 options`);
			assert.equal(await resolvedType(tool, { questions: [{ question: "q", [written]: true }] }), keyWithout, `"${written}": true 无 options`);
		}
	});
});

test("取值空间的单选样 / 多选样边界（SINGLE_LIKE_KEY、LINE_THEN_PICK 也服务取值侧）", async () => {
	const tool = registerTool();
	await captureWarnings(async () => {
		// 明确单选的拼写 → 交回形状推断（select），不能被判成多选
		for (const written of ["singleChoice", "exclusivePick", "single-choice"]) {
			assert.equal(await resolvedType(tool, { type: written, question: "选哪个", options: ["A", "B"] }), "select", `type: "${written}" 应是 select`);
		}
		// line 紧跟选择语义 → 多选（不能因为含 line 就判成 editor）
		for (const written of ["multiLineSelect", "multiSelectLines"]) {
			assert.equal(await resolvedType(tool, { type: written, question: "选哪些", options: ["A", "B"] }), "multi_select", `type: "${written}" 应是 multi_select`);
		}
	});
});

test("裸 choice / choices 作为 type 取值且无 options 时落到 input（不撞护栏）", async () => {
	// 带 options 的用例分不出「返回 undefined」与「显式 select」；无 options 时会撞 execute 的护栏，
	// 所以这条专门钉住「裸 choice 交回形状推断」而不是被当成选择题式声明。
	const tool = registerTool();
	await captureWarnings(async () => {
		for (const written of ["choice", "choices"]) {
			assert.equal(await resolvedType(tool, { type: written, question: "说明一下" }), "input", `type: "${written}" 无 options 应是 input`);
		}
	});
});

test('意图键取值写着单选的分隔符/同义词变体（multiple: "single choice" / "select one"）不升级成多选', async () => {
	// 归一表此前只服务 type 取值：`multiple: "single"`（命中词表）判成单选，`"single choice"`（不命中）被判成
	// 「表达了意图」→ 多选卡。同一个词只因为多写一个空格就换渲染形态，正是本次要消灭的那一类，只是方向相反。
	// 反序语序（`"select one"`）同属这一类：判决不该取决于词的先后。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiple: "single choice" },
			{ id: "b", question: "选一个", options: ["B"], multi_select: "single_choice" },
			{ id: "c", question: "选一个", options: ["C"], multiple: "one option" },
			{ id: "d", question: "选一个", options: ["D"], multiple: "exclusive" },
			{ id: "e", question: "选一个", options: ["E"], multiple: "select one" },
			{ id: "f", question: "选一个", options: ["F"], multiple: "pick one" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select", "select", "select", "select", "select"],
	);
});

test('singleLine / oneLine 说的是单行文本：不折成 editor（与 type: "singleLine" 同判）', async () => {
	// isLineLikeKey 只判「含 line 且不与选择语义相邻」，`singleLine` / `oneLine` 于是被当成多行意图 → 多行框；
	// 而同一个拼写作为 type 取值又交回形状推断落成 input。两个空间相反，方向还是「单行 → 多行」这种静默换形态。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "一句话结论", singleLine: true },
				{ id: "b", question: "选一个", options: ["A"], oneLine: true },
			],
		});
		return promise.then(() => envelope().questions.map((q) => ({ type: q.type, options: q.options?.length })));
	});
	assert.deepEqual(JSON.parse(JSON.stringify(result)), [{ type: "input" }, { type: "select", options: 1 }]);
	assert.doesNotMatch(warnings.join("\n"), /多选必须写/);
	// 取值空间同判（修复前后都是 input：`canonicalTypeOf` 因不含多选词根提前返回）：记录两空间一致，
	// 防止后来者把归一后的 `singleline` 再判成 editor。
	assert.equal(await resolvedType(tool, { type: "singleLine", question: "一句话结论" }), "input");
	assert.equal(await resolvedType(tool, { type: "one-line", question: "一句话结论" }), "input");
	// 键名与 type 取值同样归一：双分隔符的 `single__choice` 作为键不许被判成拼错的多选键抛错。
	const spaced = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "c", question: "选一个", options: ["A"], single__choice: true }] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(spaced.result, "select");
});

test("外层被折成默认 type 的拼错键不再被日志说成「已忽略」", async () => {
	// warn 只服务于事后排查：`checkbox: true` 明明折成了默认 type，日志却报「忽略未知字段 checkbox」，
	// 排查时这条线索只能当噪音丢掉。折了就说折了，没折才说忽略。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"] }], checkbox: true });
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["multi_select"]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /顶层字段的 checkbox/);
	assert.doesNotMatch(warnings[0], /忽略未知字段/);
});

test("外层拼错键被折成默认 type 后，同样不许列进「字段只支持 …」清单", async () => {
	// 上一组用例钉的是题级 call site（consumedMulti 收得到拼错键）；外层靠 extraKnown「放行」绕过
	// 「未知字段」那一句，于是同一个拼错键会从另一条告警里漏出来，被宣传成受支持字段名——
	// 模型/排查者照着日志写 `checkbox: true` 就会撞上题级那条报错。放行不等于合法。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"] }], checkbox: true, description: "冗余" });
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["multi_select"], "外层拼错键仍要折成默认多选");
	const joined = warnings.join("\n");
	assert.match(joined, /忽略未知字段 "description"/, "其它未知字段仍要如实报忽略");
	assert.doesNotMatch(joined, /字段只支持[^\n]*checkbox/, "被折成默认 type 的拼错键不许列进受支持字段");
});

test("工具参数外层的「字段只支持 …」不许把逐题字段宣传成工具参数级字段", async () => {
	// 同一句日志的后半截已经声明「options / placeholder 等逐题字段已忽略」，前半截的受支持清单却把
	// id / question / options / placeholder / prefill / allowOther 全列了一遍。模型照着清单写有效字段名
	// （比如把 options 留在外层）会直接丢掉整组选项、题退成 input。这一层真正生效的只有 type 与意图键。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "a", question: "选一个", options: ["A"] }], foo: 1 });
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["select"], "外层未知键不影响逐题渲染");
	const listed = warnings.join("\n").match(/字段只支持[^\n]*/)?.[0] ?? "";
	assert.match(listed, /questions/, "参数级自身字段要在清单里");
	assert.match(listed, /\btype\b/, "外层 type 真的生效，要在清单里");
	// 反向也不能漏：把清单退化成 ["type"] 时上面的 doesNotMatch 仍全绿，但清单会漏报真能生效的意图键。
	assert.match(listed, /multi_select/, "外层多选意图键要在清单里");
	assert.match(listed, /multiline/, "外层多行意图键要在清单里");
	for (const perQuestionOnly of ["question", "options", "placeholder", "prefill", "allowOther", "id"]) {
		assert.doesNotMatch(listed, new RegExp(`(?:^|[ /])${perQuestionOnly}(?:[ /]|$)`), `逐题字段 ${perQuestionOnly} 写在外层不生效，不许列进受支持清单`);
	}
});

test("外层已声明 type 且不会被多选意图升级时，拼错的多选键如实报「忽略」而不是「已当作默认 type」", async () => {
	// 声明优先：`type: "input"` 在场、多选意图也不会把它升级成多选时，拼错键的意图根本不会被消费，
	// 这时候说「已当作各题默认 type（select）」等于把被丢掉的东西说成被采纳了——同一条 warn 撒谎，
	// 只是换了个方向。（`type: "select"` + 多选意图现在会被升级成 multi_select，见下一条用例。）
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪个？", options: ["A", "B"] }], type: "input", checkbox: true });
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["select"]);
	const joined = warnings.join("\n");
	assert.match(joined, /忽略未知字段 "checkbox"/);
	assert.doesNotMatch(joined, /checkbox.*已当作各题默认 type/);
});

test('type: "select" 旁边写了多选意图：升级成 multi_select，不留「点一下即交卷」的静默降级', async () => {
	// `type: "select"` 只说了「这是一道选择题」，基数由 `multiple: true` / `multi_select: true` 说，两者不矛盾。
	// 改前声明优先会把多选意图整条吃掉：渲染成 select（askUi.shouldAutoAdvanceBatchAnswer 里 select
	// 点选项即提交），用户点一个就交卷、模型拿到单个值，而且连 warn 都没有。
	const tool = registerTool();
	for (const intentKey of ["multiple", "multi_select", "multiSelect", "multiselect", "multi"]) {
		const { warnings, result } = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], type: "select", [intentKey]: true }] });
			return promise.then(() => envelope().questions[0].type);
		});
		assert.equal(result, "multi_select", `${intentKey}: true 应升级成 multi_select`);
		assert.match(warnings.join("\n"), /已按 multi_select 处理/, `${intentKey}: 升级要留一条排查线索`);
	}
	// 未知的多选样键（`checkbox` / `selectMultiple`）同样参与升级，否则一边报「请改 multi_select」的键
	// 在 select 旁边就被静默吞掉——两个入口判决相反。
	for (const [key, value] of [
		["checkbox", true],
		["selectMultiple", true],
		["multipleChoice", "yes"],
		["allowMultiple", 1],
	]) {
		const { warnings, result } = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], type: "select", [key]: value }] });
			return promise.then(() => envelope().questions[0].type);
		});
		assert.equal(result, "multi_select", `${key}: ${JSON.stringify(value)} 应升级成 multi_select`);
		// 意图已经进了渲染结果，就不许再说「已忽略」——同一句日志里一边说忽略一边说已按多选处理是自相矛盾；
		// 「字段只支持 …」也不能把这个被吃掉的多选意图键宣传成合法字段名。
		const joined = warnings.join("\n");
		assert.doesNotMatch(joined, /忽略未知字段/, `${key}: 被升级消费的键不许报「已忽略」`);
		assert.doesNotMatch(joined, /字段只支持[^\n]*checkbox|字段只支持[^\n]*selectMultiple|字段只支持[^\n]*allowMultiple/, `${key}: 不许把拼错键列进受支持字段`);
	}
	// `multiple: true` 是已知意图键，本身不进「未知字段」名单，同样不许出现忽略字句。
	const known = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], type: "select", multiple: true, checkbox: true }] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(known.result, "multi_select");
	assert.doesNotMatch(known.warnings.join("\n"), /忽略未知字段 "checkbox"/);
	// 否定值 / 单选字样不算意图，不能把真正的单选卡翻成多选。
	for (const value of [false, 0, "no", "false", "single", "single choice"]) {
		const { result } = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪个？", options: ["A", "B"], type: "select", multiple: value }] });
			return promise.then(() => envelope().questions[0].type);
		});
		assert.equal(result, "select", `multiple: ${JSON.stringify(value)} 不是多选意图`);
	}
});

test("只有 select 会被多选意图升级：input / confirm / editor 仍按声明走（折成多选会撞 options 护栏）", async () => {
	// 这些题型多半没有 options，升级成 multi_select 会撞 execute 的「必须提供 options」→ 整批打回、
	// 一张卡都不渲染，比原来的文本档更差（同 inferType 的 fallbackType 取舍）。
	// 但「多选意图被忽略」同样不能零日志：模型写了多选、渲染出来却是文本档/确认框，事后排查看不到线索。
	const tool = registerTool();
	for (const type of ["input", "confirm", "editor"]) {
		const { warnings, result } = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "随便说说", type, multiple: true }] });
			return promise.then(() => envelope().questions[0].type);
		});
		assert.equal(result, type, `${type} + multiple: true 不该被升级`);
		assert.match(warnings.join("\n"), /多选意图键被忽略/, `${type}: 被忽略的多选意图要留一条排查线索`);
	}
});

test('外层 type: "select" + 多选意图：折叠成默认 multi_select，被升级消费的键不再说成「已忽略」', async () => {
	// 外层写法（题级字段写错层级）走同一套判据：`type: \"select\"` 被多选意图升级后，
	// `checkbox` 的意图已经进了渲染结果，日志就不能再说「忽略未知字段 checkbox」——撒谎的日志比没有更费时间。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "q1", question: "选哪些？", options: ["A", "B"] },
				{ id: "q2", question: "补充说明" },
			],
			type: "select",
			checkbox: true,
		});
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	// 折叠仍受形状约束：无 options 的题留在 input（折成多选会撞护栏、整批打回）。
	assert.deepEqual(result, ["multi_select", "input"]);
	const joined = warnings.join("\n");
	assert.doesNotMatch(joined, /忽略未知字段 "checkbox"/);
	assert.match(joined, /已当作各题默认 type（multi_select/);
});

test("外层多选意图 + 布尔意图键同写：渲染为多选，且不重复报「已忽略」", async () => {
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"] }], multi_select: true, checkbox: true });
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["multi_select"]);
	assert.doesNotMatch(warnings.join("\n"), /忽略未知字段 "checkbox"/);
});

test("外层已声明多选时，题级拼错键不再硬报错（渲染结果早就定了，抛错只会白重发一整批）", async () => {
	// 外层 `multi_select: true` + 本题带 options 时，按折叠规则渲染结果就是 multi_select，与拼错键要求的
	// 写法完全一致：没有降级，抛错只会把一整套本就可渲染的提问打回、让模型重发。
	// 外层写 `select` 或非选择题式时不豁免（那才是真正的静默降级风险，见下一条对照）；
	// 题级自己声明过时也不受影响（已有用例）。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], checkbox: true }], multi_select: true });
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["multi_select"]);
	// 对照：外层写的是 select（不会升级成本题的多选）时照旧报错，别把豁免写成「外层有意图就行」。
	await assert.rejects(() => runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], checkbox: true }], type: "select" }).promise, /多选必须写 type: "multi_select"/);
	// 对照：外层多选但本题没有 options（折叠不成立）时也照旧报错。
	await assert.rejects(() => runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", checkbox: true }], multi_select: true }).promise, /多选必须写 type: "multi_select"/);
	// 弱断言（只看有没有 warn）会被「反正 stray warn 恒触发」蒙过去：钉子落到内容上。
	assert.match(warnings.join("\n"), /已当作各题默认 type（multi_select/, "外层 intent 仍要留排查线索");
});

test("只是含有 line 的词不算多行文本样（outline / deadline / inline 不许被静默折成 editor）", async () => {
	// 判据是「multi/multiple 紧跟 line」，不是 token.includes("line")：outline / deadline / headline / timeline /
	// inline / pipeline 只是**含有** line、跟多行文本无关。旧判据把它们折成 editor（无 options 时渲染形态被换掉），
	// 而同一个拼写作为 type 取值又落成 input——又是「同一个词两个空间相反判决」，方向反过来。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "选一个", options: ["A"], outline: true },
				{ id: "b", question: "说两句", deadline: true },
				{ id: "c", question: "说两句", inline: true },
			],
		});
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["select", "input", "input"]);
	const joined = warnings.join("\n");
	assert.doesNotMatch(joined, /已按 editor 渲染/);
	// 三个键都没参与渲染，就都如实报「忽略未知字段」。
	assert.equal((joined.match(/忽略未知字段/g) ?? []).length, 3);
	// 同名拼写作为 type 取值与该键同判（都不落 editor）。
	for (const written of ["outline", "deadline", "inline"]) {
		assert.equal(await resolvedType(tool, { type: written, question: "说两句" }), "input", `type: "${written}" 应与键空间同判`);
	}
});

test("外层多选意图把带 options 的题折成 multi_select 时，日志写最终形态而不是 select", async () => {
	// 折叠结果由外层意图决定：`{options, multiline: true}` 在外层 `multi_select: true` 下渲染成 multi_select，
	// 日志硬写「已按 select 渲染」就是撒谎——排查时按日志去找一张根本不存在的单选卡。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "a", question: "选哪些？", options: ["A", "B"], multiline: true }], multi_select: true });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "multi_select");
	const joined = warnings.join("\n");
	assert.match(joined, /已按 multi_select 渲染/);
	assert.doesNotMatch(joined, /已按 select 渲染/);
});

test("带 options 的 confirm/input/editor + 多选意图：日志按真实原因写，不抄「没有 options」", async () => {
	// 这三型不升级的原因是 type 声明了别的题型（那份 options 也确实不渲染），不是缺 options；
	// 把「没有 options 撞护栏」抄进日志，等于给排查指一条不存在的路。
	const tool = registerTool();
	for (const type of ["confirm", "input", "editor"]) {
		const { warnings, result } = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", type, options: ["A"], multiple: true }] });
			return promise.then(() => envelope().questions[0].type);
		});
		assert.equal(result, type, `${type} 不该被升级`);
		const joined = warnings.join("\n");
		assert.doesNotMatch(joined, /没有 options/, `${type}: 本题有 options，不许说是因为缺 options`);
		assert.match(joined, /与多选意图键冲突/, `${type}: 要说明冲突在 type 上`);
	}
});

test("type: multi_select 与多行文本意图键同写：按多选渲染并留一条日志", async () => {
	// `multiline` 在改前是未知字段，至少会报一条「忽略未知字段」；成为已知意图键后被多选声明压掉时若不报，
	// 「多行框没了」这件事就零输出（用户看得见、排查看不见）。
	const tool = registerTool();
	for (const params of [{ questions: [{ id: "q1", question: "选哪些？", options: ["A"], type: "multi_select", multiline: true }] }, { questions: [{ id: "q1", question: "选哪些？", options: ["A"], multi_select: true, multiline: true }] }]) {
		const { warnings, result } = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, params);
			return promise.then(() => envelope().questions[0].type);
		});
		assert.equal(result, "multi_select");
		assert.match(warnings.join("\n"), /多行文本意图键，已按 multi_select 渲染/);
	}
});

test("type: multi_select + multiline 但没 options：日志不许声称「已渲染」（execute 会整批打回）", async () => {
	// 声明了选择题式却没给 options 时一张卡都不渲染（execute 的 options 护栏），
	// 这时说「已按 multi_select 渲染」又是一条指向不存在渲染结果的日志。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", type: "multi_select", multiline: true }] });
		return promise.then((res) => ({ type: envelope()?.questions[0].type ?? null, text: res.content[0].text }));
	});
	assert.equal(result.type, null, "没有 options 的 multi_select 不该进信封");
	assert.match(result.text, /未执行/);
	const joined = warnings.join("\n");
	assert.match(joined, /没有 options，会被 execute 的「必须提供 options」护栏打回/);
	assert.doesNotMatch(joined, /已按 multi_select 渲染/);
});

test("顶层 type 别名被多选意图抬成多选时，日志写最终类型而不是别名（两句 warn 不许互相矛盾）", async () => {
	// `type: "SELECT"` 是别名（提示规范写法 type: "select"），但旁边写了 `multiple: true`，实际渲染 multi_select。
	// 照抄别名会同时产出「已按 multi_select 处理」和「已按 select 处理」两句，排查时按后一句去找那张
	// 根本不存在的单选卡；别名只该作为「这个字段该怎么写」的提示留在括号里。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { type: "SELECT", question: "选哪些？", options: ["A", "B"], multiple: true });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "multi_select");
	const joined = warnings.join("\n");
	assert.doesNotMatch(joined, /已按 select 处理/);
	assert.match(joined, /type "SELECT" 不是规范写法，已按 multi_select 处理/);
	// 括号里的「规范写法」同样只能是最终 type：同一轮两条日志推荐两个不同的 type 取值，
	// 模型照哪条改都有一半是错的（上一条 warn 说「多选请只写 multi_select」）。
	assert.match(joined, /规范写法 type: "multi_select"/);
	assert.doesNotMatch(joined, /规范写法 type: "select"/);
});

test("选择题式没有 options 时，「已按 X 处理」的日志必须说明会被 options 护栏打回", async () => {
	// 与「多行意图 + 没 options 的 multi_select」同一条命题（上一提交只修了那一处）：
	// 护栏会把整批打回、一张卡都不渲染，日志再说「已按 X 处理」就又是误导。
	const tool = registerTool();
	// 顶层别名收口出的 multi_select 没有 options（旧调用形态）
	{
		const { warnings, result } = await captureWarnings(() => runBatch(tool, { type: "multipleChoice", question: "选哪些？" }).promise);
		assert.match(result.content[0].text, /未执行/);
		assert.equal(result.details.questions[0].type, "multi_select");
		const joined = warnings.join("\n");
		assert.match(joined, /已按 multi_select 处理/);
		assert.match(joined, /必须提供 options」护栏打回/);
	}
	// 题级 `type: "select"` + 多选意图升级：同一命题的另一个入口
	{
		const { warnings, result } = await captureWarnings(() => runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", type: "select", multiple: true }] }).promise);
		assert.match(result.content[0].text, /未执行/);
		const joined = warnings.join("\n");
		assert.match(joined, /已按 multi_select 处理，但本题没有 options/);
		assert.match(joined, /必须提供 options」护栏打回/);
	}
});

test("自动兜底的 id 不许和模型自己写的 id 撞车（桌面端按 id 存答案，撞车会伪造答案）", async () => {
	// 第 1 题没写 id（自动 q1），第 2 题明确写 `id: "q1"`：旧实现两题都叫 q1，桌面端
	// answers[question.id] 是同一个槽，答第 1 题即被当成「两题都答了」，模型收到一条不存在的答案。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ question: "用哪个包管理器？", options: ["npm", "pnpm"] },
			{ question: "提交信息怎么写？", id: "q1" },
		],
	});
	await promise;
	const ids = envelope().questions.map((q) => q.id);
	assert.equal(new Set(ids).size, ids.length, `id 必须唯一，实际: ${ids.join(" / ")}`);
	// 模型自己写的 id 保持字面不变（它按这个 id 收答案），被挤走的只能是自动兜底值。
	assert.equal(ids[1], "q1");
	// 全部题目都没写 id 时仍按序号兜底（既有行为），不给日志添噪音。
	const plain = await captureWarnings(() => {
		const { promise: p2, envelope: e2 } = runBatch(tool, { questions: [{ question: "a", options: ["A"] }, { question: "b" }] });
		return p2.then(() => e2().questions.map((q) => q.id));
	});
	assert.deepEqual(plain.result, ["q1", "q2"]);
	assert.deepEqual(plain.warnings, []);
});

test("同一 id 写了两道题时也要收成唯一（模型自己撞车同样会伪造答案）", async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ question: "a", options: ["A"], id: "dup" },
			{ question: "b", options: ["B"], id: "dup" },
		],
	});
	await promise;
	const ids = envelope().questions.map((q) => q.id);
	assert.deepEqual(ids, ["dup", "dup-2"]);
});

test("重复 id 的后缀不许抢走另一题真正写下的 id", async () => {
	// `dup` 写重了要加后缀，但后缀候选同样避开**所有**显式 id：否则第 3 题自己写的 `dup-2`
	// 会被第 2 题的兜底后缀挤成 `dup-2-2`，模型收到一个它从未写过的 id（而 id 是它对答案的钥匙）。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ question: "a", options: ["A"], id: "dup" },
			{ question: "b", options: ["B"], id: "dup" },
			{ question: "c", options: ["C"], id: "dup-2" },
		],
	});
	await promise;
	const ids = envelope().questions.map((q) => q.id);
	assert.equal(ids[0], "dup");
	assert.equal(ids[2], "dup-2", `显式 id 必须原样保留，实际: ${ids.join(" / ")}`);
	assert.equal(new Set(ids).size, ids.length, `id 必须唯一，实际: ${ids.join(" / ")}`);
});

test("外层意图没折叠到某题时，批量级日志必须说明「本题自己写了 type / 意图键的优先」", async () => {
	// 与上一条「外层已声明 type 且不会被多选意图升级」相邻：那题有 options、形状并不冲突，
	// 却没吃到外层 multi_select——日志若只说「按形状折叠」，排查时就会怀疑形状判错了。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "选哪些？", options: ["A"] },
				{ id: "b", question: "选一个", options: ["B"], type: "select" },
			],
			multi_select: true,
		});
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["multi_select", "select"]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /只补本题没写 type \/ 意图键的题/);
});

test("意图键取值的英文否定词（disabled / never / single line）不许翻成多选或 editor", async () => {
	// `isIntentOn` 对字符串是 fail-open：除了否定词表里的词，其余一律算「已表达意图」。词表只有
	// false/no/off/单行… 时，模型写的 `multiple: "disabled"` 会被当成多选意图（勾选卡 + 数组），
	// `multiline: "single line"` 会被当成多行意图（多行框）——两处都是「明确说了关掉/单行却渲染成另一形态」，
	// 而日志还会说「已按你的意图渲染」，把排查引到相反结论。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiple: "disabled" },
			{ id: "b", question: "选一个", options: ["B"], multiple: "never" },
			{ id: "c", question: "填一句", multiline: "single line" },
			{ id: "d", question: "填一句", multiline: "disabled" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select", "input", "input"],
	);
});

test("意图键取值与意图键名共用一张真值表（enabled 在两个入口不许得出相反结论）", async () => {
	// 已知键（multiple / multiline…）走 fail-open 的 `isIntentOn`，未知键（allowMultiple / multipleLines…）
	// 改前走封闭词表：`multiple: "enabled"` 是多选卡，`allowMultiple: "enabled"` 却退回单选
	// （点一下即交卷），`multipleLines: "enabled"` 还退成单行框。同一个词换个入口换个结论。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [{ id: "a", question: "写一段", multipleLines: "enabled" }],
	});
	await promise;
	assert.equal(envelope().questions[0].type, "editor");
	await captureWarnings(() => assert.rejects(runBatch(tool, { questions: [{ id: "b", question: "选哪些", options: ["A"], allowMultiple: "enabled" }] }).promise, /"allowMultiple": "enabled"[\s\S]*type: "multi_select"/));
});

test("原型链名字与空串当不了答案槽位：id 让路，别伪造「已作答」", async () => {
	// 桌面端用普通对象按 id 存答案（`answers[question.id]`，见 SessionRuntimeUiOverlay / inspectBatchAnswers）：
	// `answers["constructor"]` 取到的是函数（非 null、非数组），`isBatchAnswered` 于是把没答的题判成已答、
	// 放行提交，序列化时函数又被 JSON.stringify 丢掉 —— 用户真实作答被吞。空串同理（与「没写 id」只差一次
	// hasOwn，且后缀会滚成模型从未写过的 `-2`）。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "constructor", question: "a", options: ["A"] },
			{ id: "toString", question: "b", options: ["B"] },
			{ id: "__proto__", question: "c", options: ["C"] },
			{ id: "", question: "d" },
			{ id: "   ", question: "e" },
		],
	});
	await promise;
	const ids = envelope().questions.map((q) => q.id);
	for (const id of ids) {
		assert.equal(Object.hasOwn(Object.prototype, id), false, `id 不许落在原型链上: ${id}`);
		assert.notEqual(id.trim(), "", "id 不许是空串 / 纯空白");
	}
	assert.equal(new Set(ids).size, ids.length, `id 必须唯一，实际: ${ids.join(" / ")}`);
	// 空 id 拿序号兜底，不是 `-2` 这种模型没写过的后缀。
	assert.deepEqual(ids.slice(3), ["q4", "q5"]);
});

test("未声明键名里的换行压成一行（诊断日志不许被拆成伪造行）", async () => {
	// 「问题反馈」页导出的诊断日志按 `[ask_question]` 前缀逐行读（pideck-doctor）：模型在**未声明键名**里
	// 写换行就能凭空造出一条日志行。题级 `type` 是 schema 声明的 enum、非规范值在校验层就被拒，所以
	// 换行能穿过校验层的入口只有键名与工具参数级的 `type`（未在 schema 声明）。
	const tool = registerTool();
	const { warnings } = await captureWarnings(async () => {
		const { promise } = runBatch(tool, {
			questions: [{ id: "a", question: "q", options: ["A"], "de\nfault": 1 }],
		});
		await promise;
	});
	assert.equal(warnings.length, 1);
	assert.doesNotMatch(warnings[0], /[\r\n\u2028\u2029]/);
	assert.match(warnings[0], /忽略未知字段 "de fault"/);

	// 工具参数级的 `type` 不在 AskQuestionParams 里，能带着换行到达 warnNonCanonicalType。
	const topLevel = await captureWarnings(async () => {
		const { promise } = runBatch(tool, { question: "q", options: ["A"], type: "SELECT\n[ask_question] 伪造的一行" });
		await promise;
	});
	assert.equal(topLevel.warnings.length, 1);
	assert.doesNotMatch(topLevel.warnings[0], /[\r\n\u2028\u2029]/);
	assert.match(topLevel.warnings[0], /伪造的一行/);

	// 同一个顶层 `type` 走多行文本样拼写的分支（带 options → explicit===editor + hasPickableOptions）时
	// 是另一条 warn，同样不许把换行带进去。
	const lineLike = await captureWarnings(async () => {
		const { promise } = runBatch(tool, { question: "q", options: ["A"], type: "multiline\n[ask_question] 伪造的一行" });
		await promise;
	});
	assert.ok(lineLike.warnings.length >= 1);
	for (const warning of lineLike.warnings) assert.doesNotMatch(warning, /[\r\n\u2028\u2029]/);
});

test("多选词根 + 描述性字符串同样报错（fail-open 是有意的策略，不是漏判）", async () => {
	// 未知键走与已知意图键同一张真值表后，取值不再限于 true/yes/on：`{checkboxLabel: "选中多个"}` 这类
	// 「键名像多选、取值是描述」的写法也会硬报错。代价是一轮重发，换来的是不再把多选意图静默降级成
	// 「点一下即交卷」的 select 卡——这条把取舍钉住，免得以后被当成误判「修」回封闭词表。
	const tool = registerTool();
	await captureWarnings(() => assert.rejects(runBatch(tool, { questions: [{ id: "a", question: "选哪些", options: ["A"], checkboxLabel: "选中多个" }] }).promise, /"checkboxLabel": "选中多个"[\s\S]*type: "multi_select"/));
	// 同一个报错里回显取值时不许折叠内部空白（回显就得是模型写的那份字面量）。
	const { result: message } = await captureWarnings(async () => {
		try {
			await runBatch(tool, { questions: [{ id: "b", question: "选哪些", options: ["A"], checkboxHint: "press  space" }] }).promise;
			return null;
		} catch (error) {
			return error.message;
		}
	});
	assert.match(message, /"checkboxHint": "press  space"/);
});

test("英文否定短语（not / not multiple / no multiple）不许翻成多选、editor 或整批报错", async () => {
	// 已知意图键与未知键共用 fail-open 真值表，取值侧只认完整否定词表就会把 `multiple: "not multiple"`
	// 当成「表达了多选」；未知键更会把整批提问硬报错。顶层 `type` 不在 schema 声明里，`notMultiple`
	// 同样会经多选词根被当成 multi_select。否定前缀必须和完整否定词一样关掉意图，键名也不能例外。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiple: "not" },
			{ id: "b", question: "选一个", options: ["B"], multiple: "not multiple" },
			{ id: "c", question: "选一个", options: ["C"], multiple: "no multiple" },
			{ id: "d", question: "填一句", multiline: "not needed" },
			{ id: "e", question: "选一个", options: ["E"], choiceMode: "not multiple" },
			{ id: "f", question: "选一个", options: ["F"], notMultiple: true },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select", "select", "input", "select", "select"],
	);

	const topLevel = await captureWarnings(() => runBatch(tool, { question: "选哪些", options: ["A"], type: "notMultiple" }).promise.then(() => null));
	assert.equal(topLevel.warnings.length, 1);
	assert.match(topLevel.warnings[0], /已忽略，实际按 select 处理/);

	const negatedKey = await captureWarnings(() => runBatch(tool, { question: "选哪些", options: ["A"], notMultiple: true }).promise.then(() => null));
	assert.equal(negatedKey.warnings.length, 1);
	assert.match(negatedKey.warnings[0], /忽略未知字段 "notMultiple"/);
});

test("否定词根带后缀短语同样关掉意图（single line only / negative multiple / 中文否定）", async () => {
	// `OFF_WORDS` 的完整否定词同时要做前缀词根：`single line only` / `negative multiple` / `非多选` 这类写法
	// 与 `not multiple` 同属「明确否定 + 后续内容」，漏一个词根就又变回静默换形态、零日志。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "填一句", multiline: "single line only" },
			{ id: "b", question: "选一个", options: ["B"], multiple: "negative multiple" },
			{ id: "c", question: "选一个", options: ["C"], multiple: "false positive" },
			{ id: "d", question: "选一个", options: ["D"], multiple: "n/a multi" },
			{ id: "e", question: "选一个", options: ["E"], multiple: "非多选" },
			{ id: "f", question: "选一个", options: ["F"], multiple: "无多选" },
			{ id: "g", question: "选一个", options: ["G"], multiple: "没多选" },
			{ id: "h", question: "选一个", options: ["H"], multiple: "未多选" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["input", "select", "select", "select", "select", "select", "select", "select"],
	);
});

test("editor + options + 多选意图只留一条不矛盾的排查线索", async () => {
	// 「与多选意图键冲突」那句已经说明 options 不会渲染并指向 multi_select；再叠一条指向 select 的
	// 「选项不会渲染」warn，就是同一轮两条日志推荐两个不同 type（docblock 明令不许）。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(async () => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", type: "editor", options: ["A"], multiple: true }] });
		await promise;
		return envelope().questions[0].type;
	});
	assert.equal(result, "editor");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /与多选意图键冲突/);
	assert.doesNotMatch(warnings[0], /type: "select"/);
});

test("notMultiline 与 notMultiple 同判：否定前缀键不许折成 editor", async () => {
	// 多选侧键名已复用 isOffToken，多行文本样键名漏了同一判据：`notMultiline: true` 会落成 editor
	// 并被从「已忽略」名单摘掉，日志反过来声称「已按 editor 渲染」——同一否定前缀两个谓词相反判决。
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(async () => {
		const { promise, envelope } = runBatch(tool, { question: "填一句", notMultiline: true });
		await promise;
		return envelope().questions[0].type;
	});
	assert.equal(result, "input");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /忽略未知字段 "notMultiline"/);
	assert.doesNotMatch(warnings[0], /已按 editor 渲染/);
});

test("无撇号 / 带点号的否定短语不许漏判：既不整批打回，也不翻成多选或 editor", async () => {
	// `normalizeTypeToken` 保留撇号与点号，`"does not apply"` 归一成 `doesnotapply`，而词表里只有
	// `"doesn't"`（永远匹配不到）；`isIntentSwitch` 于是 fail-open 判成肯定：已知键静默翻成勾选卡，
	// 未知键更会把整批提问硬报错打回（base 下这类调用只是正常渲染 select）。
	const tool = registerTool();
	await captureWarnings(async () => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "选一个", options: ["A"], multiple: "does not apply" },
				{ id: "b", question: "选一个", options: ["B"], multiple: "n.a." },
				{ id: "c", question: "选一个", options: ["C"], multiple: "单项" },
				{ id: "d", question: "选一个", options: ["D"], multiple: "禁止" },
				{ id: "e", question: "填一句", multiline: "does not apply" },
			],
		});
		await promise;
		assert.deepEqual(
			envelope().questions.map((q) => q.type),
			["select", "select", "select", "select", "input"],
		);
	});
	const unknownKey = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "f", question: "选一个", options: ["A"], allowMultiple: "does not apply" }] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(unknownKey.result, "select");
});

test('短否定前缀不许误伤普通描述词：multiple: "normal" 仍是多选', async () => {
	// `OFF_PREFIXES` 里的 `no` / `off` 只有 2-3 个字符，裸 `startsWith` 会把 `normal` / `note` /
	// `official` / `offset` 判成「明确否定」→ 静默降级成单选 / 单行框，正是本分支要消灭的那一类。
	// 短词根现在必须自成一段（分隔符 / camelCase 边界）才算否定短语。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选哪些", options: ["A"], multiple: "normal" },
			{ id: "b", question: "选哪些", options: ["B"], multiple: "note" },
			{ id: "c", question: "选哪些", options: ["C"], multiple: "offset" },
			{ id: "d", question: "填一段", multiline: "official" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["multi_select", "multi_select", "multi_select", "editor"],
	);
});

test("双重否定（not single / no limit / non-exclusive）说的是「不是单选」，按多选渲染", async () => {
	// 否定前缀 + 单选 / 限制语义不是「关掉多选」，而是明确要求多选；关掉它就退回点一下即交卷的 select 卡。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选哪些", options: ["A"], multiple: "not single" },
			{ id: "b", question: "选哪些", options: ["B"], multiple: "no limit" },
			{ id: "c", question: "选哪些", options: ["C"], multiple: "non-exclusive" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["multi_select", "multi_select", "multi_select"],
	);
});

test("中文「不限」是不设限制，不许被「不」前缀关掉意图；原有否定短语仍生效", async () => {
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "贴日志", multiline: "不限" },
			{ id: "b", question: "贴日志", notes_multiline: true },
			{ id: "c", question: "选一个", options: ["A"], multiple: "not multiple" },
			{ id: "d", question: "选一个", options: ["B"], multiple: "no multiple" },
			{ id: "e", question: "填一句", multiline: "single line only" },
			{ id: "f", question: "选一个", options: ["C"], multiple: "非多选" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["editor", "editor", "select", "select", "input", "select"],
	);
});

test("双重否定不许限死「否定词排首位」：前面多写一个词仍按多选 / 多行渲染", async () => {
	// `isOffToken` 原来只在 parts[0] 是否定词时查双重否定：`"definitely not single"` /
	// `"yes, not single"` 的否定词排在后面，直接落到 parts.some 被判成「关掉意图」——
	// 模型明确写了「不是单选」，却静默拿到 select 卡（点一下即交卷）或单行 input。
	// editor 侧共用同一条判据，一起兜住；后面三题是回归护栏：否定词后面没写单选 / 限制的仍要关掉意图。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选哪些", options: ["A"], multiple: "definitely not single" },
			{ id: "b", question: "选哪些", options: ["B"], multiple: "yes, not single" },
			{ id: "c", question: "选哪些", options: ["C"], multiple: "allow multiple, not single" },
			{ id: "d", question: "贴日志", multiline: "definitely not single line" },
			{ id: "e", question: "选一个", options: ["D"], multiple: "no multiple" },
			{ id: "f", question: "选一个", options: ["E"], multiple: "does not apply" },
			{ id: "g", question: "填一句", multiline: "single line only" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["multi_select", "multi_select", "multi_select", "editor", "select", "select", "input"],
	);
});

test("短否定词根与多选词根连写（notmultiple / nomultiple / offmultiple）与 camelCase 同判", async () => {
	// `isOffToken` 的第 2 道判据要切词（分隔符 / camelCase），第 3 道又因短根长度 < 4 跳过前缀收口，
	// 于是「全小写连写」两头落空：`type: "notMultiple"` 判忽略、`type: "notmultiple"` 却翻成 multi_select
	// 并建议模型改成多选；`notMultiple: true` 只 warn、`notmultiple: true` 直接整批硬报错。
	// 同一语义只差一个大写字母就得出相反判决，正是本分支要消灭的那类不对称。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiple: "notmultiple" },
			{ id: "b", question: "选一个", options: ["B"], notmultiple: true },
			{ id: "c", question: "选一个", options: ["C"], nonmultiple: true },
			{ id: "d", question: "填一句", nomultiline: true },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select", "select", "input"],
	);

	const topLevel = await captureWarnings(() => runBatch(tool, { question: "选哪些", options: ["A"], type: "notmultiple" }).promise.then(() => null));
	assert.equal(topLevel.warnings.length, 1);
	assert.match(topLevel.warnings[0], /已忽略，实际按 select 处理/);
	assert.doesNotMatch(topLevel.warnings[0], /已按 multi_select 处理/);

	// 反向护栏：短根后面不是多选词根的普通描述词照样按多选 / 多行处理。
	const positive = runBatch(tool, {
		questions: [
			{ id: "a", question: "选哪些", options: ["A"], multiple: "normal" },
			{ id: "b", question: "选哪些", options: ["B"], multiple: "offshore" },
			{ id: "c", question: "填一段", multiline: "official" },
		],
	});
	const positiveResult = await positive.promise;
	assert.deepEqual(
		positive.envelope().questions.map((q) => q.type),
		["multi_select", "multi_select", "editor"],
	);
	assert.doesNotMatch(positiveResult.content[0].text, /必须提供 options/);
});

test("单选词带标点（single. / 单选。 / one,）仍是单选，不许翻成多选卡", async () => {
	// `SINGLE_WORDS` 是整串精确匹配，而 `isOffToken` 用的是去标点的归一：`"single."` / `"单选。"`
	// 两边都查不到「单选」，fail-open 判成「已表达多选意图」——写单选加一个句号就静默变勾选卡。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiple: "single." },
			{ id: "b", question: "选一个", options: ["B"], multiple: "单选。" },
			{ id: "c", question: "选一个", options: ["C"], multiple: "one," },
			{ id: "d", question: "选一个", options: ["D"], multiple: "exclusive;" },
			{ id: "e", question: "选一个", options: ["E"], multiple: "单项。" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select", "select", "select", "select"],
	);

	const topLevel = await captureWarnings(() => runBatch(tool, { questions: [{ question: "选哪些", options: ["A"], type: "singleChoice." }] }).promise.then((result) => result.content[0].text));
	assert.match(topLevel.warnings[0], /实际按 select 处理/);
	assert.doesNotMatch(topLevel.warnings[0], /已按 multi_select 处理/);
});

test("中文双重否定与「不限 + 后缀」按肯定处理：与英文孪生写法同判", async () => {
	// 中文连写没有分隔符可切，`parts.length === 1`，英文那道双重否定判据到不了；
	// `NOT_OFF` 只列 4 个精确串也挡不住「不限 + 后缀说明」。结果中英文同义写法结论相反：
	// `"非单选"` 被「非」前缀判成关掉 → select（点一下即交卷）、`"不限行数"` 被「不」前缀判成关掉 → 单行框。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选哪些", options: ["A"], multiple: "非单选" },
			{ id: "b", question: "选哪些", options: ["B"], multiple: "不是单选" },
			{ id: "c", question: "贴日志", multiline: "不是单行" },
			{ id: "d", question: "贴日志", multiline: "不限行数" },
			{ id: "e", question: "贴日志", multiline: "无限量" },
			{ id: "f", question: "选哪些", options: ["C"], multiple: "不限量多选" },
			{ id: "g", question: "选一个", options: ["D"], multiple: "非多选" },
			{ id: "h", question: "填一句", multiline: "不是多行" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["multi_select", "multi_select", "editor", "editor", "editor", "multi_select", "select", "input"],
	);
});

test("中文 exclusive 孪生写法（非互斥 / 非排他 / 不是单一）与 non-exclusive 同判", async () => {
	// 英文 `NEGATED_SINGLE` 含 `exclusive`（`non-exclusive` → 多选已钉住），中文词表只列了
	// 单选 / 单项 / 单行 / 限制 / 唯一 / 一个，`非互斥` / `非排他` / `不是单一` 于是落到中文否定字前缀
	// 被判成「关掉意图」→ select（点一下即交卷）。同一语义的两种写法必须同判。
	// 反向护栏：`单一` 本身是单选语义；「不要只说一句」含 `只` 但那是说明不是基数，仍按否义处理。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选哪些", options: ["A"], multiple: "非互斥" },
			{ id: "b", question: "选哪些", options: ["B"], multiple: "非排他" },
			{ id: "c", question: "选哪些", options: ["C"], multiple: "不是单一" },
			{ id: "d", question: "选一个", options: ["D"], multiple: "单一" },
			{ id: "e", question: "选一个", options: ["E"], multiple: "不要只说一句" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["multi_select", "multi_select", "multi_select", "select", "select"],
	);
});

test("否定词根带后缀一律关掉意图：OFF_PREFIXES 与 OFF_WORDS 不许漂移", async () => {
	// `OFF_WORDS` 里收了「禁止」，前缀表却漏了它：`multiple: "禁止多选"` 被 fail-open 判成肯定 →
	// 勾选卡（对照「禁用多选」是 select）；未知键更会把整批提问硬报错。`none…` 同属漏掉的 4 字符根。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiple: "禁止多选" },
			{ id: "b", question: "选一个", options: ["B"], multiple: "禁用多选" },
			{ id: "c", question: "选一个", options: ["C"], multiple: "非多选" },
			{ id: "d", question: "选一个", options: ["D"], multiple: "nonemultiple" },
			{ id: "e", question: "填一句", multiline: "禁止多行" },
			{ id: "f", question: "选哪些", options: ["F"], multiple: "normal" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select", "select", "select", "input", "multi_select"],
	);

	const unknown = await captureWarnings(async () => {
		const { promise: p, envelope: e } = runBatch(tool, { questions: [{ id: "g", question: "选一个", options: ["G"], allowMultiple: "禁止多选" }] });
		await p;
		return e().questions[0].type;
	});
	assert.equal(unknown.result, "select");
	assert.match(unknown.warnings.join("\n"), /忽略未知字段 "allowMultiple"/);
});

test("单选词根判据必须整串匹配：肯定多值短语不许被翻成单选卡", async () => {
	// SINGLE_LIKE_KEY 未锚定时，`"not one option"` 归一成 `notoneoption`，里面的子串 `oneoption`
	// 命中单选判据 → 明确要求多选的取值静默落成 select（点一下即交卷），键名 / type 取值两个空间同病。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选哪些", options: ["A"], multiple: "not one option" },
			{ id: "b", question: "选哪些", options: ["B"], multiple: "more than one option" },
			{ id: "c", question: "选一个", options: ["C"], multiple: "single choice" },
			{ id: "d", question: "选一个", options: ["D"], multiple: "one option" },
			{ id: "e", question: "选一个", options: ["E"], multiple: "only one option" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["multi_select", "multi_select", "select", "select", "select"],
	);

	const alias = await captureWarnings(() => {
		const { promise: p, envelope: e } = runBatch(tool, { type: "multipleOneOption", question: "选哪些", options: ["A", "B"] });
		return p.then(() => e().questions[0].type);
	});
	assert.equal(alias.result, "multi_select");
	await captureWarnings(() => assert.rejects(runBatch(tool, { questions: [{ question: "选哪些", options: ["A"], multipleOneOption: true }] }).promise, /多选必须写 type: "multi_select"/));
});

test("中文肯定形单选词与双重否定词表对齐（互斥 / 排他 / 唯一 / 一个 / 限制）", async () => {
	// `NEGATED_SINGLE_ZH` 补了 `互斥|排他|唯一|一个|限制`，肯定形却没进 SINGLE_WORDS：
	// `multiple: "互斥"` 翻成多选卡，而英文孪生词 exclusive 与 `type: "互斥"` 都是 select。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiple: "互斥" },
			{ id: "b", question: "选一个", options: ["B"], multiple: "排他" },
			{ id: "c", question: "选一个", options: ["C"], multiple: "唯一" },
			{ id: "d", question: "选一个", options: ["D"], multiple: "一个" },
			{ id: "e", question: "选一个", options: ["E"], multiple: "限制" },
			{ id: "f", question: "选一个", options: ["F"], multiple: "exclusive" },
			{ id: "g", question: "选哪些", options: ["G"], multiple: "非互斥" },
			{ id: "h", question: "选哪些", options: ["H"], multiple: "非排他" },
			{ id: "i", question: "选哪些", options: ["I"], multiple: "不限制" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select", "select", "select", "select", "select", "multi_select", "multi_select", "multi_select"],
	);

	const alias = await captureWarnings(() => {
		const { promise: p, envelope: e } = runBatch(tool, { type: "互斥", question: "选一个", options: ["A", "B"] });
		return p.then(() => e().questions[0].type);
	});
	assert.equal(alias.result, "select");
});

test("句读把否定与单选分开时不许折成中文双重否定", async () => {
	// `normalizeOffToken` 抹掉全角逗号后 `"不，单选"` 变成 `"不单选"`，被双重否定判据升成多选；
	// 同义的 `"否，单选"` 却按否定处理。双重否定必须在保留句读的原值上判。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiple: "不，单选" },
			{ id: "b", question: "选一个", options: ["B"], multiple: "否，单选" },
			{ id: "c", question: "填一句", multiline: "不，单行" },
			{ id: "d", question: "选哪些", options: ["D"], multiple: "不是单选" },
			{ id: "e", question: "贴日志", multiline: "不限行数" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select", "input", "multi_select", "editor"],
	);
});

test("句尾否定词仍关掉意图；单行笔误（on line）不折成多行框", async () => {
	// 归一后的分隔符集合与切词不一致时，`"no, thanks"` / `"on line"` 这类写法会落空。
	// 句尾否定词（`"why not"` / `"of course not"` / `"please no"`）**保持关掉意图**：它们后面没接
	// 多选词根，误判成肯定的代价是整批提问被拼错键报错打回，比少判一个修辞性肯定严重得多。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "填一句", multiline: "on line" },
			{ id: "b", question: "填一句", multiline: "one line" },
			{ id: "c", question: "选一个", options: ["C"], multiple: "not multiple" },
			{ id: "d", question: "选一个", options: ["D"], multiple: "why not" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["input", "input", "select", "select"],
	);
});

test("句尾明确否定不许翻成多选，也不许把整批提问报错打回", async () => {
	// `"of course not"` / `"please no"` 的否定词在句尾：关掉意图后，未知多选样键只留一条「忽略未知字段」；
	// 若判成肯定，`allowMultiple` 会走 isMisreadMultiKey 抛错，用户一张卡也看不到。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiple: "of course not" },
			{ id: "b", question: "选一个", options: ["B"], multiple: "definitely not" },
			{ id: "c", question: "填一句", multiline: "please no" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select", "input"],
	);

	const { warnings, result } = await captureWarnings(async () => {
		const { promise: p, envelope: e } = runBatch(tool, { questions: [{ id: "d", question: "选一个", options: ["D"], allowMultiple: "of course not" }] });
		await p;
		return e().questions[0].type;
	});
	assert.equal(result, "select");
	assert.match(warnings.join("\n"), /忽略未知字段 "allowMultiple"/);
});

test("中文双重否定的分隔符变体与单选词的 only 后缀仍按老语义", async () => {
	// 归一判据必须在抹掉全部分隔符的 offToken 上判：`"不是 单选"` / `"非、互斥"` / `"不 限行数"`
	// 与连写孪生同判；只有「单个否定字 + 句读」（`"不，单选"`）才是分句，按否定处理。
	// 锚定 SINGLE_LIKE_KEY 后 `"one option only"` / `"exclusive pick only"` 仍是单选。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选哪些", options: ["A"], multiple: "不是 单选" },
			{ id: "b", question: "选哪些", options: ["B"], multiple: "非、互斥" },
			{ id: "c", question: "贴日志", multiline: "不 限行数" },
			{ id: "d", question: "选一个", options: ["D"], multiple: "one option only" },
			{ id: "e", question: "选一个", options: ["E"], multiple: "exclusive pick only" },
			{ id: "f", question: "选一个", options: ["F"], multiple: "single choice only" },
			{ id: "g", question: "选哪些", options: ["G"], multiple: "not one option" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["multi_select", "multi_select", "editor", "select", "select", "select", "multi_select"],
	);
});

test("带标点的否定短语不许被词边界判据漏判", async () => {
	// `normalizeOffToken` 会去掉逗号，切词却仍把 `"no,"` 当成一个整词：短根 `no` 落不进
	// 「独立否定词」分支，长根前缀又因长度 < 4 跳过，`"no, thanks"` 于是被当成肯定 → 多选卡 / 多行框。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiple: "no, thanks" },
			{ id: "b", question: "填一句", multiline: "off, please" },
			{ id: "c", question: "选哪些", options: ["C"], multiple: "yes, multiple" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "input", "multi_select"],
	);
});

test("孤立数量词不是「不是单选」：only / no one / no, only one 仍是单选", async () => {
	// 意图键改成 fail-open 后，否定词后面出现 one / only 会被当成「不是单选」的双重否定，
	// 明确写「只要一个」的题于是静默翻成 multi_select；基线里这些键被忽略，本来是 select。
	// 只有后接选择语义词（not one option）才是「不是一个选项」＝多选要求。四个入口同判。
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [
			{ id: "a", question: "选一个", options: ["A"], multiple: "only" },
			{ id: "b", question: "选一个", options: ["B"], multiple: "ONLY" },
			{ id: "c", question: "选一个", options: ["C"], multiple: "only," },
			{ id: "d", question: "选一个", options: ["D"], multiple: "no one" },
			{ id: "e", question: "选一个", options: ["E"], multiple: "no, only one" },
			{ id: "f", question: "选一个", options: ["F"], allowMultiple: "only" },
			{ id: "g", question: "填一句", multiline: "no one" },
			{ id: "h", question: "选哪些", options: ["H"], multiple: "not one option" },
		],
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		["select", "select", "select", "select", "select", "select", "input", "multi_select"],
	);
});

test("只带 multi 前缀的描述性字段不是多选意图：不整批抛错，也不翻掉显式 select", async () => {
	const tool = registerTool();
	await captureWarnings(async () => {
		for (const key of ["multiStepHint", "multimediaHint", "multiTenantNote"]) {
			assert.equal(await resolvedType(tool, { questions: [{ question: "选哪个？", options: ["A", "B"], [key]: "先看 A 再决定" }] }), "select", `${key} 不该被升级或抛错`);
		}
		assert.equal(await resolvedType(tool, { questions: [{ question: "选哪个？", options: ["A", "B"], type: "select", multiStepHint: "先看 A 再决定" }] }), "select", '显式 type: "select" 不许被描述字段翻成 multi_select');
		assert.equal(await resolvedType(tool, { questions: [{ question: "选哪些？", options: ["A", "B"], checkbox: true }] }), "THROW", "真正的多选拼写仍要提示改 type");
	});
	const { warnings } = await captureWarnings(() => resolvedType(tool, { questions: [{ question: "选哪个？", options: ["A", "B"], multiStepHint: "先看 A 再决定" }] }));
	assert.match(warnings.join("\n"), /忽略未知字段 "multiStepHint"/);
});

test("multi + line + 选择语义的拼写仍按多选（描述性收紧不许误伤）", async () => {
	const tool = registerTool();
	await captureWarnings(async () => {
		for (const written of ["multiLineSelect", "multiLineChoices", "multiSelectLines", "multiChoiceLines"]) {
			assert.equal(await resolvedType(tool, { type: written, question: "选哪些？", options: ["A", "B"] }), "multi_select", `type: "${written}"`);
			assert.equal(await resolvedType(tool, { questions: [{ question: "选哪些？", options: ["A", "B"], [written]: true }] }), "THROW", `"${written}": true 仍要提示改 type`);
		}
	});
});

test("分句否定 + 单选词（no, single / off, single / 否，single）仍是单选，不许翻成多选或整批抛错", async () => {
	// `isOffToken` 原来只在中文否定字起头时认分句标点：`multiple: "no, single"` 的归一串
	// `nosingle` 命中「不是单选」的双重否定豁免，被判成肯定 → 带 options 的题静默翻成 multi_select
	// （自定义输入框消失、全程零 warn）；同一个取值写在未知键上还会把整批提问硬报错打回。
	// 「no, only one」/「不，单选」早已钉住这条语义，英文与中英混写必须同判。
	const tool = registerTool();
	for (const value of ["no, single", "off, single", "no, single choice", "否，single", "不, single"]) {
		const { promise, envelope } = runBatch(tool, {
			questions: [{ id: "q1", question: "只能选一个？", options: ["A", "B"], multiple: value }],
		});
		await promise;
		assert.equal(envelope().questions[0].type, "select", `multiple: "${value}" 应留在 select`);
		assert.equal(envelope().questions[0].allowOther, true, `multiple: "${value}" 的自定义输入框不许消失`);
		const { promise: unknownKey, envelope: unknownEnvelope } = runBatch(tool, {
			questions: [{ id: "q1", question: "只能选一个？", options: ["A", "B"], allowMultiple: value }],
		});
		await unknownKey;
		assert.equal(unknownEnvelope().questions[0].type, "select", `allowMultiple: "${value}" 不该整批抛错`);
	}
});

test("分句判据不许误伤没有分句标点的双重否定（not single / no limit / definitely not single 仍按多选）", async () => {
	const tool = registerTool();
	for (const value of ["not single", "no limit", "definitely not single", "yes, not single", "allow multiple, not single"]) {
		const { promise, envelope } = runBatch(tool, {
			questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], multiple: value }],
		});
		await promise;
		assert.equal(envelope().questions[0].type, "multi_select", `multiple: "${value}" 应是 multi_select`);
	}
});

/** 以给定的桌面端回包跑一次三题批量，返回工具结果。 */
async function runWithReply(reply) {
	const tool = registerTool();
	const ctx = { hasUI: true, ui: { input: async () => (typeof reply === "string" ? reply : JSON.stringify(reply)) } };
	return tool.execute(
		"call_1",
		{
			questions: [
				{ id: "a", question: "A?", options: ["x", "y"] },
				{ id: "b", question: "B?" },
				{ id: "c", question: "C?" },
			],
		},
		undefined,
		undefined,
		ctx,
	);
}

test("主动跳过的题算已处理：整卡不算取消，结果里明确标出跳过", async () => {
	const result = await runWithReply({
		answers: [
			{ id: "a", type: "select", value: "x" },
			{ id: "b", type: "input", value: null, skipped: true },
			{ id: "c", type: "input", value: "ok" },
		],
	});
	assert.equal(result.details.cancelled, false);
	assert.equal(result.details.closed, undefined);
	assert.equal(result.content[0].text, "a: x\nb: (用户跳过，未作答)\nc: ok");
});

test("答了一部分后关闭卡片：已答内容交回模型，未答的标出，不当成整单取消", async () => {
	const result = await runWithReply({
		cancelled: true,
		answers: [
			{ id: "a", type: "select", value: "y" },
			{ id: "b", type: "input", value: null },
			{ id: "c", type: "input", value: null },
		],
	});
	assert.equal(result.details.cancelled, false);
	assert.equal(result.details.closed, true);
	const text = result.content[0].text;
	assert.match(text, /关闭了提问卡/);
	assert.match(text, /a: y/);
	assert.match(text, /b: \(未作答\)/);
});

test("关闭时 confirm 答「否」照样算有效作答，不会被说成没答", async () => {
	const result = await runWithReply({
		cancelled: true,
		answers: [
			{ id: "a", type: "confirm", value: false },
			{ id: "b", type: "input", value: null },
		],
	});
	assert.equal(result.details.cancelled, false);
	assert.equal(result.details.closed, true);
	const text = result.content[0].text;
	assert.match(text, /a: 否/);
	assert.match(text, /「否」也是有效作答/);
	assert.match(text, /b: \(未作答\)/);
});

test("一题没答就关闭（含旧版桌面端的空回包）仍是取消", async () => {
	for (const reply of ["", { cancelled: true, answers: [{ id: "a", type: "select", value: null }] }]) {
		const result = await runWithReply(reply);
		assert.equal(result.details.cancelled, true);
		assert.equal(result.content[0].text, "用户取消了提问");
	}
});

test("写着「只能选一个」的取值是单选，不是多选意图（已知键 / 未知键 / type 取值三处同判）", async () => {
	// 取值侧的 fail-open（除否定词与单选词外一律算「已表达多选意图」）只认整串词表与「单/多选词根」，
	// 于是同一语义的**短语**写法漏在外面：`multiple: "只能选一个"` / `"exactly one"` / `"one answer"`
	// 被判成多选意图 → 静默升级成勾选卡（用户明明写的是单选，方向与本分支要消灭的那类正好相反），
	// 写在未知键上（`allowMultiple: "只能选一个"`）还会整批硬报错。三种写法走同一份判据，所以三处一起钉。
	const tool = registerTool();
	const phrases = [
		"只能选一个",
		"只能选择一个",
		"只能选一项",
		"只能选 1 个",
		"只能挑一个",
		"只选一个",
		"只允许选一个",
		"仅可选一个",
		"单选（只能选一个）",
		"exactly one",
		"exactly_one",
		"just one",
		"just_one",
		"at most one",
		"one answer",
		"one selection",
		"1 option",
		"one of the following",
		"one_of_the_following",
	];
	for (const value of phrases) {
		const known = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪个？", options: ["A", "B"], multiple: value }] });
			return promise.then(() => envelope().questions[0]);
		});
		assert.equal(known.result.type, "select", `multiple: ${JSON.stringify(value)} 应留在 select`);
		assert.equal(known.result.allowOther, true, `multiple: ${JSON.stringify(value)} 的自定义输入框不许消失`);
		// 同一取值写在未知键上：只留一条「忽略未知字段」，不许把整批提问打回。
		const unknown = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪个？", options: ["A", "B"], allowMultiple: value }] });
			return promise.then(() => envelope().questions[0].type);
		});
		assert.equal(unknown.result, "select", `allowMultiple: ${JSON.stringify(value)} 不该整批抛错`);
		assert.match(unknown.warnings.join("\n"), /忽略未知字段 "allowMultiple"/);
		// 同一拼写作为 type 取值交回形状推断（两处不许给出相反判决）。
		assert.equal(await resolvedType(tool, { questions: [{ id: "q1", question: "选哪个？", options: ["A", "B"], type: value }] }), "select", `type: ${JSON.stringify(value)} 应与键空间同判`);
	}

	// 反向护栏：短语判据锚定串首，否定词开头的仍是「不是单选」的双重否定（按多选，`not only one`
	// 这种不带名词的写法也算——它后面没接 option/choice，别只认带名词的那支），词根写的多选值
	// 也不许被这条短语判据顺手吃掉。
	const stillMulti = ["not only one", "not just one", "not only one option", "不是单选", "非互斥", "more than one option", "multiple selections", "many"];
	for (const value of stillMulti) {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], multiple: value }] });
		await promise;
		assert.equal(envelope().questions[0].type, "multi_select", `multiple: ${JSON.stringify(value)} 应仍是 multi_select`);
	}
});
