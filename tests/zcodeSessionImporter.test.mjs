import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);

/**
 * ZCodeSessionImporter 单测。
 *
 * 与 codex/claude importer 测试同款做法：把 TS 源转译成 CJS 后在 vm 沙箱运行，
 * mock electron（app.getPath("home") 指向临时目录），node:sqlite / fs 用真实实现。
 * 数据库按 zcode 真实 schema 的字段子集构造（importer 只查询这些列），
 * 不依赖真实 zcode 安装，也不触碰用户 ~/.zcode 数据。
 */

function loadTranspiled(sourcePath, sandbox) {
	const source = readFileSync(sourcePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	vm.runInNewContext(outputText, sandbox, { filename: sourcePath });
	return sandbox.exports;
}

function loadImporter(homePath) {
	const importCopy = loadTranspiled("src/main/sessions/SessionImportCopy.ts", { exports: {} });
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "electron") return { app: { getPath: () => homePath } };
			if (id === "./SessionImportCopy") return importCopy;
			return require(id);
		},
		process,
		Buffer,
		console,
		setTimeout,
		clearTimeout,
		URL,
		TextEncoder,
		TextDecoder,
	};
	return loadTranspiled("src/main/sessions/ZCodeSessionImporter.ts", sandbox);
}

function createZcodeDb(dbPath, { projectPath }) {
	const db = new DatabaseSync(dbPath);
	db.exec(`
		CREATE TABLE session (id text primary key, project_id text, directory text, title text, time_created integer, time_updated integer);
		CREATE TABLE message (id text primary key, session_id text, sequence integer, time_created integer, time_updated integer, data text);
		CREATE TABLE part (id text primary key, message_id text, session_id text, sequence integer, time_created integer, time_updated integer, data text);
	`);
	return db;
}

const T0 = 1787928060000; // 固定起始时间戳（ms），保证时间断言可复现

function insertSession(db, { id, directory, title, createdAt = T0, updatedAt = T0 + 1000 }) {
	db.prepare(
		"insert into session (id, project_id, directory, title, time_created, time_updated) values (?, ?, ?, ?, ?, ?)",
	).run(id, "proj", directory, title, createdAt, updatedAt);
}

function insertMessage(db, { id, sessionId, sequence, created = T0, data }) {
	db.prepare(
		"insert into message (id, session_id, sequence, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
	).run(id, sessionId, sequence, created, created, JSON.stringify(data));
}

function insertPart(db, { id, messageId, sessionId, sequence, created = T0, data }) {
	db.prepare(
		"insert into part (id, message_id, session_id, sequence, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)",
	).run(id, messageId, sessionId, sequence, created, created, JSON.stringify(data));
}

