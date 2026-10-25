import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const nodeRequire = createRequire(import.meta.url);
const PROJECT_ROOT = join(nodeRequire.resolve("sql.js").split(/[\\/]node_modules[\\/]/)[0], "node_modules", "sql.js", "dist");

/**
 * KimiWorkSessionImporter 单测（探测链 + sqlite 读取 + loop 聚合 + 转换 + 导入原子性）。
 *
 * 与 tests/kimiSessionImporter.test.mjs 同款做法：createTsSandbox 转译生产 TS，
 * mock electron（getPath 按 key 返回不同根：home 放 pi 会话产物，appData 放 kimi-desktop），
 * fs 用真实实现。daimon-share 按真实布局构造：conversations.sqlite 用 sql.js 生成，
 * wire.jsonl 用桌面版事件流 schema（append_message + append_loop_event）。
 */

const PROJECT_PATH = "F:\\PiDeck";
const OTHER_PROJECT_PATH = "F:\\Other";

/** sql.js 的 wasm 定位（生产代码的 locateFile 走打包路径，测试里指回 node_modules）。 */
function locateSqlWasm(file) {
	return join(PROJECT_ROOT, file);
}

function loadImporter(homePath, appDataPath) {
	const load = createTsSandbox({
		stubs: { electron: { app: { getPath: (key) => (key === "appData" ? appDataPath : homePath) } } },
	});
	return {
		source: load("src/main/sessions/kimiWorkSource.ts"),
		convert: load("src/main/sessions/kimiWorkConvert.ts"),
		importerMod: load("src/main/sessions/KimiWorkSessionImporter.ts"),
	};
}

/** 用 sql.js 生成 conversations.sqlite（真实表结构），返回 db 文件绝对路径。 */
async function writeConversationDb(shareRoot, rows) {
	const dbDir = join(shareRoot, "daimon", "agents", "main", "sessions", "hosted-logical");
	mkdirSync(dbDir, { recursive: true });
	const initSqlJs = nodeRequire("sql.js");
	const SQL = await initSqlJs({ locateFile: locateSqlWasm });
	const db = new SQL.Database();
	db.run("CREATE TABLE conversations (conversation_id TEXT, title TEXT, first_user_text TEXT, workspace_path TEXT, kernel_records_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER)");
	for (const row of rows) {
		db.run("INSERT INTO conversations (conversation_id, title, first_user_text, workspace_path, kernel_records_path, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?)", [
			row.conversationId,
			row.title ?? "",
			row.firstUserText ?? "",
			row.workspacePath ?? "",
			row.recordsPath,
			row.createdAtMs ?? 0,
			row.updatedAtMs ?? 0,
		]);
	}
	const bytes = db.export();
	db.close();
	const dbPath = join(dbDir, "conversations.sqlite");
	writeFileSync(dbPath, Buffer.from(bytes));
	return dbPath;
}

function userMessage(text, time = 1_700_000_001_000) {
	return {
		type: "context.append_message",
		agentId: "main",
		time,
		message: { role: "user", id: `msg_u_${time}`, content: [{ type: "text", text }], toolCalls: [] },
	};
}

function loopStep(uuid, parts, time = 1_700_000_002_000, usage = { inputOther: 100, output: 40, inputCacheRead: 10, inputCacheCreation: 0 }, finishReason = "stop") {
	const records = [{ type: "context.append_loop_event", time, event: { type: "step.begin", uuid } }];
	for (const part of parts) {
		records.push({ type: "context.append_loop_event", time: time + 1, event: { type: "content.part", stepUuid: uuid, part } });
	}
	records.push({ type: "context.append_loop_event", time: time + 2, event: { type: "step.end", uuid, messageId: `msg_a_${uuid}`, usage, finishReason } });
	return records;
}

