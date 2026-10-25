import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { readFileSync } from "node:fs";

const { VIRTUAL_MIN_TURNS, VIRTUAL_SOLID_TAIL_TURNS, VIRTUAL_ESTIMATED_RUN_HEIGHT, shouldVirtualizeTurnList, resolveRunHeight, splitVirtualRunsByTail, isRenderableRunItem } = loadTsCommonJs("src/renderer/src/components/session/timeline/virtualTimelinePolicy.ts");

test("常量是有限正数", () => {
	for (const v of [VIRTUAL_MIN_TURNS, VIRTUAL_SOLID_TAIL_TURNS, VIRTUAL_ESTIMATED_RUN_HEIGHT]) {
		assert.ok(Number.isFinite(v) && v > 0);
	}
});

test("短会话不虚拟化", () => {
	assert.equal(shouldVirtualizeTurnList(VIRTUAL_MIN_TURNS), false);
	assert.equal(shouldVirtualizeTurnList(VIRTUAL_MIN_TURNS + 1), true);
	assert.equal(shouldVirtualizeTurnList(Number.NaN), false);
});

test("高度：实测优先，未测量回落估值，非法值不采信", () => {
	const cache = new Map([
		["a", 400],
		["b", 0],
		["c", Number.NaN],
	]);
	assert.equal(resolveRunHeight(cache, "a"), 400);
	assert.equal(resolveRunHeight(cache, "b"), VIRTUAL_ESTIMATED_RUN_HEIGHT);
	assert.equal(resolveRunHeight(cache, "c"), VIRTUAL_ESTIMATED_RUN_HEIGHT);
	assert.equal(resolveRunHeight(cache, "missing"), VIRTUAL_ESTIMATED_RUN_HEIGHT);
});

const messageItem = (role, meta) => ({ kind: "message", message: { id: "m-" + role, role, text: "", timestamp: 0, ...(meta === undefined ? {} : { meta }) } });

test("可渲染判定：agent-run / user / error / 普通 system 都产出 DOM", () => {
	assert.equal(isRenderableRunItem({ kind: "agent-run", id: "run-0" }), true);
	assert.equal(isRenderableRunItem(messageItem("user")), true);
	assert.equal(isRenderableRunItem(messageItem("error")), true);
	// 普通 system 走 DiagnosticMessageCard（不是 null 分支）
	assert.equal(isRenderableRunItem(messageItem("system")), true);
	assert.equal(isRenderableRunItem(messageItem("system", { i18nKey: "diagnostic.requestFailed" })), true);
});

test("可渲染判定：renderRunItem 的 null 分支一律不产出 DOM", () => {
	// 非 agent-run / message 的中间分组不在时间线顶层
	for (const kind of ["tool-group", "thinking-group", "retry-group", "error-group", "extension-entries", "unknown-kind"]) {
		assert.equal(isRenderableRunItem({ kind, id: kind }), false, kind);
	}
	// 非 user / error / system 的 message
	assert.equal(isRenderableRunItem(messageItem("assistant")), false);
	// message 字段缺失（历史投影 / 异常数据）也不产出 DOM
	assert.equal(isRenderableRunItem({ kind: "message" }), false);
	assert.equal(isRenderableRunItem(messageItem(undefined)), false);
	// system 的占位与已下线的卡片
	assert.equal(isRenderableRunItem(messageItem("system", { type: "askQuestion" })), false);
	assert.equal(isRenderableRunItem(messageItem("system", { type: "compaction" })), false);
	// customMessage 只在通知白名单内渲染
	assert.equal(isRenderableRunItem(messageItem("system", { type: "customMessage" })), false);
	assert.equal(isRenderableRunItem(messageItem("system", { type: "customMessage", customType: "pi-deck-plan-mode-context" })), false);
	assert.equal(isRenderableRunItem(messageItem("system", { type: "customMessage", customType: "subagent-notify" })), true);
	// customEntry（扩展输出）照常渲染
	assert.equal(isRenderableRunItem(messageItem("system", { type: "customEntry" })), true);
	// 自动重试状态卡已收进过程行
	assert.equal(isRenderableRunItem(messageItem("system", { i18nKey: "diagnostic.retryScheduled" })), false);
	assert.equal(isRenderableRunItem(messageItem("system", { i18nKey: "diagnostic.retrySucceeded" })), false);
});

test("按轮切分：尾部 2 轮真实渲染，前面的 user 气泡一起留下", () => {
	const list = [
		{ id: "u0", kind: "user" },
		{ id: "r0", kind: "agent-run" },
		{ id: "u1", kind: "user" },
		{ id: "r1", kind: "agent-run" },
		{ id: "u2", kind: "user" },
		{ id: "r2", kind: "agent-run" },
		{ id: "u3", kind: "user" },
		{ id: "r3", kind: "agent-run" },
	];
	const split = splitVirtualRunsByTail(list, (item) => item.kind === "agent-run", 2, 2);
	// 从尾部数到第 2 个 run（r2，index 5），切点再前移到它前面的 user 条目 u2（index 4）
	assert.equal(split.solidStart, 4);
	assert.equal(split.virtualCount, 4);
	assert.equal(list[split.solidStart].id, "u2");
});

