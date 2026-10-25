import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);

/**
 * ACP 标题所有权回归（2026-10 用户现场）：AcpUpdatePipeline.applyProjectionTitle →
 * host.onTitleChanged → catalog。旧实现直接 update({ title }) 把 CLI 的
 * session_info_update.title 锁成 manual 终态：① 用户手动改名在下一个回合就被 CLI 拉回；
 * ② codex 把 prompt 原文当标题也永久锁死。applyAgentTitle 语义：同源 last-wins、
 * manual（用户确认名）不可被 CLI 覆盖、标记脏名拒收。
 */
function loadCatalog(fsPromises = nodeRequire("node:fs/promises")) {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"node:fs/promises": fsPromises,
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

function summary(overrides = {}) {
	return {
		id: "C:/sessions/example.jsonl",
		filePath: "C:/sessions/example.jsonl",
		name: "Example",
		preview: "hello",
		updatedAt: 100,
		messageCount: 1,
		source: "pi",
		...overrides,
	};
}

/** mergeScanned 的外部删除清理会剔掉磁盘不存在的 pi 条目——持久化分支用例必须真实落盘。 */
async function realSessionFile(dir, relativePath) {
	const absolute = join(dir, relativePath);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, '{"type":"session"}\n', "utf8");
	return absolute.replace(/\\/g, "/");
}

test("applyAgentTitle on transient draft: last-wins and marker/blank rejection", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-acp-title-transient-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const draft = await catalog.createDraft({ projectId: "project-1", title: "新会话", environment: "native" });

		// CLI 首个标题（常是 prompt 原文）可领取
		const first = await catalog.applyAgentTitle(draft.id, "帮我修一下登录 bug");
		assert.ok(first);
		assert.equal(first.title, "帮我修一下登录 bug");
		// 同源 last-wins：CLI 回合末精修出更好的名字时必须能替换
		const refined = await catalog.applyAgentTitle(draft.id, "修复登录会话过期");
		assert.ok(refined);
		assert.equal(refined.title, "修复登录会话过期");
		// 同名重复投递不重复写
		assert.equal(await catalog.applyAgentTitle(draft.id, "修复登录会话过期"), undefined);
		// 标记形态脏名（上下文代理确认行）不写
		assert.equal(await catalog.applyAgentTitle(draft.id, "[ACP] acp_status result: 1"), undefined);
		assert.equal(await catalog.applyAgentTitle(draft.id, "📦 [ACP] Compression FAILED: none resolved"), undefined);
		assert.equal(catalog.get(draft.id)?.title, "修复登录会话过期");
		// 空白标题不写
		assert.equal(await catalog.applyAgentTitle(draft.id, "   "), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("applyAgentTitle on transient draft: user manual rename is terminal", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-acp-title-manual-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const draft = await catalog.createDraft({ projectId: "project-1", title: "新会话", environment: "native" });
		assert.ok(await catalog.applyAgentTitle(draft.id, "prompt 原文标题"));

		// 用户手动改名 → manual 终态
		await catalog.update(draft.id, { title: "我的调试会话" });
		// CLI 后续 session_info_update.title 不得拉回
		assert.equal(await catalog.applyAgentTitle(draft.id, "CLI 精修标题"), undefined);
		assert.equal(catalog.get(draft.id)?.title, "我的调试会话");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("applyAgentTitle on persisted entry: last-wins, manual guard, survives reload", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-acp-title-persisted-"));
	const catalogPath = join(dir, "sessions.json");
	try {
		const catalog = new SessionCatalog(catalogPath);
		await catalog.load();
		const realPath = await realSessionFile(dir, "sessions/example.jsonl");
		// nameFromSessionInfo=false：首条消息弱回退名只算 fallback（#266 口径），
		// 这样才模拟出「可被 agent 标题升级」的初始状态（session_info 权威名会锁 manual）。
		const [record] = await catalog.mergeScanned("project-1", [summary({ filePath: realPath, id: realPath, nameFromSessionInfo: false })]);
		// 扫描初始化的正文兜底名是 fallback，可被 agent 标题升级
		const applied = await catalog.applyAgentTitle(record.id, "codex 起的标题");
		assert.ok(applied);
		assert.equal(applied.title, "codex 起的标题");

		// 重载后 auto 所有权保留：新 agent 标题仍可 last-wins（不因重载被锁死）
		const reloaded = new SessionCatalog(catalogPath);
		await reloaded.load();
		const again = await reloaded.applyAgentTitle(record.id, "回合末精修标题");
		assert.ok(again);
		assert.equal(again.title, "回合末精修标题");

		// 用户改名后 CLI 不可覆盖，且重载后 manual 终态同样生效
		await reloaded.update(record.id, { title: "用户定的名" });
		assert.equal(await reloaded.applyAgentTitle(record.id, "codex 又起的标题"), undefined);
		const reloaded2 = new SessionCatalog(catalogPath);
		await reloaded2.load();
		assert.equal(await reloaded2.applyAgentTitle(record.id, "codex 再起的标题"), undefined);
		// 持久化确实落盘（agent 标题是 auto 而非 manual；用户名保留）
		const raw = JSON.parse(await readFile(catalogPath, "utf8"));
		const persisted = raw.sessions.find((entry) => entry.id === record.id);
		assert.equal(persisted.title, "用户定的名");
		assert.equal(persisted.titleOrigin, "manual");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("index.ts onTitleChanged routes through applyAgentTitle (never update-manual)", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	const start = source.indexOf("onTitleChanged: (deckSessionId, title) => {");
	assert.ok(start > 0, "index.ts must wire ACP onTitleChanged");
	const end = source.indexOf("logger: appLogger,", start);
	const block = source.slice(start, end);
	assert.match(block, /applyAgentTitle\(deckSessionId,\s*title\)/, "onTitleChanged must claim via applyAgentTitle");
	assert.doesNotMatch(block, /\.update\(\s*entry\.id,\s*\{\s*title\s*\}/, "onTitleChanged must not write CLI titles as manual");
	assert.match(block, /applied\.projectId/, "catalog refresh should use the applied record's project");
});