function writeWire(path, entries) {
	mkdirSync(join(path, ".."), { recursive: true });
	const lines = entries.flat().map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function readLines(file) {
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/**
 * 造一个完整 daimon-share（真实布局）：内嵌 runtime 目录放 wire.jsonl，
 * conversations.sqlite 只存元数据行（title/workspace 等）。
 * 返回 { shareRoot, rows, wires }；rows 顺序即 conversations 表插入顺序。
 */
async function writeShare(baseDir, conversations) {
	const shareRoot = join(baseDir, "daimon-share");
	const rows = [];
	const wires = [];
	for (const conversation of conversations) {
		// 真实布局：<share>/daimon/runtime/kimi-code/home/sessions/wd_<目录名>_<hash>/<conv-id>/agents/main/wire.jsonl
		const marker = conversation.marker ?? "wd_pideck_98629d2b9dda";
		const wirePath = join(shareRoot, "daimon", "runtime", "kimi-code", "home", "sessions", marker, conversation.conversationId, "agents", "main", "wire.jsonl");
		writeWire(wirePath, conversation.wire);
		rows.push({
			conversationId: conversation.conversationId,
			title: conversation.title ?? "",
			firstUserText: conversation.firstUserText ?? "",
			workspacePath: conversation.workspacePath ?? "",
			recordsPath: conversation.recordsPath ?? wirePath,
			createdAtMs: conversation.createdAtMs ?? 1_700_000_000_000,
			updatedAtMs: conversation.updatedAtMs ?? 1_700_000_060_000,
		});
		wires.push(wirePath);
	}
	await writeConversationDb(shareRoot, rows);
	return { shareRoot, rows, wires };
}

function standardConversation(overrides = {}) {
	return {
		conversationId: "conv-001",
		title: "迁移计划",
		firstUserText: "帮我评估迁移风险",
		workspacePath: PROJECT_PATH,
		wire: [userMessage("帮我评估迁移风险"), loopStep("step-1", [{ type: "text", text: "风险点有三个。" }])],
		...overrides,
	};
}

test("resolveKimiWorkShareRoot: 全部位置都不存在时返回 undefined", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { source } = loadImporter(home, appData);
	const resolved = await source.resolveKimiWorkShareRoot(appData);
	assert.equal(resolved, undefined);
	const described = await source.describeKimiWorkShareRoot(appData);
	// 跨 vm realm 的对象不能用 deepEqual（原型不同），逐字段断言
	assert.equal(described.root, null);
	assert.equal(described.origin, null);
	assert.equal(described.sessionsFound, false);
});

test("resolveKimiWorkShareRoot: 默认位置存在 → origin default", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { source } = loadImporter(home, appData);
	const defaultRoot = join(appData, "kimi-desktop", "daimon-share");
	mkdirSync(defaultRoot, { recursive: true });
	const resolved = await source.resolveKimiWorkShareRoot(appData);
	assert.equal(resolved.origin, "default");
	assert.equal(resolved.root, defaultRoot);
	// 目录在但 runtime sessions 目录缺失：root 仍命中，sessionsFound=false（装了但还没有会话）
	const described = await source.describeKimiWorkShareRoot(appData);
	assert.equal(described.sessionsFound, false);
});

test("resolveKimiWorkShareRoot: daimon-storage.json 记录自定义位置 → 优先于默认", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { source } = loadImporter(home, appData);
	// 默认位置也存在，验证 storage.json 胜出
	mkdirSync(join(appData, "kimi-desktop", "daimon-share"), { recursive: true });
	const customShare = mkdtempSync(join(tmpdir(), "kw-custom-"));
	mkdirSync(join(appData, "kimi-desktop"), { recursive: true });
	writeFileSync(join(appData, "kimi-desktop", "daimon-storage.json"), JSON.stringify({ shareDir: customShare }), "utf8");
	const resolved = await source.resolveKimiWorkShareRoot(appData);
	assert.equal(resolved.origin, "app-config");
	assert.equal(resolved.root, customShare);
});

