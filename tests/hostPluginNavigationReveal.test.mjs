import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const HOOK_SOURCE = "src/renderer/src/hooks/plugins/useHostPluginNavigation.ts";
const CHANNEL_SOURCE = "src/renderer/src/hooks/timeline/timelineRevealChannel.ts";

// 常量与决策纯函数在无依赖模块（时间线组件只该引用这一层，不能把 desktopApi/browserApi 的
// 模块求值副作用带进时间线的单测沙箱）。wiring 仍直接扫描 hook 源码。
const channel = loadTsCommonJs(CHANNEL_SOURCE);
const plan = (input) => ({ ...channel.planRevealAttempt(input) });

test("reveal event is a renderer-only channel with a stable name", () => {
	assert.equal(channel.REVEAL_TIMELINE_ENTRY_EVENT, "pideck:reveal-timeline-entry");
});

test("missing DOM target dispatches the reveal event once and keeps polling", () => {
	assert.deepEqual(plan({ found: false, eventDispatched: false, elapsedMs: 0 }), { action: "dispatch", keepPolling: true });
	assert.deepEqual(plan({ found: false, eventDispatched: true, elapsedMs: 500 }), { action: "wait", keepPolling: true });
	assert.deepEqual(plan({ found: false, eventDispatched: true, elapsedMs: 4000 }), { action: "give-up", keepPolling: false });
});

test("direct DOM hit keeps the legacy scroll, event-driven hit does not double-scroll", () => {
	assert.deepEqual(plan({ found: true, eventDispatched: false, elapsedMs: 0 }), { action: "scroll", keepPolling: false });
	assert.deepEqual(plan({ found: true, eventDispatched: true, elapsedMs: 200 }), { action: "wait", keepPolling: false });
	assert.deepEqual(plan({ found: false, eventDispatched: true, elapsedMs: 100, timeoutMs: 50 }), { action: "give-up", keepPolling: false });
});

test("hook wiring dispatches the event with the entry id and session id", () => {
	const source = readFileSync(HOOK_SOURCE, "utf8");
	// sessionId 必须随事件带出：插件刚 selectSession 时时间线可能还挂在旧会话，
	// 监听端要靠它决定「现在就跳」还是「等会话切到位再跳」。正则空白容忍（biome 会重排）。
	assert.match(source, /window\.dispatchEvent\(\s*new CustomEvent\(\s*REVEAL_TIMELINE_ENTRY_EVENT\s*,\s*\{\s*detail:\s*\{\s*entryId,\s*sessionId\s*\}\s*\}\s*\)\s*\)/);
	assert.match(source, /revealTimelineEntry\(\s*input\.entryId,\s*input\.sessionId\s*\)/);
});

test("selector escapes attribute quotes and backslashes", () => {
	const nav = loadTsCommonJs(HOOK_SOURCE, {
		stubs: {
			react: { useEffect: () => undefined, useRef: (initial) => ({ current: initial }) },
			jotai: { useSetAtom: () => () => undefined },
			"../../desktopApi": { desktopApi: { hostPlugins: { onNavigate: () => () => undefined, onOpenBrowser: () => () => undefined } } },
			"../../atoms/host-plugin-atoms": { hostPluginPanelAtom: {} },
		},
	});
	assert.equal(nav.timelineEntrySelector('a"b\\c'), '[data-message-id="a\\"b\\\\c"]');
});
