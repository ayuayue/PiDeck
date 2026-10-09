import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * SessionCatalog 标题所有权来源（titleOrigin）回归测试。
 *
 * 背景（issue #266，v0.7.7 回归）：refreshAutoTitle 的「首条消息兜底名」和扩展的
 * 「模型自动命名」都走 applyAutomaticTitle 抢先领取占位标题，先到者把条目锁成终态，
 * 后到的强来源（扩展）被 isTitleLocked 拒掉 —— 自动命名只在消息轮次恰好晚于扩展时
 * 才生效（时序抽奖）。
 *
 * 修复后的所有权模型：
 *   - undefined：未确认（占位名，留一次初始化机会）
 *   - "fallback"：内容派生兜底（首条消息 / 扫描弱回退），可被 "auto" 覆盖
 *   - "auto"：扩展经 marker 校验的模型标题，终态
 *   - "manual"：用户改名 / 导入 / claimTitleOwnership，终态
 *   - "legacy"：旧 catalog 存量条目（0.7.7 缺陷把首句兜底误锁成 titleLocked: true）。行为同
 *     manual（挡自动写入），额外允许一次指纹修复 —— 见文末存量自愈用例。
 */

const nodeRequire = createRequire(import.meta.url);

// 生产同源的身份构造：夹具手写 `pi:native:${path}` 只在 POSIX 下巧合相等。
const { buildSessionOriginKey } = loadTsCommonJs("src/shared/sessionIdentity.ts");

// 存量自愈用例要接真实探测器：SessionScanner 构造期依赖 electron 的 app/shell。
const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts", {
	stubs: {
		electron: {
			app: { getPath: () => tmpdir() },
			shell: {},
		},
	},
});

