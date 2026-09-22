import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 加载 dshForeignSync 与真实 SessionCatalog；相对 import 由 helper 按源文件目录解析。 */
function loadModules() {
	const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: { "../logging/sharedLogger": { getAppLogger: () => null } },
	});
	const sync = loadTsCommonJs("src/main/dsh/dshForeignSync.ts");
	return { SessionCatalog, ...sync };
}

function foreignItem(overrides = {}) {
	return {
		dshSessionId: "session-web-1",
		...overrides,
	};
}

/** 构建真实 catalog + mock host/项目依赖的同步测试台。 */
async function createFixture(foreignItems, knownIds = new Set()) {
	const { SessionCatalog, ...sync } = loadModules();
	const dir = await mkdtemp(join(tmpdir(), "pideck-dsh-foreign-sync-"));
	const catalogPath = join(dir, "catalog.json");
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	const fallbackProject = { id: "builtin-external" };
	let fallbackCreated = 0;
	const registeredByCwd = new Map();
	const deps = {
		listForeignSessions: async () => foreignItems,
		findProjectByPath: (cwd) => (cwd === "C:/repo/alpha" ? { id: "project-alpha" } : cwd === "C:/repo/beta" ? { id: "project-beta" } : (registeredByCwd.get(cwd) ?? null)),
		shouldRegisterCwd: async () => true,
		ensureProjectForCwd: async (cwd) => {
			const existing = registeredByCwd.get(cwd);
			if (existing) return existing;
			const created = { id: `registered:${cwd}` };
			registeredByCwd.set(cwd, created);
			return created;
		},
		ensureFallbackProject: async () => {
			fallbackCreated += 1;
			return fallbackProject;
		},
		createDraft: (input) => catalog.createDraft(input),
		getExistingDraft: (dshSessionId) => {
			const existing = catalog.listEntries().find((entry) => entry.dshSessionId === dshSessionId);
			return existing ? { title: existing.title } : undefined;
		},
		getEnvironment: () => "native",
		fallbackTitle: "DSH 会话",
		onError: () => undefined,
	};
	return {
		catalog,
		catalogPath,
		sync,
		deps,
		get fallbackCreated() {
			return fallbackCreated;
		},
		async cleanup() {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

test("splitForeignSessions separates catalog-known sessions from pending ones", () => {
	const { splitForeignSessions, knownForeignSessionIds } = loadModules();
	const items = [foreignItem({ dshSessionId: "session-a" }), foreignItem({ dshSessionId: "session-b" }), foreignItem({ dshSessionId: "session-c" })];
	const known = knownForeignSessionIds([{ dshSessionId: "session-a" }, { dshSessionId: "session-c" }, { dshSessionId: undefined }]);
	const { pending, imported } = splitForeignSessions(items, known);
	assert.equal(pending.map((item) => item.dshSessionId).join(","), "session-b");
	assert.equal(imported.map((item) => item.dshSessionId).join(","), "session-a,session-c");
});

test("pickProjectForForeignSession matches cwd, registers unmatched cwd, falls back only when cwd is missing", () => {
	const { pickProjectForForeignSession } = loadModules();
	const findProject = (cwd) => (cwd === "C:/repo/alpha" ? { id: "project-alpha" } : null);
	// vm 上下文对象的 prototype 与测试字面量不同，deepStrictEqual 会误报：逐字段断言
	let picked = pickProjectForForeignSession(foreignItem({ cwd: "C:/repo/alpha" }), findProject, "builtin-external");
	assert.equal(picked.projectId, "project-alpha");
	assert.equal(picked.matched, true);
	assert.equal(picked.cwdToRegister, undefined);
	// cwd 存在但未注册：按该目录建/挂项目，不能塞进同一个「外部会话」兑底
	picked = pickProjectForForeignSession(foreignItem({ cwd: "C:/elsewhere" }), findProject, "builtin-external");
	assert.equal(picked.projectId, undefined);
	assert.equal(picked.matched, false);
	assert.equal(picked.cwdToRegister, "C:/elsewhere");
	// 无 cwd：才兑底
	picked = pickProjectForForeignSession(foreignItem({}), findProject, "builtin-external");
	assert.equal(picked.projectId, "builtin-external");
	assert.equal(picked.matched, false);
	assert.equal(picked.cwdToRegister, undefined);
});

test("importForeignSession maps into the matched project and keeps the projected title", async () => {
	const fixture = await createFixture([]);
	try {
		const record = await fixture.sync.importForeignSession(fixture.deps, "session-web-1", foreignItem({ title: " 打包的体积优化  ", cwd: "C:/repo/alpha" }));
		assert.equal(record.title, "打包的体积优化");
		assert.equal(record.projectId, "project-alpha");
		assert.equal(record.backend, "dsh");
		assert.equal(record.dshSessionId, "session-web-1");
		assert.equal(record.status, "active");
		assert.equal(fixture.catalog.listEntries().length, 1);
	} finally {
		await fixture.cleanup();
	}
});

test("importForeignSession falls back to host-resolved title when the projection is missing", async () => {
	const fixture = await createFixture([]);
	fixture.deps.resolveHostTitle = async (id) => (id === "session-web-1" ? "历史投影标题" : undefined);
	try {
		const record = await fixture.sync.importForeignSession(fixture.deps, "session-web-1", foreignItem({ cwd: "C:/repo/beta" }));
		assert.equal(record.title, "历史投影标题");
		assert.equal(record.projectId, "project-beta");
	} finally {
		await fixture.cleanup();
	}
});

test("resolveFallbackTitle defers function evaluation until use", () => {
	const { resolveFallbackTitle } = loadModules();
	assert.equal(resolveFallbackTitle("DSH 会话"), "DSH 会话");
	let called = 0;
	const title = resolveFallbackTitle(() => {
		called += 1;
		return "lazy-title";
	});
	assert.equal(title, "lazy-title");
	assert.equal(called, 1);
});

test("index foreignSyncDeps must not call mainCopy at module load", () => {
	// 回归：eager fallbackTitle: mainCopy(...) 在 settingsStore 赋值前求值，
	// 启动即 TypeError: Cannot read properties of undefined (reading 'get')。
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.match(source, /fallbackTitle:\s*\(\)\s*=>\s*mainCopy\(/, "fallbackTitle 必须惰性取 i18n，不能在对象字面量里直接 mainCopy");
	assert.doesNotMatch(source, /fallbackTitle:\s*mainCopy\(/);
	assert.match(source, /getExistingDraft:\s*\(dshSessionId\)/, "纠正归属时必须能读到已有标题，才能用官方投影覆盖 cwd 占位名");
	assert.match(source, /dismissedDshSessionIds:\s*\(\)\s*=>\s*sessionCatalog\.listDismissedDshSessionIds\(\)/, "自动同步必须跳过用户删过的 DSH host 会话");
});

test("foreign session IPC hides dismissed host sessions from the import list", () => {
	const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
	assert.match(sessionIpc, /listDismissedDshSessionIds\(\)[\s\S]*!dismissed\.has\(item\.dshSessionId\)/);
	assert.match(sessionIpc, /restoreDismissed: true/);
});

test("cwdDisplayName takes the last path segment on both separators", () => {
	const { cwdDisplayName } = loadModules();
	assert.equal(cwdDisplayName("C:/repo/alpha"), "alpha");
	assert.equal(cwdDisplayName("D:\\project\\github\\pi-desktop\\"), "pi-desktop");
	assert.equal(cwdDisplayName(""), undefined);
	assert.equal(cwdDisplayName(undefined), undefined);
});

test("importForeignSession uses cwd last segment when title is missing and host title is not used", async () => {
	const fixture = await createFixture([]);
	try {
		const record = await fixture.sync.importForeignSession(fixture.deps, "session-web-1", foreignItem({ cwd: "C:/repo/alpha" }), false);
		assert.equal(record.title, "alpha");
		assert.equal(record.projectId, "project-alpha");
	} finally {
		await fixture.cleanup();
	}
});

test("importForeignSession uses the fallback title and fallback project for directory-less sessions", async () => {
	const fixture = await createFixture([]);
	try {
		const record = await fixture.sync.importForeignSession(fixture.deps, "session-web-2", foreignItem({ dshSessionId: "session-web-2" }));
		assert.equal(record.title, "DSH 会话");
		assert.equal(record.projectId, "builtin-external");
		assert.equal(fixture.fallbackCreated, 1);
	} finally {
		await fixture.cleanup();
	}
});

test("re-importing the same dshSessionId updates in place instead of duplicating", async () => {
	const fixture = await createFixture([]);
	try {
		const first = await fixture.sync.importForeignSession(fixture.deps, "session-web-1", foreignItem({ title: "旧标题", cwd: "C:/repo/alpha" }));
		const second = await fixture.sync.importForeignSession(fixture.deps, "session-web-1", foreignItem({ title: "新标题", cwd: "C:/repo/beta" }));
		assert.equal(second.id, first.id, "同一 host 会话重复导入必须返回同一条 catalog 记录");
		assert.equal(fixture.catalog.listEntries().length, 1);
		const persisted = fixture.catalog.listEntries()[0];
		assert.equal(persisted.title, "新标题");
		assert.equal(persisted.projectId, "project-beta");
	} finally {
		await fixture.cleanup();
	}
});

test("importForeignSession uses disk file mtime as updatedAt instead of import time", async () => {
	const fixture = await createFixture([]);
	try {
		// 远早于导入时刻的 mtime：模拟一条几天前活跃的 DSH 会话
		const mtime = 1_700_000_000_000;
		const record = await fixture.sync.importForeignSession(fixture.deps, "session-web-1", foreignItem({ title: "wc 周会", cwd: "C:/repo/alpha", updatedAt: mtime }));
		assert.equal(record.updatedAt, mtime, "updatedAt 必须来自磁盘日志文件 mtime，而不是 Date.now()");
		// 重启全量重导场景：同一 mtime 重复导入，updatedAt 不得被顶到“现在”
		const again = await fixture.sync.importForeignSession(fixture.deps, "session-web-1", foreignItem({ title: "wc 周会", cwd: "C:/repo/alpha", updatedAt: mtime }));
		assert.equal(again.updatedAt, mtime, "重复导入（重启重导）不得顶高 updatedAt");
	} finally {
		await fixture.cleanup();
	}
});

test("re-import with an older mtime corrects a previously bumped updatedAt and persists it", async () => {
	const fixture = await createFixture([]);
	try {
		const mtime = 1_700_000_000_000;
		const record = await fixture.sync.importForeignSession(fixture.deps, "session-web-1", foreignItem({ title: "wc 周会", cwd: "C:/repo/alpha", updatedAt: mtime }));
		// 模拟旧版本 bug：启动/attach 把 updatedAt 顶到“现在”
		await fixture.catalog.update(record.id, { updatedAt: Date.now() });
		// 本轮带真实 mtime 重导，应把被顶高的时间拉回磁盘活跃时刻
		const corrected = await fixture.sync.importForeignSession(fixture.deps, "session-web-1", foreignItem({ title: "wc 周会", cwd: "C:/repo/alpha", updatedAt: mtime }));
		assert.equal(corrected.updatedAt, mtime, "旧的错误顶高值必须被 mtime 拉回");
		// updatedAt 单独变化也必须落盘：重开 catalog 从磁盘读回验证
		const { SessionCatalog } = loadModules();
		const reloaded = new SessionCatalog(fixture.catalogPath);
		await reloaded.load();
		assert.equal(reloaded.listEntries().find((entry) => entry.id === record.id).updatedAt, mtime, "mtime 修正必须写入 catalog.json（不能只改内存不落盘）");
	} finally {
		await fixture.cleanup();
	}
});

test("importForeignSession skips a cwd that the caller refuses to auto-register", async () => {
	const fixture = await createFixture([]);
	fixture.deps.shouldRegisterCwd = async () => false;
	try {
		await assert.rejects(() => fixture.sync.importForeignSession(fixture.deps, "session-gone", foreignItem({ dshSessionId: "session-gone", cwd: "C:/Temp/pideck-mockpi-abc/profile/chat-workspace" })), /FOREIGN_CWD_NOT_REGISTERED/);
		assert.equal(fixture.catalog.listEntries().length, 0);
		assert.equal(fixture.fallbackCreated, 0, "拒绝注册的 cwd 不得掉进「外部会话」兑底");
	} finally {
		await fixture.cleanup();
	}
});

test("syncForeignSessions skips dismissed or missing cwds without recreating projects", async () => {
	const fixture = await createFixture([
		foreignItem({
			dshSessionId: "session-e2e",
			title: "chat-workspace",
			cwd: "C:/Temp/pideck-mockpi-abc/profile/chat-workspace",
		}),
		foreignItem({ dshSessionId: "session-keep", title: "Keep", cwd: "C:/repo/alpha" }),
	]);
	fixture.deps.shouldRegisterCwd = async (cwd) => cwd === "C:/repo/alpha";
	try {
		const result = await fixture.sync.syncForeignSessions(fixture.deps);
		assert.equal(result.imported, 1);
		assert.equal(result.skipped, 1);
		const ids = fixture.catalog.listEntries().map((entry) => entry.dshSessionId);
		assert.equal(ids.join(","), "session-keep");
	} finally {
		await fixture.cleanup();
	}
});

test("importForeignSession registers a project for an unmatched cwd instead of the fallback bucket", async () => {
	const fixture = await createFixture([]);
	try {
		const record = await fixture.sync.importForeignSession(fixture.deps, "session-elsewhere", foreignItem({ dshSessionId: "session-elsewhere", cwd: "C:/elsewhere" }));
		assert.equal(record.projectId, "registered:C:/elsewhere");
		assert.equal(fixture.fallbackCreated, 0, "有自己目录的会话不得进入「外部会话」兑底");
	} finally {
		await fixture.cleanup();
	}
});

test("syncForeignSessions rehomes a previously dumped fallback session onto its own cwd", async () => {
	const fixture = await createFixture([foreignItem({ dshSessionId: "session-dumped", title: "Dumped", cwd: "C:/elsewhere" })]);
	try {
		await fixture.catalog.createDraft({
			projectId: "builtin-external",
			title: "Dumped",
			environment: "native",
			backend: "dsh",
			dshSessionId: "session-dumped",
		});
		const result = await fixture.sync.syncForeignSessions(fixture.deps, new Set(["session-dumped"]));
		assert.equal(result.imported, 0);
		assert.equal(result.skipped, 1);
		assert.equal(fixture.catalog.listEntries().length, 1);
		assert.equal(fixture.catalog.listEntries()[0].projectId, "registered:C:/elsewhere");
		assert.equal(fixture.catalog.listEntries()[0].title, "Dumped", "纠正归属不得覆盖已有标题");
	} finally {
		await fixture.cleanup();
	}
});

test("syncForeignSessions imports all pending sessions and counts known ones as skipped", async () => {
	const fixture = await createFixture([foreignItem({ dshSessionId: "session-a", title: "A", cwd: "C:/repo/alpha" }), foreignItem({ dshSessionId: "session-b", title: "B", cwd: "C:/repo/beta" }), foreignItem({ dshSessionId: "session-c", title: "C" })]);
	try {
		const result = await fixture.sync.syncForeignSessions(fixture.deps, new Set(["session-a"]));
		assert.equal(result.imported, 2);
		assert.equal(result.skipped, 1);
		// 已在 knownIds 的 session-a 也会再导入一遍（纠正归属），空 catalog 上会补写该条。
		const ids = fixture.catalog
			.listEntries()
			.map((entry) => entry.dshSessionId)
			.sort();
		assert.equal(ids.join(","), "session-a,session-b,session-c");
		// 无目录会话进入兑底项目
		const c = fixture.catalog.listEntries().find((entry) => entry.dshSessionId === "session-c");
		assert.equal(c.projectId, "builtin-external");
	} finally {
		await fixture.cleanup();
	}
});

test("syncForeignSessions keeps going when a single import fails", async () => {
	const fixture = await createFixture([foreignItem({ dshSessionId: "session-bad", title: "Bad" }), foreignItem({ dshSessionId: "session-good", title: "Good", cwd: "C:/repo/alpha" })]);
	const errors = [];
	fixture.deps.onError = (id, error) => errors.push({ id, error: String(error) });
	fixture.deps.createDraft = async (input) => {
		if (input.dshSessionId === "session-bad") throw new Error("host session vanished");
		return fixture.catalog.createDraft(input);
	};
	try {
		const result = await fixture.sync.syncForeignSessions(fixture.deps);
		assert.equal(result.imported, 1);
		assert.equal(errors.length, 1);
		assert.equal(errors[0].id, "session-bad");
		assert.ok(String(errors[0].error).includes("host session vanished"));
		assert.equal(fixture.catalog.listEntries().length, 1);
		assert.equal(fixture.catalog.listEntries()[0].dshSessionId, "session-good");
	} finally {
		await fixture.cleanup();
	}
});

test("isPlaceholderForeignTitle treats folder name and i18n fallback as placeholders", () => {
	const { isPlaceholderForeignTitle } = loadModules();
	assert.equal(isPlaceholderForeignTitle("alpha", "C:/repo/alpha", "DSH 会话"), true);
	assert.equal(isPlaceholderForeignTitle("DSH 会话", "C:/repo/alpha", "DSH 会话"), true);
	assert.equal(isPlaceholderForeignTitle("你好", "C:/repo/alpha", "DSH 会话"), false);
});

test("syncForeignSessions overwrites a cwd-placeholder title with the official projection title", async () => {
	const fixture = await createFixture([foreignItem({ dshSessionId: "session-dumped", title: "你好", cwd: "C:/repo/alpha" })]);
	try {
		await fixture.catalog.createDraft({
			projectId: "project-alpha",
			title: "alpha",
			environment: "native",
			backend: "dsh",
			dshSessionId: "session-dumped",
		});
		await fixture.sync.syncForeignSessions(fixture.deps, new Set(["session-dumped"]));
		assert.equal(fixture.catalog.listEntries()[0].title, "你好");
	} finally {
		await fixture.cleanup();
	}
});

test("syncForeignSessions never calls resolveHostTitle so bulk sync cannot attach host", async () => {
	const fixture = await createFixture([foreignItem({ dshSessionId: "session-a", cwd: "C:/repo/alpha" })]);
	let called = 0;
	fixture.deps.resolveHostTitle = async () => {
		called += 1;
		return "should-not-use";
	};
	try {
		const result = await fixture.sync.syncForeignSessions(fixture.deps);
		assert.equal(result.imported, 1);
		assert.equal(called, 0, "批量同步禁止 sessions.history 标题补全");
		assert.equal(fixture.catalog.listEntries()[0].title, "alpha");
	} finally {
		await fixture.cleanup();
	}
});

test("syncForeignSessions does not resurrect a deleted DSH session still on disk", async () => {
	// 用户删的是侧栏映射；host 目录还在 $DSH_HOME。刷新/自动导入若只按
	// catalog 现有 id 过滤，会把同一条再 createDraft 回来。
	const fixture = await createFixture([foreignItem({ dshSessionId: "session-deleted", title: "Keep me?", cwd: "C:/repo/alpha" })]);
	try {
		await fixture.sync.syncForeignSessions(fixture.deps);
		assert.equal(fixture.catalog.listEntries().length, 1);
		const id = fixture.catalog.listEntries()[0].id;
		const dshSessionId = fixture.catalog.listEntries()[0].dshSessionId;
		await fixture.catalog.rememberDismissedDshSession(dshSessionId);
		await fixture.catalog.remove(id);
		assert.equal(fixture.catalog.listEntries().length, 0);
		fixture.deps.dismissedDshSessionIds = () => fixture.catalog.listDismissedDshSessionIds();
		const again = await fixture.sync.syncForeignSessions(fixture.deps);
		assert.equal(again.imported, 0, "已删除的 host 会话不得因磁盘仍在而被重新导入");
		assert.equal(fixture.catalog.listEntries().length, 0);
		assert.equal(fixture.catalog.listDismissedDshSessionIds().has(dshSessionId), true);
	} finally {
		await fixture.cleanup();
	}
});

test("syncForeignSessions does not resurrect when the tombstone arrives mid-sync", async () => {
	// 回归：同步已开始、第一条 createDraft 时用户删了后面那条。
	// 旧逻辑 createDraft 会清墓碑再新建；现在必须跳过且墓碑还在。
	const fixture = await createFixture([foreignItem({ dshSessionId: "session-a", title: "A", cwd: "C:/repo/alpha" }), foreignItem({ dshSessionId: "session-deleted", title: "Gone", cwd: "C:/repo/alpha" })]);
	try {
		await fixture.sync.syncForeignSessions(fixture.deps);
		const doomed = fixture.catalog.listEntries().find((entry) => entry.dshSessionId === "session-deleted");
		assert.ok(doomed);
		const originalCreate = fixture.deps.createDraft;
		fixture.deps.createDraft = async (input) => {
			if (input.dshSessionId === "session-a") {
				await fixture.catalog.rememberDismissedDshSession("session-deleted");
				await fixture.catalog.remove(doomed.id);
			}
			assert.equal(input.restoreDismissed, undefined, "批量同步不得清删除墓碑");
			return originalCreate(input);
		};
		fixture.deps.dismissedDshSessionIds = () => fixture.catalog.listDismissedDshSessionIds();
		const known = fixture.sync.knownForeignSessionIds(fixture.catalog.listEntries());
		const again = await fixture.sync.syncForeignSessions(fixture.deps, known);
		assert.equal(again.imported, 0);
		assert.equal(
			fixture.catalog.listEntries().some((entry) => entry.dshSessionId === "session-deleted"),
			false,
		);
		assert.equal(fixture.catalog.listDismissedDshSessionIds().has("session-deleted"), true);
	} finally {
		await fixture.cleanup();
	}
});

test("syncForeignSessions without knownIds lets createDraft absorb duplicates", async () => {
	const fixture = await createFixture([foreignItem({ dshSessionId: "session-a", title: "A", cwd: "C:/repo/alpha" })]);
	try {
		const first = await fixture.sync.syncForeignSessions(fixture.deps);
		assert.equal(first.imported, 1);
		// 第二次同步不传 knownIds：createDraft 幂等吸收，不新增条目
		const second = await fixture.sync.syncForeignSessions(fixture.deps);
		assert.equal(second.imported, 1);
		assert.equal(fixture.catalog.listEntries().length, 1);
	} finally {
		await fixture.cleanup();
	}
});
