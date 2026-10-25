import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// pi-deck-goal-mode.ts 只使用 type import（编译后消失），空沙箱即可加载；
// 行为通过扩展注册的 handler 与注入的 pi api 替身断言。
const extensionPath = "resources/extensions/pi-deck-goal-mode.ts";
const marker = "__PI_DECK_GOAL_MODE__";

function loadGoalExtension() {
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
	vm.runInNewContext(
		output,
		{
			module: module2,
			exports: module2.exports,
			require: (specifier) => {
				throw new Error(`pi-deck-goal-mode must stay dependency-free, got require("${specifier}")`);
			},
			__filename: "C:/PiDeck/resources/extensions/pi-deck-goal-mode.ts",
			console,
		},
		{ filename: extensionPath },
	);
	return module2.exports.default;
}

function createHarness() {
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const widgets = new Map();
	const appendedEntries = [];
	const sentMessages = [];

	// 模拟重启：session_start 读到的历史条目（默认就是本次追加的条目）
	let entrySource = null;

	const api = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
		appendEntry(customType, data) {
			appendedEntries.push({ type: "custom", customType, data });
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
		},
		sessionManager: {
			getEntries() {
				return entrySource ? [...entrySource] : [...appendedEntries];
			},
		},
	};

	loadGoalExtension()(api);

	return {
		handlers,
		context,
		widgets,
		appendedEntries,
		sentMessages,
		async runInput(text) {
			return handlers.get("input")({ text }, context);
		},
		async runCommand(args) {
			return commands.get("goal").handler(args, context);
		},
		async runBeforeAgentStart(event = {}) {
			return handlers.get("before_agent_start")(event, context);
		},
		async runAgentEnd(messages) {
			return handlers.get("agent_end")({ messages }, context);
		},
		async runSessionStart() {
			return handlers.get("session_start")({}, context);
		},
		setEntrySource(entries) {
			entrySource = entries.map((entry) => ({ ...entry, data: { ...entry.data } }));
		},
		/** 用给定条目模拟「重启后打开同一会话」：新扩展实例读取这些历史条目恢复状态。 */
		async restartWith(entries) {
			const next = createHarness();
			next.setEntrySource(entries);
			await next.runSessionStart();
			return next;
		},
	};
}

