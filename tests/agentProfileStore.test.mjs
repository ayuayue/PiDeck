import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
test("usage 计数落盘合并：窗口内多次 recordUsage 只写一轮盘，flush 后完整持久化（2027-02 写放大治理）", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		const created = await store.create({ name: "计数助手", systemPrompt: "设定", category: "writing" }, 2_000);
		await store.flushPendingUsage();
		const before = await readFile(filePath, "utf8");
		// 合并窗口内连打 5 次计数：内存态立即可见，磁盘不动
		for (let index = 0; index < 5; index += 1) {
			await store.recordUsage(created.id, 3_000 + index);
		}
		assert.equal(store.getSnapshot().agents.find((agent) => agent.id === created.id).usageCount, 5, "内存态立即累加（UI 排序即时）");
		assert.equal(await readFile(filePath, "utf8"), before, "窗口未到期不得写盘");
		await store.flushPendingUsage();
		const persisted = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(persisted.agents.find((agent) => agent.id === created.id).usageCount, 5, "flush 后一次性落盘最终计数");
	});
});

const { AgentProfileStore } = loadTsCommonJs("src/main/agents/AgentProfileStore.ts");
const { BUILTIN_AGENT_SEED_CREATED_AT, getBuiltinSeed } = loadTsCommonJs("src/main/agents/builtinAgents.ts");
const { AGENT_PROFILE_DESCRIPTION_MAX_CHARS, AGENT_PROFILE_ICON_MAX_CHARS, AGENT_PROFILE_NAME_MAX_CHARS, AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS, BUILTIN_TRANSLATE_AGENT_ID } = loadTsCommonJs("src/shared/types.ts");

