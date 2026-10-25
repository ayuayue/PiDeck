import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createPromptLoadout, applyPromptMessage, resetPromptLoadoutFromSnapshot, estimatePromptLoadoutTokens, hasMeasuredPromptLoadout } = loadTsCommonJs("src/main/pi/promptLoadout.ts");

/**
 * 提示词装载重放（promptLoadout）：
 * pi 会话文件里的系统消息条目承载「模型当前看到的提示词」（sections 按节名打补丁、
 * null 删除；工具用 toolsAdded/toolsRemoved 增量维护），compaction 条目上的
 * systemMessage 是压缩边界处的完整快照。
 *
 * 这是「系统 / 工具」两段的唯一数据源：过去它们由「总占用 − 对话估算」反推，
 * 估算误差会把反推值打到 0（用户看到「系统 + 工具 ~0」），所以这里锁住重放语义。
 */

function systemLine({ content, sections, toolsAdded, toolsRemoved } = {}) {
	return {
		role: "system",
		...(content !== undefined ? { content } : {}),
		...(sections !== undefined ? { sections } : {}),
		...(toolsAdded !== undefined ? { toolsAdded } : {}),
		...(toolsRemoved !== undefined ? { toolsRemoved } : {}),
	};
}

function sectionTokens(state) {
	return estimatePromptLoadoutTokens(state).systemTokens;
}

/** 把 Map 摊平成「名=值」字符串数组：vm 沙箱里的 Map 迭代器返回的是别的 realm 的数组，
 *  deepStrictEqual 会比原型，直接用字符串比较避免跨 realm 假失败。 */
function pairs(map) {
	return [...map.entries()].map(([name, text]) => `${name}=${text}`);
}

test("applyPromptMessage: 提示词各节按名补齐，null 删除该节", () => {
	const loadout = createPromptLoadout();
	applyPromptMessage(loadout, systemLine({ sections: { preamble: "aaaa", rules: "bbbb" } }));
	assert.deepEqual([...loadout.sections.keys()], ["preamble", "rules"]);

	// 后续系统消息只补变化的部分：新节加入、null 删除已有节
	applyPromptMessage(loadout, systemLine({ sections: { rules: null, docs: "cccc" } }));
	assert.deepEqual(pairs(loadout.sections), ["preamble=aaaa", "docs=cccc"]);
});

test("applyPromptMessage: 非系统角色与畸形条目忽略，不抛错", () => {
	const loadout = createPromptLoadout();
	applyPromptMessage(loadout, { role: "user", content: "hi", sections: { preamble: "aaaa" } });
	applyPromptMessage(loadout, null);
	applyPromptMessage(loadout, "system");
	applyPromptMessage(loadout, { role: "system", sections: { preamble: 42, ok: "bbbb" } });
	assert.deepEqual(pairs(loadout.sections), ["ok=bbbb"]);
	assert.equal(estimatePromptLoadoutTokens(loadout).toolsTokens, 0);
});

test("applyPromptMessage: 工具声明按 toolsAdded 覆盖、toolsRemoved 删除（支持名字字符串形态）", () => {
	const loadout = createPromptLoadout();
	const readTool = { name: "read", description: "read files", parameters: { type: "object" } };
	applyPromptMessage(loadout, systemLine({ toolsAdded: [readTool, { name: "bash", description: "run" }] }));
	assert.deepEqual([...loadout.tools.keys()], ["read", "bash"]);

	// 同名工具重定义 → 覆盖（不重复计量）
	applyPromptMessage(loadout, systemLine({ toolsAdded: [{ name: "read", description: "read files v2" }] }));
	assert.equal(loadout.tools.get("read").description, "read files v2");
	assert.deepEqual([...loadout.tools.keys()], ["read", "bash"]);

	applyPromptMessage(loadout, systemLine({ toolsRemoved: [{ name: "bash" }, "read"] }));
	assert.deepEqual([...loadout.tools.keys()], []);
	assert.equal(estimatePromptLoadoutTokens(loadout).toolsTokens, 0);
});

