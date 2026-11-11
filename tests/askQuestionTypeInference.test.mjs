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
	assert.match(typeSchema.description, /多选必须写 type: "multi_select"（不要写 multi_select: true）/);
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
	assert.equal(result, "multi_select");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /type "multiSelect" 不是规范写法，已按 multi_select 处理/);
});

test("多选同族的 type 取值（multipleChoice / multi-choice / checklist）同样收口成 multi_select", async () => {
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
	const tool = registerTool();
	await assert.rejects(runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A"], choiceMode: "multiple" }] }).promise, /"choiceMode": "multiple"[\s\S]*type: "multi_select"/);
});

test('中文否定真值（multiple: "否"）不把单选翻成多选，且与多行意图键同判', async () => {
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
	const tool = registerTool();
	await assert.rejects(runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A"], multiSelectLines: true }] }).promise, /"multiSelectLines": true[\s\S]*type: "multi_select"/);
	await assert.rejects(runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A"], multiChoiceLines: true }] }).promise, /"multiChoiceLines": true[\s\S]*type: "multi_select"/);
});

test("明确表达单选的冗余键（singleChoice / exclusivePick）不报多选错误，也不连坐整批", async () => {
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
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { multipleLines: true, questions: [{ id: "a", question: "贴日志" }] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "input");
	assert.match(warnings.join("\n"), /顶层字段 忽略未知字段 "multipleLines"/);
});

test("multiline: true 与 options 同写不吞选项：按形状走 select，并留一条日志", async () => {
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
		const { promise } = runBatch(tool, { type: "grid", question: "选哪些？", options: ["A"], multi_select: true });
		await promise;
	});
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /实际按 multi_select 处理/);
});

test("意图键写在工具参数最外层：当作各题默认 type，不许静默降级成单选", async () => {
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
	assert.deepEqual(result, ["multi_select", "select"]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /已当作各题默认 type（multi_select/);
});

test("外层选择题意图只折叠到带 options 的题：无 options 的题退成 input，不能把整批打回", async () => {
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
	const tool = registerTool();
	for (const [outer, noOptionsType] of [
		["input", "input"],
		["editor", "editor"],
		["confirm", "input"],
	]) {
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
		assert.deepEqual(JSON.parse(JSON.stringify(result.map((q) => q.type))), ["select", noOptionsType], `外层 ${outer}`);
		assert.deepEqual(JSON.parse(JSON.stringify(result[0].options.map((o) => o.label))), ["A", "B"], `外层 ${outer}`);
		assert.equal(warnings.length, 1, `外层 ${outer}`);
	}
});

test("工具参数外层的 stray options 不许吃掉外层多行文本意图（那层的 options 已声明忽略）", async () => {
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "a", question: "贴代码" }], multiline: true, options: ["A"] });
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(JSON.parse(JSON.stringify(result)), ["editor"], "外层 multiline 要当默认 type");
	const joined = warnings.join("\n");
	assert.match(joined, /已当作各题默认 type（editor/, "日志要说明意图真的被采纳了");
	assert.doesNotMatch(joined, /没有可识别的 type \/ 意图键/, "意图明明在，不许说没有");
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

async function resolvedType(tool, params) {
	const { promise, envelope } = runBatch(tool, params);
	let res;
	try {
		res = await promise;
	} catch (error) {
		if (!/多选必须写 type: "multi_select"/.test(String(error?.message))) throw error;
		return "THROW";
	}
	const parsed = envelope();
	if (parsed) return parsed.questions[0].type;
	return res.content[0].text.includes("未执行") ? "NOENV" : "??";
}

test("同一拼写 × 两个空间同判（表驱动：key 与 type 取值不许各自得出相反结论）", async () => {
	const tool = registerTool();
	const rows = [
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
		for (const written of ["singleChoice", "exclusivePick", "single-choice"]) {
			assert.equal(await resolvedType(tool, { type: written, question: "选哪个", options: ["A", "B"] }), "select", `type: "${written}" 应是 select`);
		}
		for (const written of ["multiLineSelect", "multiSelectLines"]) {
			assert.equal(await resolvedType(tool, { type: written, question: "选哪些", options: ["A", "B"] }), "multi_select", `type: "${written}" 应是 multi_select`);
		}
	});
});