/** 每个用例一份独立的临时 userData 目录：store 只认注入的 filePath，互不干扰。 */
async function withStore(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-agent-profiles-"));
	const filePath = join(dir, "agent-profiles.json");
	try {
		await run({ dir, filePath });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function readPersisted(filePath) {
	return readFile(filePath, "utf8").then((raw) => JSON.parse(raw));
}

/** 生产模块在 vm 沙箱里创建的对象原型属于另一个 realm，深度比较前转成本 realm 的普通对象。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("load seeds the builtin translation agent on a fresh profile file", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		const snapshot = await store.load(1_000);
		assert.equal(snapshot.agents.length, 4);
		const [translate] = snapshot.agents;
		// PiDeck 相关内置智能体：小助手 / 问题诊断 / 插件开发（提示词是产品内容，不是 UI 文案）。
		const pideck = snapshot.agents.filter((agent) => agent.id.startsWith("builtin-pideck-"));
		assert.deepEqual(
			Array.from(pideck, (agent) => agent.id),
			["builtin-pideck-helper", "builtin-pideck-diagnostic", "builtin-pideck-plugin-dev"],
		);
		assert.deepEqual(
			Array.from(pideck, (agent) => agent.name),
			["PiDeck 小助手", "PiDeck 问题诊断助手", "PiDeck 插件开发助手"],
		);
		for (const agent of pideck) {
			assert.equal(agent.builtin, true);
			assert.ok(agent.systemPrompt.length > 2_000, agent.id + " 的提示词必须足够完整");
			assert.ok(agent.systemPrompt.length < AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS);
		}
		const seed = getBuiltinSeed(BUILTIN_TRANSLATE_AGENT_ID);
		assert.equal(translate.id, BUILTIN_TRANSLATE_AGENT_ID);
		assert.equal(translate.name, "翻译官");
		assert.equal(translate.icon, "🌐");
		assert.equal(translate.category, "translation");
		assert.equal(translate.builtin, true);
		assert.equal(translate.description, "把任意语言的专业文本翻译成目标语言，保留格式与术语");
		assert.equal(translate.systemPrompt, seed.systemPrompt);
		assert.equal(translate.createdAt, BUILTIN_AGENT_SEED_CREATED_AT);
		assert.equal(translate.usageCount, 0);
		assert.deepEqual(plain(snapshot.settings), { selectionToolEnabled: true, systemSelectionEnabled: false, selectionToolAgentId: null, sessionAgentBindings: {} });
		// 角色设定必须覆盖产品要求的每条规则（方向判定 / 只输出译文 / 格式保真 / 术语 / 单词多义）。
		assert.match(translate.systemPrompt, /只输出译文/);
		assert.match(translate.systemPrompt, /原文是中文 → 译为英文/);
		assert.match(translate.systemPrompt, /原文是其他语言 → 译为简体中文/);
		assert.match(translate.systemPrompt, /Markdown/);
		assert.match(translate.systemPrompt, /API、SDK/);
		assert.match(translate.systemPrompt, /“；”/);
		// 种子本身已落盘，重启不再依赖内存补种。
		const persisted = await readPersisted(filePath);
		assert.equal(persisted.version, 1);
		assert.equal(persisted.agents.length, 4);
	});
});

test("create/update/delete bump revision, emit changed events, and keep unspecified fields", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		const events = [];
		const unsubscribe = store.onChanged((event) => events.push(event.revision));

		const created = await store.create({ name: " 代码审查员 ", description: " 查 bug ", systemPrompt: " 你是审查员 ", category: "coding" }, 2_000);
		assert.equal(created.name, "代码审查员");
		assert.equal(created.description, "查 bug");
		assert.equal(created.systemPrompt, "你是审查员");
		assert.equal(created.category, "coding");
		assert.equal(created.createdAt, 2_000);
		assert.equal(created.updatedAt, 2_000);
		assert.equal(created.usageCount, 0);
		assert.equal(store.getSnapshot().revision, 1);
		assert.deepEqual(events, [1]);

		const updated = await store.update(created.id, { name: "高级审查员", description: "" }, 3_000);
		assert.equal(updated.name, "高级审查员");
		assert.equal(updated.description, "");
		assert.equal(updated.systemPrompt, "你是审查员");
		assert.equal(updated.createdAt, 2_000);
		assert.equal(updated.updatedAt, 3_000);
		assert.equal(store.getSnapshot().revision, 2);

		const patched = await store.update(created.id, { icon: "🔍" }, 3_500);
		assert.equal(patched.name, "高级审查员");
		assert.equal(patched.icon, "🔍");
		assert.equal(store.getSnapshot().revision, 3);

		assert.equal(await store.delete(created.id), true);
		assert.equal(store.get(created.id), undefined);
		assert.equal(store.list().length, 4);
		assert.equal(store.getSnapshot().revision, 4);
		assert.deepEqual(events, [1, 2, 3, 4]);

		unsubscribe();
		await store.update(BUILTIN_TRANSLATE_AGENT_ID, { icon: "🛠" });
		assert.deepEqual(events, [1, 2, 3, 4]);
		await assert.rejects(() => store.update("missing", { name: "x" }), /Agent not found: missing/);
	});
});

test("builtin agents cannot be deleted and can be reset to the seed after edits", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		const revisionBefore = store.getSnapshot().revision;
		assert.equal(await store.delete(BUILTIN_TRANSLATE_AGENT_ID), false);
		assert.equal(store.get(BUILTIN_TRANSLATE_AGENT_ID).name, "翻译官");
		assert.equal(store.getSnapshot().revision, revisionBefore);

		const edited = await store.update(BUILTIN_TRANSLATE_AGENT_ID, { name: "我的翻译", systemPrompt: "自定义设定", icon: "🈯" }, 2_000);
		assert.equal(edited.name, "我的翻译");
		assert.equal(edited.builtin, true);

		const seed = getBuiltinSeed(BUILTIN_TRANSLATE_AGENT_ID);
		const restored = await store.resetBuiltin(BUILTIN_TRANSLATE_AGENT_ID, 3_000);
		assert.equal(restored.name, seed.name);
		assert.equal(restored.systemPrompt, seed.systemPrompt);
		assert.equal(restored.icon, seed.icon);
		assert.equal(restored.createdAt, BUILTIN_AGENT_SEED_CREATED_AT);
		assert.equal(restored.updatedAt, 3_000);

		await assert.rejects(() => store.resetBuiltin("missing"), /Agent not found: missing/);
		const custom = await store.create({ name: "自定义", systemPrompt: "设定" }, 4_000);
		await assert.rejects(() => store.resetBuiltin(custom.id), /not builtin/);
		await assert.rejects(() => store.duplicate("missing"), /Agent not found: missing/);
	});
});

test("duplicate copies content with a unique name and drops builtin identity", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		const source = await store.create({ name: "分析师", description: "分析文本", systemPrompt: "你是分析师", category: "analysis", model: { provider: "anthropic", modelId: "claude" } }, 2_000);
		await store.recordUsage(source.id, 2_500);

		const copy = await store.duplicate(source.id, 3_000);
		assert.notEqual(copy.id, source.id);
		assert.equal(copy.name, "分析师 (2)");
		assert.equal(copy.systemPrompt, "你是分析师");
		assert.equal(copy.category, "analysis");
		assert.deepEqual(plain(copy.model), { provider: "anthropic", modelId: "claude" });
		assert.equal(copy.builtin, undefined);
		assert.equal(copy.usageCount, 0);
		assert.equal(copy.createdAt, 3_000);

		// 连续复制同一份：序号递增，不覆盖已有名字。
		assert.equal((await store.duplicate(source.id, 4_000)).name, "分析师 (3)");
		const builtinCopy = await store.duplicate(BUILTIN_TRANSLATE_AGENT_ID, 5_000);
		assert.equal(builtinCopy.name, "翻译官 (2)");
		assert.equal(builtinCopy.builtin, undefined);
		// 副本是普通智能体，可删除；源仍在。
		assert.equal(await store.delete(copy.id), true);
		assert.notEqual(store.get(source.id), undefined);
	});
});

test("load normalizes malformed persisted agents instead of failing", async () => {
	await withStore(async ({ filePath }) => {
		const payload = {
			version: 1,
			revision: 7,
			settings: { selectionToolEnabled: "yes", selectionToolAgentId: "ghost" },
			agents: [
				{
					id: "agent-a",
					name: "名".repeat(AGENT_PROFILE_NAME_MAX_CHARS + 20),
					description: "描".repeat(AGENT_PROFILE_DESCRIPTION_MAX_CHARS + 5),
					icon: "🌐".repeat(10),
					systemPrompt: "提".repeat(AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS + 100),
					category: "unknown-category",
					model: { provider: "p", modelId: "" },
					createdAt: 100,
					updatedAt: 90,
					usageCount: -3,
					extraField: "ignored",
				},
				{ id: "agent-a", name: "重复 id" },
				{ name: "没有 id" },
				{ id: "agent-b", name: "有模型", systemPrompt: "设定", category: "writing", model: { provider: "openai", modelId: "gpt" }, usageCount: 2.7, lastUsedAt: 500 },
			],
		};
		await writeFile(filePath, JSON.stringify(payload), "utf8");
		const store = new AgentProfileStore(filePath);
		const snapshot = await store.load(6_000);

		const seenA = snapshot.agents.filter((agent) => agent.id === "agent-a");
		assert.equal(seenA.length, 1);
		const agentA = seenA[0];
		assert.equal(agentA.name.length, AGENT_PROFILE_NAME_MAX_CHARS);
		assert.equal(agentA.description.length, AGENT_PROFILE_DESCRIPTION_MAX_CHARS);
		assert.equal(agentA.icon.length, AGENT_PROFILE_ICON_MAX_CHARS);
		assert.equal(agentA.systemPrompt.length, AGENT_PROFILE_SYSTEM_PROMPT_MAX_CHARS);
		assert.equal(agentA.category, "general");
		assert.equal(agentA.model, undefined);
		assert.equal(agentA.usageCount, 0);
		assert.equal(agentA.updatedAt, 100);
		assert.equal(agentA.extraField, undefined);

		const agentB = snapshot.agents.find((agent) => agent.id === "agent-b");
		assert.deepEqual(plain(agentB.model), { provider: "openai", modelId: "gpt" });
		assert.equal(agentB.usageCount, 2);
		assert.equal(agentB.lastUsedAt, 500);

		assert.deepEqual(plain(snapshot.settings), { selectionToolEnabled: true, systemSelectionEnabled: false, selectionToolAgentId: null, sessionAgentBindings: {} });
		assert.equal(snapshot.revision, 7);
		assert.equal(snapshot.agents.filter((agent) => agent.id === BUILTIN_TRANSLATE_AGENT_ID).length, 1);
		// 归一化结果写回磁盘：未知键与坏值不再出现。
		const persisted = await readPersisted(filePath);
		assert.equal(persisted.agents.find((agent) => agent.id === "agent-a").extraField, undefined);
		assert.equal(persisted.settings.selectionToolAgentId, null);
	});
});

test("load recovers from corrupted JSON with an empty state plus the builtin seed", async () => {
	await withStore(async ({ filePath }) => {
		await writeFile(filePath, "{ this is not json", "utf8");
		const store = new AgentProfileStore(filePath);
		const snapshot = await store.load(1_000);
		assert.equal(snapshot.revision, 0);
		assert.deepEqual(plain(snapshot.settings), { selectionToolEnabled: true, systemSelectionEnabled: false, selectionToolAgentId: null, sessionAgentBindings: {} });
		assert.equal(snapshot.agents.length, 4);
		assert.equal(snapshot.agents[0].id, BUILTIN_TRANSLATE_AGENT_ID);
		assert.equal((await readPersisted(filePath)).agents.length, 4);
	});
});

test("settings updates persist and a deleted default agent clears the dangling selection", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		const agent = await store.create({ name: "我的翻译", systemPrompt: "设定" }, 2_000);

		const settings = await store.updateSettings({ selectionToolEnabled: false, selectionToolAgentId: agent.id });
		assert.deepEqual(plain(settings), { selectionToolEnabled: false, systemSelectionEnabled: false, selectionToolAgentId: agent.id, sessionAgentBindings: {} });
		assert.deepEqual(plain(store.getSnapshot().settings), plain(settings));

		// store 层容错：未知默认智能体回退 null（IPC 边界会先抛 Agent not found，不静默）。
		assert.deepEqual(plain(await store.updateSettings({ selectionToolAgentId: "ghost" })), { selectionToolEnabled: false, systemSelectionEnabled: false, selectionToolAgentId: null, sessionAgentBindings: {} });

		await store.updateSettings({ selectionToolAgentId: agent.id });
		assert.equal(await store.delete(agent.id), true);
		assert.deepEqual(plain(store.getSnapshot().settings), { selectionToolEnabled: false, systemSelectionEnabled: false, selectionToolAgentId: null, sessionAgentBindings: {} });
		assert.equal((await readPersisted(filePath)).settings.selectionToolAgentId, null);
	});
});

test("load keeps a selection that points at a re-seeded builtin agent", async () => {
	await withStore(async ({ filePath }) => {
		await writeFile(filePath, JSON.stringify({ version: 1, revision: 2, settings: { selectionToolEnabled: true, selectionToolAgentId: BUILTIN_TRANSLATE_AGENT_ID }, agents: [{ id: "custom", name: "自定义", systemPrompt: "设定" }] }), "utf8");
		const store = new AgentProfileStore(filePath);
		const snapshot = await store.load(1_000);
		assert.equal(snapshot.agents.length, 5);
		assert.equal(snapshot.settings.selectionToolAgentId, BUILTIN_TRANSLATE_AGENT_ID);
	});
});

test("recordUsage increments usageCount and lastUsedAt and ignores unknown ids", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		const revisionBefore = store.getSnapshot().revision;
		await store.recordUsage("missing", 2_000);
		assert.equal(store.getSnapshot().revision, revisionBefore);

		await store.recordUsage(BUILTIN_TRANSLATE_AGENT_ID, 2_000);
		await store.recordUsage(BUILTIN_TRANSLATE_AGENT_ID, 3_000);
		const translate = store.get(BUILTIN_TRANSLATE_AGENT_ID);
		assert.equal(translate.usageCount, 2);
		assert.equal(translate.lastUsedAt, 3_000);
		assert.equal(store.getSnapshot().revision, revisionBefore + 2);
	});
});

test("profile changes persist across store instances without duplicating the builtin seed", async () => {
	await withStore(async ({ filePath }) => {
		const first = new AgentProfileStore(filePath);
		await first.load(1_000);
		const created = await first.create({ name: "写作助手", systemPrompt: "你是写作助手", category: "writing" }, 2_000);
		await first.updateSettings({ selectionToolAgentId: created.id });
		await first.recordUsage(created.id, 3_000);
		// 2027-02 起 usage 计数带 1s 落盘合并窗口（写放大治理）：跨实例校验前先收尾，
		// 生产路径由 quitCleanup("agent-profile-store") 与普通编辑 mutate() 负责 flush。
		await first.flushPendingUsage();
		const revision = first.getSnapshot().revision;

		const second = new AgentProfileStore(filePath);
		const snapshot = await second.load(4_000);
		assert.equal(snapshot.revision, revision);
		assert.equal(snapshot.agents.filter((agent) => agent.id === BUILTIN_TRANSLATE_AGENT_ID).length, 1);
		const restored = snapshot.agents.find((agent) => agent.id === created.id);
		assert.equal(restored.name, "写作助手");
		assert.equal(restored.category, "writing");
		assert.equal(restored.createdAt, 2_000);
		assert.equal(restored.usageCount, 1);
		assert.equal(restored.lastUsedAt, 3_000);
		assert.equal(snapshot.settings.selectionToolAgentId, created.id);
	});
});

test("load never overwrites a user-edited builtin agent", async () => {
	await withStore(async ({ filePath }) => {
		const first = new AgentProfileStore(filePath);
		await first.load(1_000);
		await first.update(BUILTIN_TRANSLATE_AGENT_ID, { name: "我的翻译官", systemPrompt: "自定义角色设定" }, 2_000);
		const second = new AgentProfileStore(filePath);
		const snapshot = await second.load(3_000);
		const translate = snapshot.agents.find((agent) => agent.id === BUILTIN_TRANSLATE_AGENT_ID);
		assert.equal(translate.name, "我的翻译官");
		assert.equal(translate.systemPrompt, "自定义角色设定");
		assert.equal(translate.builtin, true);
	});
});

test("a clean file is not rewritten and the revision does not drift on reload", async () => {
	await withStore(async ({ filePath }) => {
		const first = new AgentProfileStore(filePath);
		await first.load(1_000);
		const stable = await readFile(filePath, "utf8");
		const second = new AgentProfileStore(filePath);
		const snapshot = await second.load(2_000);
		assert.equal(snapshot.revision, 0);
		assert.equal(await readFile(filePath, "utf8"), stable);
	});
});

test("model references are normalized on create/update and clearable", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		const created = await store.create({ name: "带模型", systemPrompt: "设定", model: { provider: "openai", modelId: "gpt" } }, 2_000);
		assert.deepEqual(plain(created.model), { provider: "openai", modelId: "gpt" });

		// null = 清空首选模型（跟随会话模型）。
		assert.equal((await store.update(created.id, { model: null }, 3_000)).model, undefined);
		// 缺键 = 保留原值。
		const restored = await store.update(created.id, { model: { provider: "anthropic", modelId: "claude" } }, 4_000);
		assert.deepEqual(plain(restored.model), { provider: "anthropic", modelId: "claude" });
		assert.deepEqual(plain((await store.update(created.id, { name: "改名" }, 5_000)).model), { provider: "anthropic", modelId: "claude" });
		// 半截引用视同「未设置」，绝不落盘半个 provider/modelId。
		assert.equal((await store.update(created.id, { model: { provider: "anthropic", modelId: "  " } }, 6_000)).model, undefined);
	});
});

test("create rejects blank required fields at the store boundary", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		await assert.rejects(() => store.create({ name: "  ", systemPrompt: "设定" }), /Agent name is required/);
		await assert.rejects(() => store.create({ name: "名字", systemPrompt: "" }), /Agent system prompt is required/);
		assert.equal(store.list().length, 4);
	});
});

test("reads return deep copies that cannot mutate the store", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		const list = store.list();
		list[0].name = "被外部改掉";
		list.push({ id: "ghost" });
		const snapshot = store.getSnapshot();
		snapshot.agents[0].name = "被外部改掉";
		snapshot.settings.selectionToolEnabled = false;
		assert.equal(store.list().length, 4);
		assert.equal(store.get(BUILTIN_TRANSLATE_AGENT_ID).name, "翻译官");
		assert.equal(store.getSnapshot().settings.selectionToolEnabled, true);
	});
});

test("agent backend is whitelisted, persisted, and clearable", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		const created = await store.create({ name: "DSH 助手", systemPrompt: "设定", backend: "dsh" }, 2_000);
		assert.equal(created.backend, "dsh");
		assert.equal((await readPersisted(filePath)).agents.find((agent) => agent.id === created.id).backend, "dsh");

		// 缺键 = 保留原值；null = 清除（跟随默认后端）。
		assert.equal((await store.update(created.id, { name: "改名" }, 3_000)).backend, "dsh");
		assert.equal((await store.update(created.id, { backend: null }, 4_000)).backend, undefined);
		assert.equal((await store.update(created.id, { backend: "pi" }, 5_000)).backend, "pi");
		// 显式 undefined（编辑器「跟随默认」用 own key + undefined 表达清除）与 null 同义。
		assert.equal((await store.update(created.id, { backend: undefined }, 6_000)).backend, undefined);

		// store 层容错：白名单外的值静默丢弃（IPC 边界会先拒绝）。
		const bad = await store.create({ name: "脏数据", systemPrompt: "设定", backend: "acp" }, 7_000);
		assert.equal(bad.backend, undefined);

		// 副本保留后端，恢复内置原文则回到「跟随默认」。
		await store.update(created.id, { backend: "dsh" }, 8_000);
		const copy = await store.duplicate(created.id, 9_000);
		assert.equal(copy.backend, "dsh");
	});
});

test("load drops a persisted backend outside the pi/dsh whitelist", async () => {
	await withStore(async ({ filePath }) => {
		const agents = [
			{ id: "keep-dsh", name: "DSH", systemPrompt: "设定", backend: "dsh" },
			{ id: "drop-acp", name: "ACP", systemPrompt: "设定", backend: "acp" },
			{ id: "drop-number", name: "数值", systemPrompt: "设定", backend: 3 },
		];
		await writeFile(filePath, JSON.stringify({ version: 1, revision: 1, settings: {}, agents }), "utf8");
		const store = new AgentProfileStore(filePath);
		const snapshot = await store.load(1_000);
		assert.equal(snapshot.agents.find((agent) => agent.id === "keep-dsh").backend, "dsh");
		assert.equal(snapshot.agents.find((agent) => agent.id === "drop-acp").backend, undefined);
		assert.equal(snapshot.agents.find((agent) => agent.id === "drop-number").backend, undefined);
	});
});

test("bindSession binds/unbinds a session, returns the full settings, and bumps revision", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		const agent = await store.create({ name: "审查员", systemPrompt: "你是审查员" }, 2_000);
		const events = [];
		store.onChanged((event) => events.push(event.revision));
		const revisionBefore = store.getSnapshot().revision;

		const settings = await store.bindSession({ sessionId: "session-a", agentId: agent.id });
		assert.deepEqual(plain(settings.sessionAgentBindings), { "session-a": agent.id });
		assert.equal(settings.selectionToolEnabled, true);
		assert.equal(settings.systemSelectionEnabled, false);
		assert.equal(settings.selectionToolAgentId, null);
		assert.equal(store.getSnapshot().revision, revisionBefore + 1);
		assert.deepEqual(events, [revisionBefore + 1]);
		assert.equal(store.getBoundAgent("session-a")?.id, agent.id);
		assert.equal(store.getBoundAgent("session-b"), undefined);

		const unbound = await store.bindSession({ sessionId: "session-a", agentId: null });
		assert.deepEqual(plain(unbound.sessionAgentBindings), {});
		assert.equal(store.getBoundAgent("session-a"), undefined);
		assert.equal(store.getSnapshot().revision, revisionBefore + 2);

		await assert.rejects(() => store.bindSession({ sessionId: "session-a", agentId: "missing" }), /Agent not found: missing/);
		await assert.rejects(() => store.bindSession({ sessionId: "  ", agentId: agent.id }), /Invalid session id/);
		await assert.rejects(() => store.bindSession({ sessionId: "s".repeat(201), agentId: agent.id }), /Invalid session id/);
		await assert.rejects(() => store.bindSession({ sessionId: "session\na", agentId: agent.id }), /Invalid session id/);
		await assert.rejects(() => store.bindSession({ sessionId: "session-a", agentId: "" }), /Invalid agent id/);
		await assert.rejects(() => store.bindSession({ sessionId: "session-a", agentId: "a\nb" }), /Invalid agent id/);
		// 失败不写盘、不推进 revision。
		assert.equal(store.getSnapshot().revision, revisionBefore + 2);
	});
});

test("deleting an agent prunes session bindings that pointed to it", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		const removed = await store.create({ name: "待删", systemPrompt: "设定" }, 2_000);
		const kept = await store.create({ name: "保留", systemPrompt: "设定" }, 2_000);
		await store.bindSession({ sessionId: "session-a", agentId: removed.id });
		await store.bindSession({ sessionId: "session-b", agentId: kept.id });
		await store.bindSession({ sessionId: "session-c", agentId: removed.id });

		assert.equal(await store.delete(removed.id), true);
		assert.deepEqual(plain(store.getSnapshot().settings.sessionAgentBindings), { "session-b": kept.id });
		assert.deepEqual((await readPersisted(filePath)).settings.sessionAgentBindings, { "session-b": kept.id });
		assert.equal(store.getBoundAgent("session-a"), undefined);
	});
});

test("load drops malformed, dangling, and prototype-key session bindings", async () => {
	await withStore(async ({ filePath }) => {
		// 绑定表来自可手改 JSON：超长键、空值、非字符串、悬空 agentId 与 __proto__ 都要清掉。
		const bindings = Object.fromEntries([
			["session-ok", BUILTIN_TRANSLATE_AGENT_ID],
			["session-ghost", "deleted-agent"],
			["  session-trimmed  ", BUILTIN_TRANSLATE_AGENT_ID],
			["s".repeat(201), BUILTIN_TRANSLATE_AGENT_ID],
			["session-empty", ""],
			["session-number", 42],
			["session-control", "bad\nagent"],
			["__proto__", BUILTIN_TRANSLATE_AGENT_ID],
		]);
		await writeFile(filePath, JSON.stringify({ version: 1, revision: 5, settings: { selectionToolEnabled: false, systemSelectionEnabled: false, sessionAgentBindings: bindings }, agents: [] }), "utf8");
		const store = new AgentProfileStore(filePath);
		const snapshot = await store.load(1_000);
		const expected = { "session-ok": BUILTIN_TRANSLATE_AGENT_ID, "session-trimmed": BUILTIN_TRANSLATE_AGENT_ID };
		assert.deepEqual(plain(snapshot.settings.sessionAgentBindings), expected);
		assert.equal(snapshot.settings.selectionToolEnabled, false);
		assert.equal(snapshot.settings.systemSelectionEnabled, false);
		// 清理结果写回磁盘，重启不再重复修复。
		assert.deepEqual((await readPersisted(filePath)).settings.sessionAgentBindings, expected);
		// 原型键没有落成自有属性（跨 realm 不能比较 Object.prototype，直接查自有属性）。
		assert.equal(Object.getOwnPropertyDescriptor(snapshot.settings.sessionAgentBindings, "__proto__"), undefined);
		assert.equal(snapshot.settings.sessionAgentBindings["session-ok"], BUILTIN_TRANSLATE_AGENT_ID);
	});
});

test("bindSession rejects new bindings beyond the cap but still allows updates and unbinds", async () => {
	await withStore(async ({ filePath }) => {
		const bindings = {};
		for (let index = 0; index < 2_000; index += 1) bindings[`session-${index}`] = BUILTIN_TRANSLATE_AGENT_ID;
		await writeFile(filePath, JSON.stringify({ version: 1, revision: 0, settings: { sessionAgentBindings: bindings }, agents: [] }), "utf8");
		const store = new AgentProfileStore(filePath);
		const snapshot = await store.load(1_000);
		assert.equal(Object.keys(snapshot.settings.sessionAgentBindings).length, 2_000);

		await assert.rejects(() => store.bindSession({ sessionId: "session-new", agentId: BUILTIN_TRANSLATE_AGENT_ID }), /Session binding limit reached: 2000/);
		// 更新已有绑定不受上限影响；解绑后又能再绑定。
		const updated = await store.bindSession({ sessionId: "session-0", agentId: BUILTIN_TRANSLATE_AGENT_ID });
		assert.equal(Object.keys(updated.sessionAgentBindings).length, 2_000);
		await store.bindSession({ sessionId: "session-0", agentId: null });
		const rebound = await store.bindSession({ sessionId: "session-new", agentId: BUILTIN_TRANSLATE_AGENT_ID });
		assert.equal(rebound.sessionAgentBindings["session-new"], BUILTIN_TRANSLATE_AGENT_ID);
	});
});

test("updateSettings ignores sessionAgentBindings and persists the new settings fields", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		await store.load(1_000);
		await store.bindSession({ sessionId: "session-a", agentId: BUILTIN_TRANSLATE_AGENT_ID });

		// 绑定只能经 bindSession 改：settings patch 里带 bindings 必须被忽略（否则旧快照会覆盖整表）。
		const settings = await store.updateSettings({ selectionToolEnabled: false, systemSelectionEnabled: false, sessionAgentBindings: { "session-b": "ghost" } });
		assert.deepEqual(plain(settings.sessionAgentBindings), { "session-a": BUILTIN_TRANSLATE_AGENT_ID });
		assert.equal(settings.systemSelectionEnabled, false);

		const reloaded = new AgentProfileStore(filePath);
		const snapshot = await reloaded.load(2_000);
		assert.deepEqual(plain(snapshot.settings), { selectionToolEnabled: false, systemSelectionEnabled: false, selectionToolAgentId: null, sessionAgentBindings: { "session-a": BUILTIN_TRANSLATE_AGENT_ID } });
	});
});

test("reorder 持久化自定义顺序：未知/重复 id 忽略、顺序不变不写盘", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		const snapshot = await store.load(1_000);
		const ids = Array.from(snapshot.agents, (agent) => agent.id);
		const reversed = [...ids].reverse();

		const next = await store.reorder(["missing", ...reversed, reversed[0]]);
		assert.deepEqual(Array.from(next), reversed, "未知 id 忽略、重复 id 只算一次");
		assert.deepEqual(Array.from(store.getSnapshot().agentOrder), reversed);
		assert.deepEqual(plain(await readPersisted(filePath)).agentOrder, reversed, "顺序写进 agent-profiles.json");

		const reloaded = await new AgentProfileStore(filePath).load(1_000);
		assert.deepEqual(Array.from(reloaded.agentOrder), reversed, "重启后顺序不变");

		// 顺序没变：不推进 revision、不重写文件（拖回原位是纯视觉动作）。
		const revision = store.getSnapshot().revision;
		const before = await readFile(filePath, "utf8");
		await store.reorder(reversed);
		assert.equal(store.getSnapshot().revision, revision);
		assert.equal(await readFile(filePath, "utf8"), before);
	});
});

test("reorder 之后新建/复制追加到末尾，删除从顺序里剔除", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		const snapshot = await store.load(1_000);
		const ids = Array.from(snapshot.agents, (agent) => agent.id);
		const custom = [ids[1], ids[0], ids[2], ids[3]];
		await store.reorder(custom);

		const created = await store.create({ name: "新智能体", description: "描述", systemPrompt: "设定", category: "general" }, 2_000);
		assert.deepEqual(Array.from(store.getSnapshot().agentOrder), [...custom, created.id], "新建追加到尾部，不插进用户已排好的队伍");

		const copy = await store.duplicate(created.id, 3_000);
		assert.deepEqual(Array.from(store.getSnapshot().agentOrder), [...custom, created.id, copy.id]);

		assert.equal(await store.delete(created.id), true);
		assert.deepEqual(Array.from(store.getSnapshot().agentOrder), [...custom, copy.id], "删除同时剔除顺序里的 id");
	});
});

test("load 剔除顺序里未知/重复的 id，缺失的智能体由排序策略补位", async () => {
	await withStore(async ({ filePath }) => {
		const store = new AgentProfileStore(filePath);
		const snapshot = await store.load(1_000);
		const ids = Array.from(snapshot.agents, (agent) => agent.id);
		const persisted = await readPersisted(filePath);
		persisted.agentOrder = ["missing", ids[2], ids[2], 42, ids[0]];
		await writeFile(filePath, JSON.stringify(persisted), "utf8");

		const reloaded = await new AgentProfileStore(filePath).load(2_000);
		assert.deepEqual(Array.from(reloaded.agentOrder), [ids[2], ids[0]], "未知 id / 非字符串 / 重复项全部剔除");
	});
});