test("estimatePromptLoadoutTokens: 系统段=各节+content，工具段=声明 JSON；中文按 CJK 加权", () => {
	const loadout = createPromptLoadout();
	applyPromptMessage(loadout, systemLine({ content: "", sections: { preamble: "abcd" } }));
	const stable = sectionTokens(loadout);
	assert.equal(stable, 1); // 4 个非中文字符 ÷4

	// 中文字符按 1.5 字/token：3 个汉字 → 2（向上取整）
	applyPromptMessage(loadout, systemLine({ sections: { rules: "中文规则" } }));
	assert.equal(sectionTokens(loadout) - stable, 3);

	// content 字段（老格式承载提示词）也计入系统段
	applyPromptMessage(loadout, systemLine({ content: "abcdefgh" }));
	// 1（abcd）+ 3（中文规则）+ 2（content: abcdefgh）
	assert.equal(sectionTokens(loadout), 1 + 3 + 2);

	applyPromptMessage(loadout, systemLine({ toolsAdded: [{ name: "read", description: "read files here" }] }));
	assert.ok(estimatePromptLoadoutTokens(loadout).toolsTokens > 0);
});

test("hasMeasuredPromptLoadout: 空装载不算测量值（不能当成系统/工具为 0）", () => {
	const empty = createPromptLoadout();
	assert.equal(hasMeasuredPromptLoadout(empty), false);

	// 只有删除补丁（目标节本来就不存在）：装载仍为空 → 依然不算测量值
	applyPromptMessage(empty, systemLine({ sections: { preamble: null } }));
	assert.equal(hasMeasuredPromptLoadout(empty), false);

	applyPromptMessage(empty, systemLine({ sections: { preamble: "text" } }));
	assert.equal(hasMeasuredPromptLoadout(empty), true);

	const toolsOnly = createPromptLoadout();
	applyPromptMessage(toolsOnly, systemLine({ toolsAdded: [{ name: "read", description: "read" }] }));
	assert.equal(hasMeasuredPromptLoadout(toolsOnly), true);
});

test("resetPromptLoadoutFromSnapshot: 压缩快照整体替换提示词与工具（不再叠加压缩前的节）", () => {
	const loadout = createPromptLoadout();
	applyPromptMessage(loadout, systemLine({ sections: { preamble: "old prompt text", stale: "keep?" }, toolsAdded: [{ name: "old-tool", description: "x".repeat(40) }] }));

	resetPromptLoadoutFromSnapshot(loadout, { role: "system", content: "", sections: { preamble: "new prompt text" }, toolsAdded: [{ name: "read", description: "read" }] });
	assert.deepEqual([...loadout.sections.keys()], ["preamble"]);
	assert.deepEqual([...loadout.tools.keys()], ["read"]);

	// 快照之后仍继续应用后续补丁
	applyPromptMessage(loadout, systemLine({ sections: { skills: "skills text", preamble: null } }));
	assert.deepEqual([...loadout.sections.keys()], ["skills"]);
});

test("resetPromptLoadoutFromSnapshot: 缺 systemMessage 的老会话（或部分字段）保持原装载", () => {
	const loadout = createPromptLoadout();
	applyPromptMessage(loadout, systemLine({ sections: { preamble: "keep me" }, toolsAdded: [{ name: "read", description: "read" }] }));

	resetPromptLoadoutFromSnapshot(loadout, undefined);
	resetPromptLoadoutFromSnapshot(loadout, null);
	// 只有 sections 没有 toolsAdded（部分快照）：工具补齐，提示词替换
	resetPromptLoadoutFromSnapshot(loadout, { role: "system", sections: { preamble: "from snapshot" } });
	assert.deepEqual(pairs(loadout.sections), ["preamble=from snapshot"]);
	assert.deepEqual([...loadout.tools.keys()], ["read"]);
});