test("裸 choice / choices 作为 type 取值且无 options 时落到 input（不撞护栏）", async () => {
	const tool = registerTool();
	await captureWarnings(async () => {
		for (const written of ["choice", "choices"]) {
			assert.equal(await resolvedType(tool, { type: written, question: "说明一下" }), "input", `type: "${written}" 无 options 应是 input`);
		}
	});
});

test('意图键取值写着单选的分隔符/同义词变体（multiple: "single choice" / "select one"）不升级成多选', async () => {
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
	assert.equal(await resolvedType(tool, { type: "singleLine", question: "一句话结论" }), "input");
	assert.equal(await resolvedType(tool, { type: "one-line", question: "一句话结论" }), "input");
	const spaced = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "c", question: "选一个", options: ["A"], single__choice: true }] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(spaced.result, "select");
});

test("外层被折成默认 type 的拼错键不再被日志说成「已忽略」", async () => {
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
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "a", question: "选一个", options: ["A"] }], foo: 1 });
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["select"], "外层未知键不影响逐题渲染");
	const listed = warnings.join("\n").match(/字段只支持[^\n]*/)?.[0] ?? "";
	assert.match(listed, /questions/, "参数级自身字段要在清单里");
	assert.match(listed, /\btype\b/, "外层 type 真的生效，要在清单里");
	assert.match(listed, /multi_select/, "外层多选意图键要在清单里");
	assert.match(listed, /multiline/, "外层多行意图键要在清单里");
	for (const perQuestionOnly of ["question", "options", "placeholder", "prefill", "allowOther", "id"]) {
		assert.doesNotMatch(listed, new RegExp(`(?:^|[ /])${perQuestionOnly}(?:[ /]|$)`), `逐题字段 ${perQuestionOnly} 写在外层不生效，不许列进受支持清单`);
	}
});

test("外层已声明 type 且不会被多选意图升级时，拼错的多选键如实报「忽略」而不是「已当作默认 type」", async () => {
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
	const tool = registerTool();
	for (const intentKey of ["multiple", "multi_select", "multiSelect", "multiselect", "multi"]) {
		const { warnings, result } = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], type: "select", [intentKey]: true }] });
			return promise.then(() => envelope().questions[0].type);
		});
		assert.equal(result, "multi_select", `${intentKey}: true 应升级成 multi_select`);
		assert.match(warnings.join("\n"), /已按 multi_select 处理/, `${intentKey}: 升级要留一条排查线索`);
	}
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
		const joined = warnings.join("\n");
		assert.doesNotMatch(joined, /忽略未知字段/, `${key}: 被升级消费的键不许报「已忽略」`);
		assert.doesNotMatch(joined, /字段只支持[^\n]*checkbox|字段只支持[^\n]*selectMultiple|字段只支持[^\n]*allowMultiple/, `${key}: 不许把拼错键列进受支持字段`);
	}
	const known = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], type: "select", multiple: true, checkbox: true }] });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(known.result, "multi_select");
	assert.doesNotMatch(known.warnings.join("\n"), /忽略未知字段 "checkbox"/);
	for (const value of [false, 0, "no", "false", "single", "single choice"]) {
		const { result } = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪个？", options: ["A", "B"], type: "select", multiple: value }] });
			return promise.then(() => envelope().questions[0].type);
		});
		assert.equal(result, "select", `multiple: ${JSON.stringify(value)} 不是多选意图`);
	}
});

test("只有 select 会被多选意图升级：input / confirm / editor 仍按声明走（折成多选会撞 options 护栏）", async () => {
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
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], checkbox: true }], multi_select: true });
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(result, ["multi_select"]);
	await assert.rejects(() => runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], checkbox: true }], type: "select" }).promise, /多选必须写 type: "multi_select"/);
	await assert.rejects(() => runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", checkbox: true }], multi_select: true }).promise, /多选必须写 type: "multi_select"/);
	assert.match(warnings.join("\n"), /已当作各题默认 type（multi_select/, "外层 intent 仍要留排查线索");
});

