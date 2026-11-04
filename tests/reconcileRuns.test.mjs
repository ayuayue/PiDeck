import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 阶段0补强：历史 run 引用稳定。
 *
 * groupToolMessages 每次全量重建所有 run；reconcileRuns 对比新旧列表，
 * 对「内容未变化」的 run 复用旧对象引用。这样 TurnRow 的 memo 比较
 * （sameAgentRunForRender）的 `previous === next` 快速路径命中，历史 run
 * 比较退化为 O(1)，不再每次流式增量都深度遍历全部历史消息。
 */

// AppUtils 依赖 chips 模块，用 transpileModule + vm 沙箱加载
//（与 tests/turnSegments.test.mjs 的 loadAppUtils 同套路）。
function loadAppUtils() {
	const source = readFileSync("src/renderer/src/components/app/AppUtils.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = {
		exports: {},
		location: { href: "file:///Users/test/app" },
		require: (id) => {
			if (id === "../session/composer/chips") return { formatFilePathRef: (p) => p };
			return {};
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "AppUtils.ts" });
	return sandbox.exports;
}

function makeRun(id, text) {
	return {
		kind: "agent-run",
		id,
		items: [
			{
				kind: "message",
				message: {
					id: `${id}-m1`,
					agentId: "agent",
					role: "assistant",
					text,
					timestamp: 1,
				},
			},
		],
		startedAt: 1,
		endedAt: 2,
	};
}

test("sameAgentRunForRender returns true when references are identical", () => {
	const { sameAgentRunForRender } = loadAppUtils();
	const run = makeRun("run-1", "hello");
	assert.equal(sameAgentRunForRender(run, run), true);
});

test("sameAgentRunForRender deep-compares content when references differ", () => {
	const { sameAgentRunForRender } = loadAppUtils();
	const a = makeRun("run-1", "hello");
	const b = makeRun("run-1", "hello");
	const c = makeRun("run-1", "world");
	assert.equal(sameAgentRunForRender(a, b), true);
	assert.equal(sameAgentRunForRender(a, c), false);
});

test("reconcileRuns reuses unchanged run references and keeps new runs", () => {
	const { reconcileRuns } = loadAppUtils();
	const run1 = makeRun("run-1", "first answer");
	const run2 = makeRun("run-2", "second answer");

	// 第一次：无 previous，全部用新对象
	const first = reconcileRuns(undefined, [run1]);
	assert.equal(first[0], run1);

	// 第二次：run-1 未变化 → 复用旧引用；run-2 新增 → 新对象
	const second = reconcileRuns(first, [run1, run2]);
	assert.equal(second[0], run1, "unchanged run should reuse old reference");
	assert.equal(second[1], run2);

	// 第三次：全部未变化 → 整体复用 previous 数组（引用相等）
	const third = reconcileRuns(second, [run1, run2]);
	assert.equal(third, second, "all unchanged should return previous array itself");
});

test("reconcileRuns detects content changes inside a run", () => {
	const { reconcileRuns } = loadAppUtils();
	const run1 = makeRun("run-1", "first answer");
	const first = reconcileRuns(undefined, [run1]);

	// run-1 内容变化（流式增量）：不能复用旧引用。
	// endedAt 也跟着变（2 → 99）：外层字段必须取自 next，而不是沿用旧 run —— 这是
	// 「{ ...prev, items }」这类变异唯一会被抓住的地方（run 由未结束变结束、ask 等待时长变化时，
	// 沿用旧 endedAt 会让行计时与等待态留在旧值，且因为数组已重建，表现为「重渲染了但值还是旧的」）。
	const run1Changed = { ...makeRun("run-1", "first answer with more text"), startedAt: 7, endedAt: 99 };
	const second = reconcileRuns(first, [run1Changed]);
	assert.notEqual(second[0], run1, "changed run must use new reference");
	assert.equal(second[0].items[0].message.text, "first answer with more text", "新内容必须落到返回对象上");
	assert.equal(second[0].endedAt, 99, "外层字段必须取自 next（沿用旧 run 的 endedAt 是静默错误）");
	// startedAt 取 7 而 first[0] 是 1：这条断言才可能因「沿用旧 run」而红
	//（若两版 startedAt 相同，`{...prev, items}` 变异下它恒绿，等于没测）。
	assert.equal(second[0].startedAt, 7, "外层字段必须逐个取自 next，不能靠「值恰好相同」蒙过");
});