/** 加载生产 SessionCatalog：相对 import 由 helper 按源文件目录解析。 */
function loadCatalog(fsPromises = nodeRequire("node:fs/promises")) {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"node:fs/promises": fsPromises,
			// 假路径场景恒真：existsSync 只被外部删除清理消费，避免条目被剔（同 sessionCatalogForked）。
			"node:fs": { existsSync: () => true },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

/** 轻量扫描形态的 summary：name 缺失（listPathSummary 只 stat，不读正文）。 */
function lightSummary(overrides = {}) {
	return {
		id: "C:/sessions/2026-08-22T04-22-29-162Z_abc.jsonl",
		filePath: "C:/sessions/2026-08-22T04-22-29-162Z_abc.jsonl",
		name: undefined,
		preview: "",
		messageCount: 0,
		updatedAt: 1000,
		source: "pi",
		environment: "native",
		...overrides,
	};
}

/** 读取磁盘上的 catalog 条目（断言所有权字段真的落盘）。 */
async function readEntry(dir, id) {
	const onDisk = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8"));
	return onDisk.sessions.find((entry) => entry.id === id);
}

// #266 核心：refreshAutoTitle 先写入首条消息兜底名（fallback），扩展随后到达的
// 模型标题（auto）必须还能覆盖它 —— 不能因为「先到先锁」把自动命名拒掉。
test("an extension auto title replaces an earlier first-message fallback title", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-upgrade-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const [draft] = await catalog.mergeScanned("project-1", [lightSummary()]);
		assert.equal(draft.title, "Untitled");

		// AgentManager.refreshAutoTitle：首条用户消息的兜底名。
		const fallback = await catalog.applyAutomaticTitle(draft.id, "帮我看看这个报错", "fallback");
		assert.equal(fallback.title, "帮我看看这个报错");
		const fallbackOnDisk = await readEntry(dir, draft.id);
		assert.equal(fallbackOnDisk.titleOrigin, "fallback");

		// 扩展的模型自动命名：必须覆盖 fallback 并把来源升级为终态 auto。
		const upgraded = await catalog.applyAutomaticTitle(draft.id, "排查报错根因", "auto");
		assert.equal(upgraded.title, "排查报错根因");
		const upgradedOnDisk = await readEntry(dir, draft.id);
		assert.equal(upgradedOnDisk.titleOrigin, "auto");
		assert.equal(upgradedOnDisk.titleLocked, true);

		// 重启（重新 load）后 auto 仍是终态。
		const reloaded = new SessionCatalog(join(dir, "sessions.json"));
		await reloaded.load();
		const late = await reloaded.applyAutomaticTitle(draft.id, "重新加载后的兜底名", "fallback");
		assert.equal(late.title, "排查报错根因");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// fallback 落盘后重启，自动命名仍可覆盖（来源随 catalog 持久化）。
test("a persisted fallback title stays replaceable across reload", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-persist-"));
	try {
		const first = new SessionCatalog(join(dir, "sessions.json"));
		await first.load();
		const [draft] = await first.mergeScanned("project-1", [lightSummary()]);
		await first.applyAutomaticTitle(draft.id, "首条消息兜底", "fallback");

		const second = new SessionCatalog(join(dir, "sessions.json"));
		await second.load();
		const upgraded = await second.applyAutomaticTitle(draft.id, "扩展模型标题", "auto");
		assert.equal(upgraded.title, "扩展模型标题");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// auto 是终态：第二个自动结果与迟到的兜底名都不得再改标题。
test("an auto title is terminal against later automatic writers", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-terminal-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const [draft] = await catalog.mergeScanned("project-1", [lightSummary()]);
		await catalog.applyAutomaticTitle(draft.id, "扩展模型标题", "auto");

		const secondAuto = await catalog.applyAutomaticTitle(draft.id, "第二个自动结果", "auto");
		assert.equal(secondAuto.title, "扩展模型标题");
		const lateFallback = await catalog.applyAutomaticTitle(draft.id, "迟到的首条消息兜底", "fallback");
		assert.equal(lateFallback.title, "扩展模型标题");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 手动所有权（claimTitleOwnership / update）仍是终态，升级为 manual 后自动写入全部拒绝。
test("manual ownership blocks both fallback and auto writers", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-manual-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const [draft] = await catalog.mergeScanned("project-1", [lightSummary()]);

		// sessionIpc 在异步 rename 前先占位。
		await catalog.claimTitleOwnership(draft.id);
		const afterClaim = await readEntry(dir, draft.id);
		assert.equal(afterClaim.titleOrigin, "manual");

		assert.equal((await catalog.applyAutomaticTitle(draft.id, "迟到的兜底名", "fallback")).title, "Untitled");
		assert.equal((await catalog.applyAutomaticTitle(draft.id, "迟到的自动标题", "auto")).title, "Untitled");

		const manual = await catalog.update(draft.id, { title: "A-123" });
		assert.equal(manual.title, "A-123");
		assert.equal((await catalog.applyAutomaticTitle(draft.id, "自动标题再迟到", "auto")).title, "A-123");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 旧 catalog 只有 titleLocked 没有 titleOrigin：锁定条目按终态 manual 迁移（保守方向），
// 未锁定条目保持一次领取机会。
test("legacy titleLocked entries migrate to legacy and stay terminal for automatic writers", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-legacy-"));
	try {
		await writeFile(
			join(dir, "sessions.json"),
			JSON.stringify({
				version: 1,
				sessions: [
					{ id: "legacy-locked", projectId: "project-1", title: "旧标题", titleLocked: true, source: "pi", environment: "native", status: "active", createdAt: 1, updatedAt: 1 },
					{ id: "legacy-open", projectId: "project-1", title: "Untitled", titleLocked: false, source: "pi", environment: "native", status: "active", createdAt: 1, updatedAt: 1 },
				],
			}),
			"utf8",
		);
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();

		const blocked = await catalog.applyAutomaticTitle("legacy-locked", "自动标题", "auto");
		assert.equal(blocked.title, "旧标题", "旧锁定条目不得被自动命名覆盖");
		// 迁移成 legacy（来源未知，行为同 manual，但留一次指纹修复机会）。
		assert.equal((await readEntry(dir, "legacy-locked")).titleOrigin, "legacy");

		const claimed = await catalog.applyAutomaticTitle("legacy-open", "自动标题", "auto");
		assert.equal(claimed.title, "自动标题", "旧未锁定条目仍可被自动命名领取");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 扫描路径：无 session_info 时的首条消息弱回退只算 fallback，可被扩展自动命名替换。
test("a scanned first-message fallback stays replaceable by the extension", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-scan-weak-"));
	try {
		const fetcher = async () => ({ name: "首条消息回退", valid: true, nameFromSessionInfo: false });
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
		await catalog.load();
		const [scanned] = await catalog.mergeScanned("project-1", [lightSummary()]);
		assert.equal(scanned.title, "首条消息回退");
		const scannedOnDisk = await readEntry(dir, scanned.id);
		assert.equal(scannedOnDisk.titleOrigin, "fallback");

		const upgraded = await catalog.applyAutomaticTitle(scanned.id, "扩展模型标题", "auto");
		assert.equal(upgraded.title, "扩展模型标题");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 扫描路径：summary 携带的弱回退名（readSummary 的首条消息降级）同样只算 fallback。
test("a summary-provided weak fallback stays replaceable by the extension", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-summary-weak-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		const [scanned] = await catalog.mergeScanned("project-1", [lightSummary({ name: "首条消息弱回退", nameFromSessionInfo: false })]);
		assert.equal(scanned.title, "首条消息弱回退");
		const scannedOnDisk = await readEntry(dir, scanned.id);
		assert.equal(scannedOnDisk.titleOrigin, "fallback");

		const upgraded = await catalog.applyAutomaticTitle(scanned.id, "扩展模型标题", "auto");
		assert.equal(upgraded.title, "扩展模型标题");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 扫描路径：权威 session_info 名是终态 manual，自动命名不得反向覆盖。
test("an authoritative scanned session_info title blocks the extension", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-scan-strong-"));
	try {
		const fetcher = async () => ({ name: "pi-tui 命名", valid: true, nameFromSessionInfo: true });
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
		await catalog.load();
		const [scanned] = await catalog.mergeScanned("project-1", [lightSummary()]);
		assert.equal(scanned.title, "pi-tui 命名");
		const scannedOnDisk = await readEntry(dir, scanned.id);
		assert.equal(scannedOnDisk.titleOrigin, "manual");

		const blocked = await catalog.applyAutomaticTitle(scanned.id, "扩展模型标题", "auto");
		assert.equal(blocked.title, "pi-tui 命名");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 扫描弱回退名第二次仍不得覆盖已有 fallback（只有扩展 auto 能覆盖它）。
test("scanning cannot replace a fallback title with another weak fallback", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-scan-stable-"));
	try {
		const fetcher = async () => ({ name: "首条消息回退", valid: true, nameFromSessionInfo: false });
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
		await catalog.load();
		const [scanned] = await catalog.mergeScanned("project-1", [lightSummary()]);
		await catalog.applyAutomaticTitle(scanned.id, "首条消息回退", "fallback");

		const upgradedFetcher = async () => ({ name: "pi 侧稍后出现的名称", valid: true, nameFromSessionInfo: true });
		const second = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, upgradedFetcher);
		await second.load();
		const [afterSecondScan] = await second.mergeScanned("project-1", [lightSummary({ updatedAt: 2000 })]);
		assert.equal(afterSecondScan.title, "首条消息回退", "JSONL 名称不得覆盖 fallback（只有扩展 auto 可以）");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ── #266 存量自愈（legacy）：0.7.7 把首句兜底误锁成 titleLocked: true 的条目 ──

/** 旧 catalog 形态的条目（真实盘上就是这些字段）：titleLocked=true 且无 titleOrigin，来源不可区分。 */
function legacyHealEntry(filePath, title, overrides = {}) {
	return {
		id: "legacy-heal",
		projectId: "project-1",
		// originKey 必须由生产构造器给出（buildSummaryOriginKey 的底层）：手写
		// `pi:native:${path}` 只在 POSIX 下巧合相等，Windows 上 canonicalize 把盘符折小写
		// （2026-10-09 全套 Windows 验证：自愈用例因此对不上条目而红）。
		originKey: buildSessionOriginKey({ source: "pi", environment: "native", filePath }),
		title,
		titleLocked: true,
		source: "pi",
		environment: "native",
		filePath,
		status: "active",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

/** 真实 pi JSONL：session 头 + 首条用户消息（弱兜底候选）+ 权威 session_info 名。 */
async function writeHealFixture(filePath, { firstUser, sessionInfoName } = {}) {
	const lines = [{ type: "session", version: 3, id: "heal-fixture", cwd: "C:/project" }];
	if (firstUser) lines.push({ type: "message", message: { role: "user", content: firstUser } });
	if (sessionInfoName) lines.push({ type: "session_info", name: sessionInfoName, cwd: "C:/project" });
	await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

/** 生产同源探测器：main/index.ts 注入的就是 SessionScanner.inferSessionNameAndValidity。 */
function scannerFetcher() {
	return (path, options) => new SessionScanner().inferSessionNameAndValidity(path, options);
}

// 端到端复现 issue #266：旧 catalog 里 titleLocked 的首句兜底，在真实 jsonl 读到
// 权威 session_info 名时必须被改写——这正是当年 applyAutomaticTitle 丢弃的那个名字。
test("a legacy locked first-message fallback is healed from the JSONL session_info name", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-heal-"));
	try {
		const filePath = join(dir, "2026-08-22T04-22-29-162Z_abc.jsonl");
		await writeHealFixture(filePath, { firstUser: "帮我看看这个报错", sessionInfoName: "排查报错根因" });
		await writeFile(join(dir, "sessions.json"), JSON.stringify({ version: 1, sessions: [legacyHealEntry(filePath, "帮我看看这个报错")] }), "utf8");

		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, scannerFetcher());
		await catalog.load();
		const [merged] = await catalog.mergeScanned("project-1", [lightSummary({ id: filePath, filePath })]);
		assert.equal(merged.title, "排查报错根因", "存量误锁必须被 JSONL 权威名修好");
		const onDisk = await readEntry(dir, "legacy-heal");
		assert.equal(onDisk.titleOrigin, "manual", "自愈后转终态 manual");
		assert.equal(onDisk.titleLocked, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 全量扫描已带权威名（summary.name）而探测窗口没读到 session_info 时，同样要自愈。
test("a legacy locked entry is healed when the full scan supplies the authoritative name", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-heal-summary-"));
	try {
		const filePath = join(dir, "2026-08-22T04-22-29-163Z_def.jsonl");
		await writeHealFixture(filePath, { firstUser: "帮我看看这个报错" });
		await writeFile(join(dir, "sessions.json"), JSON.stringify({ version: 1, sessions: [legacyHealEntry(filePath, "帮我看看这个报错")] }), "utf8");

		const probeOnly = async () => ({ name: "帮我看看这个报错", nameFromSessionInfo: false, valid: true, fallbackName: "帮我看看这个报错" });
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, probeOnly);
		await catalog.load();
		const [merged] = await catalog.mergeScanned("project-1", [lightSummary({ id: filePath, filePath, name: "排查报错根因", nameFromSessionInfo: true })]);
		assert.equal(merged.title, "排查报错根因");
		assert.equal((await readEntry(dir, "legacy-heal")).titleOrigin, "manual");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 反例（防误伤）：用户手动改的标题不等于首句兼底，不得被指纹修复改写；探测过一次即转终态。
test("a legacy entry whose title is not the first-message fallback keeps the user title", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-heal-manual-"));
	try {
		const filePath = join(dir, "2026-08-22T04-22-29-164Z_ghi.jsonl");
		await writeHealFixture(filePath, { firstUser: "帮我看看这个报错", sessionInfoName: "排查报错根因" });
		await writeFile(join(dir, "sessions.json"), JSON.stringify({ version: 1, sessions: [legacyHealEntry(filePath, "我自己改的标题")] }), "utf8");

		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, scannerFetcher());
		await catalog.load();
		const [merged] = await catalog.mergeScanned("project-1", [lightSummary({ id: filePath, filePath })]);
		assert.equal(merged.title, "我自己改的标题", "用户改名不得被指纹修复波及");
		assert.equal((await readEntry(dir, "legacy-heal")).titleOrigin, "manual", "探测过即收口，不重复读盘");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 反例：JSONL 里只有首条消息兼底（无 session_info 名）时，不得用另一个弱兜底「修复」弱兜底。
test("a legacy fallback title is not healed by another weak fallback", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-heal-weak-"));
	try {
		const filePath = join(dir, "2026-08-22T04-22-29-165Z_jkl.jsonl");
		await writeHealFixture(filePath, { firstUser: "帮我看看这个报错" });
		await writeFile(join(dir, "sessions.json"), JSON.stringify({ version: 1, sessions: [legacyHealEntry(filePath, "帮我看看这个报错")] }), "utf8");

		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, scannerFetcher());
		await catalog.load();
		const [merged] = await catalog.mergeScanned("project-1", [lightSummary({ id: filePath, filePath })]);
		assert.equal(merged.title, "帮我看看这个报错");
		assert.equal((await readEntry(dir, "legacy-heal")).titleOrigin, "manual");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 读盘失败不得消费掉唯一的一次自愈机会（下次扫描还能修）；修完不再重复读盘。
test("a failed legacy probe keeps the entry retryable and healing is one-shot", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-heal-retry-"));
	try {
		const filePath = join(dir, "2026-08-22T04-22-29-166Z_mno.jsonl");
		await writeHealFixture(filePath, { firstUser: "帮我看看这个报错", sessionInfoName: "排查报错根因" });
		await writeFile(join(dir, "sessions.json"), JSON.stringify({ version: 1, sessions: [legacyHealEntry(filePath, "帮我看看这个报错")] }), "utf8");

		let calls = 0;
		const failingFetcher = async (path, options) => {
			calls += 1;
			if (calls === 1) throw new Error("EBUSY: file locked");
			return new SessionScanner().inferSessionNameAndValidity(path, options);
		};
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, failingFetcher);
		await catalog.load();

		const [afterFailure] = await catalog.mergeScanned("project-1", [lightSummary({ id: filePath, filePath, updatedAt: 2000 })]);
		assert.equal(afterFailure.title, "帮我看看这个报错", "读盘失败必须保持原样");
		assert.equal((await readEntry(dir, "legacy-heal")).titleOrigin, "legacy", "下次扫描再试");

		const [healed] = await catalog.mergeScanned("project-1", [lightSummary({ id: filePath, filePath, updatedAt: 3000 })]);
		assert.equal(healed.title, "排查报错根因", "重试必须能修好");
		const readsAfterHeal = calls;

		await catalog.mergeScanned("project-1", [lightSummary({ id: filePath, filePath, updatedAt: 4000 })]);
		assert.equal(calls, readsAfterHeal, "自愈是 one-shot：后续扫描不再读盘");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// #266 第二指纹基准：系统提示很大时 64KB 头窗口还没进到第一条用户消息，窗口兜底会落到尾部消息上。
// 目录标题存的是**真首句**时，必须用「文件内真首句」再比一次才能自愈（只比窗口兜底会永久漏修）。
test("a legacy first-message title is healed when the name window only sees a later message", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-heal-deep-"));
	try {
		const filePath = join(dir, "2026-08-22T04-22-29-167Z_pqr.jsonl");
		const firstUser = "这个会话的第一条用户消息";
		const lines = [
			{ type: "session", version: 3, id: "deep-fixture", cwd: "C:/project" },
			// 巨型系统提示（中文 3 字节/字）：把第一条用户消息推到 64KB 头窗口之外。
			{ type: "message", message: { role: "system", content: "系统提示 ".repeat(12000) } },
			{ type: "message", message: { role: "user", content: firstUser } },
			// 尾部填充：把真首句挤出 64KB 尾窗口，让窗口兜底只能看到后面的用户消息。
			{ type: "message", message: { role: "assistant", content: "填充 ".repeat(30000) } },
			{ type: "message", message: { role: "user", content: "尾部这条消息才是窗口兜底" } },
			{ type: "session_info", name: "权威名：会话标题", cwd: "C:/project" },
		];
		await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
		await writeFile(join(dir, "sessions.json"), JSON.stringify({ version: 1, sessions: [legacyHealEntry(filePath, firstUser)] }), "utf8");

		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, scannerFetcher());
		await catalog.load();
		const [merged] = await catalog.mergeScanned("project-1", [lightSummary({ id: filePath, filePath })]);
		assert.equal(merged.title, "权威名：会话标题", "真首句标题必须被 JSONL 权威名自愈");
		assert.equal((await readEntry(dir, "legacy-heal")).titleOrigin, "manual", "自愈后转终态 manual");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ── fork/copy 现场（2026-10-08）：权威名必须能升级弱兜底（fallback）标题 ──
//
// 现场：fork 出新文件后，扫描在 pi 写入 (fork) session_info 之前的几百毫秒窗口里
// 先索引了该文件，从尾部窗口兜底猜出一段 assistant thinking 原文当标题并锁定为
// fallback；随后权威 (fork) 名落盘，但 mergeScanned 的 canInitializeTitle =
// !isTitleLocked(entry) 把权威名拒之门外 → 侧栏永久显示那段 thinking 原文。
// 同理 copy：catalog 里坏路径让 rename ENOENT（静默），文件从未获得 session_info
// 名，条目停留在「最后一条输入」弱兜底上。
//
// 契约：所有权语义上 fallback 是「内容派生的猜测」，权威 session_info 名是
// 「pi/用户写下的名字」——后者必须能升级前者（fallback → manual）；
// 但绝不允许反向（权威名落定后再被另一个弱兜底覆盖），auto/manual/legacy 终态不动。
test("an authoritative session_info name upgrades a weak fallback title", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-upgrade-authority-"));
	try {
		const catalog = new SessionCatalog(join(dir, "sessions.json"));
		await catalog.load();
		// 第 0 步：扫描在 session_info 落盘前先索引（现场形态）→ 弱兜底锁成 fallback。
		const [early] = await catalog.mergeScanned("project-1", [lightSummary({ name: "某次回答里的一大段 thinking 原文", nameFromSessionInfo: false })]);
		assert.equal(early.title, "某次回答里的一大段 thinking 原文");
		assert.equal((await readEntry(dir, early.id)).titleOrigin, "fallback");

		// 第 1 步：pi 把 (fork) 名写进 session_info，下一轮扫描读到了权威名。
		const [healed] = await catalog.mergeScanned("project-1", [lightSummary({ name: "pi 1.0.4/1.0.3 更新通俗解读 (fork)", nameFromSessionInfo: true })]);
		assert.equal(healed.id, early.id, "同一文件的扫描必须命中同一 catalog 条目");
		assert.equal(healed.title, "pi 1.0.4/1.0.3 更新通俗解读 (fork)", "权威名必须升级弱兜底标题");
		const healedOnDisk = await readEntry(dir, early.id);
		assert.equal(healedOnDisk.titleOrigin, "manual", "权威名升级后转终态 manual");
		assert.equal(healedOnDisk.titleLocked, true);

		// 第 2 步：升级后的 manual 是终态——迟到的弱兜底不得反向覆盖。
		const [again] = await catalog.mergeScanned("project-1", [lightSummary({ name: "另一段弱兜底", nameFromSessionInfo: false })]);
		assert.equal(again.title, "pi 1.0.4/1.0.3 更新通俗解读 (fork)");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 探测器路径（listPathSummary 轻扫）的 fallback 条目同样能被 summary 携带的权威名升级：
// 生产 fork/copy 现场就是全扫描（readSummary）带着 nameFromSessionInfo: true 回来。
test("a summary-carried authoritative name upgrades a scanned weak fallback title", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-title-origin-upgrade-fetch-"));
	try {
		// 轻扫形态：summary 不带 name，靠探测器回退（锁成 fallback）。
		const fetcher = async () => ({ name: "复制出来的最后一条输入", valid: true, nameFromSessionInfo: false });
		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, fetcher);
		await catalog.load();
		const [early] = await catalog.mergeScanned("project-1", [lightSummary()]);
		assert.equal(early.title, "复制出来的最后一条输入");
		assert.equal((await readEntry(dir, early.id)).titleOrigin, "fallback");

		// 全扫描（readSummary）带着权威 session_info 名回来（rename 已落盘）。
		const [healed] = await catalog.mergeScanned("project-1", [lightSummary({ updatedAt: 2000, name: "原会话名 (copy)", nameFromSessionInfo: true })]);
		assert.equal(healed.id, early.id, "同一文件的扫描必须命中同一 catalog 条目");
		assert.equal(healed.title, "原会话名 (copy)", "权威名必须升级弱兜底标题");
		assert.equal((await readEntry(dir, early.id)).titleOrigin, "manual");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