test("只是含有 line 的词不算多行文本样（outline / deadline / inline 不许被静默折成 editor）", async () => {
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
	assert.equal((joined.match(/忽略未知字段/g) ?? []).length, 3);
	for (const written of ["outline", "deadline", "inline"]) {
		assert.equal(await resolvedType(tool, { type: written, question: "说两句" }), "input", `type: "${written}" 应与键空间同判`);
	}
});

test("外层多选意图把带 options 的题折成 multi_select 时，日志写最终形态而不是 select", async () => {
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
	const tool = registerTool();
	const { warnings, result } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, { type: "SELECT", question: "选哪些？", options: ["A", "B"], multiple: true });
		return promise.then(() => envelope().questions[0].type);
	});
	assert.equal(result, "multi_select");
	const joined = warnings.join("\n");
	assert.doesNotMatch(joined, /已按 select 处理/);
	assert.match(joined, /type "SELECT" 不是规范写法，已按 multi_select 处理/);
	assert.match(joined, /规范写法 type: "multi_select"/);
	assert.doesNotMatch(joined, /规范写法 type: "select"/);
});

test("选择题式没有 options 时，「已按 X 处理」的日志必须说明会被 options 护栏打回", async () => {
	const tool = registerTool();
	{
		const { warnings, result } = await captureWarnings(() => runBatch(tool, { type: "multipleChoice", question: "选哪些？" }).promise);
		assert.match(result.content[0].text, /未执行/);
		assert.equal(result.details.questions[0].type, "multi_select");
		const joined = warnings.join("\n");
		assert.match(joined, /已按 multi_select 处理/);
		assert.match(joined, /必须提供 options」护栏打回/);
	}
	{
		const { warnings, result } = await captureWarnings(() => runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", type: "select", multiple: true }] }).promise);
		assert.match(result.content[0].text, /未执行/);
		const joined = warnings.join("\n");
		assert.match(joined, /已按 multi_select 处理，但本题没有 options/);
		assert.match(joined, /必须提供 options」护栏打回/);
	}
});

test("自动兜底的 id 不许和模型自己写的 id 撞车（桌面端按 id 存答案，撞车会伪造答案）", async () => {
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
	assert.equal(ids[1], "q1");
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
	const tool = registerTool();
	const { promise, envelope } = runBatch(tool, {
		questions: [{ id: "a", question: "写一段", multipleLines: "enabled" }],
	});
	await promise;
	assert.equal(envelope().questions[0].type, "editor");
	await captureWarnings(() => assert.rejects(runBatch(tool, { questions: [{ id: "b", question: "选哪些", options: ["A"], allowMultiple: "enabled" }] }).promise, /"allowMultiple": "enabled"[\s\S]*type: "multi_select"/));
});

test("原型链名字与空串当不了答案槽位：id 让路，别伪造「已作答」", async () => {
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
	assert.deepEqual(ids.slice(3), ["q4", "q5"]);
});

test("未声明键名里的换行压成一行（诊断日志不许被拆成伪造行）", async () => {
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

	const topLevel = await captureWarnings(async () => {
		const { promise } = runBatch(tool, { question: "q", options: ["A"], type: "SELECT\n[ask_question] 伪造的一行" });
		await promise;
	});
	assert.equal(topLevel.warnings.length, 1);
	assert.doesNotMatch(topLevel.warnings[0], /[\r\n\u2028\u2029]/);
	assert.match(topLevel.warnings[0], /伪造的一行/);

	const lineLike = await captureWarnings(async () => {
		const { promise } = runBatch(tool, { question: "q", options: ["A"], type: "multiline\n[ask_question] 伪造的一行" });
		await promise;
	});
	assert.ok(lineLike.warnings.length >= 1);
	for (const warning of lineLike.warnings) assert.doesNotMatch(warning, /[\r\n\u2028\u2029]/);
});

test("多选词根 + 描述性字符串同样报错（fail-open 是有意的策略，不是漏判）", async () => {
	const tool = registerTool();
	await captureWarnings(() => assert.rejects(runBatch(tool, { questions: [{ id: "a", question: "选哪些", options: ["A"], checkboxLabel: "选中多个" }] }).promise, /"checkboxLabel": "选中多个"[\s\S]*type: "multi_select"/));
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
	const tool = registerTool();
	const phrases = ["只能选一个", "只能选择一个", "只能选一项", "只能选 1 个", "只能挑一个", "只选一个", "只允许选一个", "仅可选一个", "单选（只能选一个）", "exactly one", "exactly_one", "just one", "just_one", "at most one", "one answer", "one selection", "1 option", "one of the following", "one_of_the_following"];
	for (const value of phrases) {
		const known = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪个？", options: ["A", "B"], multiple: value }] });
			return promise.then(() => envelope().questions[0]);
		});
		assert.equal(known.result.type, "select", `multiple: ${JSON.stringify(value)} 应留在 select`);
		assert.equal(known.result.allowOther, true, `multiple: ${JSON.stringify(value)} 的自定义输入框不许消失`);
		const unknown = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪个？", options: ["A", "B"], allowMultiple: value }] });
			return promise.then(() => envelope().questions[0].type);
		});
		assert.equal(unknown.result, "select", `allowMultiple: ${JSON.stringify(value)} 不该整批抛错`);
		assert.match(unknown.warnings.join("\n"), /忽略未知字段 "allowMultiple"/);
		assert.equal(await resolvedType(tool, { questions: [{ id: "q1", question: "选哪个？", options: ["A", "B"], type: value }] }), "select", `type: ${JSON.stringify(value)} 应与键空间同判`);
	}

	const stillMulti = ["not only one", "not just one", "not only one option", "不是单选", "非互斥", "more than one option", "multiple selections", "many"];
	for (const value of stillMulti) {
		const { promise, envelope } = runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A", "B"], multiple: value }] });
		await promise;
		assert.equal(envelope().questions[0].type, "multi_select", `multiple: ${JSON.stringify(value)} 应仍是 multi_select`);
	}
});