function makeImageGenRun(status, errorDetail, endedAt = 2) {
	return {
		kind: "agent-run",
		id: "run-image",
		items: [
			{
				kind: "message",
				message: {
					id: "img-1",
					agentId: "",
					role: "assistant",
					text: "",
					stopReason: "stop",
					timestamp: 1,
					meta: {
						imageGen: {
							status,
							prompt: "a cat",
							size: "1024x1024",
							...(errorDetail ? { errorDetail } : {}),
						},
					},
				},
			},
		],
		startedAt: 1,
		endedAt,
	};
}

// 厂商拒绝生图时只改 meta.imageGen.status（文本/图片都不变）。
// 漏比这项会复用 generating 的旧 run，界面一直转圈，直到切标签卸载重挂。
test("reconcileRuns does not reuse an image-gen run when status flips to error", () => {
	const { sameAgentRunForRender, reconcileRuns } = loadAppUtils();
	const generating = makeImageGenRun("generating");
	const failed = makeImageGenRun("error", "API refused the request", 9);

	assert.equal(sameAgentRunForRender(generating, generating), true);
	assert.equal(sameAgentRunForRender(generating, makeImageGenRun("generating")), true, "identical generating placeholders should still compare equal");
	assert.equal(sameAgentRunForRender(generating, failed), false, "imageGen status change must be visible to TurnRow memo");

	const first = reconcileRuns(undefined, [generating]);
	const second = reconcileRuns(first, [failed]);
	assert.notEqual(second[0], generating, "error state must not reuse generating run");
	// 返回对象是 {...failed, items: 复用后的数组}：外层字段全来自 failed，但引用不等于 failed。
	assert.equal(second[0].id, failed.id);
	// endedAt 只比 id 是不够的：id 两版相同，`{...prev, items}` 变异下也绿。
	// 断言 endedAt 取自 next（9）才真正排除「沿用旧 run 外层字段」。
	assert.equal(second[0].endedAt, 9, "外层 endedAt 必须取自 next");
	assert.deepEqual(
		second[0].items.map((item) => item.message?.meta?.imageGen?.status),
		["error"],
	);
});

test("reconcileRunItems reuses the items array when every entry is unchanged", () => {
	const { reconcileRuns } = loadAppUtils();
	// 关键：tool-group / thinking-group 每次 flush 都会新建包装对象，只有成员消息引用稳定。
	// 这条测的就是「包装对象是新的、成员逐项同引用」时必须换回旧条目并复用 items 数组。
	const sharedMessage = { id: "tool-1", agentId: "agent", role: "tool", text: "ok", timestamp: 1 };
	const firstGroup = { kind: "tool-group", id: "tool-1", messages: [sharedMessage] };
	const firstRun = { kind: "agent-run", id: "run-1", items: [firstGroup], startedAt: 1, endedAt: 2 };
	const first = reconcileRuns(undefined, [firstRun]);

	// 同一批成员消息，但 tool-group 包装是全新对象；外层 endedAt 也变了。
	const secondGroup = { kind: "tool-group", id: "tool-1", messages: [sharedMessage] };
	const secondRun = { kind: "agent-run", id: "run-1", items: [secondGroup], startedAt: 1, endedAt: 5 };
	const second = reconcileRuns(first, [secondRun]);

	assert.notEqual(second[0], first[0], "外层字段变了 → run 必须新建");
	assert.equal(second[0].items, first[0].items, "条目逐项同引用时，items 数组必须复用（下游 useMemo 的命中前提）");
	assert.equal(second[0].items[0], first[0].items[0], "未变的 tool-group 必须换回旧引用");
	assert.equal(second[0].endedAt, 5, "外层字段取自 next");
});

