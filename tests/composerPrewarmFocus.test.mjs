import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function compile(filePath, imports = {}) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: (id) => imports[id] ?? nodeRequire(id),
		Date,
	});
	return module.exports;
}

const timeline = compile("src/renderer/src/hooks/useSessionTimelineController.ts", {
	react: {},
	jotai: { atom: (value) => ({ _mockInit: value }) },
	"jotai/utils": {},
	"../atoms": {}, "../lib/pinTurnScroll": { animateScrollTop: () => () => undefined, pinScrollDurationMs: () => 320 },
	"../desktopApi": {},	"./timeline/autoExpandThreshold": { TURN_WINDOW_AUTO_EXPAND_THRESHOLD: 120, resolveAutoExpandThreshold: (h) => Math.max(120, Math.round(h * 0.4)) },	"../components/session/timeline/turnRenderWindow": {
		TIMELINE_SCROLLED_TURN_LIMIT: 3,
		TIMELINE_WINDOW_EXPAND_STEP: 3,
	},
	// useSessionTimelineController 引入 jumpWindowPolicy（策略函数），loader 缺此 stub 时
	// 回落到 nodeRequire 解析 .ts 失败。其自身依赖 ./turnRenderWindow，用同名 mock 即可。
	"../components/session/timeline/jumpWindowPolicy": compile(
		"src/renderer/src/components/session/timeline/jumpWindowPolicy.ts",
		{ "./turnRenderWindow": { TIMELINE_WINDOW_EXPAND_STEP: 3 } },
	),
});

const composerController = readFileSync(
	"src/renderer/src/hooks/useSessionComposerController.ts",
	"utf8",
);
const runtimeController = readFileSync(
	"src/renderer/src/hooks/useSessionRuntimeController.ts",
	"utf8",
);
const composerArea = readFileSync(
	"src/renderer/src/components/session/ComposerArea.tsx",
	"utf8",
);
const header = readFileSync(
	"src/renderer/src/components/session/SessionHeader.tsx",
	"utf8",
);
const headerCss = readFileSync("src/renderer/src/styles/foundation.css", "utf8");

test("background runtime start is not a user-facing start", () => {
	// 输入预热会把 runtime 打成 starting，但 send 仍是 idle：不能当成「正在启动」去锁 UI。
	assert.equal(timeline.isUserFacingSessionStart("idle"), false);
	assert.equal(timeline.isUserFacingSessionStart(undefined), false);
	assert.equal(timeline.isUserFacingSessionStart("sending"), false);
	assert.equal(timeline.isUserFacingSessionStart("activating"), true);
});

test("prewarming an empty ready session does not flash the history skeleton", () => {
	const prewarm = timeline.deriveSessionSurfaceRuntime(
		0,
		"ready",
		"idle",
		"starting",
		undefined,
		true,
	);
	assert.equal(prewarm.isLoading, false);
	assert.equal(prewarm.isStarting, false);
	assert.equal(prewarm.isBusy, false);
});

test("send activating still counts as starting, but does not replace start surface with skeleton", () => {
	// 空会话点发送：保留起始页，等首条消息上屏；不要先闪一轮骨架屏。
	const sending = timeline.deriveSessionSurfaceRuntime(
		0,
		"ready",
		"activating",
		"starting",
		undefined,
		true,
	);
	assert.equal(sending.isStarting, true);
	assert.equal(sending.isBusy, true);
	assert.equal(sending.isLoading, false);
	assert.equal(sending.status, "starting");
});

test("composer lock follows send activating, not background runtime starting", () => {
	// 预热只创建进程，不能 setEditable(false)，否则输入一半失焦。
	assert.match(composerController, /isUserFacingSessionStart\(sendState\.status\)/);
	assert.doesNotMatch(
		composerController,
		/runtime\?\.status === "starting" \|\| sendState\.status === "activating"/,
	);
	assert.match(composerArea, /disabled=\{composer\.isStarting\}/);
});

test("session header does not grow when agent is only prewarming", () => {
	assert.match(runtimeController, /isUserFacingSessionStart\(/);
	assert.doesNotMatch(
		runtimeController,
		/activeConversationStatus === "starting" \|\s*currentSessionSendState\.status === "activating"/,
	);
	assert.match(header, /isStarting \? " loading"/);
	// 标题行是 h-7（28px）；loading 再写 min-height:36px 会把整栏顶高一截。
	assert.doesNotMatch(headerCss, /\.chat-header-actions\.loading \{[\s\S]*?min-height:\s*36px/);
});