test('外层 `type: "confirm"` 不折叠到无 options 的题：那是二值卡，不是文本档', async () => {
	const tool = registerTool();
	const { result, warnings } = await captureWarnings(() => {
		const { promise, envelope } = runBatch(tool, {
			questions: [
				{ id: "a", question: "你的名字？" },
				{ id: "b", question: "确认删除？", type: "confirm" },
			],
			type: "confirm",
		});
		return promise.then(() => envelope().questions.map((q) => q.type));
	});
	assert.deepEqual(JSON.parse(JSON.stringify(result)), ["input", "confirm"], "外层 confirm 只该对本题自己声明的 confirm 生效");
	const joined = warnings.join("\n");
	assert.match(joined, /只对本题自己也声明 confirm 的题生效/);
	assert.doesNotMatch(joined, /已当作各题默认 type（confirm/);
});

test("飞书 / headless 里日志不假装「已渲染」：这两个分支一张卡都不出，也走不到 options 护栏", async () => {
	const probes = ["headless", "headless 的 ctx 缺失", "飞书会话"];
	for (const label of probes) {
		const previous = process.env.PIDECK_FEISHU_LINKED;
		const feishu = label === "飞书会话";
		if (feishu) process.env.PIDECK_FEISHU_LINKED = "1";
		try {
			let tool;
			registerAskQuestion({
				registerTool: (t) => {
					tool = t;
				},
			});
			const ctx = feishu ? { hasUI: true, ui: { input: async () => "" } } : label === "headless" ? { hasUI: false, ui: { input: async () => "" } } : undefined;
			const { warnings } = await captureWarnings(async () => {
				await tool.execute("c1", { questions: [{ id: "q1", question: "选哪些？", options: ["A"], multiline: true }] }, undefined, undefined, ctx);
				await tool.execute("c2", { type: "multipleChoice", question: "选哪些？" }, undefined, undefined, ctx);
				await tool.execute("c3", { type: "input", question: "名字？", multiple: true }, undefined, undefined, ctx);
			});
			const joined = warnings.join("\n");
			assert.match(joined, /已按 select 处理/, `${label}: 仍要留最终形态的线索`);
			assert.match(joined, /已按 multi_select 处理/, `${label}: 别名同样要收口到最终 type`);
			assert.match(joined, /本题按 input 处理/, `${label}: 被忽略的多选意图键同样要收口到最终 type`);
			assert.doesNotMatch(joined, /已按 select 渲染|已按 multi_select 渲染|按 input 渲染/, `${label}: 不许声称渲染`);
			assert.doesNotMatch(joined, /护栏打回|撞 execute 的「必须提供 options」护栏/, `${label}: 这两个分支走不到护栏，别声称会被打回`);
		} finally {
			if (previous === undefined) delete process.env.PIDECK_FEISHU_LINKED;
			else process.env.PIDECK_FEISHU_LINKED = previous;
		}
	}
	const tool = registerTool();
	const { warnings } = await captureWarnings(async () => {
		await runBatch(tool, { questions: [{ id: "q1", question: "选哪些？", options: ["A"], multiline: true }] }).promise;
		await runBatch(tool, { type: "input", question: "名字？", multiple: true }).promise;
	});
	const joined = warnings.join("\n");
	assert.match(joined, /已按 select 渲染/);
	assert.match(joined, /本题按 input 渲染：没有 options，折成多选会撞 execute 的「必须提供 options」护栏/);
});

