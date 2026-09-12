import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	stabilizeProjectedIdsFromIdentities,
	stabilizeReloadedMessageIds,
} = loadTsCommonJs("src/main/pi/historyMessages.ts");
const { stoppedMessageFingerprint } = loadTsCommonJs("src/main/pi/stoppedMessageIdentity.ts");

/** 会话级身份摘要（stop/restart 时留存），与 Runtime 消息同内容。 */
function retainedIdentity(id, entryId, role, text, timestamp = 2_000_000) {
	return {
		id,
		...(entryId ? { entryId } : {}),
		role,
		timestamp,
		fingerprint: stoppedMessageFingerprint({ role, text }),
	};
}

/**
 * 压缩/attach 重连后动画重放回归测试。
 *
 * 背景：运行中会话的时间线消息 id 是事件版（randomUUID），压缩成功后
 * loadMessages 全量投影替换（id = agentId-history-entryId）→ 渲染层 React
 * key 全部变化 → 已渲染消息全部 remount → 回答入场/settle 动画重放
 * （视觉上「回复又被加载了一遍」）。
 *
 * 修复语义：按内容指纹把投影消息的 id 重写为旧缓存中同一条消息的 id
 * （时间容差内、一一消耗），保留投影的 entryId 等 meta；无旧匹配的新消息
 * （压缩摘要卡）保持投影 id。
 */

let seq = 0;
function runId() {
	seq += 1;
	return `run-${seq}`;
}

/** 投影身份消息（id = agentId-history-entryId，meta.entryId 存在）。 */
function projectedMessage(text, entryId, role = "assistant", extra = {}) {
	return {
		id: `agent-1-history-${entryId}`,
		agentId: "agent-1",
		role,
		text,
		timestamp: 2_000_000,
		meta: { entryId, _piDeckMsgSeq: 1 },
		...extra,
	};
}

/** 运行期身份消息（id = randomUUID 形态，无 entryId），与投影版同内容。 */
function runtimeMessage(text, role = "assistant", extra = {}) {
	return {
		id: runId(),
		agentId: "agent-1",
		role,
		text,
		timestamp: 2_000_000,
		...extra,
	};
}

test("压缩重载：同一条消息沿用事件版 id（渲染层 key 稳定，不 remount）", () => {
	// 压缩前时间线：事件版 id；压缩后投影：history id，内容一致
	const previous = [
		runtimeMessage("画一只猫", "user"),
		runtimeMessage("好的，我来画"),
	];
	const projected = [
		projectedMessage("画一只猫", "e1", "user"),
		projectedMessage("好的，我来画", "e2"),
	];
	const stabilized = stabilizeReloadedMessageIds(previous, projected);
	assert.deepEqual(
		stabilized.map((m) => m.id),
		[previous[0].id, previous[1].id],
		"投影消息必须沿用旧缓存的事件版 id",
	);
	assert.equal(stabilized[1].meta.entryId, "e2", "投影的 entryId 等 meta 必须保留");
});

test("压缩摘要卡（投影新增、无旧匹配）保持投影 id", () => {
	const previous = [
		runtimeMessage("画一只猫", "user"),
		runtimeMessage("好的，我来画"),
	];
	const summaryCard = {
		id: "agent-1-meta-1",
		agentId: "agent-1",
		role: "system",
		text: "前面的对话已压缩",
		timestamp: 2_100_000,
		meta: { type: "compaction" },
	};
	const projected = [
		summaryCard,
		projectedMessage("画一只猫", "e1", "user"),
		projectedMessage("好的，我来画", "e2"),
	];
	const stabilized = stabilizeReloadedMessageIds(previous, projected);
	assert.equal(stabilized[0].id, "agent-1-meta-1", "新卡片保持投影 id");
	assert.equal(stabilized[1].id, previous[0].id);
	assert.equal(stabilized[2].id, previous[1].id);
});