test("resolveKimiWorkShareRoot: settings 手动指定优先级最高", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { source } = loadImporter(home, appData);
	mkdirSync(join(appData, "kimi-desktop", "daimon-share"), { recursive: true });
	const settingsShare = mkdtempSync(join(tmpdir(), "kw-settings-"));
	const resolved = await source.resolveKimiWorkShareRoot(appData, settingsShare);
	assert.equal(resolved.origin, "settings");
	assert.equal(resolved.root, settingsShare);
});

test("readKimiWorkStorageShareDir: 损坏 JSON / 非法字段 → 空串（探测链回退默认）", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { source } = loadImporter(home, appData);
	mkdirSync(join(appData, "kimi-desktop"), { recursive: true });
	writeFileSync(join(appData, "kimi-desktop", "daimon-storage.json"), "{ broken", "utf8");
	assert.equal(await source.readKimiWorkStorageShareDir(appData), "");
	writeFileSync(join(appData, "kimi-desktop", "daimon-storage.json"), JSON.stringify({ shareDir: 42 }), "utf8");
	assert.equal(await source.readKimiWorkStorageShareDir(appData), "");
});

test("assertKimiWorkSourcePath: 逃逸出 daimon-share 的路径被拒绝", () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { source } = loadImporter(home, appData);
	assert.doesNotThrow(() => source.assertKimiWorkSourcePath("D:\\KimiData\\daimon-share", "D:\\KimiData\\daimon-share\\daimon\\wire.jsonl"));
	// 大小写与斜杠差异（Windows）不拒
	assert.doesNotThrow(() => source.assertKimiWorkSourcePath("d:/kimidata/daimon-share", "D:/KimiData/daimon-share/wire.jsonl"));
	assert.throws(() => source.assertKimiWorkSourcePath("D:\\KimiData\\daimon-share", "D:\\KimiData\\daimon-share-evil\\wire.jsonl"));
	assert.throws(() => source.assertKimiWorkSourcePath("D:\\KimiData\\daimon-share", "D:\\evil\\wire.jsonl"));
});

test("aggregateKimiWorkLoopEvents: step 流聚合为一条 assistant（分片有序拼接 + usage + finishReason）", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { convert } = loadImporter(home, appData);
	const messages = convert.aggregateKimiWorkLoopEvents(
		loopStep("step-1", [
			{ type: "think", think: "先看目录" },
			{ type: "text", text: "目录里有 3 个文件。" },
		]),
	);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].role, "assistant");
	assert.equal(messages[0].id, "msg_a_step-1");
	assert.equal(messages[0].finishReason, "stop");
	assert.equal(messages[0].usage.output, 40);
	assert.equal(messages[0].content.length, 2);
	assert.equal(messages[0].content[0].type, "think");
	assert.equal(messages[0].content[0].think, "先看目录");
	assert.equal(messages[0].content[1].type, "text");
	assert.equal(messages[0].content[1].text, "目录里有 3 个文件。");
});

test("aggregateKimiWorkLoopEvents: 孤儿 content.part 开隐式步不丢内容；多余 step.end 丢弃", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { convert } = loadImporter(home, appData);
	const records = [
		{ type: "context.append_loop_event", time: 1, event: { type: "content.part", stepUuid: "orphan-1", part: { type: "text", text: "残片" } } },
		{ type: "context.append_loop_event", time: 2, event: { type: "step.end", uuid: "never-began", finishReason: "stop" } },
		{ type: "context.append_loop_event", time: 3, event: { type: "step.end", uuid: "orphan-1", finishReason: "stop" } },
	];
	const messages = convert.aggregateKimiWorkLoopEvents(records);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].content[0].text, "残片");
});

