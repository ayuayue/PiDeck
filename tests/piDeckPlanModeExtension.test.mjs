import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// pi-deck-plan-mode.ts 只使用 type import（编译后消失），无运行时依赖，
// 空沙箱即可加载；行为通过扩展注册的 handler 与注入的 pi api 替身断言。
const extensionPath = "resources/extensions/pi-deck-plan-mode.ts";
const selfPath = "C:/PiDeck/resources/extensions/pi-deck-plan-mode.ts";

function compileExtension() {
	const source = readFileSync(extensionPath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: extensionPath,
	}).outputText;
	const module2 = { exports: {} };
	const localRequire = (specifier) => {
		throw new Error(`pi-deck-plan-mode must stay dependency-free, got require("${specifier}")`);
	};
	vm.runInNewContext(
		output,
		{
			module: module2,
			exports: module2.exports,
			require: localRequire,
			__filename: selfPath,
			console,
		},
		{ filename: extensionPath },
	);
	return module2.exports.default;
}

/**
 * 构造扩展运行沙箱：
 * - api 替身记录工具开关/消息注入/持久化条目；
 * - context 替身记录通知与 widget，ui.select 可编程（模拟选单点击/关闭）。
 */
function createHarness() {
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const widgets = new Map();
	const appendedEntries = [];
	const sentMessages = [];
	const toolSwitches = [];
	let activeTools = ["read", "bash", "edit", "write", "ask_question"];
	let selectResponses = [];

	const api = {
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names) {
			toolSwitches.push([...names]);
			activeTools = [...names];
		},
		appendEntry(customType, data) {
			appendedEntries.push({ type: "custom", customType, data });
		},
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		sendMessage(message, options) {
			sentMessages.push({ message, options });
		},
	};

	const context = {
		hasUI: true,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setWidget(key, lines) {
				if (lines?.length) widgets.set(key, [...lines]);
				else widgets.delete(key);
			},
			select(title, options) {
				return selectResponses.length > 0 ? selectResponses.shift() : undefined;
			},
		},
		sessionManager: {
			getEntries() {
				return [...appendedEntries];
			},
		},
	};

	const extension = compileExtension();
	extension(api);

	return {
		handlers,
		commands,
		notifications,
		widgets,
		appendedEntries,
		sentMessages,
		toolSwitches,
		context,
		getActiveTools: () => [...activeTools],
		/** 模拟第三方扩展在 plan 期间异步注册工具：注册即进入活跃集合。 */
		registerThirdPartyTool(name) {
			if (!activeTools.includes(name)) activeTools.push(name);
		},
		/** 预设下一次 ui.select 的返回值（模拟点击选项；undefined = 关闭选单）。 */
		queueSelectResponse(value) {
			selectResponses.push(value);
		},
		/** 预置历史条目：模拟从会话文件恢复（sessionManager.getEntries 的输入）。 */
		seedEntries(entries) {
			appendedEntries.push(...entries);
		},
		async runCommand(name, args) {
			const command = commands.get(name);
			assert.ok(command, `command ${name} not registered`);
			await command.handler(args, context);
		},
		async runInput(text) {
			return handlers.get("input")({ text }, context);
		},
		async runBeforeAgentStart(event = {}) {
			return handlers.get("before_agent_start")(event, context);
		},
		async runToolCall(toolName, input) {
			return handlers.get("tool_call")({ toolName, input }, context);
		},
		async runAgentEnd(messages) {
			return handlers.get("agent_end")({ messages }, context);
		},
		async runTurnEnd(message) {
			return handlers.get("turn_end")({ message }, context);
		},
		async runSessionStart() {
			return handlers.get("session_start")({}, context);
		},
	};
}

function assistantMessage(text) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------

test("/plan command keeps plan mode active for the next normal message", async () => {
	const harness = createHarness();

	await harness.runCommand("plan", "");
	assert.ok(harness.notifications.some((n) => n.message.includes("已启用")));

	// 根因回归：/plan 激活后，下一条普通任务消息不得被当成退出信号。
	const inputResult = await harness.runInput("分析一下认证模块的改造方案");
	assert.equal(inputResult, undefined, "normal message must pass through untransformed");

	// 通知里不得出现「已禁用」；工具面仍处于只读集合（edit/write 不在列）。
	assert.equal(
		harness.notifications.some((n) => n.message.includes("已禁用")),
		false,
		"plan mode must not be disabled by the first normal message",
	);
	const tools = harness.getActiveTools();
	assert.equal(tools.includes("edit"), false);
	assert.equal(tools.includes("write"), false);

	// before_agent_start 注入只读计划上下文，模型才知道要产出 Plan:。
	const contextResult = await harness.runBeforeAgentStart();
	assert.ok(contextResult?.message?.content?.includes("[PLAN MODE ACTIVE]"));
});

