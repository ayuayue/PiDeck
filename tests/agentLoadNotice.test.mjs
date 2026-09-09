import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

// 纯逻辑模块只 import 类型（编译期擦除），无需解析运行时依赖
function loadModule() {
	const sandbox = { exports: {} };
	vm.runInNewContext(transpile("src/renderer/src/utils/agentLoadNotice.ts"), sandbox, {
		filename: "agentLoadNotice.ts",
	});
	return sandbox.exports;
}

function runtime(status) {
	return { status };
}

test("high agent count threshold is 15", () => {
	const { HIGH_AGENT_COUNT_THRESHOLD } = loadModule();
	assert.equal(HIGH_AGENT_COUNT_THRESHOLD, 15);
});

test("countActivatedAgents counts only alive runtimes (starting/idle/running/error)", () => {
	const { countActivatedAgents } = loadModule();
	assert.equal(
		countActivatedAgents({
			a: runtime("starting"),
			b: runtime("idle"),
			c: runtime("running"),
			d: runtime("error"),
		}),
		4,
	);
});

test("countActivatedAgents excludes closed / detached / empty", () => {
	const { countActivatedAgents } = loadModule();
	assert.equal(
		countActivatedAgents({
			closed: runtime("closed"),
			detached: runtime("detached"),
			unknown: runtime("weird"),
			noStatus: runtime(undefined),
		}),
		0,
	);
	assert.equal(countActivatedAgents({}), 0);
});

test("countActivatedAgents is independent of key names (sessionId semantics)", () => {
	const { countActivatedAgents } = loadModule();
	assert.equal(
		countActivatedAgents({
			"session-1": runtime("idle"),
			"session-2": runtime("closed"),
			"session-3": runtime("running"),
		}),
		2,
	);
});

// 行为侧（React hook）用源码断言：每个启动周期只提示一次，且带 count 与蓝色（空闲）提示语义
test("useAgentLoadNotice warns once per launch via guarded effect", () => {
	const source = readFileSync("src/renderer/src/hooks/useAgentLoadNotice.ts", "utf8");
	assert.match(source, /warnedRef\.current/);
	assert.match(source, /enabledRef\.current/);
	assert.match(source, /countActivatedAgents\(store\.get\(sessionRuntimeByIdAtom\)\)/);
	assert.match(source, /HIGH_AGENT_COUNT_THRESHOLD/);
	assert.match(source, /store\.sub\(sessionRuntimeByIdAtom, check\)/);
	// 提示为 warning 且携带数量参数，正文指向蓝色（空闲）会话
	assert.match(source, /15000,\s*"warning"/);
	assert.match(source, /t\("app\.highAgentCountBody",\s*\{\s*count\s*\}\)/);
	assert.match(source, /t\("app\.highAgentCountTitle"\)/);
});

test("useAgentLoadNotice lets the user snooze reminders for the current launch", () => {
	const source = readFileSync("src/renderer/src/hooks/useAgentLoadNotice.ts", "utf8");
	// 静默开关为内存态：snooze 后 check 直接短路，应用重启（重新加载模块）即重置
	assert.match(source, /let snoozedForLaunch = false/);
	// 设置关闭时同样短路：开启才提醒
	assert.match(source, /if \(!enabledRef\.current \|\| snoozedForLaunch \|\| warnedRef\.current\) return;/);
	// 两个操作：主按钮静默本周期、次按钮仅关闭当前 toast
	assert.match(source, /t\("app\.highAgentCountSnooze"\)/);
	assert.match(source, /t\("app\.projectRemoveBlockedAck"\)/);
	assert.match(source, /snoozedForLaunch = true/);
});

test("reminder toggles are default-enabled and wired through App + SettingsStore", () => {
	const settingsType = readFileSync("src/shared/types/settings.ts", "utf8");
	const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const notificationTab = readFileSync("src/renderer/src/components/app/settings/NotificationTab.tsx", "utf8");
	// 类型、主进程默认值、渲染层首屏默认值三处同步为开启
	assert.match(settingsType, /agentCountReminderEnabled: boolean/);
	assert.match(store, /agentCountReminderEnabled: true/);
	assert.match(app, /agentCountReminderEnabled: true/);
	// 渲染层 hook 读取开关：开启才提醒
	assert.match(app, /useAgentLoadNotice\(settings\.agentCountReminderEnabled\)/);
	// 设置面板提供开关（更新草稿对应字段）；开关位于通知设置 tab（NotificationTab）
	assert.match(notificationTab, /updateDraft\(\{ agentCountReminderEnabled: checked \}\)/);
});

test("i18n copy covers zh-CN and en-US with count placeholder", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.match(zh, /"app\.highAgentCountTitle": "运行的 Agent 有点多，给电脑减减负吧"/);
	assert.match(zh, /"app\.highAgentCountBody": "当前有 \{count\} 个 Agent/);
	assert.match(en, /"app\.highAgentCountTitle": "Quite a few agents are running/);
	assert.match(en, /"app\.highAgentCountBody": "There are currently \{count\} active agents/);
	// 静默按钮双语同步
	assert.match(zh, /"app\.highAgentCountSnooze": "本次不再提醒"/);
	assert.match(en, /"app\.highAgentCountSnooze": "Don't remind again this session"/);
});
