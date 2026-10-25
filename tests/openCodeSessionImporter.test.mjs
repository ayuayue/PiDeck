import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

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
	// 统一沙箱加载器：相对 import 自动按**源文件目录**解析，不再手写 require 桥。
	const load = createTsSandbox({ stubs: { electron: { app: { getPath: () => homePath } } } });
	const mod = load("src/main/sessions/OpenCodeSessionImporter.ts");
	return { ...mod, importer: new mod.OpenCodeSessionImporter() };
}

const T0 = 1_700_000_000_000;

function seedOpenCodeDb(dbPath, projectPath) {
	const db = new DatabaseSync(dbPath);
	db.exec(`
		CREATE TABLE project (id text primary key, worktree text);
		CREATE TABLE session (id text primary key, project_id text, directory text, title text, time_created integer, time_updated integer, model text);
		CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
		CREATE TABLE part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
	`);
	db.prepare("insert into project (id, worktree) values (?, ?)").run("proj", projectPath);
	db.prepare("insert into session (id, project_id, directory, title, time_created, time_updated, model) values (?, ?, ?, ?, ?, ?, ?)").run("sess_1", "proj", projectPath, "工具栏", T0, T0 + 1000, JSON.stringify({ providerID: "opencode", modelID: "test" }));
	db.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)").run("m_user", "sess_1", T0, T0, JSON.stringify({ role: "user" }));
	db.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)").run("p_user", "m_user", "sess_1", T0, T0, JSON.stringify({ type: "text", text: "列一下目录" }));
	db.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)").run("p_file", "m_user", "sess_1", T0, T0, JSON.stringify({ type: "file", filename: "shot.png", mime: "image/png" }));
	db.prepare("insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)").run("m_asst", "sess_1", T0 + 100, T0 + 200, JSON.stringify({ role: "assistant", finish: "tool-calls" }));
	db.prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)").run(
		"p_tool",
		"m_asst",
		"sess_1",
		T0 + 160,
		T0 + 180,
		JSON.stringify({
			type: "tool",
			callID: "call_abc",
			tool: "bash",
			state: { status: "completed", input: { command: "ls" }, output: "a.ts\nb.ts" },
		}),
	);
	db.close();
}

test("import: assistant 上的 tool part 拆成 toolCall + toolResult", async () => {
	const home = mkdtempSync(join(tmpdir(), "opencode-home-"));
	try {
		const projectPath = join(home, "proj");
		const dbDir = join(home, ".local", "share", "opencode");
		mkdirSync(dbDir, { recursive: true });
		seedOpenCodeDb(join(dbDir, "opencode.db"), projectPath);

		const { importer } = loadImporter(home);
		const sessions = await importer.scan(projectPath);
		assert.equal(sessions.length, 1);
		const report = await importer.import(projectPath, [sessions[0].sourcePath]);
		assert.equal(report.imported, 1);

		const lines = readFileSync(report.results[0].targetPath, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const assistant = lines.find((line) => line.type === "message" && line.message?.role === "assistant");
		const toolCall = assistant.message.content.find((item) => item.type === "toolCall");
		assert.equal(toolCall.id, "call_abc");
		assert.equal(toolCall.name, "bash");
		assert.deepEqual(toolCall.arguments, { command: "ls" });
		assert.equal(assistant.message.stopReason, "toolUse");

		const toolResults = lines.filter((line) => line.type === "message" && line.message?.role === "toolResult");
		assert.equal(toolResults.length, 1);
		assert.equal(toolResults[0].message.toolCallId, "call_abc");
		assert.equal(toolResults[0].message.toolName, "bash");
		assert.equal(toolResults[0].message.content[0].text, "a.ts\nb.ts");

		const user = lines.find((line) => line.type === "message" && line.message?.role === "user");
		assert.equal(user.message.content[0].text, "列一下目录");
		assert.equal(user.message.content[1].text, "[image: shot.png]");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