test("aggregateKimiWorkLoopEvents: 截断流 flush 兜底产出未收尾的步", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { convert } = loadImporter(home, appData);
	const messages = convert.aggregateKimiWorkLoopEvents([
		{ type: "context.append_loop_event", time: 1, event: { type: "step.begin", uuid: "s1" } },
		{ type: "context.append_loop_event", time: 2, event: { type: "content.part", stepUuid: "s1", part: { type: "text", text: "写到一半" } } },
	]);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].content[0].text, "写到一半");
	// 非 loop event 记录不产出
	assert.equal(convert.aggregateKimiWorkLoopEvents([userMessage("hi")]).length, 0);
});

test("scan: workspace_path 匹配当前项目的排前，其他项目殿后；状态从导入标记判定", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { importerMod } = loadImporter(home, appData);
	// Kimi Work 装在默认位置：直接在 <appData>/kimi-desktop/daimon-share 构造。
	// （DB 里的 kernel_records_path 是绝对路径，先建后挪会让路径失效——那是在测搬家，不是测探测）
	const defaultShareDir = join(appData, "kimi-desktop");
	const { shareRoot } = await writeShare(defaultShareDir, [standardConversation({ conversationId: "conv-other", title: "别的项目", workspacePath: OTHER_PROJECT_PATH, marker: "wd_otherproj_0011223344aa" }), standardConversation({ conversationId: "conv-mine", title: "本项目会话" })]);
	assert.equal(shareRoot, join(defaultShareDir, "daimon-share"));

	const importer = new importerMod.KimiWorkSessionImporter(undefined, locateSqlWasm);
	const sessions = await importer.scan(PROJECT_PATH);
	assert.equal(sessions.length, 2);
	assert.equal(sessions[0].id, "conv-mine");
	assert.equal(sessions[0].status, "new");
	assert.equal(sessions[1].id, "conv-other");
	assert.ok(sessions[0].messageCount >= 2, "头部粗算：user 1 + loop 步 1");
});

test("import: 转换为 pi JSONL（标题来自 sqlite）；重复导入覆盖且状态转 current/outdated", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { importerMod } = loadImporter(home, appData);
	const { shareRoot, wires } = await writeShare(appData, [standardConversation()]);

	const importer = new importerMod.KimiWorkSessionImporter(undefined, locateSqlWasm);
	const report = await importer.import(PROJECT_PATH, [wires[0]], shareRoot);
	assert.equal(report.imported, 1);
	assert.equal(report.failed, 0);
	const result = report.results[0];
	assert.equal(result.success, true);
	assert.equal(result.overwritten, false);
	assert.equal(result.title, "迁移计划");
	assert.ok(result.messageCount >= 2);

	// 产物结构：session → kimi_work_import → model_change → 消息序列 → session_info 收尾
	const lines = readLines(result.targetPath);
	assert.equal(lines[0].type, "session");
	assert.equal(lines[0].id, "conv-001");
	assert.equal(lines[0].cwd, PROJECT_PATH);
	assert.equal(lines[1].type, "kimi_work_import");
	assert.equal(lines[1].sourcePath, wires[0]);
	assert.equal(lines[2].type, "model_change");
	const sessionInfo = lines[lines.length - 1];
	assert.equal(sessionInfo.type, "session_info");
	assert.equal(sessionInfo.name, "迁移计划");
	const roles = lines.filter((line) => line.type === "message").map((line) => line.message.role);
	assert.deepEqual(roles, ["user", "assistant"]);

	// 侧栏时间取会话真实最后时间（updatedAtMs），不是导入时刻
	const targetStat = await stat(result.targetPath);
	assert.equal(Math.round(targetStat.mtimeMs / 1000), Math.round(1_700_000_060_000 / 1000));

	// 未变更时再扫 → current；重复导入 → overwritten 覆盖
	let sessions = await importer.scan(PROJECT_PATH, shareRoot);
	assert.equal(sessions[0].status, "current");
	const again = await importer.import(PROJECT_PATH, [wires[0]], shareRoot);
	assert.equal(again.results[0].overwritten, true);

	// 源有更新（wire 追加一行）→ outdated
	writeFileSync(wires[0], `${readFileSync(wires[0], "utf8")}${JSON.stringify(userMessage("追加一问", 1_700_000_070_000))}\n`, "utf8");
	sessions = await importer.scan(PROJECT_PATH, shareRoot);
	assert.equal(sessions[0].status, "outdated");
});