/** 构造一个含 user/assistant/工具/步骤噪声/系统事件的典型会话。 */
function seedTypicalSession(db, sessionId, projectPath) {
	insertSession(db, {
		id: sessionId,
		directory: projectPath,
		title: "优化工具栏展示",
	});

	// user：文本 + 一条系统事件（timeline，应被跳过）
	insertMessage(db, {
		id: "m_user",
		sessionId,
		sequence: 0,
		data: { role: "user", time: { created: T0 } },
	});
	insertPart(db, {
		id: "p_user_text", messageId: "m_user", sessionId, sequence: 0,
		data: { type: "text", text: "帮我优化工具栏按钮", time: { start: T0, end: T0 } },
	});

	// assistant：reasoning + text + tool 调用（Bash）+ step 噪声
	insertMessage(db, {
		id: "m_asst",
		sessionId,
		sequence: 1,
		created: T0 + 100,
		data: {
			role: "assistant",
			time: { created: T0 + 100, completed: T0 + 200 },
			providerID: "builtin:bigmodel-start-plan",
			modelID: "GLM-5.3-Flash",
			finish: "tool-calls",
			tokens: { total: 100, input: 80, output: 20, cache: { read: 10, write: 0 } },
		},
	});
	insertPart(db, {
		id: "p_asst_think", messageId: "m_asst", sessionId, sequence: 0,
		data: { type: "reasoning", text: "先看工具栏代码", metadata: { anthropic: { signature: "sig1" } }, time: { start: T0 + 100, end: T0 + 150 } },
	});
	insertPart(db, {
		id: "p_asst_text", messageId: "m_asst", sessionId, sequence: 1,
		data: { type: "text", text: "我来看看", time: { start: T0 + 150, end: T0 + 160 } },
	});
	insertPart(db, {
		id: "p_asst_tool", messageId: "m_asst", sessionId, sequence: 2,
		data: {
			type: "tool",
			callID: "call_abc123",
			tool: "Bash",
			state: { status: "completed", input: { command: "ls", description: "列目录" }, output: "file1\nfile2", time: { start: T0 + 160, end: T0 + 180 } },
		},
	});
	insertPart(db, {
		id: "p_asst_step1", messageId: "m_asst", sessionId, sequence: 3,
		data: { type: "step-start" },
	});
	insertPart(db, {
		id: "p_asst_step2", messageId: "m_asst", sessionId, sequence: 4,
		data: { type: "step-finish" },
	});

	// 系统 timeline 事件（semantics.origin = system）：应被整体跳过
	insertMessage(db, {
		id: "m_system",
		sessionId,
		sequence: 2,
		created: T0 + 300,
		data: { role: "assistant", semantics: { origin: "system", kind: "timeline_event" } },
	});
	insertPart(db, {
		id: "p_system_tl", messageId: "m_system", sessionId, sequence: 0,
		data: { type: "timeline", timelineType: "model_change" },
	});

	// 失败工具：输出应为 error 内容且 isError=true
	insertMessage(db, {
		id: "m_asst2",
		sessionId,
		sequence: 3,
		created: T0 + 400,
		data: { role: "assistant", time: { created: T0 + 400, completed: T0 + 500 }, finish: "stop", tokens: { total: 5, input: 5, output: 0, cache: { read: 0, write: 0 } } },
	});
	insertPart(db, {
		id: "p_asst2_tool", messageId: "m_asst2", sessionId, sequence: 0,
		data: { type: "tool", callID: "call_err", tool: "Read", state: { status: "error", input: { path: "nope.txt" }, output: "file not found" } },
	});
}