test("before_agent_start 写系统提示 section，不再每轮复制模式文本（issue #365-09）", async () => {
	const harness = createHarness();
	await harness.runCommand("plan", "");

	const sections = { pi_deck_earlier: "keep me" };
	const result = await harness.runBeforeAgentStart({ systemPromptOptions: { sections } });

	// 有 sections 通道时不得返回每轮 message：旧写法会把同一段 Plan 文本写进历史一遍又一遍。
	assert.equal(result, undefined);
	assert.match(sections.pi_deck_plan_mode, /^\[PLAN MODE ACTIVE\]/);
	assert.ok(sections.pi_deck_plan_mode.includes("Plan:\n1. First concrete step"));
	assert.equal(sections.pi_deck_earlier, "keep me", "前序扩展写入的 section 必须保留");

	// 旧宿主（无 systemPromptOptions）仍走 message 回退，行为不变。
	const legacy = await harness.runBeforeAgentStart();
	assert.ok(legacy?.message?.content?.includes("[PLAN MODE ACTIVE]"));
});

test("/plan command still blocks non-read-only bash while active", async () => {
	const harness = createHarness();
	await harness.runCommand("plan", "");

	const blocked = await harness.runToolCall("bash", { command: "echo hacked > file.txt" });
	assert.ok(blocked?.block === true, "destructive bash must be blocked in plan mode");

	const allowed = await harness.runToolCall("bash", { command: "ls src/main" });
	assert.equal(allowed, undefined, "read-only bash must pass through");
});

test("composer chip activation still exits plan mode on the next unmarked message", async () => {
	const harness = createHarness();
	const marker = "__PI_DECK_PLAN_MODE__";

	// 桌面输入框计划 chip 发出带标记消息（agentMessage 前缀）。
	const markerResult = await harness.runInput(`${marker}\n分析认证模块`);
	assert.equal(markerResult?.action, "transform");
	assert.ok(markerResult.text.startsWith("分析认证模块"), "marker must be stripped before LLM");

	// composer 切回普通后的无标记消息：退出信号，plan 模式关闭。
	await harness.runInput("普通消息");
	assert.ok(
		harness.notifications.some((n) => n.message.includes("已禁用")),
		"unmarked message after chip activation must exit plan mode",
	);
	assert.deepEqual(harness.getActiveTools().sort(), ["ask_question", "bash", "edit", "read", "write"]);
});

test("/plan off explicitly disables command-activated plan mode", async () => {
	const harness = createHarness();
	await harness.runCommand("plan", "");
	await harness.runInput("任务消息");
	assert.equal(
		harness.notifications.some((n) => n.message.includes("已禁用")),
		false,
	);

	await harness.runCommand("plan", "off");
	assert.ok(harness.notifications.some((n) => n.message.includes("已禁用")));
	assert.deepEqual(harness.getActiveTools().sort(), ["ask_question", "bash", "edit", "read", "write"]);
});

test("closing the plan menu after command activation exits plan mode", async () => {
	const harness = createHarness();
	await harness.runCommand("plan", "");
	await harness.runInput("任务消息");

	// agent_end：模型产出带 Plan: 的回复 → 弹选单；关闭选单（undefined）= 退出 plan。
	harness.queueSelectResponse(undefined);
	await harness.runAgentEnd([assistantMessage("分析完成\n\nPlan:\n1. 读取现有实现\n2. 编写迁移脚本")]);
	assert.ok(
		harness.notifications.some((n) => n.message.includes("已禁用")),
		"closing the plan menu must exit plan mode",
	);
});

test("restore keeps third-party tools registered after plan activation", async () => {
	// issue #349：plan 激活早于第三方扩展异步注册时，旧快照全量覆盖会把后注册的工具整批删掉。
	const harness = createHarness();
	await harness.runCommand("plan", "");
	await harness.runInput("任务消息");
	// plan 期间第三方扩展（billion-context 压缩工具等）完成异步注册。
	harness.registerThirdPartyTool("compress");
	harness.registerThirdPartyTool("search_context");

	harness.queueSelectResponse("开始执行|恢复写权限，按步骤改代码并勾进度");
	await harness.runAgentEnd([assistantMessage("分析完成\n\nPlan:\n1. 读取现有实现\n2. 编写迁移脚本")]);

	const tools = harness.getActiveTools();
	assert.equal(tools.includes("edit"), true, "write tools must be restored on execute");
	assert.equal(tools.includes("write"), true);
	assert.equal(tools.includes("compress"), true, "tool registered during plan must survive restore");
	assert.equal(tools.includes("search_context"), true);
});