test("reconcileRunItems keeps the new entry when member content changes", () => {
	const { reconcileRuns } = loadAppUtils();
	const messageA = { id: "tool-1", agentId: "agent", role: "tool", text: "ok", timestamp: 1 };
	const first = reconcileRuns(undefined, [{ kind: "agent-run", id: "run-1", items: [{ kind: "tool-group", id: "tool-1", messages: [messageA] }], startedAt: 1, endedAt: 2 }]);

	// 成员消息换了对象（内容也变了）→ 条目不能复用，items 数组也必须新建。
	const messageB = { ...messageA, text: "ok, more output" };
	const second = reconcileRuns(first, [{ kind: "agent-run", id: "run-1", items: [{ kind: "tool-group", id: "tool-1", messages: [messageB] }], startedAt: 1, endedAt: 3 }]);

	assert.notEqual(second[0].items, first[0].items, "成员变了 → items 数组不能复用");
	assert.notEqual(second[0].items[0], first[0].items[0], "成员变了的 tool-group 必须是新对象");
	assert.equal(second[0].items[0].messages[0].text, "ok, more output");
});

test("reconcileRuns removes stale runs when next shrinks", () => {
	const { reconcileRuns } = loadAppUtils();
	const run1 = makeRun("run-1", "a");
	const run2 = makeRun("run-2", "b");
	const first = reconcileRuns(undefined, [run1, run2]);
	const second = reconcileRuns(first, [run1]);
	assert.equal(second.length, 1);
	assert.equal(second[0], run1);
});

// 契约：SessionMessageTimeline 用 reconcileRuns 复用引用，TurnRow memo 走快速路径
test("timeline wires reconcileRuns and TurnRow memo fast path", () => {
	const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.match(timeline, /reconcileRuns\(prevRenderedRunsRef\.current, renderedRuns\)/);
	assert.match(timeline, /prevRenderedRunsRef = useRef<RenderMessage\[\] \| undefined>/);

	const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
	assert.match(turnRow, /sameAgentRunForRender\(prev\.run, next\.run\)/);
});

/**
 * 顶层非 run 条目的内容变化必须透传。
 *
 * 回归背景（2026-10 审计）：`reconcileRuns` 的 map 里对 `item.kind !== "agent-run"` 直接
 * `return item`，既不参与配对也不置 `changed`。于是「只改了一条顶层消息、条目数不变」时
 * 函数走到最后一行 `if (!changed && previous.length === next.length) return previous`，
 * 直接把**旧数组**返回——新内容被静默丢弃。用户消息（role: "user"）、首轮立即失败的重试/
 * 错误卡片、扩展输出条目都是顶层条目，所以这条路径不是边缘情况。
 */
function makeTopMessage(id, text) {
	return {
		kind: "message",
		message: { id, agentId: "agent", role: "user", text, timestamp: 1 },
	};
}

test("propagates a top-level message whose text changed", () => {
	const { reconcileRuns } = loadAppUtils();
	const before = makeTopMessage("m1", "running");
	const after = makeTopMessage("m1", "success");
	const previous = [before];
	const next = [after];

	const out = reconcileRuns(previous, next);

	assert.notEqual(out, previous, "内容变了就必须返回新数组，不能整表沿用 previous");
	assert.equal(out[0], after, "顶层条目的新内容必须透传");
	assert.equal(out[0].message.text, "success", "读到的文案必须是新值");
});

test("reuses a top-level message that is reference-identical", () => {
	const { reconcileRuns } = loadAppUtils();
	const same = makeTopMessage("m1", "hello");
	const previous = [same];
	const next = [{ ...same }];

	const out = reconcileRuns(previous, next);

	assert.equal(out, previous, "全部等价时应整体复用 previous 数组");
	assert.equal(out[0], same, "等价条目应换回旧引用");
});