test("分句否定的后半句写着多选词根时按多选：`no, multiple` 与 `no, single` 同一套口径", async () => {
	const tool = registerTool();
	const cases = [
		["no, multiple", "multi_select"],
		["否，multiple", "multi_select"],
		["no, checkbox", "multi_select"],
		["no, single", "select"],
		["off, single", "select"],
		["no, thanks", "select"],
		["no, not multiple", "select"],
		["否，not multiple", "select"],
		["单选或多选都行", "multi_select"],
		["单选，不要多选", "select"],
		["no, multiple lines", "select"],
		["否，multiline", "select"],
		["notmultiple", "select"],
	];
	const { promise, envelope } = runBatch(tool, {
		questions: cases.map(([value], index) => ({ id: `c${index}`, question: "选哪些？", options: ["A", "B"], multiple: value })),
	});
	await promise;
	assert.deepEqual(
		envelope().questions.map((q) => q.type),
		cases.map(([, expected]) => expected),
	);
});

test("choice 词根键 + 多行文本取值不许整批硬报错，也不许翻成多选卡", async () => {
	const tool = registerTool();
	for (const written of ["multiline", "multiLine", "multipleLines", "multiple lines"]) {
		const { result, warnings } = await captureWarnings(() => {
			const { promise, envelope } = runBatch(tool, {
				questions: [{ id: "q1", question: "补充说明", options: ["A", "B"], choiceMode: written }],
			});
			return promise.then(() => envelope().questions[0].type);
		});
		assert.equal(result, "select", `choiceMode: ${JSON.stringify(written)} 不该被当成多选拼错`);
		const joined = warnings.join("\n");
		assert.match(joined, /忽略未知字段 "choiceMode"/);
		assert.doesNotMatch(joined, /多选必须写 type: "multi_select"/);
	}
});

test("「只许/只要/至多/最多…选一个」族短语仍是单选（已知键 / 未知键 / type 取值三处同判）", async () => {
	const tool = registerTool();
	const phrases = [
		"只许选一个",
		"只要选一个",
		"只得选一个",
		"只让选一个",
		"仅许选一个",
		"仅准选一个",
		"仅要选一个",
		"只许选一项",
		"只允许挑选一个",
		"只准挑选一个",
		"只许一",
		"只准一",
		"仅一",
		"只一",
		"只要一",
		"只能一",
		"至多选一个",
		"最多选一个",
		"最多只能选一个",
		"只能单选",
		"one only",
		"single only",
		"only a single one",
		"only a single answer",
		"up to one",
		"maximum of one",
	];
	await captureWarnings(async () => {
		for (const value of phrases) {
			assert.equal(await resolvedType(tool, { questions: [{ question: "选哪个？", options: ["A", "B"], multiple: value }] }), "select", `multiple: ${JSON.stringify(value)}`);
			assert.equal(await resolvedType(tool, { questions: [{ question: "选哪个？", options: ["A", "B"], allowMultiple: value }] }), "select", `allowMultiple: ${JSON.stringify(value)}`);
			assert.equal(await resolvedType(tool, { questions: [{ question: "选哪个？", options: ["A", "B"], type: value }] }), "select", `type: ${JSON.stringify(value)}`);
		}
	});
});

