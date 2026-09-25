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

/** 断言 schema 层面已放行：items 的 required 不再包含 type。 */
test("QuestionSchema：type 不在批量 items 的 required 里（校验层不再硬失败）", () => {
	const tool = registerTool();
	const itemsRequired = JSON.parse(JSON.stringify(tool.parameters.properties.questions.items.required));
	assert.ok(!itemsRequired.includes("type"), `required 不应包含 type，实际: ${itemsRequired}`);
	assert.ok(itemsRequired.includes("id") && itemsRequired.includes("question"));
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