test("按轮切分：轮数不够阈值时全部真实渲染", () => {
	const list = [
		{ id: "u0", kind: "user" },
		{ id: "r0", kind: "agent-run" },
	];
	const split = splitVirtualRunsByTail(list, (i) => i.kind === "agent-run", 3, 8);
	assert.equal(split.virtualCount, 0);
	assert.equal(split.solidStart, 0);
});

test("按轮切分：尾部 run 数不足时全部真实渲染", () => {
	const list = [
		{ id: "r0", kind: "agent-run" },
		{ id: "r1", kind: "agent-run" },
	];
	const split = splitVirtualRunsByTail(list, (i) => i.kind === "agent-run", 3, 1);
	assert.equal(split.virtualCount, 0);
	assert.equal(split.solidStart, 0);
});

// ── 源码契约：虚拟区的「是否产出 DOM」判据必须与真实渲染同源 ──────────────────────────
// 为什么读源码而不是渲染组件：renderRunItem 是 SessionMessageTimeline 内部的闭包，没法单独
// 挂载；而两处判据一旦漂移，症状是「虚拟区多一个空 div（行距翻倍）」或「卡片在虚拟区静默
// 消失」，两者都不会让任何现有断言变红。这里把两侧的分支集合钉在源码上，改了就红。

const REPO_ROOT = new URL("../", import.meta.url);

function readRepoFile(relativePath) {
	return readFileSync(new URL(relativePath, REPO_ROOT), "utf8");
}

/** 抽出 renderRunItem 的函数体：从声明到组件顶层 return( 之前。 */
function sliceRenderRunItem(source) {
	const start = source.indexOf("const renderRunItem = ");
	assert.notEqual(start, -1, "SessionMessageTimeline.tsx 找不到 renderRunItem 声明");
	const end = source.indexOf("\n\treturn (\n", start);
	assert.notEqual(end, -1, "SessionMessageTimeline.tsx 找不到 renderRunItem 的结束边界");
	return source.slice(start, end);
}

/** 按 'if (meta?.type === "X") { ... }' 切块，记录该块是否无条件 return null。 */
function metaTypeNullBranches(body) {
	const branches = new Map();
	const pattern = /if \(meta\?\.type === "(\w+)"\) \{/g;
	let match = pattern.exec(body);
	while (match !== null) {
		const next = body.indexOf("if (", match.index + match[0].length);
		const chunk = body.slice(match.index, next === -1 ? body.length : next);
		branches.set(match[1], /return null;/.test(chunk));
		match = pattern.exec(body);
	}
	return branches;
}

test("源码契约：renderRunItem 的无条件 null 分支与 isRenderableRunItem 的 false 分支集合一致", () => {
	const timelineSource = readRepoFile("src/renderer/src/components/session/SessionMessageTimeline.tsx");
	const body = sliceRenderRunItem(timelineSource);
	const renderBranches = metaTypeNullBranches(body);
	assert.deepEqual(
		[...renderBranches]
			.filter(([, isNull]) => isNull)
			.map(([type]) => type)
			.sort(),
		["askQuestion", "compaction"],
		"renderRunItem 的无条件 null 分支变了：必须同步 isRenderableRunItem（否则虚拟区空 div 吃行距 / 卡片被裁）",
	);
	// 非 null 分支：policy 必须判 true，且判据来源不被替换
	assert.equal(renderBranches.get("customEntry"), false, "customEntry 由 ExtensionEntryCard 渲染，不是 null 分支");
	assert.equal(renderBranches.get("customMessage"), false, "customMessage 是三元（白名单卡片 / null），不是无条件 null 分支");

	const policySource = readRepoFile("src/renderer/src/components/session/timeline/virtualTimelinePolicy.ts");
	const policyFalseTypes = [...policySource.matchAll(/if \(meta\?\.type === "(\w+)"\) return false;/g)].map((match) => match[1]).sort();
	assert.deepEqual(policyFalseTypes, ["askQuestion", "compaction"], "isRenderableRunItem 的 meta.type false 分支与 renderRunItem 不再同源");

	// 重试状态卡：两侧都必须判「不产出 DOM」
	assert.match(body, /if \(isRetryStatusMessage\(message\)\) return null;/, "renderRunItem 的重试状态卡分支变了：虚拟区判据要同步");
	assert.match(policySource, /if \(isRetryStatusMessage\(message as ChatMessage\)\) return false;/, "isRenderableRunItem 的重试状态卡分支变了：真实渲染会与虚拟区分歧");
});

test("源码契约：customMessage 白名单在两侧共用 isNotifiableCustomType（单一真值）", () => {
	const cardSource = readRepoFile("src/renderer/src/components/session/NotifyMessageCard.tsx");
	assert.match(cardSource, /export function shouldRenderNotifyCard\(message: ChatMessage\): boolean \{\s*return isNotifiableCustomType\(message\.meta\?\.customType\);/, "shouldRenderNotifyCard 必须继续委托给 isNotifiableCustomType，否则虚拟区与真实渲染的通知卡片会分歧");
	const policySource = readRepoFile("src/renderer/src/components/session/timeline/virtualTimelinePolicy.ts");
	assert.match(policySource, /meta\?\.type === "customMessage"\) return isNotifiableCustomType\(meta\.customType\);/, "policy 的 customMessage 分支必须走同一白名单");
});