test("无旧缓存（首次加载）：投影原样返回", () => {
	const projected = [projectedMessage("h", "e1", "user")];
	const stabilized = stabilizeReloadedMessageIds([], projected);
	assert.deepEqual(stabilized, projected);
});

test("同文本高频消息（连发「继续」）一一消耗，不串位", () => {
	const previous = [
		runtimeMessage("继续", "user"),
		runtimeMessage("继续", "user"),
	];
	const projected = [
		projectedMessage("继续", "e1", "user"),
		projectedMessage("继续", "e2", "user"),
	];
	const stabilized = stabilizeReloadedMessageIds(previous, projected);
	assert.deepEqual(
		stabilized.map((m) => m.id),
		[previous[0].id, previous[1].id],
		"两条同文本消息各匹配各的旧 id",
	);
});

test("时间差远超容差 → 视为不同消息，不沿用旧 id", () => {
	const previous = [
		{ ...runtimeMessage("继续", "user"), timestamp: 1_000_000 },
	];
	const projected = [
		{ ...projectedMessage("继续", "e1", "user"), timestamp: 2_000_000 },
	];
	const stabilized = stabilizeReloadedMessageIds(previous, projected);
	assert.equal(stabilized[0].id, "agent-1-history-e1", "时间不匹配保持投影 id");
});

test("tool 消息按 toolCallId 指纹匹配（text 随状态变化不可靠）", () => {
	const previous = [
		runtimeMessage("▶ image_gen", "tool", {
			meta: { toolCallId: "tc-1", status: "running" },
		}),
	];
	const projected = [
		projectedMessage("✓ image_gen", "e1", "tool", {
			meta: { entryId: "e1", toolCallId: "tc-1" },
		}),
	];
	const stabilized = stabilizeReloadedMessageIds(previous, projected);
	assert.equal(stabilized[0].id, previous[0].id, "tool 消息沿用旧 id");
	assert.equal(stabilized[0].meta.entryId, "e1");
});

test("幂等：旧缓存已是投影版时重载不改变 id", () => {
	const previous = [
		projectedMessage("画一只猫", "e1", "user"),
		projectedMessage("好的，我来画", "e2"),
	];
	const projected = [
		projectedMessage("画一只猫", "e1", "user"),
		projectedMessage("好的，我来画", "e2"),
	];
	const stabilized = stabilizeReloadedMessageIds(previous, projected);
	assert.deepEqual(
		stabilized.map((m) => m.id),
		["agent-1-history-e1", "agent-1-history-e2"],
	);
});

test("压缩归档的旧消息（投影中已不存在）自然消失，不影响其余消息", () => {
	// 压缩前有 3 条消息，压缩后头部 1 条被归档：投影只剩 2 条
	const previous = [
		runtimeMessage("最早的问题", "user"),
		runtimeMessage("好的，我来画"),
		runtimeMessage("正在生成图片，请稍候…"),
	];
	const projected = [
		projectedMessage("好的，我来画", "e2"),
		projectedMessage("正在生成图片，请稍候…", "e3"),
	];
	const stabilized = stabilizeReloadedMessageIds(previous, projected);
	assert.equal(stabilized.length, 2, "被归档消息随投影消失");
	assert.equal(stabilized[0].id, previous[1].id);
	assert.equal(stabilized[1].id, previous[2].id);
});

// ── 会话级身份延续（runtime 换绑：重启/崩溃重连后窗口重下发不换 key）──

test("身份摘要按 entryId 还原投影 id（重启后窗口沿用旧 key）", () => {
	const identities = [
		retainedIdentity("agent-1-history-e1", "e1", "user", "画一只猫"),
	];
	const projected = [projectedMessage("画一只猫", "e1", "user")];
	const stabilized = stabilizeProjectedIdsFromIdentities(identities, projected);
	assert.equal(stabilized[0].id, "agent-1-history-e1", "同一条文件条目必须沿用旧 runtime 的 key");
	assert.equal(stabilized[0].meta.entryId, "e1", "投影的 entryId 等 meta 必须保留");
});