test("mixed: top-level message unchanged while a run changes keeps both correct", () => {
	const { reconcileRuns } = loadAppUtils();
	const userMessage = makeTopMessage("u1", "do it");
	const runBefore = makeRun("run-1", "step 1");
	const runAfter = makeRun("run-1", "step 2");

	const out = reconcileRuns([userMessage, runBefore], [userMessage, runAfter]);

	assert.equal(out[0], userMessage, "未变的顶层消息保留旧引用");
	assert.equal(out[1].items[0].message.text, "step 2", "变化的那一轮取新内容");
	assert.notEqual(out, runBefore, "返回值是新数组");
});

test("a removed top-level message does not resurrect from previous", () => {
	const { reconcileRuns } = loadAppUtils();
	const out = reconcileRuns([makeTopMessage("m1", "a"), makeTopMessage("m2", "b")], [makeTopMessage("m2", "b")]);
	assert.equal(out.length, 1, "列表结构以 next 为准");
	assert.equal(out[0].message.id, "m2");
});

/**
 * `reconcileRunItems` 的条目级复用分支逐个钉住。
 *
 * 审计变异实验（2026-10）发现：把 thinking-group / retry-group / error-group 三个分支
 * 各自削到「只比 id」，9 条测试全部照绿——也就是说这三个分支此前**完全没有覆盖**。
 * 它们不是装饰：retry / error 条目是同一 id 原地 upsert（AppUtils.ts 里明写），只比 id
 * 会把新的失败详情丢掉；thinking-group 的正文与起止时间都在变，只比 id 会让思考块停在旧文案。
 */
test("thinking-group 只变正文时必须换新条目", () => {
	const { reconcileRuns } = loadAppUtils();
	const members = [{ id: "t-1", agentId: "agent", role: "assistant", text: "think", timestamp: 1 }];
	const first = reconcileRuns(undefined, [{ kind: "agent-run", id: "run-1", items: [{ kind: "thinking-group", id: "think-1", text: "旧思考", startedAt: 1, endedAt: 2, messages: members }], startedAt: 1, endedAt: 2 }]);
	const second = reconcileRuns(first, [{ kind: "agent-run", id: "run-1", items: [{ kind: "thinking-group", id: "think-1", text: "新思考", startedAt: 1, endedAt: 2, messages: members }], startedAt: 1, endedAt: 5 }]);
	assert.notEqual(second[0].items[0], first[0].items[0], "正文变了，thinking-group 必须是新对象");
	assert.equal(second[0].items[0].text, "新思考");
});

test("retry-group 同 id 不同消息时必须换新条目", () => {
	const { reconcileRuns } = loadAppUtils();
	const before = { id: "retry-1", agentId: "agent", role: "error", text: "429 retrying", timestamp: 1 };
	const after = { id: "retry-1", agentId: "agent", role: "error", text: "429 retrying (2/3)", timestamp: 2 };
	const first = reconcileRuns(undefined, [{ kind: "agent-run", id: "run-1", items: [{ kind: "retry-group", id: "retry-1", message: before }], startedAt: 1, endedAt: 2 }]);
	const second = reconcileRuns(first, [{ kind: "agent-run", id: "run-1", items: [{ kind: "retry-group", id: "retry-1", message: after }], startedAt: 1, endedAt: 5 }]);
	assert.notEqual(second[0].items[0], first[0].items[0], "同 id 原地 upsert 必须按消息本体比较");
	assert.equal(second[0].items[0].message.text, "429 retrying (2/3)");
});

test("error-group 同 id 不同消息时必须换新条目", () => {
	const { reconcileRuns } = loadAppUtils();
	const before = { id: "err-1", agentId: "agent", role: "error", text: "boom", timestamp: 1 };
	const after = { id: "err-1", agentId: "agent", role: "error", text: "boom (detail attached)", timestamp: 2 };
	const first = reconcileRuns(undefined, [{ kind: "agent-run", id: "run-1", items: [{ kind: "error-group", id: "err-1", message: before }], startedAt: 1, endedAt: 2 }]);
	const second = reconcileRuns(first, [{ kind: "agent-run", id: "run-1", items: [{ kind: "error-group", id: "err-1", message: after }], startedAt: 1, endedAt: 5 }]);
	assert.notEqual(second[0].items[0], first[0].items[0], "错误详情变了必须透传");
	assert.equal(second[0].items[0].message.text, "boom (detail attached)");
});

