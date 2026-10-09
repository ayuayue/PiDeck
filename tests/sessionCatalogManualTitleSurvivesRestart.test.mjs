import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * issue #325 回归：手动命名过的会话，重启 agent 后继续执行任务，不得再被自动命名改名。
 *
 * 报告现场：手动命名一个会话 → 在该会话继续执行任务 → 结束任务后重启 agent → 再次在该
 * 会话继续执行任务，就可能又触发自动命名。
 *
 * 所有权链条上必须同时挡住两条写入路径：
 *   1. mergeScanned（重启/扫描路径）：条目已 manual 时 canInitializeTitle=false，
 *      authoritativeUpgrade 只对 fallback 生效 → 扫到 JSONL 里的名字也不能覆盖 manual；
 *   2. applyAutomaticTitle（扩展模型标题写回路径）：claimAutomaticTitle 只接受
 *      undefined / fallback，manual 是终态，迟到的 auto 一律丢弃。
 * 两条闸门任一失效，用户写下的标题就会在「重启 + 继续」这一轮里被自动命名冲掉。
 */

const nodeRequire = createRequire(import.meta.url);

// 生产同源探测器：main/index.ts 注入的就是 SessionScanner.inferSessionNameAndValidity。
const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts", {
	stubs: {
		electron: { app: { getPath: () => tmpdir() }, shell: {} },
	},
});

function loadCatalog() {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"node:fs/promises": nodeRequire("node:fs/promises"),
			// 假路径场景恒真：existsSync 只被外部删除清理消费，避免条目被剔。
			"node:fs": { existsSync: () => true },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

/** 轻量扫描形态（listPathSummary 只 stat 不读正文）：name 缺省即非权威。 */
function lightSummary(filePath, overrides = {}) {
	return {
		id: filePath,
		filePath,
		name: undefined,
		preview: "",
		messageCount: 1,
		updatedAt: 1000,
		source: "pi",
		environment: "native",
		...overrides,
	};
}

function scannerFetcher() {
	return (path, options) => new SessionScanner().inferSessionNameAndValidity(path, options);
}

/** 真实 pi JSONL：会话头 + 首条用户消息（弱兜底候选）+ 可选 session_info 权威名。 */
async function writeSessionFile(filePath, { firstUser, sessionInfoName } = {}) {
	const lines = [{ type: "session", version: 3, id: "manual-title-regression", cwd: "C:/project" }];
	if (firstUser) lines.push({ type: "message", message: { role: "user", content: firstUser } });
	if (sessionInfoName) lines.push({ type: "session_info", name: sessionInfoName, cwd: "C:/project" });
	await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

async function readEntry(dir, id) {
	const onDisk = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8"));
	return onDisk.sessions.find((entry) => entry.id === id);
}

// 主用例：发现 → 手动命名 → 重启（新实例 load）→ 重新扫描 → 扩展迟到 auto，标题全程不变。
test("a manual rename survives agent restart, rescan and a late extension auto title", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-manual-title-restart-"));
	try {
		const filePath = join(dir, "2026-10-09T08-04-57-000Z_abc.jsonl");
		await writeSessionFile(filePath, { firstUser: "帮我把这个会话重命名一下" });
		const catalogPath = join(dir, "sessions.json");

		// 1) 首次发现：只吸到首条消息弱兜底（fallback），还没人手动命名。
		const first = new SessionCatalog(catalogPath, {}, undefined, scannerFetcher());
		await first.load();
		const [discovered] = await first.mergeScanned("project-1", [lightSummary(filePath)]);
		assert.equal(discovered.title, "帮我把这个会话重命名一下");

		// 2) 用户手动命名（sessionIpc：先 claimTitleOwnership 占位，再写标题）。
		await first.claimTitleOwnership(discovered.id);
		await first.update(discovered.id, { title: "手动命名后的标题" });
		const renamed = await readEntry(dir, discovered.id);
		assert.equal(renamed.title, "手动命名后的标题");
		assert.equal(renamed.titleOrigin, "manual");

		// 3) 重启 agent：新实例从盘上加载，标题与所有权原样恢复。
		const second = new SessionCatalog(catalogPath, {}, undefined, scannerFetcher());
		await second.load();
		assert.equal((await readEntry(dir, discovered.id)).title, "手动命名后的标题", "重启后标题不得变化");
		assert.equal((await readEntry(dir, discovered.id)).titleOrigin, "manual", "重启后所有权必须仍是 manual");

		// 4) 重启后的重新扫描（继续执行任务会触发）：弱兜底不得把手动标题降级。
		const [rescanned] = await second.mergeScanned("project-1", [lightSummary(filePath, { updatedAt: 5000 })]);
		assert.equal(rescanned.title, "手动命名后的标题");

		// 5) 扩展迟到的模型自动标题（继续执行任务后的第一轮响应）必须被拒。
		const late = await second.applyAutomaticTitle(discovered.id, "自动命名：会话重命名", "auto");
		assert.equal(late.title, "手动命名后的标题");
		const afterLate = await readEntry(dir, discovered.id);
		assert.equal(afterLate.title, "手动命名后的标题");
		assert.equal(afterLate.titleOrigin, "manual");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// 存量形态：PiDeck 侧已是 manual，但 pi 文件里另有扩展写入的 session_info 名
// （catalog 手动名与 pi 文件名不一致的真实成对现场）。全量扫描带回权威名也不得顶掉 manual。
test("a scanned JSONL name cannot take over a manual catalog title", async () => {
	const { SessionCatalog } = loadCatalog();
	const dir = await mkdtemp(join(tmpdir(), "pideck-manual-title-scan-"));
	try {
		const filePath = join(dir, "2026-10-09T08-04-58-000Z_abc.jsonl");
		await writeSessionFile(filePath, { firstUser: "帮我把这个会话重命名一下", sessionInfoName: "扩展自动名" });

		const catalog = new SessionCatalog(join(dir, "sessions.json"), {}, undefined, scannerFetcher());
		await catalog.load();
		const [discovered] = await catalog.mergeScanned("project-1", [lightSummary(filePath)]);
		await catalog.claimTitleOwnership(discovered.id);
		await catalog.update(discovered.id, { title: "手动命名后的标题" });

		const [rescanned] = await catalog.mergeScanned("project-1", [lightSummary(filePath, { name: "扩展自动名", nameFromSessionInfo: true, updatedAt: 5000 })]);
		assert.equal(rescanned.title, "手动命名后的标题", "manual 条目不得被扫描到的 JSONL 名覆盖");
		assert.equal((await readEntry(dir, discovered.id)).titleOrigin, "manual");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
