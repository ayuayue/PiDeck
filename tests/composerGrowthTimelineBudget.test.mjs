import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const source = readFileSync("src/renderer/src/rendererUtils.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: () => ({}),
	});
	return module.exports;
}

function approx(a, b) {
	return Math.abs(a - b) < 1e-9;
}

function assertLayout(got, expected) {
	assert.ok(approx(got.timeline, expected.timeline), `timeline ${got.timeline} ≈ ${expected.timeline}`);
	assert.ok(approx(got.terminal, expected.terminal), `terminal ${got.terminal} ≈ ${expected.terminal}`);
}

test("collapsing the terminal gives leftover height to the timeline", () => {
	const { redistributeTerminalAgainstTimeline } = loadModule();
	const next = redistributeTerminalAgainstTimeline({ timeline: 60, terminal: 40 }, 4.25);
	assertLayout(next, { timeline: 95.75, terminal: 4.25 });
});

test("expanding the terminal takes height from the timeline", () => {
	const { redistributeTerminalAgainstTimeline } = loadModule();
	const next = redistributeTerminalAgainstTimeline({ timeline: 95.75, terminal: 4.25 }, 40, 20);
	assertLayout(next, { timeline: 60, terminal: 40 });
});

test("timeline min-size budget stops the terminal from eating the chat column", () => {
	const { redistributeTerminalAgainstTimeline } = loadModule();
	const next = redistributeTerminalAgainstTimeline({ timeline: 30, terminal: 70 }, 90, 40);
	assertLayout(next, { timeline: 40, terminal: 60 });
});

test("session view no longer grows a composer panel against the timeline budget", () => {
	const sessionView = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
	const terminalDockPanel = readFileSync("src/renderer/src/components/terminal/TerminalDockPanel.tsx", "utf8");
	const terminalDockState = readFileSync("src/renderer/src/terminalDockState.ts", "utf8");
	assert.doesNotMatch(sessionView, /growComposerWithinTimelineBudget/);
	assert.doesNotMatch(sessionView, /id="composer"/);
	assert.match(sessionView, /redistributeTerminalAgainstTimeline/);
	assert.match(sessionView, /sessionResizableGroupKey\(sessionPanels\)/);
	assert.match(sessionView, /sessionGroupDefaultLayout/);
	assert.match(terminalDockPanel, /groupResizeBehavior="preserve-pixel-size"/);
	assert.doesNotMatch(sessionView, /applyComposerHeight\(px, true\)/);
	assert.match(sessionView, /sessionTimeline\.isSurfaceLoading/);
	assert.match(sessionView, /minSize=\{timelineColumnMinSize\}/);
	assert.match(sessionView, /isProgrammaticResize=\{\(\) => Date\.now\(\) < terminalProgrammaticExpireRef\.current\}/);
	assert.match(terminalDockPanel, /applyTerminalPanelResize/);
	assert.match(terminalDockState, /TERMINAL_COLLAPSE_THRESHOLD_PX = 35/);
	assert.doesNotMatch(sessionView, /panel\.collapse\(\)/);
	assert.doesNotMatch(sessionView, /panel\.expand\(\)/);
	assert.match(sessionView, /redistributeTerminalAgainstTimeline\(/);
});

test("bottom composer mount does not change the group panel count", () => {
	const { shouldMountBottomComposer, sessionResizableGroupKey, sanitizeSessionPanelLayout } = loadModule();

	assert.equal(
		shouldMountBottomComposer({
			hasActiveConversation: true,
			messageCount: 0,
			isConversationLoading: true,
		}),
		true,
		"loading history must keep the bottom composer mounted",
	);
	assert.equal(
		shouldMountBottomComposer({
			hasActiveConversation: true,
			messageCount: 0,
			isConversationLoading: false,
		}),
		false,
		"empty ready sessions stay on the start surface",
	);
	assert.equal(
		shouldMountBottomComposer({
			hasActiveConversation: true,
			messageCount: 3,
			isConversationLoading: false,
		}),
		true,
	);
	assert.equal(
		shouldMountBottomComposer({
			hasActiveConversation: false,
			messageCount: 0,
			isConversationLoading: true,
		}),
		false,
	);

	assert.equal(sessionResizableGroupKey({ terminal: false }), "session-group-1p");
	assert.equal(sessionResizableGroupKey({ terminal: true }), "session-group-2p");
	assert.notEqual(sessionResizableGroupKey({ terminal: false }), sessionResizableGroupKey({ terminal: true }), "1-panel and 2-panel groups must not share a cache key");

	const onePanel = sanitizeSessionPanelLayout({ timeline: 83.506, terminal: 16.494 }, { terminal: false });
	assert.equal(onePanel.timeline, 100);
	assert.equal(onePanel.terminal, undefined);
	assert.equal(Object.keys(onePanel).join(","), "timeline");

	const twoPanel = sanitizeSessionPanelLayout({ timeline: 50, terminal: 50 }, { terminal: true });
	assert.equal(twoPanel.terminal, 50);
	assert.ok(Math.abs(twoPanel.timeline - 50) < 1e-9);
});

test("sanitize preserves getLayout key order so percentages are not swapped", () => {
	const { sanitizeSessionPanelLayout } = loadModule();

	const terminalFirst = sanitizeSessionPanelLayout({ terminal: 20, timeline: 80 }, { terminal: true });
	assert.equal(Object.keys(terminalFirst).join(","), "terminal,timeline");
	assert.equal(terminalFirst.terminal, 20);
	assert.ok(Math.abs(terminalFirst.timeline - 80) < 1e-9);

	const timelineFirst = sanitizeSessionPanelLayout({ timeline: 80, terminal: 20 }, { terminal: true });
	assert.equal(Object.keys(timelineFirst).join(","), "timeline,terminal");
	assert.equal(timelineFirst.terminal, 20);
	assert.ok(Math.abs(timelineFirst.timeline - 80) < 1e-9);
});

test("session group default layout keys stay in DOM order", () => {
	const { sessionGroupDefaultLayout } = loadModule();
	const one = sessionGroupDefaultLayout({ terminal: false }, 0, 800);
	assert.equal(Object.keys(one).join(","), "timeline");
	assert.equal(one.timeline, 100);

	const two = sessionGroupDefaultLayout({ terminal: true }, 160, 800);
	assert.equal(Object.keys(two).join(","), "timeline,terminal");
	assert.equal(two.terminal, 20);
	assert.equal(two.timeline, 80);
});