/**
 * `allReused` 的长度前提。
 *
 * 旧实现写 `let allReused = previous.length === next.length`，随后在 map 里把
 * 「没配对上」的条目置 false。审计变异 `let allReused = true` 让 9 条测试全绿——
 * 而真跑起来 items 变短时会把**更长的旧数组**返回，下游多渲染一条已经消失的条目。
 */
test("items 变短时不能返回更长的旧数组", () => {
	const { reconcileRuns } = loadAppUtils();
	const messageA = { id: "tool-1", agentId: "agent", role: "tool", text: "ok", timestamp: 1 };
	const messageB = { id: "tool-2", agentId: "agent", role: "tool", text: "ok", timestamp: 2 };
	const first = reconcileRuns(undefined, [
		{
			kind: "agent-run",
			id: "run-1",
			items: [
				{ kind: "tool-group", id: "tool-1", messages: [messageA] },
				{ kind: "tool-group", id: "tool-2", messages: [messageB] },
			],
			startedAt: 1,
			endedAt: 2,
		},
	]);
	const second = reconcileRuns(first, [{ kind: "agent-run", id: "run-1", items: [{ kind: "tool-group", id: "tool-1", messages: [messageA] }], startedAt: 1, endedAt: 5 }]);
	assert.equal(second[0].items.length, 1, "返回的 items 长度必须等于 next");
	assert.equal(second[0].items[0].id, "tool-1");
});

test("items 变长时不能沿用旧数组", () => {
	const { reconcileRuns } = loadAppUtils();
	const messageA = { id: "tool-1", agentId: "agent", role: "tool", text: "ok", timestamp: 1 };
	const messageB = { id: "tool-2", agentId: "agent", role: "tool", text: "ok", timestamp: 2 };
	const groupA = { kind: "tool-group", id: "tool-1", messages: [messageA] };
	const first = reconcileRuns(undefined, [{ kind: "agent-run", id: "run-1", items: [groupA], startedAt: 1, endedAt: 2 }]);
	const second = reconcileRuns(first, [{ kind: "agent-run", id: "run-1", items: [groupA, { kind: "tool-group", id: "tool-2", messages: [messageB] }], startedAt: 1, endedAt: 5 }]);
	assert.equal(second[0].items.length, 2, "新增条目必须出现");
	assert.equal(second[0].items[1].id, "tool-2");
});

// 预热激活回归（2026-11）：pi 运行时首次 flush 会把磁盘页投影 `_viewer-history-X`
// 改写为 `<agentId>-history-X`。session-atoms 的 stabilizeRuntimeMessageIds 负责把
// 运行时窗口段 id 稳定回缓存已有显示 id；这里守住它下游的契约——id 与内容都未变的
// run 必须复用旧引用（TurnRow memo 快路径命中、不 remount、不重播入场动画），
// 而 id 被改写的 run（修复前形态）不会复用，正是 remount/卡顿/焦点丢失的来源。
test("投影 id 稳定时 flush 后 run 引用复用；id 被改写时不复用", () => {
	const { reconcileRuns } = loadAppUtils();
	const diskRun = makeRun("_viewer-history-e5-run", "answer");
	const first = reconcileRuns(undefined, [diskRun]);

	// 修复后：运行时窗口段经 stabilizeRuntimeMessageIds 稳定回磁盘页显示 id
	//（对象是新的，id 与内容不变 —— flush 全量重建的形态）。
	const stabilizedRun = makeRun("_viewer-history-e5-run", "answer");
	const second = reconcileRuns(first, [stabilizedRun]);
	assert.equal(second[0], diskRun, "id+内容不变 → 复用旧引用（不 remount）");

	// 修复前形态：id 被改写为运行时投影前缀 → 视为不同 run，不复用（会 remount）。
	const rewrittenRun = makeRun("agent-1-history-e5-run", "answer");
	const third = reconcileRuns(first, [rewrittenRun]);
	assert.notEqual(third[0], diskRun, "id 改写 → 新引用（修复前 remount 的形态）");
});