test("re-entering plan mode keeps tools registered after the first snapshot", async () => {
	// issue #349 镜像路径：enablePlanModeTools 若用旧快照重算，第二次进入 plan 时
	// 会把快照之后注册的第三方工具当场删掉（/plan on 后再发 composer 计划消息即命中）。
	const harness = createHarness();
	await harness.runCommand("plan", "");
	harness.registerThirdPartyTool("compress");

	await harness.runCommand("plan", "on");

	const tools = harness.getActiveTools();
	assert.equal(tools.includes("compress"), true, "tool registered after the first snapshot must survive re-entering plan");
	assert.equal(tools.includes("edit"), false, "plan mode must stay read-only");
	assert.equal(tools.includes("write"), false);
});

test("/plan off keeps third-party tools registered after plan activation", async () => {
	const harness = createHarness();
	await harness.runCommand("plan", "");
	harness.registerThirdPartyTool("acp_status");

	await harness.runCommand("plan", "off");

	const tools = harness.getActiveTools();
	assert.deepEqual(tools.sort(), ["acp_status", "ask_question", "bash", "edit", "read", "write"]);
});

test("choosing execute from the menu restores write tools and sends execution prompt", async () => {
	const harness = createHarness();
	await harness.runCommand("plan", "");
	await harness.runInput("任务消息");

	// 桌面端 select 回传的是 option 原文（含「标题|说明」编码，见 askUi.splitAskOption）。
	harness.queueSelectResponse("开始执行|恢复写权限，按步骤改代码并勾进度");
	await harness.runAgentEnd([assistantMessage("分析完成\n\nPlan:\n1. 读取现有实现\n2. 编写迁移脚本")]);

	const tools = harness.getActiveTools();
	assert.equal(tools.includes("edit"), true, "write tools must be restored on execute");
	assert.equal(tools.includes("write"), true);
	// 执行提示词经 sendMessage 注入（followUp + triggerTurn）。
	assert.ok(harness.sentMessages.some((m) => String(m.message?.content ?? "").includes("Execute the approved plan")));
});

// issue #393：计划待办面板没有清理出口——没走完执行流程的草案会永久挂在界面上。
test("session_start drops a non-executing plan draft instead of restoring it", async () => {
	const harness = createHarness();
	// 会话文件里残留的草案：规划态产出计划后没点「开始执行」，用户切回普通模式并关标签。
	harness.seedEntries([
		{
			type: "custom",
			customType: "pi-deck-plan-mode",
			data: {
				enabled: true,
				executing: false,
				todos: [
					{ step: 1, text: "读取现有实现", completed: false },
					{ step: 2, text: "编写迁移脚本", completed: false },
				],
			},
		},
	]);

	await harness.runSessionStart();

	// 面板不再被草案撑出来。
	assert.equal(harness.widgets.has("pi-deck-plan-todos"), false);
	await harness.runCommand("todos", "");
	assert.ok(harness.notifications.at(-1).message.includes("没有活跃的计划事项"));

	// 落盘收敛：写回的条目必须是空待办、非执行态，否则下次重开又会被读回来。
	const last = harness.appendedEntries.at(-1);
	assert.equal(last.customType, "pi-deck-plan-mode");
	// 条目在 vm 沙箱里创建，跨 realm 的数组不能用 deepEqual 比原型。
	assert.equal(last.data.todos.length, 0);
	assert.equal(last.data.executing, false);

	// 草案状态不得被当成执行态往上下文里注入执行指令。
	const started = await harness.runBeforeAgentStart();
	assert.equal(started, undefined);
});

test("session_start still restores an executing plan and keeps tracking [DONE:n]", async () => {
	const harness = createHarness();
	harness.seedEntries([
		{
			type: "custom",
			customType: "pi-deck-plan-mode",
			data: {
				enabled: false,
				executing: true,
				todos: [
					{ step: 1, text: "读取现有实现", completed: false },
					{ step: 2, text: "编写迁移脚本", completed: false },
				],
			},
		},
	]);

	await harness.runSessionStart();

	assert.equal(harness.widgets.get("pi-deck-plan-todos")?.[0], "计划进度 0/2");
	const started = await harness.runBeforeAgentStart();
	assert.ok(started?.message?.content?.includes("[EXECUTING PI_DECK PLAN]"));

	await harness.runTurnEnd(assistantMessage("第一步完成 [DONE:1]"));
	assert.equal(harness.widgets.get("pi-deck-plan-todos")?.[0], "计划进度 1/2");
});
