import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DshHost } = loadTsCommonJs("src/main/dsh/DshHost.ts");
const { workspaceDirFor } = loadTsCommonJs("src/main/dsh/dshSessionPath.ts");

/** 构造归档测试宿主：DSH_HOME 指向临时目录（覆盖 getter 优先，不碰真实 ~/.dsh）。 */
function makeHost() {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-archive-"));
	const host = new DshHost(
		() => join(home, "userData"),
		() => home,
		() => undefined,
		() => home,
	);
	return { host, home };
}

/** 在 sessions 树里造一个假 host 会话目录（session.jsonl.zstd 占位）。 */
function makeSessionDir(home, cwd, sessionId) {
	const dir = join(home, "sessions", workspaceDirFor(cwd), sessionId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "session.jsonl.zstd"), "fake-log");
	return dir;
}

test("DshHost.archiveSession：目录移入 .pideck/archive 并写 manifest（含标题）", async () => {
	const { host, home } = makeHost();
	try {
		const cwd = "C:/work/project";
		const sessionId = "session-abc-123";
		const sourceDir = makeSessionDir(home, cwd, sessionId);
		const archived = await host.archiveSession(sessionId, cwd, "打包的体积是否能优化");
		assert.ok(archived.endsWith(join(".pideck", "archive", sessionId)), `归档路径: ${archived}`);
		assert.ok(!existsSync(sourceDir), "原 sessions 树目录应已移走");
		const manifest = JSON.parse(readFileSync(join(archived, "pideck-manifest.json"), "utf8"));
		assert.equal(manifest.dshSessionId, sessionId);
		assert.equal(manifest.cwd, cwd);
		assert.equal(typeof manifest.archivedAt, "number");
		// G14+：归档时刻的会话标题随 manifest 持久化（恢复/列表直接可用）
		assert.equal(manifest.title, "打包的体积是否能优化");
		// 会话日志随目录一起保留（不销毁数据）
		assert.ok(existsSync(join(archived, "session.jsonl.zstd")));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.archiveSession：无标题时不写 title 字段（旧归档兼容）", async () => {
	const { host, home } = makeHost();
	try {
		const cwd = "C:/work/project";
		const sessionId = "session-no-title";
		makeSessionDir(home, cwd, sessionId);
		await host.archiveSession(sessionId, cwd);
		const manifest = JSON.parse(readFileSync(join(home, ".pideck", "archive", sessionId, "pideck-manifest.json"), "utf8"));
		assert.ok(!("title" in manifest), "未提供标题时 manifest 不应写 title");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.archiveSession：会话不存在返回 undefined（不产生归档目录）", async () => {
	const { host, home } = makeHost();
	try {
		const archived = await host.archiveSession("session-missing", "C:/work/project");
		assert.equal(archived, undefined);
		assert.ok(!existsSync(join(home, ".pideck", "archive")), "不应创建归档根目录");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.unarchiveSession：按 manifest 的 cwd 移回原 workspace 目录，并返回 manifest 标题", async () => {
	const { host, home } = makeHost();
	try {
		const cwd = "C:/work/project";
		const sessionId = "session-abc-123";
		makeSessionDir(home, cwd, sessionId);
		await host.archiveSession(sessionId, cwd, "恢复后要显示的名字");
		const restored = await host.unarchiveSession(sessionId);
		const expected = join(home, "sessions", workspaceDirFor(cwd), sessionId);
		assert.equal(restored.restoredPath, expected);
		assert.equal(restored.cwd, cwd, "应返回 manifest 中的原 workspace cwd（重建 catalog 记录用）");
		assert.equal(restored.title, "恢复后要显示的名字", "应返回 manifest 中归档时刻的标题（重建 catalog 记录用）");
		assert.ok(existsSync(join(expected, "session.jsonl.zstd")), "会话日志应回到 sessions 树");
		assert.ok(!existsSync(join(home, ".pideck", "archive", sessionId)), "归档目录应已移走");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.unarchiveSession：旧归档 manifest 无标题时按日志折叠补全", async () => {
	const { host, home } = makeHost();
	try {
		const cwd = "C:/work/project";
		const sessionId = "session-legacy-fold";
		// 旧归档：manifest 无 title，但日志里有 session/title（未压缩 jsonl 可被只读折叠）
		const sessionDir = join(home, "sessions", workspaceDirFor(cwd), sessionId);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "session.jsonl"), [
			`{"type":"session","id":"${sessionId}","cwd":"${cwd}"}`,
			`{"type":"session/title","seq":1,"data":{"title":"旧归档折叠标题"}}`,
		].join("\n"), "utf8");
		await host.archiveSession(sessionId, cwd);
		const restored = await host.unarchiveSession(sessionId);
		assert.equal(restored.title, "旧归档折叠标题", "旧归档应回退到日志折叠标题，避免恢复后落占位名");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.unarchiveSession：manifest 损坏时不移动目录并返回 undefined", async () => {
	const { host, home } = makeHost();
	try {
		const sessionId = "session-bad-manifest";
		const archiveDir = join(home, ".pideck", "archive", sessionId);
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(join(archiveDir, "pideck-manifest.json"), "{ not json");
		const restored = await host.unarchiveSession(sessionId);
		assert.equal(restored, undefined);
		assert.ok(existsSync(archiveDir), "损坏 manifest 的归档目录不应被移动");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.listArchivedSessions：返回归档清单（id/cwd/archivedAt/标题），跳过无 manifest 目录", async () => {
	const { host, home } = makeHost();
	try {
		const cwd = "C:/work/带空格 项目";
		// 两个真实归档：一个带 manifest 标题，一个不带（日志可折叠出标题）
		makeSessionDir(home, cwd, "session-a");
		makeSessionDir(home, "D:/other", "session-b");
		await host.archiveSession("session-a", cwd, "归档A的标题");
		// session-b 用未压缩 jsonl + session/title 事件，验证旧归档的日志折叠兜底
		const sessionBDir = join(home, "sessions", workspaceDirFor("D:/other"), "session-b");
		rmSync(sessionBDir, { recursive: true, force: true });
		mkdirSync(sessionBDir, { recursive: true });
		writeFileSync(join(sessionBDir, "session.jsonl"), [
			`{"type":"session","id":"session-b","cwd":"D:/other"}`,
			`{"type":"session/title","seq":1,"data":{"title":"归档B折叠标题"}}`,
		].join("\n"), "utf8");
		await host.archiveSession("session-b", "D:/other");
		// 一个无 manifest 的目录（不属于 PiDeck 归档，应被跳过）
		mkdirSync(join(home, ".pideck", "archive", "not-a-pideck-archive"), { recursive: true });

		const listed = host.listArchivedSessions();
		assert.equal(listed.length, 2);
		const byId = new Map(listed.map((item) => [item.dshSessionId, item]));
		assert.equal(byId.get("session-a").cwd, cwd);
		assert.equal(byId.get("session-a").title, "归档A的标题", "manifest 携带的标题应原样返回");
		assert.equal(byId.get("session-b").cwd, "D:/other");
		assert.equal(byId.get("session-b").title, "归档B折叠标题", "旧归档缺标题时应回退日志折叠");
		assert.ok(typeof byId.get("session-a").archivedAt === "number" && byId.get("session-a").archivedAt > 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.listArchivedSessions：无归档区时返回空数组", () => {
	const { host, home } = makeHost();
	try {
		// 注意：vm realm 数组原型不同，不能用 deepEqual 直接比较空数组，按 length 断言
		assert.equal(host.listArchivedSessions().length, 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost 归档往返：编码含不安全字符的 cwd 也能恢复", async () => {
	const { host, home } = makeHost();
	try {
		const cwd = "C:\\work\\项目 dir~1";
		const sessionId = "session-unicode-1";
		makeSessionDir(home, cwd, sessionId);
		await host.archiveSession(sessionId, cwd);
		// 模拟外部改写 manifest（换机迁移等），恢复仍以 manifest 的 cwd 为准
		const manifestPath = join(home, ".pideck", "archive", sessionId, "pideck-manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.cwd = "C:\\work\\项目 dir~1";
		writeFileSync(manifestPath, JSON.stringify(manifest));
		const restored = await host.unarchiveSession(sessionId);
		assert.ok(existsSync(join(restored.restoredPath, "session.jsonl.zstd")), "会话日志应完整恢复");
		assert.equal(readdirSync(join(home, "sessions")).length, 1, "sessions 树应只剩恢复后的 workspace 目录");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.deleteArchivedSession：删除归档目录并返回 true（走注入的回收站回调）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-delarchive-"));
	const trashed = [];
	const host = new DshHost(
		() => join(home, "userData"),
		() => home,
		() => undefined,
		() => home,
		undefined,
		undefined,
		async (path) => { trashed.push(path); rmSync(path, { recursive: true, force: true }); },
	);
	try {
		const cwd = "C:/work/project";
		const sessionId = "session-del-1";
		makeSessionDir(home, cwd, sessionId);
		await host.archiveSession(sessionId, cwd, "要删除的归档");

		const deleted = await host.deleteArchivedSession(sessionId);
		assert.equal(deleted, true, "归档存在时应返回 true");
		assert.equal(trashed.length, 1, "回收站回调应被调用一次");
		assert.ok(trashed[0].endsWith(join(".pideck", "archive", sessionId)), `回收站应收到归档目录: ${trashed[0]}`);
		assert.ok(!existsSync(join(home, ".pideck", "archive", sessionId)), "归档目录应已移入回收站");
		// 删除后归档清单不再包含它
		assert.equal(host.listArchivedSessions().length, 0, "删除后归档清单应为空");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.deleteArchivedSession：无 manifest 目录（非 PiDeck 归档）不删除并返回 false", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-delarchive-guard-"));
	const trashed = [];
	const host = new DshHost(
		() => join(home, "userData"),
		() => home,
		() => undefined,
		() => home,
		undefined,
		undefined,
		async (path) => { trashed.push(path); rmSync(path, { recursive: true, force: true }); },
	);
	try {
		// 无 manifest 的目录不属于 PiDeck 归档，delete 必须拒绝（避免误删非归档数据）
		const archiveDir = join(home, ".pideck", "archive", "session-orphan-dir");
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(join(archiveDir, "other.data"), "not pideck archive");

		const deleted = await host.deleteArchivedSession("session-orphan-dir");
		assert.equal(deleted, false, "无 manifest 时应返回 false");
		assert.equal(trashed.length, 0, "回收站回调不应被调用");
		assert.ok(existsSync(archiveDir), "非归档目录不应被删除");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.deleteArchivedSession：归档目录不存在时返回 false（幂等）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-delarchive-missing-"));
	const trashed = [];
	const host = new DshHost(
		() => join(home, "userData"),
		() => home,
		() => undefined,
		() => home,
		undefined,
		undefined,
		async (path) => { trashed.push(path); rmSync(path, { recursive: true, force: true }); },
	);
	try {
		const deleted = await host.deleteArchivedSession("session-never-existed");
		assert.equal(deleted, false, "不存在时应返回 false");
		assert.equal(trashed.length, 0, "回收站回调不应被调用");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// ── DshHost.deleteSession：活跃 DSH 会话删除到回收站（与 pi 会话删除同语义） ──

test("DshHost.deleteSession：按 cwd 精确推导并移入回收站，返回 true", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-delsession-"));
	const trashed = [];
	const host = new DshHost(
		() => join(home, "userData"),
		() => home,
		() => undefined,
		() => home,
		undefined,
		undefined,
		async (path) => { trashed.push(path); rmSync(path, { recursive: true, force: true }); },
	);
	try {
		const cwd = "C:/work/project";
		const sessionId = "session-active-1";
		const sessionDir = makeSessionDir(home, cwd, sessionId);

		const deleted = await host.deleteSession(sessionId, cwd);
		assert.equal(deleted, true, "会话存在时应返回 true");
		assert.equal(trashed.length, 1, "回收站回调应被调用一次");
		assert.ok(trashed[0].endsWith(join("sessions", workspaceDirFor(cwd), sessionId)),
			`回收站应收到会话目录: ${trashed[0]}`);
		assert.ok(!existsSync(sessionDir), "sessions 树中的会话目录应已移走");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.deleteSession：cwd 失配时按 sessionId 兜底扫描仍能删除", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-delsession-fallback-"));
	const trashed = [];
	const host = new DshHost(
		() => join(home, "userData"),
		() => home,
		() => undefined,
		() => home,
		undefined,
		undefined,
		async (path) => { trashed.push(path); rmSync(path, { recursive: true, force: true }); },
	);
	try {
		// 会话真实位于 A 目录（项目目录后来被移动/改名），catalog 记录的 project.path 已失配
		const realCwd = "C:/work/project";
		const staleCwd = "D:/moved/project";
		const sessionId = "session-moved-1";
		const sessionDir = makeSessionDir(home, realCwd, sessionId);

		const deleted = await host.deleteSession(sessionId, staleCwd);
		assert.equal(deleted, true, "cwd 失配时兜底扫描应命中并删除");
		assert.equal(trashed.length, 1, "回收站回调应被调用一次");
		assert.ok(!existsSync(sessionDir), "会话目录应已移走");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.deleteSession：无会话日志的同名目录不误删（跳过非会话目录）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-delsession-guard-"));
	const trashed = [];
	const host = new DshHost(
		() => join(home, "userData"),
		() => home,
		() => undefined,
		() => home,
		undefined,
		undefined,
		async (path) => { trashed.push(path); rmSync(path, { recursive: true, force: true }); },
	);
	try {
		// 同名目录但里面没有会话日志（不是 DSH 会话目录），不能当会话删
		const decoy = join(home, "sessions", workspaceDirFor("C:/work/project"), "session-decoy");
		mkdirSync(decoy, { recursive: true });
		writeFileSync(join(decoy, "other.data"), "not a dsh session");

		const deleted = await host.deleteSession("session-decoy", "C:/work/project");
		assert.equal(deleted, false, "非会话目录不应被删除");
		assert.equal(trashed.length, 0, "回收站回调不应被调用");
		assert.ok(existsSync(decoy), "非会话目录应原样保留");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("DshHost.deleteSession：目录不存在时返回 false（幂等）", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-dsh-delsession-missing-"));
	const trashed = [];
	const host = new DshHost(
		() => join(home, "userData"),
		() => home,
		() => undefined,
		() => home,
		undefined,
		undefined,
		async (path) => { trashed.push(path); rmSync(path, { recursive: true, force: true }); },
	);
	try {
		const deleted = await host.deleteSession("session-never-existed", "C:/work/project");
		assert.equal(deleted, false, "不存在时应返回 false");
		assert.equal(trashed.length, 0, "回收站回调不应被调用");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