function assistantMessage(text, stopReason = "stop") {
	return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

test("goal 模式把规则 + 目标全文放进 section，消息只留轮次（issue #365-10 / #366）", async () => {
	const harness = createHarness();
	await harness.runInput(`${marker}\n把测试跑绿`);

	const sections = { pi_deck_earlier: "keep me" };
	const result = await harness.runBeforeAgentStart({ systemPromptOptions: { sections } });

	assert.match(sections.pi_deck_goal_mode, /^Rules:\n- Work toward the objective/);
	assert.ok(sections.pi_deck_goal_mode.includes("GOAL_COMPLETE"));
	// 目标在 run 内不变，跟着规则进 section：section 字节稳定，前缀缓存不失效。
	assert.ok(sections.pi_deck_goal_mode.includes("Objective: 把测试跑绿"));
	assert.equal(sections.pi_deck_earlier, "keep me", "前序扩展写入的 section 必须保留");

	// 每轮真正变化的只有 Round，消息里不再带目标全文与静态规则。
	assert.equal(result?.message?.content, "[GOAL MODE ACTIVE] Round: 1/32");
});

test("旧宿主（无 systemPromptOptions）保留整块目标上下文", async () => {
	const harness = createHarness();
	await harness.runInput(`${marker}\n把测试跑绿`);

	const result = await harness.runBeforeAgentStart({});
	const content = result?.message?.content ?? "";
	assert.ok(content.includes("[GOAL MODE ACTIVE]"));
	assert.ok(content.includes("Objective: 把测试跑绿"));
	assert.ok(content.includes("Round: 1/32"));
	assert.ok(content.includes("Rules:"));
	assert.ok(content.includes("GOAL_COMPLETE"));
});

test("续轮指令不再重复目标全文（issue #366）", async () => {
	const harness = createHarness();
	await harness.runInput(`${marker}\n把测试跑绿`);
	await harness.runBeforeAgentStart({ systemPromptOptions: { sections: {} } });
	await harness.runAgentEnd([assistantMessage("还在推进")]);

	assert.equal(harness.sentMessages.length, 1);
	const followUp = harness.sentMessages[0].message.content;
	assert.ok(followUp.startsWith("Continue the current goal."));
	assert.ok(followUp.includes("Rounds used: 1/32"));
	assert.equal(followUp.includes("Objective:"), false, "目标已在 section 里，续轮消息不该再写一遍");
});

test("目标没变时落盘省略 objective，只追加轮次（issue #366）", async () => {
	const harness = createHarness();
	await harness.runInput(`${marker}\n把测试跑绿`);
	await harness.runBeforeAgentStart({ systemPromptOptions: { sections: {} } });
	await harness.runAgentEnd([assistantMessage("还在推进")]);

	const [first, latest] = [harness.appendedEntries.at(0), harness.appendedEntries.at(-1)];
	assert.equal(first.data.objective, "把测试跑绿", "首次进入目标态必须落盘目标全文");
	assert.equal("objective" in latest.data, false, "目标未变化时不再写第二份全文");
	assert.equal(latest.data.roundsStarted, 1);
	assert.equal(latest.data.phase, "active");
});

test("目标变化时仍落盘完整 objective（issue #366 反向门禁）", async () => {
	const harness = createHarness();
	await harness.runInput(`${marker}\n旧目标`);
	await harness.runBeforeAgentStart({ systemPromptOptions: { sections: {} } });
	await harness.runAgentEnd([assistantMessage("还在推进")]);
	await harness.runCommand("换成另一个目标");

	const latest = harness.appendedEntries.at(-1);
	assert.equal(latest.data.objective, "换成另一个目标");
	assert.equal(latest.data.roundsStarted, 0, "显式新目标重置轮次");
});

test("session_start 能回溯到更早带 objective 的记录（issue #366）", async () => {
	const harness = createHarness();
	await harness.runInput(`${marker}\n把测试跑绿`);
	await harness.runBeforeAgentStart({ systemPromptOptions: { sections: {} } });
	await harness.runAgentEnd([assistantMessage("还在推进")]);
	assert.equal("objective" in harness.appendedEntries.at(-1).data, false, "前置：最后一轮确实省略了目标");

	await harness.runSessionStart();

	// GoalStrip 读 widget 第二行做目标原文展示。
	const lines = [...harness.widgets.values()][0];
	assert.equal(lines?.[0], "paused · 1/32");
	assert.equal(lines?.[1], "把测试跑绿");
});

test("clear 后退出再启动，旧目标不再复活（issue #395 复现路径）", async () => {
	// 复现步骤：目标模式下跑一轮 → 退出 PiDeck 重启（恢复为 paused）→ /goal clear → 再重启。
	// 关键在「重启后 clear」：重载后 persistedObjective 是模块初值 ""，
	// 旧判据 "" !== "" 为假 → 省略 objective 字段 → 会话里没有「已清除」的记录。
	const harness = createHarness();
	await harness.runInput(`${marker}\n目标 A`);
	await harness.runBeforeAgentStart({ systemPromptOptions: { sections: {} } });
	await harness.runAgentEnd([assistantMessage("还在推进")]);

	const restored = await harness.restartWith(harness.appendedEntries);
	assert.equal([...restored.widgets.values()][0]?.[1], "目标 A", "前置：重启后目标被恢复出来");

	await restored.runCommand("clear");
	assert.equal(restored.widgets.size, 0, "clear 后状态条立即消失");
	const cleared = restored.appendedEntries.at(-1);
	assert.equal(cleared.data.enabled, false);
	assert.equal(cleared.data.objective, "", 'clear 必须落 objective:""，否则重启回溯会穿透到旧目标');

	const restarted = await restored.restartWith(restored.appendedEntries);
	assert.equal(restarted.widgets.size, 0, "清除过的目标不得在重启后复活");
});

test("历史里的旧 clear 条目（不写 objective）也能截断回溯（issue #395 存量数据）", async () => {
	// 旧版 clear 落的是 { enabled:false, phase:"paused" } 且不带 objective 字段；
	// 回溯必须从尾部起、遇 enabled:false 立即停，不能穿透到更早的目标。
	const legacyEntries = [
		{ type: "custom", customType: "pi-deck-goal-mode", data: { enabled: true, phase: "active", objective: "旧目标", roundsStarted: 0, maxGoalRounds: 32 } },
		{ type: "custom", customType: "pi-deck-goal-mode", data: { enabled: true, phase: "active", roundsStarted: 1, maxGoalRounds: 32 } },
		{ type: "custom", customType: "pi-deck-goal-mode", data: { enabled: false, phase: "paused", roundsStarted: 2, maxGoalRounds: 32 } },
	];
	const restarted = await createHarness().restartWith(legacyEntries);
	assert.equal(restarted.widgets.size, 0, "旧 clear 记录必须截断回溯，旧目标不得复活");

	// 同一判据对「完成」同样成立：complete 也是 enabled:false。
	const completed = await createHarness().restartWith([legacyEntries[0], { type: "custom", customType: "pi-deck-goal-mode", data: { enabled: false, phase: "complete", roundsStarted: 3, maxGoalRounds: 32 } }]);
	assert.equal(completed.widgets.size, 0, "已完成的目标不得在重启后回到 paused");
});

test("恢复出的目标会同步 persistedObjective，恢复后 clear 仍可落盘（issue #395）", async () => {
	const harness = createHarness();
	await harness.runInput(`${marker}\n目标 A`);
	await harness.runBeforeAgentStart({ systemPromptOptions: { sections: {} } });
	await harness.runAgentEnd([assistantMessage("还在推进")]);

	// 重启恢复为 paused，随后在同一实例里 clear。
	const restarted = await harness.restartWith(harness.appendedEntries);
	assert.equal([...restarted.widgets.values()][0]?.[1], "目标 A");
	await restarted.runCommand("clear");

	const cleared = restarted.appendedEntries.at(-1);
	assert.equal(cleared.data.objective, "", '恢复后 clear 也必须落 objective:""');
	const again = await restarted.restartWith(restarted.appendedEntries);
	assert.equal(again.widgets.size, 0, "恢复→clear→再重启：目标不得复活");
});
