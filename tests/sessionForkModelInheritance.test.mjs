import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";

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
	const indexSource = mainIpcSource;
	// replaceAgentSession（重发/编辑 fork、运行中 clone）
	assert.match(indexSource, /model:\s*originEntry\?\.model,\s*thinkingLevel:\s*originEntry\?\.thinkingLevel,/);
	// 静态复制会话
	assert.match(indexSource, /model:\s*entry\.model,\s*thinkingLevel:\s*entry\.thinkingLevel,/);
});

/**
 * 源码契约：重发/编辑点击后立即反馈，fork 切会话时遮罩接力。
 *
 * 75d53a919（v0.12.0）：热会话 fork 约 0.3s，旧实现不挂遮罩也不给按钮进行中状态，
 * 用户看到的是「点下去毫无反应、随后会话突然换掉」。现在第一个 await 前同步挂专属
 * 遮罩并标记 pending；fork 成功切会话前把遮罩交给目标会话再清源会话，新会话首帧
 * 即有覆盖（早期 388975aee 曾删除该遮罩，因该反馈问题恢复）。
 */
test("重发/编辑在第一个 await 前挂遮罩，切会话时把遮罩接力给目标会话", () => {
	const mutations = readFileSync("src/renderer/src/hooks/useSessionHistoryMutations.ts", "utf8");
	const forkStart = mutations.indexOf("const runForkMutation");
	assert.ok(forkStart > 0, "runForkMutation 应存在");
	assert.match(mutations, /const overlayKind: SessionHistoryMutationOverlayKind = kind === "resend" \? "resending" : "editing";/);
	const overlayIndex = mutations.indexOf("showOverlay(sessionId, overlayKind);", forkStart);
	const pendingIndex = mutations.indexOf("beginPending(sessionId, message.id, kind);", forkStart);
	const firstAwaitIndex = mutations.indexOf("await api.sessions.activateRuntime(sessionId)", forkStart);
	assert.ok(overlayIndex > forkStart && overlayIndex < pendingIndex, "遮罩必须在 beginPending 之前同步挂上");
	assert.ok(pendingIndex < firstAwaitIndex, "点击反馈必须在第一个 await 之前");
	// fork 成功切会话前把遮罩交给目标会话，再清源会话（新会话首帧即有覆盖）。
	assert.match(mutations, /showOverlay\(targetSessionId, overlayKind\);/);
	const transferStart = mutations.indexOf("showOverlay(targetSessionId, overlayKind);");
	const transferEnd = mutations.indexOf("hideOverlay(sessionId);", transferStart);
	assert.ok(transferStart > 0 && transferEnd > transferStart && transferEnd - transferStart < 200, "切会话后应清源会话遮罩");
	// 冷会话激活仍有独立反馈。
	assert.match(mutations, /showOverlay\(sessionId, "activating"\);/);
	// 显式 fork 的 forking 文案只属于 fork 动作，runForkMutation 不占用该术语（只看其开头段落）。
	const forkSegment = mutations.slice(forkStart, forkStart + 1200);
	assert.doesNotMatch(forkSegment, /"forking"/);

	const stage = readFileSync("src/renderer/src/components/session/SessionSurfaceStage.tsx", "utf8");
	assert.match(stage, /message\.historyOverlay\.(editing|resending)/);
});
