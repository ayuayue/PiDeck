import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * CodeBuddySessionImporter 单测。
 *
 * CodeBuddy 与 WorkBuddy 共用 codebuddyFamily* 家族管线（转换语义由
 * tests/workbuddySessionImporter.test.mjs 覆盖），这里只锁 CodeBuddy 侧的差异：
 * 家目录 .codebuddy、产物前缀 codebuddy_、导入标记 codebuddy_import、provider codebuddy，
 * 以及「子代理转录 <sessionId>/subagents/agent-*.jsonl 不算可导入会话」。
 */

function loadImporter(homePath) {
	const load = createTsSandbox({ stubs: { electron: { app: { getPath: () => homePath } } } });
	const source = load("src/main/sessions/codebuddyFamilySessionSource.ts");
	const mod = load("src/main/sessions/codebuddyFamilySessionImporter.ts");
	return { importer: new mod.CodeBuddySessionImporter(), source, mod };
}

function writeSession(homePath, slug, sessionId, entries) {
	const dir = join(homePath, ".codebuddy", "projects", slug);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
	return file;
}

const SID = "9b9c1e5a-0000-4444-8888-121212121212";
const T0 = 1_700_000_000_000;
const CWD = "d:\\work\\demo";

const ENTRIES = [
	{
		id: "m1",
		timestamp: T0,
		type: "message",
		role: "user",
		sessionId: SID,
		cwd: CWD,
		content: [{ type: "input_text", text: "帮我看看这个构建" }],
	},
	{
		id: "t1",
		timestamp: T0 + 1000,
		type: "ai-title",
		aiTitle: "排查构建失败",
		sessionId: SID,
		cwd: CWD,
	},
	{
		id: "r1",
		timestamp: T0 + 2000,
		type: "reasoning",
		sessionId: SID,
		cwd: CWD,
		content: [],
		rawContent: [{ type: "reasoning_text", text: "先看日志" }],
		providerData: { model: "sonnet-4" },
	},
	{
		id: "c1",
		timestamp: T0 + 3000,
		type: "function_call",
		sessionId: SID,
		cwd: CWD,
		callId: "call-1",
		name: "Bash",
		arguments: JSON.stringify({ command: "npm run build" }),
	},
	{
		id: "cr1",
		timestamp: T0 + 4000,
		type: "function_call_result",
		sessionId: SID,
		cwd: CWD,
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
		cwd: CWD,
		content: [{ type: "output_text", text: "构建已通过" }],
		providerData: { model: "sonnet-4" },
	},
];

