import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);

/**
 * 回归（2026-10 用户反馈）：重发/编辑 fork 出的子会话，重启后模型选择器为空。
 * 根因：fork 子会话文件里没有新的 model_change，扫描回读（inheritSessionMeta）拿不到
 * 模型；catalog 建目（ensureRuntimeTarget）也不从源会话继承 → 条目 model 为空。
 * 修复：fork/clone 注册时把源会话的 model/thinkingLevel 一并带给子条目。
 */

function loadCatalog(fsPromises = nodeRequire("node:fs/promises")) {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"node:fs/promises": fsPromises,
			"node:fs": { existsSync: () => true },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

test("ensureRuntimeTarget 继承 model/thinkingLevel 且跨重启持久化", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-fork-model-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, undefined);
		await catalog.load();
		const record = await catalog.ensureRuntimeTarget({
			projectId: "project-1",
			title: "Forked topic",
			source: "pi",
			environment: "native",
			filePath: "C:/sessions/fork.jsonl",
			forked: true,
			model: { provider: "anthropic", modelId: "claude-sonnet-4-5", modelName: "Sonnet 4.5" },
			thinkingLevel: "high",
		});
		assert.equal(record.model?.provider, "anthropic");
		assert.equal(record.model?.modelId, "claude-sonnet-4-5");
		assert.equal(record.thinkingLevel, "high");
		// 重启后仍能读到（不依赖子会话文件里的 model_change 回读）
		const reloaded = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, undefined);
		await reloaded.load();
		const restored = reloaded.get(record.id);
		assert.equal(restored?.model?.modelId, "claude-sonnet-4-5");
		assert.equal(restored?.thinkingLevel, "high");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("不传 model 时行为不变（不凭空造模型偏好）", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-fork-nomodel-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, undefined);
		await catalog.load();
		const record = await catalog.ensureRuntimeTarget({
			projectId: "project-1",
			title: "Plain target",
			source: "pi",
			environment: "native",
			filePath: "C:/sessions/plain.jsonl",
		});
		assert.equal(record.model, undefined);
		assert.equal(record.thinkingLevel, undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

/** 源码契约：fork/复制注册路径必须把源会话的模型偏好传进 ensureRuntimeTarget。 */
test("重发/编辑 fork 与静态复制都向 ensureRuntimeTarget 传递源会话模型", () => {
	const indexSource = readFileSync("src/main/index.ts", "utf8");
	// replaceAgentSession（重发/编辑 fork、运行中 clone）
	assert.match(indexSource, /model:\s*originEntry\?\.model,\s*thinkingLevel:\s*originEntry\?\.thinkingLevel,/);
	// 静态复制会话
	assert.match(indexSource, /model:\s*entry\.model,\s*thinkingLevel:\s*entry\.thinkingLevel,/);
});

/** 源码契约：重发/编辑覆盖层按动作命名，不再暴露内部 fork 术语（显式 fork 动作除外）。 */
test("重发/编辑 overlay 文案按动作称呼，fork 术语只留给显式 fork 动作", () => {
	const mutations = readFileSync("src/renderer/src/hooks/useSessionHistoryMutations.ts", "utf8");
	assert.match(mutations, /showOverlay\(sessionId, kind === "edit" \? "editing" : "resending"\);/);
	const forkingCalls = mutations.match(/showOverlay\(sessionId, "forking"\);/g) ?? [];
	assert.equal(forkingCalls.length, 1, "runForkMutation 不得再用 forking 文案，只保留 forkFromUserMessage 一处");

	const stage = readFileSync("src/renderer/src/components/session/SessionSurfaceStage.tsx", "utf8");
	assert.match(stage, /editing:\s*"message\.historyOverlay\.editing"/);
	assert.match(stage, /resending:\s*"message\.historyOverlay\.resending"/);

	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.match(zh, /"message\.historyOverlay\.editing":\s*"[^"]+"/);
	assert.match(zh, /"message\.historyOverlay\.resending":\s*"[^"]+"/);
	assert.match(en, /"message\.historyOverlay\.editing":\s*"[^"]+"/);
	assert.match(en, /"message\.historyOverlay\.resending":\s*"[^"]+"/);
});
