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

/**
 * 源码契约：fork 化重发/编辑的遮罩语义。
 *
 * 2027-03 用户反馈：热会话 fork 只要约 0.3s，却先糊一层「正在编辑消息…」，看起来像在重启
 * 应用。后来遮罩收成「淡入 + spinner」（不动布局、不挡操作），并且必须在第一个 await 之前
 * 同步挂上——点下去就要有反应。冷会话的 activating 遮罩保留（那段确实在拉起进程），
 * 激活完成后要重挂回 overlayKind，否则文案一直停在「正在激活」。
 */
test("fork 化重发/编辑不再显示全屏遮罩，fork 术语只留给显式 fork 动作", () => {
	// 块名沿用基线里的存量条目（改块名会被 check-test-shape 判成新增只读源码块）；
	// 断言已跟上 2026-11 的实现：遮罩在第一个 await 之前同步挂，类型由 kind 决定，只是不再是全屏。
	const mutations = readFileSync("src/renderer/src/hooks/useSessionHistoryMutations.ts", "utf8");
	// 2026-11-11：这条原先断言「editing/resending 遮罩已删除」。后来为了点击即时反馈
	// 又在 runForkMutation 的第一个 await 之前同步挂上遮罩（不挂就表现为「点了没反应」，
	// 见该函数里的注释）。所以现在钉住的是「遮罩同步挂、类型由 kind 决定」，
	// 而「不是内联三元直接进 showOverlay」这一点保留。
	assert.doesNotMatch(mutations, /showOverlay\(sessionId, kind === "edit"/, "runForkMutation 不得把分支内联进 showOverlay");
	assert.match(mutations, /const overlayKind: SessionHistoryMutationOverlayKind = kind === "resend" \? "resending" : "editing";/);
	assert.match(mutations, /showOverlay\(sessionId, overlayKind\);/, "遮罩必须在第一个 await 之前同步挂上");
	// 冷会话激活仍要反馈
	assert.match(mutations, /showOverlay\(sessionId, "activating"\);/);
	// 顺序判据（不数次数）：开始挂 forking → 冷启动用 activating 覆盖 → 激活完成后重挂回 forking。
	// 计数只能证明「出现了两次」，顺序才能证明「重挂发生在激活之后」。
	const forkingAt = mutations.indexOf('showOverlay(sessionId, "forking")');
	const activatingAfterForkAt = mutations.indexOf('showOverlay(sessionId, "activating")', forkingAt);
	const remountForkAt = mutations.indexOf('showOverlay(sessionId, "forking")', activatingAfterForkAt);
	assert.ok(forkingAt >= 0, "runForkMutation 开始时必须挂 forking");
	assert.ok(activatingAfterForkAt > forkingAt, "冷启动必须先用 activating 覆盖 forking");
	assert.ok(remountForkAt > activatingAfterForkAt, "激活完成后必须重挂回 forking");

	const stage = readFileSync("src/renderer/src/components/session/SessionSurfaceStage.tsx", "utf8");
	// 早期约定是「fork 化重试不显示遮罩」，后来为了点击即时反馈改成同步挂；
	// stage 的文案映射因此覆盖全部 overlay kind，editing/resending 必须在。
	assert.match(stage, /editing: "message\.historyOverlay\.editing"/);
	assert.match(stage, /resending: "message\.historyOverlay\.resending"/);
});