test("live 身份（无 entryId）按指纹 + 时间窗回退匹配（重启前未落投影的用户消息）", () => {
	// 2026-09 用户反馈的现场：用户消息只有 live id（requestId），重启清缓存时只剩身份摘要，
	// 新 runtime 投影（带 entryId）必须要能按正文指纹回接到那个 live id。
	const identities = [
		retainedIdentity("7daf81fe-a2a9-4fc9-88be-e09995b6fe43", undefined, "user", "看下这个文档"),
	];
	const projected = [projectedMessage("看下这个文档", "f5fa9312", "user")];
	const stabilized = stabilizeProjectedIdsFromIdentities(identities, projected);
	assert.equal(stabilized[0].id, "7daf81fe-a2a9-4fc9-88be-e09995b6fe43", "live id 必须被还原");
	assert.equal(stabilized[0].meta.entryId, "f5fa9312", "同时补上文件条目锚点");
});

test("entryId 匹配不做时间二次校验：正文改写/久远捕获仍沿用同一 key", () => {
	// entryId 是文件条目的稳定身份（编辑只改正文不改 id），时间差再大也复用旧 key，
	// 避免「消息明明没变，重启后 key 却换了」；只有无 entryId 的指纹回退才看时间容差。
	const identities = [
		retainedIdentity("stale-id", "e1", "user", "继续", 1_000_000),
	];
	const projected = [projectedMessage("继续", "e1", "user")];
	const stabilized = stabilizeProjectedIdsFromIdentities(identities, projected);
	assert.equal(stabilized[0].id, "stale-id", "entryId 匹配不因时间超差而放弃");
});

test("指纹回退（无 entryId 的 live 身份）时间超容差 → 保持投影 id", () => {
	const identities = [
		retainedIdentity("live-stale", undefined, "user", "继续", 1_000_000),
	];
	const projected = [projectedMessage("继续", "e1", "user")];
	const stabilized = stabilizeProjectedIdsFromIdentities(identities, projected);
	assert.equal(stabilized[0].id, "agent-1-history-e1", "时间不匹配不沿用旧 key");
});

test("同一身份只能消耗一次：同文本两条投影只还原第一条", () => {
	// 连发「继续」：稍早捕获的那条身份与先出现的投影配对，第二条保持投影 id
	const identities = [
		retainedIdentity("live-1", undefined, "user", "继续", 2_000_000),
	];
	const projected = [
		projectedMessage("继续", "e1", "user"),
		projectedMessage("继续", "e2", "user"),
	];
	const stabilized = stabilizeProjectedIdsFromIdentities(identities, projected);
	assert.equal(stabilized[0].id, "live-1", "第一条按指纹还原");
	assert.equal(stabilized[1].id, "agent-1-history-e2", "第二条没有可用身份，保持投影 id");
});

test("同一文件条目多次捕获时后捕获优先（UI 当前展示的 id 胜出）", () => {
	const identities = [
		retainedIdentity("agent-1-history-e1", "e1", "user", "画一只猫"),
		retainedIdentity("agent-2-history-e1", "e1", "user", "画一只猫"),
	];
	const projected = [projectedMessage("画一只猫", "e1", "user")];
	const stabilized = stabilizeProjectedIdsFromIdentities(identities, projected);
	assert.equal(stabilized[0].id, "agent-2-history-e1", "后捕获（最新 runtime）的 id 优先");
});

test("无身份摘要或没有匹配：投影原样返回", () => {
	const projected = [projectedMessage("h", "e1", "user")];
	assert.deepEqual(stabilizeProjectedIdsFromIdentities([], projected), projected);
	const identities = [retainedIdentity("x", "e9", "user", "别的消息")];
	assert.equal(stabilizeProjectedIdsFromIdentities(identities, projected)[0].id, "agent-1-history-e1");
});