test("zcode scan: 目录匹配项目路径并返回摘要（new 状态）", async () => {
	const home = mkdtempSync(join(tmpdir(), "zcode-scan-"));
	try {
		const projectPath = join(home, "proj");
		const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
		mkdirSync(join(home, ".zcode", "cli", "db"), { recursive: true });
		const db = createZcodeDb(dbPath, { projectPath });
		seedTypicalSession(db, "sess_1", projectPath);
		db.close();

		const { ZCodeSessionImporter } = loadImporter(home);
		const summaries = await new ZCodeSessionImporter().scan(projectPath);
		assert.equal(summaries.length, 1);
		const s = summaries[0];
		assert.equal(s.id, "sess_1");
		assert.equal(s.title, "优化工具栏展示", "标题优先取 zcode session.title");
		assert.equal(s.status, "new");
		assert.equal(s.messageCount, 5, "user + assistant + toolResult + assistant + toolResult（系统事件不计）");
		assert.ok(s.preview.length > 0);
		assert.ok(s.sourcePath.startsWith(dbPath + "#"), "sourcePath 携带 db 路径与会话 id");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("zcode scan: 子目录会话也被匹配", async () => {
	const home = mkdtempSync(join(tmpdir(), "zcode-sub-"));
	try {
		const projectPath = join(home, "proj");
		const subDir = join(projectPath, "packages", "app");
		const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
		mkdirSync(join(home, ".zcode", "cli", "db"), { recursive: true });
		const db = createZcodeDb(dbPath, { projectPath });
		insertSession(db, { id: "sess_sub", directory: subDir, title: "子目录会话" });
		insertMessage(db, { id: "m1", sessionId: "sess_sub", sequence: 0, data: { role: "user" } });
		insertPart(db, { id: "p1", messageId: "m1", sessionId: "sess_sub", sequence: 0, data: { type: "text", text: "子项目问题" } });
		db.close();

		const { ZCodeSessionImporter } = loadImporter(home);
		const summaries = await new ZCodeSessionImporter().scan(projectPath);
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].id, "sess_sub");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("zcode scan: 子代理会话（sess_subagent_ 前缀）不导入", async () => {
	const home = mkdtempSync(join(tmpdir(), "zcode-subagent-"));
	try {
		const projectPath = join(home, "proj");
		const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
		mkdirSync(join(home, ".zcode", "cli", "db"), { recursive: true });
		const db = createZcodeDb(dbPath, { projectPath });
		insertSession(db, { id: "sess_1", directory: projectPath, title: "主会话" });
		insertSession(db, { id: "sess_subagent_agent_xxx", directory: projectPath, title: "子代理" });
		insertMessage(db, { id: "m1", sessionId: "sess_1", sequence: 0, data: { role: "user" } });
		insertPart(db, { id: "p1", messageId: "m1", sessionId: "sess_1", sequence: 0, data: { type: "text", text: "主会话问题" } });
		db.close();

		const { ZCodeSessionImporter } = loadImporter(home);
		const summaries = await new ZCodeSessionImporter().scan(projectPath);
		assert.equal(summaries.length, 1, "子代理会话不应出现在导入列表");
		assert.equal(summaries[0].id, "sess_1");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("zcode scan: 数据库不存在时返回空数组", async () => {
	const home = mkdtempSync(join(tmpdir(), "zcode-nodb-"));
	try {
		const { ZCodeSessionImporter } = loadImporter(home);
		const summaries = await new ZCodeSessionImporter().scan(join(home, "proj"));
		assert.equal(summaries.length, 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("zcode import: 生成可被 pi 读取的 JSONL（消息/工具/图片/标题）", async () => {
	const home = mkdtempSync(join(tmpdir(), "zcode-import-"));
	try {
		const projectPath = join(home, "proj");
		const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
		const artifactsDir = join(home, ".zcode", "cli", "artifacts", "sess_1");
		mkdirSync(join(home, ".zcode", "cli", "db"), { recursive: true });
		mkdirSync(artifactsDir, { recursive: true });
		const db = createZcodeDb(dbPath, { projectPath });
		seedTypicalSession(db, "sess_1", projectPath);
		// 图片附件：user 消息补一个 file part + artifact 文件（data URL）
		insertPart(db, {
			id: "p_user_img", messageId: "m_user", sessionId: "sess_1", sequence: 1, created: T0 + 1,
			data: { type: "file", mime: "image/png", url: "zcode-artifact://sess_1/tool-result-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
		});
		db.close();
		writeFileSync(
			join(artifactsDir, "prompt-attachment-upload-xxx-tool-result-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.txt"),
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
		);

		const { ZCodeSessionImporter } = loadImporter(home);
		const importer = new ZCodeSessionImporter();
		const summaries = await importer.scan(projectPath);
		const report = await importer.import(projectPath, [summaries[0].sourcePath]);
		assert.equal(report.imported, 1);
		assert.equal(report.failed, 0);
		assert.equal(report.results[0].success, true);

		const targetPath = report.results[0].targetPath;
		assert.ok(existsSync(targetPath), "导入产物应写入 pi 会话目录");
		const lines = readFileSync(targetPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

		// 头部契约：session 头 + zcode_import 标记 + model_change + session_info 尾行
		assert.equal(lines[0].type, "session");
		assert.equal(lines[0].version, 3);
		assert.equal(lines[0].cwd, projectPath);
		assert.equal(lines[1].type, "zcode_import");
		assert.equal(lines[1].zcodeSessionId, "sess_1");
		assert.equal(lines.at(-1).type, "session_info");
		assert.equal(lines.at(-1).name, "优化工具栏展示", "标题写入 session_info");

		// user 消息：文本 + 图片还原为 image content
		const userMsg = lines.find((l) => l.type === "message" && l.message.role === "user");
		const userTypes = userMsg.message.content.map((c) => c.type);
		assert.deepEqual(userTypes, ["text", "image"], "图片附件应还原为 image content");
		const imagePart = userMsg.message.content.find((c) => c.type === "image");
		assert.equal(imagePart.mimeType, "image/png");
		assert.ok(imagePart.data.startsWith("iVBOR"), "image data 应为基础载荷（不含 data: 前缀）");

		// assistant 消息：thinking + text + toolCall；step 噪声被跳过
		const asstMsg = lines.find((l) => l.type === "message" && l.message.role === "assistant" && l.message.content.some((c) => c.type === "toolCall"));
		const asstTypes = asstMsg.message.content.map((c) => c.type);
		assert.deepEqual(asstTypes, ["thinking", "text", "toolCall"]);
		assert.equal(asstMsg.message.model, "GLM-5.3-Flash");
		assert.equal(asstMsg.message.provider, "builtin:bigmodel-start-plan");
		assert.equal(asstMsg.message.usage.input, 80);
		const toolCall = asstMsg.message.content.find((c) => c.type === "toolCall");
		assert.equal(toolCall.id, "call_abc123");
		assert.equal(toolCall.name, "Bash");
		assert.deepEqual(toolCall.arguments, { command: "ls", description: "列目录" });

		// toolResult：紧跟 assistant 之后，输出与 isError 正确
		const resultMsgs = lines.filter((l) => l.type === "message" && l.message.role === "toolResult");
		assert.equal(resultMsgs.length, 2, "两个工具调用各生成一条 toolResult");
		assert.equal(resultMsgs[0].message.toolCallId, "call_abc123");
		assert.equal(resultMsgs[0].message.isError, false);
		assert.equal(resultMsgs[0].message.content[0].text, "file1\nfile2");
		assert.equal(resultMsgs[1].message.toolCallId, "call_err");
		assert.equal(resultMsgs[1].message.isError, true);

		// 系统 timeline 消息不导入
		const systemLike = lines.filter((l) => l.type === "message" && l.message.role === "assistant" && l.message.api === "zcode-import" && !l.message.content?.length);
		assert.equal(systemLike.length, 0, "system 事件消息应被跳过");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("zcode import: 状态流转 new -> current -> outdated", async () => {
	const home = mkdtempSync(join(tmpdir(), "zcode-status-"));
	try {
		const projectPath = join(home, "proj");
		const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
		mkdirSync(join(home, ".zcode", "cli", "db"), { recursive: true });
		const db = createZcodeDb(dbPath, { projectPath });
		insertSession(db, { id: "sess_1", directory: projectPath, title: "状态测试" });
		insertMessage(db, { id: "m1", sessionId: "sess_1", sequence: 0, data: { role: "user" } });
		insertPart(db, { id: "p1", messageId: "m1", sessionId: "sess_1", sequence: 0, data: { type: "text", text: "第一版" } });
		db.close();

		const { ZCodeSessionImporter } = loadImporter(home);
		const importer = new ZCodeSessionImporter();
		const before = await importer.scan(projectPath);
		assert.equal(before[0].status, "new");
		await importer.import(projectPath, [before[0].sourcePath]);

		const after = await importer.scan(projectPath);
		assert.equal(after[0].status, "current", "导入后源未变应为 current");

		// 改变源内容（新增一条消息 → sourceSize 变化）→ outdated
		const db2 = new DatabaseSync(dbPath);
		insertMessage(db2, { id: "m2", sessionId: "sess_1", sequence: 1, created: T0 + 999, data: { role: "user" } });
		insertPart(db2, { id: "p2", messageId: "m2", sessionId: "sess_1", sequence: 0, data: { type: "text", text: "第二版更新" } });
		db2.close();

		const updated = await importer.scan(projectPath);
		assert.equal(updated[0].status, "outdated", "源更新后应提示可覆盖");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// ── SessionScanner 来源标签识别（zcode_import → source=zcode） ──

function loadScannedModule(filePath, overrides = new Map()) {
	const source = readFileSync(filePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = {
		clearTimeout,
		exports: {},
		process,
		require: (id) => (overrides.has(id) ? overrides.get(id) : require(id)),
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

function loadZCodeMetaModule() {
	return loadScannedModule("src/shared/codexSessionMeta.ts", new Map());
}

function loadZCodeMessageContentModule() {
	const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };
	const docActions = { exports: {} };
	vm.runInNewContext(
		ts.transpileModule(readFileSync("src/main/feishu/docActions.ts", "utf8"), { compilerOptions }).outputText,
		docActions,
		{ filename: "docActions.ts" },
	);
	const messageContent = {
		exports: {},
		require: (id) => {
			if (id === "../feishu/docActions") return docActions.exports;
			throw new Error(`Unexpected messageContent import: ${id}`);
		},
	};
	vm.runInNewContext(
		ts.transpileModule(readFileSync("src/main/pi/messageContent.ts", "utf8"), { compilerOptions }).outputText,
		messageContent,
		{ filename: "messageContent.ts" },
	);
	return messageContent.exports;
}

function loadZCodeWslPathsModule() {
	const source = readFileSync("src/main/wsl/WslPaths.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {}, require };
	vm.runInNewContext(outputText, sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

function loadZCodeFsRetryModule() {
	const source = readFileSync("src/main/utils/fsRetry.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { clearTimeout, exports: {}, process, require, setTimeout };
	vm.runInNewContext(outputText, sandbox, { filename: "fsRetry.ts" });
	return sandbox.exports;
}

function loadZCodeSummaryCacheModule(homePath) {
	const source = readFileSync("src/main/sessions/sessionSummaryCache.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const fsRetry = loadZCodeFsRetryModule();
	const sandbox = {
		clearTimeout: () => undefined,
		exports: {},
		process,
		require: (id) => {
			if (id === "electron") {
				return { app: { getPath: (name) => (name === "userData" ? join(homePath, "user-data") : homePath) } };
			}
			if (id === "../utils/fsRetry") return fsRetry;
			return require(id);
		},
		setTimeout: () => ({ unref: () => undefined }),
	};
	vm.runInNewContext(outputText, sandbox, { filename: "sessionSummaryCache.ts" });
	return sandbox.exports;
}

function loadZCodeSessionNameLineModule() {
	const source = readFileSync("src/main/sessions/sessionNameLine.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {}, process, require, setTimeout };
	vm.runInNewContext(outputText, sandbox, { filename: "sessionNameLine.ts" });
	return sandbox.exports;
}

function loadZCodeScanner(homePath) {
	const source = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const codexMeta = loadZCodeMetaModule();
	const messageContent = loadZCodeMessageContentModule();
	const sessionSummaryCache = loadZCodeSummaryCacheModule(homePath);
	const wslPaths = loadZCodeWslPathsModule();
	const sessionIdentity = loadScannedModule("src/shared/sessionIdentity.ts", new Map());
	const sandbox = {
		AbortController,
		AbortSignal,
		Buffer,
		clearTimeout,
		exports: {},
		process,
		require: (id) => {
			if (id === "electron") return { app: { getPath: () => homePath }, shell: {} };
			if (id === "../../shared/codexSessionMeta") return codexMeta;
			if (id === "../pi/messageContent") return messageContent;
			if (id === "../wsl/WslPaths") return wslPaths;
			if (id === "./sessionSummaryCache") return sessionSummaryCache;
			if (id === "./sessionNameLine") return loadZCodeSessionNameLineModule();
			if (id === "../../shared/sessionIdentity") return sessionIdentity;
			if (id === "../logging/sharedLogger") return { getAppLogger: () => null };
			return require(id);
		},
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "SessionScanner.ts" });
	return sandbox.exports;
}

test("zcode import: 导入产物被 SessionScanner 识别为 zcode 来源（标签链路）", async () => {
	const home = mkdtempSync(join(tmpdir(), "zcode-scanner-"));
	try {
		const projectPath = join(home, "proj");
		const dbPath = join(home, ".zcode", "cli", "db", "db.sqlite");
		mkdirSync(join(home, ".zcode", "cli", "db"), { recursive: true });
		const db = createZcodeDb(dbPath, { projectPath });
		insertSession(db, { id: "sess_1", directory: projectPath, title: "标签链路" });
		insertMessage(db, { id: "m1", sessionId: "sess_1", sequence: 0, data: { role: "user" } });
		insertPart(db, { id: "p1", messageId: "m1", sessionId: "sess_1", sequence: 0, data: { type: "text", text: "导入后应有 zcode 标签" } });
		db.close();

		// 用 importer 导入（piRoot 覆盖为临时目录），产物落在 home 的 pi sessions 下
		const { ZCodeSessionImporter } = loadImporter(home);
		const importer = new ZCodeSessionImporter();
		const summaries = await importer.scan(projectPath);
		await importer.import(projectPath, [summaries[0].sourcePath]);

		// SessionScanner 扫描同一目录，来源应识别为 zcode
		const { SessionScanner } = loadZCodeScanner(home);
		const listed = await new SessionScanner().list(projectPath);
		assert.equal(listed.length, 1, "导入产物应出现在会话列表");
		assert.equal(listed[0].source, "zcode", "扫描应识别 zcode_import 标记为 zcode 来源");
		assert.ok(listed[0].filePath.endsWith(".jsonl"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