test("import: 无标题行回退 first_user_text；标题与首问都空时用首条 user 消息", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { importerMod } = loadImporter(home, appData);
	const conversation = standardConversation({
		conversationId: "conv-notitle",
		title: "",
		firstUserText: "",
		wire: [userMessage("从 user 消息取标题")],
	});
	const { shareRoot, wires } = await writeShare(appData, [conversation]);
	const importer = new importerMod.KimiWorkSessionImporter(undefined, locateSqlWasm);
	const report = await importer.import(PROJECT_PATH, [wires[0]], shareRoot);
	assert.equal(report.results[0].title, "从 user 消息取标题");
});

test("scan: runtime 目录里没有的会话（db 行凭空逃逸）不会出现在列表；db 缺失按空列表兜底", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { importerMod } = loadImporter(home, appData);
	const { shareRoot } = await writeShare(appData, [standardConversation()]);
	// db 里凭空多出一行 recordsPath 指向 share 外的文件——v2 主索引是 runtime 目录扫描，
	// 这行没有对应 runtime 会话，不能凭空把外部文件引进列表
	const dbPath = join(shareRoot, "daimon", "agents", "main", "sessions", "hosted-logical", "conversations.sqlite");
	const initSqlJs = nodeRequire("sql.js");
	const SQL = await initSqlJs({ locateFile: locateSqlWasm });
	const db = new SQL.Database(readFileSync(dbPath));
	db.run("INSERT INTO conversations (conversation_id, title, first_user_text, workspace_path, kernel_records_path, created_at_ms, updated_at_ms) VALUES (?,?,?,?,?,?,?)", ["conv-evil", "evil", "", "", join(appData, "evil-wire.jsonl"), 0, 0]);
	writeFileSync(dbPath, Buffer.from(db.export()));
	db.close();

	const importer = new importerMod.KimiWorkSessionImporter(undefined, locateSqlWasm);
	const sessions = await importer.scan(PROJECT_PATH, shareRoot);
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].id, "conv-001");

	// runtime sessions 目录不存在（还没产生过会话）→ 空列表，不抛错（跨 realm 数组不能用 deepEqual）
	const sessionsNoRuntime = await importer.scan(PROJECT_PATH, join(appData, "no-share"));
	assert.ok(Array.isArray(sessionsNoRuntime));
	assert.equal(sessionsNoRuntime.length, 0);
});

test("scan: WAL 场景免疫——runtime 会话在但 conversations.sqlite 不存在，仍能列出并导入（标题回退 wire 首条 user）", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { importerMod } = loadImporter(home, appData);
	// 只造 runtime 目录 + wire，不造 db（Kimi Work 运行中 WAL 未 checkpoint 时主 db 就是空的）
	const shareRoot = join(appData, "daimon-share");
	const wirePath = join(shareRoot, "daimon", "runtime", "kimi-code", "home", "sessions", "wd_pideck_98629d2b9dda", "conv-wal", "agents", "main", "wire.jsonl");
	writeWire(wirePath, [{ type: "metadata", created_at: 1_700_000_000_000, cwd: PROJECT_PATH }, userMessage("WAL 里还没 checkpoint 的会话"), loopStep("step-1", [{ type: "text", text: "回答" }])]);
	const importer = new importerMod.KimiWorkSessionImporter(undefined, locateSqlWasm);
	const sessions = await importer.scan(PROJECT_PATH, shareRoot);
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].id, "conv-wal");
	// 标题回退链：sqlite 无行 → 首条 user 文本；创建时间回退 wire metadata.created_at
	assert.equal(sessions[0].title, "WAL 里还没 checkpoint 的会话");
	assert.equal(sessions[0].createdAt, 1_700_000_000_000);
	// wd 标记匹配当前项目 → cwd 用 projectPath（sqlite workspace_path 缺失时的回退）
	assert.equal(sessions[0].cwd, PROJECT_PATH);

	const report = await importer.import(PROJECT_PATH, [wirePath], shareRoot);
	assert.equal(report.results[0].success, true);
	assert.equal(report.results[0].title, "WAL 里还没 checkpoint 的会话");
});

