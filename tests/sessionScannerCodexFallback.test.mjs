import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadTranspiledModule(filePath, overrides = new Map()) {
	const source = readFileSync(filePath, "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		clearTimeout,
		exports: {},
		process,
		require: (id) => overrides.has(id) ? overrides.get(id) : require(id),
		setTimeout,
	};
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

function loadCodexMetaModule() {
	const source = readFileSync("src/shared/codexSessionMeta.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, {
		filename: "codexSessionMeta.ts",
	});
	return sandbox.exports;
}

function loadSessionScanner(homePath) {
	const source = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const codexMeta = loadCodexMetaModule();
	const messageContent = loadTranspiledModule(
		"src/main/pi/messageContent.ts",
		new Map([["../feishu/docActions", { stripFeishuDocActionHint: (text) => text }]]),
	);
	const sessionSummaryCache = loadTranspiledModule(
		"src/main/sessions/sessionSummaryCache.ts",
		new Map([["electron", { app: { getPath: () => homePath } }]]),
	);
	const wslPaths = loadTranspiledModule("src/main/wsl/WslPaths.ts");
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "electron") {
				return { app: { getPath: () => homePath } };
			}
			if (id === "../../shared/codexSessionMeta") return codexMeta;
			if (id === "../pi/messageContent") return messageContent;
			if (id === "./sessionSummaryCache") return sessionSummaryCache;
			if (id === "../wsl/WslPaths") return wslPaths;
			return require(id);
		},
	};
	vm.runInNewContext(outputText, sandbox, {
		filename: "SessionScanner.ts",
	});
	return sandbox.exports;
}

test("backfills Codex subagent metadata for sessions imported before grouping fields existed", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-session-scanner-"));
	try {
		const projectPath = "/repo/project";
		const piDir = join(home, ".pi", "agent", "sessions", "--repo-project--");
		const codexDir = join(home, ".codex", "sessions", "2026", "06", "30");
		mkdirSync(piDir, { recursive: true });
		mkdirSync(codexDir, { recursive: true });

		const codexSourcePath = join(codexDir, "rollout-child.jsonl");
		writeFileSync(
			codexSourcePath,
			`${JSON.stringify({
				type: "session_meta",
				payload: {
					id: "child-thread",
					cwd: projectPath,
					thread_source: "subagent",
					parent_thread_id: "parent-thread",
					agent_role: "worker",
					agent_nickname: "Darwin",
				},
			})}\n`,
			"utf8",
		);

		writeFileSync(
			join(piDir, "codex_child-thread.jsonl"),
			[
				JSON.stringify({ sessionName: "Reviewer", cwd: projectPath }),
				JSON.stringify({ type: "session", id: "child-thread", cwd: projectPath }),
				JSON.stringify({
					type: "codex_import",
					version: 1,
					codexSessionId: "child-thread",
					sourcePath: codexSourcePath,
					sourceMtime: 1,
					sourceSize: 1,
				}),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "review" }] },
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const { SessionScanner } = loadSessionScanner(home);
		const summaries = await new SessionScanner().list(projectPath);

		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].codexThreadSource, "subagent");
		assert.equal(summaries[0].codexParentThreadId, "parent-thread");
		assert.equal(summaries[0].codexAgentRole, "worker");
		assert.equal(summaries[0].codexAgentNickname, "Darwin");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