function readLines(file) {
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("scan: 读 ~/.codebuddy/projects/<slug>，标题取 ai-title", async () => {
	const home = mkdtempSync(join(tmpdir(), "cb-home-"));
	try {
		const file = writeSession(home, "d-work-demo", SID, ENTRIES);
		const { importer } = loadImporter(home);

		const sessions = await importer.scan("D:\\work\\demo");

		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].id, SID);
		assert.equal(sessions[0].title, "排查构建失败");
		assert.equal(sessions[0].status, "new");
		assert.equal(sessions[0].sourcePath, file);
		assert.match(sessions[0].targetPath, /codebuddy_9b9c1e5a-0000-4444-8888-121212121212\.jsonl$/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("scan: 跳过子代理转录（<sessionId>/subagents/agent-*.jsonl）", async () => {
	const home = mkdtempSync(join(tmpdir(), "cb-home-"));
	try {
		writeSession(home, "d-work-demo", SID, ENTRIES);
		const subagentsDir = join(home, ".codebuddy", "projects", "d-work-demo", SID, "subagents");
		mkdirSync(subagentsDir, { recursive: true });
		writeFileSync(join(subagentsDir, "agent-abc.jsonl"), JSON.stringify({ timestamp: T0, type: "message", role: "user", sessionId: "agent-abc", cwd: CWD, content: [{ type: "input_text", text: "子代理" }] }) + "\n", "utf8");

		const { importer } = loadImporter(home);

		const sessions = await importer.scan("D:\\work\\demo");

		assert.equal(sessions.length, 1, "子代理转录不应作为可导入会话出现");
		assert.equal(sessions[0].id, SID);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 产物带 codebuddy_import 标记与 codebuddy provider", async () => {
	const home = mkdtempSync(join(tmpdir(), "cb-home-"));
	try {
		const file = writeSession(home, "d-work-demo", SID, ENTRIES);
		const { importer } = loadImporter(home);

		const report = await importer.import("D:\\work\\demo", [file]);

		assert.equal(report.imported, 1);
		assert.equal(report.failed, 0);
		assert.equal(report.results[0].messageCount, 4);
		assert.equal(report.results[0].overwritten, false);

		const lines = readLines(report.results[0].targetPath);
		assert.equal(lines[0].type, "session");
		assert.equal(lines[0].id, SID);
		assert.equal(lines[1].type, "codebuddy_import");
		assert.equal(lines[1].codebuddySessionId, SID);

		const modelChange = lines.find((line) => line.type === "model_change");
		assert.equal(modelChange.provider, "codebuddy");
		assert.equal(modelChange.modelId, "sonnet-4");

		// reasoning + function_call 聚合进同一条 assistant 消息（家族管线的共享语义）
		const assistant = lines.filter((line) => line.type === "message" && line.message?.role === "assistant");
		assert.deepEqual(
			assistant[0].message.content.map((item) => item.type),
			["thinking", "toolCall"],
		);
		assert.equal(assistant[0].message.provider, "codebuddy");
		assert.equal(assistant[0].message.api, "codebuddy-import");
		assert.equal(assistant[0].message.content[0].thinkingSignature, "codebuddy_thinking");
		assert.equal(lines.at(-1).type, "session_info");
		assert.equal(lines.at(-1).name, "排查构建失败");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 重复导入标记 current，源变化后 outdated", async () => {
	const home = mkdtempSync(join(tmpdir(), "cb-home-"));
	try {
		const file = writeSession(home, "d-work-demo", SID, ENTRIES);
		const { importer } = loadImporter(home);

		await importer.import("D:\\work\\demo", [file]);
		assert.equal((await importer.scan("D:\\work\\demo"))[0].status, "current");

		writeSession(home, "d-work-demo", SID, [
			...ENTRIES,
			{
				id: "m3",
				timestamp: T0 + 9000,
				type: "message",
				role: "assistant",
				sessionId: SID,
				cwd: CWD,
				content: [{ type: "output_text", text: "补充结论" }],
			},
		]);
		assert.equal((await importer.scan("D:\\work\\demo"))[0].status, "outdated");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("import: 拒绝 ~/.codebuddy/projects 之外的路径", async () => {
	const home = mkdtempSync(join(tmpdir(), "cb-home-"));
	const outside = mkdtempSync(join(tmpdir(), "cb-outside-"));
	try {
		// 同构的 WorkBuddy 目录也不能当 CodeBuddy 源读（两个来源各有自己的 root）
		mkdirSync(join(home, ".workbuddy", "projects", "d-work-demo"), { recursive: true });
		const evil = join(outside, "leak.jsonl");
		writeFileSync(evil, JSON.stringify({ timestamp: T0, type: "message", role: "user", sessionId: "evil", cwd: "/etc", content: [{ type: "input_text", text: "x" }] }) + "\n", "utf8");

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

test("描述符: WorkBuddy 与 CodeBuddy 只差家目录/前缀/标记/provider", () => {
	const home = mkdtempSync(join(tmpdir(), "cb-home-"));
	try {
		const { source } = loadImporter(home);
		assert.equal(source.CODEBUDDY_SOURCE.homeDirName, ".codebuddy");
		assert.equal(source.CODEBUDDY_SOURCE.filePrefix, "codebuddy_");
		assert.equal(source.CODEBUDDY_SOURCE.importMarker, "codebuddy_import");
		assert.equal(source.CODEBUDDY_SOURCE.provider, "codebuddy");
		assert.equal(source.WORKBUDDY_SOURCE.homeDirName, ".workbuddy");
		assert.equal(source.WORKBUDDY_SOURCE.filePrefix, "workbuddy_");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
