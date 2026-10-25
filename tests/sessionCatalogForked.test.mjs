import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);

/** 加载生产 SessionCatalog：相对 import 由 helper 按源文件目录解析，生产代码新增本地依赖不会再炸 loader。 */
function loadCatalog(fsPromises = nodeRequire("node:fs/promises")) {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"node:fs/promises": fsPromises,
			// 测试用假路径 C:/sessions/*.jsonl 模拟扫描到的既有文件；existsSync 只被
			// 外部删除清理消费，恒真 = 「文件都在磁盘上」，避免清理把条目剔掉。
			"node:fs": { existsSync: () => true },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

function summary(overrides = {}) {
	return {
		id: "C:/sessions/fork.jsonl",
		filePath: "C:/sessions/fork.jsonl",
		name: "Forked topic",
		preview: "hello",
		updatedAt: 100,
		messageCount: 1,
		source: "pi",
		...overrides,
	};
}

/** 模拟 SessionScanner.inferSessionNameAndValidity 的头部探测：fork 文件 → forked:true。 */
function forkFetchTitle() {
	return async () => ({ name: "Forked topic", nameFromSessionInfo: true, forked: true });
}

test("mergeScanned marks a newly discovered fork file without folding it under its parent", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-forked-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, forkFetchTitle());
		await catalog.load();
		// 轻量扫描（listPathSummary）不带 name：新文件因此进入头部探测（wanted）路径
		const [record] = await catalog.mergeScanned("project-1", [summary({ name: undefined })]);
		// fork 标记独立于 parentSessionPath：顶层展示的 fork 身份元数据（(fork) 标题后缀
		// 已物理写入会话名，见 sessionForkTitle.ts）
		assert.equal(record.forked, true);
		assert.equal(record.parentSessionPath, undefined);
		// 跨重启持久化：重载后标记仍在（不依赖每次扫描重新探测）
		const reloaded = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, forkFetchTitle());
		await reloaded.load();
		const [restored] = await reloaded.mergeScanned("project-1", [summary()]);
		assert.equal(restored.forked, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("folded subagent sessions never get the fork marker even when the header probe matches", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-forked-subagent-"));
	try {
		// 子代理形态：summary 带 parentSessionPath（列表折叠到父行），头部探测即便误报 forked
		// 也必须在 catalog 层被压制——fork 与子代理是两种形态。
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, async () => ({ name: "agent#12345678", nameFromSessionInfo: true, forked: true }));
		await catalog.load();
		// 轻量扫描同样不带 name：头部探测命中（forked:true）但 summary 已折叠为子代理
		const [record] = await catalog.mergeScanned("project-1", [
			summary({
				name: undefined,
				parentSessionPath: "C:/sessions/parent.jsonl",
			}),
		]);
		assert.equal(record.forked, undefined);
		assert.equal(record.parentSessionPath, "C:/sessions/parent.jsonl");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ensureRuntimeTarget registers a fork with the marker and keeps it across reload", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-forked-target-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const target = await catalog.ensureRuntimeTarget({
			projectId: "project-1",
			// fork 身份通过物理标题后缀表达；forked 只是 catalog 的辅助元数据。
			title: "Forked topic (fork)",
			source: "pi",
			environment: "native",
			filePath: "C:/sessions/fork.jsonl",
			forked: true,
		});
		assert.equal(target.forked, true);
		assert.equal(target.title, "Forked topic (fork)");
		const reloaded = new SessionCatalog(join(dir, "sessions.json"));
		await reloaded.load();
		assert.equal(reloaded.get(target.id)?.forked, true);
		assert.equal(reloaded.get(target.id)?.title, "Forked topic (fork)");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("update only sets the fork marker when the patch explicitly requests it", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-forked-update-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const target = await catalog.ensureRuntimeTarget({
			projectId: "project-1",
			title: "Plain session",
			source: "pi",
			environment: "native",
			filePath: "C:/sessions/plain.jsonl",
		});
		await catalog.update(target.id, { forked: true });
		assert.equal(catalog.getRecord(target.id)?.forked, true);
		// false/null 不得反向清除已持久化的标记（轻量扫描/普通探测后置回填的默认行为）
		await catalog.update(target.id, { forked: false });
		assert.equal(catalog.getRecord(target.id)?.forked, true);
		await catalog.update(target.id, { forked: null });
		assert.equal(catalog.getRecord(target.id)?.forked, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ensureRuntimeTarget inherits the source model into an already registered fork entry", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-forked-inherit-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		// 后台扫描抢先登记了新 fork 文件：子会话 JSONL 没有新的 model_change，条目里没有 model。
		const scanned = await catalog.ensureRuntimeTarget({
			projectId: "project-1",
			title: "Forked topic",
			source: "pi",
			environment: "native",
			filePath: "C:/sessions/fork.jsonl",
		});
		assert.equal(scanned.model, undefined);
		assert.equal(scanned.thinkingLevel, undefined);
		// 命令层随后继承源会话偏好（issue #370）：缺模型时底栏显示「-」、激活不重放模型，
		// pi fork 的静默回落就成了用户看不见的另一个模型。
		const inherited = await catalog.ensureRuntimeTarget({
			projectId: "project-1",
			title: "Forked topic (fork)",
			source: "pi",
			environment: "native",
			filePath: "C:/sessions/fork.jsonl",
			forked: true,
			model: { provider: "deepseek", modelId: "deepseek-v4.1-flash", modelName: "DeepSeek V4.1 Flash" },
			thinkingLevel: "high",
		});
		// 沙箱对象跨 realm：逐字段比较，避免原型不同导致 deepStrictEqual 假红。
		assert.equal(inherited.model.provider, "deepseek");
		assert.equal(inherited.model.modelId, "deepseek-v4.1-flash");
		assert.equal(inherited.model.modelName, "DeepSeek V4.1 Flash");
		assert.equal(inherited.thinkingLevel, "high");
		// 只补空值：子会话已有的显式选择不被命令层快照覆盖。
		const kept = await catalog.ensureRuntimeTarget({
			projectId: "project-1",
			title: "Forked topic (fork)",
			source: "pi",
			environment: "native",
			filePath: "C:/sessions/fork.jsonl",
			forked: true,
			model: { provider: "other", modelId: "other-model", modelName: "Other" },
			thinkingLevel: "low",
		});
		assert.equal(kept.model.provider, "deepseek");
		assert.equal(kept.model.modelId, "deepseek-v4.1-flash");
		assert.equal(kept.thinkingLevel, "high");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
