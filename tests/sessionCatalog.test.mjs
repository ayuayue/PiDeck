import assert from "node:assert/strict";
import { mkdtemp, readFile, rename as renameFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);

/**
 * 加载生产 SessionCatalog。
 * fsPromises 可注入 mock（重试/原子写用例需要拦截 rename）；相对 import 由 helper 按源文件目录解析，
 * 生产代码新增本地依赖不会再炸 loader。
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

test("does not restore an unsubmitted draft after the catalog is reloaded", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-draft-cleanup-"));
	const filePath = join(dir, "sessions.json");
	try {
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		await catalog.createDraft({
			projectId: "project-1",
			title: "Never submitted",
			environment: "native",
		});

		const reloaded = new SessionCatalog(filePath);
		await reloaded.load();
		assert.equal(reloaded.listEntries().length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 回归：DSH 草稿必须跨重启保留（host 会话由 $DSH_HOME 持久化，catalog 只是映射）。
// 仅清除 pi 后端（backend !== "dsh"）的草稿；dsh draft（含带 dshSessionId 的异常
// 中间态）与 active 条目都应原样保留。
test("keeps dsh drafts across reload while clearing pi drafts", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-dsh-draft-"));
	const filePath = join(dir, "sessions.json");
	const now = Date.now();
	const entry = (overrides) => ({
		projectId: "project-1",
		title: "Entry",
		source: "pi",
		environment: "native",
		status: "active",
		createdAt: now,
		updatedAt: now,
		...overrides,
	});
	const catalogFile = {
		version: 1,
		sessions: [
			entry({ id: "dsh-draft", title: "DSH draft", backend: "dsh", status: "draft" }),
			entry({
				id: "dsh-draft-with-session",
				title: "DSH draft (mid-activation)",
				backend: "dsh",
				status: "draft",
				dshSessionId: "session-host-orphan",
			}),
			entry({ id: "pi-draft", title: "Pi draft", status: "draft" }),
			entry({ id: "active", title: "Active", status: "active" }),
		],
	};
	try {
		await writeFile(filePath, JSON.stringify(catalogFile), "utf8");
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		const ids = new Map(catalog.listEntries().map((item) => [item.id, item]));
		assert.equal(ids.size, 3, "pi draft should be cleared on load");
		assert.equal(ids.get("dsh-draft")?.status, "draft", "dsh draft without dshSessionId must survive");
		assert.equal(ids.get("dsh-draft-with-session")?.status === "draft" && ids.get("dsh-draft-with-session")?.dshSessionId === "session-host-orphan", true, "dsh draft with dshSessionId (abnormal mid-state) must survive");
		assert.equal(ids.get("active")?.status, "active", "active entry preserved");
		assert.equal(ids.get("pi-draft"), undefined, "pi draft removed from memory");
		// 清理结果应落盘：磁盘上也不再有 pi draft
		const persisted = JSON.parse(await readFile(filePath, "utf8"));
		const persistedIds = persisted.sessions.map((item) => item.id);
		assert.ok(persistedIds.includes("dsh-draft"), "dsh draft persisted after cleanup");
		assert.ok(persistedIds.includes("dsh-draft-with-session"), "dsh mid-state draft persisted after cleanup");
		assert.ok(!persistedIds.includes("pi-draft"), "pi draft not persisted after cleanup");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("persists an active session backend switch from pi to dsh", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-backend-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		// 未发送的 draft 会在重启时被清理（load 清理逻辑），要验证持久化必须让会话 active。
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "New session",
			environment: "native",
		});
		await catalog.attachRuntime({
			sessionId: draft.id,
			filePath: "C:\\Sessions\\Example.jsonl",
		});
		const updated = await catalog.update(draft.id, { backend: "dsh" });
		assert.equal(updated.backend, "dsh");
		const reloaded = new SessionCatalog(join(dir, "sessions.json"));
		await reloaded.load();
		assert.equal(reloaded.getRecord(draft.id)?.backend, "dsh");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("persists DSH session id so a restarted app can attach the same host session", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-dsh-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "DSH session",
			environment: "native",
			backend: "dsh",
		});
		// DSH 会话没有 pi 会话文件：attachRuntime 只带 dshSessionId（backend=dsh 的 Coordinator 路径）。
		await catalog.attachRuntime({
			sessionId: draft.id,
			dshSessionId: "session-host-abc123",
		});
		const record = catalog.getRecord(draft.id);
		assert.equal(record?.dshSessionId, "session-host-abc123");
		assert.equal(record?.filePath, undefined, "DSH 会话不落 pi 会话文件");
		assert.equal(record?.status, "draft", "预热只绑 host id，不能把空草稿抬成 active");
		// 重启后 catalog 重载：dshSessionId 存活，Coordinator 可据此 attach 旧会话。
		const reloaded = new SessionCatalog(join(dir, "sessions.json"));
		await reloaded.load();
		const restored = reloaded.getRecord(draft.id);
		assert.equal(restored?.backend, "dsh");
		assert.equal(restored?.dshSessionId, "session-host-abc123");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("imports a foreign DSH session as active (survives restart cleanup, attachable)", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-foreign-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		// 外部（dsh-web 等）会话导入：createDraft 带 dshSessionId 直接置 active，
		// 不经过「创建→发送→attach」的激活链路。
		const imported = await catalog.createDraft({
			projectId: "project-1",
			title: "dsh-web session",
			environment: "native",
			backend: "dsh",
			dshSessionId: "session-foreign-xyz789",
		});
		assert.equal(imported.status, "active", "imported session must be active, not draft");
		assert.equal(imported.dshSessionId, "session-foreign-xyz789");
		// 重启清理只删 pi draft：active 的导入会话必须保留并可 attach。
		const reloaded = new SessionCatalog(join(dir, "sessions.json"));
		await reloaded.load();
		const restored = reloaded.getRecord(imported.id);
		assert.equal(restored?.status, "active");
		assert.equal(restored?.dshSessionId, "session-foreign-xyz789");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("remembered dismissed DSH sessions survive reload and stay out of createDraft", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-dismissed-dsh-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const imported = await catalog.createDraft({
			projectId: "project-1",
			title: "Gone",
			environment: "native",
			backend: "dsh",
			dshSessionId: "session-gone",
		});
		await catalog.rememberDismissedDshSession("session-gone");
		await catalog.remove(imported.id);
		assert.equal(catalog.listDismissedDshSessionIds().has("session-gone"), true);

		const reloaded = new SessionCatalog(join(dir, "sessions.json"));
		await reloaded.load();
		assert.equal(reloaded.listDismissedDshSessionIds().has("session-gone"), true);
		assert.equal(reloaded.listEntries().length, 0);
		// 自动同步/刷新不得清墓碑：否则删映射后磁盘还在就会写回侧栏。
		await assert.rejects(
			() =>
				reloaded.createDraft({
					projectId: "project-1",
					title: "Back again",
					environment: "native",
					backend: "dsh",
					dshSessionId: "session-gone",
				}),
			{ message: "DISMISSED_DSH_SESSION" },
		);
		assert.equal(reloaded.listEntries().length, 0);
		assert.equal(reloaded.listDismissedDshSessionIds().has("session-gone"), true);
		// 手动导入是用户明确找回：带 restoreDismissed 才成功并清掉墓碑。
		const restored = await reloaded.createDraft({
			projectId: "project-1",
			title: "Back again",
			environment: "native",
			backend: "dsh",
			dshSessionId: "session-gone",
			restoreDismissed: true,
		});
		assert.equal(restored.dshSessionId, "session-gone");
		assert.equal(reloaded.listDismissedDshSessionIds().has("session-gone"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("attachRuntime does not clear a DSH delete tombstone unless restoreDismissed", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-attach-tombstone-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "Live",
			environment: "native",
			backend: "dsh",
		});
		await catalog.rememberDismissedDshSession("session-old");
		await catalog.attachRuntime({
			sessionId: draft.id,
			dshSessionId: "session-old",
		});
		assert.equal(catalog.listDismissedDshSessionIds().has("session-old"), true);
		await catalog.attachRuntime({
			sessionId: draft.id,
			dshSessionId: "session-old",
			restoreDismissed: true,
		});
		assert.equal(catalog.listDismissedDshSessionIds().has("session-old"), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 回归：外部会话重复导入（自动同步与手动导入并发、配置页重复点击、host-ready 重放）
// 必须幂等吸收——同一 dshSessionId 只保留一条记录，后续导入只更新标题/项目归属，
// 否则侧栏出现两条同 host 会话记录（「重复导入」用户问题）。
test("createDraft with the same dshSessionId is idempotent (updates in place, no duplicate)", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-foreign-dedup-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const first = await catalog.createDraft({
			projectId: "project-1",
			title: "Old title",
			environment: "native",
			backend: "dsh",
			dshSessionId: "session-foreign-dedup-1",
		});
		const second = await catalog.createDraft({
			projectId: "project-2",
			title: "New title",
			environment: "native",
			backend: "dsh",
			dshSessionId: "session-foreign-dedup-1",
		});
		assert.equal(second.id, first.id, "same host session must resolve to the same catalog record");
		assert.equal(catalog.listEntries().length, 1);
		assert.equal(second.title, "New title");
		assert.equal(second.projectId, "project-2");
		assert.equal(second.status, "active");
		// 持久化同样只有一条：重启重载后不出现重复。
		const reloaded = new SessionCatalog(join(dir, "sessions.json"));
		await reloaded.load();
		assert.equal(reloaded.listEntries().length, 1);
		assert.equal(reloaded.getRecord(first.id)?.title, "New title");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("createDraft keepExistingTitle preserves title while moving project", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-keep-title-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		await catalog.createDraft({
			projectId: "builtin-external",
			title: "Host 回写标题",
			environment: "native",
			backend: "dsh",
			dshSessionId: "session-keep-title",
		});
		const moved = await catalog.createDraft({
			projectId: "project-elsewhere",
			title: "elsewhere",
			environment: "native",
			backend: "dsh",
			dshSessionId: "session-keep-title",
			keepExistingTitle: true,
		});
		assert.equal(moved.title, "Host 回写标题");
		assert.equal(moved.projectId, "project-elsewhere");
		assert.equal(catalog.listEntries().length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("keeps a draft desktop session ID after Pi assigns a file path", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "New session",
			environment: "native",
			model: { provider: "openai", modelId: "gpt-test" },
			thinkingLevel: "high",
		});
		await catalog.attachRuntime({
			sessionId: draft.id,
			filePath: "C:\\Sessions\\Example.jsonl",
			piSessionId: "pi-123",
		});
		const records = await catalog.mergeScanned("project-1", [
			summary({
				filePath: "c:/sessions/example.jsonl",
				id: "c:/sessions/example.jsonl",
			}),
		]);
		assert.equal(records.length, 1);
		assert.equal(records[0].id, draft.id);
		assert.equal(records[0].status, "active");
		assert.equal(records[0].model?.provider, "openai");
		assert.equal(records[0].model?.modelId, "gpt-test");
		assert.equal(records[0].thinkingLevel, "high");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("uses the configured WSL identity when a draft becomes active", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {
			wslDistro: "Ubuntu",
			wslUser: "dev",
		});
		await catalog.load();
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "WSL draft",
			environment: "wsl",
		});
		await catalog.attachRuntime({
			sessionId: draft.id,
			filePath: "/home/dev/.pi/agent/sessions/example.jsonl",
		});
		const records = await catalog.mergeScanned(
			"project-1",
			[
				summary({
					filePath: "/home/dev/.pi/agent/sessions/example.jsonl",
					id: "/home/dev/.pi/agent/sessions/example.jsonl",
					wsl: true,
				}),
			],
			{ wslDistro: "Ubuntu", wslUser: "dev" },
		);
		assert.equal(records.length, 1);
		assert.equal(records[0].id, draft.id);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("keeps imported identity after activation and rescan", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	const filePath = join(dir, "sessions.json");
	try {
		const imported = summary({
			source: "codex",
			codexSessionId: "codex-thread-42",
			filePath: "C:/sessions/codex.jsonl",
			id: "C:/sessions/codex.jsonl",
		});
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		const [first] = await catalog.mergeScanned("project-1", [imported]);
		await catalog.attachRuntime({
			sessionId: first.id,
			filePath: imported.filePath,
			piSessionId: "pi-imported",
		});

		const reloaded = new SessionCatalog(filePath);
		await reloaded.load();
		const rescanned = await reloaded.mergeScanned("project-1", [imported]);
		assert.equal(rescanned.length, 1);
		assert.equal(rescanned[0].id, first.id);
		assert.equal(rescanned[0].importedSourceId, "codex-thread-42");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("folds a scanner-created duplicate into the original draft ID", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "New session",
			environment: "native",
		});
		const scanned = summary({
			filePath: "C:/sessions/raced.jsonl",
			id: "C:/sessions/raced.jsonl",
		});
		const duringRace = await catalog.mergeScanned("project-1", [scanned]);
		assert.equal(duringRace.length, 2);

		await catalog.attachRuntime({
			sessionId: draft.id,
			filePath: "C:/sessions/raced.jsonl",
			piSessionId: "pi-raced",
		});
		const afterAttach = await catalog.mergeScanned("project-1", [scanned]);
		assert.equal(afterAttach.length, 1);
		assert.equal(afterAttach[0].id, draft.id);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("recovers a damaged primary catalog from its atomic backup", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	const filePath = join(dir, "sessions.json");
	try {
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		const first = await catalog.createDraft({
			projectId: "project-1",
			title: "First",
			environment: "native",
		});
		await catalog.attachRuntime({
			sessionId: first.id,
			filePath: "C:/sessions/first.jsonl",
			piSessionId: "pi-first",
		});
		const second = await catalog.createDraft({
			projectId: "project-1",
			title: "Second",
			environment: "native",
		});
		await catalog.attachRuntime({
			sessionId: second.id,
			filePath: "C:/sessions/second.jsonl",
			piSessionId: "pi-second",
		});
		await writeFile(filePath, "{truncated", "utf8");

		const recovered = new SessionCatalog(filePath);
		await recovered.load();
		assert.equal(recovered.listEntries().length, 1);
		assert.equal(recovered.listEntries()[0].id, first.id);
		const repaired = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(repaired.sessions[0].id, first.id);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a failed atomic write does not poison later mutations or memory", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	const filePath = join(dir, "sessions.json");
	let failPrimaryRename = true;
	const realFs = nodeRequire("node:fs/promises");
	const fsWithOneFailure = {
		...realFs,
		rename: async (source, target) => {
			if (target === filePath && failPrimaryRename) {
				failPrimaryRename = false;
				const error = new Error("simulated rename failure");
				error.code = "EIO";
				throw error;
			}
			return renameFile(source, target);
		},
	};
	const { SessionCatalog } = loadCatalog(fsWithOneFailure);
	try {
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		await assert.rejects(
			catalog.createDraft({
				projectId: "project-1",
				title: "Failed",
				environment: "native",
			}),
			/simulated rename failure/,
		);
		assert.equal(catalog.listEntries().length, 0);

		const saved = await catalog.createDraft({
			projectId: "project-1",
			title: "Saved",
			environment: "native",
		});
		assert.equal(catalog.listEntries().length, 1);
		assert.equal(catalog.listEntries()[0].id, saved.id);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("backup rename EPERM after retries does not fail the catalog write (issue: create-draft blocked)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	const filePath = join(dir, "sessions.json");
	const realFs = nodeRequire("node:fs/promises");
	// 备份轮换（.bak 目标）持续 EPERM：模拟杀软/其他进程长期锁住 .bak
	const fsWithLockedBackup = {
		...realFs,
		rename: async (source, target) => {
			if (target.endsWith(".bak")) {
				const error = new Error("simulated locked backup rename");
				error.code = "EPERM";
				throw error;
			}
			return renameFile(source, target);
		},
	};
	const { SessionCatalog } = loadCatalog(fsWithLockedBackup);
	try {
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		// 备份轮换失败不应阻断主文件原子写入：新建会话必须仍然成功
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "Saved despite locked backup",
			environment: "native",
		});
		assert.equal(catalog.listEntries().length, 1);
		assert.equal(catalog.listEntries()[0].id, draft.id);
		const snapshot = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(snapshot.sessions[0].id, draft.id);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("backup rename transient EPERM recovers via retry and still rotates the backup", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	const filePath = join(dir, "sessions.json");
	const realFs = nodeRequire("node:fs/promises");
	let backupRenameAttempts = 0;
	const fsWithFlakyBackup = {
		...realFs,
		rename: async (source, target) => {
			if (target.endsWith(".bak")) {
				backupRenameAttempts += 1;
				// 前两次失败（模拟杀软瞬时扫描锁），第三次开始成功
				if (backupRenameAttempts <= 2) {
					const error = new Error("simulated transient backup lock");
					error.code = "EPERM";
					throw error;
				}
			}
			return renameFile(source, target);
		},
	};
	const { SessionCatalog } = loadCatalog(fsWithFlakyBackup);
	try {
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		// 首次写入没有可备份的主文件；第二次写入才触发备份轮换
		await catalog.createDraft({
			projectId: "project-1",
			title: "First",
			environment: "native",
		});
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "Recovered backup",
			environment: "native",
		});
		assert.ok(catalog.listEntries().some((entry) => entry.id === draft.id));
		// 重试成功后 .bak 应已轮换：内容是本次写入前的旧快照（滞后一版）
		const snapshot = JSON.parse(await readFile(filePath, "utf8"));
		const backup = JSON.parse(await readFile(`${filePath}.bak`, "utf8"));
		assert.equal(snapshot.sessions.length, 2);
		assert.equal(backup.sessions.length, 1);
		assert.equal(backup.sessions[0].title, "First");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("maps scanned child parent paths to desktop session IDs and survives reload", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	const filePath = join(dir, "sessions.json");
	try {
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		const first = await catalog.mergeScanned("project-1", [
			summary({ filePath: "C:/sessions/parent.jsonl", id: "C:/sessions/parent.jsonl", name: "Parent" }),
			summary({
				filePath: "C:/sessions/parent/child.jsonl",
				id: "C:/sessions/parent/child.jsonl",
				name: "Child",
				parentSessionPath: "c:/sessions/parent.jsonl",
			}),
		]);
		const parent = first.find((record) => record.title === "Parent");
		const child = first.find((record) => record.title === "Child");
		assert.ok(parent);
		assert.equal(child?.parentSessionId, parent?.id);

		const reloaded = new SessionCatalog(filePath);
		await reloaded.load();
		const second = await reloaded.mergeScanned("project-1", [
			summary({ filePath: "c:/sessions/parent.jsonl", id: "c:/sessions/parent.jsonl", name: "Parent" }),
			summary({
				filePath: "c:/sessions/parent/child.jsonl",
				id: "c:/sessions/parent/child.jsonl",
				name: "Child",
				parentSessionPath: "C:/sessions/parent.jsonl",
			}),
		]);
		assert.equal(second.find((record) => record.title === "Parent")?.id, parent?.id);
		assert.equal(second.find((record) => record.title === "Child")?.parentSessionId, parent?.id);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("DSH attachRuntime ignores zstd filePath and only promotes draft when asked", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-dsh-promote-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "DSH session",
			environment: "native",
			backend: "dsh",
		});
		await catalog.attachRuntime({
			sessionId: draft.id,
			filePath: "C:\\Users\\me\\.dsh\\sessions\\ws\\session-1\\session.jsonl.zst",
			dshSessionId: "session-host-abc123",
		});
		const warmed = catalog.getRecord(draft.id);
		assert.equal(warmed?.filePath, undefined, "zstd 不得写入 filePath");
		assert.equal(warmed?.status, "draft");
		await catalog.attachRuntime({
			sessionId: draft.id,
			dshSessionId: "session-host-abc123",
			promoteToActive: true,
		});
		assert.equal(catalog.getRecord(draft.id)?.status, "active");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("runtime event attachment rejects active origin changes but accepts metadata drafts", () => {
	const { canAttachRuntimeMetadata } = loadCatalog();
	const active = {
		id: "old",
		projectId: "project-1",
		title: "Old",
		source: "pi",
		environment: "native",
		filePath: "C:/sessions/old.jsonl",
		status: "active",
		createdAt: 1,
		updatedAt: 1,
	};
	assert.equal(
		canAttachRuntimeMetadata(active, {
			sessionPath: "C:/sessions/new.jsonl",
			sessionSource: "pi",
			sessionEnvironment: "native",
		}),
		false,
	);
	assert.equal(
		canAttachRuntimeMetadata(
			{ ...active, filePath: undefined, status: "draft" },
			{
				sessionPath: "C:/sessions/new.jsonl",
				sessionSource: "pi",
				sessionEnvironment: "native",
			},
		),
		true,
	);
	assert.equal(
		canAttachRuntimeMetadata(
			{
				...active,
				backend: "dsh",
				filePath: undefined,
				status: "draft",
			},
			{
				sessionPath: "C:/Users/me/.dsh/sessions/ws/session-1/session.jsonl.zst",
				backend: "dsh",
			},
		),
		false,
		"DSH zstd 路径不得走 pi 文件配对",
	);
});

test("removes an unstarted draft from the durable catalog", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	const filePath = join(dir, "sessions.json");
	try {
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "Accidental agent",
			environment: "native",
		});
		assert.equal(catalog.get(draft.id)?.status, "draft");
		assert.equal(catalog.get(draft.id)?.filePath, undefined);

		assert.equal(await catalog.remove(draft.id), true);
		assert.equal(catalog.get(draft.id), undefined);
		const snapshot = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(
			snapshot.sessions.some((entry) => entry.id === draft.id),
			false,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("keeps anonymous records in memory and excludes them from the durable catalog", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	const filePath = join(dir, "sessions.json");
	try {
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		const anonymous = catalog.createAnonymous({
			projectId: "project-1",
			title: "Anonymous Chat",
			environment: "native",
		});
		assert.equal(anonymous.noSession, true);
		assert.equal((await catalog.mergeScanned("project-1", [])).map((record) => record.id).includes(anonymous.id), true);
		await assert.rejects(readFile(filePath, "utf8"), /ENOENT/);

		await catalog.createDraft({
			projectId: "project-1",
			title: "Saved draft",
			environment: "native",
		});
		const snapshot = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(
			snapshot.sessions.some((entry) => entry.id === anonymous.id),
			false,
		);

		const reloaded = new SessionCatalog(filePath);
		await reloaded.load();
		assert.equal(reloaded.get(anonymous.id), undefined);
		assert.equal(catalog.removeTransient(anonymous.id), true);
		assert.equal(catalog.get(anonymous.id), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("runtime replacement resolves a full-origin target without mutating the origin record", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const [origin] = await catalog.mergeScanned(
			"project-1",
			[
				summary({
					source: "codex",
					codexSessionId: "import-origin",
					filePath: "/home/dev/origin.jsonl",
					id: "/home/dev/origin.jsonl",
					wsl: true,
				}),
			],
			{ wslDistro: "Ubuntu", wslUser: "dev" },
		);
		const before = catalog.get(origin.id);

		const target = await catalog.ensureRuntimeTarget({
			projectId: "project-1",
			title: "Replacement",
			source: "codex",
			environment: "wsl",
			filePath: "/home/dev/replacement.jsonl",
			wslDistro: "Ubuntu",
			wslUser: "dev",
			importedSourceId: "import-target",
			piSessionId: "pi-target",
		});
		const repeated = await catalog.ensureRuntimeTarget({
			projectId: "project-1",
			title: "Replacement",
			source: "codex",
			environment: "wsl",
			filePath: "/home/dev/replacement.jsonl",
			wslDistro: "Ubuntu",
			wslUser: "dev",
			importedSourceId: "import-target",
			piSessionId: "pi-target",
		});

		assert.notEqual(target.id, origin.id);
		assert.equal(repeated.id, target.id);
		assert.equal(catalog.listEntries().filter((entry) => entry.id === target.id).length, 1);
		assert.deepEqual({ ...catalog.get(origin.id) }, { ...before });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ── 相对 sessionFile 归一化（2026-08 侧栏重复会话回归）─────────────
// 背景：pi 的 sessionDir 配置为相对路径（如 ".pi/sessions"）时，get_state 返回的
// sessionFile 是相对 cwd 的；原样写入 catalog 会与扫描器绝对路径 originKey 不同，
// 同一会话在侧栏出现两条记录（一条输入推断名 + 一条默认 "{项目名} agent"）。

function absolutePathResolver(projectRoot) {
	return (projectId, filePath, environment) => {
		assert.equal(projectId, "project-1");
		return filePath.startsWith(".") ? `${projectRoot}\\${filePath.replace(/^[\\/]+/, "")}` : filePath;
	};
}

test("load repairs legacy relative filePaths via the injected resolver", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	const filePath = join(dir, "sessions.json");
	try {
		// 模拟旧版本写入的相对路径条目（含按相对路径计算的旧 originKey）
		const legacy = {
			id: "rel-entry",
			projectId: "project-1",
			originKey: "pi:native:.pi/sessions/2026-08-08t10-47-19-239z_abc.jsonl",
			title: "PiDeck agent",
			source: "pi",
			environment: "native",
			filePath: ".pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl",
			status: "active",
			createdAt: 1000,
			updatedAt: 1000,
		};
		await writeFile(filePath, JSON.stringify({ version: 1, sessions: [legacy] }), "utf8");

		const catalog = new SessionCatalog(filePath, {}, absolutePathResolver("D:\\Project\\PiDeck"));
		await catalog.load();

		const [entry] = catalog.listEntries();
		assert.equal(entry.filePath, "D:\\Project\\PiDeck\\.pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl");
		// originKey 必须随路径重算，否则后续 mergeScanned 仍按旧 key 去重
		assert.match(entry.originKey, /d:\/project\/pideck\/\.pi\/sessions/);

		// 修复结果应落盘，重启后不需要再修
		const onDisk = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(onDisk.sessions[0].filePath, entry.filePath);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("attachRuntime absolutizes a relative pi sessionFile and folds the scanned absolute entry in", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, absolutePathResolver("D:\\Project\\PiDeck"));
		await catalog.load();
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "PiDeck agent",
			environment: "native",
		});

		// pi 返回相对 cwd 的 sessionFile（sessionDir 配置为 ".pi/sessions"）
		await catalog.attachRuntime({
			sessionId: draft.id,
			filePath: ".pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl",
			piSessionId: "pi-relative",
		});

		// 后台扫描发现同一文件的绝对路径（修复前这里会产生第二条记录）
		const scanned = summary({
			id: "D:\\Project\\PiDeck\\.pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl",
			filePath: "D:\\Project\\PiDeck\\.pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl",
			name: "从用户输入推断的会话名",
		});
		const records = await catalog.mergeScanned("project-1", [scanned]);

		assert.equal(records.length, 1);
		assert.equal(records[0].id, draft.id);
		assert.equal(records[0].filePath, scanned.filePath);
		assert.equal(records[0].title, "从用户输入推断的会话名");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ensureRuntimeTarget absolutizes relative session paths", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, absolutePathResolver("D:\\Project\\PiDeck"));
		await catalog.load();
		const record = await catalog.ensureRuntimeTarget({
			projectId: "project-1",
			title: "Copied",
			source: "pi",
			environment: "native",
			filePath: ".pi\\sessions\\copied.jsonl",
		});
		assert.equal(record.filePath, "D:\\Project\\PiDeck\\.pi\\sessions\\copied.jsonl");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("removeByProjectId drops every catalog entry for a removed sidebar project", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-remove-project-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		await catalog.createDraft({
			projectId: "gone-project",
			title: "Keep me out",
			environment: "native",
			backend: "dsh",
			dshSessionId: "session-gone",
		});
		await catalog.createDraft({
			projectId: "keep-project",
			title: "Stay",
			environment: "native",
			backend: "dsh",
			dshSessionId: "session-keep",
		});
		const removed = await catalog.removeByProjectId("gone-project");
		assert.equal(removed, 1);
		assert.equal(catalog.listEntries().length, 1);
		assert.equal(catalog.listEntries()[0].projectId, "keep-project");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("load rewrites pi file-stem timestamp titles so the sidebar is not a list of dates", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-ts-title-"));
	const filePath = join(dir, "sessions.json");
	try {
		await writeFile(
			filePath,
			JSON.stringify({
				version: 1,
				sessions: [
					{
						id: "sess-1",
						projectId: "project-1",
						title: "2026-08-08T10-47-19-239Z_abc",
						source: "pi",
						environment: "native",
						filePath: "C:/sessions/2026-08-08T10-47-19-239Z_abc.jsonl",
						status: "active",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			}),
			"utf8",
		);
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		assert.equal(catalog.getRecord("sess-1")?.title, "Untitled");
		const onDisk = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(onDisk.sessions[0].title, "Untitled");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("promoteToActive lifts a draft so it survives reload (staleDrafts purge)", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-promote-"));
	const filePath = join(dir, "sessions.json");
	try {
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "Imagegen draft",
			environment: "native",
			source: "pi",
		});
		assert.equal(draft.status, "draft");
		// 生图草稿已落盘到 ImageSession：提升为 active，防重启时 staleDrafts 清理丢入口
		const promoted = await catalog.promoteToActive(draft.id);
		assert.equal(promoted.status, "active");
		// 重启（重载 catalog）：active 条目不会被 staleDrafts 清理
		const catalog2 = new SessionCatalog(filePath);
		await catalog2.load();
		assert.ok(catalog2.getRecord(draft.id), "promoted draft must survive reload");
		// 幂等：对 active 再次 promote 不改变状态
		const again = await catalog2.promoteToActive(draft.id);
		assert.equal(again.status, "active");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("nameless scanned summaries keep existing titles and use the file stem for new rows", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-stem-title-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const [named] = await catalog.mergeScanned("project-1", [
			summary({
				filePath: "C:/sessions/known.jsonl",
				id: "C:/sessions/known.jsonl",
				name: "Saved title",
			}),
		]);
		const [kept] = await catalog.mergeScanned("project-1", [
			summary({
				filePath: "C:/sessions/known.jsonl",
				id: "C:/sessions/known.jsonl",
				name: undefined,
				preview: "",
				messageCount: 0,
			}),
		]);
		assert.equal(kept.id, named.id);
		assert.equal(kept.title, "Saved title");
		assert.equal(kept.preview, "");

		const records = await catalog.mergeScanned("project-1", [
			summary({
				filePath: "C:/sessions/2026-08-08T10-47-19-239Z_abc.jsonl",
				id: "C:/sessions/2026-08-08T10-47-19-239Z_abc.jsonl",
				name: undefined,
			}),
		]);
		const fresh = records.find((record) => record.filePath?.includes("2026-08-08T10-47-19-239Z_abc"));
		// pi JSONL 文件名是时间戳，不能当侧栏标题（用户看到的是一排日期，不是会话名）。
		assert.equal(fresh?.title, "Untitled");

		// 扫描器若仍把 sessionName=文件名带进 summary.name，也不能盖掉用户已有标题。
		const afterStemName = await catalog.mergeScanned("project-1", [
			summary({
				filePath: "C:/sessions/known.jsonl",
				id: "C:/sessions/known.jsonl",
				name: "2026-08-08T10-47-19-239Z_abc",
			}),
		]);
		assert.equal(afterStemName.find((record) => record.filePath === "C:/sessions/known.jsonl")?.title, "Saved title");

		const withStemName = await catalog.mergeScanned("project-1", [
			summary({
				filePath: "C:/sessions/2026-08-08T11-00-00-000Z_def.jsonl",
				id: "C:/sessions/2026-08-08T11-00-00-000Z_def.jsonl",
				name: "2026-08-08T11-00-00-000Z_def",
			}),
		]);
		assert.equal(withStemName.find((record) => record.filePath?.includes("2026-08-08T11-00-00-000Z_def"))?.title, "Untitled");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("parentSessionPath survives reload: getRecord/listEntries rebuild keeps the subagent tree link", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-parent-path-"));
	const filePath = join(dir, "sessions.json");
	try {
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		await catalog.mergeScanned("project-1", [
			summary({ filePath: "C:/sessions/parent.jsonl", id: "C:/sessions/parent.jsonl", name: "Parent" }),
			summary({
				filePath: "C:/sessions/parent/child.jsonl",
				id: "C:/sessions/parent/child.jsonl",
				name: "Child",
				parentSessionPath: "c:/sessions/parent.jsonl",
			}),
		]);

		// 重载：模拟重启后从磁盘恢复 entry，再走 getRecord（缓存先回显路径）
		const reloaded = new SessionCatalog(filePath);
		await reloaded.load();
		const entries = reloaded.listEntries().filter((entry) => entry.projectId === "project-1");
		const childEntry = entries.find((entry) => entry.title === "Child");
		assert.ok(childEntry, "child entry restored from disk");
		const record = childEntry ? reloaded.getRecord(childEntry.id) : undefined;
		// 回归：entry 必须持久化 parentSessionPath，否则缓存回显时子会话降级为顶层孤儿
		// 大小写不敏感断言：渲染层 normalizeSessionPathForCompare 比较，功能不受大小写影响
		assert.ok(record?.parentSessionPath);
		assert.equal(record?.parentSessionPath?.toLowerCase().replace(/\\/g, "/"), "c:/sessions/parent.jsonl");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 回归：pi-subagents artifactDir="session"（默认）的产物转储曾被旧版扫描误注册成
// active 条目，导致每个子代理在侧栏「嵌套 + 顶层平铺」重复显示。扫描端过滤后，
// mergeScanned 必须按同一路径规则清洗这些存量条目并落盘，否则重启后仍会回流。
test("mergeScanned drops legacy subagent-artifacts entries", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-artifacts-cleanup-"));
	const filePath = join(dir, "sessions.json");
	try {
		const now = Date.now();
		const dirtyEntry = {
			id: "dirty-artifact",
			projectId: "project-1",
			title: "31f02534_reviewer_0_transcript",
			source: "pi",
			environment: "native",
			status: "active",
			originKey: "pi:native:c:/users/x/.pi/agent/sessions/--c--repo--/subagent-artifacts/31f02534_reviewer_0_transcript.jsonl",
			filePath: "C:\\Users\\X\\.pi\\agent\\sessions\\--C--repo--\\subagent-artifacts\\31f02534_reviewer_0_transcript.jsonl",
			createdAt: now,
			updatedAt: now,
		};
		const goodEntry = {
			id: "good-session",
			projectId: "project-1",
			title: "Real session",
			source: "pi",
			environment: "native",
			status: "active",
			originKey: "pi:native:c:/users/x/.pi/agent/sessions/--c--repo--/real.jsonl",
			filePath: "C:\\Users\\X\\.pi\\agent\\sessions\\--C--repo--\\real.jsonl",
			createdAt: now,
			updatedAt: now,
		};
		await writeFile(filePath, JSON.stringify({ version: 1, sessions: [dirtyEntry, goodEntry] }), "utf8");
		const catalog = new SessionCatalog(filePath);
		await catalog.load();

		// 正常扫描只包含真实会话：脏条目应被移除，正常条目保留
		const records = await catalog.mergeScanned("project-1", [summary({ id: goodEntry.filePath, filePath: goodEntry.filePath, name: "Real session" })]);
		const recordIds = records.map((record) => record.id);
		assert.ok(!recordIds.includes("dirty-artifact"), "artifact entry must be dropped from records");
		assert.ok(recordIds.includes("good-session"), "real session must stay");

		// 清洗必须落盘：重启后不再回流
		const reloaded = new SessionCatalog(filePath);
		await reloaded.load();
		assert.equal(reloaded.getRecord("dirty-artifact"), undefined, "cleanup must persist");
		assert.ok(reloaded.getRecord("good-session"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 回归：归档/删除父会话时磁盘会把 sibling `<stem>/` 一并移走，但 catalog.remove(id)
// 只摘一条。mergeScanned 只增改不删，列表缓存会立刻把子会话孤儿提升成顶层行，
// 再点开就是残留聊天框。removeWithDescendants 必须清掉整棵子树，且不得误伤
// 匿名会话、草稿、其它项目。
test("removeWithDescendants drops nested subagent catalog entries with the parent", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-catalog-archive-descendants-"));
	const filePath = join(dir, "sessions.json");
	try {
		const catalog = new SessionCatalog(filePath);
		await catalog.load();
		const records = await catalog.mergeScanned("project-1", [
			summary({ filePath: "C:/sessions/parent.jsonl", id: "C:/sessions/parent.jsonl", name: "Parent" }),
			summary({
				filePath: "C:/sessions/parent/child.jsonl",
				id: "C:/sessions/parent/child.jsonl",
				name: "Child",
				parentSessionPath: "c:/sessions/parent.jsonl",
			}),
			summary({
				filePath: "C:/sessions/parent/child/nested.jsonl",
				id: "C:/sessions/parent/child/nested.jsonl",
				name: "Grandchild",
				parentSessionPath: "C:/sessions/parent/child.jsonl",
			}),
			summary({ filePath: "C:/sessions/other.jsonl", id: "C:/sessions/other.jsonl", name: "Unrelated" }),
		]);
		await catalog.mergeScanned("project-2", [summary({ filePath: "C:/other-project/keep.jsonl", id: "C:/other-project/keep.jsonl", name: "Other project" })]);
		const parent = records.find((record) => record.title === "Parent");
		const child = records.find((record) => record.title === "Child");
		const grandchild = records.find((record) => record.title === "Grandchild");
		const unrelated = records.find((record) => record.title === "Unrelated");
		assert.ok(parent && child && grandchild && unrelated);

		const anonymous = catalog.createAnonymous({
			projectId: "project-1",
			title: "Anonymous Chat",
			environment: "native",
		});
		const draft = await catalog.createDraft({
			projectId: "project-1",
			title: "Saved draft",
			environment: "native",
		});

		const oneId = await catalog.remove(unrelated.id);
		assert.equal(oneId, true, "remove() remains a single-id operation");
		await catalog.mergeScanned("project-1", [summary({ filePath: "C:/sessions/other.jsonl", id: "C:/sessions/other.jsonl", name: "Unrelated" })]);
		const restoredUnrelated = catalog.listEntries().find((entry) => entry.title === "Unrelated");
		assert.ok(restoredUnrelated, "unrelated session can still be merged back");

		const removedIds = await catalog.removeWithDescendants(parent.id);
		assert.ok(removedIds.includes(parent.id));
		assert.ok(removedIds.includes(child.id));
		assert.ok(removedIds.includes(grandchild.id));
		assert.equal(catalog.get(parent.id), undefined);
		assert.equal(catalog.get(child.id), undefined);
		assert.equal(catalog.get(grandchild.id), undefined);
		assert.ok(catalog.get(restoredUnrelated.id), "unrelated file-backed session must stay");
		assert.ok(catalog.get(anonymous.id), "anonymous sessions must survive parent archive");
		assert.ok(catalog.get(draft.id), "drafts must survive parent archive");
		assert.ok(
			catalog.listEntries().some((entry) => entry.title === "Other project"),
			"other-project sessions must stay",
		);

		const persisted = JSON.parse(await readFile(filePath, "utf8"));
		const persistedTitles = persisted.sessions.map((entry) => entry.title);
		assert.ok(!persistedTitles.includes("Parent"));
		assert.ok(!persistedTitles.includes("Child"));
		assert.ok(!persistedTitles.includes("Grandchild"));
		assert.ok(persistedTitles.includes("Unrelated"));
		assert.ok(persistedTitles.includes("Saved draft"));
		assert.ok(persistedTitles.includes("Other project"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