test("单选短语判据不许吃掉「可多选」「一个以上」与「选两个」的取值", async () => {
	const tool = registerTool();
	const stillMulti = ["只能选两个", "只能选俩", "只要选一个以上", "至多选一个以上", "只许选一个以上", "只要选 1 个以上", "只能选 1 个以上", "只能选 1 项以上", "只要选一个以上，不限数量", "not only one option", "不是单选", "more than one option", "multiple selections", "many"];
	await captureWarnings(async () => {
		for (const value of stillMulti) {
			assert.equal(await resolvedType(tool, { questions: [{ question: "选哪些？", options: ["A", "B"], multiple: value }] }), "multi_select", `multiple: ${JSON.stringify(value)}`);
		}
	});
});

test("「多个 + 名词」只是描述选项数量，不许把单选短语翻成多选或整批报错", async () => {
	const tool = registerTool();
	const phrases = ["单选，多个选项", "只能选一个（有多个选项）", "单选，多个候选答案", "单选，多个备选项", "只能选一个（有多个备选）", "单选，多个可选项", "单选，多个 选项", "只能选一个，一个以上会被拒"];
	await captureWarnings(async () => {
		for (const value of phrases) {
			assert.equal(await resolvedType(tool, { questions: [{ question: "选哪个？", options: ["A", "B"], multiple: value }] }), "select", `multiple: ${JSON.stringify(value)}`);
			assert.equal(await resolvedType(tool, { questions: [{ question: "选哪个？", options: ["A", "B"], allowMultiple: value }] }), "select", `allowMultiple: ${JSON.stringify(value)}`);
			assert.equal(await resolvedType(tool, { questions: [{ question: "选哪个？", options: ["A", "B"], type: value }] }), "select", `type: ${JSON.stringify(value)}`);
		}
	});
});

test("type 取值侧的短语判据有判别力（含多选词根时不会被静默升级成 multi_select）", async () => {
	const tool = registerTool();
	await captureWarnings(async () => {
		for (const value of ["only a single multiple", "up to one multiple", "maximum of one multiple"]) {
			assert.equal(await resolvedType(tool, { questions: [{ question: "选哪个？", options: ["A", "B"], type: value }] }), "select", `type: ${JSON.stringify(value)}`);
		}
	});
});

test("多选判据复查：单选文案、词序、分句双重否定与 online 前缀不许翻转题型", async () => {
	const tool = registerTool();
	const pick = (extra) => ({ question: "选哪些？", options: ["A", "B"], ...extra });
	await captureWarnings(async () => {
		assert.equal(await resolvedType(tool, { questions: [pick({ checkboxLabel: "Select one option" })] }), "select");
		assert.equal(await resolvedType(tool, { questions: [pick({ type: "select", checkboxLabel: "Select one option" })] }), "select");
		for (const value of ["single or multiple", "multiple or single", "online multiple", "offline multiple"]) {
			assert.equal(await resolvedType(tool, { questions: [pick({ multiple: value })] }), "multi_select", `multiple: ${value}`);
		}
		for (const value of ["online", "online.", "online,", "onLine"]) {
			assert.equal(await resolvedType(tool, { questions: [pick({ multiple: value })] }), "select", `multiple: ${value}`);
		}
		assert.equal(await resolvedType(tool, { questions: [pick({ multiple: "单选，多选会报错" })] }), "select");
		for (const value of ["单选或多选都行", "单选/多选", "单选，可多选", "单选,允许多选"]) {
			assert.equal(await resolvedType(tool, { questions: [pick({ multiple: value })] }), "multi_select", `multiple: ${value}`);
		}
		for (const value of ["not single", "no, not single", "不是单选", "不，不是单选"]) {
			assert.equal(await resolvedType(tool, { questions: [pick({ multiple: value })] }), "multi_select", `multiple: ${value}`);
		}
		assert.equal(await resolvedType(tool, { questions: [pick({ checkboxLabel: "选中多个" })] }), "THROW");
	});
});