test("scan: wd 标记目录名与项目匹配的会话排前（sqlite workspace_path 缺失时）", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { importerMod } = loadImporter(home, appData);
	// db 行 workspacePath 不匹配 + wd 标记也不匹配 vs wd 标记匹配项目目录名
	const { shareRoot } = await writeShare(appData, [
		standardConversation({ conversationId: "conv-marker-hit", title: "标记匹配", workspacePath: "", marker: `wd_${"PiDeck".toLowerCase()}_deadbeef89ab` }),
		standardConversation({ conversationId: "conv-marker-miss", title: "标记不匹配", workspacePath: "", marker: "wd_otherproj_0011223344aa" }),
	]);
	const importer = new importerMod.KimiWorkSessionImporter(undefined, locateSqlWasm);
	const sessions = await importer.scan(PROJECT_PATH, shareRoot);
	assert.equal(sessions.length, 2);
	assert.equal(sessions[0].id, "conv-marker-hit");
	assert.equal(sessions[1].id, "conv-marker-miss");
});

test("parseKimiWorkRuntimeWirePath / parseWorkdirMarker: 布局校验与标记解析", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { source } = loadImporter(home, appData);
	const root = "D:\\KimiData\\daimon-share";
	const valid = "d:/kimidata/daimon-share/daimon/runtime/kimi-code/home/sessions/wd_pideck_98629d2b9dda/conv-001/agents/main/wire.jsonl";
	const parsed = source.parseKimiWorkRuntimeWirePath(root, valid);
	assert.equal(parsed.marker, "wd_pideck_98629d2b9dda");
	assert.equal(parsed.conversationId, "conv-001");
	// 逃逸 / 布局不完整 / 多余层级 → 拒绝
	assert.equal(source.parseKimiWorkRuntimeWirePath(root, "d:/evil/wire.jsonl"), null);
	assert.equal(source.parseKimiWorkRuntimeWirePath(root, `${root}/daimon/runtime/kimi-code/home/sessions/wd_x_h/conv-001/wire.jsonl`), null);
	// 标记解析：目录名可含 -/_；末段恰似 hex 时可能错切（降级为不匹配，可接受）
	assert.equal(source.parseWorkdirMarker("wd_pi-desktop-dev_98629d2b9dda"), "pi-desktop-dev");
	assert.equal(source.parseWorkdirMarker("wd_PiDeck_98629d2b9dda"), "PiDeck");
	assert.equal(source.parseWorkdirMarker("wd_bad"), "");
	assert.equal(source.parseWorkdirMarker("random-dir"), "");
});

test("import: 不存在的数据目录/文件 → 失败结果带错误原因，不抛异常", async () => {
	const home = mkdtempSync(join(tmpdir(), "kw-home-"));
	const appData = mkdtempSync(join(tmpdir(), "kw-app-"));
	const { importerMod } = loadImporter(home, appData);
	const importer = new importerMod.KimiWorkSessionImporter(undefined, locateSqlWasm);
	const report = await importer.import(PROJECT_PATH, [join(appData, "missing.jsonl")], join(appData, "no-share"));
	assert.equal(report.imported, 0);
	assert.equal(report.failed, 1);
	assert.equal(report.results[0].success, false);
	assert.ok(report.results[0].error.length > 0);
});
