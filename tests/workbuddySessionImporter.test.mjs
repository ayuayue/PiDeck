import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * WorkBuddySessionImporter 单测。
 *
 * 与 zcode / codex importer 测试同款做法：把 TS 源转译成 CJS 后在 vm 沙箱运行，
 * mock electron（app.getPath("home") 指向临时目录），fs 用真实实现。
 * 会话数据按 WorkBuddy 真实 JSONL schema 构造，不依赖真实 WorkBuddy 安装，
 * 也不触碰用户 ~/.workbuddy 数据。
 */

function transpile(sourcePath, sandbox) {
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
	const registry = {};
	const makeSandbox = () => ({
		exports: {},
		require: (id) => {
			if (id === "electron") return { app: { getPath: () => homePath } };
			if (id === "./SessionImportCopy") return registry.importCopy;
			if (id === "./workbuddySessionSource") return registry.source;
			if (id === "./workbuddySessionConvert") return registry.convert;
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
	});

	registry.importCopy = transpile("src/main/sessions/SessionImportCopy.ts", makeSandbox());
	registry.source = transpile("src/main/sessions/workbuddySessionSource.ts", makeSandbox());
	registry.convert = transpile("src/main/sessions/workbuddySessionConvert.ts", makeSandbox());
	const mod = transpile("src/main/sessions/WorkBuddySessionImporter.ts", makeSandbox());
	return { importer: new mod.WorkBuddySessionImporter(), registry };
}

function writeSession(root, slug, sessionId, entries) {
	const dir = join(root, ".workbuddy", "projects", slug);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
	return file;
}

const SID = "11111111-2222-3333-4444-555555555555";
const T0 = 1_700_000_000_000;

function baseEntries({ userText }) {
	return [
		{
			id: "m1",
			timestamp: T0,
			type: "message",
			role: "user",
			sessionId: SID,
			cwd: "d:\\work\\demo",
			content: [{ type: "input_text", text: userText }],
		},
		{
			id: "t1",
			timestamp: T0 + 1000,
			type: "ai-title",
			aiTitle: "排查构建失败",
			sessionId: SID,
			cwd: "d:\\work\\demo",
		},
		{
			id: "r1",
			timestamp: T0 + 2000,
			type: "reasoning",
			sessionId: SID,
			cwd: "d:\\work\\demo",
			content: [],
			rawContent: [{ type: "reasoning_text", text: "先看一下日志" }],
			providerData: { model: "hy4-preview" },
		},
		{
			id: "c1",
			timestamp: T0 + 3000,
			type: "function_call",
			sessionId: SID,
			cwd: "d:\\work\\demo",
			callId: "call-1",
			name: "Bash",
			arguments: JSON.stringify({ command: "npm run build" }),
		},
		{
			id: "cr1",
			timestamp: T0 + 4000,
			type: "function_call_result",
			sessionId: SID,
			cwd: "d:\\work\\demo",
			callId: "call-1",
			name: "Bash",
			status: "completed",
			output: { type: "text", text: "build ok" },
		},
		{
			id: "m2",
			timestamp: T0 + 5000,
			type: "message",
			role: "assistant",
			sessionId: SID,
			cwd: "d:\\work\\demo",
			content: [{ type: "output_text", text: "构建已通过" }],
			providerData: { model: "hy4-preview" },
		},
		{
			id: "snap",
			timestamp: T0 + 6000,
			type: "file-history-snapshot",
			sessionId: SID,
			cwd: "d:\\work\\demo",
			snapshot: { trackedFileBackups: {} },
		},
	];
}

function readLines(file) {
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("scan: 按项目路径 slug 定位目录，标题取 ai-title 并按更新时间倒序", async () => {
	const home = mkdtempSync(join(tmpdir(), "wb-home-"));
	try {
		writeSession(home, "d-work-demo", SID, baseEntries({ userText: "帮我排查构建失败" }));
		writeSession(home, "d-work-demo", "aaaa-bbbb", [
			{
				id: "x1",
				timestamp: T0 + 60_000,
				type: "message",
				role: "user",
				sessionId: "aaaa-bbbb",
				cwd: "d:\\work\\demo",
				content: [{ type: "input_text", text: "第二个会话" }],
			},
		]);

		const { importer } = loadImporter(home);
		const sessions = await importer.scan("D:\\work\\demo");

		assert.equal(sessions.length, 2);
		assert.equal(sessions[0].id, "aaaa-bbbb");
		assert.equal(sessions[1].id, SID);
		assert.equal(sessions[1].title, "排查构建失败");
		assert.equal(sessions[1].status, "new");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("scan: 忽略 file-rollback 快照流，POSIX 路径同样能定位目录", async () => {
	const home = mkdtempSync(join(tmpdir(), "wb-home-"));
	try {
		const sessionFile = writeSession(home, "work-demo", SID, baseEntries({ userText: "hi" }));
		writeFileSync(
			join(home, ".workbuddy", "projects", "work-demo", `${SID}.file-rollback.ndjson`),
			JSON.stringify({ type: "rollback" }) + "\n",
			"utf8",
		);

		const { importer } = loadImporter(home);
		const sessions = await importer.scan("/work/demo");

		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].sourcePath, sessionFile);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 剥离 system-reminder，只保留用户真实输入", async () => {
	const home = mkdtempSync(join(tmpdir(), "wb-home-"));
	try {
		const injected = [
			"<system-reminder data-role=\"user-context\">",
			"<user_info>OS Version: win32</user_info>",
			"## AGENTS.md",
			"项目规则正文",
			"</system-reminder>",
			"真正的提问在这里",
		].join("\n");
		writeSession(home, "d-work-demo", SID, baseEntries({ userText: injected }));

		const { importer } = loadImporter(home);
		const report = await importer.import("D:\\work\\demo", [
			join(home, ".workbuddy", "projects", "d-work-demo", `${SID}.jsonl`),
		]);

		assert.equal(report.imported, 1);
		const lines = readLines(report.results[0].targetPath);
		const firstUser = lines.find(
			(line) => line.type === "message" && line.message?.role === "user",
		);
		assert.ok(firstUser, "应存在 user 消息");
		assert.equal(firstUser.message.content[0].text, "真正的提问在这里");
		assert.ok(!firstUser.message.content[0].text.includes("AGENTS.md"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: reasoning 与 function_call 聚合进同一条 assistant 消息", async () => {
	const home = mkdtempSync(join(tmpdir(), "wb-home-"));
	try {
		writeSession(home, "d-work-demo", SID, baseEntries({ userText: "排查构建失败" }));

		const { importer } = loadImporter(home);
		const report = await importer.import("D:\\work\\demo", [
			join(home, ".workbuddy", "projects", "d-work-demo", `${SID}.jsonl`),
		]);

		const lines = readLines(report.results[0].targetPath);
		// user + 聚合(thinking/toolCall) + toolResult + 结论文本
		assert.equal(report.results[0].messageCount, 4);

		const assistant = lines.filter(
			(line) => line.type === "message" && line.message?.role === "assistant",
		);
		// 第一条：thinking + toolCall 合并；第二条：结论文本。
		assert.equal(assistant.length, 2);
		assert.deepEqual(
			assistant[0].message.content.map((item) => item.type),
			["thinking", "toolCall"],
		);
		assert.equal(assistant[0].message.content[0].thinking, "先看一下日志");
		assert.equal(assistant[0].message.content[1].id, "call-1");
		assert.equal(assistant[0].message.content[1].name, "Bash");
		assert.deepEqual(assistant[0].message.content[1].arguments, { command: "npm run build" });
		assert.equal(assistant[0].message.model, "hy4-preview");
		assert.equal(assistant[1].message.content[0].text, "构建已通过");

		const toolResult = lines.find(
			(line) => line.type === "message" && line.message?.role === "toolResult",
		);
		assert.equal(toolResult.message.toolCallId, "call-1");
		assert.equal(toolResult.message.toolName, "Bash");
		assert.equal(toolResult.message.content[0].text, "build ok");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 写出 session 头与末尾 session_info，且 file-history-snapshot 被丢弃", async () => {
	const home = mkdtempSync(join(tmpdir(), "wb-home-"));
	try {
		writeSession(home, "d-work-demo", SID, baseEntries({ userText: "排查构建失败" }));

		const { importer } = loadImporter(home);
		const report = await importer.import("D:\\work\\demo", [
			join(home, ".workbuddy", "projects", "d-work-demo", `${SID}.jsonl`),
		]);
		const lines = readLines(report.results[0].targetPath);

		assert.equal(lines[0].type, "session");
		assert.equal(lines[0].id, SID);
		assert.equal(lines[0].cwd, "D:\\work\\demo");
		assert.equal(lines[1].type, "workbuddy_import");
		assert.equal(lines.at(-1).type, "session_info");
		assert.equal(lines.at(-1).name, "排查构建失败");
		assert.ok(
			!lines.some((line) => line.type === "file-history-snapshot"),
			"快照记录不应写入 pi 会话文件",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 重复导入标记为 current，源文件变化后标记为 outdated", async () => {
	const home = mkdtempSync(join(tmpdir(), "wb-home-"));
	try {
		const file = writeSession(home, "d-work-demo", SID, baseEntries({ userText: "排查构建失败" }));

		const { importer } = loadImporter(home);
		const first = await importer.import("D:\\work\\demo", [file]);
		assert.equal(first.results[0].overwritten, false);

		let sessions = await importer.scan("D:\\work\\demo");
		assert.equal(sessions[0].status, "current");

		// 追加一条记录改变源文件大小与 mtime
		writeSession(home, "d-work-demo", SID, [
			...baseEntries({ userText: "排查构建失败" }),
			{
				id: "m3",
				timestamp: T0 + 9000,
				type: "message",
				role: "assistant",
				sessionId: SID,
				cwd: "d:\\work\\demo",
				content: [{ type: "output_text", text: "补充结论" }],
			},
		]);

		sessions = await importer.scan("D:\\work\\demo");
		assert.equal(sessions[0].status, "outdated");

		const second = await importer.import("D:\\work\\demo", [file]);
		assert.equal(second.results[0].overwritten, true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 拒绝 ~/.workbuddy/projects 之外的路径", async () => {
	const home = mkdtempSync(join(tmpdir(), "wb-home-"));
	const outside = mkdtempSync(join(tmpdir(), "wb-outside-"));
	try {
		const evil = join(outside, "leak.jsonl");
		writeFileSync(
			evil,
			JSON.stringify({
				id: "e1",
				timestamp: T0,
				type: "message",
				role: "user",
				sessionId: "evil",
				cwd: "/etc",
				content: [{ type: "input_text", text: "x" }],
			}) + "\n",
			"utf8",
		);

		const { importer } = loadImporter(home);
		const report = await importer.import("D:\\work\\demo", [evil]);

		assert.equal(report.imported, 0);
		assert.equal(report.failed, 1);
		assert.match(report.results[0].error, /outside/);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("纯函数: stripInjectedContext 移除自闭合与成对 system-reminder", () => {
	const home = mkdtempSync(join(tmpdir(), "wb-home-"));
	try {
		const { registry } = loadImporter(home);
		const { stripInjectedContext } = registry.source;
		assert.equal(stripInjectedContext("<system-reminder />保留"), "保留");
		assert.equal(
			stripInjectedContext("前缀<system-reminder>注入</system-reminder>后缀"),
			"前缀后缀",
		);
		assert.equal(stripInjectedContext("   "), "");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("纯函数: stripInjectedContext 去掉 user_query 包装但保留提问内容", () => {
	const home = mkdtempSync(join(tmpdir(), "wb-home-"));
	try {
		const { registry } = loadImporter(home);
		const { stripInjectedContext } = registry.source;
		assert.equal(stripInjectedContext("<user_query>真实提问</user_query>"), "真实提问");
		assert.equal(
			stripInjectedContext(
				"<system-reminder>上下文</system-reminder><user_query>真实提问</user_query>",
			),
			"真实提问",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
